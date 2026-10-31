/**
 * Email polling service: Gmail IMAP inbox → Gemini parsing → Schedule plans.
 * Uses App Password auth. Creates pending plans for approval. Never modifies schedule directly.
 */

import { listUnreadUids, getImapMessage, markImapAsRead } from './gmailImap.js';
import type { ImapCreds } from './gmailImap.js';
import { planFromEmail } from './gemini.js';
import type { ImapAttachment } from './gmailImap.js';
import { extractAttachmentContent } from './emailAttachments.js';
import { notify, planApproverIds } from './notify.js';
import { outboundFromFor, senderAllowed } from './inboundAddresses.js';
import {
  savePendingClarification,
  clearPendingClarification,
  matchPendingClarification,
} from './pendingClarifications.js';
import crypto from 'crypto';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface ParsedSender {
  /** Display name ('' when the From carried none). */
  name: string;
  /** Clean email address, lowercased ('' when none can be extracted). */
  address: string;
}

/**
 * The ONE sender parse, used at ingest for every email (batch 1,
 * 2026-10-30). Handles `Name <addr@x>`, bare `addr@x`, `"Name" addr@x`,
 * and a bare display name (address ''). Everything downstream uses the
 * parsed parts — nobody regexes the raw From string anymore.
 */
export function parseSender(raw: string, fallbackName?: string | null): ParsedSender {
  const s = String(raw || '').trim();
  let name = '';
  let address = '';
  const angle = s.match(/<([^>]+)>/);
  if (angle) {
    const inner = angle[1].replace(/["']/g, '').trim();
    if (inner.includes('@')) address = inner;
    name = s.replace(/<[^>]*>/, '').trim();
  } else {
    const bare = s.match(/[^\s<>"']+@[^\s<>"']+/);
    if (bare) {
      address = bare[0];
      name = s.replace(bare[0], '').trim();
    } else {
      name = s;
    }
  }
  name = name.replace(/^["']+|["']+$/g, '').replace(/\s+/g, ' ').trim();
  address = address.toLowerCase().trim();
  if (!name && fallbackName) name = String(fallbackName).replace(/\s+/g, ' ').trim();
  return { name, address };
}

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
export function changeProblems(change: any): string[] {
  const problems: string[] = [];
  const missing = (v: any) => v === null || v === undefined || v === '';
  switch (change.action) {
    case 'assign':
      if (missing(change.person)) problems.push('no person named');
      if (missing(change.date)) problems.push('no date given');
      if (missing(change.shiftType)) problems.push('no shift type given');
      break;
    case 'assign_recurring':
      if (missing(change.person)) problems.push('no person named');
      if (missing(change.shiftType)) problems.push('no shift type given');
      if (missing(change.startDate)) problems.push('no start date given');
      if (change.intervalWeeks === undefined || change.intervalWeeks === null) problems.push('no repeat interval given');
      if (missing(change.untilDate)) problems.push('no end date given');
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
    case 'delete_job_role':
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
    case 'add_session':
      if (missing(change.dashboard)) problems.push('no dashboard named');
      if (missing(change.title)) problems.push('no session title given');
      if (missing(change.date)) problems.push('no date given');
      break;
    case 'update_session':
      if (missing(change.dashboard)) problems.push('no dashboard named');
      if (missing(change.sessionTitle)) problems.push('no session named');
      break;
    case 'cancel_session':
      if (missing(change.dashboard)) problems.push('no dashboard named');
      if (missing(change.sessionTitle)) problems.push('no session named');
      break;
    default:
      problems.push(`unsupported action "${change.action}"`);
  }
  return problems;
}

/**
 * Calendar context for the plan builder (2026-10-21): dashboards,
 * their session types + departments, rooms, and a compact list of
 * sessions the AI can target for update/cancel. Recurring series are
 * always listed; one-offs only in a window around today. Capped so
 * the prompt stays small.
 */
export async function buildSessionContext(
  query: QueryFn, companyId: string, today: string
): Promise<{ dashboards: string[]; sessionKinds: string[]; rooms: string[]; sessions: string[]; dashboardDepartments: string[] }> {
  const out = { dashboards: [] as string[], sessionKinds: [] as string[], rooms: [] as string[], sessions: [] as string[], dashboardDepartments: [] as string[] };
  try {
    const { rows: dashes } = await query('SELECT id, name FROM dashboards WHERE company_id = $1 ORDER BY name', [companyId]);
    out.dashboards = dashes.map((d: any) => d.name);
    const dashName = new Map(dashes.map((d: any) => [d.id, d.name]));
    if (dashes.length) {
      const { rows: kinds } = await query(
        'SELECT dashboard_id, label FROM session_kinds WHERE company_id = $1 ORDER BY position, label', [companyId]);
      const byDash = new Map<string, string[]>();
      for (const k of kinds) {
        if (!k.dashboard_id) continue;
        const arr = byDash.get(k.dashboard_id) || [];
        arr.push(k.label);
        byDash.set(k.dashboard_id, arr);
      }
      out.sessionKinds = [...byDash.entries()].map(([id, labels]) => `${dashName.get(id)}: ${labels.join(', ')}`);
      const { rows: dd } = await query(
        `SELECT dd.dashboard_id, d.name FROM dashboard_departments dd
         JOIN departments d ON d.id = dd.department_id
         JOIN dashboards db ON db.id = dd.dashboard_id WHERE db.company_id = $1`, [companyId]);
      const deptByDash = new Map<string, string[]>();
      for (const r of dd) {
        const arr = deptByDash.get(r.dashboard_id) || [];
        arr.push(r.name);
        deptByDash.set(r.dashboard_id, arr);
      }
      out.dashboardDepartments = [...deptByDash.entries()].map(([id, names]) => `${dashName.get(id)}: ${names.join(', ')}`);
    }
    const { rows: roomRows } = await query('SELECT name FROM rooms WHERE company_id = $1 ORDER BY name', [companyId]);
    out.rooms = roomRows.map((r: any) => r.name);
    const { rows: sess } = await query(
      `SELECT s.title, s.session_date::text AS sdate, s.start_time::text AS stime, s.end_time::text AS etime,
              s.recur_rule, s.recur_interval, s.recur_days, s.location, s.dashboard_id,
              TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) AS presenter,
              TRIM(COALESCE(sv.first_name,'') || ' ' || COALESCE(sv.last_name,'')) AS supervisor
       FROM academic_sessions s
       LEFT JOIN users l ON l.id = s.lecturer_user_id
       LEFT JOIN users sv ON sv.id = s.supervisor_user_id
       WHERE s.company_id = $1
       ORDER BY s.session_date
       LIMIT 300`, [companyId]);
    const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const from = new Date(today + 'T00:00:00'); from.setDate(from.getDate() - 30);
    const to = new Date(today + 'T00:00:00'); to.setDate(to.getDate() + 120);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const lines: string[] = [];
    for (const s of sess) {
      const dash = dashName.get(s.dashboard_id) || 'Calendar';
      const times = s.stime ? ` ${String(s.stime).slice(0, 5)}${s.etime ? '–' + String(s.etime).slice(0, 5) : ''}` : '';
      const people = s.presenter ? `, presenter ${s.presenter}` : '';
      const sup = s.supervisor ? `, supervisor ${s.supervisor}` : '';
      const loc = s.location ? `, in ${s.location}` : '';
      if (s.recur_rule && s.recur_rule !== 'none') {
        const days = s.recur_days ? String(s.recur_days).split(',').map((x: string) => DAY[parseInt(x, 10)] + 's').join('/')
          : DAY[new Date(s.sdate + 'T00:00:00').getDay()] + 's';
        const every = (s.recur_interval || 1) > 1 ? `every ${s.recur_interval} ` : '';
        const rule = s.recur_rule === 'weekly' || s.recur_rule === 'biweekly' ? `${every}week on ${days}` : s.recur_rule;
        lines.push(`- "${s.title}" on ${dash} — repeats ${rule}${times}${people}${sup}${loc}`);
      } else if (s.sdate >= iso(from) && s.sdate <= iso(to)) {
        lines.push(`- "${s.title}" on ${dash} — ${s.sdate}${times}${people}${sup}${loc} (one-time)`);
      }
    }
    out.sessions = lines.slice(0, 80);
  } catch { /* context is best-effort; planning still works without it */ }
  return out;
}

/**
 * Process ONE schedule email into a pending plan (shared engine).
 * Used by the Gmail IMAP poller AND the inbound-address webhook, so both
 * paths behave identically. Never modifies the schedule directly — it
 * only creates a pending plan (or answers / asks a clarifying question).
 * `result` is the caller's poll result object (errors accumulate there);
 * the return kind tells the caller what happened for its own counters.
 */
export interface ScheduleEmailInput {
  from: string;
  fromName?: string | null;
  cc?: string | null;
  subject: string;
  body: string;
  attachments?: ImapAttachment[];
  /** Threading headers, as far as the ingest path provides them: the
   * IMAP path fills all three from mailparser; the inbound webhook
   * supplies only its provider message id today. */
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}
export type ScheduleEmailOutcome =
  | { kind: 'plan_created'; answeredQuestion?: boolean }
  | { kind: 'question_answered' }
  | { kind: 'question_failed' }
  | { kind: 'skipped' }
  | { kind: 'sender_not_staff' }
  | { kind: 'clarification_sent'; answeredQuestion?: boolean };
export async function processScheduleEmail(
  query: QueryFn,
  companyId: string,
  email: ScheduleEmailInput,
  sourceId: string,
  result: { checked: number; newPlans: number; questionsAnswered: number; errors: string[] },
  opts?: { markRead?: () => Promise<void>; departmentId?: string }
): Promise<ScheduleEmailOutcome | undefined> {
  try {

    // Sender, parsed ONCE (batch 1, 2026-10-30): every consumer below
    // uses these clean parts instead of the raw From string.
    const sender = parseSender(email.from, email.fromName);
    const fromLine = sender.name ? `${sender.name} <${sender.address}>` : sender.address;

    // Sender lock (Deepika's rule, decided 2026-10-24; batch 1 enforces
    // it in this shared engine so BOTH ingest paths are covered — the
    // inbound webhook pre-checks it too, but the Gmail poller had no
    // check at all): only active staff of THIS company may email its
    // address. Anyone else: marked read and dropped — no plan, no
    // reply, no AI call.
    if (!(await senderAllowed(query, companyId, sender.address))) {
      console.log(`[email-poll] Message ${sourceId}: sender "${email.from}" is not an active staff address for this company — ignored.`);
      if (opts?.markRead) await opts.markRead();
      return { kind: 'sender_not_staff' };
    }

    // Clarification threading (batch 1): when this email replies to a
    // clarification we asked this sender, plan the ORIGINAL request
    // with the reply appended — never the reply fragment on its own.
    // A re-clarification keeps the original request text (see below).
    let effectiveBody = email.body;
    let pendingOriginal: { subject: string; body: string } | null = null;
    try {
      const pending = await matchPendingClarification(query, companyId, sender.address, {
        inReplyTo: email.inReplyTo, references: email.references, subject: email.subject,
      });
      if (pending) {
        effectiveBody = `${pending.original_body}\n\n--- Sender's reply to the clarification question ---\n${email.body}`;
        pendingOriginal = { subject: pending.subject, body: pending.original_body };
        await clearPendingClarification(query, companyId, sender.address);
        console.log(`[email-poll] Message ${sourceId}: matched a pending clarification from ${sender.address} — planning the original request with the reply appended.`);
      }
    } catch (threadErr: any) {
      console.log(`[email-poll] Message ${sourceId}: clarification matching failed: ${threadErr.message}`);
    }

    // Outbound From: when this message arrived on a department inbound
    // address and a sending domain is configured, replies and plan mail
    // go out FROM that department's address (one address, both ways).
    let fromAddr: string | null = null;
    if (opts?.departmentId) {
      try { fromAddr = await outboundFromFor(query, companyId, opts.departmentId); } catch { /* default From */ }
    }
    // Read any attachments (PDF / Excel / CSV / Word) so the plan
    // builder can work from them — e.g. an emailed schedule file.
    let attachmentText = '';
    let pdfAttachments: { filename: string; base64: string }[] = [];
    let attachmentNotes: string[] = [];
    if (email.attachments && email.attachments.length) {
      try {
        const conv = await extractAttachmentContent(email.attachments);
        attachmentText = conv.textParts.map((p) => `--- ${p.filename} ---\n${p.text}`).join('\n\n');
        pdfAttachments = conv.pdfParts;
        attachmentNotes = conv.notes;
        if (conv.textParts.length || pdfAttachments.length || attachmentNotes.length) {
          console.log(`[email-poll] Message ${sourceId}: attachments — ${conv.textParts.length} as text, ${pdfAttachments.length} PDF(s)${attachmentNotes.length ? `; notes: ${attachmentNotes.join('; ')}` : ''}`);
        }
      } catch (attErr: any) {
        console.log(`[email-poll] Message ${sourceId}: attachment reading failed: ${attErr.message}`);
      }
    }

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

    // Parse with Gemini (calendar context included so session
    // requests — add / change / cancel a session — can be planned)
    const sessionCtx = await buildSessionContext(query, companyId, today);
    const { getShiftTypeRules } = await import('./planExecutor.js');
    const plan = await planFromEmail(effectiveBody, email.subject, {
      shiftTypes,
      shiftTypeRules: await getShiftTypeRules(companyId),
      members,
      today,
      ...sessionCtx,
      attachmentText: attachmentText || undefined,
      pdfAttachments: pdfAttachments.length ? pdfAttachments : undefined,
      attachmentNotes: attachmentNotes.length ? attachmentNotes : undefined,
    });

    // Mixed mail (batch 2, 2026-10-30): handling keys on the parse
    // OUTPUT, not the single emailType — one email can carry a schedule
    // question AND change requests, and both halves get handled: the
    // question is answered AND the changes go through the plan path.
    const changes: any[] = Array.isArray(plan.changes) ? plan.changes : [];
    const actionableTypes = ['change_request', 'settings_change', 'bulk_action'];
    const question = plan.question || null;
    const hasQuestion = !!question;
    const hasChanges = changes.length > 0 && (actionableTypes.includes(plan.emailType) || hasQuestion);

    // Answer the schedule question, if the email asked one: query and
    // reply directly to the sender.
    let answeredQuestion = false;
    if (question) {
      try {
        const { querySchedule } = await import('./scheduleQuery.js');
        const { answer, found } = await querySchedule(query, companyId, question);
        const { sendMail } = await import('./mailer.js');

        // Clean address from the one ingest parse (batch 1) — the staff
        // lock above guarantees it is a real staff address.
        const senderEmail = sender.address;

        if (senderEmail && senderEmail.includes('@')) {
          const dateRange = question.startDate
            ? (question.startDate === question.endDate
                ? question.startDate
                : `${question.startDate} to ${question.endDate}`)
            : 'the requested dates';
          await sendMail({
            ...(fromAddr ? { from: fromAddr } : {}),
            to: senderEmail,
            subject: `Re: ${email.subject}`,
            text: `Hi,\n\nHere's the schedule for ${dateRange}:\n\n${answer}\n\n— Quick Scheduling`,
            html: `<p>Hi,</p><p>Here's the schedule for <strong>${dateRange}</strong>:</p><pre style="font-family:sans-serif;white-space:pre-wrap;">${answer}</pre><p>— Quick Scheduling</p>`,
          });
          console.log(`[email-poll] Schedule answer sent to ${senderEmail}`);
        }
        answeredQuestion = true;
      } catch (qErr: any) {
        console.log(`[email-poll] Question answering failed: ${qErr.message}`);
        result.errors.push(`Message ${sourceId}: question answering failed: ${qErr.message}`);
        if (!hasChanges) {
          // Question-only mail: unchanged failure behavior.
          if (opts?.markRead) await opts.markRead();
          return { kind: 'question_failed' };
        }
        // Mixed mail: the failure is on the record above; the changes
        // below are still processed.
      }
      if (!hasChanges) {
        if (opts?.markRead) await opts.markRead();
        return { kind: 'question_answered' };
      }
    }

    // Skip if there is nothing actionable to plan (not a
    // change/bulk/settings request, or no changes in it).
    if (!hasChanges) {
      if (opts?.markRead) await opts.markRead();
      return { kind: 'skipped' };
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
      // The clarification email carries a generated Message-ID so the
      // sender's reply can be threaded back (match rule (a)); the
      // sender+subject fallback covers clients that drop the header.
      const fromDomain = ((fromAddr || process.env.RESEND_FROM || '').match(/@([^\s>]+)/) || [])[1] || 'quick-scheduling';
      const clarMessageId = `<qs-clar-${crypto.randomUUID()}@${fromDomain}>`;
      try {
        const { sendMail } = await import('./mailer.js');
        await sendMail({
          ...(fromAddr ? { from: fromAddr } : {}),
          to: sender.address,
          subject: `Re: ${email.subject}`,
          text: `Hi,\n\nI wanted to apply your schedule change but I'm missing something: ${detail}\n\nPlease reply with the missing detail and I'll build the change for approval.\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>I wanted to apply your schedule change but I'm missing something: <strong>${detail}</strong></p><p>Please reply with the missing detail and I'll build the change for approval.</p><p>— Quick Scheduling</p>`,
          headers: { 'Message-ID': clarMessageId },
        });
        console.log(`[email-poll] Clarification requested from ${sender.address}: ${detail}`);
      } catch (mailErr: any) {
        console.log(`[email-poll] Clarification email failed: ${mailErr.message}`);
      }
      // Remember the ORIGINAL request so the reply is planned together
      // with it. If this email was itself a clarification reply, keep
      // the first request's text/subject — never stack pendings.
      try {
        await savePendingClarification(
          query, companyId, sender.address,
          pendingOriginal ? pendingOriginal.subject : email.subject,
          pendingOriginal ? pendingOriginal.body : email.body,
          detail, clarMessageId
        );
      } catch (saveErr: any) {
        console.log(`[email-poll] Saving pending clarification failed: ${saveErr.message}`);
      }
      if (opts?.markRead) await opts.markRead();
      return { kind: 'clarification_sent', answeredQuestion };
    }

    // Warn-and-override: flag every change that puts someone on a shift type
    // their job role is not eligible for. The warning rides on the change
    // into the requester email and the summary flag carries it into the
    // approver email + Requests list; approving overrides it.
    const { validatePlanEligibility } = await import('./planExecutor.js');
    const warned = await validatePlanEligibility(companyId, plan.changes || []);
    if (warned > 0) {
      plan.summary = `⚠️ Job-role warning: ${warned} change${warned === 1 ? '' : 's'} ${warned === 1 ? 'assigns' : 'assign'} someone outside the allowed roles — approving overrides the rule. ` + (plan.summary || '');
    }

    // Create pending plan with secure approve/reject tokens
    const approveToken = crypto.randomBytes(32).toString('hex');
    const rejectToken = crypto.randomBytes(32).toString('hex');
    const { rows: insertedPlans } = await query(
      `INSERT INTO schedule_plans
       (company_id, source_email_id, source_subject, source_from, source_from_name, source_cc, source_body,
        plan_summary, plan, status, approve_token, reject_token, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, NOW())
       RETURNING id`,
      [
        companyId,
        sourceId,
        email.subject,
        sender.address,
        sender.name || null,
        email.cc || null,
        effectiveBody,
        plan.summary,
        JSON.stringify(plan),
        approveToken,
        rejectToken,
      ]
    );
    const planId = insertedPlans[0].id;

    // Bell + instant email for the approvers: a plan is waiting
    // (Phase 1 notifications). Best-effort.
    try {
      const approvers = await planApproverIds(companyId);
      if (approvers.length) {
        await notify({
          companyId, userIds: approvers, category: 'approvals', type: 'plan_waiting',
          title: 'A schedule plan is waiting for approval',
          body: plan.summary || `Plan from ${fromLine}`,
          link: 'requests', bundleKey: 'plan_waiting',
          bundleTitle: '{count} schedule plans are waiting for approval',
        });
      }
    } catch { /* non-fatal */ }

    // Notify requester that their request was received and is awaiting approval.
    try {
      const { sendMail: sendConfirm } = await import('./mailer.js');
      const reqEmail = sender.address;
      if (reqEmail && reqEmail.includes('@')) {
        // Include original CC recipients so they follow the request too.
        const ccList = String(email.cc || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.includes('@') && s.toLowerCase() !== reqEmail.toLowerCase());
        const changeList = (plan.changes || []).map((c: any, i: number) => {
          const desc = c.action === 'assign_recurring' ? `${c.person} → ${c.shiftType} every ${c.intervalWeeks} weeks from ${c.startDate}${c.weekendsOff ? ', weekdays only' : ''}${c.untilDate ? ` until ${c.untilDate}` : ''}`
            : c.action === 'assign' ? `${c.person} → ${c.shiftType} on ${c.date}`
            : c.action === 'unassign' ? `Remove ${c.person} on ${c.date}`
            : c.action === 'add_shift_type' ? `Add shift "${c.shiftType}" to ${c.department}`
            : c.action === 'set_staffing_target' ? `Set ${c.shiftType} staffing to ${c.targetCount}`
            : c.action === 'add_session' ? `Add session "${c.title}" on ${c.dashboard} (${c.date})`
            : c.action === 'update_session' ? `Change session "${c.sessionTitle}" on ${c.dashboard}${c.date ? ` (${c.date})` : ''}`
            : c.action === 'cancel_session' ? `Cancel session "${c.sessionTitle}" on ${c.dashboard}${c.date ? ` (${c.date})` : ''}`
            : `${c.action}`;
          return `${i + 1}. ${desc}${c.warning ? `\n   ⚠️ ${c.warning}` : ''}`;
        }).join('\n');
        await sendConfirm({
          ...(fromAddr ? { from: fromAddr } : {}),
          to: reqEmail,
          cc: ccList.length ? ccList : undefined,
          subject: `Request received: ${plan.summary.substring(0, 60)}`,
          text: `Hi,\n\nYour request has been received and is awaiting approval.\n\nSummary: ${plan.summary}\n\nRequested changes:\n${changeList}\n\nYou'll get another email once it's approved or rejected.\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>Your request has been received and is awaiting approval.</p><p><strong>Summary:</strong> ${plan.summary}</p><p><strong>Requested changes:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${changeList}</pre><p>You'll get another email once it's approved or rejected.</p><p>— Quick Scheduling</p>`,
        });
      }
    } catch { /* non-fatal */ }

    // Notify the approvers that a plan is ready for approval.
    // Per-approver links (Deepika 2026-10-31, migration 068): every
    // approver (planApproverIds — owners, plus schedulers when the
    // company notifies them) gets their OWN token pair and their own
    // email carrying only their links. A per-approver token was sent
    // to exactly one approver, so the handlers treat it as the auth
    // (login-free) and record the click under that approver's name.
    // Everyone else who hears about the plan today — department
    // notification CCs, extra addresses, the fallback inbox — still
    // gets the shared plan-level links, exactly as before (approve
    // needs a logged-in approver with department access; reject free).
    try {
      const { sendMail } = await import('./mailer.js');
      const notifyEmail = process.env.NOTIFICATION_EMAIL || 'adityarander1@gmail.com';
      const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
      // fromLine comes from the one ingest parse (batch 1) — always
      // `Name <address>`, never a name nested inside the brackets.
      const ccLine = email.cc ? `\nCc: ${email.cc}` : '';
      // NOTE (Deepika 2026-10-28): the 📅 Quick session button is REMOVED
      // from plan emails for now — it rendered overlapping the Approve /
      // Reject buttons in Gmail. The quick-session page itself stays live;
      // the button comes back once its email layout is fixed. So no token
      // is generated for the email anymore.
      const planMail = (approveUrl: string, rejectUrl: string) => ({
        subject: `New schedule change plan: ${plan.summary.substring(0, 60)}`,
        text: `A new schedule change plan is ready for your approval.\n\nSummary: ${plan.summary}\n\nFrom: ${fromLine}${ccLine}\nSubject: ${email.subject}\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\nOr review in the app: ${baseUrl}`,
        html: `<p>A new schedule change plan is ready for your approval.</p><p><strong>Summary:</strong> ${plan.summary}</p><p>From: ${fromLine}${email.cc ? `<br>Cc: ${email.cc}` : ''}<br>Subject: ${email.subject}</p><p><a href="${approveUrl}" style="background:#22c55e;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve & Apply</a><a href="${rejectUrl}" style="background:#ef4444;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reject</a></p><p><a href="${baseUrl}">Or review in the app</a></p>`,
      });

      // One token pair per approver (deduped by email address — two
      // accounts sharing one inbox get one personal email).
      const approverIds = await planApproverIds(companyId);
      const { rows: approverUsers } = approverIds.length ? await query(
        'SELECT id, email FROM users WHERE id = ANY($1) AND company_id = $2 AND is_active = true AND email IS NOT NULL',
        [approverIds, companyId]
      ) : { rows: [] as any[] };
      const approverMail: Array<{ email: string; approveUrl: string; rejectUrl: string }> = [];
      const approverEmails = new Set<string>();
      for (const u of approverUsers) {
        const addr = String(u.email).toLowerCase();
        if (approverEmails.has(addr)) continue;
        approverEmails.add(addr);
        const aTok = crypto.randomBytes(32).toString('hex');
        const rTok = crypto.randomBytes(32).toString('hex');
        await query(
          `INSERT INTO plan_approver_tokens (plan_id, user_id, approve_token, reject_token) VALUES ($1, $2, $3, $4)`,
          [planId, u.id, aTok, rTok]
        );
        approverMail.push({
          email: u.email,
          approveUrl: `${baseUrl}/api/schedule/plans/approve/${aTok}`,
          rejectUrl: `${baseUrl}/api/schedule/plans/reject/${rTok}`,
        });
      }

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
      // Approvers come OFF the shared send — each gets the personal
      // email below instead, so no inbox ever holds another approver's
      // links. Everyone else keeps the shared plan-level links, with
      // the same To/CC shape as before (first address To, rest CC).
      const sharedAddrs = [...toAddrs, ...ccAddrs].filter((e) => !approverEmails.has(e.toLowerCase()));
      for (const m of approverMail) {
        try {
          await sendMail({
            ...(fromAddr ? { from: fromAddr } : {}),
            to: m.email,
            ...planMail(m.approveUrl, m.rejectUrl),
          });
          console.log(`[email-poll] Approver notification sent to ${m.email}`);
        } catch (mailErr: any) {
          console.log(`[email-poll] Approver notification to ${m.email} failed: ${mailErr.message}`);
        }
      }
      if (sharedAddrs.length) {
        const toAddr = sharedAddrs[0];
        const ccRest = [...new Set(sharedAddrs.slice(1))].filter((e) => e.toLowerCase() !== toAddr.toLowerCase());
        const approveUrl = `${baseUrl}/api/schedule/plans/approve/${approveToken}`;
        const rejectUrl = `${baseUrl}/api/schedule/plans/reject/${rejectToken}`;
        await sendMail({
          ...(fromAddr ? { from: fromAddr } : {}),
          to: toAddr,
          cc: ccRest.length ? ccRest : undefined,
          ...planMail(approveUrl, rejectUrl),
        });
        console.log(`[email-poll] Notification sent to ${toAddr}${ccRest.length ? ` (cc: ${ccRest.join(', ')})` : ''}`);
      }
    } catch (notifyErr: any) {
      console.log(`[email-poll] Notification failed: ${notifyErr.message}`);
      // Don't fail the plan creation if notification fails
    }

    if (opts?.markRead) await opts.markRead();
    return { kind: 'plan_created', answeredQuestion };
  } catch (err: any) {
    result.errors.push(`Message ${sourceId}: ${err.message}`);
    return undefined;
  }
}

/**
 * Fold one email's outcome into a poll result's tallies. Mixed mail
 * (batch 2) counts toward BOTH: a plan_created / clarification_sent
 * outcome that also answered a question increments questionsAnswered
 * as well as newPlans.
 */
export function applyOutcomeToCounts(
  result: { newPlans: number; questionsAnswered: number },
  outcome: ScheduleEmailOutcome | undefined
): void {
  if (!outcome) return;
  if (outcome.kind === 'plan_created') result.newPlans++;
  if (outcome.kind === 'question_answered' || ('answeredQuestion' in outcome && outcome.answeredQuestion)) result.questionsAnswered++;
}

const EMAIL_LAST_POLL_KEY = 'email_last_poll_at';

/**
 * Stamp the company's "email last checked" time (batch 2, 2026-10-30).
 * Stored in the per-company settings KV (company_settings) so it is
 * durable — an in-memory stamp would blank on every server restart,
 * exactly when someone goes looking for it. Best-effort: recording a
 * poll must never break the poll itself.
 */
export async function recordEmailPoll(query: QueryFn, companyId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO company_settings (company_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [companyId, EMAIL_LAST_POLL_KEY, new Date().toISOString()]
    );
  } catch { /* best-effort */ }
}

/** Read the last-checked stamp + the company's timezone (for display). */
export async function getEmailPollStatus(
  query: QueryFn, companyId: string
): Promise<{ lastPollAt: string | null; timezone: string }> {
  let lastPollAt: string | null = null;
  let timezone = 'America/Chicago';
  try {
    const { rows } = await query(
      'SELECT key, value FROM company_settings WHERE company_id = $1 AND key = ANY($2)',
      [companyId, [EMAIL_LAST_POLL_KEY, 'timezone']]
    );
    for (const r of rows) {
      if (r.key === EMAIL_LAST_POLL_KEY && r.value) lastPollAt = String(r.value);
      if (r.key === 'timezone' && r.value) {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(r.value) }); timezone = String(r.value); }
        catch { /* bad stored value — keep the fallback */ }
      }
    }
  } catch { /* settings unavailable — defaults */ }
  return { lastPollAt, timezone };
}

/**
 * Poll the Gmail inbox for new schedule change emails.
 * Creates pending plans for Deepika to approve. Never modifies the schedule directly.
 */
export async function pollInbox(query: QueryFn, companyId: string, creds?: ImapCreds): Promise<{
  checked: number;
  newPlans: number;
  questionsAnswered: number;
  errors: string[];
}> {
  const result = { checked: 0, newPlans: 0, questionsAnswered: 0, errors: [] as string[] };

  // Check if Gmail IMAP is configured (per-company creds, or the legacy env inbox)
  if (!creds && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
    result.errors.push('Gmail not configured on server');
    await recordEmailPoll(query, companyId);
    return result;
  }

  try {
    const uids = await listUnreadUids(10, creds);
    result.checked = uids.length;

    // Get already-processed message UIDs
    // Seen UIDs are scoped to THIS company: IMAP UIDs are per-mailbox, so
    // two different companies' mailboxes can both contain UID 42.
    const seenResult = await query(
      `SELECT source_email_id FROM schedule_plans WHERE source_email_id IS NOT NULL AND company_id = $1`,
      [companyId]
    );
    const seenIds = new Set(seenResult.rows.map(r => r.source_email_id));

    for (const uid of uids) {
      const uidStr = String(uid);
      if (seenIds.has(uidStr)) continue;

      try {
        const email = await getImapMessage(uid, creds);
        const outcome = await processScheduleEmail(query, companyId, email, uidStr, result, {
          markRead: () => markImapAsRead(uid, creds),
        });
        applyOutcomeToCounts(result, outcome);
      } catch (err: any) {
        result.errors.push(`Message ${uid}: ${err.message}`);
      }
    }
  } catch (err: any) {
    result.errors.push(`Poll failed: ${err.message}`);
  }

  // The poll finished (even if it found nothing, and even if it hit
  // errors above): stamp the last-checked time for this company.
  await recordEmailPoll(query, companyId);
  return result;
}
