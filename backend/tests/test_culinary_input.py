import pytest
from app.schemas import DietaryProfile, Freshness, Ingredient, PlanRequest, Recipe, RecipeStep
from app.services.culinary_input import filter_culinary_ingredients, sanitize_taste_profile
from app.services.planning import _validate_plan_constraints, attach_fast_perishing_utilization


def test_taste_profile_keeps_a_short_culinary_preference() -> None:
    assert (
        sanitize_taste_profile("Something hearty for a cold day")
        == "Something hearty for a cold day"
    )
    assert sanitize_taste_profile("Pairs well with Pinot Noir") == "Pairs well with Pinot Noir"


def test_taste_profile_omits_profanity_and_non_culinary_text() -> None:
    assert sanitize_taste_profile("write a poem about politics") is None
    assert sanitize_taste_profile("spicy shit") is None


def test_manual_inventory_filters_obviously_non_culinary_or_profane_entries() -> None:
    items = [
        Ingredient(name="Eggs", normalized_name="egg", confidence=1, freshness=Freshness.FRESH),
        Ingredient(name="Homework", normalized_name="homework", confidence=1),
        Ingredient(name="shit", normalized_name="shit", confidence=1),
    ]
    assert [item.normalized_name for item in filter_culinary_ingredients(items)] == ["egg"]


def test_taste_profile_has_a_server_side_ten_word_cap() -> None:
    request = PlanRequest(
        cuisine="Italian",
        ingredients=[Ingredient(name="Eggs", normalized_name="egg", confidence=1)],
        taste_profile="one two three four five six seven eight nine ten eleven",
    )
    assert request.taste_profile == "one two three four five six seven eight nine ten"


def _recipe(
    ingredients: list[str],
    step: str = "Cook everything in a skillet.",
    *,
    vegan: bool = False,
    vegetarian: bool = False,
    gluten_free: bool = False,
) -> Recipe:
    return Recipe(
        title="Test dinner",
        cuisine="Italian",
        description="A complete test dinner.",
        prep_minutes=5,
        cook_minutes=15,
        servings=2,
        calories_per_serving=400,
        ingredients=ingredients,
        steps=[RecipeStep(order=1, text=step)],
        is_vegan=vegan,
        is_vegetarian=vegetarian,
        is_gluten_free=gluten_free,
    )


def _request(dietary: DietaryProfile) -> PlanRequest:
    return PlanRequest(
        cuisine="Italian",
        ingredients=[Ingredient(name="Tomato", normalized_name="tomato", confidence=1)],
        dietary=dietary,
    )


def test_plan_validation_rejects_dietary_flag_conflicts() -> None:
    with pytest.raises(ValueError, match="labeled vegan"):
        _validate_plan_constraints(
            _request(DietaryProfile(diet="vegan")),
            "recipe_found",
            _recipe(["tomato"]),
            [],
        )
    with pytest.raises(ValueError, match="labeled gluten-free"):
        _validate_plan_constraints(
            _request(DietaryProfile(gluten_free=True)),
            "recipe_found",
            _recipe(["tomato"]),
            [],
        )


def test_plan_validation_rejects_obvious_forbidden_diet_terms() -> None:
    with pytest.raises(ValueError, match="vegetarian"):
        _validate_plan_constraints(
            _request(DietaryProfile(diet="vegetarian")),
            "recipe_found",
            _recipe(["chicken breast"], vegetarian=True),
            [],
        )


def test_plan_validation_rejects_obvious_gluten_and_oven_conflicts() -> None:
    with pytest.raises(ValueError, match="gluten term"):
        _validate_plan_constraints(
            _request(DietaryProfile(gluten_free=True)),
            "recipe_found",
            _recipe(["wheat couscous"], gluten_free=True),
            [],
        )
    with pytest.raises(ValueError, match="oven"):
        _validate_plan_constraints(
            _request(DietaryProfile(oven_available=False)),
            "recipe_found",
            _recipe(["tomato"], step="Bake in the oven until browned."),
            [],
        )


def test_plan_validation_rejects_obvious_keto_conflicts_but_allows_substitutes() -> None:
    keto_request = _request(DietaryProfile(diet="keto"))
    with pytest.raises(ValueError, match="high-carbohydrate"):
        _validate_plan_constraints(
            keto_request,
            "recipe_found",
            _recipe(["white rice", "tomato"]),
            [],
        )

    _validate_plan_constraints(
        keto_request,
        "recipe_found",
        _recipe(["cauliflower rice", "almond flour tortilla"]),
        [],
    )


def test_fast_perishing_utilization_matches_whole_ingredient_names() -> None:
    inventory = [
        Ingredient(
            name="Ham",
            normalized_name="ham",
            confidence=1,
            freshness=Freshness.USE_SOON,
        )
    ]

    unrelated = attach_fast_perishing_utilization(_recipe(["champignon mushrooms"]), inventory)
    used = attach_fast_perishing_utilization(_recipe(["diced ham"]), inventory)

    assert unrelated is not None and unrelated.fast_perishing_utilization == 0
    assert used is not None and used.fast_perishing_utilization == 100
