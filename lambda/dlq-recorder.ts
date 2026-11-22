
import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { WorkKind } from './common';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const table = process.env.TABLE_NAME!;
const archiveTable = process.env.ARCHIVE_TABLE_NAME!;
const worker = process.env.WORKER as WorkKind;

function extractEventId(body: string): string | undefined {
  try {
    const event: unknown = JSON.parse(body);
    if (
      event !== null &&
      typeof event === 'object' &&
      'eventId' in event &&
      typeof event.eventId === 'string'
    ) {
      return event.eventId;
    }
  } catch {
    // Invalid JSON is still worth archiving.
  }
  return undefined;
}

async function recordFailure(record: SQSEvent['Records'][number]) {
  const eventId = extractEventId(record.body);
  const messageKey = `${worker}#${record.messageId}`;

  // Preserve the original failed payload before acknowledging.
  // Duplicate deliveries must not overwrite the archive.
  try {
    await db.send(new PutCommand({
      TableName: archiveTable,
      Item: {
        messageKey,
        worker,
        eventId: eventId ?? 'UNKNOWN',
        originalBody: record.body,
        sourceDlqArn: record.eventSourceARN,
        archivedAt: new Date().toISOString(),
      },
      ConditionExpression: 'attribute_not_exists(messageKey)',
    }));
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') {
      throw error;
    }
  }

  // Malformed messages may not identify a recipe.
  if (!eventId) {
    console.warn(JSON.stringify({
      action: 'archived-without-event-id',
      messageKey,
    }));
    return;
  }

  try {
    await db.send(new UpdateCommand({
      TableName: table,
      Key: { eventId },
      UpdateExpression: 'SET #worker = :failed',
      ConditionExpression:
        'attribute_exists(eventId) AND ' +
        '(attribute_not_exists(#worker.#status) OR ' +
        '#worker.#status <> :succeeded)',
      ExpressionAttributeNames: {
        '#worker': worker,
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':succeeded': 'SUCCEEDED',
        ':failed': {
          status: 'FAILED',
          detail: 'Message exhausted retries and was archived',
          failedAt: new Date().toISOString(),
          archiveKey: messageKey,
        },
      },
    }));
  } catch (error) {
    if ((error as Error).name !== 'ConditionalCheckFailedException') {
      throw error;
    }
    // Already succeeded or no matching recipe record.
    // Do not overwrite successful processing.
  }

  console.log(JSON.stringify({
    action: 'dlq-archived',
    worker,
    eventId,
    messageKey,
  }));
}

export const handler = async (
  event: SQSEvent
): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await recordFailure(record);
    } catch (error) {
      console.error('DLQ recording failed', error);
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
};
