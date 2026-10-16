-- Scheduled (future-dated) job role promotions.
CREATE TABLE IF NOT EXISTS scheduled_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_role_id UUID REFERENCES job_roles(id) ON DELETE SET NULL,
  to_role_id UUID NOT NULL REFERENCES job_roles(id) ON DELETE CASCADE,
  effective_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'cancelled')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at TIMESTAMPTZ,
  UNIQUE (company_id, user_id, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_sched_promo_due ON scheduled_promotions (company_id, effective_date) WHERE status = 'pending';
