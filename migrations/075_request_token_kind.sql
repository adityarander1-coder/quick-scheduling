-- Approver action tokens (Deepika 2026-11-03): shift_request_action_tokens
-- gains a kind so owners/schedulers can get their own Approve/Reject email
-- links for requests waiting on THEIR decision (pickup requests, share-link
-- open pickups, swaps at the admin stage). 'asked' = the person being
-- asked (cover audience / swap partner), the original migration-074 use.
ALTER TABLE shift_request_action_tokens
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'asked';
