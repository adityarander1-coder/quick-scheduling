-- Credential tracker (Deepika 2026-11-04): per-person licenses and
-- certifications with expiry dates. Categories are company-defined —
-- the list starts with defaults and grows from the credential form
-- itself ("+ New category"). Reminder checkpoints (30 days / 7 days /
-- expired) run in util/notifyJobs.ts and dedupe via the notifications
-- payload, so no reminder-log table is needed here.
CREATE TABLE IF NOT EXISTS credential_categories (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS credential_categories_company_name
  ON credential_categories (company_id, lower(name));

CREATE TABLE IF NOT EXISTS credentials (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Other',
  number TEXT,
  expiry_date DATE NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credentials_company_expiry
  ON credentials (company_id, expiry_date);
