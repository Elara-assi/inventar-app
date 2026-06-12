# Plan: Offline-Modus (Offline-First-Erfassung)

Stand: 2026-06-12. Status: UMGESETZT (O1+O2+O3-Kern bzw. D1-D3; siehe README Phase 2). On-Device-Whisper (D4) offen.

## Ziel und Prinzip

Die mobile Erfassung funktioniert zu 100 % ohne Netz – auch unter Volllast (ganzer Kellerraum, hunderte Objekte, mehrere Erfasser). Kein einziger Datensatz geht verloren, und der Erfasser sieht jederzeit, was lokal gesichert und was uebertragen ist. Vertrauen entsteht durch zwei Regeln:

1. **Lokal zuerst.** Speichern schreibt IMMER zuerst auf das Geraet (IndexedDB). Das dauert < 100 ms und fuehlt sich mit und ohne Netz identisch an. Der Server-Upload ist ein Hintergrundprozess.
2. **Sichtbarkeit statt Hoffnung.** Jedes Objekt hat einen sichtbaren Zustand: lokal gesichert -> wird uebertragen -> auf Server bestaetigt. Nie ein stiller Fehler.

## Architektur

```
Wizard ──speichert──> IndexedDB (Outbox)  ──Sync-Engine──> API
                      │  CaptureRecord:                    │
                      │  Felder + Fotos/Audio als Blobs    │ idempotent via
                      │  + client_capture_id (UUID)        │ client_capture_id
App-Shell <──precache── Service Worker
Stammdaten <──Cache──── bootstrap + field_requirements (beim Join geladen)
```

### 1. Service Worker / App-Shell

- **Serwist** (`@serwist/next`, gepflegter Workbox-Nachfolger fuer Next.js App Router): Precache aller statischen Assets + Wizard-Route. Die App laedt offline, auch nach Reload oder Geraete-Neustart im Keller.
- Update-Disziplin gegen Stale-Cache-Chaos: SW-Versionierung, neue Version aktiviert sich erst nach Hinweis "Update verfuegbar – neu laden". Niemals API-Antworten im SW cachen (nur App-Shell); strukturierte Daten liegen in IndexedDB.
- PWA-Installation ("Zum Home-Bildschirm") wird Team-Standard: stabilerer Speicher (v. a. iOS), Vollbild, eigenes Icon.

### 2. Lokale Datenhaltung (IndexedDB)

- **Stammdaten-Cache:** Beim Join werden bootstrap + field_requirements aller Klassen geladen und persistiert (mit Zeitstempel). Der Wizard braucht danach keine API mehr – Klassen-Kacheln und Pflicht-Nachweise kommen aus dem Cache.
- **Session-Kontext** persistiert (Session-ID, Join-Status): Browser-Reload oder App-Kill mitten im Raum -> Wizard startet nahtlos weiter.
- **Outbox:** Ein abgeschlossener Wizard-Durchlauf = ein `CaptureRecord` (alle Felder, Fotos/Audio als Blobs, lokale TEMP-ID, `client_capture_id` als UUID, Teilfortschritt des Uploads). Schreiben atomar in einer IndexedDB-Transaktion – App-Kill mitten im Speichern hinterlaesst keinen halben Datensatz.
- **Speicherbudget:** `navigator.storage.persist()` anfordern (Schutz vor Eviction), Foto-Kompression clientseitig (max. 1600 px, ~300–500 KB) -> 500 Objekte x 3 Fotos ~ 0,5–0,7 GB, weit unter Quota. Warnung ab 80 % Belegung mit Anzeige "Jetzt synchronisieren".

### 3. Sync-Engine

- **Trigger:** `online`-Event, App sichtbar, Timer (30 s), manueller Button. (iOS hat kein Background Sync – Sync laeuft bei geoeffneter App; dokumentiert und ausreichend.)
- **Ablauf pro Record:** POST /items -> Fotos -> Audio, exakt die heutige Retry-Pipeline, nur persistent: Teilfortschritt steht im Record, ein Abbruch setzt beim naechsten Versuch dort fort.
- **Idempotenz (der kritische Punkt):** Neue Spalte `client_capture_id UUID UNIQUE` auf `inventory_items` (Migration 003). Bricht das Netz NACH dem Server-Commit, aber VOR der Client-Bestaetigung ab, erzeugt der erneute Sync keine Dublette – der Server erkennt die ID und liefert das bestehende Item zurueck. Fotos analog ueber `UNIQUE (item_id, original_hash)`.
- **Inventar-IDs:** vergibt weiterhin der Server beim Sync (atomare Zaehlertabelle, bereits gebaut). Offline zeigt das Geraet die TEMP-ID. Keine ID-Konflikte zwischen Geraeten moeglich.
- **Fehlerklassen:** Netz/5xx -> exponentieller Retry, unbegrenzt. Fachlich/4xx (z. B. Session inzwischen geschlossen) -> Record geht in **Quarantaene** mit sichtbarem Grund und manueller Aktion, wird NIE verworfen.

### 4. Vertrauens-UI

- Kopfzeile im Wizard: Online/Offline-Punkt + "12 erfasst · 3 warten auf Uebertragung".
- Outbox-Ansicht: wartende Objekte mit Thumbnail, Status, Fehlergrund, "Erneut senden".
- Pruefansicht: je gekoppeltem Geraet letzter Kontakt + ausstehende Anzahl ("Handy 1: 3 ausstehend, zuletzt 14:32") ueber leichtgewichtigen Heartbeat, sobald online.
- Raumabschluss warnt, wenn Geraete kuerzlich aktiv waren, aber noch nicht alles gesynct haben.

### 5. Abnahmekriterien "100 % unter Volllast"

| Kriterium | Messlatte |
|---|---|
| Offline-Durchsatz | 500 Objekte am Stueck ohne Netz erfassbar, UI-Feedback je Speicherung < 100 ms |
| Datensicherheit | App-Kill / Akku leer / Reload mitten im Speichern: kein Datenverlust, kein halber Datensatz (Kill-Tests) |
| Doppel-Sync | Netzabbruch waehrend Sync, danach erneut: keine Dubletten (Idempotenz-Test) |
| Sync-Leistung | 500 Objekte inkl. Fotos < 15 min ueber LTE, fortsetzbar nach Abbruch |
| Wiederanlauf | Geraete-Neustart im Keller: App laedt offline, Session und Outbox intakt |
| Speicher | Quota-Warnung funktioniert; persist() aktiv; iOS-PWA ueberlebt 7+ Tage ohne Nutzung |

Testaufbau: Chrome DevTools (offline/throttling), zwei echte Geraete (Android Mittelklasse, iPhone), Kill-Tests, Dublettentest gegen lokale API.

## Etappen und Aufwand

| Etappe | Inhalt | Aufwand |
|---|---|---|
| O1 Fundament | Serwist-SW, App-Shell offline, Stammdaten-/Session-Cache, Online/Offline-Anzeige | 2–3 PT |
| O2 Outbox + Sync | IndexedDB-Records, lokaler Speicherpfad im Wizard, Sync-Engine, Migration 003 (client_capture_id, Foto-Hash-Unique), Outbox-UI | 4–6 PT |
| O3 Haertung | Foto-Kompression, Quota-Management, Quarantaene-Faelle, Geraete-Status beim Pruefer, Kill-/Lasttests, iOS-Feinschliff | 3–4 PT |

Gesamt: ~9–13 PT. O1+O2 liefern den nutzbaren Offline-Modus; O3 macht ihn revisionsfest.

## Entscheidungspunkte

1. **Session waehrend Offline-Phase geschlossen:** Empfehlung: Pruefer kann Raum per "Wieder oeffnen" reaktivieren, Quarantaene-Records syncen dann nach. Alternative: Nacherfassungs-Flag am Item.
2. **PWA-Installation als Team-Standard:** Empfehlung: ja (stabilerer Speicher, v. a. iOS).
3. **Foto-Aufloesung:** 1600 px Kompromiss aus Lesbarkeit (Typenschild) und Speicher/Synczeit – ok?
