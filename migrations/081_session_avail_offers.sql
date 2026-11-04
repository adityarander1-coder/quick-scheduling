-- 081_session_avail_offers.sql
-- Calendar availability links + session offers (Deepika, 2026-11-04),
-- mirroring the shift side (availability links 022 + gap offers 079):
-- a no-login link lists the sessions that still need a presenter or a
-- supervisor; people tap the ones they can cover. From the Needs
-- people tool, a scheduler offers a session to those volunteers (or
-- everyone on the calendar); each person gets a bell + an email with
-- a personal login-free link, and the first to accept is assigned.
CREATE TABLE IF NOT EXISTS session_avail_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dashboard_id UUID REFERENCES dashboards(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  title TEXT,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_session_avail_links_company ON session_avail_links(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_avail_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES session_avail_links(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  session_id UUID NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  occ_date DATE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('presenter', 'supervisor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (link_id, name, session_id, occ_date, role)
);
CREATE INDEX IF NOT EXISTS idx_session_avail_resp_link ON session_avail_responses(link_id);

CREATE TABLE IF NOT EXISTS session_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  occ_date DATE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('presenter', 'supervisor')),
  dashboard_id UUID REFERENCES dashboards(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, session_id, occ_date, role)
);
CREATE INDEX IF NOT EXISTS idx_session_offers_company ON session_offers(company_id, occ_date);

CREATE TABLE IF NOT EXISTS session_offer_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES session_offers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offer_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_session_offer_recipients_offer ON session_offer_recipients(offer_id);
