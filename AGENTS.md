# Codex Project Rules

## Product Principle

This app is a fast, AI-assisted inventory capture machine for car dealerships and multi-location operations.

Primary rule: the real room process must be fast.

- Phone: capture quickly with photo, code scan and voice.
- iPad/Laptop: review, correct and approve.
- AI: prefill structured suggestions and identify missing data.
- Human: makes final decisions.
- System: records audit trail, evidence and export history.

Do not turn the mobile flow into an accounting form. Bookkeeping and unclear commercial details become rework tasks.

## Current Stack

- Frontend: Next.js PWA, TypeScript, CSS/Tailwind-compatible styling.
- Backend: FastAPI REST API.
- Live updates: polling and SSE endpoint in Phase 1.
- Database: PostgreSQL.
- Queue: Redis plus worker placeholder.
- AI gateway: LiteLLM prepared, Phase 1 uses deterministic JSON stub.
- Upload storage: `/opt/inventar/uploads` in Docker, `storage/uploads` locally.
- Deployment: Docker Compose.

## Repo Map

- `apps/web`: Next.js frontend.
- `apps/api`: FastAPI backend.
- `db/migrations`: SQL migrations.
- `db/seeds`: seed data.
- `storage/uploads`: local upload folder structure.
- `docs`: project architecture and acceptance docs.
- `scripts/smoke-check.mjs`: structural smoke check.

## Scope Discipline

Always identify the phase before implementing.

- Phase 0: architecture, scaffold, base structure, data model.
- Phase 1: real room MVP.
- Phase 1.5: hardening.
- Phase 2: target/actual reconciliation, labels, accounting expansion.
- Phase 3: offline, NFC, DMS, DATEV, advanced reporting.

Do not implement Phase 2 or Phase 3 features unless the user explicitly asks. It is fine to keep schema and interfaces ready.

## Engineering Rules

- Keep mobile capture fast and low-friction.
- Keep API errors explicit and safe.
- Use `.env` values; do not hardcode secrets.
- Preserve migration and seed integrity when changing data model.
- Add audit entries for state-changing user actions.
- AI output must be structured JSON, never the final source of truth.
- Finalized items are locked; changes require reason and permission in later hardening.
- Run `npm run smoke` and `npm run build` after changes that affect code or structure.

## UI Rules

- No landing page unless requested.
- First screen is a working dashboard.
- Mobile capture has three main actions: photo, code scan, voice.
- Use large buttons, clear status badges, short labels.
- Avoid long mobile forms.
- Use industrial, calm, inspection-safe styling.
- Status must be visible immediately.

## Required References

Read these before substantial changes:

- `docs/MASTER_ARCHITECTURE.md`
- `docs/PHASES.md`
- `docs/DATA_MODEL.md`
- `docs/UI_GUIDELINES.md`
- `docs/ROOM_TEST_V01.md`
