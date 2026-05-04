INSERT INTO roles (name, slug, description) VALUES
  ('Erfasser', 'erfasser', 'Mobile Schnellerfassung im Raum'),
  ('Prüfer', 'pruefer', 'Live-Prüfung, Korrektur und Finalisierung'),
  ('Standortverantwortlicher', 'standortverantwortlicher', 'Raumfreigabe und Export'),
  ('Admin', 'admin', 'Systemkonfiguration'),
  ('Revision/Leser', 'revision_leser', 'Audit und Leserechte'),
  ('Buchhaltung', 'buchhaltung', 'Kaufmaennische Nacharbeit')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO users (email, display_name, password_hash) VALUES
  ('pruefer@example.local', 'Demo Prüfer', 'demo'),
  ('erfasser@example.local', 'Demo Erfasser', 'demo'),
  ('buchhaltung@example.local', 'Demo Buchhaltung', 'demo')
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE (u.email = 'pruefer@example.local' AND r.slug IN ('pruefer', 'standortverantwortlicher'))
   OR (u.email = 'erfasser@example.local' AND r.slug = 'erfasser')
   OR (u.email = 'buchhaltung@example.local' AND r.slug = 'buchhaltung')
ON CONFLICT DO NOTHING;

INSERT INTO locations (name, code, address)
VALUES ('Betrieb Muster', 'BETR', 'Beispielstrasse 1')
ON CONFLICT (code) DO NOTHING;

INSERT INTO buildings (location_id, name, code)
SELECT id, 'Hauptgebäude', 'HG' FROM locations WHERE code = 'BETR'
ON CONFLICT (location_id, code) DO NOTHING;

INSERT INTO rooms (building_id, name, code, room_type)
SELECT b.id, x.name, x.code, x.room_type
FROM buildings b
CROSS JOIN (VALUES
  ('Serviceannahme', 'SA', 'office'),
  ('Werkstatt 1', 'W1', 'workshop'),
  ('Reifenlager', 'RL', 'storage')
) AS x(name, code, room_type)
WHERE b.code = 'HG'
ON CONFLICT (building_id, code) DO NOTHING;

INSERT INTO object_classes (
  name, slug, description, default_commercial_category,
  requires_nameplate, requires_serial_number, requires_accounting_review
) VALUES
  ('Reifen', 'reifen', 'Reifen und Reifensaetze mit DOT-Logik', 'ware', false, false, true),
  ('Monitor', 'monitor', 'Bildschirme und Arbeitsplatzmonitore', 'it_ausstattung', false, false, true),
  ('Hebebühne', 'hebebuehne', 'Werkstatteinrichtung mit Typenschildpflicht', 'anlagevermoegen', true, true, true),
  ('Werkzeugwagen', 'werkzeugwagen', 'Mobile Werkstattwagen und Werkzeugaufbewahrung', 'betriebsmittel', false, false, true),
  ('IT-Gerät', 'it_geraet', 'IT-Hardware mit Datenschutzrelevanz', 'it_ausstattung', false, false, true),
  ('Wuchtmaschine', 'wuchtmaschine', 'Radwuchtmaschinen mit Schutzhaube, Spindel und Bedienpanel', 'werkstattausstattung', true, true, true),
  ('Reifenmontiermaschine', 'reifenmontiermaschine', 'Reifenmontiermaschinen mit Montageteller, Montagearm und Abdrückeinheit', 'werkstattausstattung', true, true, true),
  ('Diagnosegerät', 'diagnosegeraet', 'Diagnose- und Testgeräte mit OBD-/Werkstattbezug', 'gwg_pruefen', false, false, true),
  ('Kompressor', 'kompressor', 'Druckluftkompressoren und stationäre Drucklufterzeuger', 'werkstattausstattung', true, true, true)
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
SELECT id, default_commercial_category, requires_accounting_review, requires_accounting_review,
       requires_accounting_review, requires_accounting_review, false
FROM object_classes
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
  ('reifen','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('reifen','dot_photo','DOT-Foto',true,true,true,'dot','human_or_ai',true,'Erfasser',20),
  ('reifen','dot_number','DOT-Nummer',true,true,false,null,'human_or_ai',true,'Prüfer',30),
  ('reifen','tire_size','Reifengröße',true,false,false,null,'human_or_ai',true,'Prüfer',40),
  ('reifen','tread_depth','Profiltiefe',true,true,false,null,'human',true,'Erfasser',50),
  ('reifen','ownership_type','Eigentumsart',true,false,false,null,'human',true,'Prüfer',60),
  ('monitor','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('monitor','condition','Zustand',true,true,false,null,'human_or_ai',true,'Prüfer',20),
  ('monitor','brand','Marke falls sichtbar',false,false,false,null,'human_or_ai',true,'Prüfer',30),
  ('monitor','serial_number','Seriennummer falls sichtbar',false,false,false,null,'human_or_ai',true,'Prüfer',40),
  ('hebebuehne','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('hebebuehne','nameplate_photo','Typenschildfoto',true,true,true,'nameplate','human',false,'Erfasser',20),
  ('hebebuehne','serial_number','Seriennummer',true,true,false,null,'human_or_ai',true,'Prüfer',30),
  ('hebebuehne','load_capacity','Tragfähigkeit',true,true,false,null,'human_or_ai',true,'Prüfer',40),
  ('werkzeugwagen','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('werkzeugwagen','responsible_user','Verantwortlicher',true,false,false,null,'human',true,'Prüfer',20),
  ('it_geraet','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('it_geraet','device_type','Gerätetyp',true,true,false,null,'human_or_ai',true,'Prüfer',20),
  ('it_geraet','serial_number','Seriennummer falls sichtbar',false,false,false,null,'human_or_ai',true,'Prüfer',30),
  ('it_geraet','privacy_relevance','Datenschutzrelevanz',true,false,false,null,'human',true,'Prüfer',40),
  ('wuchtmaschine','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('wuchtmaschine','nameplate_photo','Typenschildfoto',true,true,true,'nameplate','human',true,'Erfasser',20),
  ('wuchtmaschine','serial_number','Seriennummer',true,true,false,null,'human_or_ai',true,'Prüfer',30),
  ('reifenmontiermaschine','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('reifenmontiermaschine','nameplate_photo','Typenschildfoto',true,true,true,'nameplate','human',true,'Erfasser',20),
  ('reifenmontiermaschine','serial_number','Seriennummer',true,true,false,null,'human_or_ai',true,'Prüfer',30),
  ('diagnosegeraet','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('diagnosegeraet','device_type','Gerätetyp',true,true,false,null,'human_or_ai',true,'Prüfer',20),
  ('diagnosegeraet','serial_number','Seriennummer falls sichtbar',false,false,false,null,'human_or_ai',true,'Prüfer',30),
  ('kompressor','object_photo','Objektfoto',true,true,true,'object','human',false,'Erfasser',10),
  ('kompressor','nameplate_photo','Typenschildfoto',true,true,true,'nameplate','human',true,'Erfasser',20),
  ('kompressor','serial_number','Seriennummer',true,true,false,null,'human_or_ai',true,'Prüfer',30)
) AS fr(slug, field_name, field_label, required, blocks_finalization, evidence_required, evidence_photo_type, source_type, rework_allowed, responsible_role, sort_order)
ON oc.slug = fr.slug
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

