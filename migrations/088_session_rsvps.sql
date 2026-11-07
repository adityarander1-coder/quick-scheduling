-- 088: RSVPs for invited event attendees (Deepika, 2026-11-07).
-- One row per invited user per occurrence date: a Yes / No / Maybe
-- reply for that date only. (087 was already written and applied
-- for the rest of the event model, so this lands as the next
-- number rather than folding into 087.)
CREATE TABLE IF NOT EXISTS session_rsvps (
  session_id uuid NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  session_date date NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('yes', 'no', 'maybe')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, session_date, user_id)
);
CREATE INDEX IF NOT EXISTS idx_session_rsvps_session ON session_rsvps(session_id, session_date);
