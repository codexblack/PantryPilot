import asyncio
import base64
import io
import threading
import time
from pathlib import Path

import app.services.grocery as grocery_module
import app.services.video as video_module
import cv2
import numpy as np
import pytest
from app.config import Settings
from app.schemas import Coordinates, Freshness, Ingredient, RecipeImage, StoreOffer
from app.services.grocery import GooglePlacesLocator, SerpApiShoppingProvider, lookup_store_offers
from app.services.inventory import normalize_inventory, normalize_name
from app.services.recipe_images import GeneratedRecipeImageProvider
from app.services.vision import _parse_ingredients
from fastapi import HTTPException, UploadFile
from starlette.datastructures import Headers


def test_normalizes_recipe_aliases() -> None:
    assert normalize_name(" Fresh   Mozzarella ") == "mozzarella"
    assert normalize_name("cherry tomatoes") == "tomato"


def test_merges_duplicate_inventory_by_confidence() -> None:
    items = [
        Ingredient(
            name="Roma tomatoes",
            normalized_name="roma tomatoes",
            confidence=0.71,
            freshness=Freshness.UNKNOWN,
        ),
        Ingredient(
            name="Cherry tomatoes",
            normalized_name="cherry tomatoes",
            confidence=0.91,
            freshness=Freshness.FRESH,
        ),
    ]
    output = normalize_inventory(items)
    assert len(output) == 1
    assert output[0].normalized_name == "tomato"
    assert output[0].confidence == 0.91


def test_merges_duplicate_inventory_without_losing_quantity_or_use_soon() -> None:
    items = [
        Ingredient(
            name="Tomatoes", normalized_name="tomatoes", confidence=0.93, freshness=Freshness.FRESH
        ),
        Ingredient(
            name="Roma tomatoes",
            normalized_name="roma tomatoes",
            quantity="4",
            confidence=0.72,
            freshness=Freshness.USE_SOON,
            opened=True,
        ),
    ]
    output = normalize_inventory(items)
    assert len(output) == 1
    assert output[0].confidence == 0.93
    assert output[0].quantity == "4"
    assert output[0].freshness == Freshness.USE_SOON
    assert output[0].opened is True


def test_inventory_confidence_floor_runs_after_duplicate_merge() -> None:
    items = [
        Ingredient(
            name="Roma tomatoes",
            normalized_name="roma tomatoes",
            quantity="4",
            confidence=0.48,
            freshness=Freshness.USE_SOON,
        ),
        Ingredient(
            name="Cherry tomatoes",
            normalized_name="cherry tomatoes",
            confidence=0.68,
            freshness=Freshness.FRESH,
        ),
        Ingredient(name="Unclear package", normalized_name="unclear package", confidence=0.19),
    ]

    output = normalize_inventory(items, minimum_confidence=0.5)

    assert len(output) == 1
    assert output[0].normalized_name == "tomato"
    assert output[0].confidence == 0.68
    assert output[0].quantity == "4"
    assert output[0].freshness == Freshness.USE_SOON


def test_inventory_normalization_truncates_deterministically_to_scan_limit() -> None:
    items = [
        Ingredient(
            name=f"Item {index}",
            normalized_name=f"item {index}",
            confidence=(100 - index) / 100,
        )
        for index in range(100)
    ]

    output = normalize_inventory(items)

    assert len(output) == 80
    assert output[0].normalized_name == "item 0"
    assert output[-1].normalized_name == "item 79"


def test_parses_model_inventory_envelope() -> None:
    result = _parse_ingredients(
        '{"ingredients": [{"name": "Fresh mozzarella", "normalized_name": "fresh mozzarella", "confidence": 0.8, "freshness": "fresh"}]}'
    )
    assert result[0].normalized_name == "mozzarella"


def test_parsed_inventory_drops_very_low_confidence_clutter() -> None:
    result = _parse_ingredients(
        '{"ingredients": ['
        '{"name": "Milk", "normalized_name": "milk", "confidence": 0.56, "freshness": "unknown"},'
        '{"name": "Unclear package", "normalized_name": "unclear package", "confidence": 0.2, "freshness": "unknown"}'
        "]}"
    )

    assert [item.normalized_name for item in result] == ["milk"]


def test_serpapi_offer_uses_source_price_and_in_store_distance() -> None:
    offer = SerpApiShoppingProvider._to_offer(
        "mozzarella",
        {
            "source": "Market Basket",
            "title": "Fresh Mozzarella, 8 oz",
            "price": "$4.99",
            "thumbnail": "https://images.example.test/mozzarella.jpg",
            "extensions": ["In store, 2.5 mi", "Pickup today"],
        },
    )

    assert offer is not None
    assert offer.store_name == "Market Basket"
    assert offer.item_name == "Fresh Mozzarella, 8 oz"
    assert offer.requested_item_name == "mozzarella"
    assert offer.price == "$4.99"
    assert offer.thumbnail_url == "https://images.example.test/mozzarella.jpg"
    assert offer.distance_miles == 2.5
    assert offer.availability == "in_store"


def test_serpapi_encodes_exact_coordinates_as_uule() -> None:
    value = SerpApiShoppingProvider._uule_from_coordinates(
        Coordinates(latitude=30.266666, longitude=-97.73333),
        timestamp_micros=1_680_877_906_236_736,
    )

    assert value == (
        "a+cm9sZToxCnByb2R1Y2VyOjEyCnByb3ZlbmFuY2U6MAp0aW1lc3RhbXA6MTY4MDg3NzkwNjIzNjczNgps"
        "YXRsbmd7CmxhdGl0dWRlX2U3OjMwMjY2NjY2MApsb25naXR1ZGVfZTc6LTk3NzMzMzMwMAp9CnJhZGl1czot"
        "MQo"
    )


def test_serpapi_prefers_two_distinct_offers_from_nearest_store() -> None:
    offers = SerpApiShoppingProvider._select_offers(
        "milk",
        {
            "shopping_results": [
                {
                    "source": "Near Market",
                    "title": "Whole Milk",
                    "price": "$4.25",
                    "extensions": ["In store, 1 mi"],
                },
                {
                    "source": "Near Market",
                    "title": "Organic Whole Milk",
                    "price": "$6.25",
                    "extensions": ["In store, 1 mi"],
                },
                {
                    "source": "Far Market",
                    "title": "Two Percent Milk",
                    "price": "$4.15",
                    "extensions": ["In store, 4 mi"],
                },
            ]
        },
    )

    assert [offer.store_name for offer in offers] == ["Near Market", "Near Market"]
    assert [offer.item_name for offer in offers] == ["Whole Milk", "Organic Whole Milk"]


def test_serpapi_prefers_in_stores_nearby_category() -> None:
    offers = SerpApiShoppingProvider._select_offers(
        "milk",
        {
            "categorized_shopping_results": [
                {
                    "title": "In stores nearby",
                    "shopping_results": [
                        {
                            "source": "Local Market",
                            "title": "Whole Milk",
                            "price": "$4.25",
                            "extensions": ["In store, 1 mi"],
                        }
                    ],
                }
            ],
            "shopping_results": [
                {
                    "source": "Online Retailer",
                    "title": "Milk delivered",
                    "price": "$3.99",
                    "extensions": ["Delivery"],
                }
            ],
        },
    )

    assert [offer.store_name for offer in offers] == ["Local Market"]
    assert offers[0].availability == "in_store"


def test_serpapi_uses_one_localized_google_shopping_request(monkeypatch) -> None:
    captured: list[dict[str, str]] = []

    class FakeResponse:
        def __init__(self, payload: dict[str, object]) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self):
            return self._payload

    class FakeClient:
        def __init__(self, **_kwargs) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def get(self, _url, params):
            captured.append(params)
            return FakeResponse(
                {
                    "shopping_results": [
                        {
                            "source": "Local Grocer",
                            "title": "Whole Milk",
                            "price": "$4.25",
                            "extensions": ["In store, 1 mi"],
                        }
                    ]
                }
            )

    monkeypatch.setattr(grocery_module.httpx, "AsyncClient", FakeClient)
    provider = SerpApiShoppingProvider(Settings(serpapi_api_key="test-key"))
    offers = asyncio.run(provider.search(["milk"], Coordinates(latitude=39.1, longitude=-84.5)))

    assert len(offers) == 1
    assert [params["engine"] for params in captured] == ["google_shopping"]
    assert captured[0]["q"] == "milk"
    assert captured[0]["device"] == "mobile"
    assert captured[0]["uule"].startswith("a+")
    assert "location" not in captured[0]


def test_store_lookup_service_normalizes_items_and_uses_serpapi(monkeypatch) -> None:
    captured: dict[str, object] = {}

    async def search(_provider, items, location):
        captured["items"] = items
        captured["location"] = location
        return [
            StoreOffer(
                store_name="Market Basket",
                item_name="Roma Tomatoes (1 lb)",
                requested_item_name="tomato",
                price="$2.49",
                availability="in_store",
            )
        ]

    monkeypatch.setattr(SerpApiShoppingProvider, "search", search)
    location = Coordinates(latitude=39.1, longitude=-84.5)
    result = asyncio.run(
        lookup_store_offers(
            Settings(serpapi_api_key="test-key"),
            ["Tomatoes"],
            location,
        )
    )

    assert captured == {"items": ["tomato"], "location": location}
    assert result.stores[0].item_name == "Roma Tomatoes (1 lb)"
    assert "Google Shopping offers" in result.shopping_notice


def test_store_lookup_falls_back_to_places_after_serpapi_failure(monkeypatch) -> None:
    async def serpapi_search(provider, _items, _location):
        provider.last_notice = "Google Shopping could not complete this request."
        return []

    async def places_search(_provider, items, _location):
        return [
            StoreOffer(
                store_name="Neighborhood Market",
                item_name=items[0],
                availability="location_only",
            )
        ]

    monkeypatch.setattr(SerpApiShoppingProvider, "search", serpapi_search)
    monkeypatch.setattr(GooglePlacesLocator, "search", places_search)
    result = asyncio.run(
        lookup_store_offers(
            Settings(
                serpapi_api_key="test-key",
                google_maps_api_key="test-google-key",
            ),
            ["milk"],
            Coordinates(latitude=39.1, longitude=-84.5),
        )
    )

    assert result.stores[0].store_name == "Neighborhood Market"
    assert result.stores[0].price is None
    assert "could not complete" in result.shopping_notice
    assert "without product prices" in result.shopping_notice


def test_google_places_limits_results_to_two_stores_per_item(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return {
                "places": [
                    {
                        "displayName": {"text": f"Store {index}"},
                        "formattedAddress": f"{index} Main St",
                        "location": {"latitude": 39.1, "longitude": -84.5},
                    }
                    for index in range(5)
                ]
            }

    class FakeClient:
        def __init__(self, **_kwargs) -> None:
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def post(self, _url, json, headers):
            captured["body"] = json
            captured["headers"] = headers
            return FakeResponse()

    monkeypatch.setattr(grocery_module.httpx, "AsyncClient", FakeClient)
    offers = asyncio.run(
        GooglePlacesLocator(Settings(google_maps_api_key="test-key")).search(
            ["milk", "eggs"],
            Coordinates(latitude=39.1, longitude=-84.5),
        )
    )

    assert captured["body"]["maxResultCount"] == 2
    assert len(offers) == 4
    assert sum(offer.item_name == "milk" for offer in offers) == 2
    assert sum(offer.item_name == "eggs" for offer in offers) == 2


def test_generated_recipe_image_is_a_small_jpeg_data_url(monkeypatch) -> None:
    class FakeImages:
        async def generate(self, **kwargs):
            assert kwargs["model"] == "gpt-image-2"
            assert kwargs["quality"] == "low"
            assert kwargs["size"] == "816x816"
            assert kwargs["output_format"] == "jpeg"
            return type(
                "Response", (), {"data": [type("Image", (), {"b64_json": "small-image"})()]}
            )()

    class FakeAsyncOpenAI:
        def __init__(self, **_kwargs):
            self.images = FakeImages()

        async def close(self) -> None:
            return None

    monkeypatch.setattr("app.services.recipe_images.AsyncOpenAI", FakeAsyncOpenAI)
    image = asyncio.run(
        GeneratedRecipeImageProvider(Settings(openai_api_key="test-key"))._generate(
            "Spinach frittata"
        )
    )
    assert image is not None
    assert image.url == "data:image/jpeg;base64,small-image"
    assert image.alt == "Generated serving of Spinach frittata"
    assert image.attribution == "Generated for PantryPilot"


def test_recipe_image_coalesces_matching_active_requests(monkeypatch) -> None:
    provider = GeneratedRecipeImageProvider(Settings(openai_api_key="test-key"))
    calls = 0

    async def fake_generate(_title: str) -> RecipeImage:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return RecipeImage(url="data:image/jpeg;base64,preview", alt="Generated preview")

    monkeypatch.setattr(provider, "_generate", fake_generate)

    async def exercise() -> tuple[RecipeImage | None, RecipeImage | None, RecipeImage | None]:
        first, second = await asyncio.gather(
            provider.find("Concurrent preview test"),
            provider.find("Concurrent preview test"),
        )
        await asyncio.sleep(0)
        third = await provider.find("Concurrent preview test")
        return first, second, third

    first, second, third = asyncio.run(exercise())

    assert first is not None
    assert second == first
    assert third == first
    assert calls == 2


def test_recipe_image_generation_has_bounded_active_and_queued_work(monkeypatch) -> None:
    provider = GeneratedRecipeImageProvider(Settings(openai_api_key="test-key"))
    active = 0
    peak = 0
    calls = 0

    async def exercise() -> None:
        nonlocal active, peak, calls
        release = asyncio.Event()
        two_started = asyncio.Event()

        async def generate(title: str) -> RecipeImage:
            nonlocal active, peak, calls
            calls += 1
            active += 1
            peak = max(peak, active)
            if active == 2:
                two_started.set()
            await release.wait()
            active -= 1
            return RecipeImage(url=f"data:image/jpeg;base64,{title}", alt=title)

        monkeypatch.setattr(provider, "_request_image", generate)
        monkeypatch.setattr(provider.__class__, "_generation_slots", asyncio.Semaphore(2))
        requests = [
            asyncio.create_task(provider.find(f"Budget test {index}")) for index in range(4)
        ]
        await two_started.wait()
        await asyncio.sleep(0)
        assert len(provider._in_flight_images) == 4

        release.set()
        results = await asyncio.gather(*requests)
        assert all(image is not None for image in results)

    asyncio.run(exercise())

    assert calls == 4
    assert peak == 2


def test_recipe_image_thumbnail_is_limited_to_384_pixels() -> None:
    source = np.full((900, 1200, 3), 180, dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", source)
    assert ok

    thumbnail = GeneratedRecipeImageProvider._to_thumbnail(
        base64.b64encode(encoded.tobytes()).decode("ascii")
    )
    rendered = cv2.imdecode(
        np.frombuffer(base64.b64decode(thumbnail), dtype=np.uint8), cv2.IMREAD_COLOR
    )

    assert rendered is not None
    assert rendered.shape[:2] == (288, 384)


def test_recipe_image_shutdown_drain_waits_for_in_flight_generation(monkeypatch) -> None:
    provider = GeneratedRecipeImageProvider(Settings(openai_api_key="test-key"))

    async def exercise() -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def generate(_title: str) -> RecipeImage:
            started.set()
            await release.wait()
            return RecipeImage(url="data:image/jpeg;base64,done", alt="Completed preview")

        monkeypatch.setattr(provider, "_generate", generate)
        request = asyncio.create_task(provider.find("Shutdown test"))
        await started.wait()
        drain = asyncio.create_task(provider.drain_pending_tasks())
        await asyncio.sleep(0)
        assert not drain.done()

        release.set()
        await drain
        image = await request
        assert image is not None
        assert not len(provider._in_flight_images)

    asyncio.run(exercise())


def test_image_dimensions_are_rejected_before_pixel_decode(monkeypatch) -> None:
    oversized_png_header = (
        b"\x89PNG\r\n\x1a\n"
        + (13).to_bytes(4, "big")
        + b"IHDR"
        + (6_000).to_bytes(4, "big")
        + (4_000).to_bytes(4, "big")
    )

    def fail_if_called(*_args, **_kwargs):
        pytest.fail("oversized image reached OpenCV decoding")

    monkeypatch.setattr(video_module.cv2, "imdecode", fail_if_called)
    with pytest.raises(HTTPException) as caught:
        video_module._normalize_image(oversized_png_header)

    assert caught.value.status_code == 413


def test_photo_decode_concurrency_is_bounded_per_process(monkeypatch) -> None:
    active = 0
    peak = 0
    counter_lock = threading.Lock()

    def normalize(raw: bytes) -> bytes:
        nonlocal active, peak
        with counter_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.04)
        with counter_lock:
            active -= 1
        return raw

    def uploads(prefix: str) -> list[UploadFile]:
        return [
            UploadFile(
                io.BytesIO(b"image"),
                filename=f"{prefix}-{index}.jpg",
                headers=Headers({"content-type": "image/jpeg"}),
            )
            for index in range(4)
        ]

    async def exercise() -> None:
        await asyncio.gather(
            video_module.prepare_image_uploads(uploads("first"), 4, 100, 20),
            video_module.prepare_image_uploads(uploads("second"), 4, 100, 20),
        )

    monkeypatch.setattr(video_module, "_normalize_image", normalize)
    asyncio.run(exercise())

    assert peak == 2


def test_video_decode_concurrency_is_bounded_per_process(monkeypatch) -> None:
    active = 0
    peak = 0
    counter_lock = threading.Lock()

    def extract(_path: Path, _max_frames: int, _max_seconds: int) -> list[bytes]:
        nonlocal active, peak
        with counter_lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.04)
        with counter_lock:
            active -= 1
        return [b"frame"]

    async def exercise() -> None:
        await asyncio.gather(
            *(
                video_module.extract_keyframes_async(Path(f"video-{index}.mp4"), 8, 35)
                for index in range(3)
            )
        )

    monkeypatch.setattr(video_module, "extract_keyframes", extract)
    asyncio.run(exercise())

    assert peak == 1


def test_video_keyframes_span_the_complete_reported_duration(monkeypatch) -> None:
    class FakeCapture:
        frame_index = 0

        def isOpened(self) -> bool:
            return True

        def get(self, property_id: int) -> float:
            if property_id == cv2.CAP_PROP_FPS:
                return 1
            if property_id == cv2.CAP_PROP_FRAME_COUNT:
                return 20
            if property_id in {cv2.CAP_PROP_FRAME_WIDTH, cv2.CAP_PROP_FRAME_HEIGHT}:
                return 2
            return 0

        def read(self):
            if self.frame_index == 20:
                return False, None
            frame = np.full((2, 2, 3), self.frame_index, dtype=np.uint8)
            self.frame_index += 1
            return True, frame

        def release(self) -> None:
            return None

    def encode(_extension, frame, _parameters):
        return True, np.array([frame[0, 0, 0]], dtype=np.uint8)

    monkeypatch.setattr(video_module.cv2, "VideoCapture", lambda _path: FakeCapture())
    monkeypatch.setattr(video_module.cv2, "imencode", encode)
    monkeypatch.setattr(video_module, "_is_distinct", lambda _fingerprint, _existing: True)

    frames = video_module.extract_keyframes(Path("walkthrough.mp4"), 4, 35)

    assert frames == [b"\x00", b"\x06", b"\x0d", b"\x13"]


def test_video_decode_enforces_frame_budget_without_metadata(monkeypatch) -> None:
    frame = np.full((24, 32, 3), 180, dtype=np.uint8)

    class FakeCapture:
        def isOpened(self) -> bool:
            return True

        def get(self, property_id: int) -> float:
            if property_id == cv2.CAP_PROP_FPS:
                return 30
            return 0

        def read(self):
            return True, frame.copy()

        def release(self) -> None:
            return None

    monkeypatch.setattr(video_module.cv2, "VideoCapture", lambda _path: FakeCapture())
    monkeypatch.setattr(video_module, "_MAX_VIDEO_DECODED_FRAMES", 3)

    with pytest.raises(HTTPException) as caught:
        video_module.extract_keyframes(Path("metadata-free.mp4"), 8, 35)

    assert caught.value.status_code == 422
    assert "frame limit" in caught.value.detail.lower()


def test_video_decode_accepts_exact_frame_budget_at_end_of_file(monkeypatch) -> None:
    frame = np.full((24, 32, 3), 180, dtype=np.uint8)

    class FakeCapture:
        frames_read = 0

        def isOpened(self) -> bool:
            return True

        def get(self, property_id: int) -> float:
            if property_id == cv2.CAP_PROP_FPS:
                return 30
            return 0

        def read(self):
            if self.frames_read == 3:
                return False, None
            self.frames_read += 1
            return True, frame.copy()

        def release(self) -> None:
            return None

    monkeypatch.setattr(video_module.cv2, "VideoCapture", lambda _path: FakeCapture())
    monkeypatch.setattr(video_module, "_MAX_VIDEO_DECODED_FRAMES", 3)

    frames = video_module.extract_keyframes(Path("three-frames.mp4"), 8, 35)

    assert len(frames) == 1


def test_video_decode_enforces_frame_pixel_cap(monkeypatch) -> None:
    frame = np.full((11, 10, 3), 180, dtype=np.uint8)

    class FakeCapture:
        def isOpened(self) -> bool:
            return True

        def get(self, _property_id: int) -> float:
            return 0

        def read(self):
            return True, frame

        def release(self) -> None:
            return None

    monkeypatch.setattr(video_module.cv2, "VideoCapture", lambda _path: FakeCapture())
    monkeypatch.setattr(video_module, "_MAX_VIDEO_FRAME_PIXELS", 100)

    with pytest.raises(HTTPException) as caught:
        video_module.extract_keyframes(Path("oversized-frame.mp4"), 8, 35)

    assert caught.value.status_code == 422
    assert "resolution" in caught.value.detail.lower()


def test_video_decode_allows_reported_4k_resolution(monkeypatch) -> None:
    class FakeCapture:
        def isOpened(self) -> bool:
            return True

        def get(self, property_id: int) -> float:
            if property_id == cv2.CAP_PROP_FRAME_WIDTH:
                return 3840
            if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
                return 2160
            if property_id == cv2.CAP_PROP_FPS:
                return 30
            return 0

        def read(self):
            return False, None

        def release(self) -> None:
            return None

    monkeypatch.setattr(video_module.cv2, "VideoCapture", lambda _path: FakeCapture())

    with pytest.raises(HTTPException) as caught:
        video_module.extract_keyframes(Path("4k.mp4"), 8, 35)

    assert "no usable frames" in caught.value.detail.lower()


def test_video_decode_enforces_wall_clock_cap(monkeypatch) -> None:
    class FakeCapture:
        def isOpened(self) -> bool:
            return True

        def get(self, _property_id: int) -> float:
            return 0

        def read(self):
            pytest.fail("wall-clock limit should be checked before frame decoding")

        def release(self) -> None:
            return None

    monkeypatch.setattr(video_module.cv2, "VideoCapture", lambda _path: FakeCapture())
    monkeypatch.setattr(video_module, "_MAX_VIDEO_DECODE_WALL_SECONDS", 0.0)

    with pytest.raises(HTTPException) as caught:
        video_module.extract_keyframes(Path("slow.mp4"), 8, 35)

    assert caught.value.status_code == 422
    assert "processing time" in caught.value.detail.lower()
