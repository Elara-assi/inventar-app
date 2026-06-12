# Code-Review: Konsistenz und Stabilitaet (2026-06-12)

Bewertung des Standes Phase 0+1. Schweregrade: KRITISCH = Datenverlust/Absturz im Betrieb moeglich, HOCH = Stabilitaets-/Konsistenzrisiko, MITTEL = Wartbarkeit/Robustheit.

## Backend (apps/api)

| # | Schweregrad | Befund | Status |
|---|-------------|--------|--------|
| B1 | KRITISCH | `next_inventory_id` zaehlt per `count(*)+1`. Zwei Handys, die gleichzeitig erfassen, erzeugen dieselbe ID -> UNIQUE-Verletzung -> 500-Fehler, Objekt geht verloren. | Behoben: atomare Zaehlertabelle `inventory_id_counters` (UPSERT, Migration 002). |
| B2 | KRITISCH | Keine Transaktionen: `create_item` macht 2 Inserts mit Einzel-Commits. Schlaegt der zweite fehl, existiert ein Item ohne Buchhaltungsdatensatz. | Behoben: `transaction()`-Kontext, Item+Accounting+ID-Vergabe atomar. |
| B3 | HOCH | Jede Query oeffnet eine eigene DB-Verbindung (`psycopg.connect` pro Aufruf). `GET /sessions/{id}/items` macht zusaetzlich pro Item ~6 Folge-Queries (N+1). Bei 50 Objekten und 2,5s-Polling: Hunderte Verbindungen/Minute -> Verbindungsabbrueche unter Last. | Behoben: ConnectionPool (psycopg_pool) + gebatchte Abfragen (4 Queries statt 6N+1). |
| B4 | HOCH | SSE-Endpoint `/sessions/{id}/events` ruft synchrone DB-Funktionen im Async-Generator auf -> blockiert den Event-Loop fuer ALLE Requests. Kein Disconnect-Handling -> Zombie-Streams. | Behoben: `asyncio.to_thread`, Disconnect-Pruefung, Fehlertoleranz. |
| B5 | HOCH | Action-Endpoints (`change-status`, `request-rework`, `accounting`, `object-classes`) nehmen ungetypte `dict[str, Any]`-Bodies. Beliebige Statuswerte/Felder moeglich -> inkonsistente Daten. | Behoben: Pydantic-Modelle + zentrale Status-Whitelists. |
| B6 | HOCH | `upload_photo` ohne Validierung: kein Groessenlimit, kein Typcheck, beliebige Dateiendung. | Behoben: Whitelist Bildformate, 15-MB-Limit, sichere Dateinamen. |
| B7 | HOCH | Fotos sind gespeichert, aber es gibt keinen Endpoint, der sie ausliefert (`/uploads/{id}` ist Platzhalter). Pruefer kann Nachweisbilder nicht sehen. | Behoben: `GET /files/photo/{id}` u. `GET /files/audio/{id}` mit Pfad-Containment-Check. |
| B8 | MITTEL | `run_ai` setzt Status `ki_laeuft`, ohne Fehlerpfad: wirft der Stub eine Exception, haengt das Item dauerhaft in `ki_laeuft`. | Behoben: try/except, Fehlerresultat in `ai_results` (status=failed), Status-Reset. |
| B9 | MITTEL | `audit()` ohne Fehlerschutz: Schlaegt das Audit-Insert fehl, bricht der fachliche Request ab. Audit darf nie den Prozess killen. | Behoben: defensives Logging. |
| B10 | MITTEL | `export_excel` ueberschreibt je Session immer dieselbe Datei; aeltere Exporte (Beleg!) gehen verloren. | Behoben: Zeitstempel im Dateinamen. |
| B11 | MITTEL | `item_accounting` liefert `null` statt 404; `close_session` schliesst bereits geschlossene Sessions erneut. | Behoben. |
| B12 | MITTEL | Deprecated `@app.on_event("startup")`; `import json` inline in Funktionen; doppelte `json_string`/`json_dumps`-Helfer. | Behoben: Lifespan-Handler, zentrale Helfer. |

## Frontend (apps/web)

| # | Schweregrad | Befund | Status |
|---|-------------|--------|--------|
| F1 | KRITISCH | Pruefansicht: Das 2,5s-Polling ersetzt die Item-Props; `ItemReviewCard` setzt dann den Bearbeitungs-Draft zurueck. **Eingaben des Pruefers werden waehrend des Tippens verworfen.** | Behoben: Dirty-State-Schutz; Polling ueberschreibt nie eine aktive Bearbeitung. |
| F2 | HOCH | Jede Karte laedt bei jedem Poll zusaetzlich `GET /items/{id}` -> bei 30 Objekten 30 Extra-Requests alle 2,5s. | Behoben: Listen-Endpoint liefert alles Notwendige; kein Einzelfetch mehr. |
| F3 | HOCH | Mobile: `Code scannen` ist ein Fake-Button (legt nur ein Item an), kein Scanner. Sprachnotiz ist ein Textfeld. Fallback laedt Textdateien als "Fotos" hoch -> Testdaten-Muell in Produktion. | Behoben: echter Live-Barcode-Scanner (BarcodeDetector + ZXing-Fallback), echte Audioaufnahme (MediaRecorder), Fake-Uploads entfernt. |
| F4 | HOCH | Mobile-Erfassung ist eine lange Scroll-Seite ohne Prozessfuehrung; Aktionen koennen in falscher Reihenfolge/doppelt ausgefuehrt werden. | Behoben: gefuehrter Schritt-Wizard (eine Aufgabe pro Bildschirm), Pflicht-Nachweise je Objektklasse dynamisch aus `field_requirements`. |
| F5 | MITTEL | Dashboard: `load()` setzt die Raumauswahl nach jedem Reload auf Raum 1 zurueck. | Behoben. |
| F6 | MITTEL | Keine Lade-/Fehlerzustaende; API-Fehler (JSON) werden roh angezeigt. | Behoben: lesbare Fehlertexte, Lade-Indikatoren, Retry bei Mobile-Uploads. |
| F7 | MITTEL | Polling laeuft auch bei verstecktem Tab weiter (Akku/Last). | Behoben: Pause bei `document.hidden`. |

## Konsistenz Datenmodell vs. Code

- `field_requirements` ist gut modelliert, wurde aber mobil nicht genutzt (Nachweise waren statisch). Jetzt steuert die Tabelle den Wizard.
- Statuswerte waren nur im Frontend hartkodiert; jetzt zentrale Whitelists im Backend (Quelle: docs/DATA_MODEL.md).
- `exports`, `audit_log`, `ai_results` konsistent; Indizes fuer `audit_log(entity_id)` und `accounting_tasks(item_id,status)` ergaenzt (Migration 002).

## Bewusst NICHT angefasst (Scope-Disziplin, AGENTS.md)

- KI bleibt deterministischer Stub (LiteLLM-Anbindung = eigener Schritt).
- Kein Service Worker / voller Offline-Modus (kaputter SW-Cache waere selbst ein Stabilitaetsrisiko; Upload-Retry deckt Netz-Wackler ab).
- Auth bleibt Demo-Niveau (laut Phasenplan Haertung spaeter).
- Worker bleibt Platzhalter.
