# Inventar Maschine

KI-gestÃ¼tzte Inventur-App fÃ¼r Autohaus-Standorte. Das System trennt den schnellen Vor-Ort-Prozess vom Prüf- und Buchhaltungsprozess:

- Handy: Foto, Code, Sprache.
- iPad/Laptop: prüfen, korrigieren, freigeben.
- KI: strukturierte Vorschlaege und Hinweise.
- Mensch: finale Entscheidung.
- System: Audit, Nachweisbilder, Export.

## Projektregeln und Dokumentation

Folgeaufgaben sollen zuerst diese Dateien lesen:

- [AGENTS.md](AGENTS.md): Codex-Regeln, Scope-Disziplin und Arbeitsweise.
- [docs/MASTER_ARCHITECTURE.md](docs/MASTER_ARCHITECTURE.md): Zielarchitektur und Systembild.
- [docs/PHASES.md](docs/PHASES.md): Phasenlogik und Scope-Grenzen.
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md): Tabellen, Statuswerte und Seed-Struktur.
- [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md): UI-Regeln für mobile Erfassung und Prüfung.
- [docs/ROOM_TEST_V01.md](docs/ROOM_TEST_V01.md): Raumtest und Akzeptanzkriterien.
- [docs/SPECIAL_TOOL_KNOWLEDGE.md](docs/SPECIAL_TOOL_KNOWLEDGE.md): Spezialwerkzeug-Wissensbasis aus alten Inventar-/Werkzeuglisten.

## Umgesetzter Scope

Phase 0:

- Monorepo-Struktur mit `apps/web`, `apps/api`, `db`, `storage/uploads`.
- Next.js PWA-Grundgeruest mit industriellem Look & Feel.
- FastAPI Backend mit REST API.
- Docker Compose mit PostgreSQL, Redis, API, Web, Worker sowie optional LiteLLM und Uptime Kuma.
- PostgreSQL-Migrationen fÃ¼r MVP- und vorbereitende Phase-2-Tabellen.
- Seed-Daten fÃ¼r Rollen, Standort, GebÃ¤ude, RÃ¤ume, Objektklassen, Pflichtfelder und Buchhaltungsprofile.
- Uploadordner: `originals`, `stamped`, `audio`, `exports`, `temp`.
- README und Smoke-Check.

Phase 1:

- Demo-Login API.
- Raum-Session starten.
- Join-Token und QR-Code im Frontend.
- Mobile Kopplung per Join-Link.
- Mobile Erfassung mit drei Hauptaktionen: Foto, Code, Sprache.
- Objektanlage in PostgreSQL.
- Live-PrÃ¼feransicht per Polling und SSE-Endpunkt.
- KI-Job-Stub mit strukturierter JSON-Ausgabe fÃ¼r Monitor/Reifen/HebebÃ¼hne.
- Pflichtfeld-/Blockerlogik.
- Nacharbeitsaufgaben.
- Buchhaltungs-Vorprofil.
- Korrektur, Statuswechsel, Finalisierung mit Sperre.
- Raumabschluss mit Blocker-PrÃ¼fung.
- Excel-Export.
- Audit-Log fÃ¼r Kernaktionen.

Nicht gebaut:

- Voller Offline-Modus.
- NFC.
- DATEV/SKR51-Vollintegration.
- Vollstaendiger Soll-Ist-Abgleich.
- DMS/Paperless/n8n.
- Vier-Augen-Prinzip.
- Perfekte Dubletten-KI.

Diese Themen sind durch Tabellen, Worker und Service-Struktur vorbereitet.

## Annahmen

- Es gab im Repo keine `AGENTS.md` und keinen `/docs`-Ordner. Die Anforderungen aus dem Chat sind daher fuehrend.
- Backend wurde mit FastAPI umgesetzt, weil es für den MVP schneller und gut testbar ist.
- Die Phase-1-KI ist ein deterministischer Stub. Er speichert bereits das geforderte JSON-Format und ist so vorbereitet, dass LiteLLM im Worker angebunden wird.
- Mobile Foto-/Audioaufnahme ist im UI als Prozess angelegt. Die Upload-Endpunkte existieren; echte Kamera-/Mikrofonintegration und Retry-Queue gehoeren zur Haertung.
- Der Excel-Export nutzt `openpyxl`.
- Buchhaltung blockiert die schnelle Erfassung nicht. Sie blockiert nur kaufmännische Nacharbeit/Freigabe, wenn später entsprechend konfiguriert.

## Start mit Docker Compose

```powershell
docker compose up --build
```

Danach:

- Web: http://localhost:3000
- API: http://localhost:8000/health
- API Docs: http://localhost:8000/docs

PostgreSQL wird beim ersten Start mit Migration und Seeds initialisiert. Wenn der Docker-Volume schon existiert, vorher bewusst loeschen:

```powershell
docker compose down -v
docker compose up --build
```

Healthcheck mit laufender DB:

```powershell
Invoke-WebRequest http://localhost:8000/health -UseBasicParsing
```

Erwartung:

```json
{"ok":true,"database":true,"phase":"0+1"}
```

## Lokaler Start ohne Docker

Voraussetzungen:

- Node.js 24+
- Python 3.14+
- PostgreSQL 17+

```powershell
copy .env.example .env
npm install
pip install -r apps/api/requirements.txt
```

PostgreSQL-Benutzer und Datenbank anlegen, falls noch nicht vorhanden:

```powershell
$env:PGPASSWORD="postgres"
.\scripts\db-bootstrap.ps1
```

Migrationen und Seeds wiederholbar einspielen:

```powershell
$env:DATABASE_URL="postgresql://inventar:inventar@localhost:5432/inventar"
npm run db:reset
```

API starten:

```powershell
$env:DATABASE_URL="postgresql://inventar:inventar@localhost:5432/inventar"
$env:UPLOAD_ROOT="$PWD\storage\uploads"
python -m uvicorn app.main:app --app-dir apps/api --reload --port 8000
```

Web starten:

```powershell
$env:NEXT_PUBLIC_API_URL="http://localhost:8000"
npm run dev
```

Healthcheck:

```powershell
Invoke-WebRequest http://localhost:8000/health -UseBasicParsing
```

Mit laufender PostgreSQL-Datenbank muss `database:true` enthalten sein.

## Raumtest

Das genaue Protokoll steht in [docs/ROOM_TEST_V01.md](docs/ROOM_TEST_V01.md).

Kurzfassung:

1. DB mit `npm run db:reset` initialisieren.
2. API und Web starten.
3. http://localhost:3000 Ã¶ffnen.
4. Raum wÃ¤hlen und Session starten.
5. QR-Code oder Link `/mobile/join/{token}` mit Handy Ã¶ffnen.
6. Monitor, Reifen und HebebÃ¼hne mit Objektfoto, Evidence-Foto und Sprachnotiz erfassen.
7. PrÃ¼feransicht Ã¶ffnen und alle Objekte sehen.
8. Monitor finalisieren.
9. Raumabschluss testen; Reifen/HebebÃ¼hne zeigen offene Pflichtpunkte.
10. Excel-Export erzeugen.

## Demo-Accounts

- `pruefer@example.local` / `demo`
- `erfasser@example.local` / `demo`
- `buchhaltung@example.local` / `demo`

Die Weboberflaeche verwendet aktuell noch keinen echten Token-Schutz. Die API stellt die Auth-Grundstruktur bereit.

## API-Auszug

- `POST /auth/login`
- `POST /sessions`
- `POST /sessions/join`
- `POST /items`
- `POST /items/{id}/photos`
- `POST /items/{id}/audio`
- `POST /items/{id}/ai/run`
- `POST /items/{id}/finalize`
- `POST /sessions/{id}/close`
- `POST /sessions/{id}/export/excel`
- `GET /sessions/{id}/events`

## Checks

```powershell
npm run smoke
npm run build
npm run db:reset
python -m py_compile apps/api/app/main.py apps/api/app/db.py apps/api/app/logic.py apps/api/app/settings.py
```

## Naechste technische Schritte

1. Echte Kamera-, Barcode- und Audioaufnahme in der PWA anbinden.
2. Upload-Queue mit Retry und Offline-Puffer fÃ¼r Phase 1.5.
3. Worker an Redis und LiteLLM anbinden.
4. Bildstempel wirklich rendern statt Phase-1-Kopie.
5. Rollenprüfung und Session-Token absichern.
6. Deployment-Profile fÃ¼r VPS, NPM und Backup ergÃ¤nzen.
