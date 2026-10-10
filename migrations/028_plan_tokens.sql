-- Add approval tokens for email approve/reject links
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS approve_token TEXT UNIQUE;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS reject_token TEXT UNIQUE;
CREATE INDEX IF NOT EXISTS idx_plans_approve_token ON schedule_plans(approve_token);
CREATE INDEX IF NOT EXISTS idx_plans_reject_token ON schedule_plans(reject_token);
