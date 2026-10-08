-- Team member profile color (chosen from 6 swatches, shown on avatar).
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color TEXT;
