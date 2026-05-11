from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

# The provider tests exercise search/deep-dive code only. Some local dev
# environments do not have Pillow installed, while the production API image does.
sys.modules.setdefault("PIL", types.ModuleType("PIL"))
sys.modules.setdefault("PIL.Image", types.ModuleType("PIL.Image"))
sys.modules.setdefault("PIL.ImageOps", types.ModuleType("PIL.ImageOps"))

from app import main  # noqa: E402


class FakeResponse:
    def __init__(self, *, data: dict[str, Any] | None = None, text: str = "", status_code: int = 200) -> None:
        self._data = data or {}
        self.text = text
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict[str, Any]:
        return self._data


def test_searxng_sources() -> None:
    original_get = main.httpx.get
    original_provider = main.settings.search_provider
    original_base_url = main.settings.searxng_base_url
    try:
        main.settings.search_provider = "searxng"
        main.settings.searxng_base_url = "http://searxng.local"

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            assert url == "http://searxng.local/search"
            assert kwargs["params"]["format"] == "json"
            assert kwargs["params"]["language"] == "de"
            return FakeResponse(
                data={
                    "results": [
                        {
                            "title": "Logitech Computermaus gebraucht kaufen",
                            "url": "https://example.test/mouse",
                            "content": "Gebrauchte Computermaus mit Marktpreisbezug.",
                        }
                    ]
                }
            )

        main.httpx.get = fake_get
        sources, provider, error = main.search_sources("Computermaus Logitech gebraucht Preis", limit=3)
        assert provider == "searxng"
        assert error is None
        assert sources == [
            {
                "title": "Logitech Computermaus gebraucht kaufen",
                "url": "https://example.test/mouse",
                "snippet": "Gebrauchte Computermaus mit Marktpreisbezug.",
                "source_provider": "searxng",
                "rank": 1,
            }
        ]
    finally:
        main.httpx.get = original_get
        main.settings.search_provider = original_provider
        main.settings.searxng_base_url = original_base_url


def test_duckduckgo_fallback_after_searxng_error() -> None:
    original_get = main.httpx.get
    original_provider = main.settings.search_provider
    original_base_url = main.settings.searxng_base_url
    try:
        main.settings.search_provider = "searxng"
        main.settings.searxng_base_url = "http://searxng.local"

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            if "searxng.local" in url:
                raise RuntimeError("connection refused")
            assert url == "https://duckduckgo.com/html/"
            return FakeResponse(
                text=(
                    '<a class="result__a" href="https://example.test/fallback">Fallback Quelle</a>'
                    '<div class="result__snippet">Fallback Snippet</div>'
                )
            )

        main.httpx.get = fake_get
        sources, provider, error = main.search_sources("Computermaus Logitech gebraucht Preis", limit=3)
        assert provider == "duckduckgo_html"
        assert error and "SearXNG" in error
        assert len(sources) == 1
        assert sources[0]["source_provider"] == "duckduckgo_html"
        assert sources[0]["snippet"] == "Fallback Snippet"
    finally:
        main.httpx.get = original_get
        main.settings.search_provider = original_provider
        main.settings.searxng_base_url = original_base_url


def test_deep_dive_without_sources_leaves_value_and_age_open() -> None:
    original_fetch_one = main.fetch_one
    original_search_sources = main.search_sources
    try:
        def fake_fetch_one(sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
            if "FROM inventory_items" in sql:
                return {
                    "id": "item-1",
                    "object_type": "Unbekanntes Objekt",
                    "brand": None,
                    "model": None,
                    "serial_number": None,
                    "object_class_name": "Unklar",
                    "condition": "gebraucht",
                }
            if "FROM ai_results" in sql:
                return None
            return None

        main.fetch_one = fake_fetch_one
        main.search_sources = lambda *args, **kwargs: ([], "searxng", "SearXNG: test offline")
        result = main.build_deep_dive_result("item-1")
        assert result["web_search_performed"] is False
        assert result["search_provider"] == "searxng"
        assert result["estimated_value"] is None
        assert result["estimated_age_years"] is None
        assert result["manual_review_required"] is True
        assert result["value_requires_review"] is True
    finally:
        main.fetch_one = original_fetch_one
        main.search_sources = original_search_sources


if __name__ == "__main__":
    test_searxng_sources()
    test_duckduckgo_fallback_after_searxng_error()
    test_deep_dive_without_sources_leaves_value_and_age_open()
    print("Search provider guardrails passed.")
