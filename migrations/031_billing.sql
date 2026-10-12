-- 031_billing.sql — self-serve signup + Stripe billing.
-- Company lifecycle: trial (14d, card on file) -> active -> past_due (7d grace)
--   -> read_only -> suspended. Cancel -> access to period end, then canceled.
-- Stripe is the source of truth; webhooks write these columns.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'trial'
    CHECK (billing_status IN ('trial','active','past_due','read_only','suspended','canceled')),
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS billing_updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS companies_stripe_customer_id_unique
  ON companies (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS companies_billing_status_idx ON companies (billing_status);
