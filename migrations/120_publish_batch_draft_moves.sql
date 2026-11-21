-- 120_publish_batch_draft_moves.sql — Ledger for the draft shortfall a
-- publish moves into published opens (Deepika, 2026-11-20 — detached
-- open slots: once drafted, detached).
--
-- A publish converts the draft's stored shortfall (draft_open_slots)
-- into published opens by moving the count into extra_open_slots.
-- Undoing that publish must put the opens back to draft — exactly the
-- amount the publish moved, not a recomputation from the target (the
-- target may have changed since, and the draft is detached from it).
-- So the publish records each move here, keyed by batch; the batch
-- undo reads it back, consumes that many extras, and restores the
-- draft count. No row is ever written for the bulk-publish-state
-- flip path or an AI publish — neither has a batch to undo against,
-- and unpublishing there leaves the opens alone, as before.
CREATE TABLE IF NOT EXISTS publish_batch_draft_moves (
  batch_id uuid NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date date NOT NULL,
  shift_type_id uuid NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  count int NOT NULL CHECK (count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, date, shift_type_id)
);
CREATE INDEX IF NOT EXISTS publish_batch_draft_moves_company_idx
  ON publish_batch_draft_moves (company_id, date);
