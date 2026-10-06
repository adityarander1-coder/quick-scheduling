-- 002_sessions.sql — sessions table backing the express-session PGlite store.
-- Store writes sess as jsonb (session cookie data) and expire as timestamptz.

CREATE TABLE IF NOT EXISTS sessions (
  sid text PRIMARY KEY,
  sess jsonb NOT NULL,
  expire timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions (expire);
