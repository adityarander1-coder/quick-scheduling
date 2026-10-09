-- Allow negative slot adjustments (removing individual open slots).
ALTER TABLE extra_open_slots DROP CONSTRAINT IF EXISTS extra_open_slots_count_check;
ALTER TABLE extra_open_slots ADD CONSTRAINT extra_open_slots_count_check CHECK (count <> 0);
