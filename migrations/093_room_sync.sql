-- 093: room sync + import (Deepika, 2026-11-07). Two modes per
-- company/provider: (A) keep both systems live — provider rooms are
-- SYNCED into our rooms table (names/details stay theirs; the table
-- is now the picker's source for that provider, availability still
-- checked live against the provider); (B) move over to us — a
-- one-time IMPORT detaches the rooms for good: they become ordinary
-- app rooms, editable in our Settings, and sync never touches them
-- again.
--
-- rooms.source: 'app' (ours — includes imported rooms), 'google' or
-- 'microsoft' (synced, provider-owned), or 'imported-google' /
-- 'imported-microsoft' (a detached copy — display only; sync ignores
-- these rows entirely).
-- rooms.external_id: the provider-side id of a synced room; NULL for
-- app/imported rows (import clears it, so no upsert can ever match a
-- detached room again).
-- rooms.user_disabled: set when someone here switches a room off —
-- for a synced room a re-sync refreshes name/details but never turns
-- it back on.
-- The last-sync outcome per provider lives in company_settings under
-- rooms_sync_<provider> (JSON: lastSyncAt / lastAttemptAt / lastResult).
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS user_disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_company_source_external
  ON rooms (company_id, source, external_id) WHERE external_id IS NOT NULL;
