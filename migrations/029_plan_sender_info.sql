-- Store sender name and CC for plan display
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS source_from_name TEXT;
ALTER TABLE schedule_plans ADD COLUMN IF NOT EXISTS source_cc TEXT;
