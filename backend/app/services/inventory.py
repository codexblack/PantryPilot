from collections.abc import Iterable

from app.schemas import MAX_SCAN_INGREDIENTS, Freshness, Ingredient

# Keep aliases deliberately small and auditable.
ALIASES = {
    "roma tomatoes": "tomato",
    "cherry tomatoes": "tomato",
    "tomatoes": "tomato",
    "mozzarella balls": "mozzarella",
    "fresh mozzarella": "mozzarella",
    "scallions": "green onion",
    "spring onions": "green onion",
    "bell peppers": "bell pepper",
    "eggs": "egg",
    "potatoes": "potato",
}


def normalize_name(value: str) -> str:
    cleaned = " ".join(value.lower().strip().split())
    return ALIASES.get(cleaned, cleaned)


def normalize_inventory(
    items: Iterable[Ingredient],
    *,
    minimum_confidence: float = 0,
) -> list[Ingredient]:
    """Normalize duplicates, then remove standalone results below a confidence floor."""
    if not 0 <= minimum_confidence <= 1:
        raise ValueError("minimum confidence must be between 0 and 1")
    grouped: dict[str, Ingredient] = {}
    for item in items:
        normalized = normalize_name(item.normalized_name or item.name)
        candidate = item.model_copy(update={"normalized_name": normalized})
        current = grouped.get(normalized)
        if current is None:
            grouped[normalized] = candidate
            continue

        # Frame confidence applies to identification as a whole. A lower-confidence sighting can
        # still be the only one where a count, an opened package, or an expiry signal is visible.
        best = candidate if candidate.confidence > current.confidence else current
        quantity = best.quantity or current.quantity or candidate.quantity
        freshness = (
            Freshness.USE_SOON
            if Freshness.USE_SOON in {current.freshness, candidate.freshness}
            else Freshness.FRESH
            if Freshness.FRESH in {current.freshness, candidate.freshness}
            else Freshness.UNKNOWN
        )
        opened = True if True in {current.opened, candidate.opened} else best.opened
        grouped[normalized] = best.model_copy(
            update={"quantity": quantity, "freshness": freshness, "opened": opened}
        )
    ranked = sorted(
        (item for item in grouped.values() if item.confidence >= minimum_confidence),
        key=lambda item: (-item.confidence, item.name),
    )
    return ranked[:MAX_SCAN_INGREDIENTS]
