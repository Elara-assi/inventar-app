"""Slot-Parser fuer die Diktat-Felderkennung (D2).

Deterministische Grammatik statt ML: schnell, offline-faehig, erklaerbar.
Identisch implementiert in TypeScript (apps/web/lib/dictation.ts) – gemeinsame
Testfaelle in apps/api/tests/dictation_cases.json halten beide synchron.

Konvention (Spickzettel im Wizard): "Marke ... Typ ... Baujahr ...
Seriennummer ... Zustand ...". Reihenfolge egal, Schluesselwoerter zaehlen.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any

# Schluesselwort -> Slot
KEYWORDS: dict[str, str] = {
    "marke": "brand", "hersteller": "brand",
    "typ": "model", "modell": "model", "type": "model", "model": "model",
    "baujahr": "year",
    "seriennummer": "serial", "serien nummer": "serial", "seriennr": "serial",
    "zustand": "condition",
    "bezeichnung": "object_type",
    "hinweis": "note", "notiz": "note", "bemerkung": "note",
}

CLASS_SYNONYMS: dict[str, list[str]] = {
    "hebebuehne": ["hebebuehne", "buehne", "hebelift", "lift"],
    "monitor": ["monitor", "bildschirm", "display"],
    "reifen": ["reifen", "reifensatz", "kompletträder", "komplettraeder"],
    "werkzeugwagen": ["werkzeugwagen"],
    "it_geraet": ["laptop", "notebook", "computer", "rechner", "pc"],
}

CONDITION_MAP: dict[str, str] = {
    "neu": "neu", "neuwertig": "neu",
    "sehr gut": "sehr_gut", "sehr guter": "sehr_gut",
    "gut": "gut", "guter": "gut",
    "gebraucht": "gebraucht", "ok": "gebraucht", "okay": "gebraucht",
    "reparaturbeduerftig": "reparaturbeduerftig", "reparatur noetig": "reparaturbeduerftig",
    "reparatur": "reparaturbeduerftig",
    "defekt": "defekt", "kaputt": "defekt",
    "aussondern": "aussondern", "schrott": "aussondern", "entsorgen": "aussondern",
}

# DIN-5009-Buchstabieralphabet (fuer Seriennummern)
SPELLING: dict[str, str] = {
    "anton": "A", "berta": "B", "caesar": "C", "cäsar": "C", "dora": "D",
    "emil": "E", "friedrich": "F", "gustav": "G", "heinrich": "H", "ida": "I",
    "julius": "J", "kaufmann": "K", "ludwig": "L", "martha": "M", "nordpol": "N",
    "otto": "O", "paula": "P", "quelle": "Q", "richard": "R", "samuel": "S",
    "siegfried": "S", "theodor": "T", "ulrich": "U", "viktor": "V",
    "wilhelm": "W", "xanthippe": "X", "ypsilon": "Y", "zacharias": "Z",
}

_ONES = {
    "null": 0, "eins": 1, "ein": 1, "zwei": 2, "drei": 3, "vier": 4,
    "fuenf": 5, "sechs": 6, "sieben": 7, "acht": 8, "neun": 9,
}
_TEENS = {
    "zehn": 10, "elf": 11, "zwoelf": 12, "dreizehn": 13, "vierzehn": 14,
    "fuenfzehn": 15, "sechzehn": 16, "siebzehn": 17, "achtzehn": 18, "neunzehn": 19,
}
_TENS = {
    "zwanzig": 20, "dreissig": 30, "vierzig": 40, "fuenfzig": 50,
    "sechzig": 60, "siebzig": 70, "achtzig": 80, "neunzig": 90,
}


def _normalize(text: str) -> str:
    text = text.lower()
    for src, dst in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("ß", "ss")):
        text = text.replace(src, dst)
    return text


def german_number(word: str) -> int | None:
    """'zweiundzwanzig' -> 22, 'achtzehn' -> 18 (0-99)."""
    word = _normalize(word.strip())
    if word in _ONES:
        return _ONES[word]
    if word in _TEENS:
        return _TEENS[word]
    if word in _TENS:
        return _TENS[word]
    if "und" in word:
        head, _, tail = word.partition("und")
        if head in _ONES and tail in _TENS:
            return _ONES[head] + _TENS[tail]
    return None


def parse_year(value: str) -> int | None:
    value = _normalize(value.strip())
    match = re.search(r"\b(19|20)\d{2}\b", value)
    if match:
        return int(match.group(0))
    match = re.search(r"\b(\d{1,2})\b", value)
    if match:
        two = int(match.group(1))
        current = date.today().year % 100
        return 2000 + two if two <= current else 1900 + two
    if value.startswith("zweitausend"):
        rest = value[len("zweitausend"):].lstrip("und")
        if not rest:
            return 2000
        n = german_number(rest)
        if n is not None:
            return 2000 + n
    n = german_number(value)
    if n is not None and n <= date.today().year % 100:
        return 2000 + n
    return None


def parse_serial(value: str) -> str | None:
    tokens = value.replace(",", " ").split()
    if not tokens:
        return None
    mapped: list[str] = []
    for token in tokens:
        norm = _normalize(token)
        if norm in SPELLING:
            mapped.append(SPELLING[norm])
        elif norm in _ONES:
            mapped.append(str(_ONES[norm]))
        elif norm in _TEENS:
            mapped.append(str(_TEENS[norm]))
        else:
            mapped.append(token)
    if len(mapped) == 1:
        return mapped[0].upper()
    return "".join(part.upper() for part in mapped)


def _find_keyword_spans(normalized: str) -> list[tuple[int, int, str]]:
    """(start, ende, slot) aller Schluesselwoerter, ueberlappungsfrei."""
    spans: list[tuple[int, int, str]] = []
    for keyword, slot in KEYWORDS.items():
        for match in re.finditer(rf"\b{re.escape(keyword)}\b", normalized):
            spans.append((match.start(), match.end(), slot))
    spans.sort()
    result: list[tuple[int, int, str]] = []
    last_end = -1
    for span in spans:
        if span[0] >= last_end:
            result.append(span)
            last_end = span[1]
    return result


def parse_dictation(text: str, brands: list[str] | None = None) -> dict[str, Any]:
    """Extrahiert Inventarfelder aus einem Diktat-Transkript.

    Liefert nur sicher erkannte Slots; alles Unzugeordnete landet in 'note'.
    """
    brands = brands or []
    original = text.strip()
    normalized = _normalize(original)
    result: dict[str, Any] = {}
    notes: list[str] = []

    spans = _find_keyword_spans(normalized)
    head_end = spans[0][0] if spans else len(original)
    head = original[:head_end].strip(" ,.;")

    # Segmente: Wert = Text zwischen Schluesselwort und naechstem Schluesselwort.
    for index, (start, end, slot) in enumerate(spans):
        value_end = spans[index + 1][0] if index + 1 < len(spans) else len(original)
        value = original[end:value_end].strip(" ,.;:-")
        if not value:
            continue
        if slot == "brand":
            result["brand"] = value.split(",")[0].strip()
        elif slot == "model":
            result["model"] = value
        elif slot == "year":
            year = parse_year(value)
            if year:
                result["manufacturing_year"] = year
            else:
                notes.append(f"Baujahr unklar: {value}")
        elif slot == "serial":
            serial = parse_serial(value)
            if serial:
                result["serial_number"] = serial
        elif slot == "condition":
            norm_value = _normalize(value)
            hit = None
            for phrase in sorted(CONDITION_MAP, key=len, reverse=True):
                if norm_value.startswith(phrase):
                    hit = CONDITION_MAP[phrase]
                    rest = value[len(phrase):].strip(" ,.;")
                    if rest:
                        notes.append(rest)
                    break
            if hit:
                result["condition"] = hit
            else:
                notes.append(f"Zustand unklar: {value}")
        elif slot == "object_type":
            result["object_type"] = value
        elif slot == "note":
            notes.append(value)

    # Kopf vor dem ersten Schluesselwort: Objektklasse + Marke per Lexikon.
    if head:
        head_norm = _normalize(head)
        head_words = head_norm.split()
        for slug, synonyms in CLASS_SYNONYMS.items():
            if any(word in synonyms for word in head_words):
                result.setdefault("object_class_slug", slug)
                break
        remaining = head
        for brand in brands:
            if re.search(rf"\b{re.escape(_normalize(brand))}\b", head_norm):
                result.setdefault("brand", brand)
                remaining = re.sub(rf"\b{re.escape(brand)}\b", "", remaining, flags=re.IGNORECASE)
                break
        remaining = remaining.strip(" ,.;")
        if remaining and "object_type" not in result:
            result["object_type"] = remaining

    # Marken-Lexikon auch ausserhalb des Kopfes (z. B. "Monitor von Dell").
    if "brand" not in result:
        for brand in brands:
            if re.search(rf"\b{re.escape(_normalize(brand))}\b", normalized):
                result["brand"] = brand
                break

    if notes:
        result["note"] = "; ".join(notes)
    return result


def to_bga_fields(parsed: dict[str, Any]) -> dict[str, str]:
    """Mappt generische Diktat-Slots auf das BGA-Erfassungsformular (main).

    brand+model werden zu 'specification' kombiniert, das Baujahr ist dort
    ein Textfeld ('construction_year'), freie Reste landen in 'remark'.
    """
    out: dict[str, str] = {}
    if parsed.get("object_type"):
        out["object_type"] = str(parsed["object_type"])
    specification = " ".join(str(parsed[key]) for key in ("brand", "model") if parsed.get(key))
    if specification:
        out["specification"] = specification
    if parsed.get("serial_number"):
        out["serial_number"] = str(parsed["serial_number"])
    if parsed.get("manufacturing_year"):
        out["construction_year"] = str(parsed["manufacturing_year"])
    if parsed.get("condition"):
        out["condition"] = str(parsed["condition"])
    if parsed.get("note"):
        out["remark"] = str(parsed["note"])
    return out
