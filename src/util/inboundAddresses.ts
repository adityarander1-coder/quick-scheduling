// util/inboundAddresses.ts — in-app mailbox address book (Option E).
// Pure DB helpers: no dependency on the email engine, so both the poller
// (for outbound From) and the webhook handler can use them without a cycle.
//
// Model (Deepika's decisions, 2026-10-24):
// - One address per DEPARTMENT, never pooled across companies/departments.
// - Only known staff addresses may send to it (sender lock, enforced in
//   inboundMail.ts, not here).
// - Addresses are routing keys, not mailboxes: nobody logs into them.
// - Full address = local_part + '@' + INBOUND_DOMAIN. The domain is unset
//   until the lawyer clears one, so local parts are usable (and testable)
//   on their own until then.

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface InboundAddressRow {
  id: string;
  company_id: string;
  department_id: string | null;
  local_part: string;
  is_active: boolean;
}

/** Sending/receiving domain for in-app addresses, or null when unset. */
export function inboundDomain(): string | null {
  const d = (process.env.INBOUND_DOMAIN || '').trim().toLowerCase();
  return d || null;
}

/** Full address for a local part, or the bare local part when no domain yet. */
export function fullInboundAddress(localPart: string): string {
  const domain = inboundDomain();
  return domain ? `${localPart}@${domain}` : localPart;
}

function slug(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'dept';
}

/** Find an address row by local part (case-insensitive). */
export async function lookupInboundAddress(
  query: QueryFn, localPart: string
): Promise<InboundAddressRow | null> {
  const { rows } = await query(
    'SELECT id, company_id, department_id, local_part, is_active FROM inbound_addresses WHERE lower(local_part) = lower($1)',
    [localPart]
  );
  return rows[0] || null;
}

/**
 * Get or create the inbound address for a company (department_id null) or
 * one department. Local part is company-slug + department-slug, with a
 * numeric suffix on collision (two companies may both have an "ER").
 */
export async function ensureInboundAddress(
  query: QueryFn, companyId: string, departmentId: string | null
): Promise<InboundAddressRow> {
  const existing = await query(
    departmentId
      ? 'SELECT id, company_id, department_id, local_part, is_active FROM inbound_addresses WHERE company_id = $1 AND department_id = $2'
      : 'SELECT id, company_id, department_id, local_part, is_active FROM inbound_addresses WHERE company_id = $1 AND department_id IS NULL',
    departmentId ? [companyId, departmentId] : [companyId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const { rows: cRows } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
  const companySlug = slug(cRows[0]?.name || 'company');
  let base = companySlug;
  if (departmentId) {
    const { rows: dRows } = await query(
      'SELECT name FROM departments WHERE id = $1 AND company_id = $2', [departmentId, companyId]);
    if (!dRows[0]) throw new Error('Department not found in this company.');
    base = `${companySlug}-${slug(dRows[0].name)}`;
  }
  let localPart = base;
  let suffix = 2;
  while (await lookupInboundAddress(query, localPart)) {
    localPart = `${base}-${suffix++}`;
  }
  const { rows } = await query(
    `INSERT INTO inbound_addresses (company_id, department_id, local_part)
     VALUES ($1, $2, $3)
     RETURNING id, company_id, department_id, local_part, is_active`,
    [companyId, departmentId, localPart]
  );
  return rows[0];
}

/** Sender lock: is this email an active team member of this company? */
export async function senderAllowed(
  query: QueryFn, companyId: string, email: string
): Promise<boolean> {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return false;
  const { rows } = await query(
    'SELECT 1 FROM users WHERE company_id = $1 AND lower(email) = $2 AND is_active = true LIMIT 1',
    [companyId, clean]
  );
  return rows.length > 0;
}

/**
 * Outbound From for mail about a department: "Quick Scheduling
 * <local@domain>" when a sending domain is configured AND the department
 * has an address, else null (caller falls back to the default From).
 * Resend can only send from a verified domain, so a configured-but-
 * unverified domain must still fall back — the caller treats a send
 * failure as non-fatal, and operators verify the domain at go-live.
 */
export async function outboundFromFor(
  query: QueryFn, companyId: string, departmentId: string
): Promise<string | null> {
  const domain = inboundDomain();
  if (!domain) return null;
  const { rows } = await query(
    'SELECT local_part FROM inbound_addresses WHERE company_id = $1 AND department_id = $2 AND is_active = true',
    [companyId, departmentId]
  );
  if (!rows[0]) return null;
  return `Quick Scheduling <${rows[0].local_part}@${domain}>`;
}
