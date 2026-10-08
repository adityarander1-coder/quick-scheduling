-- Candidate profile photo and special instructions (carried over on approval).
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS avatar_data TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS special_instructions TEXT;
