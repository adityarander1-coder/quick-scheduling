-- Shareable pickup links: no-login page showing ONLY open shifts in a date range.
CREATE TABLE IF NOT EXISTS pickup_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
  shift_type_id UUID REFERENCES shift_types(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pickup_links_company ON pickup_links(company_id);
