-- 110_draft_open_shortfall.sql — Draft-open rule (Deepika, 2026-11-14):
-- when a shift type is drafted from the rotation, the draft also opens
-- the positions still needed (staffing-target shortfall), owned by the
-- generation. The shortfall lives in generation_open_slots alongside
-- the rule-7 opens, distinguished by kind — it is NEVER added to
-- extra_open_slots, so the grid's target math (target + extra -
-- filled) keeps counting the shortfall exactly once. A generation can
-- hold both a rule-7 row and a shortfall row for the same date+type,
-- so the per-generation unique key gains kind.
ALTER TABLE generation_open_slots
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'rule7'
  CHECK (kind IN ('rule7', 'shortfall'));
-- Drop the old per-generation unique (generation_id, date,
-- shift_type_id) so a rule-7 row and a shortfall row can coexist for
-- the same date+type, and replace it with the kind-aware key.
ALTER TABLE generation_open_slots
  DROP CONSTRAINT IF EXISTS generation_open_slots_generation_id_date_shift_type_id_key;
ALTER TABLE generation_open_slots
  ADD CONSTRAINT generation_open_slots_gen_date_type_kind_key
  UNIQUE (generation_id, date, shift_type_id, kind);
CREATE INDEX IF NOT EXISTS generation_open_slots_shortfall_idx
  ON generation_open_slots (company_id, shift_type_id, date)
  WHERE kind = 'shortfall';
