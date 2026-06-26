ALTER TABLE damage_reports
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES inventory_sessions(id);

ALTER TABLE damage_photos
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES inventory_sessions(id);

CREATE INDEX IF NOT EXISTS idx_damage_reports_session_updated
  ON damage_reports(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_damage_photos_session
  ON damage_photos(session_id);
