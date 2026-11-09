-- 101_publish_batches.sql
-- Publish schedule (Deepika, 2026-11-09 — Step 2 of Pattern ≠
-- Schedule, the easy way): a pattern is only a draft until a manager
-- publishes a range, which STAMPS the drawn occurrences into real
-- shifts. Every stamped shift records its provenance (which batch,
-- which rotation) so a later publish can offer pattern-changed
-- republish (removes only ever target batch-created shifts) and a
-- batch can be undone without touching hand-made shifts or the past.
CREATE TABLE IF NOT EXISTS publish_batches (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  range_start date NOT NULL,
  range_end date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS publish_batches_company_idx ON publish_batches (company_id, created_at DESC);

ALTER TABLE shifts ADD COLUMN IF NOT EXISTS publish_batch_id uuid REFERENCES publish_batches(id) ON DELETE SET NULL;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS rotation_id uuid REFERENCES rotations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS shifts_publish_batch_idx ON shifts (publish_batch_id);

-- Rule 7 ledger: when a person's last working day falls inside a
-- published range, the shifts they would have worked after it are
-- stamped as open-for-cover slots (extra_open_slots increments — the
-- representation Short cover, pickup links and gap offers already
-- consume). This ledger records what each batch opened, per rotation,
-- so a re-publish can close slots the pattern no longer produces and
-- an undo can take back exactly its own slots.
CREATE TABLE IF NOT EXISTS publish_batch_open_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  rotation_id uuid NOT NULL REFERENCES rotations(id) ON DELETE CASCADE,
  date date NOT NULL,
  shift_type_id uuid NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  count int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, rotation_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS publish_open_slots_lookup ON publish_batch_open_slots (company_id, rotation_id, date);
