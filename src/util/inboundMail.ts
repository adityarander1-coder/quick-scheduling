// util/inboundMail.ts — in-app mailbox intake (Option E).
// The mail-receiving service (catch-all on the app's domain) POSTs each
// message to /api/inbound/email; this handler routes it, enforces the
// sender lock, dedupes provider retries, and runs it through the SAME
// plan engine the Gmail poller uses (processScheduleEmail).
//
// Rules (Deepika, 2026-10-24):
// - One address per department; mail never pools across companies/depts.
// - Only known staff addresses are processed; anyone else is rejected.
// - A message is never planned twice: dedupe by (address, message key),
//   and a retry reuses the original row, re-checking for an existing plan.

import crypto from 'crypto';
import { query } from '../db.js';
import { processScheduleEmail } from './emailPoller.js';
import { lookupInboundAddress, senderAllowed } from './inboundAddresses.js';

export interface InboundEmailInput {
  to: string;
  from: string;
  subject?: string;
  body?: string;
  messageId?: string;
}

export type InboundResult =
  | { status: 'processed'; kind: string; messageRowId: string; companyId: string; departmentId: string | null }
  | { status: 'rejected'; reason: 'unknown_address' | 'address_inactive' | 'sender_not_allowed'; companyId?: string; departmentId?: string | null }
  | { status: 'duplicate'; messageRowId: string; companyId: string; departmentId: string | null }
  | { status: 'failed'; error: string; messageRowId: string; companyId: string; departmentId: string | null };

/** "Name <addr@x>" -> addr@x; a bare local part passes through as-is. */
function parseAddress(raw: string): string {
  const m = String(raw || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(raw || '')).trim().toLowerCase();
}

function localPartOf(address: string): string {
  const at = address.indexOf('@');
  return at >= 0 ? address.slice(0, at) : address;
}

export async function handleInboundEmail(input: InboundEmailInput): Promise<InboundResult> {
  const toAddr = parseAddress(input.to);
  const toLocal = localPartOf(toAddr);
  const sender = parseAddress(input.from);
  const subject = String(input.subject || '');
  const body = String(input.body || '');

  const addr = await lookupInboundAddress(query, toLocal);
  if (!addr || !addr.is_active) {
    await query(
      `INSERT INTO inbound_messages (inbound_address_id, company_id, department_id, message_key, from_email, to_local_part, subject, body, status, reject_reason)
       VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, 'rejected', $7)`,
      [addr ? addr.id : null, `rejected:${Date.now()}:${Math.random()}`, sender, toLocal, subject, body,
       addr ? 'address_inactive' : 'unknown_address']
    );
    return { status: 'rejected', reason: addr ? 'address_inactive' : 'unknown_address' };
  }
  const companyId = addr.company_id;
  const departmentId = addr.department_id;

  // Sender lock: only people who work at this company may email its addresses.
  if (!(await senderAllowed(query, companyId, sender))) {
    await query(
      `INSERT INTO inbound_messages (inbound_address_id, company_id, department_id, message_key, from_email, to_local_part, subject, body, status, reject_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'rejected', 'sender_not_allowed')`,
      [addr.id, companyId, departmentId, `rejected:${Date.now()}:${Math.random()}`, sender, toLocal, subject, body]
    );
    return { status: 'rejected', reason: 'sender_not_allowed', companyId, departmentId };
  }

  const messageKey = (input.messageId || '').trim()
    || crypto.createHash('sha256').update(`${addr.local_part}\n${sender}\n${subject}\n${body}`).digest('hex');

  // Insert, or reuse the row on a provider retry (unique index guards the race).
  let rowId: string | null = null;
  const inserted = await query(
    `INSERT INTO inbound_messages (inbound_address_id, company_id, department_id, message_key, from_email, to_local_part, subject, body, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'received')
     ON CONFLICT (inbound_address_id, message_key) WHERE inbound_address_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [addr.id, companyId, departmentId, messageKey, sender, toLocal, subject, body]
  );
  if (inserted.rows[0]) {
    rowId = String(inserted.rows[0].id);
  } else {
    const { rows } = await query(
      'SELECT id, status FROM inbound_messages WHERE inbound_address_id = $1 AND message_key = $2',
      [addr.id, messageKey]
    );
    rowId = String(rows[0].id);
    // Never plan twice: if a plan already exists for this row, the first
    // attempt got that far — mark it processed and stop.
    const { rows: planRows } = await query(
      'SELECT 1 FROM schedule_plans WHERE company_id = $1 AND source_email_id = $2 LIMIT 1',
      [companyId, `inbound:${rowId}`]
    );
    if (planRows.length || rows[0].status === 'processed') {
      await query(
        "UPDATE inbound_messages SET status = 'processed', processed_at = NOW() WHERE id = $1",
        [rowId]
      );
      return { status: 'duplicate', messageRowId: rowId, companyId, departmentId };
    }
    await query(
      "UPDATE inbound_messages SET status = 'received', from_email = $2, subject = $3, body = $4 WHERE id = $1",
      [rowId, sender, subject, body]
    );
  }
  if (!rowId) throw new Error('Inbound message row missing.');

  const engineResult = { checked: 1, newPlans: 0, questionsAnswered: 0, errors: [] as string[] };
  const outcome = await processScheduleEmail(
    query, companyId,
    { from: sender, fromName: null, cc: null, subject, body, attachments: [] },
    `inbound:${rowId}`,
    engineResult,
    { departmentId: departmentId || undefined }
  );
  if (!outcome) {
    const error = engineResult.errors[0] || 'Processing failed.';
    await query(
      "UPDATE inbound_messages SET status = 'failed', error = $2 WHERE id = $1",
      [rowId, error]
    );
    return { status: 'failed', error, messageRowId: rowId, companyId, departmentId };
  }
  if (outcome.kind === 'question_failed') {
    const error = engineResult.errors[0] || 'Answering failed.';
    await query(
      "UPDATE inbound_messages SET status = 'failed', error = $2 WHERE id = $1",
      [rowId, error]
    );
    return { status: 'failed', error, messageRowId: rowId, companyId, departmentId };
  }
  await query(
    "UPDATE inbound_messages SET status = 'processed', processed_at = NOW() WHERE id = $1",
    [rowId]
  );
  return { status: 'processed', kind: outcome.kind, messageRowId: rowId, companyId, departmentId };
}
