-- Inventur-Cockpit: Geraete-Status (letzter Kontakt + lokal wartende
-- Erfassungen je Handy) fuer den Live-Steuerstand.
ALTER TABLE session_devices
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_count INTEGER NOT NULL DEFAULT 0;
