-- Shift types can belong to multiple departments (e.g. a "Red Team" shift
-- spanning Internal Medicine and Internal Medicine Residency).
CREATE TABLE IF NOT EXISTS shift_type_departments (
  shift_type_id UUID NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY (shift_type_id, department_id)
);

-- Migrate existing single-department assignments.
INSERT INTO shift_type_departments (shift_type_id, department_id)
SELECT id, department_id FROM shift_types
WHERE department_id IS NOT NULL
ON CONFLICT DO NOTHING;
