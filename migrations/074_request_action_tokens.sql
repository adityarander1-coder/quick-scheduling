-- 074_request_action_tokens.sql — login-free action links for shift
-- requests (Deepika 2026-11-02).
--
-- When someone asks for cover or proposes a swap, the people being
-- asked now also get an EMAIL with a personal link: cover recipients
-- can pick the shift up from the link, a swap partner can agree or
-- decline. The link opens a confirmation page (the tap on the page's
-- button is what acts, so mail scanners that prefetch links can't
-- claim a shift). One token per (request, person); the request's own
-- status is the guard — once decided, every link just reports that.

CREATE TABLE IF NOT EXISTS shift_request_action_tokens (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  company_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_srat_request ON shift_request_action_tokens (request_id);
CREATE INDEX IF NOT EXISTS idx_srat_token ON shift_request_action_tokens (token);
