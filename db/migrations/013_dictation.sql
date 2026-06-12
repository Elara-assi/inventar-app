-- Diktat-Felderkennung: Marken-Lexikon (offline auf dem Geraet und im
-- Worker nutzbar, pflegbar ohne Code-Aenderung) + Audio-Dedup fuer
-- idempotente Wiederholungs-Uploads aus der Offline-Queue.
CREATE TABLE IF NOT EXISTS brand_lexicon (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  category TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO brand_lexicon (name, category) VALUES
  ('Nussbaum', 'werkstatt'), ('MAHA', 'werkstatt'), ('Hofmann', 'werkstatt'),
  ('Consul', 'werkstatt'), ('Stertil-Koni', 'werkstatt'),
  ('Bosch', 'werkstatt'), ('Hazet', 'werkzeug'), ('Gedore', 'werkzeug'),
  ('Wuerth', 'werkzeug'), ('Stahlwille', 'werkzeug'), ('Snap-on', 'werkzeug'),
  ('Festool', 'werkzeug'), ('Makita', 'werkzeug'), ('Hilti', 'werkzeug'),
  ('Dell', 'it'), ('HP', 'it'), ('Lenovo', 'it'), ('Apple', 'it'),
  ('Samsung', 'it'), ('LG', 'it'), ('Fujitsu', 'it'), ('Asus', 'it'),
  ('Acer', 'it'), ('Brother', 'it'), ('Canon', 'it'), ('Epson', 'it'),
  ('Michelin', 'reifen'), ('Continental', 'reifen'), ('Bridgestone', 'reifen'),
  ('Pirelli', 'reifen'), ('Goodyear', 'reifen'), ('Dunlop', 'reifen'),
  ('Hankook', 'reifen'), ('Vredestein', 'reifen'), ('Falken', 'reifen')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE item_audio_notes ADD COLUMN IF NOT EXISTS audio_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_item_audio_dedup
  ON item_audio_notes(item_id, audio_hash) WHERE audio_hash IS NOT NULL;
