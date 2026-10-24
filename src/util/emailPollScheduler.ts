// util/emailPollScheduler.ts — polls each company's Gmail inbox for schedule
// change emails and creates pending plans. Runs on server startup and every
// 5 minutes.
//
// Per-company inboxes (Deepika 2026-10-24): a company connects its own Gmail
// mailbox in Settings → Email inbox (stored encrypted in company_inboxes).
// The scheduler polls every ACTIVE inbox row. The legacy single inbox from
// env vars (GMAIL_USER / GMAIL_APP_PASSWORD, pinned to GMAIL_COMPANY_ID) is
// still polled — but ONLY for a company that has no inbox row, so the same
// mailbox is never polled twice and the Test workspace keeps working.
import { query } from '../db.js';
import { pollInbox } from './emailPoller.js';
import { decryptInboxPassword } from './inboxCrypto.js';
import type { ImapCreds } from './gmailImap.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function pollOneCompany(companyId: string, companyName: string, creds: ImapCreds | undefined, inboxRowId: string | null): Promise<void> {
  try {
    const result = await pollInbox(query, companyId, creds);
    console.log(`[email-poll] ${companyName}: checked ${result.checked} email(s), created ${result.newPlans} plan(s)`);
    if (result.errors.length > 0) console.log(`[email-poll] ${companyName} errors:`, result.errors.join('; '));
    if (inboxRowId) {
      await query(
        'UPDATE company_inboxes SET last_polled_at = NOW(), last_error = $2 WHERE id = $1',
        [inboxRowId, result.errors.length ? result.errors.join('; ').slice(0, 500) : null]
      );
    }
  } catch (err: any) {
    console.log(`[email-poll] ${companyName} poll failed:`, err.message);
    if (inboxRowId) {
      await query('UPDATE company_inboxes SET last_error = $2 WHERE id = $1', [inboxRowId, String(err.message).slice(0, 500)]);
    }
  }
}

async function runPoll(): Promise<void> {
  try {
    // 1. Every company with an active inbox row.
    let inboxRows: any[] = [];
    try {
      const { rows } = await query(
        `SELECT ci.id, ci.company_id, ci.gmail_user, ci.gmail_app_password_enc, c.name
         FROM company_inboxes ci JOIN companies c ON c.id = ci.company_id
         WHERE ci.is_active = true`
      );
      inboxRows = rows;
    } catch (e: any) {
      // Table missing (migration not run yet) — fall through to legacy only.
      console.log('[email-poll] company_inboxes unavailable, legacy inbox only:', e.message);
    }
    const polledCompanyIds = new Set<string>();
    for (const row of inboxRows) {
      polledCompanyIds.add(String(row.company_id));
      let creds: ImapCreds | undefined;
      try {
        creds = { user: row.gmail_user, password: decryptInboxPassword(row.gmail_app_password_enc) };
      } catch (e: any) {
        console.log(`[email-poll] ${row.name}: stored inbox password unreadable:`, e.message);
        await query('UPDATE company_inboxes SET last_error = $2 WHERE id = $1', [row.id, 'Stored inbox password could not be decrypted — reconnect the inbox.']);
        continue;
      }
      await pollOneCompany(String(row.company_id), row.name, creds, String(row.id));
    }

    // 2. Legacy env inbox — only for a company WITHOUT an inbox row.
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      if (!inboxRows.length) console.log('[email-poll] Gmail not configured, skipping');
      return;
    }
    let legacyCompanyId = process.env.GMAIL_COMPANY_ID as string;
    let legacyName = 'legacy inbox';
    if (!legacyCompanyId) {
      const { rows } = await query(`
        SELECT c.id, c.name, COUNT(u.id) AS user_count
        FROM companies c
        LEFT JOIN users u ON u.company_id = c.id AND u.is_active = true
        GROUP BY c.id, c.name
        ORDER BY user_count DESC, c.created_at DESC
      `);
      if (!rows.length) return;
      legacyCompanyId = rows[0].id as string;
      legacyName = rows[0].name;
    } else {
      const { rows } = await query('SELECT name FROM companies WHERE id = $1', [legacyCompanyId]);
      if (rows.length) legacyName = rows[0].name;
    }
    if (polledCompanyIds.has(String(legacyCompanyId))) {
      console.log(`[email-poll] Legacy inbox skipped for ${legacyName}: company already has its own inbox.`);
      return;
    }
    await pollOneCompany(String(legacyCompanyId), legacyName, undefined, null);
  } catch (err: any) {
    console.error('[email-poll] Poll failed:', err.message);
  }
}

export function startEmailPollScheduler(): void {
  // Run once on startup (after a short delay to let server fully boot)
  setTimeout(runPoll, 30000);
  // Then every 5 minutes
  setInterval(runPoll, POLL_INTERVAL_MS);
  console.log('[email-poll] Scheduler started (every 5 min)');
}
