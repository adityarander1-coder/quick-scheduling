-- Schedule audit log: tracks every change to the schedule (who, what, when, manual vs rotation).
CREATE TABLE IF NOT EXISTS schedule_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted', 'published', 'unpublished', 'rotation_excluded')),
  person_name TEXT,
  shift_type_name TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'rotation')),
  rotation_name TEXT,
  changed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_by_name TEXT,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_company_date ON schedule_audit_log(company_id, date);
CREATE INDEX IF NOT EXISTS idx_audit_created ON schedule_audit_log(company_id, created_at DESC);
