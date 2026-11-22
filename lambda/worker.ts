
import { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  RecipeEvent,
  WorkKind,
  INGREDIENT_UNITS,
} from "./common";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const table = process.env.TABLE_NAME!;
const worker = process.env.WORKER as WorkKind;

// Validate an incoming SNS event before processing it.
function isRecipeEvent(value: unknown): value is RecipeEvent {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return false;
  }

  const event = value as Partial<RecipeEvent>;

  if (
    event.eventType !== "recipe.published" ||
    event.version !== 2 ||
    typeof event.eventId !== "string" ||
    !event.eventId ||
    typeof event.occurredAt !== "string" ||
    typeof event.recipe?.title !== "string" ||
    !event.recipe.title.trim() ||
    !Array.isArray(event.recipe.ingredients) ||
    event.recipe.ingredients.length === 0 ||
    typeof event.demo?.failNutrition !== "boolean"
  ) {
    return false;
  }

  return event.recipe.ingredients.every((ingredient) =>
    ingredient !== null &&
    typeof ingredient === "object" &&
    typeof ingredient.name === "string" &&
    ingredient.name.trim().length > 0 &&
    typeof ingredient.quantity === "number" &&
    Number.isFinite(ingredient.quantity) &&
    ingredient.quantity > 0 &&
    typeof ingredient.unit === "string" &&
    (INGREDIENT_UNITS as readonly string[]).includes(ingredient.unit) &&
    (
      ingredient.notes === undefined ||
      typeof ingredient.notes === "string"
    )
  );
}

// Update this worker's processing status in DynamoDB.
async function updateStatus(
  eventId: string,
  value: Record<string, unknown>
) {
  // Repeated delivery updates the same status field.
  await db.send(
    new UpdateCommand({
      TableName: table,
      Key: { eventId },
      UpdateExpression: "SET #worker = :value",
      ConditionExpression: "attribute_exists(eventId)",
      ExpressionAttributeNames: {
        "#worker": worker,
      },
      ExpressionAttributeValues: {
        ":value": value,
      },
    })
  );
}

// Process a recipe event.
async function processRecipe(value: unknown) {
  if (!isRecipeEvent(value)) {
    throw new Error("Unsupported or invalid recipe event");
  }

  const event = value;

  // Deliberately fail Nutrition for our retry/DLQ demonstration.
  if (worker === "nutrition" && event.demo.failNutrition) {
    await updateStatus(event.eventId, {
      status: "RETRYING",
      detail: "Deliberately failing to demonstrate SQS retries and DLQ",
    });

    throw new Error("Injected nutrition processing failure");
  }

  let result: Record<string, unknown>;

  switch (worker) {
    case "search": {
      // NEW: Extract names from ingredient objects.
      const ingredientNames = event.recipe.ingredients.map(
        (ingredient) => ingredient.name
      );

      const words = [
        event.recipe.title,
        ...ingredientNames,
      ]
        .join(" ")
        .toLowerCase()
        .match(/[a-z]+/g) || [];

      result = {
        keywords: [...new Set(words)].slice(0, 20),
      };
      break;
    }

    case "nutrition": {
      // Placeholder validation, NOT a nutrition estimate.
      result = {
        valid: event.recipe.ingredients.length > 0,
        ingredientCount: event.recipe.ingredients.length,
      };
      break;
    }

    case "audit": {
      result = {
        receivedEventType: event.eventType,
        sourceOccurredAt: event.occurredAt,
        version: event.version,
      };
      break;
    }

    default:
      throw new Error(`Unknown worker: ${worker}`);
  }

  // Record successful processing.
  await updateStatus(event.eventId, {
    status: "SUCCEEDED",
    processedAt: new Date().toISOString(),
    result,
  });

  console.log(
    JSON.stringify({
      eventId: event.eventId,
      worker,
      action: "succeeded",
    })
  );
}

// SQS Lambda handler.
export const handler = async (
  event: SQSEvent
): Promise<SQSBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      // Raw SNS delivery: the SQS body contains our recipe event.
      const payload: unknown = JSON.parse(record.body);

      await processRecipe(payload);
    } catch (error) {
      console.error(
        JSON.stringify({
          worker,
          messageId: record.messageId,
          error: String(error),
        })
      );

      // Only failed messages should be retried.
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
};
