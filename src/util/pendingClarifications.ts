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
  /** Structured name-ambiguity items (migration 103), or null when
   * the question is open-ended and prose is the only door. */
  options: { items: any[] } | null;
  /** Picks recorded so far: item index (string key) -> user id. */
  answers: Record<string, string>;
  /** Unguessable token for the answer page; dies with the row. */
  answer_token: string | null;
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** True when the row is past the 7-day match window. */
export function clarificationExpired(row: { created_at: any }): boolean {
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return !(ageMs >= 0) || ageMs > MAX_AGE_MS;
}

const ROW_COLUMNS = 'id, company_id, sender_address, subject, original_body, missing, message_id, created_at, options, answers, answer_token';

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

/** Save (or replace) the open clarification for this sender.
 * `extras` carries the clickable-options payload (migration 103):
 * a fresh clarification always starts with empty answers, and a
 * replace without extras clears any previous options/token. */
export async function savePendingClarification(
  query: QueryFn,
  companyId: string,
  senderAddress: string,
  subject: string,
  originalBody: string,
  missing: string,
  messageId: string | null,
  extras?: { options?: { items: any[] } | null; answerToken?: string | null }
): Promise<void> {
  await query(
    `INSERT INTO pending_email_clarifications
       (company_id, sender_address, subject, original_body, missing, message_id, options, answers, answer_token)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8)
     ON CONFLICT (company_id, sender_address) DO UPDATE SET
       subject = EXCLUDED.subject,
       original_body = EXCLUDED.original_body,
       missing = EXCLUDED.missing,
       message_id = EXCLUDED.message_id,
       options = EXCLUDED.options,
       answers = '{}'::jsonb,
       answer_token = EXCLUDED.answer_token,
       created_at = now()`,
    [companyId, senderAddress, subject, originalBody, missing, messageId,
     extras?.options ? JSON.stringify(extras.options) : null,
     extras?.answerToken || null]
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
    `SELECT ${ROW_COLUMNS}
     FROM pending_email_clarifications
     WHERE company_id = $1 AND sender_address = $2`,
    [companyId, senderAddress]
  );
  const row = rows[0] as PendingClarification | undefined;
  if (!row) return null;

  if (clarificationExpired(row)) {
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

// ---------------------------------------------------------------------------
// Clickable options (Deepika, 2026-11-10): the answer page loads the
// row by its token — the token IS the auth, scoped to this one
// clarification. Recording an answer never deletes the row; only
// completion (all items answered) claims it, and whichever door
// resolves the clarification first (click completion, prose reply,
// form) deletes the row, so every later click lands on the friendly
// "already answered" page.
// ---------------------------------------------------------------------------

/** Load the open clarification an answer-page token points at. */
export async function loadClarificationByToken(
  query: QueryFn, token: string
): Promise<PendingClarification | null> {
  if (!token || token.length < 16) return null;
  const { rows } = await query(
    `SELECT ${ROW_COLUMNS} FROM pending_email_clarifications WHERE answer_token = $1`,
    [token]
  );
  return rows.length ? (rows[0] as PendingClarification) : null;
}

/** Persist the picks recorded so far for a clarification. */
export async function recordClarificationAnswers(
  query: QueryFn, id: string, answers: Record<string, string>
): Promise<void> {
  await query(
    'UPDATE pending_email_clarifications SET answers = $2 WHERE id = $1',
    [id, JSON.stringify(answers)]
  );
}

/**
 * Atomically claim a fully-answered clarification for completion:
 * the delete IS the claim — exactly one completion can win it, and
 * claiming also closes the clarification for every other door.
 * Returns the claimed row, or null when it was already resolved.
 */
export async function claimClarification(
  query: QueryFn, id: string
): Promise<PendingClarification | null> {
  const { rows } = await query(
    `DELETE FROM pending_email_clarifications WHERE id = $1 RETURNING ${ROW_COLUMNS}`,
    [id]
  );
  return rows.length ? (rows[0] as PendingClarification) : null;
}

/** Put a claimed row back (the completion run failed before it could
 * resolve anything, so the sender keeps their question). */
export async function restoreClarification(
  query: QueryFn, row: PendingClarification
): Promise<void> {
  await query(
    `INSERT INTO pending_email_clarifications
       (id, company_id, sender_address, subject, original_body, missing, message_id, options, answers, answer_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (company_id, sender_address) DO UPDATE SET
       subject = EXCLUDED.subject,
       original_body = EXCLUDED.original_body,
       missing = EXCLUDED.missing,
       message_id = EXCLUDED.message_id,
       options = EXCLUDED.options,
       answers = EXCLUDED.answers,
       answer_token = EXCLUDED.answer_token,
       created_at = EXCLUDED.created_at`,
    [row.id, row.company_id, row.sender_address, row.subject, row.original_body, row.missing,
     row.message_id, row.options ? JSON.stringify(row.options) : null,
     JSON.stringify(row.answers || {}), row.answer_token, row.created_at]
  );
}

// ---------------------------------------------------------------------------
// Processed-message idempotency (Deepika, 2026-11-11 — the one-email
// fix): EVERY message the poller finishes processing is recorded
// here — plan_created, clarification_sent, and skipped alike —
// keyed by (company_id, source_email_id). pollInbox skips recorded
// ids, so a second tick, a manual re-poll, or a failed markRead
// can never re-process a message and send a second clarification
// email. A clarification REPLY is a different message id and is
// recorded in its own right, so the reply path keeps working.
// (Migration 104 — processed_schedule_emails.)
// ---------------------------------------------------------------------------

/** Record that a message was processed. A failed record must not
 * fail the processing itself — worst case a duplicate poll is
 * possible, not a lost plan. */
export async function recordProcessedMessage(
  query: QueryFn, companyId: string, sourceEmailId: string, outcome: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO processed_schedule_emails (company_id, source_email_id, outcome)
       VALUES ($1, $2, $3)
       ON CONFLICT (company_id, source_email_id) DO NOTHING`,
      [companyId, sourceEmailId, outcome]
    );
  } catch (e: any) {
    console.error('[processed] could not record', sourceEmailId, e?.message);
  }
}

/** True when this message was already processed. */
export async function hasProcessedMessage(
  query: QueryFn, companyId: string, sourceEmailId: string
): Promise<boolean> {
  try {
    const { rows } = await query(
      `SELECT 1 FROM processed_schedule_emails WHERE company_id = $1 AND source_email_id = $2 LIMIT 1`,
      [companyId, sourceEmailId]
    );
    return rows.length > 0;
  } catch (e: any) {
    // If the table is missing (pre-migration deploy), never block
    // processing — the older plan-row + Seen-flag checks still run.
    if (e?.code === '42P01') return false;
    throw e;
  }
}
