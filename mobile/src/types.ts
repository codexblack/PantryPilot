export type Freshness = 'fresh' | 'use_soon' | 'unknown';

export type Ingredient = {
  name: string;
  normalized_name: string;
  quantity?: string | null;
  confidence: number;
  freshness: Freshness;
  opened?: boolean | null;
};

export type ScanResponse = {
  ingredients: Ingredient[];
  frames_analyzed: number;
  demo_mode: boolean;
  notice?: string | null;
};

export type DietaryChoice = 'none' | 'vegan' | 'vegetarian' | 'keto';

export type DietaryProfile = {
  diet: DietaryChoice;
  gluten_free: boolean;
  oven_available: boolean;
};

export type Recipe = {
  title: string;
  cuisine?: string | null;
  description: string;
  prep_minutes: number;
  cook_minutes: number;
  servings: number;
  calories_per_serving?: number | null;
  ingredients: string[];
  steps: { order: number; text: string }[];
  storage_tip?: string | null;
  fast_perishing_utilization?: number | null;
  is_vegan: boolean;
  is_gluten_free: boolean;
  is_vegetarian?: boolean;
  is_keto_friendly?: boolean;
};

export type StoreOffer = {
  store_name: string;
  distance_miles?: number | null;
  address?: string | null;
  item_name: string;
  requested_item_name?: string | null;
  price?: string | null;
  price_source?: string | null;
  thumbnail_url?: string | null;
  availability: string;
};

export type StoreLookupResponse = {
  stores: StoreOffer[];
  shopping_notice: string;
};

export type RecipeImage = {
  url: string;
  alt: string;
  attribution?: string | null;
  license?: string | null;
  source_url?: string | null;
};

export type PlanResponse = {
  status: 'recipe_found' | 'needs_shopping' | 'no_feasible_recipe';
  recipe?: Recipe | null;
  missing_ingredients: string[];
  stores: StoreOffer[];
  shopping_notice?: string | null;
  demo_mode: boolean;
};
