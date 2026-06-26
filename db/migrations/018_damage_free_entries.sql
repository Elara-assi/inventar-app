ALTER TABLE damage_reports
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'catalog';

ALTER TABLE damage_reports
  ADD COLUMN IF NOT EXISTS free_reference TEXT;

UPDATE damage_reports
SET entry_type = 'catalog'
WHERE entry_type IS NULL OR entry_type = '';
