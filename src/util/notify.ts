/**
 * Notifications (Phase 1, Deepika 2026-10-22).
 *
 * notify() records an in-app notification for one or more users.
 * A dispatcher (startNotificationDispatcher, 60s tick) emails the
 * notifications whose resolved speed is "instant" once they have
 * settled (no merges for 3 minutes — bundling window is 10 minutes).
 * Speed resolution per user: personal pref -> company default ->
 * per-type built-in -> category built-in ("instant"; open shifts and
 * needs-a-presenter default to "digest"). "digest" rows are emailed
 * once a day by the Phase 2 digest job in util/notifyJobs.ts; reminder
 * rows (shift_reminder / session_reminder) are never digested — they
 * email on the instant path even when the resolved speed is "digest".
 *
 * Notification is always best-effort: a failure here must never break
 * the schedule change that triggered it, so notify() swallows errors.
 */
import { query } from '../db.js';
import { sendMail } from './mailer.js';
import { getDepartmentAccess } from './departmentAccess.js';

export type NotifCategory = 'schedule' | 'calendar' | 'approvals' | 'messages';
export type NotifSpeed = 'instant' | 'digest' | 'off';

export const NOTIF_CATEGORIES: NotifCategory[] = ['schedule', 'calendar', 'approvals', 'messages'];

const CATEGORY_DEFAULT: Record<string, NotifSpeed> = {
  schedule: 'instant', calendar: 'instant', approvals: 'instant', messages: 'instant',
};
const TYPE_DEFAULT: Record<string, NotifSpeed> = {
  open_shift: 'digest',
  session_needs_presenter: 'digest',
};

export async function resolveSpeed(companyId: string, userId: string, category: string, type: string): Promise<NotifSpeed> {
  const { rows: pref } = await query('SELECT speed FROM notification_prefs WHERE user_id = $1 AND category = $2', [userId, category]);
  if (pref.length) return pref[0].speed as NotifSpeed;
  const { rows: def } = await query('SELECT speed FROM notification_defaults WHERE company_id = $1 AND category = $2', [companyId, category]);
  if (def.length) return def[0].speed as NotifSpeed;
  if (TYPE_DEFAULT[type]) return TYPE_DEFAULT[type];
  return CATEGORY_DEFAULT[category] || 'instant';
}

/** '2027-06-07' -> 'Fri, Jun 7, 2027' (UTC-safe). */
export function fmtDateLong(iso: string): string {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return String(iso);
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

export interface NotifyInput {
  companyId: string;
  userIds: string[];
  category: NotifCategory;
  type: string;
  title: string;
  body?: string;
  link?: string;
  bundleKey?: string;
  /** Title used once a bundle holds more than one event; "{count}" is replaced. */
  bundleTitle?: string;
  payload?: Record<string, any>;
  excludeUserId?: string | null;
}

export async function notify(input: NotifyInput): Promise<void> {
  try {
    const ids = [...new Set((input.userIds || []).filter(Boolean))].filter((id) => id !== input.excludeUserId);
    if (!ids.length) return;
    // Only active members of this company can be notified.
    const { rows: valid } = await query(
      'SELECT id FROM users WHERE company_id = $1 AND is_active = true AND id = ANY($2::uuid[])',
      [input.companyId, ids]
    );
    const validIds = new Set(valid.map((r: any) => r.id));
    const count = (input.payload && typeof input.payload.count === 'number') ? input.payload.count : 1;
    for (const userId of ids) {
      if (!validIds.has(userId)) continue;
      let merged = false;
      if (input.bundleKey) {
        const { rows: existing } = await query(
          `SELECT id, payload FROM notifications
           WHERE user_id = $1 AND type = $2 AND bundle_key = $3 AND read_at IS NULL
             AND email_state != 'sent' AND updated_at > now() - interval '10 minutes'
           ORDER BY updated_at DESC LIMIT 1`,
          [userId, input.type, input.bundleKey]
        );
        if (existing.length) {
          const prev = existing[0];
          const newCount = (typeof prev.payload?.count === 'number' ? prev.payload.count : 1) + count;
          const title = newCount > 1 && input.bundleTitle
            ? input.bundleTitle.replace('{count}', String(newCount))
            : input.title;
          await query(
            `UPDATE notifications SET title = $1, body = $2, payload = $3, updated_at = now()
             WHERE id = $4`,
            [title, input.body || null, JSON.stringify({ ...(input.payload || {}), count: newCount }), prev.id]
          );
          merged = true;
        }
      }
      if (!merged) {
        await query(
          `INSERT INTO notifications (company_id, user_id, category, type, title, body, link, payload, bundle_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [input.companyId, userId, input.category, input.type, input.title, input.body || null, input.link || null,
           JSON.stringify({ ...(input.payload || {}), count }), input.bundleKey || null]
        );
      }
    }
  } catch (e: any) {
    console.log(`[notify] failed (${input.type}): ${e?.message || e}`);
  }
}

// ---------------------------------------------------------------------------
// Recipient helpers
// ---------------------------------------------------------------------------

export async function companyOwnerIds(companyId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true`, [companyId]);
  return rows.map((r: any) => r.id);
}

/** Owners + schedulers with Edit access to the department (plan approvers). */
export async function planApproverIds(companyId: string): Promise<string[]> {
  const { rows: cfg } = await query('SELECT notify_schedulers FROM company_notification_settings WHERE company_id = $1', [companyId]);
  const ids = await companyOwnerIds(companyId);
  if (cfg.length && cfg[0].notify_schedulers) {
    const { rows } = await query(
      `SELECT id FROM users WHERE company_id = $1 AND role = 'scheduler' AND is_active = true`, [companyId]);
    ids.push(...rows.map((r: any) => r.id));
  }
  return [...new Set(ids)];
}

/** Owners + schedulers who can edit the given department. */
export async function deptApproverIds(companyId: string, departmentId: string | null): Promise<string[]> {
  const ids = await companyOwnerIds(companyId);
  const { rows } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'scheduler' AND is_active = true`, [companyId]);
  for (const s of rows) {
    if (!departmentId) { ids.push(s.id); continue; }
    try {
      const access = await getDepartmentAccess(s.id, companyId);
      if (access.edit.includes(departmentId)) ids.push(s.id);
    } catch { /* skip */ }
  }
  return [...new Set(ids)];
}

/** Active members whose home department is the given department. */
export async function deptMemberIds(companyId: string, departmentId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND department_id = $2 AND is_active = true`,
    [companyId, departmentId]);
  return rows.map((r: any) => r.id);
}

/**
 * Members who could pick up a shift type: members of its departments,
 * filtered by the shift type's eligible job roles when it has any.
 */
export async function eligibleMemberIds(companyId: string, shiftTypeId: string): Promise<string[]> {
  const { rows: depts } = await query('SELECT department_id FROM shift_type_departments WHERE shift_type_id = $1', [shiftTypeId]);
  if (!depts.length) return [];
  const deptIds = depts.map((r: any) => r.department_id);
  const { rows: st } = await query('SELECT eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2', [shiftTypeId, companyId]);
  const eligible: string[] = Array.isArray(st[0]?.eligible_job_role_ids) ? st[0].eligible_job_role_ids : [];
  let sql = `SELECT id FROM users WHERE company_id = $1 AND is_active = true AND department_id = ANY($2::uuid[])`;
  const params: any[] = [companyId, deptIds];
  if (eligible.length) { sql += ' AND job_role_id = ANY($3::uuid[])'; params.push(eligible); }
  const { rows } = await query(sql, params);
  return rows.map((r: any) => r.id);
}

// ---------------------------------------------------------------------------
// Email dispatcher
// ---------------------------------------------------------------------------

export async function dispatchNotificationEmails(): Promise<void> {
  try {
    const { rows } = await query(
      `SELECT n.id, n.company_id, n.user_id, n.category, n.type, n.title, n.body, u.email
       FROM notifications n JOIN users u ON u.id = n.user_id
       WHERE n.email_state = 'pending' AND n.updated_at < now() - interval '3 minutes'
       ORDER BY n.updated_at ASC LIMIT 100`
    );
    if (!rows.length) return;
    const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
    for (const n of rows) {
      const speed = await resolveSpeed(n.company_id, n.user_id, n.category, n.type);
      if (speed === 'off') {
        await query(`UPDATE notifications SET email_state = 'skipped' WHERE id = $1`, [n.id]);
        continue;
      }
      // Reminders are never digested (a reminder in tomorrow's digest is
      // useless) — a digest speed still emails them right away.
      if (speed === 'digest' && n.type !== 'shift_reminder' && n.type !== 'session_reminder') {
        continue; // the Phase 2 digest job (util/notifyJobs.ts) owns these.
      }
      try {
        await sendMail({
          to: n.email,
          subject: n.title,
          text: `${n.title}\n\n${n.body || ''}\n\nOpen Quick Scheduling: ${baseUrl}`,
          html: `<p><strong>${n.title}</strong></p>${n.body ? `<p>${n.body}</p>` : ''}<p><a href="${baseUrl}">Open Quick Scheduling</a></p>`,
        });
        await query(`UPDATE notifications SET email_state = 'sent', email_sent_at = now() WHERE id = $1`, [n.id]);
      } catch (e: any) {
        const attempts = 1; // incremented below; give up after 5 tries
        await query(
          `UPDATE notifications SET email_attempts = email_attempts + ${attempts},
             email_state = CASE WHEN email_attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END
           WHERE id = $1`, [n.id]);
        console.log(`[notify] email failed for notification ${n.id}: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    console.log(`[notify] dispatch failed: ${e?.message || e}`);
  }
}

export function startNotificationDispatcher(): void {
  setTimeout(() => { dispatchNotificationEmails(); }, 45_000);
  setInterval(() => { dispatchNotificationEmails(); }, 60_000);
}
