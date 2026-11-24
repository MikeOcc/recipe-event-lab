import { SQSEvent, SQSBatchResponse } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { RecipeEvent, WorkKind, INGREDIENT_UNITS } from "./common";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const table = process.env.TABLE_NAME!;
const worker = process.env.WORKER as WorkKind;

// Validate an incoming SNS event before processing it.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRecipeEvent(value: unknown): value is RecipeEvent {
  if (!isRecord(value)) return false;

  if (
    value.eventType !== "recipe.published" ||
    typeof value.eventId !== "string" ||
    !value.eventId ||
    typeof value.occurredAt !== "string" ||
    !value.occurredAt
  ) {
    return false;
  }

  const recipe = value.recipe;
  const demo = value.demo;

  if (
    !isRecord(recipe) ||
    typeof recipe.title !== "string" ||
    !recipe.title.trim() ||
    !isRecord(demo) ||
    typeof demo.failNutrition !== "boolean" ||
    !Array.isArray(recipe.ingredients) ||
    recipe.ingredients.length < 1 ||
    recipe.ingredients.length > 30
  ) {
    return false;
  }

  const ingredientsValid = recipe.ingredients.every(
    (ingredient: unknown) =>
      isRecord(ingredient) &&
      typeof ingredient.name === "string" &&
      ingredient.name.trim().length > 0 &&
      typeof ingredient.quantity === "number" &&
      Number.isFinite(ingredient.quantity) &&
      ingredient.quantity > 0 &&
      typeof ingredient.unit === "string" &&
      (INGREDIENT_UNITS as readonly string[]).includes(ingredient.unit) &&
      (ingredient.notes === undefined || typeof ingredient.notes === "string"),
  );

  if (!ingredientsValid) return false;

  // Existing event contract remains supported.
  if (value.version === 2) return true;

  if (value.version !== 3) return false;

  // Version 3 carries a saved recipe and its revision.
  if (
    typeof value.recipeId !== "string" ||
    !value.recipeId ||
    typeof value.revision !== "number" ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    recipe.recipeId !== value.recipeId ||
    recipe.revision !== value.revision ||
    typeof recipe.description !== "string" ||
    typeof recipe.servings !== "number" ||
    !Number.isInteger(recipe.servings) ||
    recipe.servings < 1 ||
    typeof recipe.prepMinutes !== "number" ||
    !Number.isInteger(recipe.prepMinutes) ||
    recipe.prepMinutes < 0 ||
    typeof recipe.cookMinutes !== "number" ||
    !Number.isInteger(recipe.cookMinutes) ||
    recipe.cookMinutes < 0 ||
    typeof recipe.createdAt !== "string" ||
    typeof recipe.updatedAt !== "string" ||
    (recipe.imageUrl !== undefined && typeof recipe.imageUrl !== "string")
  ) {
    return false;
  }

  if (
    !Array.isArray(recipe.instructions) ||
    recipe.instructions.length < 1 ||
    recipe.instructions.length > 50 ||
    !recipe.instructions.every(
      (instruction: unknown, index: number) =>
        isRecord(instruction) &&
        instruction.step === index + 1 &&
        typeof instruction.text === "string" &&
        instruction.text.trim().length > 0 &&
        instruction.text.length <= 1000,
    )
  ) {
    return false;
  }

  return (
    Array.isArray(recipe.tags) &&
    recipe.tags.length <= 20 &&
    recipe.tags.every(
      (tag: unknown) =>
        typeof tag === "string" && tag.trim().length > 0 && tag.length <= 50,
    )
  );
}

// Update this worker's processing status in DynamoDB.
async function updateStatus(eventId: string, value: Record<string, unknown>) {
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
    }),
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
        (ingredient) => ingredient.name,
      );

      const words =
        [event.recipe.title, ...ingredientNames]
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
        ...(event.version === 3
          ? {
              recipeId: event.recipeId,
              revision: event.revision,
            }
          : {}),
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
    }),
  );
}

// SQS Lambda handler.
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
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
        }),
      );

      // Only failed messages should be retried.
      batchItemFailures.push({
        itemIdentifier: record.messageId,
      });
    }
  }

  return { batchItemFailures };
};
