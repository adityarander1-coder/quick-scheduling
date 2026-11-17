-- 111_draft_open_slots.sql — Per-slot open publish state (Deepika, 2026-11-17):
-- open slots are COMPUTED (target + extra - filled), so a single slot's
-- draft/published state has no stored row to live on. It lives here as
-- a per-date+type DRAFT-OPEN COUNT: N of that date+type's computed
-- opens are draft (grey with a DRAFT badge on the manager grid, hidden
-- from employees, unclaimable); the rest are published. Absent row = 0
-- = today's behaviour (all published). Positions are fungible — the
-- count attaches to the first N rendered positions, not to a slot
-- identity — so a count set while 2 opens exist still reads as "1
-- draft" if a third open appears later; the manager flips it back from
-- the menu. The row is deleted at 0 (same rule as extra_open_slots).
CREATE TABLE IF NOT EXISTS draft_open_slots (
  company_id text NOT NULL,
  date date NOT NULL,
  shift_type_id text NOT NULL,
  count int NOT NULL CHECK (count > 0),
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS draft_open_slots_company_idx
  ON draft_open_slots (company_id, date);
