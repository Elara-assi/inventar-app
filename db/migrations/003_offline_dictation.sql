-- Offline-First (O2) + Diktat (D2/D3)

-- 1) Idempotenter Sync: dieselbe Erfassung darf bei Netzabbruch + erneutem
--    Sync keine Dublette erzeugen. Das Geraet vergibt eine UUID je Erfassung.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS client_capture_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_items_client_capture
  ON inventory_items(client_capture_id) WHERE client_capture_id IS NOT NULL;

-- 2) Foto-/Audio-Dedup ueber Inhalts-Hash (Wiederholungs-Uploads beim Sync).
DELETE FROM item_photos a USING item_photos b
  WHERE a.item_id = b.item_id AND a.photo_type = b.photo_type
    AND a.original_hash = b.original_hash AND a.ctid > b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_photos_dedup
  ON item_photos(item_id, photo_type, original_hash);

ALTER TABLE item_audio_notes ADD COLUMN IF NOT EXISTS audio_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_audio_dedup
  ON item_audio_notes(item_id, audio_hash) WHERE audio_hash IS NOT NULL;

-- 3) Geraete-Status fuer die Pruefansicht (Vertrauens-UI): letzter Kontakt
--    und Anzahl lokal wartender Erfassungen je Handy.
ALTER TABLE session_devices
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_count INTEGER NOT NULL DEFAULT 0;

-- 4) Marken-Lexikon fuer die Diktat-Felderkennung (offline auf dem Geraet
--    und im Worker; pflegbar ohne Code-Aenderung).
CREATE TABLE IF NOT EXISTS brand_lexicon (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
