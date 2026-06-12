-- Buchhaltungs-Blatt im Excel-Export (SKR51-Vorbereitung):
-- Nutzungsdauer je Objektklasse + Konten-Mapping pflegbar machen.
ALTER TABLE accounting_profiles
  ADD COLUMN IF NOT EXISTS useful_life_years NUMERIC(4,1);

-- Selbsttragend: fehlende Profile anlegen (unabhaengig von Seed-Reihenfolge).
INSERT INTO accounting_profiles (object_class_id, default_commercial_category)
SELECT id, default_commercial_category FROM object_classes
ON CONFLICT (object_class_id) DO NOTHING;

-- Nutzungsdauer-STARTWERTE nach amtlicher AfA-Logik (Buchhaltung pflegt nach):
UPDATE accounting_profiles ap SET useful_life_years = sub.nd
FROM (
  SELECT oc.id AS class_id,
         CASE oc.slug
           WHEN 'hebebuehne' THEN 8
           WHEN 'monitor' THEN 3
           WHEN 'notebook' THEN 3
           WHEN 'eingabegeraet' THEN 3
           WHEN 'it_geraet' THEN 3
           WHEN 'werkzeugwagen' THEN 13
           ELSE 13
         END::numeric AS nd
  FROM object_classes oc
) sub
WHERE ap.object_class_id = sub.class_id AND ap.useful_life_years IS NULL;
