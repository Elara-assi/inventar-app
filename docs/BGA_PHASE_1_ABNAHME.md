# BGA Phase 1 Abnahme

Stand: 07.05.2026

Diese Abnahme dokumentiert den aktuellen Stand des Moduls Betriebs- und Geschäftsausstattung (BGA) als stabile Phase-1-Basis.

## 1. Funktionsumfang BGA Phase 1

BGA Phase 1 ersetzt die bisherige manuelle Zählliste für Betriebs- und Geschäftsausstattung in einem praxistauglichen Raumprozess.

Umgesetzt und geprüft sind:

- geführte Handy-Erfassung für Objekte im Raum
- Objektfoto und weitere Nachweisfotos je Gegenstand
- strukturierte BGA-Felder wie Bezeichnung, Typ/Spezifikation, Baujahr, Zustand, Funktion i. O., UVV bis und Bemerkung
- Prüfer-/Nacharbeit am Laptop oder iPad
- direkte Korrektur gespeicherter Objekte bis zum Raumabschluss
- Nacharbeitslogik für fehlende oder fachlich kritische Angaben
- Raumabschluss mit Sperre
- gesperrter Zustand nach Raumabschluss für Bearbeitung, Upload, KI-Start und Löschen
- Excel-Export nach papiernaher Zähllistenstruktur
- Foto-/Nachweisexport mit eingebetteten Bildern und Originalpfaden

## 2. Erfolgreicher Praxistest

Der BGA-Praxistest wurde mit einer neuen Raum-Session durchgeführt.

Geprüft wurden:

- 10 BGA-Objekte erfasst
- Typenschild-Fall geprüft
- UVV-Siegel-Fall geprüft
- Zustand defekt geprüft
- Funktion i. O. Nein geprüft
- Objekt ohne Typenschild geprüft
- 17 Foto-Nachweise gespeichert
- Excel-Export erfolgreich erzeugt
- Raumabschluss-Sperre erfolgreich geprüft

Die Sperre nach Raumabschluss wurde technisch geprüft. Nach Abschluss wurden Bearbeitung, Foto-Upload, KI-Start und Löschen jeweils blockiert.

## 3. Fachliche Excel-Struktur

Der Tab `Inventurliste` ist an die bisherige manuelle Zählliste angelehnt.

Kopfbereich:

- Manuelle Zählliste
- Betriebs- und Geschäftsausstattung
- Standort
- erfasst durch
- Datum

Tabellenstruktur exakt:

| Spalte | Überschrift |
| --- | --- |
| A | lfd. Nr. / Foto |
| B | Bezeichnung |
| C | Typ / Spezifikation |
| D | Baujahr |
| E | Zustand |
| F | Funktion i. O. Ja |
| G | Funktion i. O. Nein |
| H | UVV bis |
| I | Bemerkung |

Wichtig: Im BGA-Export gibt es keine Prüfbuch-Spalten.

Weitere Tabs bleiben erhalten:

- Übersicht
- Offene Punkte - Nacharbeit
- Fotos - Nachweise
- Protokoll

## 4. Bekannte Grenze

Die Nacharbeitsliste war im finalen Export des Praxistests leer, weil die blockierenden Testfälle vor dem Raumabschluss prüferseitig korrigiert wurden.

Die Blockerlogik wurde vor der Korrektur erfolgreich geprüft: Der Raumabschluss wurde bei offenen Punkten korrekt blockiert.

## 5. Technische Prüfungen

Folgende Prüfungen wurden erfolgreich ausgeführt:

```bash
python -m py_compile apps/api/app/main.py apps/api/app/logic.py
npm run smoke
npm run build
```

Zusätzlich auf dem VPS geprüft:

- `docker compose ps`
- API Health mit `database:true`
- Web HTTP 200

## 6. Schutzregel für Folgeentwicklung

BGA Phase 1 gilt ab dieser Abnahme als stabile Basis.

Künftige Änderungen am BGA-Prozess sollen gezielt, klein und fachlich begründet erfolgen. BGA darf nicht im Rahmen neuer Module grundlegend umgebaut oder destabilisiert werden.

Die späteren Module Reifen/Räder und Spezialwerkzeuge sollen auf dem BGA-Muster aufbauen:

- gleiche Grundlogik für Raum, Erfassung, Prüfung, Nacharbeit, Sperre und Export
- eigene Felder und Regeln pro Modul
- keine Beschädigung des bestehenden BGA-Ablaufs

