/**
 * Email polling service: Gmail IMAP inbox → Gemini parsing → Schedule plans.
 * Uses App Password auth. Creates pending plans for approval. Never modifies schedule directly.
 */

import { listUnreadUids, getImapMessage, markImapAsRead } from './gmailImap.js';
import { planFromEmail } from './gemini.js';
import crypto from 'crypto';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

/** Get department IDs affected by a plan's changes (for per-department notifications). */
async function getPlanDeptIds(companyId: string, plan: any): Promise<string[]> {
  const { query } = await import('../db.js');
  const deptIds = new Set<string>();
  const changes = plan?.changes || [];
  for (const c of changes) {
    if (c.department) {
      const { rows } = await query('SELECT id FROM departments WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, String(c.department).trim()]);
      if (rows.length) deptIds.add(rows[0].id);
    }
    if (c.shiftType) {
      const { rows: stRows } = await query('SELECT id FROM shift_types WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, String(c.shiftType).trim()]);
      if (stRows.length) {
        const { rows: drows } = await query('SELECT department_id FROM shift_type_departments WHERE shift_type_id = $1', [stRows[0].id]);
        drows.forEach((r: any) => { if (r.department_id) deptIds.add(r.department_id); });
      }
    }
  }
  return [...deptIds];
}

/** Required-field check for a plan change. Returns a list of problems (empty = complete). */
function changeProblems(change: any): string[] {
  const problems: string[] = [];
  const missing = (v: any) => v === null || v === undefined || v === '';
  switch (change.action) {
    case 'assign':
      if (missing(change.person)) problems.push('no person named');
      if (missing(change.date)) problems.push('no date given');
      if (missing(change.shiftType)) problems.push('no shift type given');
      break;
    case 'unassign':
      if (missing(change.person)) problems.push('no person named');
      if (missing(change.date)) problems.push('no date given');
      break;
    case 'move':
      if (missing(change.fromPerson)) problems.push('no person to move');
      if (missing(change.toPerson)) problems.push('no replacement person');
      if (missing(change.date) && missing(change.fromDate)) problems.push('no date given');
      break;
    case 'swap':
      if (missing(change.fromPerson)) problems.push('no first person named');
      if (missing(change.toPerson)) problems.push('no second person named');
      if (missing(change.date)) problems.push('no date given');
      break;
    case 'add_job_role':
      if (missing(change.jobRoleName)) problems.push('no job role name given');
      if (missing(change.department)) problems.push('no department given');
      break;
    case 'rename_job_role':
      if (missing(change.jobRoleName)) problems.push('no job role name given');
      if (missing(change.newJobRoleName)) problems.push('no new job role name given');
      if (missing(change.department)) problems.push('no department given');
      break;
    case 'add_department':
      if (missing(change.department)) problems.push('no department name given');
      break;
    case 'rename_department':
      if (missing(change.department)) problems.push('no department name given');
      if (missing(change.newDepartment)) problems.push('no new department name given');
      break;
    case 'add_team_member':
      if (missing(change.firstName)) problems.push('no first name given');
      if (missing(change.lastName)) problems.push('no last name given');
      break;
    case 'update_team_member':
      if (missing(change.person)) problems.push('no person named');
      if (missing(change.department) && missing(change.jobRoleName)) problems.push('no updates specified');
      break;
    case 'add_shift_type':
      if (missing(change.shiftType)) problems.push('no shift type name given');
      if (missing(change.department)) problems.push('no department given');
      break;
    case 'rename_shift_type':
      if (missing(change.shiftType)) problems.push('no shift type name given');
      if (missing(change.newShiftType)) problems.push('no new shift type name given');
      break;
    case 'set_staffing_target':
      if (missing(change.shiftType)) problems.push('no shift type given');
      if (change.targetCount === undefined || change.targetCount === null) problems.push('no target count given');
      break;
    case 'bulk_publish':
    case 'bulk_unpublish':
      if (missing(change.fromDate)) problems.push('no start date given');
      if (missing(change.toDate)) problems.push('no end date given');
      break;
    default:
      problems.push(`unsupported action "${change.action}"`);
  }
  return problems;
}

/**
 * Poll the Gmail inbox for new schedule change emails.
 * Creates pending plans for Deepika to approve. Never modifies the schedule directly.
 */
export async function pollInbox(query: QueryFn, companyId: string): Promise<{
  checked: number;
  newPlans: number;
  questionsAnswered: number;
  errors: string[];
}> {
  const result = { checked: 0, newPlans: 0, questionsAnswered: 0, errors: [] as string[] };

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

        // Handle schedule questions: query and reply directly to sender
        if (plan.emailType === 'schedule_question' && plan.question) {
          try {
            const { querySchedule } = await import('./scheduleQuery.js');
            const { answer, found } = await querySchedule(query, companyId, plan.question);
            const { sendMail } = await import('./mailer.js');

            // Extract sender email address (from "Name <email>" or plain email)
            const senderMatch = email.from.match(/<([^>]+)>/) || [null, email.from.trim()];
            const senderEmail = (senderMatch[1] || '').trim();

            if (senderEmail && senderEmail.includes('@')) {
              const dateRange = plan.question.startDate
                ? (plan.question.startDate === plan.question.endDate
                    ? plan.question.startDate
                    : `${plan.question.startDate} to ${plan.question.endDate}`)
                : 'the requested dates';
              await sendMail({
                to: senderEmail,
                subject: `Re: ${email.subject}`,
                text: `Hi,\n\nHere's the schedule for ${dateRange}:\n\n${answer}\n\n— Quick Scheduling`,
                html: `<p>Hi,</p><p>Here's the schedule for <strong>${dateRange}</strong>:</p><pre style="font-family:sans-serif;white-space:pre-wrap;">${answer}</pre><p>— Quick Scheduling</p>`,
              });
              console.log(`[email-poll] Schedule answer sent to ${senderEmail}`);
              result.questionsAnswered++;
            }
          } catch (qErr: any) {
            console.log(`[email-poll] Question answering failed: ${qErr.message}`);
            result.errors.push(`Message ${uid}: question answering failed: ${qErr.message}`);
          }
          await markImapAsRead(uid);
          continue;
        }

        // Skip if not a change/bulk/settings request
        const actionableTypes = ['change_request', 'settings_change', 'bulk_action'];
        if (!actionableTypes.includes(plan.emailType) || !plan.changes || plan.changes.length === 0) {
          await markImapAsRead(uid);
          continue;
        }

        // Gate: every change must be complete. If the AI left required fields
        // blank (or flagged low confidence / needs clarification), ask the sender
        // for the missing info instead of creating a broken approve link.
        const incomplete = plan.changes
          .map((c: any, i: number) => ({ i, problems: changeProblems(c) }))
          .filter((x: any) => x.problems.length > 0);
        const needsInfo = incomplete.length > 0 || plan.needsClarification || plan.confidence === 'low';
        if (needsInfo) {
          const detail = incomplete.length
            ? incomplete.map((x: any) => `Change ${x.i + 1} (${plan.changes[x.i].action || 'unknown'}): ${x.problems.join(', ')}`).join('; ')
            : (plan.needsClarification || 'I could not understand the requested change well enough to build it.');
          try {
            const { sendMail } = await import('./mailer.js');
            await sendMail({
              to: email.from,
              subject: `Re: ${email.subject}`,
              text: `Hi,\n\nI wanted to apply your schedule change but I'm missing something: ${detail}\n\nPlease reply with the missing detail and I'll build the change for approval.\n\n— Quick Scheduling`,
              html: `<p>Hi,</p><p>I wanted to apply your schedule change but I'm missing something: <strong>${detail}</strong></p><p>Please reply with the missing detail and I'll build the change for approval.</p><p>— Quick Scheduling</p>`,
            });
            console.log(`[email-poll] Clarification requested from ${email.from}: ${detail}`);
          } catch (mailErr: any) {
            console.log(`[email-poll] Clarification email failed: ${mailErr.message}`);
          }
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

        // Notify requester that their request was received and is awaiting approval.
        try {
          const { sendMail: sendConfirm } = await import('./mailer.js');
          const reqEmail = (email.from || '').trim();
          if (reqEmail && reqEmail.includes('@')) {
            // Include original CC recipients so they follow the request too.
            const ccList = String(email.cc || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.includes('@') && s.toLowerCase() !== reqEmail.toLowerCase());
            const changeList = (plan.changes || []).map((c: any, i: number) => {
              const desc = c.action === 'assign' ? `${c.person} → ${c.shiftType} on ${c.date}`
                : c.action === 'unassign' ? `Remove ${c.person} on ${c.date}`
                : c.action === 'add_shift_type' ? `Add shift "${c.shiftType}" to ${c.department}`
                : c.action === 'set_staffing_target' ? `Set ${c.shiftType} staffing to ${c.targetCount}`
                : `${c.action}`;
              return `${i + 1}. ${desc}`;
            }).join('\n');
            await sendConfirm({
              to: reqEmail,
              cc: ccList.length ? ccList : undefined,
              subject: `Request received: ${plan.summary.substring(0, 60)}`,
              text: `Hi,\n\nYour request has been received and is awaiting approval.\n\nSummary: ${plan.summary}\n\nRequested changes:\n${changeList}\n\nYou'll get another email once it's approved or rejected.\n\n— Quick Scheduling`,
              html: `<p>Hi,</p><p>Your request has been received and is awaiting approval.</p><p><strong>Summary:</strong> ${plan.summary}</p><p><strong>Requested changes:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${changeList}</pre><p>You'll get another email once it's approved or rejected.</p><p>— Quick Scheduling</p>`,
            });
          }
        } catch { /* non-fatal */ }

        // Notify schedulers (primary) and owner (CC) that a plan is ready for approval
        try {
          const { sendMail } = await import('./mailer.js');
          const notifyEmail = process.env.NOTIFICATION_EMAIL || 'adityarander1@gmail.com';
          // Per-department recipients from the Email AI notification tab.
          // Primary recipients go in To:, CCs go in Cc:, owner is always CC'd.
          const toAddrs: string[] = [];
          const ccAddrs: string[] = [];
          try {
            const deptIds = await getPlanDeptIds(companyId, plan);
            if (deptIds.length) {
              const { rows: dsettings } = await query(
                'SELECT department_id, primary_user_id, cc_user_ids, extra_emails FROM department_notification_settings WHERE company_id = $1 AND department_id = ANY($2)',
                [companyId, deptIds]
              );
              const userIds = new Set<string>();
              dsettings.forEach((s: any) => {
                if (s.primary_user_id) userIds.add(s.primary_user_id);
                (s.cc_user_ids || []).forEach((id: string) => userIds.add(id));
              });
              if (userIds.size) {
                const { rows: urows } = await query(
                  'SELECT id, email FROM users WHERE id = ANY($1) AND company_id = $2 AND is_active = true AND email IS NOT NULL',
                  [[...userIds], companyId]
                );
                const emailById: any = {};
                urows.forEach((u: any) => { emailById[u.id] = u.email; });
                dsettings.forEach((s: any) => {
                  if (s.primary_user_id && emailById[s.primary_user_id]) toAddrs.push(emailById[s.primary_user_id]);
                  (s.cc_user_ids || []).forEach((id: string) => { if (emailById[id]) ccAddrs.push(emailById[id]); });
                  (s.extra_emails || []).forEach((e: string) => { if (e && e.includes('@')) ccAddrs.push(e); });
                });
              }
            }
          } catch { /* fall through to default */ }
          // Fallback: owner if no per-department recipients configured.
          if (!toAddrs.length) toAddrs.push(notifyEmail);
          // Owner always CC'd for visibility (unless they're already a primary).
          if (!toAddrs.some(e => e.toLowerCase() === notifyEmail.toLowerCase()) && !ccAddrs.some(e => e.toLowerCase() === notifyEmail.toLowerCase())) {
            ccAddrs.push(notifyEmail);
          }
          {
            const toAddr = toAddrs[0];
            const ccRest = [...new Set([...ccAddrs, ...toAddrs.slice(1)])].filter(e => e.toLowerCase() !== toAddr.toLowerCase());
          const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
          const approveUrl = `${baseUrl}/api/schedule/plans/approve/${approveToken}`;
          const rejectUrl = `${baseUrl}/api/schedule/plans/reject/${rejectToken}`;
          const fromLine = email.fromName ? `${email.fromName} <${email.from}>` : email.from;
          const ccLine = email.cc ? `\nCc: ${email.cc}` : '';
          await sendMail({
            to: toAddr,
            cc: ccRest.length ? ccRest : undefined,
            subject: `New schedule change plan: ${plan.summary.substring(0, 60)}`,
            text: `A new schedule change plan is ready for your approval.\n\nSummary: ${plan.summary}\n\nFrom: ${fromLine}${ccLine}\nSubject: ${email.subject}\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\nOr review in the app: ${baseUrl}`,
            html: `<p>A new schedule change plan is ready for your approval.</p><p><strong>Summary:</strong> ${plan.summary}</p><p>From: ${fromLine}${email.cc ? `<br>Cc: ${email.cc}` : ''}<br>Subject: ${email.subject}</p><p><a href="${approveUrl}" style="background:#22c55e;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve & Apply</a><a href="${rejectUrl}" style="background:#ef4444;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reject</a></p><p><a href="${baseUrl}">Or review in the app</a></p>`,
          });
          console.log(`[email-poll] Notification sent to ${toAddr}${ccRest.length ? ` (cc: ${ccRest.join(', ')})` : ''}`);
          } // end else (notifications enabled)
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
