-- 119_suppressed_open_slots.sql — Closed computed opens, done properly
-- (Deepika, 2026-11-20 — "when i say close this slot it should really
-- delete the slot" / "it cannot ask to restore the slot again").
--
-- The old close wrote a NEGATIVE row into extra_open_slots, which
-- suppressed one computed open forever and left the day dialog offering
-- "N slot(s) removed — Restore". A close now works like this:
--   * an EXTRA open slot (a stored positive row) is really deleted;
--   * a SHORTFALL open (computed from target - filled, no stored row)
--     is recorded here — suppressed until the next draft/publish of
--     that date+type pulls it back from the rotation (target - filled).
-- The open count is target + extra - filled - suppressed (0 when the
-- day is closed for the type). No negative extra_open_slots row is
-- ever written by a close again, and no Restore row is ever rendered.
--
-- Legacy conversion: every negative extra_open_slots row in existence
-- is exactly one old-style close record, so it moves here with the
-- same count — closes made before this build keep suppressing their
-- slots until the next draft/publish of that date+type, exactly as
-- the new rule says. Nothing is un-closed by the migration.
CREATE TABLE IF NOT EXISTS suppressed_open_slots (
  company_id text NOT NULL,
  date date NOT NULL,
  shift_type_id text NOT NULL,
  count int NOT NULL CHECK (count > 0),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS suppressed_open_slots_company_idx
  ON suppressed_open_slots (company_id, date);

INSERT INTO suppressed_open_slots (company_id, date, shift_type_id, count, created_by)
SELECT company_id, date, shift_type_id, -count, created_by
FROM extra_open_slots WHERE count < 0
ON CONFLICT (company_id, date, shift_type_id) DO NOTHING;
DELETE FROM extra_open_slots WHERE count < 0;
