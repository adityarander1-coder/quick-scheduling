-- 113_schedule_undo_history.sql — Persistent 3-step Undo/Redo (Deepika, 2026-11-17):
-- Undo/Redo used to live only in the open page (in-page qsUndoStack /
-- qsRedoStack, cap 10) — a reload wiped it. Deepika asked for up to
-- THREE undos and three redos that survive a reload, on her phone and
-- her computer alike, so the last 3 undoable actions (and their redo
-- counterparts) are stored server-side, per user per company. One row
-- per (company, user); the client is the source of truth for ordering
-- and POSTs the whole stacks (capped at 3) whenever they change; the
-- page loads them back at login. Entries are the same shapes the
-- client stacks already hold (drag move/swap, single + bulk delete);
-- the existing server guards (delete-undo no-overwrite rules, Rule 7,
-- drag-undo op checks) still decide whether a restored entry applies.
-- No row is ever written for task undo — that stays server-side as it
-- is (src/util/planUndo.ts).
CREATE TABLE IF NOT EXISTS schedule_undo_history (
  company_id text NOT NULL,
  user_id text NOT NULL,
  undo_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
  redo_stack jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);
