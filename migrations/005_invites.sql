-- 005_invites.sql — invite tokens for the no-password team-member flow.
-- An owner/scheduler adds a team member without a password; the new member
-- sets their own password via /accept-invite.html?token=<token>.
-- Only SHA-256 hashes of tokens are stored; raw tokens are never persisted.
-- Invite lifecycle per member: not sent (sent_at NULL) -> sent (sent_at set)
-- -> accepted (used_at set). Reissuing deletes prior unused invites.

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_token_hash_idx ON invites (token_hash);
CREATE INDEX IF NOT EXISTS invites_user_id_idx ON invites (user_id);
CREATE INDEX IF NOT EXISTS invites_company_id_idx ON invites (company_id);
