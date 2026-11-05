-- 084_availability_user.sql
-- Login-based availability (Deepika, 2026-11-04 evening): availability
-- links now open a login page; answers belong to the person's account
-- (user_id), not a typed name. The name column stays for display and
-- for legacy answers given on the old no-login pages.
ALTER TABLE availability_responses ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE session_avail_responses ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_avail_resp_user ON availability_responses(user_id);
CREATE INDEX IF NOT EXISTS idx_session_avail_resp_user ON session_avail_responses(user_id);
