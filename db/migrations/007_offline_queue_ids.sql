ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS client_item_id TEXT,
  ADD COLUMN IF NOT EXISTS source_device_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_client_identity
  ON inventory_items(session_id, source_device_id, client_item_id)
  WHERE source_device_id IS NOT NULL AND client_item_id IS NOT NULL;

ALTER TABLE item_photos
  ADD COLUMN IF NOT EXISTS client_photo_id TEXT,
  ADD COLUMN IF NOT EXISTS source_device_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_item_photos_client_identity
  ON item_photos(item_id, source_device_id, client_photo_id)
  WHERE source_device_id IS NOT NULL AND client_photo_id IS NOT NULL;
