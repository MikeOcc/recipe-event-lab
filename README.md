# Recipe Event Lab — AWS SNS/SQS Portfolio Demo

A minimal **working** TypeScript + React project designed to demonstrate asynchronous fan-out, failure isolation, retries, dead-letter queues, and status tracing. It is **not** an America's Test Kitchen product; all recipes are fictional sample data.

## Architecture

```text
Local React dashboard (Vite) --HTTPS--> API Gateway HTTP API
                                      |-- POST /recipes -> Publisher Lambda -> SNS topic
                                      |                                      |--> SQS search queue -> Search Lambda -----|
                                      |                                      |--> SQS nutrition queue -> Nutrition Lambda|--> DynamoDB status
                                      |                                      |--> SQS audit queue -> Audit Lambda -------|
                                      |-- GET /recipes/{eventId} -> Status Lambda -> DynamoDB

Each SQS queue has a corresponding DLQ. SNS subscriptions use raw message delivery.
```

## 0. Costs and security

- Create an AWS cost budget (e.g., $5/month) and email notifications **before** provisioning. A budget alert is NOT a hard spending cap.
- AWS Free Tier/credits depend on account eligibility and age. Expect small but nonzero usage charges if ineligible.
- This demo avoids NAT Gateway, RDS, EC2, OpenSearch, and provisioned throughput.
- The API requires a random `x-demo-token` header, which you enter in the UI. This is **only a simple demonstration gate**, not production authentication or brute-force protection. For a public deployment use an OIDC/JWT authorizer, quotas/throttling, and monitoring. Do not share the token or commit it.
- `RemovalPolicy.DESTROY` on DynamoDB means `cdk destroy` irreversibly deletes event records. This is deliberate for disposable demonstration data.

## 1. Local prerequisites

- An AWS account with permission to bootstrap and deploy CloudFormation/CDK stacks.
- AWS CLI v2; configure a non-root profile, preferably with AWS IAM Identity Center (`aws configure sso`).
- Node.js 22+ and npm. Run `node --version` and `npm --version`.
- Verify credentials: `aws sts get-caller-identity`.
- Choose one region and keep it throughout (example `us-east-1`).

For example:

```bash
export AWS_PROFILE=YOUR_AWS_PROFILE
export AWS_REGION=us-east-1
aws sts get-caller-identity
```

If you use `aws configure` instead of SSO, do NOT use root access keys. Avoid storing credentials in the project.

## 2. Install and deploy the backend

From the repository root:

```bash
npm install
npm run build
npx cdk bootstrap
export DEMO_TOKEN="$(openssl rand -hex 24)"
npx cdk synth
npx cdk deploy --parameters DemoToken="$DEMO_TOKEN"
```

**Save the value of `DEMO_TOKEN` in a secure password manager**, as the UI will ask for it. If you lose it, choose a new token and redeploy. Do not copy it into a committed file.

Write down the CloudFormation outputs: `ApiUrl`, `TopicArn`, `TableName`, and three DLQ URLs.

Note: The CDK CLI may create or reuse bootstrap resources on first deployment; don't delete an existing shared bootstrap stack unless you're certain no other stacks use it.

## 3. Test without a browser

Use the `ApiUrl` from the CDK outputs (do not put a trailing slash):

```bash
export API_URL='https://YOUR_ID.execute-api.us-east-1.amazonaws.com'
curl -sS -X POST "$API_URL/recipes" \
  -H 'content-type: application/json' \
  -H "x-demo-token: $DEMO_TOKEN" \
  -d '{"title":"New England Clam Chowder", "ingredients":["clams","potatoes","cream","onion"],"failNutrition":false}'
```

Expected response: `{"eventId":"<UUID>"}` with HTTP 202. Copy the actual UUID:

```bash
curl -sS -H "x-demo-token: $DEMO_TOKEN" "$API_URL/recipes/PUT_UUID_HERE"
```

The returned record should eventually show `search.status`, `nutrition.status`, and `audit.status` all `SUCCEEDED`. They are genuinely updated by three separate Lambda consumers of three SQS queues.

## 4. Run the real dashboard

```bash
cd web
npm install
cp .env.example .env.local
```

Edit `web/.env.local` and paste your actual `ApiUrl` into `VITE_API_URL`. Then run:

```bash
npm run dev
```

Open http://localhost:5173; paste your `DEMO_TOKEN` into the password input. Type a recipe and click **Publish recipe event**. The browser polls the status endpoint every two seconds.

The only allowed browser origin is `http://localhost:5173`. If you later host the frontend elsewhere, update `allowOrigins` in the CDK stack and redeploy. CORS is *not* authentication.

## 5. Demonstrate failure isolation and a DLQ

Check the **deliberately fail** checkbox, then publish another recipe.

Expected result:

- `search.status` becomes `SUCCEEDED`.
- `audit.status` becomes `SUCCEEDED`.
- `nutrition.status` becomes `RETRYING`, while the nutrition Lambda reports the injected error.
- Once the nutrition queue reaches `maxReceiveCount: 3`, SQS can move the message to its DLQ. Open the SQS Console, inspect the **NutritionDLQ** physical queue, and verify the dead-letter message exists.
- The dashboard intentionally does **not** claim `DEAD_LETTERED`: this implementation does not automatically monitor dead-letter movement. AWS Console/CloudWatch is the source of truth for that stage.

The visibility timeout is 60 seconds, the Lambda function timeout is 10 seconds, and the queue's dead-letter redrive policy uses 3 receives. The exact retry timing is asynchronous and should not be represented as a hard countdown.

## 6. Demonstrate idempotent status updates

The event includes a stable `eventId`. Re-publishing the *same* event ID to the SNS topic will cause the three workers to overwrite the same status properties of that one DynamoDB record; no duplicate status rows or incremented counts are created. This is idempotent **for these specific DynamoDB updates**. Production side effects (e.g., a payment or external search index) need their own idempotency guarantees.

You can reproduce an event payload in a JSON file with an existing `eventId`, then publish directly to the `TopicArn` output:

```bash
aws sns publish --topic-arn 'TOPIC_ARN_OUTPUT' --message file://event.json
```

Example event.json format:

```json
{
  "eventId": "EXISTING_EVENT_UUID",
  "eventType": "recipe.published",
  "version": 1,
  "occurredAt": "2026-11-18T12:00:00.000Z",
  "recipe": { "title": "New England Clam Chowder", "ingredients": ["clams", "potatoes"] },
  "demo": { "failNutrition": false }
}
```

If you replay a previously failed event with `failNutrition:false`, the nutrition worker can overwrite the row with `SUCCEEDED`; this simulates recovery by *reprocessing* a corrected event, not automatic DLQ redrive. To practice actual DLQ redrive, use the SQS Console redrive operation and fix the failure injection strategy before replaying.

## 7. Extend for a stronger engineering demonstration

1. Increase SQS batch size to 5 and inject one bad event to show that `ReportBatchItemFailures` retries **only** the failing record.
2. Add SNS `MessageAttributes` and subscription filter policies. Example: `recipe.published` goes to search/validation; `recipe.unpublished` goes to audit only.
3. Add SQS and DLQ CloudWatch alarms for approximate oldest message age and DLQ queue depth.
4. Implement a proper per-processor idempotency key and conditional DynamoDB write (or transaction) before introducing non-idempotent side effects.
5. Add load-test scripts and show backlog/recovery. Put safe request and concurrency limits in place before externalizing the API.
6. For public access, replace the shared demo token with a JWT/OIDC authorizer (e.g., Cognito), include API throttling, and deploy the React site via a low-cost static host.
7. Add CI tests and a `cdk diff` gate before deployment.

## 8. Interview walkthrough (5–7 minutes)

- Explain the event contract and why the publisher sends exactly one event to SNS.
- Publish a recipe, show its `eventId`, and track three independent queue consumers.
- Publish with an injected nutrition failure. Point out that the other two queues keep processing.
- Open CloudWatch to show the failing Lambda and SQS to inspect the DLQ.
- Explain at-least-once delivery, idempotency, visibility timeout, and why 3 workers polling **one** queue would not provide fan-out.
- Compare the architecture to Kafka: in Kafka, replay and offsets behave differently; here each consumer has its own durable work queue.

## 9. Clean up

From the root, with the same AWS profile and region:

```bash
npx cdk destroy
```

Afterward check CloudWatch Logs for retained log groups and the CDK bootstrap artifacts. Do not casually delete a shared CDK bootstrap stack. Cost and account security settings (e.g., budget alerts) remain separate from this application stack.

## Official references

- https://docs.aws.amazon.com/cdk/v2/guide/getting-started.html
- https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html
- https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html
- https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html
- https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-create.html
