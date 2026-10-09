// util/emailPollScheduler.ts — polls Gmail inbox for schedule change emails
// and creates pending plans. Runs on server startup and every 15 minutes.
// Uses GMAIL_COMPANY_ID env var to know which company the inbox belongs to.
import { query } from '../db.js';
import { pollInbox } from './emailPoller.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

async function runPoll(): Promise<void> {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.log('[email-poll] Gmail not configured, skipping');
    return;
  }
  try {
    // Use configured company, or fall back to the first company
    let companyId = process.env.GMAIL_COMPANY_ID as string;
    if (!companyId) {
      const { rows } = await query(`SELECT id FROM companies ORDER BY created_at LIMIT 1`);
      if (rows.length === 0) return;
      companyId = rows[0].id as string;
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
