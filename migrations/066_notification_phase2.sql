-- 066_notification_phase2.sql
-- Notifications Phase 2 (Deepika 2026-10-29): personal reminder picks
-- (up to 2 per kind — shifts and sessions separately) and the
-- exactly-once log the reminder engine fires against. Reminder picks
-- are personal only; the owner never sets them. JSONB picks keeps the
-- door open for new timing values without another migration.
CREATE TABLE IF NOT EXISTS notification_reminder_prefs (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shift', 'session')),
  picks JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE IF NOT EXISTS notification_reminder_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('shift', 'session')),
  event_key TEXT NOT NULL,   -- shift:<shiftId> | session:<seriesId>:<date>
  pick TEXT NOT NULL,        -- 30m | 1h | evening | morning
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, event_key, pick)
);
CREATE INDEX IF NOT EXISTS idx_reminder_log_user ON notification_reminder_log(user_id, fired_at DESC);
