-- 094_comm_groups.sql
-- Communication groups (Deepika, 2026-11-07): named circles of people
-- who regularly need to be at things — company-wide, members pulled
-- from ANY department mixed together. For COMMUNICATIONS only: no
-- effect on shifts, schedules, or permissions. First use: calendar
-- event BENEFICIARIES — picking a group in the event form expands it
-- (snapshot) into the session's ordinary beneficiary people; the
-- session stores no link back to the group, so editing a group later
-- never changes saved events. (In-app messaging addressing is a
-- future step, not part of this migration.)
--
-- Membership rows may outlive a member's active state: a deactivated
-- member stays stored but is skipped when a group is expanded in the
-- event form.
CREATE TABLE IF NOT EXISTS comm_groups (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comm_groups_company ON comm_groups(company_id);
-- Group names are unique per company, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_groups_company_name
  ON comm_groups (company_id, lower(name));

CREATE TABLE IF NOT EXISTS comm_group_members (
  group_id UUID NOT NULL REFERENCES comm_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comm_group_members_group ON comm_group_members(group_id);
