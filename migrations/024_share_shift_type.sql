-- Allow schedule share links to be scoped to a shift type as well.
ALTER TABLE schedule_shares ADD COLUMN IF NOT EXISTS shift_type_id UUID REFERENCES shift_types(id) ON DELETE CASCADE;
