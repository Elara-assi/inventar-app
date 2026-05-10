CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  external_system TEXT,
  external_tenant_id TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO tenants (name, slug, external_system, external_tenant_id)
VALUES ('Standardmandant', 'default', NULL, NULL)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  updated_at = now();

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS external_system TEXT,
  ADD COLUMN IF NOT EXISTS external_location_id TEXT;

ALTER TABLE buildings
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS external_system TEXT,
  ADD COLUMN IF NOT EXISTS external_building_id TEXT;

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS external_system TEXT,
  ADD COLUMN IF NOT EXISTS external_room_id TEXT;

ALTER TABLE inventory_sessions
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS external_system TEXT,
  ADD COLUMN IF NOT EXISTS external_session_id TEXT;

ALTER TABLE session_devices
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS pending_items_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pending_photos_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_uploads_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS external_system TEXT,
  ADD COLUMN IF NOT EXISTS external_item_id TEXT;

ALTER TABLE item_photos
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

ALTER TABLE item_audio_notes
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

ALTER TABLE exports
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id),
  ADD COLUMN IF NOT EXISTS request_id TEXT;

UPDATE users SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE locations SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;
UPDATE buildings b SET tenant_id = COALESCE(l.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM locations l
WHERE b.location_id = l.id AND b.tenant_id IS NULL;
UPDATE rooms r SET tenant_id = COALESCE(b.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM buildings b
WHERE r.building_id = b.id AND r.tenant_id IS NULL;
UPDATE inventory_sessions s SET tenant_id = COALESCE(l.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM locations l
WHERE s.location_id = l.id AND s.tenant_id IS NULL;
UPDATE session_devices d SET tenant_id = COALESCE(s.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM inventory_sessions s
WHERE d.session_id = s.id AND d.tenant_id IS NULL;
UPDATE inventory_items i SET tenant_id = COALESCE(s.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM inventory_sessions s
WHERE i.session_id = s.id AND i.tenant_id IS NULL;
UPDATE item_photos p SET tenant_id = COALESCE(i.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM inventory_items i
WHERE p.item_id = i.id AND p.tenant_id IS NULL;
UPDATE item_audio_notes a SET tenant_id = COALESCE(i.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM inventory_items i
WHERE a.item_id = i.id AND a.tenant_id IS NULL;
UPDATE exports e SET tenant_id = COALESCE(s.tenant_id, (SELECT id FROM tenants WHERE slug = 'default'))
FROM inventory_sessions s
WHERE e.session_id = s.id AND e.tenant_id IS NULL;
UPDATE audit_log SET tenant_id = (SELECT id FROM tenants WHERE slug = 'default') WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_locations_tenant ON locations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_buildings_tenant ON buildings(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_tenant ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_sessions_tenant ON inventory_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_session_devices_tenant ON session_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_items_tenant ON inventory_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_item_photos_tenant ON item_photos(tenant_id);
CREATE INDEX IF NOT EXISTS idx_exports_tenant ON exports(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant ON audit_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_locations_external ON locations(external_system, external_location_id) WHERE external_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_items_external ON inventory_items(external_system, external_item_id) WHERE external_item_id IS NOT NULL;
