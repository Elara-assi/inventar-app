CREATE TABLE IF NOT EXISTS damage_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  client_report_id TEXT NOT NULL,
  source_device_id TEXT,
  article_no TEXT NOT NULL,
  nr TEXT,
  buchungskreis TEXT,
  anlagenbezeichnung TEXT,
  aktivdatum TEXT,
  alter NUMERIC(8,2),
  team_name TEXT NOT NULL,
  damage_description TEXT NOT NULL DEFAULT '',
  uvv_sticker_present TEXT NOT NULL DEFAULT 'unklar',
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_damage_reports_tenant_article
  ON damage_reports(COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), article_no);

CREATE UNIQUE INDEX IF NOT EXISTS idx_damage_reports_client
  ON damage_reports(COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), source_device_id, client_report_id)
  WHERE source_device_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_damage_reports_updated
  ON damage_reports(updated_at DESC);

CREATE TABLE IF NOT EXISTS damage_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id),
  damage_report_id UUID NOT NULL REFERENCES damage_reports(id) ON DELETE CASCADE,
  client_photo_id TEXT,
  source_device_id TEXT,
  photo_type TEXT NOT NULL,
  original_path TEXT NOT NULL,
  original_hash TEXT,
  width INTEGER,
  height INTEGER,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_damage_photos_report_type
  ON damage_photos(damage_report_id, photo_type);

CREATE UNIQUE INDEX IF NOT EXISTS idx_damage_photos_client
  ON damage_photos(damage_report_id, source_device_id, client_photo_id)
  WHERE source_device_id IS NOT NULL AND client_photo_id IS NOT NULL;
