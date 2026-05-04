# Master Architecture

## Purpose

Inventar Maschine is not a simple inventory list. It is an AI-assisted capture and review system for physical inventory in a car dealership environment.

The app optimizes for speed in real rooms:

- Capture fast on phone.
- Review and finalize on tablet or laptop.
- Use AI for prefill and hints.
- Keep humans responsible for decisions.
- Keep all important changes auditable.

## Core Flow

1. Reviewer starts a room session.
2. System creates a temporary join token and QR code.
3. Capturer scans the QR code with phone.
4. Phone joins the session with capture rights.
5. Capturer records room/object evidence.
6. Backend stores item, photos/audio and audit events.
7. AI creates a structured JSON suggestion.
8. Reviewer sees the item live.
9. Reviewer corrects, requests rework or finalizes.
10. Room can close only if blocking requirements are complete.
11. Excel export is generated and logged.

## Architecture

```text
Phone PWA
  photo / code / voice
        |
        v
FastAPI Backend
  auth / sessions / uploads / items
        |
        v
PostgreSQL
  master data / items / status / audit
        |
        v
Upload Storage
  originals / stamped / audio / exports / temp
        |
        v
Redis Queue + Worker
  AI / stamping / export / duplicates / rework
        |
        v
LiteLLM
  vision / speech / structured JSON
        |
        v
SSE / polling
        |
        v
iPad / Laptop
  review / approval / room close / export
```

## Components

### Frontend

- Next.js PWA in `apps/web`.
- Mobile-first capture view.
- Desktop/tablet reviewer view.
- Industrial look, large controls, status badges.

### Backend

- FastAPI in `apps/api`.
- REST endpoints for auth, sessions, devices, items, uploads, AI, accounting, exports and audit.
- SSE endpoint for live session events.
- Phase 1 AI is deterministic stub; LiteLLM is prepared through worker service.

### Database

- PostgreSQL.
- SQL migrations in `db/migrations`.
- Seed data in `db/seeds`.
- Data model includes Phase 0/1 tables and Phase 2 preparation tables.

### Queue And AI

- Redis service exists in Compose.
- Worker placeholder exists in `apps/api/app/worker.py`.
- Future worker responsibilities:
  - LiteLLM calls.
  - Speech transcription.
  - Vision analysis.
  - Evidence image stamping.
  - Export jobs.
  - Duplicate detection.
  - Rework task generation.

### Upload Storage

Docker path:

```text
/opt/inventar/uploads
```

Local path:

```text
storage/uploads
```

Required folders:

- `originals`
- `stamped`
- `audio`
- `exports`
- `temp`

Original images must remain unchanged. Stamped evidence versions are separate files.

## Deployment

`docker-compose.yml` defines:

- `postgres`
- `redis`
- `api`
- `web`
- `worker`
- optional `litellm`
- optional `uptime-kuma`

Reverse proxy is expected through NPM/Nginx Proxy Manager in later deployment work.

## Non-Negotiables

- Capture must not block on AI failure.
- Items remain visible if AI fails.
- Accounting must not slow down phone capture.
- Finalization is blocked only by configured blocking requirements.
- Every meaningful state change belongs in `audit_log`.
