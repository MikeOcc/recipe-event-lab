
import { describe, expect, it } from "vitest";
import { isRecipeEvent } from "../lambda/worker";
import type {
  RecipeEventV2,
  RecipeEventV3,
  Recipe,
} from "../lambda/common";

const recipe: Recipe = {
  recipeId: "recipe-123",
  revision: 1,
  title: "New England Clam Chowder",
  description: "A creamy seafood soup.",
  servings: 6,
  prepMinutes: 20,
  cookMinutes: 35,
  ingredients: [
    {
      name: "Clams",
      quantity: 2,
      unit: "cup",
    },
  ],
  instructions: [
    {
      step: 1,
      text: "Combine ingredients and cook.",
    },
  ],
  tags: ["soup", "seafood"],
  createdAt: "2026-11-24T00:00:00Z",
  updatedAt: "2026-11-24T00:00:00Z",
};

const eventV2: RecipeEventV2 = {
  eventId: "event-v2",
  eventType: "recipe.published",
  version: 2,
  occurredAt: "2026-11-24T00:00:00Z",
  recipe: {
    title: recipe.title,
    ingredients: recipe.ingredients,
  },
  demo: { failNutrition: false },
};

const eventV3: RecipeEventV3 = {
  eventId: "event-v3",
  eventType: "recipe.published",
  version: 3,
  occurredAt: "2026-11-24T00:00:00Z",
  recipeId: recipe.recipeId,
  revision: recipe.revision,
  recipe,
  demo: { failNutrition: false },
};

describe("Recipe event validation", () => {
  it("accepts existing version 2 events", () => {
    expect(isRecipeEvent(eventV2)).toBe(true);
  });

  it("accepts version 3 saved-recipe events", () => {
    expect(isRecipeEvent(eventV3)).toBe(true);
  });

  it("rejects a mismatched recipe revision", () => {
    expect(
      isRecipeEvent({
        ...eventV3,
        revision: 2,
      }),
    ).toBe(false);
  });

  it("rejects a mismatched recipe ID", () => {
    expect(
      isRecipeEvent({
        ...eventV3,
        recipeId: "wrong-recipe",
      }),
    ).toBe(false);
  });

  it("rejects invalid ingredient quantities", () => {
    expect(
      isRecipeEvent({
        ...eventV3,
        recipe: {
          ...recipe,
          ingredients: [
            { name: "Clams", quantity: -2, unit: "cup" },
          ],
        },
      }),
    ).toBe(false);
  });

  it("rejects version 3 recipes without instructions", () => {
    expect(
      isRecipeEvent({
        ...eventV3,
        recipe: {
          ...recipe,
          instructions: [],
        },
      }),
    ).toBe(false);
  });

  it("rejects unsupported event versions", () => {
    expect(
      isRecipeEvent({
        ...eventV3,
        version: 99,
      }),
    ).toBe(false);
  });
});
