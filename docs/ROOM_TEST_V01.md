# Room Test V01

## Goal

Validate that a real room inventory test can be performed quickly with the Phase 1 MVP.

The test proves:

- reviewer can start a session.
- phone can join.
- capturer can create objects quickly.
- reviewer sees objects live.
- AI stub creates structured suggestions.
- required fields and rework are visible.
- room close blocks on open blockers.
- Excel export is created.
- audit log receives events.

## Preconditions

Use Docker:

```powershell
docker compose up --build
```

Or local PostgreSQL mode:

```powershell
$env:DATABASE_URL="postgresql://inventar:inventar@localhost:5432/inventar"
$env:UPLOAD_ROOT="$PWD\storage\uploads"
npm run db:reset
python -m uvicorn app.main:app --app-dir apps/api --reload --port 8000
```

In a second terminal:

```powershell
$env:NEXT_PUBLIC_API_URL="http://localhost:8000"
npm run dev
```

Healthcheck:

```powershell
Invoke-WebRequest http://localhost:8000/health -UseBasicParsing
```

Expected:

```json
{"ok":true,"database":true,"phase":"0+1"}
```

## Demo Accounts

- Reviewer: `SAH` / `!Scherer!`
- Capturer: `erfasser@example.local` / `demo`
- Accounting: `buchhaltung@example.local` / `demo`

## Test Scenario

### 1. Start Session

1. Open `http://localhost:3000`.
2. Select room `Serviceannahme`, `Werkstatt 1` or `Reifenlager`.
3. Start session.
4. Confirm QR code appears.
5. Open reviewer session view.

Expected:

- session exists in backend.
- join token exists.
- QR code points to `/mobile/join/{token}`.

### 2. Join Phone

1. Open QR link on phone or browser.
2. Confirm mobile view shows room/session context.

Expected:

- device is recorded in `session_devices`.
- audit event `device_joined` is recorded.

### 3. Capture Monitor

Mobile input:

```text
Dell Monitor, Serviceannahme, Zustand gut
```

Actions:

1. Select object class Monitor.
2. Select or take an object photo.
3. Press `Foto`.
4. Press `Code scannen` and confirm inventory ID appears.
5. Enter the text above as the voice note.
6. Press `Sprache aufnehmen`.

Expected:

- item is created.
- object photo row exists in `item_photos`.
- file exists under `storage/uploads/originals`.
- temporary/inventory ID exists.
- AI result JSON contains Monitor/Dell hints.
- review status becomes `nacharbeit_buchhaltung`.
- accounting follow-up tasks exist for asset data such as acquisition date/book value.
- capturer was not asked for bookkeeping fields.

### 4. Reviewer Checks Monitor

1. Open session reviewer view.
2. Confirm item card appears.
3. Confirm status badge is visible.
4. Correct fields if needed.
5. Set condition/status if needed.
6. Finalize Monitor.

Expected:

- reviewer can see item quickly.
- accounting rework is clear.
- item remains visible even if AI is incomplete.
- Monitor can be finalized after object photo and condition are present.
- accounting follow-up does not block physical finalization.

### 5. Capture Reifen

Mobile input:

```text
Michelin Sommerreifen, DOT 3822, Zustand gut
```

Actions:

1. Select object class Reifen.
2. Select or take an object photo.
3. Press `Foto`.
4. Select or take DOT photo.
5. Press `DOT-Foto`.
6. Enter the text above as the voice note.
7. Press `Sprache aufnehmen`.

Expected:

- AI result JSON contains Reifen.
- DOT `3822` is parsed.
- production week `38` and production year `2022` are present.
- age source is `dot`.
- missing Profiltiefe creates rework.
- finalization is blocked until Profiltiefe is handled.

### 6. Capture Hebebühne

Mobile input:

```text
Nussbaum Hebebühne, Werkstattplatz 4, Zustand gut
```

Actions:

1. Select object class Hebebühne.
2. Select or take object photo.
3. Press `Foto`.
4. Select or take Typenschild photo.
5. Press `Typenschildfoto`.
6. Enter the text above as the voice note.
7. Press `Sprache aufnehmen`.

Expected:

- AI result JSON contains Hebebühne.
- brand hint `Nussbaum` is stored when detected.
- Typenschild evidence is stored.
- missing serial number and load capacity block finalization.

### 7. Room Close

1. Try to close room with open blockers.

Expected:

- close request is rejected with blocking missing requirements.
- UI shows that room cannot close yet.
- Reifen blocker includes Profiltiefe.
- Hebebühne blockers include Seriennummer and Tragfähigkeit.

### 8. Resolve And Finalize

1. Add or correct missing evidence/required data for one object.
2. Finalize eligible Monitor.
3. Confirm item locks.

Expected:

- finalization only works without blockers.
- status becomes `finalisiert`.
- `locked_at` is set.
- audit event exists.

### 9. Export

1. Trigger Excel export.
2. Download export through API.

Expected:

- `.xlsx` file is written under uploads exports.
- `exports` row exists.
- audit event `export_created` exists.

### 10. Audit Check

Query or inspect the API audit endpoints:

```powershell
Invoke-WebRequest http://localhost:8000/sessions/{sessionId}/audit-log -UseBasicParsing
```

Expected actions:

- `session_started`
- `device_joined`
- `item_created`
- `photo_uploaded`
- `audio_saved`
- `ai_result_created`
- `item_changed` or `status_changed`
- `item_finalized`
- `export_created`

## Acceptance Criteria

The MVP passes Room Test V01 when:

- a reviewer can start a room session.
- a phone can join by QR link.
- monitor and tire examples can be captured.
- reviewer sees live data.
- AI JSON suggestions are stored.
- missing required fields become visible.
- accounting data does not slow mobile capture.
- finalization respects blockers.
- room close respects blockers.
- Excel export exists.
- audit log records the important steps.
