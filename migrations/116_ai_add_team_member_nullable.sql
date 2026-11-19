-- 116: AI add_team_member can never supply an email or a password
-- (Deepika, 2026-11-19 — "Rah Kum" incident).
--
-- The AI executor inserts new users with email NULL and no password
-- hash, which violated the NOT NULL constraints from 001_init.sql, so
-- every AI-added team member silently failed to save (the chat still
-- said "Done"). Relax both columns. The executor still writes an
-- unusable password hash (mirroring the manual invite flow in
-- routes/users.ts), and email stays NULL when the plan supplies none
-- — a member added by the AI has no login until invited, exactly like
-- a manually added member before their invite is sent.
-- Existing rows are unaffected (all have email + password_hash set).
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
