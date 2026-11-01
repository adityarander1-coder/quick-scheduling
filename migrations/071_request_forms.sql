-- 071_request_forms.sql
-- Email Q-Scheduler request form (Deepika, 2026-11-01): a structured
-- form (in-app behind the Email Q-Scheduler button, and as a no-login
-- page linked from our emails) whose submissions enter the SAME email
-- pipeline as a hand-written email, in the app's own standard wording.
--
-- users.alt_email: one extra "send from" address per person (set in My
-- Settings). The sender lock accepts it alongside the account email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS alt_email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_company_alt_email
  ON users (company_id, lower(alt_email)) WHERE alt_email IS NOT NULL;

-- Links that open the form without a login. 'standing' links belong to
-- one staff member and live until replaced; 'clarification' links are
-- issued inside a clarification email, carry the original request as
-- prefill, and expire with the clarification window (7 days).
CREATE TABLE IF NOT EXISTS form_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  sender_email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('standing', 'clarification')),
  prefill JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_form_links_user ON form_links (company_id, user_id, kind);

-- One row per form submission: the structured fields, the composed
-- email that entered the pipeline, and how processing ended. Rows the
-- engine could not process (e.g. an AI billing outage) stay 'queued'
-- and are retried by the poll scheduler, attempt-capped.
CREATE TABLE IF NOT EXISTS form_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  from_email TEXT NOT NULL,
  action TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'app',
  status TEXT NOT NULL DEFAULT 'processing',
  outcome TEXT,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_form_requests_queue ON form_requests (status, created_at);

-- AI learning (Deepika, 2026-11-01): when an email could not be
-- understood and the sender later resolves it (form or plain reply)
-- into a real plan, the pair (their original words -> the clean
-- request) is saved per company. The email planner is shown the few
-- most similar pairs next time it reads mail for that company.
CREATE TABLE IF NOT EXISTS email_learning_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  original_text TEXT NOT NULL,
  resolved_text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'clarification',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_learning_company ON email_learning_examples (company_id, created_at DESC);
