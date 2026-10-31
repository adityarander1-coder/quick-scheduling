-- 069_platform_state.sql
-- Platform-wide key/value state — rows that belong to the PLATFORM,
-- not to any one company (company_settings is per-company and cannot
-- hold them). First user: the Gemini outage episode tracker
-- (util/platformAlert.ts), which must remember across restarts that
-- an outage alert has already been sent, so a deploy or restart
-- mid-outage never re-alerts.
CREATE TABLE IF NOT EXISTS platform_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
