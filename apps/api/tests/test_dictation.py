"""Gemeinsame Testfaelle fuer beide Parser-Implementierungen (Python/TS)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.dictation import parse_dictation  # noqa: E402

BRANDS = [
    "Nussbaum", "MAHA", "Hofmann", "Dell", "HP", "Lenovo", "Samsung",
    "Michelin", "Continental", "Hazet", "Gedore", "Brother",
]


def test_cases() -> None:
    cases = json.loads((Path(__file__).parent / "dictation_cases.json").read_text(encoding="utf-8"))
    failures = []
    for case in cases:
        got = parse_dictation(case["text"], BRANDS)
        for key, expected in case["expect"].items():
            if key == "note_contains":
                if expected.lower() not in str(got.get("note", "")).lower():
                    failures.append(f"{case['text']!r}: note {got.get('note')!r} enthaelt nicht {expected!r}")
            elif got.get(key) != expected:
                failures.append(f"{case['text']!r}: {key}={got.get(key)!r}, erwartet {expected!r}")
    assert not failures, "\n".join(failures)


if __name__ == "__main__":
    test_cases()
    print("Alle Diktat-Testfaelle bestanden (Python).")
