/**
 * Email polling service: Gmail IMAP inbox → Gemini parsing → Schedule plans.
 * Uses App Password auth. Creates pending plans for approval. Never modifies schedule directly.
 */

import { listUnreadUids, getImapMessage, markImapAsRead } from './gmailImap.js';
import type { ImapCreds, ImapMessage } from './gmailImap.js';
import { planFromEmail } from './gemini.js';
import type { ImapAttachment } from './gmailImap.js';
import { extractAttachmentContent } from './emailAttachments.js';
import { notify, planApproverIds, companyOwnerIds } from './notify.js';
import {
  MAX_EMAIL_ATTEMPTS,
  getEmailAttempt,
  recordEmailFailure,
  clearEmailAttempt,
  isParked,
  parkedEmailReport,
  normalizeMailbox,
} from './emailAttempts.js';
import type { EmailAttemptRecord } from './emailAttempts.js';
import { isBillingError } from './planHelpers.js';
import { sendMail, escHtml } from './mailer.js';
import { outboundFromFor, senderAllowed } from './inboundAddresses.js';
import {
  savePendingClarification,
  clearPendingClarification,
  matchPendingClarification,
  recordProcessedMessage,
  hasProcessedMessage,
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
    const { rows: dashes } = await query('SELECT id, name FROM dashboards WHERE company_id = $1 AND archived_at IS NULL ORDER BY name', [companyId]);
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
              TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) AS presenter
       FROM academic_sessions s
       LEFT JOIN users l ON l.id = s.lecturer_user_id
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
      const people = s.presenter ? `, speaker ${s.presenter}` : '';
      const loc = s.location ? `, in ${s.location}` : '';
      if (s.recur_rule && s.recur_rule !== 'none') {
        const days = s.recur_days ? String(s.recur_days).split(',').map((x: string) => DAY[parseInt(x, 10)] + 's').join('/')
          : DAY[new Date(s.sdate + 'T00:00:00').getDay()] + 's';
        const every = (s.recur_interval || 1) > 1 ? `every ${s.recur_interval} ` : '';
        const rule = s.recur_rule === 'weekly' || s.recur_rule === 'biweekly' ? `${every}week on ${days}` : s.recur_rule;
        lines.push(`- "${s.title}" on ${dash} — repeats ${rule}${times}${people}${loc}`);
      } else if (s.sdate >= iso(from) && s.sdate <= iso(to)) {
        lines.push(`- "${s.title}" on ${dash} — ${s.sdate}${times}${people}${loc} (one-time)`);
      }
    }
    out.sessions = lines.slice(0, 80);
  } catch { /* context is best-effort; planning still works without it */ }
  return out;
}

const REQUEST_MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const REQUEST_WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Deterministic (no-AI) extraction of the dates a schedule request
 * is about, resolved against `today` (YYYY-MM-DD). Recognises ISO
 * dates, US numeric dates (12/2, 12/02/2026), month-name dates
 * ("dec 2", "December 2nd", "2 Dec"), today/tomorrow, "in N
 * days/weeks", and weekday names (bare/"this" = the coming one,
 * "next" = the following week's — the ±14-day slice around the
 * extracted dates makes the exact weekday convention forgiving).
 * A yearless month/day resolves to its coming occurrence: this
 * year, unless that date is more than 14 days in the past, in
 * which case next year's. Returns sorted unique YYYY-MM-DD dates;
 * an empty array means "no date could be extracted with
 * confidence" and callers fall back to the near window.
 */
export function extractRequestDates(text: string, today: string): string[] {
  const found = new Set<string>();
  const t = ` ${String(text || '').toLowerCase()} `;
  const base = new Date(today + 'T00:00:00Z');
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const mk = (y: number, mo: number, da: number): Date | null => {
    if (mo < 0 || mo > 11 || da < 1 || da > 31) return null;
    const d = new Date(Date.UTC(y, mo, da));
    return d.getUTCFullYear() === y && d.getUTCMonth() === mo && d.getUTCDate() === da ? d : null;
  };
  const yearless = (mo: number, da: number) => {
    let d = mk(base.getUTCFullYear(), mo, da);
    if (!d) return;
    if ((base.getTime() - d.getTime()) / 86400000 > 14) {
      d = mk(base.getUTCFullYear() + 1, mo, da);
      if (!d) return;
    }
    found.add(iso(d));
  };
  for (const m of t.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    const d = mk(+m[1], +m[2] - 1, +m[3]);
    if (d) found.add(iso(d));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      const d = mk(y, +m[1] - 1, +m[2]);
      if (d) found.add(iso(d));
    } else yearless(+m[1] - 1, +m[2]);
  }
  const MON = Object.keys(REQUEST_MONTHS).join('|');
  for (const m of t.matchAll(new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?\\b`, 'g'))) {
    if (m[3]) {
      const d = mk(+m[3], REQUEST_MONTHS[m[1]], +m[2]);
      if (d) found.add(iso(d));
    } else yearless(REQUEST_MONTHS[m[1]], +m[2]);
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})\\b`, 'g'))) {
    yearless(REQUEST_MONTHS[m[2]], +m[1]);
  }
  if (/\btoday\b/.test(t)) found.add(today);
  if (/\btomorrow\b/.test(t)) {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + 1); found.add(iso(d));
  }
  for (const m of t.matchAll(/\bin\s+(\d{1,3})\s+(day|week)s?\b/g)) {
    const n = +m[1] * (m[2] === 'week' ? 7 : 1);
    if (n > 0 && n <= 366) {
      const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); found.add(iso(d));
    }
  }
  const WD = Object.keys(REQUEST_WEEKDAYS).join('|');
  for (const m of t.matchAll(new RegExp(`\\b(next|this)?\\s*(${WD})\\b`, 'g'))) {
    let delta = (REQUEST_WEEKDAYS[m[2]] - base.getUTCDay() + 7) % 7;
    if (m[1] === 'next') delta += 7;
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + delta); found.add(iso(d));
  }
  return [...found].sort();
}

/**
 * Schedule context for the planner (Deepika, 2026-11-10): who actually
 * holds each shift around the dates a request is about — stored
 * shifts AND pattern-drawn occurrences, read through
 * getShiftsForRange, the same source the grid uses — plus a
 * per-person pivot so the planner can see who is working vs off
 * around any day it touches.
 *
 * Why: per Deepika's Nov 8 decision the planner receives the company's
 * roster AND schedule inside each request (and forgets it after); the
 * schedule half was never built, so the planner proposed changes
 * blind — the Nov 10 incident, where it invented a "move" from a man
 * who was not on that day's schedule at all.
 *
 * Bounds (Deepika, 2026-11-10 evening): the data layer may reach any
 * date within 8 months of today ("lets give access to 8 months of
 * schedule"), but 8 months is the REACH, not the payload — "it
 * should only read the part for those dates requested … to save
 * cost." Dates are extracted from the request text deterministically
 * (extractRequestDates, no AI); when dates are found, the day-by-day
 * view is a slice [earliest − 14 days, latest + 14 days] at full
 * detail, plus a small always-present anchor [today−1, today+21]
 * (which also feeds the pivot whole), clamped to the 8-month reach.
 * When NO date can be extracted, it falls back to the pre-8-month
 * behaviour — the near window [today−1, today+60] — so no request
 * ever sees less than it did before. If a block spans more than 62
 * days (a request naming far-apart dates), its tail renders compact
 * — same facts (date, per-type holders, full names) with short type
 * codes spelled out in one legend line and no open-slot markers.
 * A coverage line ALWAYS heads the section ("Schedule shown: …")
 * naming the ranges actually rendered; if the character budget
 * still cuts a block short, the cut marker is guaranteed to print
 * (its space is reserved up front) and the coverage line names the
 * last date actually shown, so a date the planner cannot see is
 * never silently indistinguishable from an empty one — the planner
 * prompt scopes its "not listed = nobody scheduled" rule to the
 * shown ranges. The deterministic gate in planGate.ts always
 * verifies against the FULL record regardless of the slice, so a
 * narrow slice can cause a question, never a wrong applied change.
 * The per-person pivot covers the next 21 days in detail.
 * Best-effort: any failure returns empty lines and planning
 * continues.
 */
export async function buildScheduleContext(
  query: QueryFn, companyId: string, today: string, requestText?: string
): Promise<{ scheduleLines: string[] }> {
  const out = { scheduleLines: [] as string[] };
  try {
    const { getShiftsForRange } = await import('./shiftRange.js');
    const shiftDay = (ds: string, n: number) => {
      const d = new Date(ds + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const reachDate = new Date(today + 'T00:00:00Z');
    reachDate.setUTCMonth(reachDate.getUTCMonth() + 8);
    const REACH_TO = reachDate.toISOString().slice(0, 10);
    const REACH_FROM = shiftDay(today, -31);

    // Blocks of dates to render: [start, end] pairs, sorted, merged.
    const requested = requestText ? extractRequestDates(requestText, today) : [];
    let blocks: Array<[string, string]>;
    if (requested.length) {
      const sliceFrom = shiftDay(requested[0], -14) < REACH_FROM ? REACH_FROM : shiftDay(requested[0], -14);
      const sliceTo = shiftDay(requested[requested.length - 1], 14) > REACH_TO ? REACH_TO : shiftDay(requested[requested.length - 1], 14);
      const raw: Array<[string, string]> = [[shiftDay(today, -1), shiftDay(today, 21)]];
      if (sliceFrom <= sliceTo) raw.push([sliceFrom, sliceTo]);
      raw.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      blocks = [];
      for (const b of raw) {
        const last = blocks[blocks.length - 1];
        if (last && b[0] <= shiftDay(last[1], 1)) {
          if (b[1] > last[1]) last[1] = b[1];
        } else blocks.push([b[0], b[1]]);
      }
    } else {
      blocks = [[shiftDay(today, -1), shiftDay(today, 60)]];
    }

    let entries: Awaited<ReturnType<typeof getShiftsForRange>> = [];
    for (const [bs, be] of blocks) {
      entries = entries.concat(await getShiftsForRange(query, companyId, bs, be));
    }

    // Staffing targets → open slots: a type staffed below its target
    // on a date has that many open slots that day.
    const targets = new Map<string, number>();
    try {
      const { rows: trows } = await query(
        'SELECT shift_type_id, target_count FROM staffing_targets WHERE company_id = $1',
        [companyId]
      );
      for (const r of trows) {
        targets.set(r.shift_type_id, Math.max(targets.get(r.shift_type_id) || 0, Number(r.target_count) || 0));
      }
    } catch { /* targets are an enhancement, not a requirement */ }

    // (a) Day-by-day holders.
    const byDate = new Map<string, Map<string, { name: string; people: string[] }>>();
    for (const e of entries) {
      if (!byDate.has(e.date)) byDate.set(e.date, new Map());
      const byType = byDate.get(e.date)!;
      if (!byType.has(e.shiftTypeId!)) byType.set(e.shiftTypeId!, { name: e.shiftTypeName, people: [] });
      byType.get(e.shiftTypeId!)!.people.push(e.personName);
    }
    // Render each block: its first 62 days at full detail (the
    // pre-8-month format, OPEN markers included); any tail beyond
    // that renders compact — same facts (date, per-type holders,
    // full names) with short type codes and no open-slot markers.
    const blockFullTo = blocks.map(([bs]) => shiftDay(bs, 61));
    const compactNames = new Set<string>();
    for (const [date, byType] of byDate) {
      const bi = blocks.findIndex(([bs, be], i) => date >= bs && date <= be && date > blockFullTo[i]);
      if (bi >= 0) for (const t of byType.values()) compactNames.add(t.name);
    }
    // Short type codes: the initials of each compact-rendered type
    // name, made unique with a numeric suffix on collision. One
    // legend line (placed before the first compact line) spells
    // them out, so the codes stay unambiguous to the planner.
    const codeByName = new Map<string, string>();
    {
      const used = new Map<string, string>();
      for (const name of [...compactNames].sort()) {
        const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
        let base = words.map((w) => w[0]).join('').toUpperCase();
        if (!base) base = name.slice(0, 2).toUpperCase();
        let code = base; let n = 2;
        while (used.has(code) && used.get(code) !== name) code = base + (n++);
        used.set(code, name);
        codeByName.set(name, code);
      }
    }
    const legendLine = codeByName.size
      ? `Type codes: ${[...codeByName.entries()].map(([name, code]) => `${code} = ${name}`).join('; ')}`
      : '';

    const fullLine = (date: string): string => {
      const byType = byDate.get(date)!;
      const parts: string[] = [];
      for (const [typeId, t] of byType) {
        parts.push(`${t.name}: ${t.people.join(', ')}`);
        const target = targets.get(typeId) || 0;
        if (target > t.people.length) parts.push(`${t.name} OPEN ×${target - t.people.length}`);
      }
      for (const [typeId, target] of targets) {
        if (target > 0 && !byType.has(typeId)) {
          const nameRow = entries.find((e) => e.shiftTypeId === typeId);
          // Only list fully-open types we have a name for.
          if (nameRow) parts.push(`${nameRow.shiftTypeName} OPEN ×${target}`);
        }
      }
      const dow = DOW[new Date(date + 'T00:00:00Z').getUTCDay()];
      return `${date} (${dow}): ${parts.join('; ')}`;
    };
    const compactLine = (date: string): string => {
      const byType = byDate.get(date)!;
      const parts: string[] = [];
      for (const t of byType.values()) {
        parts.push(`${codeByName.get(t.name)}: ${t.people.join(', ')}`);
      }
      return `${date}: ${parts.join('; ')}`;
    };
    const sortedDates = [...byDate.keys()].sort();
    const blockItems: Array<Array<{ date: string; line: string; compact: boolean }>> =
      blocks.map(([bs, be], i) => sortedDates
        .filter((date) => date >= bs && date <= be)
        .map((date) => date > blockFullTo[i]
          ? { date, line: compactLine(date), compact: true }
          : { date, line: fullLine(date), compact: false }));

    // (b) Per-person pivot, next 21 days: the planner sees each
    // person's actual working pattern around "now", so "Bon is off
    // Dec 2" is readable straight off the context.
    const pivotTo = shiftDay(today, 21);
    const byPerson = new Map<string, string[]>();
    for (const e of entries) {
      if (e.date < today || e.date > pivotTo) continue;
      if (!byPerson.has(e.personName)) byPerson.set(e.personName, []);
      byPerson.get(e.personName)!.push(`${e.date.slice(5)} ${e.shiftTypeName}`);
    }
    const personLines: string[] = [];
    for (const name of [...byPerson.keys()].sort()) {
      const items = byPerson.get(name)!;
      const shown = items.slice(0, 25);
      personLines.push(`${name} works: ${shown.join('; ')}${items.length > shown.length ? `; …and ${items.length - shown.length} more` : ''}`);
    }

    // The budget is a backstop (slices keep typical contexts near
    // today's size); its space for the coverage line is reserved up
    // front so the honesty lines always print.
    const BUDGET = 64000;
    const COVERAGE_RESERVE = 192; // the coverage line always fits
    const lines: string[] = [];
    let chars = 0;
    const push = (line: string) => {
      if (chars + line.length > BUDGET - COVERAGE_RESERVE) return false;
      lines.push(line); chars += line.length + 1; return true;
    };
    const shown: Array<{ from: string; to: string }> = [];
    let cut = false;
    let legendShown = false;
    let stop = false;
    for (let b = 0; b < blocks.length && !stop; b++) {
      const [bs, be] = blocks[b];
      const items = blockItems[b];
      if (!items.length) {
        // An empty block was still shown — "nobody scheduled
        // anywhere in it" is information the coverage line carries.
        shown.push({ from: bs, to: be });
        continue;
      }
      let blockShownTo: string | null = null;
      for (const it of items) {
        if (it.compact && !legendShown) {
          if (!push(legendLine)) { cut = true; stop = true; break; }
          legendShown = true;
        }
        if (!push(it.line)) { cut = true; stop = true; break; }
        blockShownTo = it.date;
      }
      if (blockShownTo) shown.push({ from: bs, to: blockShownTo });
      else if (cut && !shown.length) shown.push({ from: bs, to: bs });
    }
    if (cut) push('…(schedule list cut for length)');
    if (personLines.length) {
      if (push('Per person, next 21 days:')) {
        for (const l of personLines) if (!push(l)) { push('…(per-person list cut for length)'); break; }
      }
    }
    // Coverage line: the ranges ACTUALLY rendered. A block cut
    // short names its last rendered date — never its promised end.
    const ranges = shown.length ? shown : blocks.map(([a, b]) => ({ from: a, to: b }));
    lines.unshift(`Schedule shown: ${ranges.map((r) => `${r.from} through ${r.to}`).join('; and ')}.`);
    out.scheduleLines = lines;
  } catch { /* context is best-effort; the gate still verifies */ }
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
/**
 * Reply-To for a clarification email: the address this company's
 * scheduling mail is READ at, so the "reply in your own words" option
 * actually delivers the reply into an ingest path where it can be
 * matched to the pending clarification. Without it the mail goes out
 * From the Resend sender and a reply lands at a dead address
 * (Deepika's catch, 2026-11-10).
 *  - Webhook path: the request arrived on a department inbound
 *    address and replies go out From that same address (fromAddr) —
 *    the bare address inside it is the Reply-To.
 *  - Gmail path: the company's own connected inbox (company_inboxes,
 *    the row the scheduler polls), else the legacy shared GMAIL_USER
 *    inbox the poller falls back to.
 * Null when no read address is known — the mail then goes out with
 * no Reply-To, exactly as before.
 */
/** Bare email address out of a value that may carry a display
 * name ("Quick Scheduling <a@b.c>" -> "a@b.c"), or null when the
 * value is not a usable address. Every Reply-To source goes
 * through this so a stored display-name form can never reach
 * Resend as a malformed header. */
function bareAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = String(value).match(/<([^>]+)>/);
  const addr = (m ? m[1] : String(value)).trim().toLowerCase();
  if (!addr || /\s/.test(addr) || (addr.match(/@/g) || []).length !== 1) return null;
  const [local, domain] = addr.split('@');
  return local && domain && domain.includes('.') ? addr : null;
}

async function clarificationReplyTo(
  query: QueryFn, companyId: string, fromAddr: string | null
): Promise<string | null> {
  // Webhook path: the request arrived on a department inbound
  // address and replies go out From that same address (fromAddr) —
  // the bare address inside it is the Reply-To. A malformed
  // value must NOT short-circuit the company lookup below (the
  // old code returned null here, skipping every fallback) — fall
  // through instead.
  if (fromAddr) {
    const addr = bareAddress(fromAddr);
    if (addr) return addr;
    console.log(`[email-poll] clarificationReplyTo: fromAddr ${JSON.stringify(fromAddr)} has no usable address — falling through to the company inbox.`);
  }
  // The company's own connected inbox (company_inboxes, the row
  // the scheduler polls). One retry: a transient pool/connection
  // blip at send time must not silently drop Reply-To (production,
  // 2026-11-11: the click-triggered re-clarification went out with
  // no Reply-To and the sender's reply landed nowhere — the
  // lookup failure was swallowed without a trace, and the code
  // read afterwards found "no defect" because the happy path is
  // identical on every trigger). A lookup that succeeds but finds
  // no usable address is NOT retried — it falls to the legacy env.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { rows } = await query(
        'SELECT gmail_user FROM company_inboxes WHERE company_id = $1 AND is_active = true ORDER BY updated_at DESC LIMIT 1',
        [companyId]
      );
      const user = bareAddress(rows[0]?.gmail_user);
      if (user) return user;
      break;
    } catch (e: any) {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
      else console.log(`[email-poll] clarificationReplyTo: company inbox lookup failed for ${companyId} (after retry): ${e?.message || e}`);
    }
  }
  const legacy = bareAddress(process.env.GMAIL_USER);
  return legacy;
}

export async function processScheduleEmail(
  query: QueryFn,
  companyId: string,
  email: ScheduleEmailInput,
  sourceId: string,
  result: { checked: number; newPlans: number; questionsAnswered: number; errors: string[] },
  opts?: {
    markRead?: () => Promise<void>;
    departmentId?: string;
    /** Set ONLY by the IMAP poller from the message's attempt record
     * when that record carries an outage-forward marker — written
     * under the short-lived forwarding behavior of 2026-10-31 (live
     * data may still carry one): the plan notification then carries
     * a "you may already have handled this" note quoting that date.
     * New billing failures no longer set the marker (outage-handling
     * correction, 2026-10-31). The webhook path never sets it (it
     * has no attempt record), so its plan emails stay unchanged. */
    outageForwardedAt?: string | null;
  }
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
      await recordProcessedMessage(query, companyId, sourceId, 'sender_not_staff');
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
      `SELECT COALESCE(nickname, first_name || ' ' || last_name) as name,
              first_name, last_name, nickname
       FROM users WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    const shiftTypesResult = await query(
      `SELECT name FROM shift_types WHERE company_id = $1`,
      [companyId]
    );
    const members = membersResult.rows.map(r => r.name);
    // Structured roster for the planner (Deepika, 2026-11-10): full
    // name plus its parts and the known-as name, so an exact copy is
    // possible and a fragment visibly matches nobody's full name.
    const memberDetails = membersResult.rows.map((r) => {
      const full = `${r.first_name || ''} ${r.last_name || ''}`.trim().replace(/\s+/g, ' ');
      const bits = [`first name: ${r.first_name || ''}`];
      if (r.nickname && r.nickname !== full) bits.push(`known as: ${r.nickname}`);
      return `${full} (${bits.join('; ')})`;
    });
    const shiftTypes = shiftTypesResult.rows.map(r => r.name);
    const today = new Date().toISOString().split('T')[0];

    // Parse with Gemini (calendar context included so session
    // requests — add / change / cancel a session — can be planned).
    // The company's learned examples ride along (Deepika 2026-11-01):
    // past unclear wording that was later resolved, so the same
    // wording is understood the first time.
    const sessionCtx = await buildSessionContext(query, companyId, today);
    const scheduleCtx = await buildScheduleContext(query, companyId, today, `${email.subject}\n${effectiveBody}`);
    const { getShiftTypeRules } = await import('./planExecutor.js');
    const { getRelevantExamples } = await import('./emailLearning.js');
    const examples = await getRelevantExamples(query, companyId, `${email.subject}\n${effectiveBody}`);
    const plan = await planFromEmail(effectiveBody, email.subject, {
      shiftTypes,
      shiftTypeRules: await getShiftTypeRules(companyId),
      members,
      memberDetails,
      schedule: scheduleCtx.scheduleLines,
      today,
      ...sessionCtx,
      attachmentText: attachmentText || undefined,
      pdfAttachments: pdfAttachments.length ? pdfAttachments : undefined,
      attachmentNotes: attachmentNotes.length ? attachmentNotes : undefined,
      examples: examples.length ? examples : undefined,
    });

    // Parse summary for EVERY email (Deepika, 2026-11-10): the
    // clarification-ordering bug hid behind a parse that was computed
    // and then discarded without a trace. This line makes any future
    // silent case diagnosable from the logs alone.
    console.log(`[email-poll] Message ${sourceId}: parse — emailType=${plan.emailType} changes=${Array.isArray(plan.changes) ? plan.changes.length : 0} confidence=${plan.confidence} needsClarification=${!!plan.needsClarification}`);

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
        // Employee askers get the employee view (Deepika, 2026-11-09
        // — Step 1 of pattern ≠ schedule): published stored shifts
        // only, no rotation preview and no drafts. Owners/schedulers
        // keep the full picture. An unresolved asker (the staff lock
        // above makes this unlikely) fails closed to the employee
        // view.
        const { findUserByAnyEmail } = await import('./formLinks.js');
        const asker = await findUserByAnyEmail(query, companyId, sender.address);
        const { answer, found } = await querySchedule(query, companyId, question,
          { employeeView: !asker || asker.role === 'employee' });
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
          // The answer carries the standing "New request" footer too.
          let ansFooter: { text: string; html: string } | null = null;
          try {
            const { standingFormFooter } = await import('./formLinks.js');
            ansFooter = await standingFormFooter(query, companyId, senderEmail);
          } catch { /* best-effort */ }
          await sendMail({
            ...(fromAddr ? { from: fromAddr } : {}),
            to: senderEmail,
            subject: `Re: ${email.subject}`,
            text: `Hi,\n\nHere's the schedule for ${dateRange}:\n\n${answer}${ansFooter ? `\n\n${ansFooter.text}` : ''}\n\n— Quick Scheduling`,
            html: `<p>Hi,</p><p>Here's the schedule for <strong>${dateRange}</strong>:</p><pre style="font-family:sans-serif;white-space:pre-wrap;">${answer}</pre>${ansFooter ? ansFooter.html : ''}<p>— Quick Scheduling</p>`,
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

    // Ordering (Deepika, 2026-11-10 — the clarification-ordering
    // bug): there is deliberately NO !hasChanges early return here.
    // A parse can carry zero actionable changes AND a clarification
    // the sender is owed (needsClarification set, low confidence, or
    // incomplete fields) — the needsInfo evaluation below must see it
    // first, or the question is computed and silently discarded. The
    // 'skipped' return now sits below that block.

    // Gate: every change must be complete. If the AI left required fields
    // blank (or flagged low confidence / needs clarification), ask the sender
    // for the missing info instead of creating a broken approve link.
    const incomplete = plan.changes
      .map((c: any, i: number) => ({ i, problems: changeProblems(c) }))
      .filter((x: any) => x.problems.length > 0);
    // Exact-name + workability gate (Deepika, 2026-11-10 — the
    // "Kum" → Binod Kumar incident): every person the planner named
    // must resolve EXACTLY against the roster, a move/swap's
    // from-person must actually hold that shift in the real schedule,
    // and nobody may be given a shift that overlaps or breaks the
    // 8-hour rest rule. A failure here does NOT create a plan — it
    // becomes the clarification question below, naming the candidates
    // or the actual holder. (The in-app Task path runs the same gate
    // in finalizeTaskPlan; the form path never needs it — its names
    // come from picked IDs.)
    let gateQuestion: string | null = null;
    let gateItems: any[] | null = null;
    let gateHolderMismatch = false;
    let gateBlockedByConflict = false;
    // The gate verifies plans; when there are no actionable changes
    // no plan can be created, so there is nothing to gate — the
    // clarification below is then driven by the parse's own
    // needsClarification / confidence / incomplete fields.
    if (hasChanges) {
      try {
        const { gatePlanChanges } = await import('./planGate.js');
        const gate = await gatePlanChanges(query, companyId, plan.changes);
        if (!gate.ok) {
          gateQuestion = gate.question;
          gateItems = gate.items || null;
          gateHolderMismatch = !!gate.holderMismatch;
          gateBlockedByConflict = gate.blockedBy === 'conflict';
        }
      } catch (gateErr: any) {
        // Fail closed: an unverifiable plan must not become approvable.
        console.log(`[email-poll] Message ${sourceId}: plan gate failed to run: ${gateErr.message}`);
        gateQuestion = 'I could not check that change against the schedule — could you confirm the full names of the people involved and the date?';
      }
    }
    const needsInfo = incomplete.length > 0 || plan.needsClarification || plan.confidence === 'low' || !!gateQuestion;
    if (needsInfo) {
      let detail = gateQuestion
        ? gateQuestion
        : incomplete.length
        ? incomplete.map((x: any) => `Change ${x.i + 1} (${plan.changes[x.i].action || 'unknown'}): ${x.problems.join(', ')}`).join('; ')
        : (plan.needsClarification || 'I could not understand the requested change well enough to build it.');
      const originalDetail = detail;
      // ONE aggregation point (Deepika, 2026-11-11 — the one-email
      // fix): every question source merges into a single detail +
      // a single items list before the one email is built — the
      // gate's items, the planner question's quoted fragments, the
      // planner's change-field values, and the sender's own words
      // (the planner canonicalizes names before the gate sees them,
      // so 'muh' can only be recovered from the original request).
      // The merge must be COMPLETE — every undecidable element
      // gets a row — or the question stays prose-only: a
      // confident-looking button set that cannot resolve the
      // request is worse than no buttons. Incomplete fields and
      // conflict blocks have no button kind, so they stay prose.
      let clickItems: any[] | null = null;
      try {
        const { deriveNameAmbiguityItems, deriveShiftChoiceItems, resolveNameValues, deriveNameItemsFromRequest } = await import('./planGate.js');
        const { buildDetailFromItems } = await import('./clarifyOptions.js');
        const requestText = `${pendingOriginal ? pendingOriginal.subject : email.subject}\n${pendingOriginal ? pendingOriginal.body : email.body}`;
        const gateShiftItems: any[] = (gateItems || []).filter((it: any) => it.kind === 'shift');
        const gateNameItems: any[] = (gateItems || []).filter((it: any) => it.kind !== 'shift');
        const seenFrag = new Set<string>();
        const nameItems: any[] = [];
        const pushName = (it: any) => {
          const k = String(it.fragment || '').toLowerCase();
          if (!k || seenFrag.has(k)) return;
          seenFrag.add(k);
          nameItems.push(it);
        };
        for (const it of gateNameItems) pushName(it);
        const derived = await deriveNameAmbiguityItems(query, companyId, detail);
        for (const it of derived.items) pushName(it);
        const changeValues: string[] = [];
        for (const ch of (plan.changes || [])) {
          for (const f of ['person', 'fromPerson', 'toPerson']) if ((ch as any)[f]) changeValues.push(String((ch as any)[f]));
        }
        if (changeValues.length) {
          const fromChanges = await resolveNameValues(query, companyId, changeValues);
          for (const it of fromChanges.items) pushName(it);
        }
        for (const it of await deriveNameItemsFromRequest(query, companyId, requestText)) pushName(it);
        // Name rows read in the sender's own word order.
        const lowerReq = requestText.toLowerCase();
        nameItems.sort((a, b) => {
          const ia = lowerReq.indexOf(String(a.fragment || '').toLowerCase());
          const ib = lowerReq.indexOf(String(b.fragment || '').toLowerCase());
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });
        // Shift choice for a planner-composed holder question:
        // recomputed deterministically from the schedule, never
        // parsed from the prose. The gate's own shift item already
        // covers the gate-driven case.
        let shiftItems = gateShiftItems;
        if (!shiftItems.length && nameItems.length) {
          const dates = extractRequestDates(requestText, today);
          const typeNames = [...new Set((plan.changes || []).map((c: any) => c.shiftType).filter(Boolean))];
          shiftItems = await deriveShiftChoiceItems(query, companyId, {
            dates, shiftTypeNames: typeNames,
            fragments: nameItems.map((it) => it.fragment), text: requestText,
          });
        }
        // Order (Deepika's confirmed order for the live case):
        // taker, shift, giver — the shift row sits after the first
        // name row.
        const merged: any[] = [...nameItems];
        for (const s of shiftItems) merged.splice(merged.length ? 1 : 0, 0, s);
        const complete = merged.length > 0
          && !derived.unresolved.length
          && !gateBlockedByConflict
          && !incomplete.length;
        if (complete) {
          const sentences = buildDetailFromItems(merged, detail);
          if (gateHolderMismatch && gateQuestion) {
            // The holder fact is what-is-known context the rows
            // don't state; the gate's proposal sentence is dropped
            // (the shift row is the decision now).
            const first = String(gateQuestion).match(/^.*?[.!?](\s|$)/);
            detail = `${first ? first[0].trim() : gateQuestion} ${sentences}`;
          } else {
            detail = sentences;
          }
          clickItems = merged;
        }
      } catch (mergeErr: any) {
        console.log(`[email-poll] Clarification merge failed: ${mergeErr.message}`);
        detail = originalDetail;
        clickItems = null;
      }
      // The clarification email carries a generated Message-ID so the
      // sender's reply can be threaded back (match rule (a)); the
      // sender+subject fallback covers clients that drop the header.
      const fromDomain = ((fromAddr || process.env.RESEND_FROM || '').match(/@([^\s>]+)/) || [])[1] || 'quick-scheduling';
      const clarMessageId = `<qs-clar-${crypto.randomUUID()}@${fromDomain}>`;
      // Two ways to finish (Deepika 2026-11-01): the form is the
      // recommended one — it opens already knowing who they are and
      // submits straight into a plan; a plain-words reply also works.
      let clarFormUrl: string | null = null;
      let senderUserId: string | null = null;
      try {
        const { findUserByAnyEmail, createClarificationFormLink, formLinkUrl } = await import('./formLinks.js');
        const senderUser = await findUserByAnyEmail(query, companyId, sender.address);
        senderUserId = senderUser ? senderUser.id : null;
        const link = await createClarificationFormLink(query, companyId, senderUser ? senderUser.id : null, sender.address, {
          originalSubject: pendingOriginal ? pendingOriginal.subject : email.subject,
          originalBody: pendingOriginal ? pendingOriginal.body : email.body,
          missing: detail,
          messageId: clarMessageId,
        });
        clarFormUrl = formLinkUrl(link.token);
      } catch (linkErr: any) {
        console.log(`[email-poll] Clarification form link failed: ${linkErr.message}`);
      }
      // Clickable options (Deepika, 2026-11-10; one-email fix
      // 2026-11-11): the items were merged above into ONE list for
      // this one email — no items → the email below stays
      // byte-identical to the prose-only one and no token is stored.
      let clickToken: string | null = null;
      let optionsBlock: { text: string; html: string } | null = null;
      if (clickItems && clickItems.length) {
        try {
          const { buildOptionsEmailBlock } = await import('./clarifyOptions.js');
          clickToken = crypto.randomBytes(24).toString('base64url');
          optionsBlock = buildOptionsEmailBlock(clickItems, clickToken, clarFormUrl);
        } catch (optErr: any) {
          console.log(`[email-poll] Clarification options failed: ${optErr.message}`);
          detail = originalDetail;
          clickItems = null; clickToken = null; optionsBlock = null;
        }
      }
      // Reply-To: the address this company's scheduling mail is read
      // at, so option 2 ("just reply to this email") delivers the
      // reply into the polled inbox / inbound route instead of the
      // dead Resend sender address.
      let clarReplyTo: string | null = null;
      try { clarReplyTo = await clarificationReplyTo(query, companyId, fromAddr); } catch { /* no Reply-To */ }
      // Never silent (Deepika, 2026-11-11): a clarification
      // without Reply-To sends the sender's reply to the dead
      // Resend address, so a missing value is logged with the
      // company and recipient instead of disappearing.
      if (!clarReplyTo) console.log(`[email-poll] Clarification to ${sender.address} (company ${companyId}) has NO Reply-To — a reply will go to the dead sender address.`);
      try {
        const { sendMail } = await import('./mailer.js');
        await sendMail({
          ...(fromAddr ? { from: fromAddr } : {}),
          ...(clarReplyTo ? { replyTo: clarReplyTo } : {}),
          to: sender.address,
          subject: `Re: ${email.subject}`,
          text: `Hi,\n\nI wanted to apply your schedule change but I'm missing something: ${detail}${optionsBlock ? `\n\n${optionsBlock.text}\n` : ''}\n\nTwo ways to finish this:\n\n1) Recommended — use the short form (it takes under a minute, and it is read exactly):${clarFormUrl ? `\n${clarFormUrl}` : ' open the ✉️ Email Q-Scheduler form in the app.'}\n\n2) Or just reply to this email in your own words with the missing detail, and I'll build the change for approval.\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>I wanted to apply your schedule change but I'm missing something: <strong>${detail}</strong></p>${optionsBlock ? optionsBlock.html : ''}<p>Two ways to finish this:</p><p><strong>1) Recommended</strong> — use the short form (under a minute, and it is read exactly):</p>${clarFormUrl ? `<p><a href="${clarFormUrl}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Finish it with the form</a></p>` : '<p>Open the ✉️ Email Q-Scheduler form in the app.</p>'}<p><strong>2)</strong> Or just reply to this email in your own words with the missing detail, and I'll build the change for approval.</p><p>— Quick Scheduling</p>`,
          headers: { 'Message-ID': clarMessageId },
        });
        console.log(`[email-poll] Clarification requested from ${sender.address}: ${detail}`);
        // Idempotency (Deepika, 2026-11-11): a clarification writes
        // no plan row, so the plan-row check in pollInbox cannot see
        // it — record the send here, at the point of effect, so a
        // second tick or a failed markRead can never send it twice.
        await recordProcessedMessage(query, companyId, sourceId, 'clarification_sent');
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
          detail, clarMessageId,
          clickItems && clickToken ? { options: { items: clickItems }, answerToken: clickToken } : undefined
        );
      } catch (saveErr: any) {
        console.log(`[email-poll] Saving pending clarification failed: ${saveErr.message}`);
      }
      // In-app surface for the same question (Deepika, 2026-11-10):
      // the requester's bell entry opens the answer page when
      // logged in. (No options → nothing new in-app, as today.)
      if (clickItems && clickToken && senderUserId) {
        try {
          await notify({
            companyId,
            userIds: [senderUserId],
            category: 'schedule',
            type: 'email_clarification',
            title: 'Quick question about your schedule request',
            body: detail,
            link: `/api/schedule/clarify/${clickToken}`,
            bundleKey: `email_clarification:${companyId}:${sender.address}`,
          });
        } catch { /* best-effort */ }
      }
      if (opts?.markRead) await opts.markRead();
      return { kind: 'clarification_sent', answeredQuestion };
    }

    // Skip if there is nothing actionable to plan AND nothing to
    // ask about (not a change/bulk/settings request, or no changes
    // in it, and no clarification owed). The skip is LOGGED with the
    // parse summary — an unlogged skip is what let the Nov 10
    // clarification-ordering bug pass unnoticed.
    if (!hasChanges) {
      console.log(`[email-poll] Skipped ${sourceId}: emailType=${plan.emailType} changes=${changes.length} confidence=${plan.confidence} needsClarification=${!!plan.needsClarification} — ${plan.summary || ''}`);
      await recordProcessedMessage(query, companyId, sourceId, 'skipped');
      if (opts?.markRead) await opts.markRead();
      return { kind: 'skipped' };
    }

    // The requester confirmation carries the standing "New request"
    // footer (form recommended / plain words) when we can build it.
    let reqFooter: { text: string; html: string } | null = null;
    try {
      const { standingFormFooter } = await import('./formLinks.js');
      reqFooter = await standingFormFooter(query, companyId, sender.address);
    } catch { /* best-effort */ }
    const planId = await createPendingPlanFromChanges(query, companyId, plan, {
      sourceId,
      subject: email.subject,
      cc: email.cc || null,
      body: effectiveBody,
      senderAddress: sender.address,
      senderName: sender.name || null,
      fromAddr,
      fromLine,
      outageForwardedAt: opts?.outageForwardedAt,
      requesterFooter: reqFooter || undefined,
    });
    void planId;
    // Idempotency (Deepika, 2026-11-11): the plan row itself is
    // pollInbox's dedupe key, but the processed record closes the
    // same hole for every outcome uniformly.
    await recordProcessedMessage(query, companyId, sourceId, 'plan_created');
    // Learning (Deepika 2026-11-01): this email resolved a pending
    // clarification into a real plan — save the pair (their original
    // unclear words -> the clean request) in the company's example
    // book so the same wording is understood the first time.
    if (pendingOriginal) {
      try {
        const { saveLearningExample } = await import('./emailLearning.js');
        const resolvedText = `${plan.summary || ''} Changes: ${(plan.changes || []).map((c: any) =>
          [c.action, c.person || c.fromPerson || '', c.shiftType || c.sessionTitle || c.title || '', c.date || c.fromDate || ''].filter(Boolean).join(' ')
        ).join('; ')}`;
        await saveLearningExample(query, companyId, pendingOriginal.body || pendingOriginal.subject, resolvedText, 'clarification-reply');
      } catch { /* best-effort */ }
    }
    if (opts?.markRead) await opts.markRead();
    return { kind: 'plan_created', answeredQuestion };
  } catch (err: any) {
    result.errors.push(`Message ${sourceId}: ${err.message}`);
    return undefined;
  }
}

  /** One plain-language rendering of a plan's changes — shared by the
 * requester confirmation, the approver email and the swap-partner
 * email so everyone reads exactly what will happen. */
export function renderChangeList(plan: any): string {
  return (plan.changes || []).map((c: any, i: number) => {
    const desc = c.action === 'assign_recurring' ? `${c.person} → ${c.shiftType} every ${c.intervalWeeks} weeks from ${c.startDate}${c.weekendsOff ? ', weekdays only' : ''}${c.untilDate ? ` until ${c.untilDate}` : ''}`
      : c.action === 'assign' ? `${c.person} → ${c.shiftType} on ${c.date}`
      : c.action === 'unassign' ? `Remove ${c.person} from ${c.shiftType ? `${c.shiftType} ` : ''}on ${c.date}`
      : c.action === 'swap' ? `Swap: ${c.fromPerson}'s ${c.shiftType || 'shift'} on ${c.fromDate || c.date} ↔ ${c.toPerson}'s shift on ${c.toDate || c.date}`
      : c.action === 'move' ? `Move ${c.fromPerson}'s ${c.shiftType || 'shift'} on ${c.date} to ${c.toPerson}`
      : c.action === 'add_shift_type' ? `Add shift "${c.shiftType}" to ${c.department}`
      : c.action === 'set_staffing_target' ? `Set ${c.shiftType} staffing to ${c.targetCount}`
      : c.action === 'add_session' ? `Add session "${c.title}" on ${c.dashboard} (${c.date})`
      : c.action === 'update_session' ? `Change session "${c.sessionTitle}" on ${c.dashboard}${c.date ? ` (${c.date})` : ''}`
      : c.action === 'cancel_session' ? `Cancel session "${c.sessionTitle}" on ${c.dashboard}${c.date ? ` (${c.date})` : ''}`
      : `${c.action}`;
    return `${i + 1}. ${desc}${c.warning ? `\n   ⚠️ ${c.warning}` : ''}${c.conflict ? `\n   ⛔ ${c.conflict}` : ''}`;
  }).join('\n');
}

/** Resolve the ONE swap partner a plan involves (Deepika 2026-11-01:
 * a swap goes to the partner first). The caller may hint the partner
 * (the request form knows exactly who was picked); otherwise the
 * swap changes' toUserId / toPerson names resolve within the company.
 * Returns null when the plan has no swap, several partners, or the
 * partner cannot be resolved — those plans keep the direct-to-
 * approvers flow. The requester is never their own partner. */
async function resolveSwapPartner(
  query: QueryFn, companyId: string, plan: any,
  requesterId: string | null, hintedPartnerId?: string | null,
): Promise<{ id: string; name: string | null } | null> {
  const hasSwap = (plan.changes || []).some((c: any) => c.action === 'swap');
  if (!hasSwap && !hintedPartnerId) return null;
  const nameOf = async (id: string): Promise<string | null> => {
    const { rows } = await query(
      `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [id, companyId]);
    return rows.length ? (rows[0].name || null) : null;
  };
  if (hintedPartnerId) {
    if (requesterId && hintedPartnerId === requesterId) return null;
    const name = await nameOf(hintedPartnerId);
    return name !== null ? { id: hintedPartnerId, name } : null;
  }
  const partners = new Map<string, string | null>();
  for (const c of plan.changes || []) {
    if (c.action !== 'swap') continue;
    if (c.toUserId) { partners.set(String(c.toUserId), c.toPerson || null); continue; }
    if (c.toPerson) {
      const { rows } = await query(
        `SELECT id FROM users WHERE company_id = $1 AND is_active = true
           AND TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) = $2`,
        [companyId, String(c.toPerson)]);
      if (rows.length === 1) partners.set(rows[0].id, String(c.toPerson));
    }
  }
  if (partners.size !== 1) return null;
  const [id, name] = [...partners.entries()][0];
  if (requesterId && id === requesterId) return null;
  return { id, name: name || (await nameOf(id)) };
}

/** Bell + emails telling the APPROVERS a plan is waiting. Runs when a
 * plan is born 'pending', or later when a swap partner agrees and the
 * plan is released to them (releasePlanToApprovers). `ctx` carries
 * everything the mails quote; the release path rebuilds it from the
 * stored plan row. All steps best-effort. */
export async function notifyPlanApprovers(
  query: QueryFn, companyId: string, planId: string, plan: any,
  ctx: {
    fromLine: string; cc: string | null; subject: string; body: string;
    fromAddr?: string | null; outageForwardedAt?: any; changeList: string;
    approveToken: string; rejectToken: string;
  },
): Promise<void> {
  const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
  // Bell for the approvers: a plan is waiting (Phase 1 notifications).
  try {
    const approvers = await planApproverIds(companyId);
    if (approvers.length) {
      await notify({
        companyId, userIds: approvers, category: 'approvals', type: 'plan_waiting',
        title: 'A schedule plan is waiting for approval',
        body: plan.summary || `Plan from ${ctx.fromLine}`,
        link: 'requests', bundleKey: 'plan_waiting',
        bundleTitle: '{count} schedule plans are waiting for approval',
      });
    }
  } catch { /* non-fatal */ }

  try {
    const { sendMail } = await import('./mailer.js');
    const notifyEmail = process.env.NOTIFICATION_EMAIL || 'adityarander1@gmail.com';
    const ccLine = ctx.cc ? `\nCc: ${ctx.cc}` : '';
    const outageNote = ctx.outageForwardedAt
      ? `Note: this email was forwarded to you on ${formatOutageForwardDate(ctx.outageForwardedAt)} during an AI credit outage. If you already handled it manually, please Reject this plan.`
      : null;
    const planMail = (approveUrl: string, rejectUrl: string) => ({
      subject: `New schedule change plan: ${(plan.summary || '').substring(0, 60)}`,
      text: `${outageNote ? outageNote + '\n\n' : ''}A new schedule change plan is ready for your approval.\n\nSummary: ${plan.summary}\n\nFrom: ${ctx.fromLine}${ccLine}\nSubject: ${ctx.subject}\n\nWhat they asked:\n${ctx.body}\n\nChanges to apply:\n${ctx.changeList}\n\nApprove: ${approveUrl}\nReject: ${rejectUrl}\n\nOr review in the app: ${baseUrl}\n\nPlease don't reply to this email — replies to it aren't read. To correct this plan, Reject it and ask for a new request.`,
      html: `${outageNote ? `<p><strong>${escHtml(outageNote)}</strong></p>` : ''}<p>A new schedule change plan is ready for your approval.</p><p><strong>Summary:</strong> ${plan.summary}</p><p>From: ${ctx.fromLine}${ctx.cc ? `<br>Cc: ${ctx.cc}` : ''}<br>Subject: ${ctx.subject}</p><p><strong>What they asked:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${escHtml(ctx.body)}</pre><p><strong>Changes to apply:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${escHtml(ctx.changeList)}</pre><p><a href="${approveUrl}" style="background:#22c55e;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Approve & Apply</a><a href="${rejectUrl}" style="background:#ef4444;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reject</a></p><p><a href="${baseUrl}">Or review in the app</a></p><p>Please don't reply to this email — replies to it aren't read. To correct this plan, Reject it and ask for a new request.</p>`,
    });

    // One token pair per approver (deduped by email address).
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
    if (!toAddrs.length) toAddrs.push(notifyEmail);
    if (!toAddrs.some(e => e.toLowerCase() === notifyEmail.toLowerCase()) && !ccAddrs.some(e => e.toLowerCase() === notifyEmail.toLowerCase())) {
      ccAddrs.push(notifyEmail);
    }
    const sharedAddrs = [...toAddrs, ...ccAddrs].filter((e) => !approverEmails.has(e.toLowerCase()));
    for (const m of approverMail) {
      try {
        await sendMail({
          ...(ctx.fromAddr ? { from: ctx.fromAddr } : {}),
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
      const approveUrl = `${baseUrl}/api/schedule/plans/approve/${ctx.approveToken}`;
      const rejectUrl = `${baseUrl}/api/schedule/plans/reject/${ctx.rejectToken}`;
      await sendMail({
        ...(ctx.fromAddr ? { from: ctx.fromAddr } : {}),
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
}

/** The swap partner agreed: flip the plan to 'pending' and run the
 * approver notifications from the stored row. Returns false when the
 * plan was not waiting for a partner (already decided / raced). */
export async function releasePlanToApprovers(query: QueryFn, planId: string): Promise<boolean> {
  const { rows } = await query('SELECT * FROM schedule_plans WHERE id = $1', [planId]);
  if (!rows.length || rows[0].status !== 'awaiting_partner') return false;
  const row = rows[0];
  const { rows: upd } = await query(
    `UPDATE schedule_plans SET status = 'pending', partner_status = 'approved'
     WHERE id = $1 AND status = 'awaiting_partner' RETURNING id`,
    [planId]
  );
  if (!upd.length) return false;
  const plan = typeof row.plan === 'string' ? JSON.parse(row.plan) : row.plan;
  plan.summary = row.plan_summary;
  const fromLine = row.source_from_name ? `${row.source_from_name} <${row.source_from}>` : (row.source_from || '');
  await notifyPlanApprovers(query, row.company_id, planId, plan, {
    fromLine, cc: row.source_cc, subject: row.source_subject, body: row.source_body,
    changeList: renderChangeList(plan),
    approveToken: row.approve_token, rejectToken: row.reject_token,
  });
  // Tell the requester the partner agreed — it's with the schedulers now.
  try {
    const { rows: urows } = await query(
      `SELECT id FROM users WHERE company_id = $1 AND is_active = true
         AND (lower(email) = lower($2) OR lower(alt_email) = lower($2)) LIMIT 1`,
      [row.company_id, row.source_from || '']);
    if (urows.length) {
      await notify({
        companyId: row.company_id, userIds: [urows[0].id], category: 'schedule', type: 'swap_partner_agreed',
        title: `${row.partner_name || 'Your swap partner'} agreed to the swap`,
        body: 'It is now with the schedulers for final approval.',
        link: 'requests', bundleKey: 'swap_partner_agreed',
      });
    }
  } catch { /* non-fatal */ }
  try {
    const { sendMail } = await import('./mailer.js');
    const reqEmail = (row.source_from || '').trim();
    if (reqEmail && reqEmail.includes('@')) {
      await sendMail({
        to: reqEmail,
        subject: `Swap agreed: ${(row.plan_summary || '').substring(0, 60)}`,
        text: `Hi,\n\n${row.partner_name || 'Your swap partner'} agreed to the swap. Your request is now with the schedulers for final approval — the swap happens only once they approve it.\n\nSummary: ${row.plan_summary}\n\nYou'll get another email with the final decision.\n\n— Quick Scheduling`,
        html: `<p>Hi,</p><p><strong>${escHtml(row.partner_name || 'Your swap partner')}</strong> agreed to the swap. Your request is now with the schedulers for final approval — the swap happens only once they approve it.</p><p><strong>Summary:</strong> ${escHtml(row.plan_summary || '')}</p><p>You'll get another email with the final decision.</p><p>— Quick Scheduling</p>`,
      });
    }
  } catch { /* non-fatal */ }
  return true;
}

/** The swap partner declined: close the plan as rejected and tell the
 * requester. Returns false when the plan was not waiting. */
export async function rejectPlanByPartner(query: QueryFn, planId: string): Promise<boolean> {
  const { rows } = await query('SELECT * FROM schedule_plans WHERE id = $1', [planId]);
  if (!rows.length || rows[0].status !== 'awaiting_partner') return false;
  const row = rows[0];
  const { rows: upd } = await query(
    `UPDATE schedule_plans SET status = 'rejected', partner_status = 'rejected', decided_at = now()
     WHERE id = $1 AND status = 'awaiting_partner' RETURNING id`,
    [planId]
  );
  if (!upd.length) return false;
  try {
    const { rows: urows } = await query(
      `SELECT id FROM users WHERE company_id = $1 AND is_active = true
         AND (lower(email) = lower($2) OR lower(alt_email) = lower($2)) LIMIT 1`,
      [row.company_id, row.source_from || '']);
    if (urows.length) {
      await notify({
        companyId: row.company_id, userIds: [urows[0].id], category: 'schedule', type: 'request_decided',
        title: 'Your swap request was declined',
        body: `${row.partner_name || 'Your swap partner'} can't do this swap, so the request is closed.`,
        link: 'requests', bundleKey: 'request_decided',
      });
    }
  } catch { /* non-fatal */ }
  try {
    const { sendMail } = await import('./mailer.js');
    const reqEmail = (row.source_from || '').trim();
    if (reqEmail && reqEmail.includes('@')) {
      await sendMail({
        to: reqEmail,
        subject: `Swap declined: ${(row.plan_summary || '').substring(0, 60)}`,
        text: `Hi,\n\n${row.partner_name || 'Your swap partner'} can't do this swap, so the request is closed. It did not go to the schedulers.\n\nSummary: ${row.plan_summary}\n\n— Quick Scheduling`,
        html: `<p>Hi,</p><p><strong>${escHtml(row.partner_name || 'Your swap partner')}</strong> can't do this swap, so the request is closed. It did not go to the schedulers.</p><p><strong>Summary:</strong> ${escHtml(row.plan_summary || '')}</p><p>— Quick Scheduling</p>`,
      });
    }
  } catch { /* non-fatal */ }
  return true;
}

/**
 * Create a pending plan from a fully-built change list and send every
 * notification (bell, requester confirmation, per-approver emails,
 * shared plan email). Shared by the email engine (after the AI parses
 * a hand-written email) and the request form (which builds the change
 * list directly from the form's picks — no AI in that loop). The
 * eligibility warn-and-override runs here so both paths behave the
 * same. Returns the new plan id. Throws on insert failure; all mail
 * steps are best-effort.
 *
 * Swap staging (Deepika 2026-11-01): a plan that swaps with ONE
 * partner is born 'awaiting_partner' — only the partner is notified
 * (bell + token email); approvers hear about it only if the partner
 * agrees (releasePlanToApprovers).
 */
export async function createPendingPlanFromChanges(
  query: QueryFn,
  companyId: string,
  plan: any,
  input: {
    sourceId: string;
    subject: string;
    cc: string | null;
    body: string;
    senderAddress: string;
    senderName: string | null;
    fromAddr: string | null;
    fromLine: string;
    outageForwardedAt?: any;
    /** Extra html/text appended to the requester confirmation email. */
    requesterFooter?: { text: string; html: string };
    /** The swap partner, when the caller knows exactly who it is
     * (the request form). Swap staging uses it before name
     * resolution; see resolveSwapPartner. */
    partnerUserId?: string | null;
  }
): Promise<string> {
    // Warn-and-override: flag every change that puts someone on a shift type
    // their job role is not eligible for. The warning rides on the change
    // into the requester email and the summary flag carries it into the
    // approver email + Requests list; approving overrides it.
    const { validatePlanEligibility } = await import('./planExecutor.js');
    const warned = await validatePlanEligibility(companyId, plan.changes || []);
    if (warned > 0) {
      plan.summary = `⚠️ Job-role warning: ${warned} change${warned === 1 ? '' : 's'} ${warned === 1 ? 'assigns' : 'assign'} someone outside the allowed roles — approving overrides the rule. ` + (plan.summary || '');
    }

    // Schedule-conflict flags (Deepika 2026-11-01): a swap that would
    // double-book someone or leave them under 8 hours of rest is
    // flagged in the preview and SKIPPED at execution with the reason
    // reported — approving does not override a physical impossibility.
    const { validatePlanConflicts } = await import('./planExecutor.js');
    const conflicted = await validatePlanConflicts(companyId, plan.changes || []);
    if (conflicted > 0) {
      plan.summary = `⛔ Schedule conflict: ${conflicted} swap${conflicted === 1 ? '' : 's'} can't happen as written (overlap or too little rest) — if approved, the conflicting swap${conflicted === 1 ? '' : 's'} will be skipped and reported with the reason. ` + (plan.summary || '');
    }

    // Swap staging (Deepika 2026-11-01): a plan that swaps with ONE
    // partner is born 'awaiting_partner' — the partner is asked
    // FIRST, and the approvers are notified only if they agree.
    let requesterId: string | null = null;
    try {
      const { rows: rrows } = await query(
        `SELECT id FROM users WHERE company_id = $1 AND is_active = true
           AND (lower(email) = lower($2) OR lower(alt_email) = lower($2)) LIMIT 1`,
        [companyId, input.senderAddress || '']);
      if (rrows.length) requesterId = rrows[0].id;
    } catch { /* staging just falls back to the direct flow */ }
    let partner: { id: string; name: string | null } | null = null;
    try {
      partner = await resolveSwapPartner(query, companyId, plan, requesterId, input.partnerUserId || null);
    } catch { partner = null; }
    const partnerApproveToken = partner ? crypto.randomBytes(32).toString('hex') : null;
    const partnerRejectToken = partner ? crypto.randomBytes(32).toString('hex') : null;

    // Create the plan with secure approve/reject tokens. A staged
    // swap plan starts in 'awaiting_partner', never 'pending', so no
    // approver path (in-app, plan-level link — both gate on
    // status='pending') can touch it before the partner agrees.
    const approveToken = crypto.randomBytes(32).toString('hex');
    const rejectToken = crypto.randomBytes(32).toString('hex');
    const { rows: insertedPlans } = await query(
      `INSERT INTO schedule_plans
       (company_id, source_email_id, source_subject, source_from, source_from_name, source_cc, source_body,
        plan_summary, plan, status, approve_token, reject_token, created_at,
        partner_user_id, partner_name, partner_status, partner_approve_token, partner_reject_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15, $16, $17)
       RETURNING id`,
      [
        companyId,
        input.sourceId,
        input.subject,
        input.senderAddress,
        input.senderName || null,
        input.cc || null,
        input.body,
        plan.summary,
        JSON.stringify(plan),
        partner ? 'awaiting_partner' : 'pending',
        approveToken,
        rejectToken,
        partner ? partner.id : null,
        partner ? partner.name : null,
        partner ? 'pending' : null,
        partnerApproveToken,
        partnerRejectToken,
      ]
    );
    const planId = insertedPlans[0].id;

    // One plain-language rendering of the changes, shared by the
    // requester confirmation, the partner email and the approver
    // email so everyone sees exactly what will happen (Deepika
    // 2026-11-01: the approver email "is not clear — swap with who,
    // when, dates are not there").
    const changeList = renderChangeList(plan);

    // Notify requester that their request was received. A staged swap
    // says plainly where it goes first.
    try {
      const { sendMail: sendConfirm } = await import('./mailer.js');
      const reqEmail = input.senderAddress;
      if (reqEmail && reqEmail.includes('@')) {
        // Include original CC recipients so they follow the request too.
        const ccList = String(input.cc || '').split(',').map((s: string) => s.trim()).filter((s: string) => s.includes('@') && s.toLowerCase() !== reqEmail.toLowerCase());
        const nextStep = partner
          ? `First, ${partner.name || 'your swap partner'} has to agree to the swap. If they agree, it goes to the schedulers for final approval — you'll hear again at each step.`
          : `Your request has been received and is awaiting approval.`;
        await sendConfirm({
          ...(input.fromAddr ? { from: input.fromAddr } : {}),
          to: reqEmail,
          cc: ccList.length ? ccList : undefined,
          subject: `Request received: ${plan.summary.substring(0, 60)}`,
          text: `Hi,\n\n${nextStep}\n\nSummary: ${plan.summary}\n\nRequested changes:\n${changeList}\n\nYou'll get another email once it's approved or rejected. Please don't reply to this email — replies to it aren't read. If anything above is wrong, ask a scheduler to reject this plan, then send a new request (the form is fastest).${input.requesterFooter ? `\n\n${input.requesterFooter.text}` : ''}\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>${escHtml(nextStep)}</p><p><strong>Summary:</strong> ${plan.summary}</p><p><strong>Requested changes:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${changeList}</pre><p>You'll get another email once it's approved or rejected. Please don't reply to this email — replies to it aren't read. If anything above is wrong, ask a scheduler to reject this plan, then send a new request (the form is fastest).</p>${input.requesterFooter ? input.requesterFooter.html : ''}<p>— Quick Scheduling</p>`,
        });
      }
    } catch { /* non-fatal */ }

    if (partner) {
      // Staged: the partner is asked FIRST (bell + a token email —
      // Agree / Decline, no login needed). The approvers hear nothing
      // yet; if the partner agrees, releasePlanToApprovers runs the
      // full approver notifications. (Per-approver approver links:
      // Deepika 2026-10-31, migration 068 — minted inside
      // notifyPlanApprovers.)
      try {
        await notify({
          companyId, userIds: [partner.id], category: 'schedule', type: 'swap_partner_waiting',
          title: `${input.senderName || 'A team member'} wants to swap shifts with you`,
          body: plan.summary,
          link: 'requests', bundleKey: 'swap_partner_waiting',
          bundleTitle: '{count} swap requests are waiting for your agreement',
        });
      } catch { /* non-fatal */ }
      try {
        const { rows: prows } = await query(
          'SELECT email FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [partner.id, companyId]);
        const partnerEmail = prows.length ? String(prows[0].email || '') : '';
        if (partnerEmail && partnerEmail.includes('@')) {
          const { sendMail } = await import('./mailer.js');
          const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
          const agreeUrl = `${baseUrl}/api/schedule/plans/partner-approve/${partnerApproveToken}`;
          const declineUrl = `${baseUrl}/api/schedule/plans/partner-reject/${partnerRejectToken}`;
          await sendMail({
            ...(input.fromAddr ? { from: input.fromAddr } : {}),
            to: partnerEmail,
            subject: `Swap request: ${plan.summary.substring(0, 60)}`,
            text: `${input.fromLine} has asked to swap shifts with you.

What they asked:
${input.body}

Changes to apply:
${changeList}

If you agree, the request then goes to the schedulers for final approval — the swap only happens after they approve it too.

Agree: ${agreeUrl}
Decline: ${declineUrl}

— Quick Scheduling`,
            html: `<p><strong>${escHtml(input.fromLine)}</strong> has asked to swap shifts with you.</p><p><strong>What they asked:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${escHtml(input.body)}</pre><p><strong>Changes to apply:</strong></p><pre style="font-family:sans-serif;white-space:pre-wrap">${escHtml(changeList)}</pre><p>If you agree, the request then goes to the schedulers for final approval — the swap only happens after they approve it too.</p><p><a href="${agreeUrl}" style="background:#22c55e;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;margin-right:10px;">Agree to the swap</a><a href="${declineUrl}" style="background:#ef4444;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Decline</a></p><p>— Quick Scheduling</p>`,
          });
          console.log(`[email-poll] Swap partner asked first: ${partnerEmail}`);
        }
      } catch (mailErr: any) {
        console.log(`[email-poll] Swap partner notification failed: ${mailErr.message}`);
      }
    } else {
      // No single swap partner: the plan goes straight to the
      // approvers, as before.
      await notifyPlanApprovers(query, companyId, planId, plan, {
        fromLine: input.fromLine, cc: input.cc, subject: input.subject, body: input.body,
        fromAddr: input.fromAddr, outageForwardedAt: input.outageForwardedAt,
        changeList, approveToken, rejectToken,
      });
    }

  return planId;
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

/** The IMAP operations pollInbox needs — injectable so tests can drive
 * the poll loop without a live Gmail connection. Production callers
 * omit it and get the real Gmail functions. */
export interface PollImapDeps {
  listUnreadUids: (maxResults: number, creds?: ImapCreds) => Promise<number[]>;
  getImapMessage: (uid: number, creds?: ImapCreds) => Promise<ImapMessage>;
  markImapAsRead: (uid: number, creds?: ImapCreds) => Promise<void>;
}

const realImapDeps: PollImapDeps = { listUnreadUids, getImapMessage, markImapAsRead };

/** "October 31, 2026" — the date quoted in forward/plan-note lines. */
export function formatOutageForwardDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Recipients for a forwarded schedule email (forward add-on,
 * 2026-10-31): the same resolution the plan-approval notification
 * emails use, on its company-wide branch. The plan path's recipient
 * set is the plan approvers (planApproverIds — owners, plus
 * schedulers when the company notifies them) with their own emails,
 * plus the per-department notification settings — which apply only
 * when a plan's changes name departments. A poll-time failure has no
 * plan and no department (the poller routes per company; the webhook
 * is the path that knows departments, and it never forwards), so the
 * resolution here is: approver addresses + the NOTIFICATION_EMAIL
 * fallback the plan path always ends up copying — minus the
 * scheduling inbox's own address, so a forward can never land back
 * in the mailbox the poller reads (no re-ingestion loop).
 */
async function forwardRecipients(query: QueryFn, companyId: string, mailbox: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (e?: string | null) => {
    const a = String(e || '').trim().toLowerCase();
    if (a && a.includes('@') && !seen.has(a)) { seen.add(a); out.push(a); }
  };
  const approverIds = await planApproverIds(companyId);
  if (approverIds.length) {
    const { rows } = await query(
      'SELECT email FROM users WHERE id = ANY($1) AND company_id = $2 AND is_active = true AND email IS NOT NULL',
      [approverIds, companyId]
    );
    rows.forEach((r: any) => push(r.email));
  }
  // Same fallback the plan notification uses when no per-department
  // recipients resolve (and it is copied on every plan email).
  push(process.env.NOTIFICATION_EMAIL || 'adityarander1@gmail.com');
  const self = normalizeMailbox(mailbox);
  return out.filter((a) => a !== self);
}

/**
 * Send ONE forward of a PARKED (unprocessable) email to the approvers —
 * Deepika's rule (2026-10-31): a request the AI cannot process must
 * reach a human who can act on it, with the original email attached
 * in full. This is the park path only: the email is the customer
 * company's own content and only their admins can act on it. An AI
 * credit OUTAGE never forwards (outage-handling correction,
 * 2026-10-31) — that failure is the platform's, and waiting mail is
 * simply left waiting while the platform is alerted separately.
 * Returns true when the mail was sent. Throws never: a failed send is
 * only logged by the caller — the park itself stands either way.
 */
async function sendScheduleForward(args: {
  query: QueryFn;
  companyId: string;
  mailbox: string;
  email: ImapMessage;
  reason: string;
}): Promise<boolean> {
  const { query, companyId, mailbox, email, reason } = args;
  let recipients: string[];
  try {
    recipients = await forwardRecipients(query, companyId, mailbox);
  } catch (e: any) {
    console.log(`[email-poll] Park-forward for "${email.subject}": could not resolve recipients: ${e.message}`);
    return false;
  }
  if (!recipients.length) {
    // Nobody to send to (e.g. the only approver address IS the
    // scheduling inbox, which is excluded). The bell note / poll
    // error from the park path still stand.
    console.log(`[email-poll] Park-forward for "${email.subject}": no approver recipients — forward skipped.`);
    return false;
  }
  const sender = parseSender(email.from, email.fromName);
  const fromLine = sender.name ? `${sender.name} <${sender.address}>` : (sender.address || email.from);
  const subject = (email.subject || '').trim() || '(no subject)';
  const header = `The AI couldn't process this email after ${MAX_EMAIL_ATTEMPTS} tries, so it has been set aside. Please handle the request below directly.\nReason: ${String(reason || 'Processing failed.').slice(0, 300)}`;
  const text =
    `${header}\n\n----- Original email -----\nFrom: ${fromLine}\nSubject: ${subject}\n\n${email.body || ''}`;
  const html =
    `<p>${escHtml(header)}</p><hr><p><strong>From:</strong> ${escHtml(fromLine)}<br><strong>Subject:</strong> ${escHtml(subject)}</p><pre style="font-family:sans-serif;white-space:pre-wrap;">${escHtml(email.body || '')}</pre>`;
  try {
    await sendMail({
      to: recipients[0],
      cc: recipients.length > 1 ? recipients.slice(1) : undefined,
      subject: `[Couldn't process] ${subject}`,
      text,
      html,
    });
    console.log(`[email-poll] Forwarded (parked) "${subject}" to ${recipients.join(', ')}`);
    return true;
  } catch (e: any) {
    console.log(`[email-poll] Park-forward for "${subject}" failed to send: ${e.message}`);
    return false;
  }
}

/**
 * Bookkeeping for one failed processing attempt (retry cap, 2026-10-31).
 *
 * Failure classes (forward add-on, 2026-10-31):
 *  - COUNTED (this function): the fetched message was handed to the
 *    engine and the engine threw a non-billing error. Below the cap
 *    the message simply stays unread and is retried on the next poll,
 *    exactly as before. At the cap the message is PARKED: marked read
 *    so it leaves the retry set, reported once in the poll outcome,
 *    the company owner gets a one-line bell notification, and the
 *    original email is FORWARDED to the approvers (sendScheduleForward
 *    kind 'parked') so a human can act on the request.
 *  - BILLING failures never reach here either: they are not counted,
 *    not parked, and not forwarded (see the pollInbox branch) — the
 *    message waits for the platform's service to return.
 *  - FETCH failures never reach here at all (see pollInbox).
 * Best-effort throughout — bookkeeping must never break the poll.
 */
async function notePollFailure(
  query: QueryFn,
  companyId: string,
  mailbox: string,
  uid: number,
  error: string,
  result: { errors: string[] },
  deps: PollImapDeps,
  email: ImapMessage,
  creds?: ImapCreds
): Promise<void> {
  let rec: EmailAttemptRecord;
  try {
    rec = await recordEmailFailure(query, companyId, mailbox, String(uid), error);
  } catch (e: any) {
    console.log(`[email-poll] Message ${uid}: could not record the failed attempt: ${e.message}`);
    return;
  }
  if (!rec.parked) {
    console.log(`[email-poll] Message ${uid}: failed attempt ${rec.count}/${MAX_EMAIL_ATTEMPTS} — will retry on the next poll.`);
    return;
  }
  console.log(`[email-poll] ${parkedEmailReport(String(uid), rec)}`);
  try { await deps.markImapAsRead(uid, creds); } catch (e: any) {
    // Still parked in the store: the poll loop will skip it even if it
    // shows up unread again, so the retry loop stays dead either way.
    console.log(`[email-poll] Message ${uid}: could not mark the parked message read: ${e.message}`);
  }
  result.errors.push(parkedEmailReport(String(uid), rec));
  try {
    const owners = await companyOwnerIds(companyId);
    if (owners.length) {
      await notify({
        companyId, userIds: owners, category: 'approvals', type: 'email_parked',
        title: 'An emailed schedule request could not be processed',
        body: `One emailed request was tried ${rec.count} times and has been set aside (message ${uid}). Last error: ${rec.lastError}`.slice(0, 500),
      });
    }
  } catch { /* notification is best-effort */ }
  // Park-forward: the parked flag is already persisted, so this send
  // lives inside the one-shot park path — a failed send is only
  // logged (bell note + poll error above still stand) and later polls
  // skip the parked message without ever forwarding again.
  await sendScheduleForward({ query, companyId, mailbox, email, reason: rec.lastError });
}

/**
 * Poll the Gmail inbox for new schedule change emails.
 * Creates pending plans for Deepika to approve. Never modifies the schedule directly.
 */
/**
 * In-flight polls, one flag per company (Deepika, 2026-11-11 —
 * the one-email fix): runPoll ticks every 5 minutes and the
 * manual /poll-inbox route shares this same entry point, so two
 * polls for one inbox can overlap. A second poll for a company
 * already being polled reports "already running" instead of
 * re-reading the same unread messages. The processed-message
 * record below is the primary dedupe; this guard is the second
 * layer. Cleared in a finally — a crashed poll never wedges the
 * inbox.
 */
const pollInFlight = new Set<string>();

export async function pollInbox(query: QueryFn, companyId: string, creds?: ImapCreds, deps: PollImapDeps = realImapDeps): Promise<{
  checked: number;
  newPlans: number;
  questionsAnswered: number;
  errors: string[];
}> {
  const result = { checked: 0, newPlans: 0, questionsAnswered: 0, errors: [] as string[] };
  if (pollInFlight.has(companyId)) {
    result.errors.push('A poll for this inbox is already running — try again in a moment.');
    return result;
  }
  pollInFlight.add(companyId);
  try {
  return await pollInboxInner(query, companyId, creds, deps, result);
  } finally {
    pollInFlight.delete(companyId);
  }
}

async function pollInboxInner(query: QueryFn, companyId: string, creds: ImapCreds | undefined, deps: PollImapDeps, result: {
  checked: number;
  newPlans: number;
  questionsAnswered: number;
  errors: string[];
}): Promise<{
  checked: number;
  newPlans: number;
  questionsAnswered: number;
  errors: string[];
}> {

  // Check if Gmail IMAP is configured (per-company creds, or the legacy env inbox)
  if (!creds && (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD)) {
    result.errors.push('Gmail not configured on server');
    await recordEmailPoll(query, companyId);
    return result;
  }

  // Attempt records are scoped per mailbox: this company's own inbox
  // when it has one, else the legacy shared inbox identity.
  const mailbox = (creds?.user || process.env.GMAIL_USER || 'unknown').toLowerCase();

  try {
    const uids = await deps.listUnreadUids(10, creds);
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

      // Idempotency (Deepika, 2026-11-11 — the one-email fix): a
      // clarification_sent or skipped outcome writes no plan row,
      // so the plan-row check above cannot see it — a second tick
      // or a manual re-poll would re-process the message and send
      // a second email. The processed record closes that hole. A
      // clarification REPLY is a different message id and is
      // unaffected.
      if (await hasProcessedMessage(query, companyId, uidStr)) continue;

      // Retry cap: a parked message is NEVER processed again, even if
      // it shows up unread once more (the park-time mark-read failed,
      // or someone re-marked it). Try to mark it read again and move
      // on — no AI call, no second report.
      let attempt: EmailAttemptRecord | null = null;
      try { attempt = await getEmailAttempt(query, companyId, mailbox, uidStr); } catch { /* store unreadable — process as before */ }
      if (isParked(attempt)) {
        try { await deps.markImapAsRead(uid, creds); } catch { /* best-effort */ }
        continue;
      }

      // Fetch first, in its own try: a message that cannot be FETCHED
      // (IMAP hiccup, auth timeout) was never handed to the engine,
      // so the failure is not the email's fault — it is NOT counted
      // toward the retry cap and never forwards (forward add-on,
      // 2026-10-31). It stays unread and retries on the next poll,
      // exactly the pre-package behavior; the error line is unchanged.
      let email: ImapMessage;
      try {
        email = await deps.getImapMessage(uid, creds);
      } catch (err: any) {
        result.errors.push(`Message ${uid}: ${err.message}`);
        console.log(`[email-poll] Message ${uid}: fetch failed (not counted toward the retry cap): ${err.message}`);
        continue;
      }

      const errorsBefore = result.errors.length;
      let failure: string | null = null;
      try {
        const outcome = await processScheduleEmail(query, companyId, email, uidStr, result, {
          markRead: () => deps.markImapAsRead(uid, creds),
          // Read from the attempt snapshot taken above — BEFORE the
          // success below clears the record — so a plan built after
          // an outage forward carries the "already forwarded" note.
          outageForwardedAt: attempt?.outageForwarded ? attempt.outageForwardedAt : null,
        });
        applyOutcomeToCounts(result, outcome);
        if (outcome === undefined) {
          // The engine caught a failure (already logged into
          // result.errors by the engine) and left the message unread.
          failure = result.errors.slice(errorsBefore).join('; ')
            .replace(new RegExp(`^Message ${uidStr}: `), '') || 'Processing failed.';
        }
      } catch (err: any) {
        failure = err.message;
        result.errors.push(`Message ${uid}: ${err.message}`);
      }

      if (failure === null) {
        // Processed — any earlier failure count for this message clears.
        if (attempt) {
          try { await clearEmailAttempt(query, companyId, mailbox, uidStr); } catch { /* best-effort */ }
        }
      } else if (isBillingError(failure)) {
        // AI credit outage — Deepika's ruling (outage-handling
        // correction, 2026-10-31): the outage is the PLATFORM's
        // failure (the AI is platform-paid; the customer company
        // does not pay for Gemini), so the company must never get
        // our backlog as homework. The attempt is NOT counted, the
        // message is NOT parked, and NOTHING is forwarded or
        // notified to the company: the message stays unread and
        // processes automatically once credits return. The platform
        // itself is alerted once per outage episode from the Gemini
        // call layer (util/platformAlert.ts) — the engine's failed
        // call above already fed that tracker.
        console.log(`[email-poll] Message ${uid}: AI credit outage — not counted, not parked, not forwarded; the message waits for the service to return.`);
      } else {
        await notePollFailure(query, companyId, mailbox, uid, failure, result, deps, email, creds);
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
