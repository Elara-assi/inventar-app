ALTER TABLE inventory_sessions
  ADD COLUMN IF NOT EXISTS inventory_type TEXT NOT NULL DEFAULT 'bga'
  CHECK (inventory_type IN ('bga', 'tires_wheels', 'special_tools'));

CREATE INDEX IF NOT EXISTS idx_inventory_sessions_type ON inventory_sessions(inventory_type);

UPDATE inventory_sessions
SET inventory_type = 'bga'
WHERE inventory_type IS NULL;
