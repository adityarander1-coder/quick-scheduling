-- 065_inbound_addresses.sql
-- In-app mailboxes (Option E, Deepika approved 2026-10-24): each department
-- gets its OWN inbound address on the app's domain (one address per
-- department, never pooled across companies or departments). The app is the
-- receiver: a catch-all rule on the domain hands every address to the
-- webhook, which resolves the local part here. No mailbox is ever created
-- for these addresses — they are routing keys, not logins.
-- Sending domain: INBOUND_DOMAIN env (unset until the lawyer clears a
-- domain). Until then, addresses exist as local parts only and the webhook
-- still routes by local part, so the whole flow is testable without one.
CREATE TABLE IF NOT EXISTS inbound_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  department_id UUID REFERENCES departments(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_inbound_company_dept UNIQUE (company_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_addresses_company ON inbound_addresses (company_id);
-- At most one company-level (department-less) address per company: Postgres
-- treats NULLs as distinct in a UNIQUE constraint, so this needs its own index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_company_address
  ON inbound_addresses (company_id) WHERE department_id IS NULL;

-- Every inbound message is recorded, including rejects: the sender lock
-- (only known staff addresses are processed) must be auditable, and
-- provider retries must not double-process a message (message_key).
CREATE TABLE IF NOT EXISTS inbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbound_address_id UUID REFERENCES inbound_addresses(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
  message_key TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_local_part TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received',
  reject_reason TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_inbound_messages_dedupe
  ON inbound_messages (inbound_address_id, message_key)
  WHERE inbound_address_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_messages_company ON inbound_messages (company_id, created_at DESC);
