-- 122_exclusion_origin.sql — Tell a bulk-delete exclusion from a
-- one-by-one delete (Deepika, 2026-11-23 — draft fix).
--
-- A bulk delete clears a whole range so it can be re-drafted, and its
-- exclusions are range-clear markers: the draft clears them in the
-- range it drafts, so the people come back. A one-by-one delete
-- (DELETE /shifts/:id, a swap, a replace) is a deliberate removal of
-- one person from one shift, and its exclusion stays — a re-draft
-- must not bring that person back (case F). Before this migration
-- the two were indistinguishable, so a bulk-deleted range could
-- never re-draft: every occurrence was skipped as 'excluded' and the
-- draft reported "0 draft shifts" with no reason.
--
-- Conversion: every existing exclusion is a one-by-one delete
-- (safe default — nothing that is currently deleted comes back).
-- Ranges bulk-deleted BEFORE this migration keep that behaviour
-- until they are bulk-deleted once more, which writes the new
-- 'bulk' marker.
ALTER TABLE rotation_shift_exclusions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'single';
CREATE INDEX IF NOT EXISTS idx_rotexcl_origin ON rotation_shift_exclusions(company_id, origin);
