-- 062_quick_session_links.sql
-- Quick session links (Deepika, 2026-10-21): plan-approval emails
-- carry a "Quick session" button next to Approve / Reject. It opens
-- a small standalone session form (no app, no login — the token is
-- the auth, like the approve/reject tokens) so a session can be
-- added or changed straight from the email. Tokens are scoped to
-- one company (optionally prefilled to one dashboard / session /
-- date) and expire after 7 days.
CREATE TABLE IF NOT EXISTS quick_session_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT UNIQUE NOT NULL,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dashboard_id UUID REFERENCES dashboards(id) ON DELETE CASCADE,
  session_id UUID REFERENCES academic_sessions(id) ON DELETE CASCADE,
  occ_date DATE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_quick_session_links_token ON quick_session_links(token);
