-- 082_rotation_groups.sql
-- Rotation groups (Deepika 2026-11-04): named, ordered lists of team
-- members. A rotation can be set to "group mode": instead of everyone
-- working every occurrence, the group's members take turns in their
-- fixed order for the rotation's shift type — a "special shift" that
-- takes precedence over the person's other rotation occurrences.
CREATE TABLE IF NOT EXISTS rotation_groups (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rotation_groups_company_idx ON rotation_groups (company_id);

CREATE TABLE IF NOT EXISTS rotation_group_members (
  group_id uuid NOT NULL REFERENCES rotation_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position int NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS rotation_group_members_group_idx ON rotation_group_members (group_id, position);

ALTER TABLE rotations ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES rotation_groups(id) ON DELETE SET NULL;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS group_shift_type_id uuid REFERENCES shift_types(id) ON DELETE SET NULL;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS group_days text;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS turn_unit text;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS turn_days int;
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS week_start int;
