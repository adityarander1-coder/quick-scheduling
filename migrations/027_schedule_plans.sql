-- Schedule change plans: AI-proposed changes awaiting approval.
CREATE TABLE IF NOT EXISTS schedule_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_email_id TEXT,           -- Gmail message ID
  source_from TEXT,               -- who sent the email
  source_subject TEXT,
  source_body TEXT,               -- original email text
  plan JSONB NOT NULL,            -- structured list of proposed changes
  plan_summary TEXT NOT NULL,     -- human-readable summary
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  executed_at TIMESTAMPTZ,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_company_status ON schedule_plans(company_id, status);
CREATE INDEX IF NOT EXISTS idx_plans_email ON schedule_plans(source_email_id);
