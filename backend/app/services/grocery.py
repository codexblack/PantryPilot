from __future__ import annotations

import asyncio
import base64
import logging
import math
import re
import time
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from app.config import Settings
from app.schemas import Coordinates, StoreOffer
from app.services.inventory import normalize_name

logger = logging.getLogger(__name__)
_MAX_OFFERS_PER_ITEM = 2
_DISTANCE_PATTERN = re.compile(r"\b(\d+(?:\.\d+)?)\s*(?:mi|miles)\b", re.IGNORECASE)


class GrocerySearchProvider(Protocol):
    """A provider returns a source with every retail price it exposes."""

    async def search(self, items: list[str], location: Coordinates) -> list[StoreOffer]: ...


@dataclass(frozen=True, slots=True)
class StoreLookupResult:
    """Store offers and the user-facing provenance or fallback notice."""

    stores: list[StoreOffer]
    shopping_notice: str


def _distance_miles(origin: Coordinates, latitude: float, longitude: float) -> float:
    """Calculate great-circle distance between two coordinates."""
    radius_miles = 3958.8
    latitude_delta = math.radians(latitude - origin.latitude)
    longitude_delta = math.radians(longitude - origin.longitude)
    a = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(math.radians(origin.latitude))
        * math.cos(math.radians(latitude))
        * math.sin(longitude_delta / 2) ** 2
    )
    return round(2 * radius_miles * math.asin(math.sqrt(min(1.0, a))), 1)


def _place_distance_miles(origin: Coordinates, place: dict[str, Any]) -> float | None:
    coordinates = place.get("location") or {}
    if not isinstance(coordinates, dict):
        return None
    try:
        latitude = float(coordinates["latitude"])
        longitude = float(coordinates["longitude"])
        return _distance_miles(origin, latitude, longitude)
    except (KeyError, TypeError, ValueError):
        return None


class SerpApiShoppingProvider:
    """Single-request Google Shopping adapter for localized product offers."""

    def __init__(self, settings: Settings):
        self._api_key = settings.serpapi_api_key
        self._search_url = settings.serpapi_search_url
        self._country = settings.serpapi_country.casefold()
        self._language = settings.serpapi_language.casefold()
        self.last_notice: str | None = None

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    async def search(self, items: list[str], location: Coordinates) -> list[StoreOffer]:
        """Return up to two priced, geographically localized offers per item."""
        self.last_notice = None
        if not self.configured:
            self.last_notice = "SerpAPI credentials are not configured."
            return []
        async with httpx.AsyncClient(timeout=12.0) as client:
            grouped = await asyncio.gather(
                *(self._offers_for_item(client, item, location) for item in items)
            )
        offers = [offer for offers_for_item in grouped for offer in offers_for_item]
        if not offers:
            self.last_notice = "Google Shopping did not return a priced offer for the item."
        return offers

    async def _offers_for_item(
        self,
        client: httpx.AsyncClient,
        item_name: str,
        location: Coordinates,
    ) -> list[StoreOffer]:
        payload = await self._search(client, item_name, location)
        return self._select_offers(item_name, payload)

    async def _search(
        self,
        client: httpx.AsyncClient,
        item_name: str,
        location: Coordinates,
    ) -> dict[str, Any]:
        params: dict[str, str] = {
            "api_key": self._api_key or "",
            "engine": "google_shopping",
            "device": "mobile",
            "gl": self._country,
            "hl": self._language,
            "q": item_name,
            "uule": self._uule_from_coordinates(location),
        }
        try:
            response = await client.get(self._search_url, params=params)
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, TypeError, ValueError) as error:
            self._log_failure(f"shopping lookup for {item_name}", error)
            return {}
        if not isinstance(payload, dict):
            return {}
        if isinstance(payload.get("error"), str):
            logger.warning("SerpAPI Google Shopping returned an error response")
            return {}
        return payload

    @staticmethod
    def _uule_from_coordinates(
        location: Coordinates,
        timestamp_micros: int | None = None,
    ) -> str:
        timestamp = timestamp_micros if timestamp_micros is not None else time.time_ns() // 1_000
        latitude_e7 = int(location.latitude * 10_000_000)
        longitude_e7 = int(location.longitude * 10_000_000)
        payload = (
            "role:1\n"
            "producer:12\n"
            "provenance:0\n"
            f"timestamp:{timestamp}\n"
            "latlng{\n"
            f"latitude_e7:{latitude_e7}\n"
            f"longitude_e7:{longitude_e7}\n"
            "}\n"
            "radius:-1\n"
        )
        encoded = base64.urlsafe_b64encode(payload.encode("ascii")).decode("ascii").rstrip("=")
        return f"a+{encoded}"

    @classmethod
    def _select_offers(cls, item_name: str, payload: dict[str, Any]) -> list[StoreOffer]:
        nearby_candidates = cls._nearby_category_candidates(payload)
        candidates = [
            candidate for candidate in nearby_candidates if cls._to_offer(item_name, candidate)
        ]
        if not candidates:
            candidates = cls._standard_candidates(payload)
            candidates = [
                candidate for candidate in candidates if cls._to_offer(item_name, candidate)
            ]
        ordered = sorted(candidates, key=cls._offer_sort_key)
        if not ordered:
            return []
        selected: list[StoreOffer] = []
        seen: set[tuple[str, str]] = set()
        preferred_store = cls._source_name(ordered[0])
        preferred_candidates = [
            candidate for candidate in ordered if cls._source_name(candidate) == preferred_store
        ]
        for candidate in [*preferred_candidates, *ordered]:
            offer = cls._to_offer(item_name, candidate)
            if not offer:
                continue
            identity = (offer.store_name.casefold(), offer.item_name.casefold())
            if identity in seen:
                continue
            selected.append(offer)
            seen.add(identity)
            if len(selected) == _MAX_OFFERS_PER_ITEM:
                return selected
        return selected

    @staticmethod
    def _nearby_category_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
        categories = payload.get("categorized_shopping_results", [])
        if not isinstance(categories, list):
            return []
        candidates: list[dict[str, Any]] = []
        for category in categories:
            if not isinstance(category, dict):
                continue
            title = category.get("title")
            normalized_title = title.casefold() if isinstance(title, str) else ""
            if "nearby" not in normalized_title or "store" not in normalized_title:
                continue
            results = category.get("shopping_results", [])
            if isinstance(results, list):
                candidates.extend(result for result in results if isinstance(result, dict))
        return candidates

    @staticmethod
    def _standard_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for key in ("shopping_results", "inline_shopping_results"):
            results = payload.get(key, [])
            if isinstance(results, list):
                candidates.extend(result for result in results if isinstance(result, dict))
        return candidates

    @classmethod
    def _offer_sort_key(cls, candidate: dict[str, Any]) -> tuple[bool, float, float, int]:
        text = cls._offer_text(candidate).casefold()
        distance = cls._distance_from_text(text)
        price = candidate.get("extracted_price")
        try:
            numeric_price = float(price)
        except (TypeError, ValueError):
            numeric_price = math.inf
        try:
            position = int(candidate.get("position", math.inf))
        except (OverflowError, TypeError, ValueError):
            position = 10_000
        distance_key = distance if distance is not None else math.inf
        return (not cls._is_in_store(text), distance_key, numeric_price, position)

    @staticmethod
    def _source_name(candidate: dict[str, Any]) -> str:
        source = candidate.get("source")
        if isinstance(source, str) and source.strip():
            return " ".join(source.split())[:120]
        return "Google Shopping"

    @classmethod
    def _to_offer(cls, item_name: str, candidate: dict[str, Any]) -> StoreOffer | None:
        title = candidate.get("title")
        price = candidate.get("price")
        if not isinstance(title, str) or not title.strip() or price is None:
            return None
        price_text = str(price).strip()
        if not price_text:
            return None
        details = cls._offer_text(candidate)
        return StoreOffer(
            store_name=cls._source_name(candidate),
            distance_miles=cls._distance_from_text(details),
            item_name=" ".join(title.split())[:120],
            requested_item_name=item_name,
            price=price_text[:40],
            price_source="Google Shopping via SerpAPI",
            thumbnail_url=cls._thumbnail_url(candidate),
            availability=cls._availability(details),
        )

    @staticmethod
    def _thumbnail_url(candidate: dict[str, Any]) -> str | None:
        for key in ("thumbnail", "serpapi_thumbnail"):
            value = candidate.get(key)
            if isinstance(value, str) and value.startswith(("https://", "http://")):
                return value[:2_000]
        return None

    @staticmethod
    def _offer_text(candidate: dict[str, Any]) -> str:
        values: list[str] = []
        for key in ("delivery", "snippet"):
            value = candidate.get(key)
            if isinstance(value, str):
                values.append(value)
        extensions = candidate.get("extensions", [])
        if isinstance(extensions, list):
            values.extend(value for value in extensions if isinstance(value, str))
        return " ".join(values)

    @staticmethod
    def _distance_from_text(text: str) -> float | None:
        match = _DISTANCE_PATTERN.search(text)
        if not match:
            return None
        try:
            return float(match.group(1))
        except ValueError:
            return None

    @staticmethod
    def _is_in_store(text: str) -> bool:
        lowered = text.casefold()
        return "in store" in lowered or "pick up" in lowered or "pickup" in lowered

    @classmethod
    def _availability(cls, text: str) -> str:
        if cls._is_in_store(text):
            return "in_store"
        return "delivery" if "delivery" in text.casefold() else "catalog_match"

    @staticmethod
    def _log_failure(operation: str, error: Exception) -> None:
        status_code = getattr(getattr(error, "response", None), "status_code", None)
        logger.warning(
            "SerpAPI %s failed: %s%s",
            operation,
            type(error).__name__,
            f" ({status_code})" if status_code else "",
        )


class GooglePlacesLocator:
    """Fallback store locator for when priced shopping offers are unavailable."""

    def __init__(self, settings: Settings):
        self._api_key = settings.google_maps_api_key
        self._url = settings.google_places_search_url

    @property
    def configured(self) -> bool:
        return bool(self._api_key)

    async def search(self, items: list[str], location: Coordinates) -> list[StoreOffer]:
        """Return nearby grocery locations when product pricing is unavailable."""
        if not self.configured:
            return []
        request_body = {
            "includedTypes": ["grocery_or_supermarket"],
            "maxResultCount": _MAX_OFFERS_PER_ITEM,
            "rankPreference": "DISTANCE",
            "locationRestriction": {
                "circle": {
                    "center": {"latitude": location.latitude, "longitude": location.longitude},
                    "radius": 5000.0,
                }
            },
        }
        headers = {
            "X-Goog-Api-Key": self._api_key,
            "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
        }
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                response = await client.post(self._url, json=request_body, headers=headers)
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, TypeError, ValueError) as error:
            logger.warning("Google Places lookup failed: %s", type(error).__name__)
            return []
        places = payload.get("places", []) if isinstance(payload, dict) else []
        if not isinstance(places, list):
            return []
        ordered_places = sorted(
            (place for place in places if isinstance(place, dict)),
            key=lambda place: _place_distance_miles(location, place) or math.inf,
        )
        offers: list[StoreOffer] = []
        for place in ordered_places[:_MAX_OFFERS_PER_ITEM]:
            display_name = place.get("displayName")
            name = "Grocery store"
            if isinstance(display_name, dict):
                value = display_name.get("text")
                if isinstance(value, str) and value.strip():
                    name = value
            distance = _place_distance_miles(location, place)
            for item in items:
                offers.append(
                    StoreOffer(
                        store_name=name,
                        distance_miles=distance,
                        address=place.get("formattedAddress"),
                        item_name=item,
                        availability="location_only",
                    )
                )
        return offers


async def lookup_store_offers(
    settings: Settings,
    items: list[str],
    location: Coordinates,
) -> StoreLookupResult:
    """Resolve dynamic store offers independently from recipe generation."""
    normalized_items = list(
        dict.fromkeys(normalized for item in items if (normalized := normalize_name(item)))
    )
    provider = SerpApiShoppingProvider(settings)
    if provider.configured:
        stores = await provider.search(normalized_items, location)
        if stores:
            notice = (
                "Up to two Google Shopping offers are shown for each item. Prices change often."
            )
            if provider.last_notice:
                notice = f"{notice} {provider.last_notice}"
            return StoreLookupResult(stores=stores, shopping_notice=notice)
        provider_notice = provider.last_notice or "No Google Shopping offers were available."
    else:
        provider_notice = provider.last_notice or "SerpAPI credentials are not configured."

    fallback_stores = await GooglePlacesLocator(settings).search(normalized_items, location)
    if fallback_stores:
        return StoreLookupResult(
            stores=fallback_stores,
            shopping_notice=f"{provider_notice} Nearby stores are shown without product prices.",
        )
    return StoreLookupResult(
        stores=[],
        shopping_notice=f"{provider_notice} Turn on location access and try again.",
    )
