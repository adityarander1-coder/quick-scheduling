-- 063_notifications.sql
-- In-app notifications + notification preferences (Phase 1 of the
-- notification plan, Deepika 2026-10-22). Every notification-worthy
-- event (shift assigned/changed/removed, schedule published, open
-- shifts, session changes, approvals waiting) lands in `notifications`
-- for the bell/list; a dispatcher emails the ones whose resolved
-- speed is "instant" (per-user pref -> company default -> built-in).
-- "digest" rows stay pending for the Phase 2 digest email.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,          -- schedule | calendar | approvals | messages
  type TEXT NOT NULL,              -- shift_assigned | shift_changed | ... (see util/notify.ts)
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,                       -- in-app target hint: my-schedule | schedule | requests | calendars
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  bundle_key TEXT,                 -- merges rapid repeats for the same user+type within 10 min
  read_at TIMESTAMPTZ,
  email_state TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | skipped | failed
  email_attempts INT NOT NULL DEFAULT 0,
  email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_email ON notifications(email_state, updated_at);
CREATE INDEX IF NOT EXISTS idx_notifications_bundle ON notifications(user_id, type, bundle_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  speed TEXT NOT NULL CHECK (speed IN ('instant', 'digest', 'off')),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS notification_defaults (
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  speed TEXT NOT NULL CHECK (speed IN ('instant', 'digest', 'off')),
  PRIMARY KEY (company_id, category)
);
