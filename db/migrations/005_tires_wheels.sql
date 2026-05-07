CREATE TABLE IF NOT EXISTS item_tire_wheel_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID NOT NULL UNIQUE REFERENCES inventory_items(id) ON DELETE CASCADE,
  set_type TEXT NOT NULL DEFAULT 'satz' CHECK (set_type IN ('satz', 'einzelreifen')),
  season TEXT NOT NULL DEFAULT 'unklar' CHECK (season IN ('sommer', 'winter', 'ganzjahr', 'unklar')),
  manufacturer TEXT,
  profile_model TEXT,
  tire_size TEXT,
  load_index TEXT,
  speed_index TEXT,
  dot TEXT,
  production_week INTEGER CHECK (production_week IS NULL OR production_week BETWEEN 1 AND 53),
  production_year INTEGER CHECK (production_year IS NULL OR production_year BETWEEN 1980 AND 2100),
  tread_depth_front_left NUMERIC(4,1),
  tread_depth_front_right NUMERIC(4,1),
  tread_depth_rear_left NUMERIC(4,1),
  tread_depth_rear_right NUMERIC(4,1),
  tread_depth_single NUMERIC(4,1),
  rim_present BOOLEAN,
  rim_type TEXT CHECK (rim_type IS NULL OR rim_type IN ('stahl', 'alu', 'unklar')),
  rim_condition TEXT,
  tire_condition TEXT,
  damage_note TEXT,
  set_complete BOOLEAN,
  storage_location TEXT,
  remark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_item_tire_wheel_data_item ON item_tire_wheel_data(item_id);
CREATE INDEX IF NOT EXISTS idx_item_tire_wheel_data_dot ON item_tire_wheel_data(dot);

INSERT INTO object_classes (
  name, slug, description, default_commercial_category,
  requires_nameplate, requires_serial_number, requires_accounting_review
) VALUES
  ('Reifen/Räder', 'tires_wheels', 'Reifen, Räder, Radsätze und Einzelreifen', 'ware', false, false, false)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  default_commercial_category = EXCLUDED.default_commercial_category,
  requires_nameplate = EXCLUDED.requires_nameplate,
  requires_serial_number = EXCLUDED.requires_serial_number,
  requires_accounting_review = EXCLUDED.requires_accounting_review;

INSERT INTO field_requirements (
  object_class_id, field_name, field_label, required, blocks_finalization,
  evidence_required, evidence_photo_type, source_type, rework_allowed,
  responsible_role, sort_order
)
SELECT oc.id, fr.field_name, fr.field_label, fr.required, fr.blocks_finalization,
       fr.evidence_required, fr.evidence_photo_type, fr.source_type,
       fr.rework_allowed, fr.responsible_role, fr.sort_order
FROM object_classes oc
JOIN (VALUES
  ('tire_overview_photo','Gesamtfoto Reifen/Radsatz',true,true,true,'tire_overview','human',false,'Erfasser',10),
  ('tire_size','Reifengröße',true,true,false,null,'human_or_ai',true,'Erfasser',20),
  ('dot','DOT',true,true,false,null,'human_or_ai',true,'Erfasser',30),
  ('tread_depth','Profiltiefe',true,true,false,null,'human',true,'Erfasser',40),
  ('season','Saison',true,false,false,null,'human',true,'Erfasser',50)
) AS fr(field_name, field_label, required, blocks_finalization, evidence_required, evidence_photo_type, source_type, rework_allowed, responsible_role, sort_order)
ON oc.slug = 'tires_wheels'
ON CONFLICT (object_class_id, field_name) DO UPDATE SET
  field_label = EXCLUDED.field_label,
  required = EXCLUDED.required,
  blocks_finalization = EXCLUDED.blocks_finalization,
  evidence_required = EXCLUDED.evidence_required,
  evidence_photo_type = EXCLUDED.evidence_photo_type,
  source_type = EXCLUDED.source_type,
  rework_allowed = EXCLUDED.rework_allowed,
  responsible_role = EXCLUDED.responsible_role,
  sort_order = EXCLUDED.sort_order;
