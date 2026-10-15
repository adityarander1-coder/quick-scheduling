-- Add is_active to shift_types if missing (production table predates the column).
ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
