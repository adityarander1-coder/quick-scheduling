// util/emailPollScheduler.ts — polls Gmail inbox for schedule change emails
// and creates pending plans. Runs on server startup and every 15 minutes.
// Uses GMAIL_COMPANY_ID env var to know which company the inbox belongs to.
import { query } from '../db.js';
import { pollInbox } from './emailPoller.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function runPoll(): Promise<void> {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('[email-poll] Gmail not configured, skipping');
    return;
  }
  try {
    // Use configured company, or fall back to the company with the most active users
    // (the first-created company is often a test company)
    let companyId = process.env.GMAIL_COMPANY_ID as string;
    if (!companyId) {
      const { rows } = await query(`
        SELECT c.id, c.name, COUNT(u.id) AS user_count
        FROM companies c
        LEFT JOIN users u ON u.company_id = c.id AND u.is_active = true
        GROUP BY c.id, c.name
        ORDER BY user_count DESC, c.created_at DESC
      `);
      if (rows.length === 0) return;
      // Diagnostic: list all companies so the inbox owner can pin GMAIL_COMPANY_ID.
      console.log('[email-poll] Companies: ' + rows.map((r: any) => `${r.name} (${r.id}, ${r.user_count} users)`).join(' | '));
      const { rows: urows } = await query(
        `SELECT c.name AS company, u.first_name, u.last_name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.is_active = true ORDER BY c.name, u.first_name`
      );
      console.log('[email-poll] Users: ' + urows.map((u: any) => `${u.first_name} ${u.last_name || ''}`.trim() + '@' + u.company).join(' | '));
      companyId = rows[0].id as string;
      console.log(`[email-poll] Using company: ${rows[0].name} (${rows[0].user_count} users)`);
    }
    const result = await pollInbox(query, companyId);
    console.log(`[email-poll] Checked ${result.checked} email(s), created ${result.newPlans} plan(s)`);
    if (result.errors.length > 0) {
      console.log('[email-poll] Errors:', result.errors.join('; '));
    }
  } catch (err: any) {
    console.error('[email-poll] Poll failed:', err.message);
  }
}

export function startEmailPollScheduler(): void {
  // Run once on startup (after a short delay to let server fully boot)
  setTimeout(runPoll, 30000);
  // Then every 15 minutes
  setInterval(runPoll, POLL_INTERVAL_MS);
  console.log('[email-poll] Scheduler started (every 15 min)');
}
