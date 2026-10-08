-- Team member special instructions (e.g., "Prefers night shifts", "No weekends").
ALTER TABLE users ADD COLUMN IF NOT EXISTS special_instructions TEXT;
