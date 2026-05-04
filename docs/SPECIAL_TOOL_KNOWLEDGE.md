# Spezialwerkzeug-Wissensbasis

Stand: 2026-05-04

## Zweck

Die Spezialwerkzeug-Wissensbasis dient als Referenzschicht für die KI-Auswertung. Sie ist kein finaler Stammdatenimport, sondern liefert prüfpflichtige Kandidaten für:

- Spezialwerkzeug-Bezeichnungen
- VAS-/V.A.G.-Nummern
- ASE-/Bestellnummern
- Werkstattbereiche wie Hybrid, Batteriekompetenz, Lack, Alu-Mischbau und R/RS
- Standardwerkzeuggruppen und Mengengerüst-Hinweise

## Quellen

Eingelesene Dateien:

- `Batteriekompetenzzentrum_V24.1.xlsx`
- `Standardwerkzeugsatz-Ergänzung.xls`
- `hybrid V15.0.xlsx`
- `Standardwerkzeugsatz-Basis.xls`
- `R8_200.xls`
- `Lack V190.xls`
- `Alu-Mischbau_V24.0.xlsx`
- `Empfehlung_R-RS_Partner_230.xlsx`
- `Mengengeruest_V24.0.xlsx`

## Ergebnis

Die normalisierte JSON-Datei liegt unter:

`apps/api/app/knowledge/special_tools_reference.json`

Aktueller Umfang:

- 605 Referenzdatensätze
- Datensatztypen: `tool`, `tool_group`, `quantity_rule`
- Felder: Quelle, Tabellenblatt, Zeile, Kategorie, deutsche Bezeichnung, englische Bezeichnung, Bestellnummer, VAG-Nummer, Standardkennzeichen und Bemerkung

## Nutzung in Phase 1

Bei der KI-Auswertung werden nicht alle 605 Datensätze in den Prompt geladen. Stattdessen filtert das Backend anhand von:

- Sprachnotiz
- ausgewählter Objektklasse
- VAS-/V.A.G.-Nummern
- ASE-/Bestellnummern
- bekannten Werkzeugbezeichnungen

Nur die besten Treffer werden als `special_tool_matches` an Ollama gegeben. Das hält die Auswertung schneller und präziser.

## Grundregel

Referenztreffer sind Vorschläge, keine finalen Stammdaten. Der Prüfer entscheidet final.
