-- 121_remove_closed_flag.sql — The closed flag is gone (Deepika,
-- 2026-11-21 — "why is it hanging on to not letting us add").
--
-- A whole-type close no longer writes a closed_shifts flag row: it
-- deletes the slots and suppresses exactly the visible shortfall
-- with a stored suppressed_open_slots row, like the per-slot X
-- already did. A later add (manual or AI) lands on the date and
-- shows; the suppression only ever hides the shortfall, never a
-- stored extra.
--
-- Conversion: every flagged (company, date, type) becomes a
-- suppressed-shortfall row of max(0, target - filled) — the
-- staffing target for that weekday, minus stored shifts. When a
-- suppressed row already exists for the pair, the migration keeps
-- the LARGER of the two (never double-suppresses). Stored
-- extra_open_slots rows are untouched: extras added while a date
-- was flagged show again after this migration, exactly as the
-- remove-closed-flag change intends. The closed_shifts table
-- itself stays in place (plan undo snapshots it); it is simply
-- empty after this migration, and no code writes to it any more.
INSERT INTO suppressed_open_slots (company_id, date, shift_type_id, count, created_by)
SELECT cs.company_id, cs.date, cs.shift_type_id,
       GREATEST(0, COALESCE(t.target_count, 0) - COALESCE(f.n, 0)),
       cs.created_by
FROM closed_shifts cs
LEFT JOIN staffing_targets t
  ON t.company_id = cs.company_id
 AND t.shift_type_id = cs.shift_type_id
 AND (t.weekdays IS NULL OR EXTRACT(DOW FROM cs.date)::int = ANY(t.weekdays))
 AND (t.start_date IS NULL OR cs.date >= t.start_date)
 AND (t.end_date IS NULL OR cs.date <= t.end_date)
LEFT JOIN (
  SELECT company_id, date, shift_type_id, COUNT(*)::int AS n
  FROM shifts
  GROUP BY company_id, date, shift_type_id
) f
  ON f.company_id = cs.company_id
 AND f.date = cs.date
 AND f.shift_type_id = cs.shift_type_id
WHERE GREATEST(0, COALESCE(t.target_count, 0) - COALESCE(f.n, 0)) > 0
ON CONFLICT (company_id, date, shift_type_id) DO UPDATE
  SET count = GREATEST(suppressed_open_slots.count, EXCLUDED.count);

DELETE FROM closed_shifts;
