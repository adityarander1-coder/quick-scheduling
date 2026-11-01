-- 070_push_subscriptions.sql
-- Web push notifications (Phase 3 of the notification plan, Deepika
-- 2026-10-31). Devices subscribe via the browser Push API; the server
-- keeps one row per subscription endpoint. Push delivery rides the
-- existing notification dispatcher in util/notify.ts: a notification
-- whose resolved speed is "instant" is pushed to the user's devices
-- alongside the email copy; "digest" rows are never pushed (they are
-- the morning digest's job) and "off" rows are skipped. The
-- notifications.push_state columns mirror email_state so each channel
-- is tracked independently.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS push_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMPTZ;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS push_attempts INT NOT NULL DEFAULT 0;
