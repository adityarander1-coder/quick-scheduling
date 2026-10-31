// util/emailAttempts.ts — failed-processing attempts for polled emails,
// with a retry cap ("poison message" parking).
//
// Why: on 2026-10-28 one emailed request deterministically failed AI
// parsing, and the IMAP poller retried it on every 5-minute poll —
// 390 attempts in under 3 days, ≈$3 of Gemini credits — because a
// failed message simply stayed unread and was re-listed forever.
// The cap: after MAX_EMAIL_ATTEMPTS failed attempts a message is
// PARKED — the poller marks it read, records it here with its last
// error, and reports it once. It is never handed to the AI again.
//
// Records live in the per-company settings KV (company_settings, the
// batch-2 email_last_poll_at pattern — no migration), one row per
// message: key `email_attempt:<mailbox>:<uid>`. Scoping is therefore
// company (the KV's company_id) + mailbox + IMAP UID, matching the
// poller's own per-company seen-UID scoping. A success clears the
// record; records for messages that never reach the cap simply sit
// until the message succeeds or parks.

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

/** Failed attempts allowed before a message is parked. */
export const MAX_EMAIL_ATTEMPTS = 3;

export interface EmailAttemptRecord {
  /** Failed attempts so far. */
  count: number;
  /** Most recent failure's error text ('' when none recorded). */
  lastError: string;
  /** True once the cap was hit: the message is out of the retry set. */
  parked: boolean;
  firstFailedAt: string;
  lastFailedAt: string;
  parkedAt: string | null;
}

/** Mailboxes are identities (Gmail addresses) — case-insensitive. */
export function normalizeMailbox(mailbox: string): string {
  return String(mailbox || '').trim().toLowerCase() || 'unknown';
}

/** The company_settings key for one message's attempt record. */
export function emailAttemptKey(mailbox: string, uid: string): string {
  return `email_attempt:${normalizeMailbox(mailbox)}:${String(uid)}`;
}

/** Parse a stored record; anything malformed reads as "no record". */
export function parseEmailAttemptRecord(value: unknown): EmailAttemptRecord | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const o = JSON.parse(value);
    if (!o || typeof o.count !== 'number') return null;
    return {
      count: o.count,
      lastError: String(o.lastError || ''),
      parked: !!o.parked,
      firstFailedAt: String(o.firstFailedAt || ''),
      lastFailedAt: String(o.lastFailedAt || ''),
      parkedAt: o.parkedAt ? String(o.parkedAt) : null,
    };
  } catch {
    return null;
  }
}

/** The pure park decision: a record at (or past) the cap is parked. */
export function isParked(rec: EmailAttemptRecord | null): boolean {
  return !!rec && (rec.parked || rec.count >= MAX_EMAIL_ATTEMPTS);
}

/** The one-line report surfaced in the poll outcome when a message parks. */
export function parkedEmailReport(uid: string, rec: EmailAttemptRecord): string {
  return `Message ${uid}: could not be processed after ${rec.count} attempts — parked (marked read; it will not be retried). Last error: ${rec.lastError}`;
}

/** Read one message's attempt record (null = never failed / cleared). */
export async function getEmailAttempt(
  query: QueryFn, companyId: string, mailbox: string, uid: string
): Promise<EmailAttemptRecord | null> {
  const { rows } = await query(
    'SELECT value FROM company_settings WHERE company_id = $1 AND key = $2',
    [companyId, emailAttemptKey(mailbox, uid)]
  );
  return rows.length ? parseEmailAttemptRecord(rows[0].value) : null;
}

/**
 * Record one failed processing attempt and return the updated record.
 * The record is parked once the count reaches MAX_EMAIL_ATTEMPTS.
 */
export async function recordEmailFailure(
  query: QueryFn, companyId: string, mailbox: string, uid: string, error: string
): Promise<EmailAttemptRecord> {
  const prev = await getEmailAttempt(query, companyId, mailbox, uid);
  const now = new Date().toISOString();
  const count = (prev?.count || 0) + 1;
  const parked = count >= MAX_EMAIL_ATTEMPTS;
  const rec: EmailAttemptRecord = {
    count,
    lastError: String(error || 'Processing failed.').slice(0, 500),
    parked,
    firstFailedAt: prev?.firstFailedAt || now,
    lastFailedAt: now,
    parkedAt: parked ? (prev?.parkedAt || now) : null,
  };
  await query(
    `INSERT INTO company_settings (company_id, key, value, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [companyId, emailAttemptKey(mailbox, uid), JSON.stringify(rec)]
  );
  return rec;
}

/** A message that processed successfully loses its failure record. */
export async function clearEmailAttempt(
  query: QueryFn, companyId: string, mailbox: string, uid: string
): Promise<void> {
  await query(
    'DELETE FROM company_settings WHERE company_id = $1 AND key = $2',
    [companyId, emailAttemptKey(mailbox, uid)]
  );
}
