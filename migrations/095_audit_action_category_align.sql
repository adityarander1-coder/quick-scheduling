-- Audit log: align the CHECK constraints with the code
-- (src/util/audit.ts). The action CHECK from 026 predates the
-- dashboard archive flow, so 'archived' / 'restored' /
-- 'delete_requested' / 'delete_rejected' / 'delete_cancelled'
-- entries were silently rejected (auditLog swallows the error —
-- the archive itself succeeded but its audit row never wrote).
-- Category gains 'calendar' for the separate Calendar report
-- (Deepika, 2026-11-07).
ALTER TABLE schedule_audit_log DROP CONSTRAINT IF EXISTS schedule_audit_log_action_check;
ALTER TABLE schedule_audit_log
  ADD CONSTRAINT schedule_audit_log_action_check
  CHECK (action IN ('created', 'updated', 'deleted', 'published', 'unpublished', 'rotation_excluded',
                    'archived', 'restored', 'delete_requested', 'delete_rejected', 'delete_cancelled'));
ALTER TABLE schedule_audit_log DROP CONSTRAINT IF EXISTS schedule_audit_log_category_check;
ALTER TABLE schedule_audit_log
  ADD CONSTRAINT schedule_audit_log_category_check
  CHECK (category IN ('schedule', 'settings', 'calendar'));
