-- 109_partial_generation_scope.sql — Partial drafts: pick by shift +
-- employees (Deepika, 2026-11-14)
--
-- A generation records WHO it was drafted for. user_ids NULL means the
-- whole rotation (every member, every type it produces) — all
-- generations written before this migration, and every full draft
-- since. user_ids SET means only those team members' turns were
-- drafted (the group dealing still runs unchanged; unpicked members'
-- turns simply produce no rows).
--
-- The not-drafted coverage reads (scheduleMode.ts) treat the two
-- kinds differently: a full generation covers its whole range for
-- its types, as before; a partial generation covers only the
-- (date, type) pairs it actually created rows for — so an unpicked
-- member's turn days read as "not drafted yet" for that type (no
-- OPEN row, no phantom shift), exactly as if they had never been
-- drafted.
ALTER TABLE rotation_generations ADD COLUMN IF NOT EXISTS user_ids uuid[];
COMMENT ON COLUMN rotation_generations.user_ids IS
  'Team members this generation was drafted for (partial draft). NULL = the whole rotation.';
