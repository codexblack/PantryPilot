from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_SCAN_INGREDIENTS = 80


class ApiModel(BaseModel):
    """Base model with consistent public API string normalization."""

    model_config = ConfigDict(str_strip_whitespace=True)


class Freshness(StrEnum):
    FRESH = "fresh"
    USE_SOON = "use_soon"
    UNKNOWN = "unknown"


class DietaryChoice(StrEnum):
    NONE = "none"
    VEGAN = "vegan"
    VEGETARIAN = "vegetarian"
    KETO = "keto"


class PlanStatus(StrEnum):
    RECIPE_FOUND = "recipe_found"
    NEEDS_SHOPPING = "needs_shopping"
    NO_FEASIBLE_RECIPE = "no_feasible_recipe"


class Ingredient(ApiModel):
    name: str = Field(min_length=1, max_length=80)
    normalized_name: str = Field(min_length=1, max_length=80)
    quantity: str | None = Field(default=None, max_length=80)
    confidence: float = Field(ge=0, le=1)
    freshness: Freshness = Freshness.UNKNOWN
    opened: bool | None = None

    @field_validator("name", "normalized_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return " ".join(value.lower().strip().split())


class ScanResponse(ApiModel):
    ingredients: list[Ingredient] = Field(max_length=MAX_SCAN_INGREDIENTS)
    frames_analyzed: int = Field(ge=0)
    demo_mode: bool
    notice: str | None = None


class DietaryProfile(ApiModel):
    diet: DietaryChoice = DietaryChoice.NONE
    gluten_free: bool = False
    oven_available: bool = False


class Coordinates(ApiModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


class StoreLookupRequest(ApiModel):
    items: list[str] = Field(min_length=1, max_length=2)
    location: Coordinates

    @field_validator("items")
    @classmethod
    def clean_items(cls, values: list[str]) -> list[str]:
        """Normalize, bound, and de-duplicate grocery search terms."""
        normalized = [" ".join(value.lower().split()) for value in values]
        if any(len(value) > 80 for value in normalized):
            raise ValueError("store lookup items must contain at most 80 characters")
        cleaned = list(dict.fromkeys(value for value in normalized if value))
        if not cleaned:
            raise ValueError("at least one store lookup item is required")
        return cleaned


class PlanRequest(ApiModel):
    cuisine: str = Field(min_length=2, max_length=40)
    ingredients: list[Ingredient] = Field(min_length=1, max_length=80)
    staples: list[str] = Field(default_factory=list, max_length=40)
    dietary: DietaryProfile = Field(default_factory=DietaryProfile)
    taste_profile: str | None = Field(default=None, max_length=80)
    exclude_recipe_titles: list[str] = Field(default_factory=list, max_length=12)

    @field_validator("cuisine")
    @classmethod
    def clean_cuisine(cls, value: str) -> str:
        return value.strip().title()

    @field_validator("staples")
    @classmethod
    def clean_staples(cls, values: list[str]) -> list[str]:
        """Normalize, bound, and de-duplicate staple names."""
        normalized = [" ".join(value.lower().split()) for value in values]
        if any(len(value) > 80 for value in normalized):
            raise ValueError("staple names must contain at most 80 characters")
        return list(dict.fromkeys(value for value in normalized if value))

    @field_validator("taste_profile")
    @classmethod
    def clean_taste_profile(cls, value: str | None) -> str | None:
        if not value:
            return None
        return " ".join(value.split()[:10]) or None

    @field_validator("exclude_recipe_titles")
    @classmethod
    def clean_excluded_titles(cls, values: list[str]) -> list[str]:
        normalized = [" ".join(value.lower().split()) for value in values]
        if any(len(value) > 100 for value in normalized):
            raise ValueError("excluded recipe titles must contain at most 100 characters")
        return list(dict.fromkeys(value for value in normalized if value))


class RecipeStep(ApiModel):
    order: int = Field(ge=1, le=20)
    text: str = Field(min_length=1, max_length=400)


class Recipe(ApiModel):
    title: str = Field(min_length=1, max_length=100)
    cuisine: str = Field(min_length=2, max_length=40)
    description: str = Field(min_length=1, max_length=280)
    prep_minutes: int = Field(ge=0, le=240)
    cook_minutes: int = Field(ge=0, le=240)
    servings: int = Field(default=1, ge=1, le=12)
    calories_per_serving: int | None = Field(default=None, ge=50, le=2000)
    ingredients: list[str] = Field(min_length=1, max_length=30)
    steps: list[RecipeStep] = Field(min_length=1, max_length=12)
    storage_tip: str | None = Field(default=None, max_length=300)
    fast_perishing_utilization: int | None = Field(default=None, ge=0, le=100)
    is_vegan: bool
    is_gluten_free: bool
    is_vegetarian: bool = False
    is_keto_friendly: bool = False

    @field_validator("ingredients")
    @classmethod
    def clean_ingredients(cls, values: list[str]) -> list[str]:
        """Normalize and bound recipe ingredient display strings."""
        cleaned = [" ".join(value.split()) for value in values]
        if any(not value or len(value) > 200 for value in cleaned):
            raise ValueError("recipe ingredients must contain 1 to 200 characters")
        return cleaned


class StoreOffer(ApiModel):
    store_name: str = Field(min_length=1, max_length=120)
    distance_miles: float | None = Field(default=None, ge=0)
    address: str | None = Field(default=None, max_length=300)
    item_name: str = Field(min_length=1, max_length=120)
    requested_item_name: str | None = Field(default=None, min_length=1, max_length=120)
    price: str | None = Field(default=None, max_length=40)
    price_source: str | None = Field(default=None, max_length=120)
    thumbnail_url: str | None = Field(default=None, max_length=2_000)
    availability: str = Field(default="unknown", min_length=1, max_length=40)


class StoreLookupResponse(ApiModel):
    stores: list[StoreOffer] = Field(default_factory=list)
    shopping_notice: str = Field(min_length=1, max_length=500)


class RecipeImage(ApiModel):
    url: str = Field(min_length=1, max_length=2_000_000)
    alt: str = Field(min_length=1, max_length=250)
    attribution: str | None = Field(default=None, max_length=500)
    license: str | None = Field(default=None, max_length=80)
    source_url: str | None = Field(default=None, max_length=2_000)


class RecipeImageRequest(ApiModel):
    title: str = Field(min_length=2, max_length=120)


class RecipeImageResponse(ApiModel):
    image: RecipeImage | None = None


class PlanResponse(ApiModel):
    status: PlanStatus
    recipe: Recipe | None = None
    missing_ingredients: list[str] = Field(default_factory=list)
    stores: list[StoreOffer] = Field(default_factory=list)
    shopping_notice: str | None = None
    demo_mode: bool
