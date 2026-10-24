-- 064_company_inboxes.sql
-- Per-company email inboxes (Deepika 2026-10-24): each company connects its
-- OWN Gmail mailbox for Email Q-Scheduler, instead of the single pinned
-- inbox (GMAIL_USER / GMAIL_APP_PASSWORD / GMAIL_COMPANY_ID env vars).
-- The app password is stored encrypted (AES-256-GCM, see util/inboxCrypto.ts)
-- and is NEVER returned by any API — the Settings UI only shows the address,
-- whether it is connected, and the last poll status.
CREATE TABLE IF NOT EXISTS company_inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  gmail_user TEXT NOT NULL,
  gmail_app_password_enc TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_polled_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_inboxes_active ON company_inboxes (is_active) WHERE is_active;
