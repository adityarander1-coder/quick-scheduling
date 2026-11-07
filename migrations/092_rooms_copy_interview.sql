-- 092: rooms grow up + interview platform link (Deepika, 2026-11-07).
--
-- ROOMS: the rooms table (migration 057) gains a details note
-- (capacity / floor) and an active flag (deactivate instead of
-- delete). Sessions gain a real room booking: room_id points at one
-- of OUR rooms (double-book guarded, availability computed from our
-- own sessions); room_source/room_external_id remember a room picked
-- from a connected Google/Microsoft room list (best-effort v1 — no
-- provider-side reservation). A typed one-off room keeps room_id
-- NULL and lives in `location` exactly as before.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS details TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS room_id UUID REFERENCES rooms(id) ON DELETE SET NULL;
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS room_source TEXT; -- 'app' | 'google' | 'microsoft' | NULL
ALTER TABLE academic_sessions ADD COLUMN IF NOT EXISTS room_external_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_room ON academic_sessions(company_id, room_id);

-- INTERVIEW PLATFORM LINK: only for hospitals with residency
-- programs — a company switch (default OFF, so other businesses
-- never see the feature) plus a per-calendar external link (a
-- program's Thalamus page, say) shown on that calendar and in its
-- sessions' details. A doorway, not a data pipe.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS residency_program BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS interview_link_url TEXT;
ALTER TABLE dashboards ADD COLUMN IF NOT EXISTS interview_link_label TEXT;
