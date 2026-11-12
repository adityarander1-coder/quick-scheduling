-- 104_processed_schedule_emails.sql
-- One-email fix (Deepika, 2026-11-11): the poller only remembered
-- messages that created a plan (schedule_plans.source_email_id), so
-- a clarification — which writes no plan row — could be reprocessed
-- on the next tick / manual poll and send a SECOND clarification
-- email for the same request. This table records EVERY terminally
-- processed message (plan, clarification, skip, answered question)
-- so pollInbox skips it exactly once, whatever the outcome. A
-- message that failed (or hit an AI credit outage) is NOT recorded
-- and still retries, exactly as before.
CREATE TABLE IF NOT EXISTS processed_schedule_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_email_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_email_id)
);
CREATE INDEX IF NOT EXISTS processed_schedule_emails_company_idx
  ON processed_schedule_emails (company_id, processed_at DESC);
