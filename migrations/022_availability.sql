-- Availability requests: shareable links for staff to submit availability (no login).
CREATE TABLE IF NOT EXISTS availability_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  title TEXT,
  note TEXT,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avail_req_company ON availability_requests(company_id);

CREATE TABLE IF NOT EXISTS availability_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES availability_requests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  date DATE NOT NULL,
  available BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, name, date)
);
CREATE INDEX IF NOT EXISTS idx_avail_resp_request ON availability_responses(request_id);
