-- Add updated_at to shifts table (was referenced in code but never created).
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
