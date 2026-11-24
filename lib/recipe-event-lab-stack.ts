import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as eventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";

export class RecipeEventLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Demo access control, not a production substitute for Cognito/OIDC.
    const demoToken = new cdk.CfnParameter(this, "DemoToken", {
      type: "String",
      noEcho: true,
      minLength: 24,
      description: "A random access token for the demonstration API",
    });

    const table = new dynamodb.Table(this, "RecipeEvents", {
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Demo data is disposable.
    });

    const recipesTable = new dynamodb.Table(this, "Recipes", {
      partitionKey: {
        name: "recipeId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const archive = new dynamodb.Table(this, "FailedRecipeMessages", {
      partitionKey: {
        name: "messageKey",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const topic = new sns.Topic(this, "RecipePublishedTopic");

    const functionDefaults = {
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      bundling: { minify: true, externalModules: [] },
    };

    const alertsTopic = new sns.Topic(this, "RecipeOperationsAlerts", {
      displayName: "Recipe Event Lab Operations Alerts",
    });

    new cdk.CfnOutput(this, "AlertsTopicArn", {
      value: alertsTopic.topicArn,
    });

    const workerDescriptions: {
      key: "search" | "nutrition" | "audit";
      title: string;
    }[] = [
      { key: "search", title: "Search" },
      { key: "nutrition", title: "Nutrition" },
      { key: "audit", title: "Audit" },
    ];

    const dashboard = new cloudwatch.Dashboard(
      this,
      "RecipeOperationsDashboard",
      {
        dashboardName: "RecipeEventLab-Operations",
      },
    );

    for (const worker of workerDescriptions) {
      const dlq = new sqs.Queue(this, `${worker.title}DLQ`, {
        retentionPeriod: cdk.Duration.days(4),
      });
      const queue = new sqs.Queue(this, `${worker.title}Queue`, {
        visibilityTimeout: cdk.Duration.seconds(60), // >= 6 x Lambda timeout.
        retentionPeriod: cdk.Duration.days(4),
        deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
      });

      // Without rawMessageDelivery, SQS body would contain the SNS JSON envelope.
      topic.addSubscription(
        new subscriptions.SqsSubscription(queue, {
          rawMessageDelivery: true,
        }),
      );

      const fn = new nodejs.NodejsFunction(this, `${worker.title}Worker`, {
        ...functionDefaults,
        entry: path.join(__dirname, "../lambda/worker.ts"),
        handler: "handler",
        environment: { TABLE_NAME: table.tableName, WORKER: worker.key },
      });
      table.grantReadWriteData(fn);

      fn.addEventSource(
        new eventSources.SqsEventSource(queue, {
          batchSize: 1,
          reportBatchItemFailures: true,
        }),
      );

      const recorder = new nodejs.NodejsFunction(
        this,
        `${worker.title}DLQRecorder`,
        {
          ...functionDefaults,
          entry: path.join(__dirname, "../lambda/dlq-recorder.ts"),
          handler: "handler",
          environment: {
            TABLE_NAME: table.tableName,
            ARCHIVE_TABLE_NAME: archive.tableName,
            WORKER: worker.key,
          },
        },
      );

      table.grantWriteData(recorder);
      archive.grantWriteData(recorder);

      recorder.addEventSource(
        new eventSources.SqsEventSource(dlq, {
          batchSize: 1,
          reportBatchItemFailures: true,
        }),
      );

      const dlqAlarm = new cloudwatch.Alarm(
        this,
        `${worker.title}DLQActivityAlarm`,
        {
          metric: dlq.metricNumberOfMessagesReceived({
            period: cdk.Duration.minutes(1),
            statistic: "Sum",
          }),
          threshold: 1,
          evaluationPeriods: 1,
          comparisonOperator:
            cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        },
      );

      dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertsTopic));

      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `${worker.title} - Queue Depth`,
          width: 8,
          left: [
            queue.metricApproximateNumberOfMessagesVisible({
              label: "Work queue",
              period: cdk.Duration.minutes(1),
            }),
            dlq.metricApproximateNumberOfMessagesVisible({
              label: "Dead-letter queue",
              period: cdk.Duration.minutes(1),
            }),
          ],
        }),

        new cloudwatch.GraphWidget({
          title: `${worker.title} - DLQ Receives`,
          width: 8,
          left: [
            dlq.metricNumberOfMessagesReceived({
              label: "Messages received from DLQ",
              period: cdk.Duration.minutes(1),
              statistic: "Sum",
            }),
          ],
        }),

        new cloudwatch.GraphWidget({
          title: `${worker.title} - Lambda Errors`,
          width: 8,
          left: [
            fn.metricErrors({
              label: "Worker errors",
              period: cdk.Duration.minutes(1),
              statistic: "Sum",
            }),
            recorder.metricErrors({
              label: "Recorder errors",
              period: cdk.Duration.minutes(1),
              statistic: "Sum",
            }),
          ],
        }),
      );

      new cdk.CfnOutput(this, `${worker.title}DlqUrl`, { value: dlq.queueUrl });
    }

    const publisher = new nodejs.NodejsFunction(this, "PublishRecipe", {
      ...functionDefaults,
      entry: path.join(__dirname, "../lambda/publish.ts"),
      handler: "handler",
      environment: {
        TABLE_NAME: table.tableName,
        TOPIC_ARN: topic.topicArn,
        DEMO_TOKEN: demoToken.valueAsString,
      },
    });
    table.grantReadWriteData(publisher);
    topic.grantPublish(publisher);

    const status = new nodejs.NodejsFunction(this, "GetRecipeStatus", {
      ...functionDefaults,
      entry: path.join(__dirname, "../lambda/status.ts"),
      handler: "handler",
      environment: {
        TABLE_NAME: table.tableName,
        DEMO_TOKEN: demoToken.valueAsString,
      },
    });
    table.grantReadData(status);

    const savedRecipes = new nodejs.NodejsFunction(this, "SavedRecipesApi", {
      ...functionDefaults,
      entry: path.join(__dirname, "../lambda/saved-recipes.ts"),
      handler: "handler",
      environment: {
        RECIPES_TABLE_NAME: recipesTable.tableName,
        DEMO_TOKEN: demoToken.valueAsString,
      },
    });

    //recipesTable.grantReadWriteData(savedRecipes);

    recipesTable.grant(savedRecipes, "dynamodb:GetItem", "dynamodb:PutItem");

    const api = new apigw.HttpApi(this, "RecipeApi", {
      corsPreflight: {
        allowOrigins: ["http://localhost:5173"],
        allowHeaders: ["content-type", "x-demo-token"],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST],
      },
    });
    api.addRoutes({
      path: "/recipes",
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "PublishRoute",
        publisher,
      ),
    });
    api.addRoutes({
      path: "/recipes/{eventId}",
      methods: [apigw.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "StatusRoute",
        status,
      ),
    });

    api.addRoutes({
      path: "/saved-recipes",
      methods: [apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration(
        "CreateSavedRecipeRoute",
        savedRecipes,
      ),
    });

    api.addRoutes({
      path: "/saved-recipes/{recipeId}",
      methods: [apigw.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration(
        "GetSavedRecipeRoute",
        savedRecipes,
      ),
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "TopicArn", { value: topic.topicArn });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "RecipesTableName", {
      value: recipesTable.tableName,
    });
  }
}
