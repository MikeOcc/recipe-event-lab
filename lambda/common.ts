import { APIGatewayProxyEventV2 } from "aws-lambda";

// --------------------------------------------------
// Worker definitions
// --------------------------------------------------

export type WorkKind = "search" | "nutrition" | "audit";

// --------------------------------------------------
// Ingredient definitions
// --------------------------------------------------

export const INGREDIENT_UNITS = [
  "cup",
  "tbsp",
  "tsp",
  "g",
  "kg",
  "oz",
  "lb",
  "ml",
  "l",
  "each",
  "clove",
  "pinch",
] as const;

export type IngredientUnit = (typeof INGREDIENT_UNITS)[number];

export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: IngredientUnit;
  notes?: string;
}

// --------------------------------------------------
// Existing version 2 event recipe payload
// --------------------------------------------------

// This preserves compatibility with our deployed
// publisher and worker Lambda functions.

export interface RecipePayloadV2 {
  title: string;
  ingredients: RecipeIngredient[];
}

// --------------------------------------------------
// Complete recipe model
// --------------------------------------------------

export interface RecipeInstruction {
  step: number;
  text: string;
}

// The canonical recipe stored in the Recipes table.

export interface Recipe extends RecipePayloadV2 {
  recipeId: string;
  revision: number;

  description: string;
  servings: number;

  prepMinutes: number;
  cookMinutes: number;

  instructions: RecipeInstruction[];
  tags: string[];

  imageUrl?: string;

  createdAt: string;
  updatedAt: string;
}

// --------------------------------------------------
// SNS event definitions
// --------------------------------------------------

export interface RecipeEventV2 {
  eventId: string;
  eventType: "recipe.published";
  version: 2;
  occurredAt: string;
  recipe: RecipePayloadV2;
  demo: {
    failNutrition: boolean;
  };
}

export interface RecipeEventV3 {
  eventId: string;
  eventType: "recipe.published";
  version: 3;
  occurredAt: string;

  recipeId: string;
  revision: number;

  // Snapshot of the recipe at publication time.
  recipe: Recipe;

  demo: {
    failNutrition: boolean;
  };
}

export type RecipeEvent = RecipeEventV2 | RecipeEventV3;

// --------------------------------------------------
// HTTP response helper
// --------------------------------------------------

export function response(statusCode: number, data: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(data),
  };
}

// --------------------------------------------------
// Demo API authorization
// --------------------------------------------------

export function authorized(event: APIGatewayProxyEventV2): boolean {
  // Portfolio demo only.
  // Use JWT/OIDC for a public application.

  const token = event.headers?.["x-demo-token"];

  return Boolean(
    token && process.env.DEMO_TOKEN && token === process.env.DEMO_TOKEN,
  );
}
