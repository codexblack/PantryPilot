from __future__ import annotations

import base64
import json
import logging
from typing import Any, Literal

from openai import AsyncOpenAI
from pydantic import TypeAdapter, ValidationError

from app.schemas import MAX_SCAN_INGREDIENTS, Freshness, Ingredient
from app.services.inventory import normalize_inventory

logger = logging.getLogger(__name__)

INGREDIENT_LIST = TypeAdapter(list[Ingredient])
MIN_RECOGNITION_CONFIDENCE = 0.5

INVENTORY_RESPONSE_FORMAT = {
    "type": "json_schema",
    "name": "pantry_inventory",
    "strict": True,
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "ingredients": {
                "type": "array",
                "maxItems": MAX_SCAN_INGREDIENTS,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "name": {"type": "string"},
                        "normalized_name": {"type": "string"},
                        "quantity": {"type": ["string", "null"]},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "freshness": {"type": "string", "enum": [item.value for item in Freshness]},
                        "opened": {"type": ["boolean", "null"]},
                    },
                    "required": [
                        "name",
                        "normalized_name",
                        "quantity",
                        "confidence",
                        "freshness",
                        "opened",
                    ],
                },
            },
        },
        "required": ["ingredients"],
    },
}

VISION_INSTRUCTIONS = """You are PantryPilot's careful grocery recognizer.
Review all frames of one fridge or pantry walkthrough as a single scene. Identify only edible
ingredients you can see. Merge duplicate observations across frames. Do not infer an ingredient
that is not visibly supported. An ingredient does not need to appear in multiple frames: include it
when one frame provides a reasonably clear, food-specific visual cue, even if it is partly occluded.
Use confidence from 0.55 to 0.75 for supported single-frame items. Omit vague shapes, unreadable
packages, and guesses below 0.50. For each item return name, normalized_name, quantity (or null),
confidence from 0 to 1, freshness as fresh/use_soon/unknown, and opened as true/false/null.
Freshness is a practical "preferably use in the next few days" estimate. Actively identify the small set
of items that should be used soon: visibly aging produce, ripe or bruised fruit, wilted greens or herbs,
cut produce, opened refrigerated food, opened deli or dairy products, short-lived refrigerated meat or
fish with a date/context clue, and a clearly near date. Do not require an exact expiry date when several
of those clues make an item a sensible use-soon candidate. Do not over-mark: fresh-looking whole produce,
unopened packages, frozen food, shelf-stable goods, and condiments should remain fresh or unknown unless
the image provides a reason to flag them. Return valid JSON only in this shape: {"ingredients": [items]}. No prose and no markdown."""


def _parse_ingredients(raw: str) -> list[Ingredient]:
    try:
        parsed: Any = json.loads(raw)
        return normalize_inventory(
            INGREDIENT_LIST.validate_python(parsed["ingredients"]),
            minimum_confidence=MIN_RECOGNITION_CONFIDENCE,
        )
    except (json.JSONDecodeError, KeyError, TypeError, ValidationError) as error:
        logger.warning(
            "OpenAI inventory response did not match the expected schema: error=%s output_length=%d",
            error,
            len(raw) if isinstance(raw, str) else 0,
        )
        raise ValueError(
            "The recognition response did not match the expected ingredient schema."
        ) from error


async def recognize_frames(
    frames: list[bytes],
    api_key: str,
    model: str,
    timeout_seconds: float = 300.0,
    client: AsyncOpenAI | None = None,
    *,
    image_detail: Literal["low", "high"] = "low",
) -> list[Ingredient]:
    """Recognize and normalize visible ingredients across prepared frames."""
    content: list[dict[str, str]] = []
    for frame in frames:
        image = base64.b64encode(frame).decode("ascii")
        content.append(
            {
                "type": "input_image",
                "image_url": f"data:image/jpeg;base64,{image}",
                "detail": image_detail,
            }
        )
    logger.info(
        "Submitting OpenAI vision request: model=%s images=%d timeout=%.0fs",
        model,
        len(frames),
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
                    "content": [{"type": "input_text", "text": VISION_INSTRUCTIONS}],
                },
                {"role": "user", "content": content},
            ],
            text={"format": INVENTORY_RESPONSE_FORMAT},
        )
    finally:
        if client is None:
            await openai_client.close()
    logger.info(
        "OpenAI vision response received: id=%s status=%s model=%s",
        response.id,
        response.status,
        model,
    )
    return _parse_ingredients(response.output_text)


def demo_inventory() -> list[Ingredient]:
    """Return a labeled fallback inventory when no API key is configured."""
    return [
        Ingredient(
            name="Eggs",
            normalized_name="egg",
            quantity="6",
            confidence=0.98,
            freshness=Freshness.FRESH,
        ),
        Ingredient(
            name="Spinach",
            normalized_name="spinach",
            quantity="half bag",
            confidence=0.88,
            freshness=Freshness.USE_SOON,
            opened=True,
        ),
        Ingredient(
            name="Parmesan",
            normalized_name="parmesan",
            quantity="small wedge",
            confidence=0.92,
            freshness=Freshness.FRESH,
        ),
        Ingredient(
            name="Milk",
            normalized_name="milk",
            quantity="about 500 ml",
            confidence=0.90,
            freshness=Freshness.UNKNOWN,
            opened=True,
        ),
        Ingredient(
            name="Lemon",
            normalized_name="lemon",
            quantity="2",
            confidence=0.95,
            freshness=Freshness.FRESH,
        ),
    ]
