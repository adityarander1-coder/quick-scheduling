-- 068_plan_approver_tokens.sql
-- Per-approver approval links (Deepika 2026-10-31): each approver of a
-- plan gets their OWN approve/reject token pair, generated when the
-- plan's approver-notification emails are sent. The token was emailed
-- to exactly one approver, so it IS the auth (login-free, like the
-- reject link) AND it names the approver — the Change report records
-- exactly who clicked, closing the identity gap that held the
-- login-free approval change (f97e72d) back.
-- The plan-level approve_token / reject_token on schedule_plans stay:
-- links already sitting in inboxes keep behaving exactly as before
-- (approve needs a logged-in approver with department access; reject
-- is login-free). Rows cascade away with their plan.
CREATE TABLE IF NOT EXISTS plan_approver_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES schedule_plans(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approve_token TEXT NOT NULL UNIQUE,
  reject_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plan_approver_tokens_plan ON plan_approver_tokens(plan_id);
