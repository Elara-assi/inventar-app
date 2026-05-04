# Inventarhistorie-Wissensbasis

Stand: 2026-05-04

## Zweck

Diese Wissensbasis ergänzt die Spezialwerkzeug-Referenzen um reale Bestands- und Mängelhinweise aus früheren MAV-Unterlagen.

Sie dient als prüfpflichtige Vorschlagsschicht für:

- bekannte Werkstattausstattung
- frühere Mängel
- fehlendes oder defektes Spezialwerkzeug
- UVV-/DGUV- und Wartungshinweise
- fehlende Prüfbücher
- Soll-/Ist-Hinweise für spätere Ausbaustufen

## Eingelesene Quellen

- `2023_05_AV-Mängel_MAV.xlsx`
- `2023_04_28 MAV 1 Bestandsaufnahme Werkstattausstattung.pdf`
- `2023_04_28 MAV 2 Bestandskontrolle Werkzeug lt. SEPP Aufnahme.pdf`
- `2023_04_28 MAV 3 Bestandsaufnahme Soll ISO Werkezuge.pdf`

## Ergebnis

Die normalisierte JSON-Datei liegt unter:

`apps/api/app/knowledge/inventory_history_reference.json`

Aktueller Umfang:

- 63 strukturierte Datensätze aus der Excel-Mängelliste
- 3 PDF-Quellen als Quellenmetadaten
- PDF-Status: Bild-PDF ohne Textschicht, OCR später ergänzen

## Nutzung in Phase 1

Das Backend sucht anhand von Sprachnotiz und Objektklasse nach passenden historischen Treffern.

Treffer werden als `inventory_history_matches` an die KI übergeben. Sie dürfen:

- Hinweise für den Prüfer erzeugen
- Nacharbeit vorschlagen
- UVV/Wartung/Defekt/Sollbestand markieren

Sie dürfen nicht:

- die mobile Erfassung blockieren
- ohne Prüferentscheidung final übernommen werden

## Grundregel

Altunterlagen sind starke Hinweise, aber keine finalen Daten. Der Prüfer entscheidet final.
