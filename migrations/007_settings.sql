-- 007_settings.sql — Phase 3: Settings (staffing targets, shift time defaults).
-- Staffing targets: how many of each shift type are needed per day.
-- Shift settings: default start/end times per shift type.

CREATE TABLE IF NOT EXISTS staffing_targets (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_type_id uuid NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  target_count int NOT NULL DEFAULT 0 CHECK (target_count >= 0 AND target_count <= 20),
  weekdays int[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  start_date date,
  end_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, shift_type_id)
);
CREATE INDEX IF NOT EXISTS staffing_targets_company_id_idx ON staffing_targets (company_id);
