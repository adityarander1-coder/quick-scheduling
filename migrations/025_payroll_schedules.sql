-- Automatic payroll report email schedules.
CREATE TABLE IF NOT EXISTS payroll_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  day_of_week INT CHECK (day_of_week IS NULL OR (day_of_week >= 0 AND day_of_week <= 6)),
  day_of_month INT CHECK (day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)),
  person_id UUID REFERENCES users(id) ON DELETE CASCADE,
  range_days INT NOT NULL DEFAULT 7 CHECK (range_days >= 1 AND range_days <= 62),
  last_sent_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_sched_company ON payroll_schedules(company_id);
CREATE INDEX IF NOT EXISTS idx_payroll_sched_next ON payroll_schedules(next_run_at);
