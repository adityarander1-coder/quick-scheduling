-- 102_publish_batch_flips.sql
-- Unified publish door (Deepika, 2026-11-10): the Bulk Actions
-- "Publish shifts" action becomes THE publish. Besides stamping
-- pattern occurrences (migration 101's batches), a publish now also
-- flips existing hand-made DRAFT shifts in scope to published — the
-- job the old bulk door did — and this ledger records exactly which
-- stored shifts each batch flipped, so Undo can flip back precisely
-- its own rows (future ones; the past stays truth) without ever
-- touching a draft the batch did not flip.
CREATE TABLE IF NOT EXISTS publish_batch_flips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, shift_id)
);
CREATE INDEX IF NOT EXISTS publish_batch_flips_batch_idx ON publish_batch_flips (batch_id);
