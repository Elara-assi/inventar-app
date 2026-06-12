# Plan: Push-to-Talk-Diktat mit Felderkennung

Stand: 2026-06-12. Status: UMGESETZT (O1+O2+O3-Kern bzw. D1-D3; siehe README Phase 2). On-Device-Whisper (D4) offen. Baut auf PLAN_OFFLINE_MODUS.md auf.

## Ausgangslage und Entscheidung

Die bisherige KI-Bezeichnungserkennung (`POST /items/{id}/ai/run` im Mobile-Ablauf) fliegt aus dem Erfassungspfad:

- Sie kostet Zeit im kritischen Vor-Ort-Prozess.
- Sie braucht Netz – im Keller nicht vorhanden.
- Der Endpoint bleibt fuer Pruefer/Worker erhalten (asynchrone Veredelung), wird aber mobil nicht mehr aufgerufen und blockiert nichts mehr.

Ersatz: **sauber diktieren statt raten.** Ein grosser Push-to-Talk-Button (halten = sprechen), der Erfasser diktiert Bezeichnung, Marke, Typ, Baujahr, Seriennummer, Zustand – und das Geraet fuellt die Felder selbst. Offline.

## Funktionsprinzip

```
[Button halten] -> Aufnahme (MediaRecorder, lokal)
       │
       ├─ sofort, on-device:  Transkript (falls verfuegbar) ──> Slot-Parser ──> Felder im Wizard
       │                                                          (TypeScript, offline, < 1 ms)
       └─ immer:              Audio-Blob als Beleg in die Outbox ──Sync──> Server
                                                                    │
                              Worker: Whisper-Transkription + derselbe Parser (Python)
                              fuellt fehlende Felder NACH dem Sync nach -> Pruefansicht
```

Der Mensch bestaetigt im letzten Wizard-Schritt – erkannte Felder sind vorausgefuellt und korrigierbar. Keine Wartezeit, kein Netz noetig, Audio bleibt als Nachweis erhalten.

## Baustein 1: Push-to-Talk-Button

- Pointer Events: `pointerdown` startet, `pointerup`/`pointercancel` stoppt. Long-Press-Kontextmenue unterdrueckt, `pointerleave` = Stopp (kein Haengenbleiben).
- Gross (min. 96 px Hoehe, halbe Bildschirmbreite), Vibration beim Start/Stopp, Live-Pegelanzeige (AnalyserNode) als sichtbares "es nimmt auf"-Feedback, Laufzeitanzeige, Limit 60 s.
- Zu kurze Aufnahmen (< 0,5 s) werden verworfen ("zu kurz – halten zum Sprechen").
- Ersetzt den bisherigen Aufnahme-Toggle im Schritt "Zustand & Notiz"; Diktat wird der Hauptweg, Textfeld bleibt Fallback.

## Baustein 2: Felderkennung (Slot-Parser, offline)

Kein ML im kritischen Pfad, sondern eine deterministische Grammatik – schnell, offline, erklaerbar, in TypeScript (Geraet) und Python (Worker) identisch implementiert:

- **Schluesselwort-Slots:** "Marke X", "Typ/Modell Y", "Baujahr 2018", "Seriennummer ABC-123", "Zustand gut", "DOT 2319", "Bezeichnung ...".
- **Lexika aus Stammdaten:** Objektklassen-Synonyme (Hebebuehne/Buehne/Lift), Markenliste je Branche (Nussbaum, MAHA, Hofmann, Dell, HP, ...; pflegbar als Tabelle `brand_lexicon`, im Stammdaten-Cache offline verfuegbar), Zustandswerte aus DATA_MODEL.
- **Normalisierung:** Zahlwoerter ("zweitausendachtzehn" -> 2018), Buchstabier-Modus fuer Seriennummern ("Anton Berta drei" -> AB3), Jahresplausibilitaet (1950–heute).
- Felder, die der Parser sicher erkennt, werden gesetzt; Unsicheres landet sichtbar als "nicht zugeordnet" im Notiztext. Konfidenz pro Slot, unter Schwelle -> Feld bleibt leer statt falsch.

Beispiel-Diktat: *"Hebebuehne, Marke Nussbaum, Typ Smart Lift 2.35, Baujahr 2018, Seriennummer N-4-7-3-2-2, Zustand gut, Tragkraft dreieinhalb Tonnen"*
-> object_type=Hebebuehne, Klasse=hebebuehne, brand=Nussbaum, model=Smart Lift 2.35, Baujahr=2018, serial_number=N47322, condition=gut, Notiz: "Tragkraft 3,5 t".

**Diktat-Konvention als System:** Die Reihenfolge "Marke – Typ – Baujahr – Seriennummer – Zustand" wird geschult und als Mini-Spickzettel im Wizard angezeigt (eine Zeile ueber dem Button). Konvention schlaegt Magie: damit erreicht ein simpler Parser > 90 % Trefferquote.

## Baustein 3: Transkription – drei Pfade

| Pfad | Wann | Eigenschaften |
|---|---|---|
| A: Web Speech API (live) | Online, Android Chrome stark | Sofort-Transkript waehrend des Sprechens. ABER: Audio geht an Google-Server -> Datenschutz-Entscheidung noetig. iOS lueckenhaft. |
| B: Server-Whisper (Worker) | Immer, nach Sync | `faster-whisper` (Modell small/medium, Deutsch) im vorhandenen Worker-Container, on-prem, DSGVO-sauber. Transkribiert Outbox-Audios nach dem Sync (transcript_status pending -> completed existiert bereits im Datenmodell), Parser fuellt leere Felder nach, Pruefer sieht das Ergebnis. Keine Wartezeit fuer den Erfasser. |
| C: On-Device-Whisper (WASM/WebGPU) | Optional, Spike | Transformers.js mit whisper-tiny/base quantisiert (~40–80 MB, einmalig gecacht). Echtes Offline-Transkript auf dem Geraet. Auf Mittelklasse-Handys evtl. zaeh -> 1-PT-Spike mit Messwerten, erst danach entscheiden. |

Empfehlung: **B als Pflicht** (zuverlaessig, on-prem), **A aus** (Firmendaten an Google vermeiden), **C als Spike** – wenn die Messwerte gut sind, bekommt der Erfasser auch offline sofort gefuellte Felder statt erst nach dem Sync.

Wichtig: Selbst ohne jedes Transkript funktioniert der Prozess – Audio ist gesichert, Felder kommen nach dem Sync vom Worker. Der Erfasser muss nie warten.

## Backend-Aenderungen

- `ai/run` aus der mobilen Pipeline entfernen (nur Frontend-Aenderung; Endpoint bleibt).
- Worker (bisher Platzhalter) bekommt erste echte Aufgabe: Transkriptions-Queue (Polling auf `transcript_status='pending'`), faster-whisper, danach Parser + Feld-Nachtrag mit Audit-Eintrag (`fields_from_dictation`).
- Tabelle `brand_lexicon` (Migration, seedbar) fuer die Markenliste; Parser-Regeln versioniert im Repo.
- Items, deren Felder vom Worker nachgetragen wurden, behalten review_status-Logik wie bisher (ki_vorgefuellt -> Pruefer entscheidet).

## Etappen und Aufwand

| Etappe | Inhalt | Aufwand |
|---|---|---|
| D1 | KI-Stub raus aus Mobile-Pipeline, Push-to-Talk-Button mit Pegel/Vibration/Limits | 1–2 PT |
| D2 | Slot-Parser TS (offline) + Spickzettel-UI + vorausgefuellte Felder im Bestaetigen-Schritt; identischer Parser in Python mit gemeinsamen Testfaellen | 2–3 PT |
| D3 | Worker-Transkription (faster-whisper) + Feld-Nachtrag + Audit; brand_lexicon | 2–3 PT |
| D4 (optional) | Spike On-Device-Whisper mit Messprotokoll auf Zielgeraeten | 1 PT |

Gesamt Kern (D1–D3): ~5–8 PT.

## Reihenfolge mit Offline-Plan

1. **O1 + O2** (Offline-Fundament + Outbox) – ohne sie nuetzt das beste Diktat im Keller nichts.
2. **D1 + D2** – Diktat + Felderkennung, vollstaendig offline-faehig.
3. **O3** (Haertung) parallel zu **D3** (Worker-Transkription).
4. **D4** nach Messwerten entscheiden.

## Entscheidungspunkte

1. **Web Speech API (Pfad A) aktivieren?** Empfehlung: nein (Datenschutz, Google-Server). Whisper on-prem deckt alles ab.
2. **Whisper-Modellgroesse im Worker:** small (schnell, gut) vs. medium (besser bei Fachbegriffen, braucht mehr CPU/RAM auf dem VPS). Empfehlung: small starten, medium testen.
3. **Spike D4 (On-Device-Whisper) einplanen?** Empfehlung: ja, 1 PT – grosser UX-Gewinn, falls performant.
