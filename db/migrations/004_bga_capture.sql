ALTER TABLE inventory_items
  ADD COLUMN IF NOT EXISTS inventory_type TEXT NOT NULL DEFAULT 'bga',
  ADD COLUMN IF NOT EXISTS sequence_number INTEGER,
  ADD COLUMN IF NOT EXISTS specification TEXT,
  ADD COLUMN IF NOT EXISTS construction_year TEXT,
  ADD COLUMN IF NOT EXISTS function_ok TEXT NOT NULL DEFAULT 'nicht_geprueft',
  ADD COLUMN IF NOT EXISTS uvv_status TEXT NOT NULL DEFAULT 'unklar',
  ADD COLUMN IF NOT EXISTS uvv_valid_until DATE,
  ADD COLUMN IF NOT EXISTS inspection_book_available TEXT NOT NULL DEFAULT 'unklar',
  ADD COLUMN IF NOT EXISTS remark TEXT,
  ADD COLUMN IF NOT EXISTS type_plate_status TEXT NOT NULL DEFAULT 'nicht_geprueft',
  ADD COLUMN IF NOT EXISTS captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS manual_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reopened_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_inventory_items_type ON inventory_items(inventory_type);
CREATE INDEX IF NOT EXISTS idx_inventory_items_sequence ON inventory_items(session_id, sequence_number);

INSERT INTO object_classes (
  name, slug, description, default_commercial_category,
  requires_nameplate, requires_serial_number, requires_accounting_review
) VALUES
  ('Betriebs- und Geschäftsausstattung', 'bga', 'Allgemeine Betriebs- und Geschäftsausstattung nach manueller Zählliste', 'betriebsmittel', false, false, false)
ON CONFLICT (slug) DO UPDATE SET
  description = EXCLUDED.description,
  default_commercial_category = EXCLUDED.default_commercial_category,
  requires_nameplate = EXCLUDED.requires_nameplate,
  requires_serial_number = EXCLUDED.requires_serial_number,
  requires_accounting_review = EXCLUDED.requires_accounting_review;

INSERT INTO accounting_profiles (
  object_class_id, default_commercial_category, requires_accounting_check,
  requires_asset_number, requires_book_value, requires_acquisition_date,
  blocks_commercial_finalization
)
SELECT id, 'betriebsmittel', false, false, false, false, false
FROM object_classes
WHERE slug = 'bga'
ON CONFLICT (object_class_id) DO UPDATE SET
  default_commercial_category = EXCLUDED.default_commercial_category,
  requires_accounting_check = EXCLUDED.requires_accounting_check,
  requires_asset_number = EXCLUDED.requires_asset_number,
  requires_book_value = EXCLUDED.requires_book_value,
  requires_acquisition_date = EXCLUDED.requires_acquisition_date,
  blocks_commercial_finalization = EXCLUDED.blocks_commercial_finalization;

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
  ('object_photo','Objektfoto',true,true,true,'object_front','human',false,'Erfasser',10),
  ('object_type','Bezeichnung',true,true,false,null,'human_or_ai',true,'Erfasser',20),
  ('condition','Zustand',true,true,false,null,'human',true,'Erfasser',30),
  ('function_ok','Funktion i. O.',true,false,false,null,'human',true,'Technik',40),
  ('uvv_status','UVV-Status',true,false,false,null,'human',true,'Technik',50),
  ('inspection_book_available','Prüfbuch vorhanden',true,false,false,null,'human',true,'Technik',60)
) AS fr(field_name, field_label, required, blocks_finalization, evidence_required, evidence_photo_type, source_type, rework_allowed, responsible_role, sort_order)
ON oc.slug = 'bga'
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
