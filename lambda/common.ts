import { APIGatewayProxyEventV2 } from "aws-lambda";

export type WorkKind = "search" | "nutrition" | "audit";

export interface RecipeEvent {
  eventId: string;
  eventType: "recipe.published";
  version: 2;
  occurredAt: string;
  recipe: Recipe;
  demo: {
    failNutrition: boolean;
  };
}

export function response(statusCode: number, data: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}

export function authorized(event: APIGatewayProxyEventV2): boolean {
  // For a controlled portfolio demo only. Use JWT/OIDC for a public production app.
  const token = event.headers?.["x-demo-token"];
  return Boolean(
    token && process.env.DEMO_TOKEN && token === process.env.DEMO_TOKEN,
  );
}

export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: IngredientUnit;
  notes?: string;
}

export interface Recipe {
  title: string;
  ingredients: RecipeIngredient[];
}


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

export type IngredientUnit =
  (typeof INGREDIENT_UNITS)[number];


export interface RecipeIngredient {
  name: string;
  quantity: number;
  unit: IngredientUnit;
  notes?: string;
}

export interface Recipe {
  title: string;
  ingredients: RecipeIngredient[];
}
