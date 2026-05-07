# Modul Reifen/Räder

Stand: Phase 1 Vorbereitung

Dieses Modul erweitert die Inventar-App um Reifen, Räder, Radsätze und Einzelreifen. BGA Phase 1 bleibt die stabile Referenz und darf durch dieses Modul nicht verändert oder beschädigt werden.

## Zielbild

Der Prozess folgt dem bewährten Muster:

Handy-Erfassung -> Prüferliste Laptop/iPad -> Nacharbeit -> Raumabschluss -> Excel-Export.

In Phase 1 werden Datenmodell, Backend-Schemas, DOT-Logik und Nacharbeitslogik vorbereitet. Der vollständige Handy-Flow und das eigene Excel-Layout folgen später.

## Datenfelder

Die gemeinsamen Inventurfelder bleiben in `inventory_items`:

- Standort
- Gebäude
- Raum / Lagerort
- erfasst durch
- Datum
- laufende Nummer
- Status
- Prüfstatus
- Fotos
- Audit-Log

Reifen-/Räder-spezifische Details liegen in `item_tire_wheel_data`:

- `item_id`
- `set_type`: `satz`, `einzelreifen`
- `season`: `sommer`, `winter`, `ganzjahr`, `unklar`
- `manufacturer`
- `profile_model`
- `tire_size`
- `load_index`
- `speed_index`
- `dot`
- `production_week`
- `production_year`
- `tread_depth_front_left`
- `tread_depth_front_right`
- `tread_depth_rear_left`
- `tread_depth_rear_right`
- `tread_depth_single`
- `rim_present`
- `rim_type`: `stahl`, `alu`, `unklar`
- `rim_condition`
- `tire_condition`
- `damage_note`
- `set_complete`
- `storage_location`
- `remark`

## Fotoarten

Vorbereitete `photo_type`-Werte:

| photo_type | Deutsches Label |
| --- | --- |
| `tire_overview` | Gesamtfoto Reifen/Radsatz |
| `tread` | Profilbild |
| `dot` | DOT-Foto |
| `tire_size` | Reifengröße |
| `rim` | Felge |
| `damage` | Schaden |
| `other` | Sonstiges |

## DOT-Logik

DOT wird im Format `WWYY` ausgewertet.

Beispiele:

- `2419` -> Kalenderwoche 24, Jahr 2019
- `0523` -> Kalenderwoche 5, Jahr 2023

Plausibilitätsregeln:

- Woche muss zwischen 01 und 53 liegen
- Jahr wird als 2000er-Jahr interpretiert, sofern plausibel
- unplausible Werte bleiben fachlich unklar und erzeugen Nacharbeit

## Nacharbeitsregeln

Nacharbeit wird nur für `inventory_type = "tires_wheels"` erzeugt.

Blockierende Nacharbeit:

- Gesamtfoto Reifen/Radsatz fehlt
- DOT fehlt oder unklar
- Reifengröße fehlt
- Profiltiefe fehlt
- Profiltiefe unter gesetzlicher Mindestgrenze 1,6 mm
- Satz unvollständig
- Schaden vorhanden
- Saison unklar
- Felgentyp oder Felgenzustand unklar, wenn Felge vorhanden

Nicht blockierende Warnung:

- Sommerreifen unter 3,0 mm Profiltiefe
- Winter-/Ganzjahresreifen unter 4,0 mm Profiltiefe

Warnungen werden der Prüfung zugeordnet und sollen fachlich bewertet werden, ohne BGA-Regeln zu beeinflussen.

## Offene Phase-2-Punkte

Noch nicht umgesetzt:

- vollständiger geführter Handy-Flow Reifen/Räder
- große Prüferlisten-UI für Reifen/Räder
- eigenes Excel-Layout `Reifen/Räder Inventurliste`
- automatische Webrecherche und Wertlogik
- Reifenalter-/Wertberechnung aus DOT
- Dubletten- oder Satznummernlogik
- tiefer KI-Workflow

## BGA-Schutzregel

BGA Phase 1 gilt als abgenommen und stabil.

Reifen/Räder-Logik darf nur aktiv sein, wenn `inventory_type = "tires_wheels"` gesetzt ist. BGA-Workflow, BGA-Nacharbeit und BGA-Excel dürfen nicht durch Reifen/Räder-Änderungen verändert werden.

Nach jeder Erweiterung dieses Moduls ist mindestens zu prüfen:

- BGA-Excel-Spalten bleiben exakt unverändert
- keine Prüfbuch-Spalten im BGA-Export
- BGA-Raumabschluss und Sperre funktionieren unverändert
- BGA-Handyroute baut weiterhin

