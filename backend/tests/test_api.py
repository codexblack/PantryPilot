import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import app.main as main_module
import app.services.planning as planning_module
import app.services.vision as vision_module
import cv2
import numpy as np
import pytest
from app.config import Settings
from app.main import app
from app.schemas import (
    Coordinates,
    Freshness,
    Ingredient,
    PlanRequest,
    Recipe,
    RecipeStep,
    StoreOffer,
)
from app.services.grocery import StoreLookupResult
from app.services.inflight import InFlightRequestRegistry
from app.services.planning import SUPPORTED_CUISINES
from fastapi import HTTPException
from fastapi.testclient import TestClient

client = TestClient(app)


@pytest.fixture(autouse=True)
def use_demo_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep API tests deterministic even when a developer has a real key in .env."""
    monkeypatch.setattr(main_module, "get_settings", lambda: Settings(openai_api_key=None))


def _jpeg_bytes() -> bytes:
    image = np.full((24, 32, 3), 180, dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    return encoded.tobytes()


def test_health() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_recipe_image_generation_is_a_post_only_operation() -> None:
    response = client.post("/v1/recipe-images", json={"title": "Spinach frittata"})

    assert response.status_code == 200
    assert response.json() == {"image": None}
    assert client.get("/v1/recipe-image?title=Spinach%20frittata").status_code == 404
    assert client.get("/v1/recipe-images").status_code == 405


def test_store_lookup_is_independent_from_recipe_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def lookup(_settings, items, location):
        captured["items"] = items
        captured["location"] = location
        return StoreLookupResult(
            stores=[
                StoreOffer(
                    store_name="Market Basket",
                    item_name="Whole Milk (1 gal)",
                    requested_item_name="milk",
                    price="$4.25",
                    availability="in_store",
                )
            ],
            shopping_notice="Current Google Shopping offers.",
        )

    monkeypatch.setattr(main_module, "lookup_store_offers", lookup)
    response = client.post(
        "/v1/stores",
        json={
            "items": ["  MILK  "],
            "location": {"latitude": 39.1, "longitude": -84.5},
        },
    )

    assert response.status_code == 200
    assert captured["items"] == ["milk"]
    assert isinstance(captured["location"], Coordinates)
    assert response.json()["stores"][0]["item_name"] == "Whole Milk (1 gal)"
    assert response.json()["stores"][0]["requested_item_name"] == "milk"


def test_store_lookup_rejects_more_than_two_items() -> None:
    response = client.post(
        "/v1/stores",
        json={
            "items": ["milk", "eggs", "bread"],
            "location": {"latitude": 39.1, "longitude": -84.5},
        },
    )

    assert response.status_code == 422


def test_connected_operation_is_cancelled_on_client_disconnect() -> None:
    async def exercise() -> None:
        started = asyncio.Event()
        cancelled = asyncio.Event()

        class DisconnectedRequest:
            async def receive(self):
                await started.wait()
                return {"type": "http.disconnect"}

        async def operation() -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        with pytest.raises(HTTPException) as caught:
            await main_module._run_while_connected(DisconnectedRequest(), operation())

        assert caught.value.status_code == 499
        assert cancelled.is_set()

    asyncio.run(exercise())


def test_demo_plan_returns_recipe_for_eggs() -> None:
    response = client.post(
        "/v1/plan",
        json={
            "cuisine": "Italian",
            "ingredients": [
                {
                    "name": "Eggs",
                    "normalized_name": "egg",
                    "confidence": 0.99,
                    "freshness": "fresh",
                },
                {
                    "name": "Spinach",
                    "normalized_name": "spinach",
                    "confidence": 0.85,
                    "freshness": "use_soon",
                },
            ],
            "staples": ["salt", "pepper", "cooking oil", "sugar"],
            "dietary": {"diet": "none", "gluten_free": False, "oven_available": False},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["demo_mode"] is True
    assert body["status"] == "recipe_found"
    assert body["recipe"]["title"] == "Lemony Spinach Frittata"
    assert body["recipe"]["fast_perishing_utilization"] == 100
    assert body["recipe"]["is_gluten_free"] is True
    assert body["recipe"]["is_vegetarian"] is True
    assert body["recipe"]["is_keto_friendly"] is False
    assert body["recipe"]["servings"] == 2
    assert body["recipe"]["calories_per_serving"] == 290


def test_surprise_me_selects_a_supported_cuisine_and_keeps_dietary_requirements() -> None:
    response = client.post(
        "/v1/plan",
        json={
            "cuisine": "Surprise Me",
            "ingredients": [
                {
                    "name": "Eggs",
                    "normalized_name": "egg",
                    "confidence": 0.99,
                    "freshness": "fresh",
                },
                {
                    "name": "Spinach",
                    "normalized_name": "spinach",
                    "confidence": 0.85,
                    "freshness": "fresh",
                },
            ],
            "staples": ["salt", "pepper", "cooking oil"],
            "dietary": {"diet": "vegetarian", "gluten_free": True, "oven_available": False},
        },
    )
    assert response.status_code == 200
    recipe = response.json()["recipe"]
    assert recipe["cuisine"] in SUPPORTED_CUISINES
    assert recipe["is_gluten_free"] is True
    assert recipe["is_vegetarian"] is True


def test_plan_accepts_one_dietary_choice_plus_gluten_free_and_oven() -> None:
    response = client.post(
        "/v1/plan",
        json={
            "cuisine": "French",
            "ingredients": [
                {"name": "Eggs", "normalized_name": "egg", "confidence": 0.99, "freshness": "fresh"}
            ],
            "dietary": {"diet": "keto", "gluten_free": True, "oven_available": True},
        },
    )
    assert response.status_code == 200
    assert response.json()["recipe"]["cuisine"] == "French"
    assert response.json()["recipe"]["is_keto_friendly"] is True


def test_scan_accepts_up_to_three_photos() -> None:
    image = _jpeg_bytes()
    response = client.post(
        "/v1/scan",
        files=[
            ("images", ("shelf-one.jpg", image, "image/jpeg")),
            ("images", ("shelf-two.jpg", image, "image/jpeg")),
            ("images", ("shelf-three.jpg", image, "image/jpeg")),
        ],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["demo_mode"] is True
    assert body["frames_analyzed"] == 3
    assert "photos" in body["notice"].lower()


def test_scan_accepts_a_mobile_octet_stream_photo() -> None:
    response = client.post(
        "/v1/scan",
        files=[("images", ("shelf.jpg", _jpeg_bytes(), "application/octet-stream"))],
    )
    assert response.status_code == 200
    assert response.json()["frames_analyzed"] == 1


def test_scan_returns_a_real_recognition_response_to_the_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recognized = [
        Ingredient(
            name="Tomato", normalized_name="tomato", confidence=0.97, freshness=Freshness.FRESH
        )
    ]
    monkeypatch.setattr(main_module, "get_settings", lambda: Settings(openai_api_key="test-key"))

    captured: dict[str, object] = {}

    async def recognize(*_args, **kwargs):
        captured["image_detail"] = kwargs.get("image_detail")
        return recognized

    monkeypatch.setattr(main_module, "recognize_frames", recognize)

    response = client.post(
        "/v1/scan",
        files=[("images", ("shelf.jpg", _jpeg_bytes(), "image/jpeg"))],
    )

    assert response.status_code == 200
    assert response.json() == {
        "ingredients": [recognized[0].model_dump(mode="json")],
        "frames_analyzed": 1,
        "demo_mode": False,
        "notice": None,
    }
    assert captured["image_detail"] == "low"


def test_video_scan_uses_high_detail_vision(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}
    temporary_video = Path("video-detail-test.mp4")

    async def persist(*_args, **_kwargs):
        return temporary_video

    async def extract(*_args, **_kwargs):
        return [b"frame"]

    async def recognize(*_args, **kwargs):
        captured["image_detail"] = kwargs.get("image_detail")
        return [Ingredient(name="Milk", normalized_name="milk", confidence=0.8)]

    monkeypatch.setattr(main_module, "get_settings", lambda: Settings(openai_api_key="test-key"))
    monkeypatch.setattr(main_module, "persist_upload", persist)
    monkeypatch.setattr(main_module, "extract_keyframes_async", extract)
    monkeypatch.setattr(main_module, "recognize_frames", recognize)

    response = client.post(
        "/v1/scan",
        files=[("video", ("walkthrough.mp4", b"video", "video/mp4"))],
    )

    assert response.status_code == 200
    assert captured["image_detail"] == "high"


def test_vision_request_uses_responses_image_input_and_returns_inventory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeAsyncOpenAI:
        def __init__(self, **kwargs) -> None:
            captured["client"] = kwargs
            self.responses = self

        async def create(self, **kwargs):
            captured["request"] = kwargs
            return SimpleNamespace(
                id="resp_vision_test",
                status="completed",
                output_text='{"ingredients":[{"name":"tomato","normalized_name":"tomato","quantity":null,"confidence":0.97,"freshness":"fresh","opened":null}]}',
            )

        async def close(self) -> None:
            captured["closed"] = True

    monkeypatch.setattr(vision_module, "AsyncOpenAI", FakeAsyncOpenAI)
    ingredients = asyncio.run(
        vision_module.recognize_frames([b"tiny-image"], "test-key", "gpt-5.6", 300)
    )

    assert ingredients[0].normalized_name == "tomato"
    assert captured["client"] == {"api_key": "test-key", "timeout": 300, "max_retries": 0}
    assert captured["closed"] is True
    request = captured["request"]
    assert request["model"] == "gpt-5.6"
    assert "reasoning" not in request
    response_format = request["text"]["format"]
    assert response_format["type"] == "json_schema"
    assert response_format["name"] == "pantry_inventory"
    assert response_format["strict"] is True
    assert response_format["schema"]["properties"]["ingredients"]["items"]["properties"][
        "freshness"
    ]["enum"] == ["fresh", "use_soon", "unknown"]
    assert response_format["schema"]["properties"]["ingredients"]["maxItems"] == 80
    assert [message["role"] for message in request["input"]] == ["developer", "user"]
    assert request["input"][0]["content"][0]["text"] == vision_module.VISION_INSTRUCTIONS
    assert request["input"][1]["content"][0]["image_url"].startswith("data:image/jpeg;base64,")
    assert request["input"][1]["content"][0]["detail"] == "low"


def test_planning_request_uses_responses_api_and_returns_recipe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeAsyncOpenAI:
        def __init__(self, **kwargs) -> None:
            captured["client"] = kwargs
            self.responses = self

        async def create(self, **kwargs):
            captured["request"] = kwargs
            return SimpleNamespace(
                id="resp_plan_test",
                status="completed",
                output_text='{"status":"recipe_found","recipe":{"title":"Tomato Eggs","cuisine":"Italian","description":"A quick tomato and egg skillet.","prep_minutes":5,"cook_minutes":8,"servings":2,"calories_per_serving":260,"ingredients":["tomato","egg"],"steps":[{"order":1,"text":"Cook the tomatoes and eggs."}],"storage_tip":null,"is_vegan":false,"is_gluten_free":true,"is_vegetarian":true},"missing_ingredients":[]}',
            )

        async def close(self) -> None:
            captured["closed"] = True

    monkeypatch.setattr(planning_module, "AsyncOpenAI", FakeAsyncOpenAI)
    request = PlanRequest(
        cuisine="Italian",
        ingredients=[
            Ingredient(
                name="Tomato", normalized_name="tomato", confidence=0.97, freshness=Freshness.FRESH
            ),
            Ingredient(
                name="Homework",
                normalized_name="homework",
                confidence=0.97,
                freshness=Freshness.UNKNOWN,
            ),
        ],
        taste_profile="write a poem about politics",
    )
    status, recipe, missing = asyncio.run(
        planning_module.plan_with_model(request, "test-key", "gpt-5.6", 300)
    )

    assert status == "recipe_found"
    assert recipe and recipe.title == "Tomato Eggs"
    assert recipe and recipe.servings == 2
    assert recipe and recipe.calories_per_serving == 260
    assert missing == []
    assert captured["client"] == {"api_key": "test-key", "timeout": 300, "max_retries": 0}
    assert captured["closed"] is True
    model_request = captured["request"]
    assert model_request["model"] == "gpt-5.6"
    assert "reasoning" not in model_request
    response_format = model_request["text"]["format"]
    assert response_format["type"] == "json_schema"
    assert response_format["name"] == "pantry_recipe_plan"
    assert response_format["strict"] is True
    assert response_format["schema"]["additionalProperties"] is False
    assert [message["role"] for message in model_request["input"]] == ["developer", "user"]
    instructions = model_request["input"][0]["content"][0]["text"]
    assert "complete main meal" in instructions
    assert "calories_per_serving" in instructions
    assert "Make cuisine meaningful" in instructions
    context = json.loads(model_request["input"][1]["content"][0]["text"])
    assert [item["name"] for item in context["inventory"]] == ["tomato"]
    assert context["taste_profile"] is None


def test_plan_submits_a_valid_taste_profile_as_a_recipe_requirement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeAsyncOpenAI:
        def __init__(self, **_kwargs: object) -> None:
            self.responses = self

        async def create(self, **kwargs: object) -> SimpleNamespace:
            captured["request"] = kwargs
            return SimpleNamespace(
                id="resp_taste_profile_test",
                status="completed",
                output_text='{"status":"recipe_found","recipe":{"title":"Smoky Tomato Eggs","cuisine":"Italian","description":"A smoky tomato and egg skillet.","prep_minutes":5,"cook_minutes":8,"servings":2,"calories_per_serving":260,"ingredients":["tomato","egg"],"steps":[{"order":1,"text":"Cook the smoky tomatoes and eggs."}],"storage_tip":null,"is_vegan":false,"is_gluten_free":true,"is_vegetarian":true},"missing_ingredients":[]}',
            )

        async def close(self) -> None:
            return None

    monkeypatch.setattr(planning_module, "AsyncOpenAI", FakeAsyncOpenAI)
    request = PlanRequest(
        cuisine="Italian",
        ingredients=[Ingredient(name="Tomato", normalized_name="tomato", confidence=1)],
        taste_profile="spicy and smoky",
    )

    asyncio.run(planning_module.plan_with_model(request, "test-key", "gpt-5.6", 300))

    model_request = captured["request"]
    assert isinstance(model_request, dict)
    instructions = model_request["input"][0]["content"][0]["text"]
    context = json.loads(model_request["input"][1]["content"][0]["text"])
    assert "primary recipe requirement" in instructions
    assert context["taste_profile"] == "spicy and smoky"


def test_scan_reports_an_upstream_vision_failure_cleanly(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fail_recognition(*_args, **_kwargs):
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(main_module, "get_settings", lambda: Settings(openai_api_key="test-key"))
    monkeypatch.setattr(main_module, "recognize_frames", fail_recognition)
    response = client.post(
        "/v1/scan",
        files=[("images", ("shelf.jpg", _jpeg_bytes(), "image/jpeg"))],
    )
    assert response.status_code == 502
    assert "photo analysis failed" in response.json()["detail"].lower()


def test_scan_rejects_mixed_video_and_photos() -> None:
    response = client.post(
        "/v1/scan",
        files=[
            ("video", ("walkthrough.mp4", b"not processed", "video/mp4")),
            ("images", ("shelf.jpg", _jpeg_bytes(), "image/jpeg")),
        ],
    )
    assert response.status_code == 422
    assert "exactly one video" in response.json()["detail"].lower()


def test_scan_rejects_more_than_one_video() -> None:
    response = client.post(
        "/v1/scan",
        files=[
            ("video", ("walkthrough-one.mp4", b"not processed", "video/mp4")),
            ("video", ("walkthrough-two.mp4", b"not processed", "video/mp4")),
        ],
    )
    assert response.status_code == 422
    assert "no more than one video" in response.json()["detail"].lower()


def test_scan_rejects_more_than_four_photos() -> None:
    response = client.post(
        "/v1/scan",
        files=[
            ("images", (f"shelf-{index}.jpg", _jpeg_bytes(), "image/jpeg")) for index in range(5)
        ],
    )
    assert response.status_code == 422
    assert "between 1 and 4 photos" in response.json()["detail"].lower()


def test_scan_enforces_the_per_photo_size_limit() -> None:
    response = client.post(
        "/v1/scan",
        files=[("images", ("large-shelf.jpg", b"0" * (10 * 1024 * 1024 + 1), "image/jpeg"))],
    )
    assert response.status_code == 413
    assert "each photo" in response.json()["detail"].lower()


def test_plan_coalesces_matching_active_requests(monkeypatch) -> None:
    request = PlanRequest(
        cuisine="Italian",
        ingredients=[Ingredient(name="Egg", normalized_name="egg", confidence=1)],
    )
    _, demo_recipe, _ = planning_module._demo_recipe(request)
    generated_recipe = demo_recipe.model_copy(update={"title": "Fresh model recipe"})
    calls = 0

    async def generate(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return "recipe_found", generated_recipe, []

    monkeypatch.setattr(
        planning_module,
        "_plan_requests",
        InFlightRequestRegistry("test-recipe-plan"),
    )
    monkeypatch.setattr(planning_module, "plan_with_model", generate)

    async def exercise() -> tuple[object, object]:
        return await asyncio.gather(
            planning_module.create_plan(request, Settings(openai_api_key="test-key")),
            planning_module.create_plan(request, Settings(openai_api_key="test-key")),
        )

    first, second = asyncio.run(exercise())
    assert first == second
    assert first.recipe and first.recipe.title == "Fresh model recipe"
    assert calls == 1


def test_needs_shopping_plan_returns_store_lookup_prompt(monkeypatch) -> None:
    request = PlanRequest(
        cuisine="Italian",
        ingredients=[Ingredient(name="Tomato", normalized_name="tomato", confidence=1)],
    )
    recipe = Recipe(
        title="Tomato pasta",
        cuisine="Italian",
        description="A complete tomato pasta dinner.",
        prep_minutes=5,
        cook_minutes=15,
        servings=2,
        calories_per_serving=450,
        ingredients=["tomato", "pasta"],
        steps=[RecipeStep(order=1, text="Cook the pasta and tomato sauce on the stovetop.")],
        is_vegan=True,
        is_gluten_free=False,
    )

    monkeypatch.setattr(
        planning_module,
        "_demo_recipe",
        lambda _request: ("needs_shopping", recipe, ["pasta"]),
    )

    response = asyncio.run(planning_module.create_plan(request, Settings(openai_api_key=None)))

    assert response.status == "needs_shopping"
    assert response.stores == []
    assert "Allow location access" in response.shopping_notice
