from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from app.logic import merge_nameplate_extraction, normalize_bga_object_class, normalize_nameplate_extraction, normalize_ollama_result  # noqa: E402
from app.main import estimate_value_from_web  # noqa: E402


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

    nespresso = normalize_ollama_result(
        {
            "object_name": "Nespresso Kapselmaschine",
            "object_class": "Sonstiges",
            "confidence": 0.9,
            "estimated_value_eur": 65,
            "estimated_value_confidence": 0.74,
            "estimated_value_reason": "Modellpreis",
            "value_source": "modellpreis",
        },
        base_fallback(),
    )
    assert_equal(nespresso["object_type"], "Kaffeemaschine", "nespresso object type")
    assert_equal(nespresso["object_class"], "Kaffeemaschine", "nespresso object class")
    assert_equal(nespresso["estimated_value_eur"], None, "nespresso model price cleared")
    assert_true(nespresso["bga_detection"]["value_requires_review"], "nespresso value review flag")

    nameplate = normalize_nameplate_extraction(
        {
            "raw_text": "Muster Maschinenbau GmbH\nTyp WM 240\nS/N A-123-45\nBaujahr 2019\n400 V 2.2 kW",
            "manufacturer": "Muster Maschinenbau GmbH",
            "model": "WM 240",
            "serial_number": "A-123-45",
            "construction_year": "2019",
            "technical_specs": ["400 V", "2.2 kW"],
            "suggested_object_type": "Wuchtmaschine",
            "confidence": 0.91,
        },
        "Wuchtmaschine",
    )
    assert_equal(nameplate["serial_number"], "A-123-45", "nameplate serial")
    assert_equal(nameplate["construction_year"], "2019", "nameplate year")
    assert_true("Rohtext" in nameplate["suggested_remark"], "nameplate remark keeps raw text")

    merged = merge_nameplate_extraction(keyboard, nameplate)
    assert_equal(merged["suggested_fields"]["serial_number"], "A-123-45", "nameplate serial suggested")
    assert_true("Muster Maschinenbau" in merged["suggested_fields"]["remark"], "nameplate remark merged")

    wuchtmaschine = {
        "object_type": "Wuchtmaschine",
        "object_class_name": "Betriebs- und Geschäftsausstattung",
        "brand": "Hofmann",
        "model": "geodyna 7600",
        "specification": "400 V",
        "condition": "gebraucht",
    }
    exact_value = estimate_value_from_web(
        wuchtmaschine,
        "Typenschild: Hofmann geodyna 7600 400 V",
        [
            {
                "title": "Hofmann geodyna 7600 Wuchtmaschine gebraucht 2400 EUR",
                "url": "https://www.ebay.de/itm/hofmann-geodyna-7600",
                "snippet": "Gebraucht, funktionsfähig, Hofmann geodyna 7600 Wuchtmaschine 400 V.",
            }
        ],
    )
    assert_equal(exact_value["valuation_state"], "reference_available", "exact used market reference")
    assert_equal(exact_value["reference_price_available"], True, "exact reference available")
    assert_equal(exact_value["estimated_value"], 2400, "exact reference value")

    similar_value = estimate_value_from_web(
        wuchtmaschine,
        "Typenschild: Hofmann geodyna 7600 400 V",
        [
            {
                "title": "Hofmann Wuchtmaschine gebraucht 2400 EUR",
                "url": "https://www.ebay.de/itm/hofmann-wuchtmaschine",
                "snippet": "Gebrauchte Wuchtmaschine, Modell nicht angegeben.",
            }
        ],
    )
    assert_equal(similar_value["valuation_state"], "range_review", "similar used market range only")
    assert_equal(similar_value["reference_price_available"], False, "similar reference not available")
    assert_equal(similar_value["estimated_value"], None, "similar value not applied")

    print("AI guardrail checks passed")


if __name__ == "__main__":
    main()
