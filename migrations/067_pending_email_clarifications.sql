-- 067_pending_email_clarifications.sql
-- Email scheduler batch 1 (Deepika 2026-10-30): when the email engine
-- asks a sender for a missing detail, it remembers the original request
-- here so the sender's reply can be stitched back onto that request
-- instead of being read as a brand-new email. One open row per
-- (company, sender): a new clarification replaces the row, and a matched
-- reply clears it. Rows older than 7 days no longer match.
CREATE TABLE IF NOT EXISTS pending_email_clarifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_address TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  original_body TEXT NOT NULL DEFAULT '',
  missing TEXT NOT NULL DEFAULT '',
  message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, sender_address)
);
