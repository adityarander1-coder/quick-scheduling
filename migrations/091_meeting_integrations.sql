-- 091_meeting_integrations.sql
-- One-tap meeting links (Deepika, 2026-11-07): the session form keeps
-- its paste-anything Meeting link box, and gains three generate
-- buttons (Zoom / Teams / Google Meet). Each COMPANY connects each
-- service once (owner-only OAuth); the tokens live here, one row per
-- company + provider. A session whose link was generated remembers
-- which provider made it and the provider-side meeting id, so later
-- time/title edits PATCH the external meeting and deleting the
-- session deletes it. The link itself stays in the existing
-- academic_sessions.meeting_url column.
CREATE TABLE IF NOT EXISTS company_integrations (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, -- zoom | google | microsoft
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  connected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  account_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, provider)
);

ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS meeting_provider TEXT;
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS meeting_external_id TEXT;
