CREATE TABLE IF NOT EXISTS ai_learning_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES inventory_items(id) ON DELETE SET NULL,
  session_id UUID REFERENCES inventory_sessions(id) ON DELETE SET NULL,
  object_class_id UUID REFERENCES object_classes(id) ON DELETE SET NULL,
  object_class_name TEXT,
  object_type TEXT,
  brand TEXT,
  model TEXT,
  serial_number TEXT,
  condition TEXT,
  corrected_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_suggestion_json JSONB,
  photo_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  notes TEXT,
  approved BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_learning_examples_class ON ai_learning_examples(object_class_id);
CREATE INDEX IF NOT EXISTS idx_ai_learning_examples_type ON ai_learning_examples(lower(object_type));
CREATE INDEX IF NOT EXISTS idx_ai_learning_examples_approved ON ai_learning_examples(approved);
