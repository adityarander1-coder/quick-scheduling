-- 096_groups_unify.sql
-- ONE store for groups, TWO kinds (Deepika, 2026-11-07, final model):
--   kind = 'system' — the Communication groups (ex-comm_groups):
--     created/managed by owners + schedulers only (Tools-bar Groups
--     panel + the event form's inline creator). They appear in the
--     panel, the event Attendees picker, AND in Messages, where they
--     can hold group conversations; membership is managed from the
--     panel side.
--   kind = 'chat' — Messages-only groups (ex-message_groups):
--     anyone can create one inside Messages (creator auto-member,
--     delete by creator or owner/scheduler). They appear NOWHERE
--     else — no panel, no Attendees picker.
--
-- Canonical store: message_groups / message_group_members. The
-- messages.group_id foreign key and every thread-membership read
-- (channels, message read/send gates, notifyJobs) already point
-- there, so existing threads and their ids never move. Communication
-- groups are copied across with their ids preserved — nothing
-- outside the comm tables references a comm group id (event
-- attendees are snapshots), so the copy is free.
--
-- Reversibility: the old comm tables are RENAMED to *_pre_unify,
-- never dropped (restore point: git tag `pre-groups-unify`).

-- Kind marker on the unified store; every pre-existing Messages
-- group is a chat group by birth.
ALTER TABLE message_groups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat';
-- updated_at parity with the old comm_groups (the panel list/API
-- shape carries it; the comm update path maintains it).
ALTER TABLE message_groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- created_by: comm_groups allowed a NULL creator and no FK. Align
-- the unified store to that: a shared group must not vanish when its
-- creator's account is deleted, and the copy below must be total.
ALTER TABLE message_groups ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE message_groups DROP CONSTRAINT IF EXISTS message_groups_created_by_fkey;
ALTER TABLE message_groups ADD CONSTRAINT message_groups_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- System-group names stay unique per company (the comm rule),
-- enforced in the API and backed here. Chat names are unrestricted,
-- exactly as Messages groups always were.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_groups_system_name
  ON message_groups (company_id, lower(name)) WHERE kind = 'system';

-- Copy the Communication groups across as system groups, ids kept.
INSERT INTO message_groups (id, company_id, name, created_by, created_at, updated_at, kind)
SELECT c.id, c.company_id, c.name, c.created_by, c.created_at, c.updated_at, 'system'
FROM comm_groups c
WHERE NOT EXISTS (SELECT 1 FROM message_groups m WHERE m.id = c.id);

-- …and their members, guarded to the rows actually copied (same id,
-- same company, same name, kind system).
INSERT INTO message_group_members (group_id, user_id)
SELECT cm.group_id, cm.user_id
FROM comm_group_members cm
JOIN comm_groups c ON c.id = cm.group_id
JOIN message_groups m
  ON m.id = c.id AND m.company_id = c.company_id AND m.name = c.name AND m.kind = 'system'
ON CONFLICT DO NOTHING;

-- Retire the old tables — renamed, kept for a later cleanup.
ALTER TABLE comm_groups RENAME TO comm_groups_pre_unify;
ALTER TABLE comm_group_members RENAME TO comm_group_members_pre_unify;
