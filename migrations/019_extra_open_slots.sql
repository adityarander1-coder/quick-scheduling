-- Manually added extra open slots beyond staffing targets.
CREATE TABLE IF NOT EXISTS extra_open_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  shift_type_id UUID NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  count INT NOT NULL DEFAULT 1 CHECK (count > 0),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS idx_extraopenslots_lookup ON extra_open_slots (company_id, date);
