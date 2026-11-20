-- 118_task_threads.sql — Ask/Task conversation threads, stored
-- server-side per user per company (Deepika, 2026-11-19 — N3
-- extension: "I want chat in ask task not to forget anything from
-- past").
--
-- One row = one conversation = one task plan (her design, Nov 19
-- ~8:35 PM): the full turn list of the current conversation lives
-- here, so it survives reloads and tab switches; the CURRENT
-- pending task is marked as current (pending_plan_id /
-- pending_token), so the fixers only ever narrow or re-scope the
-- plan this conversation is about — old plans can't leak into new
-- asks. A New task button (later build, after add_open_slots)
-- starts a fresh row and archives this one (is_current = false);
-- past threads reopen from history. No history UI in this dig —
-- the storage is listable by (company, user, updated_at) for it.
--
-- Retention (Deepika, Nov 19 ~8:37 PM — she corrected 30 days to
-- 15): threads older than 15 days drop out of history. Enforced
-- lazily on lookup (rows with updated_at older than 15 days are
-- deleted and never returned), so no sweeper is needed.
CREATE TABLE IF NOT EXISTS task_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  thread JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_plan_id UUID REFERENCES schedule_plans(id) ON DELETE SET NULL,
  pending_token TEXT,
  is_current BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One current thread per user per company; older threads stay
-- listable for the history build.
CREATE UNIQUE INDEX IF NOT EXISTS task_threads_current_unique
  ON task_threads (company_id, user_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS task_threads_user_idx
  ON task_threads (company_id, user_id, updated_at DESC);
