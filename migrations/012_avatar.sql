-- Team member profile photo (small base64 data URL, resized client-side).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data TEXT;
