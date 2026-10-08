-- Per-shift publish state. A shift is visible as published only when both its date
-- is published AND the shift itself is published.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE;

-- Per-shift publish overrides for rotation-generated shifts (which don't live in shifts).
CREATE TABLE IF NOT EXISTS rotation_shift_publish (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rotation_id UUID NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  shift_type_id UUID NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  published BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, rotation_id, user_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS idx_rotshiftpub_lookup ON rotation_shift_publish (company_id, rotation_id, user_id, date);
