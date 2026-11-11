-- 103_clarification_click_options.sql
-- Clickable clarification options (Deepika, 2026-11-10): when the
-- email engine's question is a name ambiguity, the candidate set is
-- stored WITH the pending clarification so the question can be
-- answered by tapping a name (email one-tap links + an answer page)
-- instead of only by prose. `options` holds the structured items
-- (fragment as written + candidate user ids/names), `answers` the
-- picks recorded so far (item index -> user id), and `answer_token`
-- the unguessable token that opens the answer page (the token IS
-- the auth, like the form and approver links). The token lives and
-- dies with the row: a reply, a form submission, or the final click
-- resolving the clarification deletes the row and kills the links.
ALTER TABLE pending_email_clarifications
  ADD COLUMN IF NOT EXISTS options JSONB,
  ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS answer_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS pending_email_clarifications_answer_token_idx
  ON pending_email_clarifications (answer_token) WHERE answer_token IS NOT NULL;
