# Phases

## Phase 0: Foundation

Goal: clean technical foundation.

Deliverables:

- Project structure.
- Docker Compose.
- Frontend and backend scaffold.
- PostgreSQL connection.
- MVP migrations.
- Seed data:
  - roles
  - example location
  - example building
  - example rooms
  - object classes
  - field requirement profiles
  - accounting profiles
- Base look and feel:
  - layout
  - colors
  - buttons
  - status badges
  - cards
- Auth base structure.
- API base structure.
- Upload folder structure.
- README and smoke checks.

## Phase 1: Real Room MVP

Goal: a real room test is possible.

Deliverables:

- Login.
- Start room session.
- Generate QR code for session.
- Join phone by QR token.
- Mobile capture:
  - object photo
  - QR/barcode scan placeholder
  - manual inventory ID generation
  - voice note
  - optional nameplate photo
  - optional DOT photo
  - upload status
- Store object in database.
- Reviewer dashboard with live data.
- AI job creation.
- Speech transcription path.
- AI suggestion stored as JSON.
- Field requirements checked by object class.
- Rework tasks generated.
- Accounting profile applied automatically.
- Reviewer can correct data.
- Reviewer can approve/finalize.
- Finalization locks item.
- Room close checks open blockers.
- Excel export.
- Audit log.
- VPS deployment prepared through Compose.

## Phase 1.5: Hardening

Do not build unless requested.

Planned work:

- Upload queue with retry.
- Better error states.
- Real role enforcement.
- Session/device revoke hardening.
- Backup workflow.
- Simple duplicate warning.
- Robust file serving and signed URLs.
- Safer auth and token handling.

## Phase 2: Business Expansion

Do not build unless requested.

Prepared topics:

- Target/actual reconciliation.
- Object class profile editor.
- Commercial follow-up workflow.
- QR labels.
- Advanced duplicate matching.
- Label batches.
- More accounting controls.

Prepared tables:

- `target_inventory_imports`
- `target_inventory_items`
- `item_target_matches`
- `duplicate_candidates`
- `task_items`
- `label_batches`

## Phase 3: Advanced Operations

Do not build unless requested.

Planned topics:

- Full offline mode.
- NFC.
- Maintenance deadlines.
- PDF reports.
- Four-eyes principle.
- DMS/Paperless/n8n integrations.
- DATEV/controlling exports.

## Scope Rule

When implementing, keep the smallest useful scope for the current phase. Architecture may prepare later work, but UI and behavior should not expose unfinished Phase 2/3 complexity.
