-- Rotation start/end times and notes.
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS start_time TIME;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS end_time TIME;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS notes TEXT;
