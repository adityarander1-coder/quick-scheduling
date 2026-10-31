// util/pendingClarifications.ts — pending email clarification store.
// When the email engine can't build a plan it emails the sender asking
// for the missing detail and saves the original request here. A reply
// from the same sender is matched back to that request (thread headers
// first, then sender + subject), so a short reply like "Clinic" is
// planned together with the original ask instead of standing alone.
//
// One open row per (company, sender): saving a new clarification
// replaces the row, consuming a reply clears it, and rows older than
// 7 days never match (they are deleted lazily on lookup).

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface PendingClarification {
  id: string;
  company_id: string;
  sender_address: string;
  subject: string;
  original_body: string;
  missing: string;
  message_id: string | null;
  created_at: any;
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** "Re: Fwd: Assign Nancy" -> "assign nancy" (reply/forward prefixes stripped). */
export function normalizeSubject(subject: string): string {
  let s = String(subject || '').trim();
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim();
  }
  return s.toLowerCase();
}

/** Save (or replace) the open clarification for this sender. */
export async function savePendingClarification(
  query: QueryFn,
  companyId: string,
  senderAddress: string,
  subject: string,
  originalBody: string,
  missing: string,
  messageId: string | null
): Promise<void> {
  await query(
    `INSERT INTO pending_email_clarifications
       (company_id, sender_address, subject, original_body, missing, message_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (company_id, sender_address) DO UPDATE SET
       subject = EXCLUDED.subject,
       original_body = EXCLUDED.original_body,
       missing = EXCLUDED.missing,
       message_id = EXCLUDED.message_id,
       created_at = now()`,
    [companyId, senderAddress, subject, originalBody, missing, messageId]
  );
}

/** Remove the open clarification for this sender, if any. */
export async function clearPendingClarification(
  query: QueryFn, companyId: string, senderAddress: string
): Promise<void> {
  await query(
    'DELETE FROM pending_email_clarifications WHERE company_id = $1 AND sender_address = $2',
    [companyId, senderAddress]
  );
}

/**
 * Find the open clarification an incoming email replies to.
 * The caller has already verified the sender is staff of this company,
 * and the lookup is scoped to (company, sender) — a reply can never
 * match another sender's clarification. Match order:
 *   (a) In-Reply-To / References contains the clarification's message-id;
 *   (b) normalized subject matches and the row is younger than 7 days.
 * Stale rows are deleted and never match.
 */
export async function matchPendingClarification(
  query: QueryFn,
  companyId: string,
  senderAddress: string,
  opts: { inReplyTo?: string | null; references?: string | null; subject?: string | null }
): Promise<PendingClarification | null> {
  const { rows } = await query(
    `SELECT id, company_id, sender_address, subject, original_body, missing, message_id, created_at
     FROM pending_email_clarifications
     WHERE company_id = $1 AND sender_address = $2`,
    [companyId, senderAddress]
  );
  const row = rows[0] as PendingClarification | undefined;
  if (!row) return null;

  const ageMs = Date.now() - new Date(row.created_at).getTime();
  if (!(ageMs >= 0) || ageMs > MAX_AGE_MS) {
    await clearPendingClarification(query, companyId, senderAddress);
    return null;
  }

  // (a) Thread headers: the reply points at the clarification email.
  if (row.message_id) {
    const needle = row.message_id.replace(/[<>]/g, '').trim();
    const haystack = `${opts.inReplyTo || ''} ${opts.references || ''}`.replace(/[<>]/g, '');
    if (needle && haystack.includes(needle)) return row;
  }
  // (b) Same sender + same (normalized) subject.
  if (normalizeSubject(opts.subject || '') === normalizeSubject(row.subject)) return row;
  return null;
}
