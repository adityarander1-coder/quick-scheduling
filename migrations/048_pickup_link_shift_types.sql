-- Pickup links: support multiple shift types (checkboxes like broadcast).
ALTER TABLE pickup_links ADD COLUMN IF NOT EXISTS shift_type_ids UUID[];
UPDATE pickup_links SET shift_type_ids = ARRAY[shift_type_id] WHERE shift_type_id IS NOT NULL AND shift_type_ids IS NULL;
