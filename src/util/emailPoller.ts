/**
 * Email polling service: Gmail inbox → Gemini parsing → Schedule plans.
 * Runs on a schedule, processes new unread emails into pending plans.
 */

import { listUnreadMessages, getMessage, markAsRead } from './gmail.js';
import { planFromEmail } from './gemini.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

/**
 * Poll the Gmail inbox for new schedule change emails.
 * Creates pending plans for Deepika to approve. Never modifies the schedule directly.
 */
export async function pollInbox(query: QueryFn, companyId: string): Promise<{
  checked: number;
  newPlans: number;
  errors: string[];
}> {
  const result = { checked: 0, newPlans: 0, errors: [] as string[] };

  // Check if Gmail is configured
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    result.errors.push('Gmail not configured on server');
    return result;
  }

  try {
    const messageIds = await listUnreadMessages(10);
    result.checked = messageIds.length;

    // Get already-processed message IDs
    const seenResult = await query(
      `SELECT source_email_id FROM schedule_plans WHERE source_email_id IS NOT NULL`
    );
    const seenIds = new Set(seenResult.rows.map(r => r.source_email_id));

    for (const msgId of messageIds) {
      if (seenIds.has(msgId)) continue;

      try {
        const email = await getMessage(msgId);
        
        // Get company context (shift types and team members) for Gemini
        const membersResult = await query(
          `SELECT name FROM team_members WHERE company_id = $1 AND active = true`,
          [companyId]
        );
        const shiftTypesResult = await query(
          `SELECT name FROM shift_types WHERE company_id = $1 AND active = true`,
          [companyId]
        );
        const members = membersResult.rows.map(r => r.name);
        const shiftTypes = shiftTypesResult.rows.map(r => r.name);
        const today = new Date().toISOString().split('T')[0];
        
        // Parse with Gemini
        const plan = await planFromEmail(email.body, email.subject, {
          shiftTypes,
          members,
          today,
        });
        
        // Skip if not a schedule change
        if (!plan.changes || plan.changes.length === 0) {
          await markAsRead(msgId);
          continue;
        }

        // Create pending plan
        await query(
          `INSERT INTO schedule_plans 
           (company_id, source_email_id, source_subject, source_from, source_body, 
            plan_summary, plan, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())`,
          [
            companyId,
            msgId,
            email.subject,
            email.from,
            email.body,
            plan.summary,
            JSON.stringify(plan),
          ]
        );

        await markAsRead(msgId);
        result.newPlans++;
      } catch (err: any) {
        result.errors.push(`Message ${msgId}: ${err.message}`);
      }
    }
  } catch (err: any) {
    result.errors.push(`Poll failed: ${err.message}`);
  }

  return result;
}
