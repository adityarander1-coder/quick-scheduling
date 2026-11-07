-- 090: dashboard delete becomes ARCHIVE + approval (Deepika, 2026-11-07).
-- Deleting a dashboard never destroys it: the row (and every session on
-- it) stays, flagged archived, hidden from all live surfaces, and can be
-- restored from Settings. An admin (scheduler) delete is a REQUEST that
-- another admin of the dashboard's departments (or the owner) must
-- approve; the owner archives immediately.
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
-- Who initiated the archive: for an approved request this is the
-- REQUESTER (the deletion was theirs, countersigned by the approver);
-- for an owner's direct archive it is the owner.
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS dashboard_delete_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  dashboard_id UUID NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
  decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
-- At most ONE pending request per dashboard.
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_delete_requests_one_pending
  ON dashboard_delete_requests (dashboard_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS dashboard_delete_requests_company_idx
  ON dashboard_delete_requests (company_id, status);
