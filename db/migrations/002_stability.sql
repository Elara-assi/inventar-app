-- Phase 1 Haertung: Stabilitaet und Konsistenz
-- 1) Atomare Inventar-ID-Vergabe (ersetzt count(*)+1, das bei parallelen
--    Erfassern UNIQUE-Verletzungen erzeugt hat).
CREATE TABLE IF NOT EXISTS inventory_id_counters (
  location_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (location_code, year)
);

-- Bestehende Items in den Zaehler uebernehmen (idempotent, max. vorhandene Nummer).
INSERT INTO inventory_id_counters (location_code, year, counter)
SELECT
  split_part(inventory_id, '-', 2) AS location_code,
  split_part(inventory_id, '-', 3)::int AS year,
  max(split_part(inventory_id, '-', 4)::int) AS counter
FROM inventory_items
WHERE inventory_id ~ '^SHR-[A-Z0-9]+-[0-9]{4}-[0-9]+$'
GROUP BY 1, 2
ON CONFLICT (location_code, year)
DO UPDATE SET counter = GREATEST(inventory_id_counters.counter, EXCLUDED.counter);

-- 2) Fehlende Indizes fuer die Abfragepfade der Pruefansicht und des Audit-Logs.
CREATE INDEX IF NOT EXISTS idx_item_photos_item ON item_photos(item_id);
CREATE INDEX IF NOT EXISTS idx_item_audio_notes_item ON item_audio_notes(item_id);
CREATE INDEX IF NOT EXISTS idx_accounting_tasks_item_status ON accounting_tasks(item_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_results_item ON ai_results(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_sessions_status ON inventory_sessions(status, created_at DESC);
