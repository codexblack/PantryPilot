"""Small, local guardrails for free-form meal-planning input."""

from __future__ import annotations

import re

from app.schemas import Ingredient

PROFANITY = frozenset(
    {
        "asshole",
        "bastard",
        "bitch",
        "bullshit",
        "crap",
        "cunt",
        "damn",
        "dick",
        "fuck",
        "motherfucker",
        "piss",
        "shit",
        "slut",
        "whore",
    }
)
NON_CULINARY_TERMS = frozenset(
    {
        "bomb",
        "code",
        "crypto",
        "election",
        "essay",
        "exploit",
        "hack",
        "homework",
        "javascript",
        "lyrics",
        "math",
        "password",
        "poem",
        "politics",
        "python",
        "sex",
        "song",
        "stock",
        "weapon",
    }
)
TASTE_TERMS = frozenset(
    {
        "bitter",
        "breakfast",
        "brunch",
        "cold",
        "comfort",
        "creamy",
        "crisp",
        "dinner",
        "dish",
        "food",
        "fresh",
        "fruity",
        "hearty",
        "herby",
        "lunch",
        "meal",
        "pinot",
        "savory",
        "smoky",
        "sour",
        "spicy",
        "sweet",
        "tangy",
        "wine",
        "warming",
    }
)


def _tokens(value: str) -> set[str]:
    return set(re.findall(r"[a-z]+", value.lower()))


def _has_disallowed_content(value: str) -> bool:
    tokens = _tokens(value)
    return bool(tokens & PROFANITY or tokens & NON_CULINARY_TERMS)


def sanitize_taste_profile(value: str | None) -> str | None:
    """Return a short culinary preference, or omit it before it reaches the model."""
    if not value:
        return None
    cleaned = " ".join(value.split())
    tokens = _tokens(cleaned)
    if not cleaned or _has_disallowed_content(cleaned) or not tokens.intersection(TASTE_TERMS):
        return None
    return cleaned


def filter_culinary_ingredients(items: list[Ingredient]) -> list[Ingredient]:
    """Keep plausible food inventory and drop profane or clearly unrelated manual entries."""
    return [
        item for item in items if not _has_disallowed_content(f"{item.name} {item.normalized_name}")
    ]
