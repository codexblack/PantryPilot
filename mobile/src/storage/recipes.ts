import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Recipe, RecipeImage } from '../types';

const KEY = '@pantrypilot/saved-recipes/v1';
const LIMIT = 30;
const NOTE_CHARACTER_LIMIT = 160;
const NOTE_WORD_LIMIT = 20;
let writeQueue: Promise<void> = Promise.resolve();

export type SavedRecipe = {
  recipe: Recipe;
  cuisine: string;
  savedAt: string;
  generatedAt: string;
  notes: string;
  image?: RecipeImage | null;
};

type RecipeMutation = (recipes: SavedRecipe[]) => SavedRecipe[];
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function boundedString(value: unknown, minimum: number, maximum: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length >= minimum && normalized.length <= maximum ? normalized : null;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | null {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : null;
}

function optionalString(value: unknown, maximum: number): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  return boundedString(value, 1, maximum) ?? undefined;
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  return boundedInteger(value, minimum, maximum) ?? undefined;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeNotes(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  const characterLimited = value.trim().slice(0, NOTE_CHARACTER_LIMIT);
  return characterLimited.split(/\s+/).filter(Boolean).slice(0, NOTE_WORD_LIMIT).join(' ');
}

function isRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSupportedImageUrl(value: string): boolean {
  if (isRemoteUrl(value)) {
    return true;
  }
  const prefix = value.match(/^data:image\/(?:jpeg|jpg|png|webp);base64,/i)?.[0];
  return Boolean(prefix && value.length > prefix.length);
}

function normalizeRecipeImage(value: unknown, recipeTitle: string): RecipeImage | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  const image = asObject(value);
  const url = boundedString(image?.url, 1, 2_000_000);
  if (!image || !url || !isSupportedImageUrl(url)) {
    return null;
  }

  const sourceUrl = optionalString(image.source_url, 2_000);
  return {
    url,
    alt: boundedString(image.alt, 1, 250) ?? `Dish preview for ${recipeTitle}`,
    attribution: optionalString(image.attribution, 500),
    license: optionalString(image.license, 80),
    source_url: sourceUrl && isRemoteUrl(sourceUrl) ? sourceUrl : undefined,
  };
}

function normalizeRecipe(value: unknown): Recipe | null {
  const recipe = asObject(value);
  if (!recipe) {
    return null;
  }

  const title = boundedString(recipe.title, 1, 100);
  const description = boundedString(recipe.description, 1, 280);
  const prepMinutes = boundedInteger(recipe.prep_minutes, 0, 240);
  const cookMinutes = boundedInteger(recipe.cook_minutes, 0, 240);
  const servings = recipe.servings === undefined ? 1 : boundedInteger(recipe.servings, 1, 12);
  if (!title || !description || prepMinutes === null || cookMinutes === null || servings === null) {
    return null;
  }

  if (
    !Array.isArray(recipe.ingredients) ||
    recipe.ingredients.length < 1 ||
    recipe.ingredients.length > 30
  ) {
    return null;
  }
  const ingredients: string[] = [];
  for (const ingredient of recipe.ingredients) {
    const normalized = boundedString(ingredient, 1, 200);
    if (!normalized) {
      return null;
    }
    ingredients.push(normalized);
  }

  if (!Array.isArray(recipe.steps) || recipe.steps.length < 1 || recipe.steps.length > 12) {
    return null;
  }
  const steps: Recipe['steps'] = [];
  for (const stepValue of recipe.steps) {
    const step = asObject(stepValue);
    const order = boundedInteger(step?.order, 1, 20);
    const text = boundedString(step?.text, 1, 400);
    if (!step || order === null || !text) {
      return null;
    }
    steps.push({ order, text });
  }

  const cuisine = optionalString(recipe.cuisine, 40);
  const caloriesPerServing = optionalInteger(recipe.calories_per_serving, 50, 2_000);
  const storageTip = optionalString(recipe.storage_tip, 300);
  const fastPerishingUtilization = optionalInteger(recipe.fast_perishing_utilization, 0, 100);
  if (
    (recipe.cuisine !== undefined && recipe.cuisine !== null && cuisine === undefined) ||
    (typeof cuisine === 'string' && cuisine.length < 2) ||
    (recipe.calories_per_serving !== undefined &&
      recipe.calories_per_serving !== null &&
      caloriesPerServing === undefined) ||
    (recipe.storage_tip !== undefined && recipe.storage_tip !== null && storageTip === undefined) ||
    (recipe.fast_perishing_utilization !== undefined &&
      recipe.fast_perishing_utilization !== null &&
      fastPerishingUtilization === undefined)
  ) {
    return null;
  }
  if (recipe.is_vegan !== undefined && typeof recipe.is_vegan !== 'boolean') {
    return null;
  }
  if (recipe.is_gluten_free !== undefined && typeof recipe.is_gluten_free !== 'boolean') {
    return null;
  }
  if (recipe.is_vegetarian !== undefined && typeof recipe.is_vegetarian !== 'boolean') {
    return null;
  }
  if (recipe.is_keto_friendly !== undefined && typeof recipe.is_keto_friendly !== 'boolean') {
    return null;
  }

  return {
    title,
    cuisine,
    description,
    prep_minutes: prepMinutes,
    cook_minutes: cookMinutes,
    servings,
    calories_per_serving: caloriesPerServing,
    ingredients,
    steps,
    storage_tip: storageTip,
    fast_perishing_utilization: fastPerishingUtilization,
    is_vegan: recipe.is_vegan ?? false,
    is_gluten_free: recipe.is_gluten_free ?? false,
    is_vegetarian: recipe.is_vegetarian ?? false,
    is_keto_friendly: recipe.is_keto_friendly ?? false,
  };
}

function normalizeSavedRecipe(value: unknown): SavedRecipe | null {
  const entry = asObject(value);
  const recipe = normalizeRecipe(entry?.recipe);
  const savedAt = normalizeDate(entry?.savedAt);
  if (!entry || !recipe || !savedAt) {
    return null;
  }

  const entryCuisine = boundedString(entry.cuisine, 2, 40);
  return {
    recipe,
    cuisine: entryCuisine ?? recipe.cuisine ?? 'Recipe',
    savedAt,
    generatedAt: normalizeDate(entry.generatedAt) ?? savedAt,
    notes: normalizeNotes(entry.notes),
    image: normalizeRecipeImage(entry.image, recipe.title),
  };
}

function requireRecipe(value: unknown): Recipe {
  const recipe = normalizeRecipe(value);
  if (!recipe) {
    throw new Error('Cannot save an invalid recipe.');
  }
  return recipe;
}

function requireRecipeImage(value: RecipeImage | null, recipeTitle: string): RecipeImage | null {
  if (value === null) {
    return null;
  }
  const image = normalizeRecipeImage(value, recipeTitle);
  if (!image) {
    throw new Error('Cannot save an invalid recipe image.');
  }
  return image;
}

function requireSavedAt(value: unknown): string {
  const savedAt = normalizeDate(value);
  if (!savedAt) {
    throw new Error('Cannot update an invalid saved recipe identifier.');
  }
  return savedAt;
}

function requireNotes(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Cannot save invalid recipe notes.');
  }
  return normalizeNotes(value);
}

function normalizeRecipeTitle(title: string) {
  return title.trim().toLowerCase();
}

function mutateSavedRecipes(mutation: RecipeMutation): Promise<SavedRecipe[]> {
  const operation = writeQueue.then(async () => {
    const current = await getSavedRecipes();
    const next = mutation(current)
      .slice(0, LIMIT)
      .map((entry) => {
        const normalized = normalizeSavedRecipe(entry);
        if (!normalized) {
          throw new Error('Refusing to persist an invalid saved recipe.');
        }
        return normalized;
      });
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
    return next;
  });
  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

export async function getSavedRecipes(): Promise<SavedRecipe[]> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const envelope = asObject(parsed);
    const recipes = Array.isArray(parsed)
      ? parsed
      : Array.isArray(envelope?.recipes)
        ? envelope.recipes
        : null;
    if (!recipes) {
      return [];
    }

    const validated: SavedRecipe[] = [];
    const seenIds = new Set<string>();
    for (const value of recipes) {
      const entry = normalizeSavedRecipe(value);
      if (!entry || seenIds.has(entry.savedAt)) {
        continue;
      }
      seenIds.add(entry.savedAt);
      validated.push(entry);
      if (validated.length === LIMIT) {
        break;
      }
    }
    return validated;
  } catch {
    return [];
  }
}

export function saveRecipe(
  recipe: Recipe,
  cuisine: string,
  generatedAt: string,
  image?: RecipeImage | null,
): Promise<SavedRecipe[]> {
  const normalizedRecipe = requireRecipe(recipe);
  const normalizedGeneratedAt = normalizeDate(generatedAt) ?? new Date().toISOString();
  const normalizedImage =
    image === undefined ? undefined : requireRecipeImage(image, normalizedRecipe.title);
  return mutateSavedRecipes((existing) => {
    const title = normalizeRecipeTitle(normalizedRecipe.title);
    const duplicate = existing.find((entry) => normalizeRecipeTitle(entry.recipe.title) === title);
    const withoutDuplicate = existing.filter(
      (entry) => normalizeRecipeTitle(entry.recipe.title) !== title,
    );
    return [
      {
        recipe: normalizedRecipe,
        cuisine: boundedString(cuisine, 2, 40) ?? normalizedRecipe.cuisine ?? 'Recipe',
        generatedAt: normalizedGeneratedAt,
        image:
          normalizedImage === undefined
            ? duplicate?.image
            : (normalizedImage ?? duplicate?.image ?? null),
        notes: duplicate?.notes ?? '',
        savedAt: new Date().toISOString(),
      },
      ...withoutDuplicate,
    ];
  });
}

export function updateRecipeNotes(savedAt: string, notes: string): Promise<SavedRecipe[]> {
  const normalizedSavedAt = requireSavedAt(savedAt);
  const normalizedNotes = requireNotes(notes);
  return mutateSavedRecipes((existing) =>
    existing.map((entry) =>
      entry.savedAt === normalizedSavedAt ? { ...entry, notes: normalizedNotes } : entry,
    ),
  );
}

export function updateRecipeImage(
  savedAt: string,
  image: RecipeImage | null,
): Promise<SavedRecipe[]> {
  const normalizedSavedAt = requireSavedAt(savedAt);
  const normalizedImage = requireRecipeImage(image, 'Saved recipe');
  return mutateSavedRecipes((existing) =>
    existing.map((entry) =>
      entry.savedAt === normalizedSavedAt ? { ...entry, image: normalizedImage } : entry,
    ),
  );
}

export function deleteSavedRecipe(savedAt: string): Promise<SavedRecipe[]> {
  const normalizedSavedAt = requireSavedAt(savedAt);
  return mutateSavedRecipes((existing) =>
    existing.filter((entry) => entry.savedAt !== normalizedSavedAt),
  );
}
