from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.logic import normalize_bga_object_class, normalize_ollama_result  # noqa: E402


def base_fallback() -> dict:
    return {
        "object_type": "Unbekanntes Objekt",
        "object_class": "Unklar",
        "condition": "gebraucht",
        "commercial_category": "ungeklaert",
        "requires_accounting_review": True,
        "missing_fields": ["Seriennummer", "Anschaffungsdatum", "Buchwert"],
        "recommended_status": "nacharbeit_buchhaltung",
        "confidence": 0.55,
    }


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def assert_true(value, label: str) -> None:
    if not value:
        raise AssertionError(label)


def main() -> None:
    assert_equal(normalize_bga_object_class("Monitor", "Computermaus"), "Computermaus", "mouse beats background monitor")

    mouse = normalize_ollama_result(
        {
            "object_name": "Maus",
            "object_class": "Monitor",
            "confidence": 0.91,
            "estimated_value_eur": 1671,
            "estimated_value_confidence": 0.8,
            "estimated_value_reason": "geraten",
            "value_source": "modellpreis",
        },
        base_fallback(),
    )
    assert_equal(mouse["object_type"], "Computermaus", "mouse object type")
    assert_equal(mouse["object_class"], "Computermaus", "mouse object class")
    assert_equal(mouse["estimated_value_eur"], None, "implausible mouse value cleared")
    assert_equal(mouse["missing_fields"], [], "simple mouse does not inherit accounting missing fields")
    assert_true(mouse["bga_detection"]["value_requires_review"], "mouse value review flag")

    unknown = normalize_ollama_result(
        {
            "object_name": "Gerät",
            "object_class": "Unklar",
            "confidence": 0.52,
            "estimated_value_eur": 450,
        },
        base_fallback(),
    )
    assert_equal(unknown["object_class"], "Unklar", "unknown class")
    assert_equal(unknown["estimated_value_eur"], None, "unknown value cleared")
    assert_true(unknown["requires_manual_review"], "unknown review flag")

    keyboard = normalize_ollama_result(
        {
            "object_name": "Tastatur",
            "object_class": "IT-Zubehör",
            "confidence": 0.86,
            "condition_guess": "gebraucht",
        },
        base_fallback(),
    )
    assert_equal(keyboard["object_class"], "Tastatur", "keyboard class")
    assert_equal(keyboard["suggested_fields"]["object_type"], "Tastatur", "keyboard suggested name")

    print("AI guardrail checks passed")


if __name__ == "__main__":
    main()
