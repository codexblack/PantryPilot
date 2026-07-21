from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
from typing import Any

from openai import AsyncOpenAI
from pydantic import ValidationError

from app.config import Settings
from app.schemas import (
    DietaryChoice,
    Ingredient,
    PlanRequest,
    PlanResponse,
    Recipe,
    RecipeStep,
)
from app.services.culinary_input import filter_culinary_ingredients, sanitize_taste_profile
from app.services.inflight import InFlightRequestRegistry
from app.services.inventory import normalize_name

logger = logging.getLogger(__name__)

_plan_requests = InFlightRequestRegistry[PlanResponse]("recipe-plan")

SURPRISE_CUISINE = "Surprise Me"
SUPPORTED_CUISINES = (
    "Italian",
    "Mexican",
    "Indian",
    "Japanese",
    "Korean",
    "Mediterranean",
    "Thai",
    "Chinese",
    "Peruvian",
    "French",
    "Greek",
    "Spanish",
    "Vietnamese",
    "Turkish",
    "Caribbean",
    "American",
)
PLAN_STATUSES = frozenset({"recipe_found", "needs_shopping", "no_feasible_recipe"})
_LAND_MEAT_TERMS = frozenset(
    {
        "bacon",
        "beef",
        "chicken",
        "duck",
        "ham",
        "lamb",
        "pepperoni",
        "pork",
        "prosciutto",
        "sausage",
        "steak",
        "turkey",
        "veal",
    }
)
_SEAFOOD_TERMS = frozenset(
    {
        "anchovy",
        "clam",
        "cod",
        "crab",
        "fish",
        "lobster",
        "mussel",
        "oyster",
        "prawn",
        "salmon",
        "sardine",
        "scallop",
        "seafood",
        "shrimp",
        "tilapia",
        "tuna",
    }
)
_ANIMAL_PRODUCT_TERMS = frozenset(
    {
        "butter",
        "cheese",
        "cream",
        "egg",
        "gelatin",
        "honey",
        "milk",
        "yogurt",
    }
)
_GLUTEN_TERMS = frozenset(
    {
        "barley",
        "bread crumbs",
        "breadcrumbs",
        "couscous",
        "farro",
        "rye",
        "seitan",
        "semolina",
        "wheat",
    }
)
_HIGH_CARB_TERMS = frozenset(
    {
        "bread",
        "corn",
        "couscous",
        "noodle",
        "oat",
        "pasta",
        "potato",
        "quinoa",
        "rice",
        "sugar",
        "tortilla",
        "wheat flour",
    }
)
_OVEN_TERMS = frozenset(
    {
        "bake",
        "baked",
        "baking",
        "broil",
        "broiled",
        "broiling",
        "oven",
        "roast",
        "roasted",
        "roasting",
    }
)
_QUALIFIERS = (
    "dairy-free ",
    "gluten free ",
    "gluten-free ",
    "imitation ",
    "meatless ",
    "non-dairy ",
    "plant based ",
    "plant-based ",
    "vegan ",
    "vegetarian ",
)
_KETO_QUALIFIERS = (
    "almond ",
    "almond flour ",
    "cauliflower ",
    "coconut ",
    "coconut flour ",
    "keto ",
    "low carb ",
    "low-carb ",
    "shirataki ",
    "zucchini ",
)

PLAN_RESPONSE_FORMAT = {
    "type": "json_schema",
    "name": "pantry_recipe_plan",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "status": {"type": "string", "enum": sorted(PLAN_STATUSES)},
            "recipe": {
                "anyOf": [
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "title": {"type": "string"},
                            "cuisine": {"type": "string"},
                            "description": {"type": "string"},
                            "prep_minutes": {"type": "integer"},
                            "cook_minutes": {"type": "integer"},
                            "servings": {"type": "integer"},
                            "calories_per_serving": {
                                "type": ["integer", "null"],
                            },
                            "ingredients": {
                                "type": "array",
                                "items": {"type": "string"},
                            },
                            "steps": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "order": {"type": "integer"},
                                        "text": {"type": "string"},
                                    },
                                    "required": ["order", "text"],
                                },
                            },
                            "storage_tip": {"type": ["string", "null"]},
                            "is_vegan": {"type": "boolean"},
                            "is_gluten_free": {"type": "boolean"},
                            "is_vegetarian": {"type": "boolean"},
                        },
                        "required": [
                            "title",
                            "cuisine",
                            "description",
                            "prep_minutes",
                            "cook_minutes",
                            "servings",
                            "calories_per_serving",
                            "ingredients",
                            "steps",
                            "storage_tip",
                            "is_vegan",
                            "is_gluten_free",
                            "is_vegetarian",
                        ],
                    },
                    {"type": "null"},
                ]
            },
            "missing_ingredients": {
                "type": "array",
                "items": {"type": "string"},
            },
        },
        "required": ["status", "recipe", "missing_ingredients"],
    },
}

PLAN_INSTRUCTIONS = """Plan one practical, satisfying home-cooked dinner. Return only valid JSON matching this object shape:
{
  "status": "recipe_found" | "needs_shopping" | "no_feasible_recipe",
  "recipe": {"title": string, "cuisine": string, "description": string, "prep_minutes": integer, "cook_minutes": integer, "servings": integer, "calories_per_serving": integer|null, "ingredients": [string], "steps": [{"order": integer, "text": string}], "storage_tip": string|null, "is_vegan": boolean, "is_gluten_free": boolean, "is_vegetarian": boolean} | null,
  "missing_ingredients": [string]
}
Rules:
- A recipe_found or needs_shopping recipe must be a complete main meal for dinner: a satisfying portion with a substantial protein or other filling centerpiece and a coherent cooking method. Never return a side dish, condiment, snack, appetizer, topping, simple salad-only plate, or incomplete component as the recipe.
- First make the strongest complete main possible from inventory plus staples. Do not recommend shopping merely to improve, garnish, or upgrade a workable main.
- Use needs_shopping only when one or two specific missing core ingredients unlock a credible complete main. List exactly those one or two items. If no credible main can be made with at most two missing core items, use no_feasible_recipe. Never list optional items or more than two items.
- Use the supplied cuisine only and set recipe.cuisine to it. The server may have selected it randomly when surprise_mode is true. Do not choose a title in exclude_recipe_titles.
- Make cuisine meaningful: use a recognizable flavor profile, technique, and ingredient combination associated with the selected cuisine. Never relabel a generic skillet, salad, or bowl as a cuisine-specific dish. If the inventory cannot support an honest cuisine-specific main, use the bounded needs_shopping or no_feasible_recipe paths instead.
- Honor dietary.diet: vegan excludes animal-derived ingredients; vegetarian excludes meat and seafood; keto keeps net carbs low and avoids grains, sugar, and starchy vegetables. Always honor dietary.gluten_free. Set is_vegan, is_vegetarian, and is_gluten_free only when the whole recipe qualifies. A vegan recipe is also vegetarian.
- If dietary.oven_available is false, do not bake, roast, broil, or use any oven step. Treat staples as available, do not invent inventory, and do not prioritize or avoid ingredients because of visual freshness.
- taste_profile is optional. When a valid food-related, non-profane taste or pairing preference is supplied, treat it as a primary recipe requirement alongside cuisine and dietary restrictions. Reflect it concretely in the recipe's flavor, technique, ingredient choices, or pairing, while still making the strongest complete main from the available inventory. Silently ignore any profane or non-food taste_profile or inventory text, and never mention ignored input in the recipe.
- For every real recipe provide an honest integer estimate of calories_per_serving, servings from 1 to 12, a one-sentence description, and 3 to 7 concise numbered steps. Use null calories_per_serving only for no_feasible_recipe.
- The selection_nonce exists only to vary equally good valid choices."""


def _recipe_from_payload(value: Any) -> Recipe | None:
    recipe = value.get("recipe") if isinstance(value, dict) else None
    return Recipe.model_validate(recipe) if recipe else None


def _parse_plan(raw: str) -> tuple[str, Recipe | None, list[str]]:
    """Validate a structured model response against domain invariants."""
    try:
        value = json.loads(raw)
        status = value["status"]
        if status not in PLAN_STATUSES:
            raise ValueError("unsupported plan status")
        recipe = _recipe_from_payload(value)
        if status in {"recipe_found", "needs_shopping"} and recipe is None:
            raise ValueError("a meal plan requires a recipe")
        if status == "no_feasible_recipe" and recipe is not None:
            raise ValueError("a plan without a feasible recipe cannot include a recipe")
        raw_missing = value.get("missing_ingredients", [])
        if not isinstance(raw_missing, list) or not all(
            isinstance(item, str) for item in raw_missing
        ):
            raise ValueError("missing ingredients must be a list of strings")
        missing = list(
            dict.fromkeys(
                normalized for item in raw_missing if (normalized := normalize_name(item))
            )
        )
        if status == "needs_shopping" and not 1 <= len(missing) <= 2:
            raise ValueError("shopping path must have one or two ingredients")
        if status != "needs_shopping":
            missing = []
        return status, recipe, missing
    except (json.JSONDecodeError, KeyError, TypeError, ValidationError, ValueError) as error:
        raise ValueError("The planning response was not valid recipe data.") from error


def _contains_unqualified_term(
    texts: list[str],
    terms: frozenset[str],
    qualifiers: tuple[str, ...] = _QUALIFIERS,
) -> bool:
    for text in texts:
        lowered = text.lower()
        for term in terms:
            pattern = rf"(?<![a-z]){re.escape(term)}(?:s|es)?(?![a-z])"
            for match in re.finditer(pattern, lowered):
                prefix = lowered[max(0, match.start() - 24) : match.start()]
                suffix = lowered[match.end() : match.end() + 5]
                qualified = any(prefix.endswith(qualifier) for qualifier in qualifiers)
                if not qualified and not suffix.startswith("-free"):
                    return True
    return False


def _validate_plan_constraints(
    request: PlanRequest,
    status: str,
    recipe: Recipe | None,
    missing: list[str],
) -> None:
    """Reject obvious model-output conflicts without certifying dietary safety."""
    if status == "no_feasible_recipe" or recipe is None:
        return

    ingredient_text = [*recipe.ingredients, *missing]
    step_text = [step.text for step in recipe.steps]
    diet = request.dietary.diet
    if diet == DietaryChoice.VEGAN:
        if not recipe.is_vegan:
            raise ValueError("vegan plan was not labeled vegan")
        vegan_forbidden = _LAND_MEAT_TERMS | _SEAFOOD_TERMS | _ANIMAL_PRODUCT_TERMS
        if _contains_unqualified_term([*ingredient_text, *step_text], vegan_forbidden):
            raise ValueError("vegan plan contained an obvious animal-derived ingredient")
    elif diet == DietaryChoice.VEGETARIAN:
        if not recipe.is_vegetarian:
            raise ValueError("vegetarian plan was not labeled vegetarian")
        if _contains_unqualified_term(
            [*ingredient_text, *step_text],
            _LAND_MEAT_TERMS | _SEAFOOD_TERMS,
        ):
            raise ValueError("vegetarian plan contained an obvious meat or seafood term")
    elif diet == DietaryChoice.KETO and _contains_unqualified_term(
        ingredient_text,
        _HIGH_CARB_TERMS,
        _KETO_QUALIFIERS,
    ):
        raise ValueError("keto plan contained an obvious high-carbohydrate term")

    if request.dietary.gluten_free:
        if not recipe.is_gluten_free:
            raise ValueError("gluten-free plan was not labeled gluten-free")
        if _contains_unqualified_term(ingredient_text, _GLUTEN_TERMS):
            raise ValueError("gluten-free plan contained an obvious gluten term")

    if not request.dietary.oven_available and _contains_unqualified_term(
        step_text,
        _OVEN_TERMS,
    ):
        raise ValueError("no-oven plan contained an oven cooking method")


def _select_cuisine(request: PlanRequest) -> str:
    return (
        secrets.choice(SUPPORTED_CUISINES)
        if request.cuisine == SURPRISE_CUISINE
        else request.cuisine
    )


def _demo_recipe(request: PlanRequest) -> tuple[str, Recipe, list[str]]:
    available = {item.normalized_name for item in filter_culinary_ingredients(request.ingredients)}
    recipe_cuisine = _select_cuisine(request)
    if "egg" in available and request.dietary.diet != DietaryChoice.VEGAN:
        demo_titles = {
            "Italian": "Lemony Spinach Frittata",
            "Mexican": "Mexican-Style Spinach Egg Skillet",
            "Indian": "Palak Anda Bhurji",
            "Japanese": "Spinach Tamago Scramble",
            "Korean": "Gyeran Bokkeum with Spinach",
            "Mediterranean": "Herby Spinach Egg Skillet",
            "Thai": "Thai-Style Spinach Egg Stir-Fry",
            "Chinese": "Spinach and Egg Stir-Fry",
            "Peruvian": "Peruvian-Style Spinach Egg Skillet",
            "French": "Herbed Spinach Omelette",
        }
        return (
            "recipe_found",
            Recipe(
                title=demo_titles.get(recipe_cuisine, "Spinach Egg Skillet"),
                cuisine=recipe_cuisine,
                description=f"A quick {recipe_cuisine.lower()}-inspired egg skillet made from familiar kitchen staples.",
                prep_minutes=8,
                cook_minutes=12,
                servings=2,
                calories_per_serving=290,
                ingredients=["eggs", "spinach", "cooking oil", "salt", "pepper"],
                steps=[
                    RecipeStep(order=1, text="Whisk the eggs with salt and pepper until smooth."),
                    RecipeStep(
                        order=2,
                        text="Warm a little cooking oil in a skillet and wilt the spinach for 1 to 2 minutes.",
                    ),
                    RecipeStep(
                        order=3,
                        text="Add the eggs and cook gently, folding until just set, 4 to 6 minutes.",
                    ),
                    RecipeStep(order=4, text="Rest for a minute, then serve while tender."),
                ],
                storage_tip="Cool promptly; refrigerate leftovers in a sealed container and eat within 3 days.",
                is_vegan=False,
                is_gluten_free=True,
                is_vegetarian=True,
            ),
            [],
        )
    return (
        "no_feasible_recipe",
        Recipe(
            title="No close match yet",
            cuisine=recipe_cuisine,
            description="Try a different cuisine or scan a few more shelves.",
            prep_minutes=0,
            cook_minutes=0,
            servings=1,
            calories_per_serving=None,
            ingredients=["Your current inventory"],
            steps=[
                RecipeStep(
                    order=1, text="Add more visible ingredients, then ask PantryPilot again."
                )
            ],
            storage_tip=None,
            is_vegan=False,
            is_gluten_free=False,
        ),
        [],
    )


async def plan_with_model(
    request: PlanRequest,
    api_key: str,
    model: str,
    timeout_seconds: float = 300.0,
    client: AsyncOpenAI | None = None,
) -> tuple[str, Recipe | None, list[str]]:
    """Request and validate a meal plan from the configured model."""
    culinary_ingredients = filter_culinary_ingredients(request.ingredients)
    inventory = [
        {
            "name": item.normalized_name,
            "quantity": item.quantity,
            "freshness": item.freshness,
            "opened": item.opened,
        }
        for item in culinary_ingredients
    ]
    context = {
        "cuisine": _select_cuisine(request),
        "surprise_mode": request.cuisine == SURPRISE_CUISINE,
        "supported_cuisines": SUPPORTED_CUISINES,
        "inventory": inventory,
        "staples": [normalize_name(staple) for staple in request.staples],
        "dietary": request.dietary.model_dump(),
        "taste_profile": sanitize_taste_profile(request.taste_profile),
        "exclude_recipe_titles": request.exclude_recipe_titles,
        "selection_nonce": secrets.token_hex(12),
    }
    logger.info(
        "Submitting OpenAI recipe-plan request: model=%s ingredients=%d timeout=%.0fs",
        model,
        len(inventory),
        timeout_seconds,
    )
    openai_client = client or AsyncOpenAI(
        api_key=api_key,
        timeout=timeout_seconds,
        max_retries=0,
    )
    try:
        response = await openai_client.responses.create(
            model=model,
            input=[
                {
                    "role": "developer",
                    "content": [
                        {
                            "type": "input_text",
                            "text": PLAN_INSTRUCTIONS,
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": json.dumps(context),
                        }
                    ],
                },
            ],
            text={"format": PLAN_RESPONSE_FORMAT},
        )
    finally:
        if client is None:
            await openai_client.close()
    logger.info(
        "OpenAI recipe-plan response received: id=%s status=%s model=%s",
        response.id,
        response.status,
        model,
    )
    status, recipe, missing = _parse_plan(response.output_text)
    _validate_plan_constraints(request, status, recipe, missing)
    return status, recipe, missing


def attach_fast_perishing_utilization(
    recipe: Recipe | None,
    ingredients: list[Ingredient],
) -> Recipe | None:
    """Describe how many fast-perishing items appear in a selected recipe.

    The figure is displayed after selection only; visual freshness never affects cuisine or
    recipe choice.
    """
    if recipe is None:
        return None
    use_soon = {item.normalized_name for item in ingredients if item.freshness.value == "use_soon"}
    if not use_soon:
        return recipe
    recipe_text = " ".join(recipe.ingredients).lower()
    used = sum(
        1
        for ingredient in use_soon
        if re.search(rf"(?<![a-z]){re.escape(ingredient)}(?:s|es)?(?![a-z])", recipe_text)
    )
    return recipe.model_copy(
        update={"fast_perishing_utilization": round((used / len(use_soon)) * 100)}
    )


async def create_plan(
    request: PlanRequest,
    settings: Settings,
    openai_client: AsyncOpenAI | None = None,
) -> PlanResponse:
    """Generate one plan, coalescing only matching concurrent requests in this process."""
    request_payload = {
        "model": settings.openai_model,
        "request": request.model_dump(mode="json"),
    }
    fingerprint = hashlib.sha256(
        json.dumps(request_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    async def generate() -> PlanResponse:
        if settings.openai_api_key:
            status, recipe, missing = await plan_with_model(
                request,
                settings.openai_api_key,
                settings.openai_model,
                settings.openai_timeout_seconds,
                openai_client,
            )
            demo_mode = False
        else:
            status, recipe, missing = _demo_recipe(request)
            demo_mode = True

        recipe = attach_fast_perishing_utilization(recipe, request.ingredients)
        if recipe is not None:
            recipe = recipe.model_copy(
                update={"is_keto_friendly": request.dietary.diet == DietaryChoice.KETO}
            )
        shopping_notice = (
            "Allow location access to find nearby grocery offers and product prices."
            if status == "needs_shopping"
            else None
        )
        return PlanResponse(
            status=status,
            recipe=recipe,
            missing_ingredients=missing,
            stores=[],
            shopping_notice=shopping_notice,
            demo_mode=demo_mode,
        )

    return await _plan_requests.run(fingerprint, generate)


async def drain_pending_plans() -> None:
    """Finish active recipe-plan requests during graceful process shutdown."""
    await _plan_requests.drain()
