-- 087_session_event_model.sql
-- Calendar EVENT model (Deepika, 2026-11-07): events carry an
-- ORGANIZING department (stored in academic_sessions.department_id),
-- any number of SPEAKERS (team members or guests), and BENEFICIARIES
-- (departments and/or specific people) who can view the event beyond
-- the calendar's own audience.
--
-- session_speakers: one row per speaker, in order. A team speaker has
-- user_id set; a GUEST speaker has user_id NULL plus guest_name (and
-- optionally guest_email, used for the one-off details email). The
-- session's lecturer_user_id keeps mirroring Speaker 1 when Speaker 1
-- is a team member (NULL when Speaker 1 is a guest or there are no
-- speakers), so My Schedule, the calendar feed, offers and Ask keep
-- working unchanged.
CREATE TABLE IF NOT EXISTS session_speakers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  guest_name TEXT,
  guest_email TEXT,
  position INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_speakers_session_idx ON session_speakers(session_id, position);

CREATE TABLE IF NOT EXISTS session_beneficiary_departments (
  session_id UUID NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, department_id)
);

CREATE TABLE IF NOT EXISTS session_beneficiary_users (
  session_id UUID NOT NULL REFERENCES academic_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, user_id)
);

-- Backfill: every existing session's presenter becomes Speaker 1.
INSERT INTO session_speakers (session_id, user_id, position)
SELECT s.id, s.lecturer_user_id, 1
FROM academic_sessions s
WHERE s.lecturer_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM session_speakers sp WHERE sp.session_id = s.id);
