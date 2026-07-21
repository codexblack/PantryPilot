from __future__ import annotations

import asyncio
import base64
import logging
from typing import ClassVar

import cv2
import numpy as np
from openai import AsyncOpenAI

from app.config import Settings
from app.schemas import RecipeImage
from app.services.inflight import InFlightRequestRegistry

logger = logging.getLogger(__name__)


class GeneratedRecipeImageProvider:
    """Create a compact dish preview without retaining generated images."""

    _in_flight_images: ClassVar[InFlightRequestRegistry[RecipeImage | None]] = (
        InFlightRequestRegistry("recipe-image")
    )
    _generation_slots: ClassVar[asyncio.Semaphore] = asyncio.Semaphore(2)

    def __init__(self, settings: Settings, client: AsyncOpenAI | None = None):
        self._api_key = settings.openai_api_key
        self._client = client
        self._model = settings.recipe_image_model
        self._size = settings.recipe_image_size
        self._timeout_seconds = min(
            settings.openai_timeout_seconds,
            settings.recipe_image_timeout_seconds,
        )

    async def find(self, title: str) -> RecipeImage | None:
        """Share only an active identical generation within the current process."""
        request_key = " ".join(title.lower().split())
        if not self._api_key:
            return None
        return await self.__class__._in_flight_images.run(
            request_key,
            lambda: self._generate(title),
        )

    async def _generate(self, title: str) -> RecipeImage | None:
        """Generate one compact preview while applying process-local concurrency limits."""
        try:
            async with self.__class__._generation_slots:
                return await self._request_image(title)
        except Exception:
            logger.exception("Recipe image generation did not complete")
            return None

    @classmethod
    async def drain_pending_tasks(cls) -> None:
        """Finish active generations before graceful process shutdown."""
        await cls._in_flight_images.drain()

    async def _request_image(self, title: str) -> RecipeImage | None:
        client = self._client or AsyncOpenAI(
            api_key=self._api_key,
            timeout=self._timeout_seconds,
            max_retries=0,
        )
        try:
            response = await client.images.generate(
                model=self._model,
                prompt=(
                    f"A square, appetizing food photograph of the finished dish: {title}. "
                    "Show one plausible home-cooked serving with cuisine-appropriate plating. "
                    "The dish is the clear hero; no people, hands, labels, captions, logos, "
                    "or written text."
                ),
                size=self._size,
                quality="low",
                output_format="jpeg",
                output_compression=55,
                background="opaque",
                timeout=self._timeout_seconds,
            )
        finally:
            if self._client is None:
                await client.close()
        image_data = response.data[0].b64_json if response.data else None
        if not image_data:
            return None
        image_data = await asyncio.to_thread(self._to_thumbnail, image_data)
        return RecipeImage(
            url=f"data:image/jpeg;base64,{image_data}",
            alt=f"Generated serving of {title}",
            attribution="Generated for PantryPilot",
        )

    @staticmethod
    def _to_thumbnail(image_data: str) -> str:
        """Keep the network response light enough for a recipe-card preview."""
        try:
            decoded = base64.b64decode(image_data)
            image = cv2.imdecode(np.frombuffer(decoded, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None:
                return image_data
            height, width = image.shape[:2]
            scale = min(1.0, 384 / max(height, width))
            if scale < 1:
                image = cv2.resize(
                    image,
                    (round(width * scale), round(height * scale)),
                    interpolation=cv2.INTER_AREA,
                )
            ok, encoded = cv2.imencode(
                ".jpg",
                image,
                [cv2.IMWRITE_JPEG_QUALITY, 65],
            )
            if not ok:
                return image_data
            return base64.b64encode(encoded.tobytes()).decode("ascii")
        except (ValueError, TypeError):
            return image_data
