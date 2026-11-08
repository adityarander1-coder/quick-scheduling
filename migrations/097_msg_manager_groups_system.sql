-- 097_msg_manager_groups_system.sql
-- Close the gap Deepika hit live minutes after 096 deployed
-- (2026-11-07): "I created new group in messages but it did not
-- get added to communication groups." Under the shipped 096 build,
-- EVERY group created through POST /messages/groups was stamped
-- kind='chat' — including ones created by owners/schedulers. Her
-- model: system groups ARE the Communication groups and only
-- admins/owners create them, so a manager-created Messages group
-- is a system group. The endpoint now stamps kind by creator role;
-- this migration reclassifies the narrow slice of rows that rule
-- covers retroactively:
--
--   kind = 'chat'  AND  created_by's CURRENT role is owner or
--   scheduler  AND  created_at >= 2026-11-08 04:00:00+00.
--
-- Migration 096 was applied on production at ~04:33 UTC on
-- 2026-11-08, so the 04:00 bound covers only rows born under the
-- unified build (the minutes between deploy and this fix). Do NOT
-- widen it: every pre-096 Messages group was ruled a chat group
-- regardless of who created it, and employee-created rows are
-- never touched.
--
-- Name collisions: system names are unique per company (partial
-- index idx_message_groups_system_name). A candidate whose name
-- matches an existing system group in its company — or an earlier
-- candidate in this same update with the same name — is LEFT as
-- chat (the earliest candidate wins), so this migration cannot
-- fail on the unique index.

UPDATE message_groups g
SET kind = 'system'
WHERE g.kind = 'chat'
  AND g.created_at >= TIMESTAMPTZ '2026-11-08 04:00:00+00'
  AND EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = g.created_by
      AND u.company_id = g.company_id
      AND u.role IN ('owner', 'scheduler')
  )
  AND NOT EXISTS (
    SELECT 1 FROM message_groups s
    WHERE s.company_id = g.company_id
      AND s.kind = 'system'
      AND lower(s.name) = lower(g.name)
  )
  AND NOT EXISTS (
    SELECT 1 FROM message_groups o
    WHERE o.company_id = g.company_id
      AND o.kind = 'chat'
      AND o.created_at >= TIMESTAMPTZ '2026-11-08 04:00:00+00'
      AND lower(o.name) = lower(g.name)
      AND EXISTS (
        SELECT 1 FROM users u2
        WHERE u2.id = o.created_by
          AND u2.company_id = o.company_id
          AND u2.role IN ('owner', 'scheduler')
      )
      AND (o.created_at < g.created_at
           OR (o.created_at = g.created_at AND o.id < g.id))
  );
