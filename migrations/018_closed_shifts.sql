-- Manually closed shifts: shift types with no open slots on a specific date.
CREATE TABLE IF NOT EXISTS closed_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  shift_type_id UUID NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS idx_closedshifts_lookup ON closed_shifts (company_id, date);
