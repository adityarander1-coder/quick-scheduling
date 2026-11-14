-- 108_department_schedule_modes.sql — Per-department draft mode
-- (Deepika, 2026-11-14): each department picks its own schedule mode —
-- 'live' (rotations fill the schedule in on their own) or 'generated'
-- (nothing appears until drafted from the rotations). The per-company
-- flag in company_settings ('schedule_mode', migration 107) is retired:
-- it was never deployed and no company ever flipped it, so the seed
-- below is a safety net only — every department starts 'live' unless
-- its company had a value set.
--
-- Why a table, not a column on departments: departments have no
-- per-department settings column anywhere in the codebase (their
-- settings live in company_settings / department-scoped rows), and a
-- separate table keeps the mode read/write in one place with the
-- company id on the row for the existing query patterns.
CREATE TABLE IF NOT EXISTS department_schedule_modes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'live' CHECK (mode IN ('live', 'generated')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, department_id)
);
CREATE INDEX IF NOT EXISTS department_schedule_modes_company_idx
  ON department_schedule_modes (company_id, department_id);

-- Seed from the old per-company flag where one was ever set; the
-- default 'live' covers everything else (including every production
-- department, which never flipped).
INSERT INTO department_schedule_modes (company_id, department_id, mode)
SELECT cs.company_id, d.id, cs.value
FROM company_settings cs
JOIN departments d ON d.company_id = cs.company_id
WHERE cs.key = 'schedule_mode' AND cs.value IN ('live', 'generated')
ON CONFLICT (company_id, department_id) DO NOTHING;
