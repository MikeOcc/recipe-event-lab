
import { randomUUID } from "crypto";
import { APIGatewayProxyEventV2 } from "aws-lambda";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  authorized,
  response,
  RecipeEvent,
  RecipeIngredient,
  INGREDIENT_UNITS,
} from "./common";

const sns = new SNSClient({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const table = process.env.TABLE_NAME!;
const topicArn = process.env.TOPIC_ARN!;

// Validate a single ingredient object.
function isRecipeIngredient(
  value: unknown,
): value is RecipeIngredient {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const item = value as Record<string, unknown>;

  return (
    typeof item.name === "string" &&
    item.name.trim().length > 0 &&
    item.name.length <= 100 &&
    typeof item.quantity === "number" &&
    Number.isFinite(item.quantity) &&
    item.quantity > 0 &&
    typeof item.unit === "string" &&
    (INGREDIENT_UNITS as readonly string[]).includes(item.unit) &&
    (
      item.notes === undefined ||
      typeof item.notes === "string"
    )
  );
}

// Validate the entire ingredient array.
function isRecipeIngredientArray(
  value: unknown,
): value is RecipeIngredient[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 30 &&
    value.every(isRecipeIngredient)
  );
}

// API Gateway Lambda handler.
export const handler = async (
  event: APIGatewayProxyEventV2,
) => {
  // Authorization
  if (!authorized(event)) {
    return response(401, { error: "Unauthorized" });
  }

  // Parse incoming JSON.
  let input: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(event.body || "{}");

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return response(400, {
        error: "Expected a JSON object",
      });
    }

    input = parsed as Record<string, unknown>;
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  // Extract request fields.
  const title =
    typeof input.title === "string"
      ? input.title.trim()
      : "";

  const ingredients = input.ingredients;

  // Validate title.
  if (!title || title.length > 120) {
    return response(400, {
      error: "Supply a title between 1 and 120 characters.",
    });
  }

  // Validate structured ingredients.
  if (!isRecipeIngredientArray(ingredients)) {
    return response(400, {
      error:
        "Supply 1-30 valid ingredients with name, quantity, unit, and optional notes.",
    });
  }

  // Create version 2 recipe event.
  const recipeEvent: RecipeEvent = {
    eventId: randomUUID(),
    eventType: "recipe.published",
    version: 2,
    occurredAt: new Date().toISOString(),
    recipe: {
      title,
      ingredients,
    },
    demo: {
      failNutrition: input.failNutrition === true,
    },
  };

  // Initialize processing status in DynamoDB.
  await db.send(
    new PutCommand({
      TableName: table,
      Item: {
        eventId: recipeEvent.eventId,
        title,
        occurredAt: recipeEvent.occurredAt,
        publishStatus: "PUBLISHING",
        search: { status: "PENDING" },
        nutrition: { status: "PENDING" },
        audit: { status: "PENDING" },
      },
    }),
  );

  // Publish event to SNS.
  try {
    await sns.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify(recipeEvent),
        MessageAttributes: {
          eventType: {
            DataType: "String",
            StringValue: recipeEvent.eventType,
          },
        },
      }),
    );
  } catch (error) {
    console.error("SNS publishing failed", error);

    try {
      await db.send(
        new UpdateCommand({
          TableName: table,
          Key: { eventId: recipeEvent.eventId },
          UpdateExpression: "SET publishStatus = :value",
          ExpressionAttributeValues: {
            ":value": "FAILED",
          },
        }),
      );
    } catch (statusError) {
      console.error(
        "Failed to record publishing error",
        statusError,
      );
    }

    return response(502, {
      error: "Could not publish to SNS",
      eventId: recipeEvent.eventId,
    });
  }

  // SNS accepted the event.
  // Do not republish if this status update fails.
  try {
    await db.send(
      new UpdateCommand({
        TableName: table,
        Key: { eventId: recipeEvent.eventId },
        UpdateExpression: "SET publishStatus = :value",
        ExpressionAttributeValues: {
          ":value": "PUBLISHED",
        },
      }),
    );
  } catch (statusError) {
    console.error(
      "SNS accepted event but status marker update failed",
      statusError,
    );
  }

  console.log(
    JSON.stringify({
      eventId: recipeEvent.eventId,
      action: "sns-published",
    }),
  );

  return response(202, {
    eventId: recipeEvent.eventId,
  });
};
