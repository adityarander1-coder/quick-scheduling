-- 072_swap_partner_stage.sql — two-stage swap approval (Deepika 2026-11-01).
--
-- Her rule: a swap request goes FIRST to the person being swapped
-- with; only when they agree does it go to the admins/owner for the
-- final approval. Today form/email swaps became plans that went
-- straight to the approvers (the partner was never asked), and in-app
-- Requests swaps executed on the FIRST approval from anyone.
--
-- Plans: a plan whose changes swap with one partner is born in the
-- new 'awaiting_partner' status — no approver bell or email fires
-- until the partner agrees (status flips to 'pending' and the normal
-- approver notifications run). The partner decides through token
-- links (login-free, like approver links) or in the app.
--
-- shift_requests: a swap row carries a stage — 'partner' first, then
-- 'admin'. Existing rows default to 'admin', which preserves the
-- current behaviour for requests already in flight.

ALTER TABLE schedule_plans DROP CONSTRAINT IF EXISTS schedule_plans_status_check;

ALTER TABLE schedule_plans
  ADD CONSTRAINT schedule_plans_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'failed', 'partial', 'awaiting_partner'));

ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS partner_user_id uuid;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS partner_name text;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS partner_status text;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS partner_approve_token text;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS partner_reject_token text;

ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'admin';
