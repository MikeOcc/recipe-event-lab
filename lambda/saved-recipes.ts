import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  authorized,
  response,
  INGREDIENT_UNITS,
  type IngredientUnit,
  type Recipe,
  type RecipeIngredient,
  type RecipeInstruction,
} from "./common";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.RECIPES_TABLE_NAME!;

class InvalidRecipe extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength
  ) {
    throw new InvalidRecipe(`${field} must contain 1-${maxLength} characters.`);
  }

  return value.trim();
}

function nonnegativeInteger(
  value: unknown,
  field: string,
  maximum: number,
  minimum = 0,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new InvalidRecipe(
      `${field} must be an integer between ${minimum} and ${maximum}.`,
    );
  }

  return value;
}

type RecipeDraft = Omit<
  Recipe,
  "recipeId" | "revision" | "createdAt" | "updatedAt"
>;

function validateRecipe(value: unknown): RecipeDraft {
  if (!isRecord(value)) {
    throw new InvalidRecipe("Recipe must be a JSON object.");
  }

  const title = requiredText(value.title, "Title", 120);

  if (
    typeof value.description !== "string" ||
    value.description.length > 2000
  ) {
    throw new InvalidRecipe(
      "Description must be a string of at most 2000 characters.",
    );
  }

  const description = value.description.trim();
  const servings = nonnegativeInteger(value.servings, "Servings", 1000, 1);
  const prepMinutes = nonnegativeInteger(
    value.prepMinutes,
    "Prep minutes",
    10080,
  );
  const cookMinutes = nonnegativeInteger(
    value.cookMinutes,
    "Cook minutes",
    10080,
  );

  if (
    !Array.isArray(value.ingredients) ||
    value.ingredients.length < 1 ||
    value.ingredients.length > 30
  ) {
    throw new InvalidRecipe("Provide between 1 and 30 ingredients.");
  }

  const ingredients: RecipeIngredient[] = value.ingredients.map(
    (item: unknown, index: number) => {
      if (!isRecord(item)) {
        throw new InvalidRecipe(`Ingredient ${index + 1} is invalid.`);
      }

      const name = requiredText(item.name, `Ingredient ${index + 1} name`, 100);

      if (
        typeof item.quantity !== "number" ||
        !Number.isFinite(item.quantity) ||
        item.quantity <= 0
      ) {
        throw new InvalidRecipe(
          `Ingredient ${index + 1} needs a positive quantity.`,
        );
      }

      if (
        typeof item.unit !== "string" ||
        !INGREDIENT_UNITS.includes(item.unit as IngredientUnit)
      ) {
        throw new InvalidRecipe(`Ingredient ${index + 1} has an invalid unit.`);
      }

      if (
        item.notes !== undefined &&
        (typeof item.notes !== "string" || item.notes.length > 250)
      ) {
        throw new InvalidRecipe(`Ingredient ${index + 1} notes are invalid.`);
      }

      return {
        name,
        quantity: item.quantity,
        unit: item.unit as IngredientUnit,
        ...(typeof item.notes === "string" && item.notes.trim()
          ? { notes: item.notes.trim() }
          : {}),
      };
    },
  );

  if (
    !Array.isArray(value.instructions) ||
    value.instructions.length < 1 ||
    value.instructions.length > 50
  ) {
    throw new InvalidRecipe("Provide between 1 and 50 instructions.");
  }

  const instructions: RecipeInstruction[] = value.instructions.map(
    (item: unknown, index: number) => {
      if (!isRecord(item) || item.step !== index + 1) {
        throw new InvalidRecipe(
          `Instruction ${index + 1} must have step ${index + 1}.`,
        );
      }

      return {
        step: index + 1,
        text: requiredText(item.text, `Instruction ${index + 1}`, 1000),
      };
    },
  );

  if (!Array.isArray(value.tags) || value.tags.length > 20) {
    throw new InvalidRecipe("Tags must be an array of at most 20 items.");
  }

  const tags: string[] = value.tags.map((tag: unknown) =>
    requiredText(tag, "Tag", 50),
  );

  if (new Set(tags.map((tag) => tag.toLowerCase())).size !== tags.length) {
    throw new InvalidRecipe("Duplicate tags are not allowed.");
  }

  let imageUrl: string | undefined;

  if (value.imageUrl !== undefined && value.imageUrl !== "") {
    imageUrl = requiredText(value.imageUrl, "Image URL", 2048);

    try {
      const url = new URL(imageUrl);
      if (url.protocol !== "https:" || !url.hostname) {
        throw new Error("Invalid protocol");
      }
    } catch {
      throw new InvalidRecipe("Image URL must be a valid HTTPS URL.");
    }
  }

  return {
    title,
    description,
    servings,
    prepMinutes,
    cookMinutes,
    ingredients,
    instructions,
    tags,
    ...(imageUrl ? { imageUrl } : {}),
  };
}

export async function handler(event: APIGatewayProxyEventV2) {
  if (!authorized(event)) {
    return response(401, { error: "Unauthorized" });
  }

  const method = event.requestContext.http.method;

  if (method === "POST") {
    try {
      if (event.isBase64Encoded) {
        throw new InvalidRecipe("Expected a JSON request body.");
      }

      let body: unknown;

      try {
        body = JSON.parse(event.body ?? "");
      } catch {
        throw new InvalidRecipe("Request body must contain valid JSON.");
      }

      const draft = validateRecipe(body);
      const now = new Date().toISOString();

      const recipe: Recipe = {
        ...draft,
        recipeId: randomUUID(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };

      await db.send(
        new PutCommand({
          TableName: tableName,
          Item: recipe,
          ConditionExpression: "attribute_not_exists(recipeId)",
        }),
      );

      return response(201, {
        recipeId: recipe.recipeId,
        revision: recipe.revision,
      });
    } catch (error) {
      if (error instanceof InvalidRecipe) {
        return response(400, { error: error.message });
      }

      console.error("Failed to save recipe:", error);
      return response(500, { error: "Unable to save recipe." });
    }
  }

  if (method === "GET") {
    const recipeId = event.pathParameters?.recipeId;

    if (!recipeId || !/^[0-9a-f-]{36}$/i.test(recipeId)) {
      return response(400, { error: "Invalid recipe ID." });
    }

    try {
      const result = await db.send(
        new GetCommand({
          TableName: tableName,
          Key: { recipeId },
          ConsistentRead: true,
        }),
      );

      if (!result.Item) {
        return response(404, { error: "Recipe not found." });
      }

      return response(200, result.Item);
    } catch (error) {
      console.error("Failed to retrieve recipe:", error);
      return response(500, { error: "Unable to retrieve recipe." });
    }
  }

  return response(405, { error: "Method not allowed." });
}
