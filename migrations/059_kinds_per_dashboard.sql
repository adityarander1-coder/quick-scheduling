-- 059_kinds_per_dashboard.sql
-- Session kinds belong to each dashboard, not the whole company
-- (Deepika, 2026-10-20: "keep this setting under its own dashboard
-- as there may be multiple dashboards").
--
-- ORDER MATTERS (the first prod deploy of this migration failed on
-- this): the old UNIQUE(company_id, key) must be dropped BEFORE
-- copying a company's kinds onto its dashboards — with two dashboards,
-- the second copy violates the company-level uniqueness.
ALTER TABLE session_kinds ADD COLUMN IF NOT EXISTS dashboard_id UUID REFERENCES dashboards(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_session_kinds_dash ON session_kinds(dashboard_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_kinds_company_id_key_key') THEN
    ALTER TABLE session_kinds DROP CONSTRAINT session_kinds_company_id_key_key;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_kinds_dash_key') THEN
    ALTER TABLE session_kinds ADD CONSTRAINT session_kinds_dash_key UNIQUE (dashboard_id, key);
  END IF;
END $$;

-- Copy each company's existing kinds onto each of its dashboards.
INSERT INTO session_kinds (id, company_id, dashboard_id, key, label, color, position)
SELECT gen_random_uuid(), d.company_id, d.id, k.key, k.label, k.color, k.position
FROM dashboards d
JOIN session_kinds k ON k.company_id = d.company_id AND k.dashboard_id IS NULL
ON CONFLICT (dashboard_id, key) DO NOTHING;

DELETE FROM session_kinds WHERE dashboard_id IS NULL;

ALTER TABLE session_kinds ALTER COLUMN dashboard_id SET NOT NULL;
