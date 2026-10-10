/**
 * Email polling service: Gmail IMAP inbox → Gemini parsing → Schedule plans.
 * Uses App Password auth. Creates pending plans for approval. Never modifies schedule directly.
 */

import { listUnreadUids, getImapMessage, markImapAsRead } from './gmailImap.js';
import { planFromEmail } from './gemini.js';
import crypto from 'crypto';

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

  // Check if Gmail IMAP is configured
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    result.errors.push('Gmail not configured on server');
    return result;
  }

  try {
    const uids = await listUnreadUids(10);
    result.checked = uids.length;

    // Get already-processed message UIDs
    const seenResult = await query(
      `SELECT source_email_id FROM schedule_plans WHERE source_email_id IS NOT NULL`
    );
    const seenIds = new Set(seenResult.rows.map(r => r.source_email_id));

    for (const uid of uids) {
      const uidStr = String(uid);
      if (seenIds.has(uidStr)) continue;

      try {
        const email = await getImapMessage(uid);

        // Get company context (shift types and team members) for Gemini
        const membersResult = await query(
          `SELECT COALESCE(nickname, first_name || ' ' || last_name) as name FROM users WHERE company_id = $1 AND is_active = true`,
          [companyId]
        );
        const shiftTypesResult = await query(
          `SELECT name FROM shift_types WHERE company_id = $1`,
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
          await markImapAsRead(uid);
          continue;
        }

        // Create pending plan with secure approve/reject tokens
        const approveToken = crypto.randomBytes(32).toString('hex');
        const rejectToken = crypto.randomBytes(32).toString('hex');
        await query(
          `INSERT INTO schedule_plans
           (company_id, source_email_id, source_subject, source_from, source_from_name, source_cc, source_body,
            plan_summary, plan, status, approve_token, reject_token, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, NOW())`,
          [
            companyId,
            uidStr,
            email.subject,
            email.from,
            email.fromName || null,
            email.cc || null,
            email.body,
            plan.summary,
            JSON.stringify(plan),
            approveToken,
            rejectToken,
          ]
        );

        // Notify Deepika that a plan is ready for approval
        try {
          const { sendMail } = await import('./mailer.js');
          const notifyEmail = process.env.NOTIFICATION_EMAIL || 'adityarander1@gmail.com';
          const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
          const approveUrl = `${baseUrl}/api/schedule/plans/approve/${approveToken}`;
          const rejectUrl = `${baseUrl}/api/schedule/plans/reject/${rejectToken}`;
          const fromLine = email.fromName ? `${email.fromName} <${email.from}>` : email.from;
          const ccLine = email.cc ? `\nCc: ${email.cc}` : '';
          await sendMail({
            to: notifyEmail,
            subject: `New schedule change plan: ${plan.summary.substring(0, 60)}`,
            text: `A new schedule change plan is ready for your approval.\n\nSummary: ${plan.summary}\n\nFrom: ${fromLine}${ccLine}\nSubject: ${email.subject}\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\nOr review in the app: ${baseUrl}`,
            html: `<p>A new schedule change plan is ready for your approval.</p><p><strong>Summary:</strong> ${plan.summary}</p><p>From: ${fromLine}${email.cc ? `<br>Cc: ${email.cc}` : ''}<br>Subject: ${email.subject}</p><p><a href="${approveUrl}" style="background:#22c55e;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve & Apply</a><a href="${rejectUrl}" style="background:#ef4444;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reject</a></p><p><a href="${baseUrl}">Or review in the app</a></p>`,
          });
          console.log(`[email-poll] Notification sent to ${notifyEmail}`);
        } catch (notifyErr: any) {
          console.log(`[email-poll] Notification failed: ${notifyErr.message}`);
          // Don't fail the plan creation if notification fails
        }

        await markImapAsRead(uid);
        result.newPlans++;
      } catch (err: any) {
        result.errors.push(`Message ${uid}: ${err.message}`);
      }
    }
  } catch (err: any) {
    result.errors.push(`Poll failed: ${err.message}`);
  }

  return result;
}
