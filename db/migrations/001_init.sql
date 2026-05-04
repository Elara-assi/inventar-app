CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL DEFAULT 'demo',
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE buildings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (location_id, code)
);

CREATE TABLE rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id UUID NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  room_type TEXT NOT NULL DEFAULT 'workspace',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (building_id, code)
);

CREATE TABLE object_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  default_commercial_category TEXT NOT NULL DEFAULT 'ungeklaert',
  requires_nameplate BOOLEAN NOT NULL DEFAULT false,
  requires_serial_number BOOLEAN NOT NULL DEFAULT false,
  requires_accounting_review BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounting_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_class_id UUID NOT NULL REFERENCES object_classes(id) ON DELETE CASCADE,
  default_commercial_category TEXT NOT NULL,
  default_skr51_account TEXT,
  default_cost_center TEXT,
  requires_accounting_check BOOLEAN NOT NULL DEFAULT false,
  requires_asset_number BOOLEAN NOT NULL DEFAULT false,
  requires_book_value BOOLEAN NOT NULL DEFAULT false,
  requires_acquisition_date BOOLEAN NOT NULL DEFAULT false,
  blocks_commercial_finalization BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (object_class_id)
);

CREATE TABLE field_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_class_id UUID NOT NULL REFERENCES object_classes(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  field_label TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  blocks_finalization BOOLEAN NOT NULL DEFAULT true,
  evidence_required BOOLEAN NOT NULL DEFAULT false,
  evidence_photo_type TEXT,
  source_type TEXT NOT NULL DEFAULT 'human_or_ai',
  rework_allowed BOOLEAN NOT NULL DEFAULT true,
  responsible_role TEXT NOT NULL DEFAULT 'Prüfer',
  sort_order INTEGER NOT NULL DEFAULT 100,
  UNIQUE (object_class_id, field_name)
);

CREATE TABLE inventory_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  building_id UUID NOT NULL REFERENCES buildings(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  status TEXT NOT NULL DEFAULT 'open',
  join_token TEXT NOT NULL UNIQUE,
  join_token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '12 hours'),
  started_by UUID REFERENCES users(id),
  closed_by UUID REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  device_fingerprint TEXT,
  role_slug TEXT NOT NULL DEFAULT 'erfasser',
  joined_by UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_id TEXT UNIQUE,
  temporary_id TEXT UNIQUE,
  session_id UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id),
  building_id UUID NOT NULL REFERENCES buildings(id),
  room_id UUID NOT NULL REFERENCES rooms(id),
  object_type TEXT,
  object_class_id UUID REFERENCES object_classes(id),
  category TEXT,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  condition TEXT NOT NULL DEFAULT 'gebraucht',
  condition_note TEXT,
  value_estimate NUMERIC(12,2),
  responsible_user_id UUID REFERENCES users(id),
  cost_center TEXT,
  status TEXT NOT NULL DEFAULT 'hochgeladen',
  review_status TEXT NOT NULL DEFAULT 'erfasst',
  lifecycle_status TEXT NOT NULL DEFAULT 'neu_gefunden',
  confidence_score NUMERIC(4,3),
  age_source TEXT NOT NULL DEFAULT 'unbekannt',
  age_verification_status TEXT NOT NULL DEFAULT 'offen',
  manufacturing_date DATE,
  acquisition_date DATE,
  commissioning_date DATE,
  estimated_age_years NUMERIC(5,2),
  commercial_category TEXT NOT NULL DEFAULT 'ungeklaert',
  accounting_relevance BOOLEAN NOT NULL DEFAULT false,
  accounting_status TEXT NOT NULL DEFAULT 'offen',
  requires_accounting_review BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id),
  reviewed_by UUID REFERENCES users(id),
  finalized_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ
);

CREATE INDEX idx_inventory_items_session ON inventory_items(session_id);
CREATE INDEX idx_inventory_items_review ON inventory_items(review_status);

CREATE TABLE item_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  photo_type TEXT NOT NULL,
  original_path TEXT NOT NULL,
  stamped_path TEXT,
  original_hash TEXT,
  width INTEGER,
  height INTEGER,
  uploaded_by UUID REFERENCES users(id),
  taken_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ai_processed BOOLEAN NOT NULL DEFAULT false,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE item_audio_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  audio_path TEXT NOT NULL,
  transcript TEXT,
  transcript_status TEXT NOT NULL DEFAULT 'pending',
  uploaded_by UUID REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  ai_type TEXT NOT NULL,
  model_used TEXT NOT NULL,
  prompt_version TEXT NOT NULL DEFAULT 'phase1-stub-v1',
  input_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_json JSONB NOT NULL,
  confidence NUMERIC(4,3),
  status TEXT NOT NULL DEFAULT 'completed',
  error_message TEXT,
  cost_estimate NUMERIC(10,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounting_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  assigned_role TEXT NOT NULL,
  assigned_user_id UUID REFERENCES users(id),
  missing_field TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE item_accounting_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL UNIQUE REFERENCES inventory_items(id) ON DELETE CASCADE,
  commercial_category TEXT NOT NULL DEFAULT 'ungeklaert',
  skr51_account TEXT,
  cost_center TEXT,
  cost_object TEXT,
  department TEXT,
  asset_number TEXT,
  acquisition_date DATE,
  acquisition_value NUMERIC(12,2),
  book_value NUMERIC(12,2),
  depreciation_method TEXT,
  accounting_status TEXT NOT NULL DEFAULT 'offen',
  confirmed_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ
);

CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  export_type TEXT NOT NULL DEFAULT 'excel',
  file_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  action TEXT NOT NULL,
  old_value_json JSONB,
  new_value_json JSONB,
  reason TEXT,
  user_id UUID REFERENCES users(id),
  device_id UUID REFERENCES session_devices(id),
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE target_inventory_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  file_path TEXT,
  status TEXT NOT NULL DEFAULT 'prepared',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE target_inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id UUID REFERENCES target_inventory_imports(id) ON DELETE CASCADE,
  inventory_id TEXT,
  object_type TEXT,
  room_hint TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE item_target_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  target_item_id UUID REFERENCES target_inventory_items(id) ON DELETE CASCADE,
  match_score NUMERIC(4,3),
  status TEXT NOT NULL DEFAULT 'candidate'
);

CREATE TABLE duplicate_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  candidate_item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  score NUMERIC(4,3),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE task_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES inventory_items(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE label_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),
  status TEXT NOT NULL DEFAULT 'prepared',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
