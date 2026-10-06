-- 001_init.sql — Phase 1 core tables: companies, users, password_reset_tokens.
-- Runs in filename order via src/db.ts migration runner (tracks applied in `migrations` table).

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','scheduler','employee')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Email uniqueness is case-insensitive; all lookups compare lower(email) = lower($1).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_company_id_idx ON users (company_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_token_hash_idx ON password_reset_tokens (token_hash);
