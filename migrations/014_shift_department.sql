-- Shift types can belong to a specific department (NULL = shared across all departments).
ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shift_types_dept ON shift_types(department_id);
