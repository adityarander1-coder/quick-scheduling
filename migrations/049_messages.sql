-- In-app messaging: company channel, department channels, direct messages.
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('company', 'department', 'dm')),
  department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
  dm_key TEXT, -- for DMs: two user ids sorted and joined with '|'
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_company_kind ON messages(company_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(company_id, dm_key, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_dept ON messages(company_id, department_id, created_at);

-- Per-user read cursors for unread badges.
CREATE TABLE IF NOT EXISTS message_reads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_key)
);
