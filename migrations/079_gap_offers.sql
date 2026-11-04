-- Gap offers (Deepika 2026-11-04): from a Short cover gap, a scheduler
-- offers the shift to staff who marked themselves available on the
-- availability link. Each recipient gets a personal login-free token
-- (same pattern as shift_request_action_tokens, migration 074): the
-- email link opens a confirmation page and the page's button claims —
-- first pickup wins, the claim creates the shift.
CREATE TABLE IF NOT EXISTS gap_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  shift_type_id UUID NOT NULL REFERENCES shift_types(id) ON DELETE CASCADE,
  needed INT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gap_offers_company ON gap_offers(company_id, date);

CREATE TABLE IF NOT EXISTS gap_offer_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID NOT NULL REFERENCES gap_offers(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  claimed_shift_id UUID REFERENCES shifts(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offer_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gap_offer_recipients_offer ON gap_offer_recipients(offer_id);
