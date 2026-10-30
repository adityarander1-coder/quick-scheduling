// util/notifyJobs.ts — Notifications Phase 2 jobs (Deepika 2026-10-29).
//
// Three periodic jobs, all best-effort (a failure logs and never breaks
// the app), ticking every 15 minutes in the payrollScheduler style:
//
// 1. Daily digest email — once a day at/after 7:00 AM in each company's
//    timezone, every user with pending "digest"-speed notifications gets
//    ONE email listing them; those rows are marked emailed so they are
//    never re-sent. Rows whose speed became "off" are marked skipped;
//    "instant" rows are left to the 60s dispatcher in util/notify.ts.
// 2. Reminder engine — personal picks only (owner never sets these):
//    for shifts and for sessions separately, each user picks UP TO 2 of
//    30m / 1h / evening (day before 6 PM) / morning (day of 7 AM),
//    company time. Default when never chosen: ['evening']. Exactly-once
//    is guaranteed by notification_reminder_log. Sessions are expanded
//    with the SAME code the schedule read uses (routes/schedule.ts
//    expandAcademicSessions + loadOverrides — no second expansion).
// 3. Message bundle email — a user whose visible unread messages have
//    been sitting unread for 30+ minutes gets ONE message_bundle
//    notification (never one per message). Email delivery flows through
//    the normal dispatcher, so the messages speed applies.
import { query } from '../db.js';
import { sendMail, escHtml } from './mailer.js';
import { notify, resolveSpeed, fmtDateLong } from './notify.js';
import { getDepartmentAccess } from './departmentAccess.js';

// ---------------------------------------------------------------------------
// Reminder picks — shared by the prefs API (routes/notifications.ts)
// ---------------------------------------------------------------------------

export const REMINDER_PICKS = ['30m', '1h', 'evening', 'morning'] as const;
export type ReminderPick = (typeof REMINDER_PICKS)[number];
export type ReminderKind = 'shift' | 'session';
export const REMINDER_KINDS: ReminderKind[] = ['shift', 'session'];
export const DEFAULT_REMINDER_PICKS: ReminderPick[] = ['evening'];

/** Validate + dedupe a picks value. Returns null when invalid. */
export function validateReminderPicks(v: any): ReminderPick[] | null {
  if (!Array.isArray(v)) return null;
  const out: ReminderPick[] = [];
  for (const p of v) {
    if (!(REMINDER_PICKS as readonly string[]).includes(p)) return null;
    if (!out.includes(p as ReminderPick)) out.push(p as ReminderPick);
  }
  if (out.length > 2) return null;
  return out;
}

/** One user's reminder picks; a kind never chosen defaults to ['evening']. */
export async function getReminderPrefs(userId: string): Promise<Record<ReminderKind, ReminderPick[]>> {
  const out: Record<ReminderKind, ReminderPick[]> = {
    shift: [...DEFAULT_REMINDER_PICKS],
    session: [...DEFAULT_REMINDER_PICKS],
  };
  const { rows } = await query('SELECT kind, picks FROM notification_reminder_prefs WHERE user_id = $1', [userId]);
  for (const r of rows) {
    const picks = validateReminderPicks(r.picks);
    if (picks && (r.kind === 'shift' || r.kind === 'session')) out[r.kind as ReminderKind] = picks;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Company-timezone helpers (company_settings key 'timezone', as Ask uses)
// ---------------------------------------------------------------------------

const FALLBACK_TZ = 'America/Chicago';

export async function companyTimezone(companyId: string): Promise<string> {
  try {
    const { rows } = await query(`SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`, [companyId]);
    const tz = rows[0]?.value;
    if (tz) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { /* bad stored value */ }
    }
  } catch { /* settings unavailable — default */ }
  return FALLBACK_TZ;
}

interface LocalParts { y: number; mo: number; d: number; h: number; mi: number }

function localParts(date: Date, tz: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => +(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

function localDateStr(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseTimeToHM(t: string | null | undefined): { h: number; mi: number } | null {
  if (!t) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

function fmtTime12(hm: { h: number; mi: number }): string {
  const ampm = hm.h >= 12 ? 'PM' : 'AM';
  const h12 = hm.h % 12 === 0 ? 12 : hm.h % 12;
  return `${h12}:${String(hm.mi).padStart(2, '0')} ${ampm}`;
}

// ---------------------------------------------------------------------------
// 1. Daily digest email
// ---------------------------------------------------------------------------

const REMINDER_TYPES = ['shift_reminder', 'session_reminder'];
const CATEGORY_LABEL: Record<string, string> = {
  schedule: 'Schedule', calendar: 'Calendar sessions', approvals: 'Approvals & requests', messages: 'Messages',
};
const CATEGORY_ORDER = ['schedule', 'calendar', 'approvals', 'messages'];

export async function sendDailyDigests(now: Date = new Date()): Promise<void> {
  try {
    const { rows: companies } = await query(
      `SELECT DISTINCT company_id FROM notifications WHERE email_state = 'pending'`);
    for (const c of companies) {
      try {
        await sendCompanyDigest(String(c.company_id), now);
      } catch (e: any) {
        console.log(`[digest] company ${c.company_id} failed: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    console.log(`[digest] run failed: ${e?.message || e}`);
  }
}

async function sendCompanyDigest(companyId: string, now: Date): Promise<void> {
  const tz = await companyTimezone(companyId);
  if (localParts(now, tz).h < 7) return; // digest goes out at/after 7 AM company time
  const todayLocal = localDateStr(now, tz);
  const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
  const { rows: users } = await query(
    `SELECT DISTINCT user_id FROM notifications WHERE company_id = $1 AND email_state = 'pending'`, [companyId]);
  for (const u of users) {
    const userId = String(u.user_id);
    const { rows } = await query(
      `SELECT n.*, usr.email FROM notifications n JOIN users usr ON usr.id = n.user_id
       WHERE n.company_id = $1 AND n.user_id = $2 AND n.email_state = 'pending'
       ORDER BY n.created_at ASC`,
      [companyId, userId]);
    const digestRows: any[] = [];
    for (const n of rows) {
      if (REMINDER_TYPES.includes(n.type)) continue; // reminders belong to the instant dispatcher
      const speed = await resolveSpeed(companyId, userId, n.category, n.type);
      if (speed === 'off') {
        await query(`UPDATE notifications SET email_state = 'skipped' WHERE id = $1`, [n.id]);
        continue;
      }
      if (speed !== 'digest') continue; // settled instant rows belong to the 60s dispatcher
      // "Everything from the last day": anything from a previous local
      // day, plus anything at least an hour old from this morning.
      const created = new Date(n.created_at);
      if (localDateStr(created, tz) < todayLocal || now.getTime() - created.getTime() >= 60 * 60 * 1000) {
        digestRows.push(n);
      }
    }
    if (!digestRows.length) continue;
    const count = digestRows.reduce(
      (sum: number, n: any) => sum + (typeof n.payload?.count === 'number' ? n.payload.count : 1), 0);
    const subject = `Your daily digest — ${count} update${count === 1 ? '' : 's'}`;
    const byCat = new Map<string, any[]>();
    for (const n of digestRows) {
      const arr = byCat.get(n.category) || [];
      arr.push(n);
      byCat.set(n.category, arr);
    }
    const textLines: string[] = ['Here is your daily update from Quick Scheduling:', ''];
    const htmlParts: string[] = ['<p>Here is your daily update from Quick Scheduling:</p>'];
    for (const cat of CATEGORY_ORDER) {
      const items = byCat.get(cat);
      if (!items) continue;
      textLines.push(CATEGORY_LABEL[cat] || cat, ...items.map((n: any) => `• ${n.title}`), '');
      htmlParts.push(
        `<p><strong>${escHtml(CATEGORY_LABEL[cat] || cat)}</strong></p><ul>` +
        items.map((n: any) => `<li>${escHtml(n.title)}</li>`).join('') + '</ul>');
    }
    textLines.push(`Open Quick Scheduling: ${baseUrl}`);
    htmlParts.push(`<p><a href="${baseUrl}">Open Quick Scheduling</a></p>`);
    try {
      await sendMail({ to: digestRows[0].email, subject, text: textLines.join('\n'), html: htmlParts.join('') });
      await query(
        `UPDATE notifications SET email_state = 'sent', email_sent_at = now() WHERE id = ANY($1::uuid[])`,
        [digestRows.map((n: any) => n.id)]);
      console.log(`[digest] sent ${digestRows.length} notification(s) to user ${userId}`);
    } catch (e: any) {
      await query(
        `UPDATE notifications SET email_attempts = email_attempts + 1,
           email_state = CASE WHEN email_attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END
         WHERE id = ANY($1::uuid[])`,
        [digestRows.map((n: any) => n.id)]);
      console.log(`[digest] email failed for user ${userId}: ${e?.message || e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Reminder engine
// ---------------------------------------------------------------------------

type ZonedToUtc = (y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string) => Date;

function reminderFireMs(pick: ReminderPick, startMs: number, dateStr: string, tz: string, zonedToUtc: ZonedToUtc): number {
  if (pick === '30m') return startMs - 30 * 60 * 1000;
  if (pick === '1h') return startMs - 60 * 60 * 1000;
  if (pick === 'evening') {
    const prev = addDays(dateStr, -1).split('-').map(Number);
    return zonedToUtc(prev[0], prev[1], prev[2], 18, 0, 0, tz).getTime();
  }
  const p = dateStr.split('-').map(Number); // morning of
  return zonedToUtc(p[0], p[1], p[2], 7, 0, 0, tz).getTime();
}

async function fireReminderOnce(args: {
  companyId: string; userId: string; kind: ReminderKind; eventKey: string; pick: ReminderPick;
  category: 'schedule' | 'calendar'; type: string; title: string; body: string; link: string;
  payload: Record<string, any>;
}): Promise<boolean> {
  // The log row IS the dedupe: only the first insert fires.
  const { rows } = await query(
    `INSERT INTO notification_reminder_log (company_id, user_id, kind, event_key, pick)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, kind, event_key, pick) DO NOTHING RETURNING id`,
    [args.companyId, args.userId, args.kind, args.eventKey, args.pick]);
  if (!rows.length) return false;
  await notify({
    companyId: args.companyId, userIds: [args.userId], category: args.category, type: args.type,
    title: args.title, body: args.body, link: args.link, payload: args.payload,
  });
  return true;
}

export async function runReminderScan(now: Date = new Date()): Promise<void> {
  try {
    // Session expansion lives in the schedule router; import lazily so
    // this util never creates a module cycle at load time.
    const sched = await import('../routes/schedule.js');
    const { rows: companies } = await query('SELECT id FROM companies');
    for (const c of companies) {
      try {
        await scanCompanyReminders(String(c.id), now, sched);
      } catch (e: any) {
        console.log(`[reminders] company ${c.id} failed: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    console.log(`[reminders] run failed: ${e?.message || e}`);
  }
}

async function scanCompanyReminders(companyId: string, now: Date, sched: any): Promise<void> {
  const tz = await companyTimezone(companyId);
  const { rows: users } = await query(
    'SELECT id FROM users WHERE company_id = $1 AND is_active = true', [companyId]);
  if (!users.length) return;
  const userIds = users.map((u: any) => String(u.id));
  const { rows: prefRows } = await query(
    'SELECT user_id, kind, picks FROM notification_reminder_prefs WHERE user_id = ANY($1::uuid[])', [userIds]);
  const prefMap = new Map<string, Record<ReminderKind, ReminderPick[]>>();
  for (const id of userIds) {
    prefMap.set(id, { shift: [...DEFAULT_REMINDER_PICKS], session: [...DEFAULT_REMINDER_PICKS] });
  }
  for (const r of prefRows) {
    const picks = validateReminderPicks(r.picks);
    const entry = prefMap.get(String(r.user_id));
    if (entry && picks && (r.kind === 'shift' || r.kind === 'session')) entry[r.kind as ReminderKind] = picks;
  }
  for (const userId of userIds) {
    const prefs = prefMap.get(userId)!;
    if (prefs.shift.length) await scanShiftReminders(companyId, userId, tz, prefs.shift, now, sched.zonedToUtc);
    if (prefs.session.length) await scanSessionReminders(companyId, userId, tz, prefs.session, now, sched);
  }
}

async function scanShiftReminders(
  companyId: string, userId: string, tz: string, picks: ReminderPick[], now: Date, zonedToUtc: ZonedToUtc,
): Promise<void> {
  const from = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10);
  // Published shifts only — a shift's own published flag (drafts never remind).
  const { rows } = await query(
    `SELECT s.id, s.date::text AS date, st.name AS type_name, st.start_time AS start_time
     FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.company_id = $1 AND s.user_id = $2 AND s.published = true
       AND s.date >= $3 AND s.date <= $4`,
    [companyId, userId, from, to]);
  for (const s of rows) {
    const dateStr = String(s.date);
    // A shift type without a start time reminds as if it starts 9:00 AM.
    const hm = parseTimeToHM(s.start_time) || { h: 9, mi: 0 };
    const p = dateStr.split('-').map(Number);
    const startMs = zonedToUtc(p[0], p[1], p[2], hm.h, hm.mi, 0, tz).getTime();
    for (const pick of picks) {
      const fireMs = reminderFireMs(pick, startMs, dateStr, tz, zonedToUtc);
      if (fireMs <= now.getTime() && now.getTime() < startMs) {
        await fireReminderOnce({
          companyId, userId, kind: 'shift', eventKey: `shift:${s.id}`, pick,
          category: 'schedule', type: 'shift_reminder',
          title: `Reminder: ${s.type_name} on ${fmtDateLong(dateStr)}`,
          body: `Your ${s.type_name} shift starts at ${fmtTime12(hm)} on ${fmtDateLong(dateStr)}.`,
          link: 'my-schedule', payload: { shiftId: s.id, date: dateStr, pick },
        });
      }
    }
  }
}

async function scanSessionReminders(
  companyId: string, userId: string, tz: string, picks: ReminderPick[], now: Date, sched: any,
): Promise<void> {
  const from = new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  // Same base row shape + windowing the schedule read uses, narrowed to
  // sessions this user presents or supervises.
  const { rows } = await query(
    `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
            sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
     FROM academic_sessions s
     LEFT JOIN users u ON u.id = s.lecturer_user_id
     LEFT JOIN users sup ON sup.id = s.supervisor_user_id
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.company_id = $1 AND (s.lecturer_user_id = $2 OR s.supervisor_user_id = $2)
       AND (s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $3)
       AND s.session_date <= $4`,
    [companyId, userId, from, to]);
  if (!rows.length) return;
  let ovMap = new Map<string, any>();
  const userName = new Map<string, string>();
  if (rows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
    ovMap = await sched.loadOverrides(companyId, rows.map((r: any) => r.id), from, to);
    const { rows: us } = await query('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [companyId]);
    for (const u of us) userName.set(String(u.id), [u.first_name, u.last_name].filter(Boolean).join(' '));
  }
  const occurrences = sched.expandAcademicSessions(rows, from, to, ovMap, userName);
  for (const occ of occurrences) {
    const isPresenter = occ.lecturerUserId === userId;
    const isSupervisor = occ.supervisorUserId === userId;
    if (!isPresenter && !isSupervisor) continue; // an override moved this date to someone else
    const dateStr = String(occ.date);
    // A session without a start time reminds as if it starts 9:00 AM.
    const hm = parseTimeToHM(occ.startTime) || { h: 9, mi: 0 };
    const p = dateStr.split('-').map(Number);
    const startMs = sched.zonedToUtc(p[0], p[1], p[2], hm.h, hm.mi, 0, tz).getTime();
    const eventKey = `session:${occ.seriesId || occ.id}:${dateStr}`;
    for (const pick of picks) {
      const fireMs = reminderFireMs(pick, startMs, dateStr, tz, sched.zonedToUtc);
      if (fireMs <= now.getTime() && now.getTime() < startMs) {
        await fireReminderOnce({
          companyId, userId, kind: 'session', eventKey, pick,
          category: 'calendar', type: 'session_reminder',
          title: `Reminder: ${occ.title} on ${fmtDateLong(dateStr)}`,
          body: `You ${isPresenter ? 'present' : 'supervise'} "${occ.title}" at ${fmtTime12(hm)} on ${fmtDateLong(dateStr)}.`,
          link: 'calendars', payload: { sessionId: occ.seriesId || occ.id, date: dateStr, pick },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Message bundle email
// ---------------------------------------------------------------------------

/** Department ids whose message channel this user can see (mirrors the
 *  channels route: owner = all, scheduler = view access, employee = own). */
async function visibleDeptIdsFor(companyId: string, user: any): Promise<string[]> {
  if (user.role === 'owner') {
    const { rows } = await query('SELECT id FROM departments WHERE company_id = $1', [companyId]);
    return rows.map((r: any) => String(r.id));
  }
  if (user.role === 'scheduler') {
    try {
      const access = await getDepartmentAccess(String(user.id), companyId);
      return access.view || [];
    } catch { return []; }
  }
  return user.department_id ? [String(user.department_id)] : [];
}

export async function runMessageBundleCheck(now: Date = new Date()): Promise<void> {
  try {
    const { rows: companies } = await query('SELECT id FROM companies');
    for (const c of companies) {
      try {
        await checkCompanyMessageBundles(String(c.id), now);
      } catch (e: any) {
        console.log(`[msg-bundle] company ${c.id} failed: ${e?.message || e}`);
      }
    }
  } catch (e: any) {
    console.log(`[msg-bundle] run failed: ${e?.message || e}`);
  }
}

async function checkCompanyMessageBundles(companyId: string, now: Date): Promise<void> {
  const { rows: users } = await query(
    'SELECT id, role, department_id FROM users WHERE company_id = $1 AND is_active = true', [companyId]);
  for (const u of users) {
    const userId = String(u.id);
    const deptIds = await visibleDeptIdsFor(companyId, u);
    // Unread = visible, not sent by me, newer than my per-channel read
    // cursor — the same definition the channels route counts with. The
    // CASE rebuilds each message's channel key for the cursor join.
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n, MIN(m.created_at) AS oldest, MAX(m.created_at) AS newest
       FROM messages m
       LEFT JOIN message_reads r ON r.user_id = $2 AND r.channel_key = CASE
         WHEN m.kind = 'company' THEN 'company'
         WHEN m.kind = 'department' THEN 'dept:' || m.department_id::text
         WHEN m.kind = 'group' THEN 'group:' || m.group_id::text
         WHEN m.kind = 'dm' AND array_length(string_to_array(m.dm_key, '|'), 1) = 2
           THEN 'dm:' || (SELECT x FROM unnest(string_to_array(m.dm_key, '|')) AS x WHERE x <> $2::text LIMIT 1)
         WHEN m.kind = 'dm'
           THEN 'dmg:' || (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(string_to_array(m.dm_key, '|')) AS x WHERE x <> $2::text)
         ELSE 'none'
       END
       WHERE m.company_id = $1 AND m.sender_id <> $2
         AND (m.kind = 'company'
              OR (m.kind = 'department' AND m.department_id = ANY($3::uuid[]))
              OR (m.kind = 'group' AND EXISTS (SELECT 1 FROM message_group_members gm
                    WHERE gm.group_id = m.group_id AND gm.user_id = $2))
              OR (m.kind = 'dm' AND string_to_array(m.dm_key, '|') @> ARRAY[$2::text]))
         AND m.created_at > COALESCE(r.last_read_at, 'epoch'::timestamptz)`,
      [companyId, userId, deptIds]);
    const agg = rows[0];
    if (!agg || !agg.n) continue;
    if (new Date(agg.oldest).getTime() > now.getTime() - 30 * 60 * 1000) continue; // not yet 30 min old
    const { rows: last } = await query(
      `SELECT created_at FROM notifications WHERE user_id = $1 AND type = 'message_bundle'
       ORDER BY created_at DESC LIMIT 1`, [userId]);
    if (last.length && !(new Date(agg.newest).getTime() > new Date(last[0].created_at).getTime())) {
      continue; // nothing new arrived since the last bundle
    }
    const { rows: open } = await query(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'message_bundle'
         AND read_at IS NULL AND email_state = 'pending' LIMIT 1`, [userId]);
    if (open.length) continue; // a bundle is already waiting for this user
    const n = agg.n as number;
    await notify({
      companyId, userIds: [userId], category: 'messages', type: 'message_bundle',
      title: `You have ${n} unread message${n === 1 ? '' : 's'}`,
      body: 'You have unread messages waiting in Quick Scheduling.',
      payload: { count: n },
    });
  }
}

// ---------------------------------------------------------------------------
// Scheduler wiring (payrollScheduler style)
// ---------------------------------------------------------------------------

export function startNotificationJobs(): void {
  const tick = async () => {
    await sendDailyDigests();
    await runReminderScan();
    await runMessageBundleCheck();
  };
  // Run once shortly after startup (DB is ready by then), then every 15 min.
  setTimeout(() => { tick().catch((e) => console.log('[notify-jobs] tick failed:', e?.message || e)); }, 90_000);
  setInterval(() => { tick().catch((e) => console.log('[notify-jobs] tick failed:', e?.message || e)); }, 15 * 60_000);
  console.log('[notify-jobs] digest + reminders + message bundles started (every 15 min)');
}
