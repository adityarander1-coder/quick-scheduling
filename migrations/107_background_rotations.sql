-- 107_background_rotations.sql — Background rotations (Deepika, 2026-11-13):
-- rotations become patterns only; the schedule is DRAFTED from them into
-- stored rows, then published like today. Stage 0 schema foundations:
-- generation provenance on shifts, the generation batch table, the
-- rule-7 open-slot ledger, and a change marker on rotations (D6 badge).
-- All additive; every existing query is unaffected. The mode flag lives
-- in company_settings ('schedule_mode' = 'live' | 'generated', default
-- 'live') — no companies-table change needed.

-- Generation batches: one row per draft action (one rotation, one range).
-- rotation_id SET NULL on rotation delete: pattern delete must never
-- touch a made schedule, and the generation record (with its snapshot
-- name) survives as history. published_at is stamped by the publish
-- flow when the generation's rows are published (informational).
CREATE TABLE IF NOT EXISTS rotation_generations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rotation_id uuid REFERENCES rotations(id) ON DELETE SET NULL,
  rotation_name text,
  range_start date NOT NULL,
  range_end date NOT NULL,
  mode text NOT NULL DEFAULT 'fresh',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS rotation_generations_company_idx
  ON rotation_generations (company_id, rotation_id, created_at DESC);

-- Provenance: which generation a stored shift came from (NULL = hand-made
-- or live-mode publish stamp). Re-draft replaces still-draft rows by
-- rotation_id, never by generation_id alone — a fresh re-draft replaces
-- every still-draft row of that rotation in the range.
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS generation_id uuid
  REFERENCES rotation_generations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS shifts_generation_idx ON shifts (generation_id);

-- Rule 7 open-slot ledger (generation edition of publish_batch_open_slots):
-- when a per-person rotation's assignee has passed their last working day,
-- the shifts they would have worked come out as open slots in the draft.
-- The ledger records what each generation opened, per date+type, so a
-- fresh re-draft can take back exactly its own slots.
CREATE TABLE IF NOT EXISTS generation_open_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  generation_id uuid NOT NULL REFERENCES rotation_generations(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  shift_type_id uuid NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  count int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (generation_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS generation_open_slots_lookup
  ON generation_open_slots (company_id, generation_id, date);

-- D6 "pattern changed since last generation" badge: a change marker on
-- the rotation itself. Backfilled from created_at; the app bumps it on
-- every pattern mutation (rotation edit, assignment change, group
-- membership change, pause change) via touchRotation().
ALTER TABLE rotations ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
UPDATE rotations SET updated_at = created_at WHERE updated_at IS NULL OR updated_at < created_at;
