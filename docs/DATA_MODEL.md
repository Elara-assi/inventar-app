# Data Model

## Migration Source

The canonical migration is:

```text
db/migrations/001_init.sql
```

Seed source:

```text
db/seeds/001_seed.sql
```

## Core Tables

- `users`
- `roles`
- `user_roles`
- `locations`
- `buildings`
- `rooms`
- `inventory_sessions`
- `session_devices`
- `inventory_items`
- `item_photos`
- `item_audio_notes`
- `ai_results`
- `audit_log`
- `exports`
- `object_classes`
- `field_requirements`
- `accounting_profiles`
- `accounting_tasks`
- `item_accounting_data`

## Prepared Phase 2 Tables

- `target_inventory_imports`
- `target_inventory_items`
- `item_target_matches`
- `duplicate_candidates`
- `task_items`
- `label_batches`

## Important Entity Notes

### inventory_items

Represents the physical object being captured and reviewed.

Important fields:

- `inventory_id`
- `temporary_id`
- `session_id`
- `location_id`
- `building_id`
- `room_id`
- `object_type`
- `object_class_id`
- `brand`
- `model`
- `serial_number`
- `condition`
- `status`
- `review_status`
- `lifecycle_status`
- `confidence_score`
- `age_source`
- `age_verification_status`
- `manufacturing_date`
- `acquisition_date`
- `commissioning_date`
- `estimated_age_years`
- `commercial_category`
- `accounting_relevance`
- `accounting_status`
- `requires_accounting_review`
- `created_by`
- `reviewed_by`
- `finalized_by`
- `finalized_at`
- `locked_at`

### item_photos

Stores evidence file metadata.

Photo types:

- `room`
- `object`
- `nameplate`
- `condition`
- `dot`
- `other`

Rules:

- `original_path` is immutable evidence.
- `stamped_path` is the generated evidence copy.
- `original_hash` must be retained.
- AI and metadata details go into `metadata_json`.

### item_audio_notes

Stores voice/audio evidence and transcript status.

Transcript statuses should remain simple in Phase 1:

- `pending`
- `completed`
- `failed`

### ai_results

Stores structured AI output.

Rules:

- AI output is JSON.
- AI never finalizes data.
- Reviewer remains final decision maker.

### field_requirements

Defines dynamic requirements per object class.

Important concepts:

- `required`: field is expected.
- `blocks_finalization`: missing value blocks finalization.
- `evidence_required`: requires photo evidence.
- `evidence_photo_type`: photo type required.
- `rework_allowed`: can be handled as follow-up.
- `responsible_role`: who should resolve it.

### accounting_profiles

Maps object classes to commercial defaults.

Accounting data is not shown in the fast mobile capture flow. Missing commercial data creates follow-up tasks.

### accounting_tasks

Represents follow-up work for accounting or reviewers.

Typical missing fields:

- asset number
- acquisition date
- book value
- cost center
- commercial category

### audit_log

Records relevant state changes:

- login
- session started
- device joined
- item created
- photo uploaded
- audio saved
- AI suggestion created
- field changed
- status changed
- rework requested
- accounting changed
- item finalized
- room closed
- export created

## Status Values

### Capture Status

- `lokal_erfasst`
- `upload_laeuft`
- `hochgeladen`
- `ki_wartet`
- `ki_laeuft`
- `ki_fertig`
- `upload_fehler`
- `ki_fehler`
- `nacharbeit_noetig`
- `pruefen`
- `geprueft`
- `finalisiert`
- `gesperrt`

### Review Status

- `erfasst`
- `ki_vorgefuellt`
- `nacharbeit_erfasser`
- `nacharbeit_pruefer`
- `nacharbeit_buchhaltung`
- `nacharbeit_technik`
- `finalisierbar`
- `finalisiert`
- `abweichung`
- `dublette`

### Lifecycle Status

- `aktiv`
- `neu_gefunden`
- `nicht_gefunden`
- `umgezogen`
- `ausser_betrieb`
- `verkauft`
- `verschrottet`
- `verloren`
- `ersetzt`
- `zusammengefuehrt`
- `archiviert`

### Accounting Status

- `nicht_relevant`
- `offen`
- `buchhaltung_pruefen`
- `bestaetigt`
- `abweichung`
- `ausgebucht_pruefen`

## Seeded Object Classes

- Reifen
- Monitor
- Hebebühne
- Werkzeugwagen
- IT-Gerät

## Condition Values

- `neu`
- `sehr_gut`
- `gut`
- `gebraucht`
- `reparaturbeduerftig`
- `defekt`
- `aussondern`

## Commercial Categories

- `anlagevermoegen`
- `gwg_pruefen`
- `betriebsmittel`
- `ware`
- `kundenware`
- `verbrauchsmaterial`
- `it_ausstattung`
- `bueroausstattung`
- `werkstattausstattung`
- `nicht_relevant`
- `ungeklaert`
