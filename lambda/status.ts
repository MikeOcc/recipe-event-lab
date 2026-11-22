import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { authorized, response } from './common';

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const handler = async (event: APIGatewayProxyEventV2) => {
  if (!authorized(event)) return response(401, { error: 'Unauthorized' });
  const eventId = event.pathParameters?.eventId;
  if (!eventId || !/^[a-f0-9-]{36}$/i.test(eventId))
    return response(400, { error: 'Invalid eventId' });
  const result = await db.send(new GetCommand({
    TableName: process.env.TABLE_NAME!,
    Key: { eventId },
    ConsistentRead: true,
  }));
  if (!result.Item) return response(404, { error: 'Event not found' });
  return response(200, result.Item);
};
