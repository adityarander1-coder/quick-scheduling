-- 080_kind_person_label.sql
-- Each session type (kind) can name the person its sessions need
-- (Deepika, 2026-11-04): a Lecture needs a "Presenter", an Interviews
-- type can need an "Interviewer". NULL means the default, Presenter.
-- The Needs people tool groups its lists by this name.
ALTER TABLE session_kinds ADD COLUMN IF NOT EXISTS person_label TEXT;
