// util/askEngine.ts — rule-based natural language Q&A over the schedule.
// Handles: who's on/working [when] [shift], staffing gaps, person schedules,
// shift counts. All data comes from live schedule tables.

import { query } from '../db.js';

interface ShiftType { id: string; name: string; }
interface Member { id: string; name: string; firstName: string; lastName: string; nickname: string | null; }

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function fmtDate(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function prettyDate(ds: string): string {
  const dt = new Date(ds + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getDay()]} ${months[dt.getMonth()]} ${dt.getDate()}`;
}

/** Parse a date reference from the question. Returns YYYY-MM-DD or null. */
function parseDate(q: string, today: Date): string | null {
  const lower = q.toLowerCase();
  // today / tomorrow / yesterday
  if (/\btoday\b/.test(lower)) return fmtDate(today);
  if (/\btomorrow\b/.test(lower)) { const d = new Date(today); d.setDate(d.getDate() + 1); return fmtDate(d); }
  if (/\byesterday\b/.test(lower)) { const d = new Date(today); d.setDate(d.getDate() - 1); return fmtDate(d); }
  // "next Monday" / "this Friday" / bare "Friday"
  const dayMatch = lower.match(/\b(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dayMatch) {
    const target = DAY_NAMES.indexOf(dayMatch[2]);
    const d = new Date(today);
    let diff = (target - d.getDay() + 7) % 7;
    if (dayMatch[1] === 'next') diff = diff === 0 ? 7 : diff + 7;
    else if (diff === 0) diff = 0; // today if it's that day
    d.setDate(d.getDate() + diff);
    return fmtDate(d);
  }
  // "Oct 15" / "October 15"
  const mdMatch = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})\b/);
  if (mdMatch) {
    const m = MONTHS[mdMatch[1]];
    const day = parseInt(mdMatch[2], 10);
    let year = today.getFullYear();
    const d = new Date(year, m, day);
    if (d < today && (today.getTime() - d.getTime()) > 30 * 24 * 3600 * 1000) year += 1; // likely next year
    return fmtDate(new Date(year, m, day));
  }
  // "2026-10-15"
  const isoMatch = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  return null;
}

/** Parse a week range: "this week" / "next week". Returns {from, to} or null. */
function parseWeek(q: string, today: Date): { from: string; to: string } | null {
  const lower = q.toLowerCase();
  const isNext = /\bnext week\b/.test(lower);
  const isThis = /\bthis week\b/.test(lower);
  if (!isNext && !isThis) return null;
  const d = new Date(today);
  // Week starts Monday.
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow + (isNext ? 7 : 0));
  const from = fmtDate(d);
  d.setDate(d.getDate() + 6);
  return { from, to: fmtDate(d) };
}

export interface AskContext {
  companyId: string;
  shiftTypes: ShiftType[];
  members: Member[];
  userId: string;
  role: string;
  /** Departments whose calendar sessions the asker may see; null = all (owner). */
  visibleDeptIds: string[] | null;
}

/** Find shift types matching words in the question. */
function matchShiftTypes(q: string, shiftTypes: ShiftType[]): ShiftType[] {
  const lower = q.toLowerCase();
  const matched: ShiftType[] = [];
  // Direct name match.
  for (const st of shiftTypes) {
    if (lower.includes(st.name.toLowerCase())) { matched.push(st); continue; }
    // Keyword heuristics.
    const n = st.name.toLowerCase();
    if (/\bnight\b/.test(lower) && n.includes('night')) matched.push(st);
    else if (/\bday\b/.test(lower) && !/\btoday\b/.test(lower) && n.includes('day') && !n.includes('night')) matched.push(st);
    else if (/\bswing\b/.test(lower) && n.includes('swing')) matched.push(st);
    else if (/\bevening\b/.test(lower) && (n.includes('swing') || n.includes('evening'))) matched.push(st);
  }
  return [...new Map(matched.map(s => [s.id, s])).values()];
}

/** Find a team member by name in the question (fuzzy). */
function matchMember(q: string, members: Member[]): Member | null {
  const lower = q.toLowerCase();
  // Try full name, nickname, first name, last name.
  for (const m of members) {
    const names = [
      m.nickname?.toLowerCase(),
      `${m.firstName} ${m.lastName}`.toLowerCase().trim(),
      m.firstName.toLowerCase(),
      m.lastName.toLowerCase(),
    ].filter(Boolean) as string[];
    for (const n of names) {
      if (n.length >= 3 && lower.includes(n)) return m;
    }
  }
  return null;
}

function memberDisplay(m: { firstName: string; lastName: string; nickname: string | null }): string {
  return m.nickname || `${m.firstName} ${m.lastName || ''}`.trim();
}

function fmtTime(t: string | null | undefined): string {
  if (!t) return '';
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(t);
  let h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

function ovDateStr(d: any): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

interface CalSession {
  date: string;
  title: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  presenterId: string | null;
  presenter: string | null;
  supervisor: string | null;
  dashboard: string | null;
  kind: string;
}

/** Load calendar sessions (dashboard sessions/events) in a window, expanding
 *  recurring series and applying per-date overrides — the same visibility
 *  rules as the Calendars tab: owner sees all dashboards, scheduler sees
 *  view-access departments, employees see only their own department. */
async function loadCalendarSessions(ctx: AskContext, from: string, to: string): Promise<CalSession[]> {
  const clauses = ['s.company_id = $1'];
  const params: any[] = [ctx.companyId];
  if (ctx.visibleDeptIds !== null) {
    params.push(ctx.visibleDeptIds);
    clauses.push(`s.department_id = ANY($${params.length})`);
  }
  params.push(from, to);
  clauses.push(`s.session_date <= $${params.length}`);
  clauses.push(`(s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $${params.length - 1})`);
  const { rows } = await query(
    `SELECT s.*, d.name AS dashboard_name,
            u.first_name, u.last_name,
            sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
     FROM academic_sessions s
     LEFT JOIN dashboards d ON d.id = s.dashboard_id
     LEFT JOIN users u ON u.id = s.lecturer_user_id
     LEFT JOIN users sup ON sup.id = s.supervisor_user_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY s.session_date, s.start_time NULLS LAST, s.title`,
    params);
  const ids = rows.map((r: any) => r.id);
  const ovMap = new Map<string, any>();
  if (ids.length) {
    const { rows: ovs } = await query(
      `SELECT * FROM academic_session_overrides
       WHERE company_id = $1 AND session_id = ANY($2) AND date >= $3 AND date <= $4`,
      [ctx.companyId, ids, from, to]);
    for (const ov of ovs) ovMap.set(ov.session_id + '|' + ovDateStr(ov.date), ov);
  }
  const { rows: us } = await query(
    'SELECT id, first_name, last_name FROM users WHERE company_id = $1', [ctx.companyId]);
  const userName = new Map<string, string>();
  for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));

  const out: CalSession[] = [];
  for (const r of rows) {
    const base = {
      title: r.title,
      lecturerUserId: r.lecturer_user_id || null,
      lecturerName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
      supervisorName: [r.sup_first_name, r.sup_last_name].filter(Boolean).join(' ') || null,
      date: ovDateStr(r.session_date),
      startTime: r.start_time || null,
      endTime: r.end_time || null,
      location: r.location || null,
      kind: r.kind || 'session',
      dashboard: r.dashboard_name || null,
      recurRule: r.recur_rule === 'biweekly' ? 'weekly' : (r.recur_rule || 'none'),
      recurInterval: r.recur_rule === 'biweekly' ? 2 : (r.recur_interval || 1),
      recurCount: r.recur_count || null,
      recurDays: r.recur_days ? String(r.recur_days).split(',').map((x: string) => parseInt(x, 10)).filter((n: number) => !isNaN(n)) : [],
      recurUntil: r.recur_until ? ovDateStr(r.recur_until) : null,
    };
    const pushOcc = (ds: string): CalSession | null => {
      if (ds < from || ds > to) return null;
      const ov = ovMap.get(r.id + '|' + ds);
      if (ov && ov.cancelled) return null;
      let presenterId = base.lecturerUserId;
      let presenter = base.lecturerName;
      let supervisor = base.supervisorName;
      let location = base.location;
      let startTime = base.startTime;
      let endTime = base.endTime;
      if (ov) {
        if (ov.has_lecturer) { presenterId = ov.lecturer_user_id || null; presenter = presenterId ? (userName.get(presenterId) || null) : null; }
        if (ov.has_supervisor) { supervisor = ov.supervisor_user_id ? (userName.get(ov.supervisor_user_id) || null) : null; }
        if (ov.has_location) location = ov.location || null;
        if (ov.has_times) { startTime = ov.start_time || null; endTime = ov.end_time || null; }
      }
      return { date: ds, title: base.title, startTime, endTime, location, presenterId, presenter, supervisor, dashboard: base.dashboard, kind: base.kind };
    };
    if (!base.recurRule || base.recurRule === 'none') {
      const occ = pushOcc(base.date);
      if (occ) out.push(occ);
      continue;
    }
    const end = base.recurUntil && base.recurUntil < to ? base.recurUntil : to;
    const startD = new Date(base.date + 'T00:00:00Z');
    const endD = new Date(end + 'T00:00:00Z');
    const interval = Math.max(1, base.recurInterval || 1);
    const maxCount = base.recurCount && base.recurCount > 0 ? base.recurCount : Infinity;
    let occCount = 0;
    const tryDate = (d: Date): boolean => {
      if (occCount >= maxCount) return false;
      occCount++;
      const occ = pushOcc(d.toISOString().slice(0, 10));
      if (occ) out.push(occ);
      return occCount < maxCount;
    };
    if (base.recurRule === 'daily') {
      const cur = new Date(startD);
      while (cur <= endD) { if (!tryDate(cur)) break; cur.setUTCDate(cur.getUTCDate() + interval); }
    } else if (base.recurRule === 'weekly') {
      const days: number[] = base.recurDays.length ? base.recurDays : [startD.getUTCDay()];
      const week0 = new Date(startD);
      week0.setUTCDate(week0.getUTCDate() - week0.getUTCDay());
      const cur = new Date(startD);
      let go = true;
      while (cur <= endD && go) {
        const weekIdx = Math.floor((cur.getTime() - week0.getTime()) / (7 * 86400000));
        if (days.includes(cur.getUTCDay()) && weekIdx % interval === 0) go = tryDate(cur);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    } else if (base.recurRule === 'monthly-weekday') {
      const wd = startD.getUTCDay();
      const nth = Math.floor((startD.getUTCDate() - 1) / 7) + 1;
      const dimStart = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth() + 1, 0)).getUTCDate();
      const isLast = startD.getUTCDate() + 7 > dimStart;
      let y = startD.getUTCFullYear(), mo = startD.getUTCMonth();
      let go = true;
      while (Date.UTC(y, mo, 1) <= endD.getTime() && go) {
        const dim = new Date(Date.UTC(y, mo, 1, 0)).getUTCDate();
        let day = 0;
        if (isLast) {
          const lastD = new Date(Date.UTC(y, mo, dim));
          day = dim - ((lastD.getUTCDay() - wd + 7) % 7);
        } else {
          const firstD = new Date(Date.UTC(y, mo, 1));
          const firstOcc = 1 + ((wd - firstD.getUTCDay() + 7) % 7);
          const cand = firstOcc + (nth - 1) * 7;
          if (cand <= dim) day = cand;
        }
        if (day) {
          const d = new Date(Date.UTC(y, mo, day));
          if (d >= startD && d <= endD) go = tryDate(d);
        }
        mo += interval; while (mo > 11) { mo -= 12; y++; }
      }
    } else if (base.recurRule === 'yearly') {
      const cur = new Date(startD);
      const baseDayY = cur.getUTCDate();
      const baseMonth = cur.getUTCMonth();
      while (cur <= endD) {
        if (!tryDate(cur)) break;
        const ny = cur.getUTCFullYear() + interval;
        const dimY = new Date(Date.UTC(ny, baseMonth + 1, 0)).getUTCDate();
        cur.setUTCFullYear(ny);
        cur.setUTCMonth(baseMonth);
        cur.setUTCDate(Math.min(baseDayY, dimY));
      }
    } else {
      const cur = new Date(startD);
      const baseDay = cur.getUTCDate();
      while (cur <= endD) {
        if (!tryDate(cur)) break;
        cur.setUTCDate(1);
        cur.setUTCMonth(cur.getUTCMonth() + interval);
        const lastDay2 = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
        cur.setUTCDate(Math.min(baseDay, lastDay2));
      }
    }
  }
  out.sort((a, b) => a.date !== b.date ? (a.date < b.date ? -1 : 1) : (a.startTime || '99') < (b.startTime || '99') ? -1 : 1);
  return out;
}

function formatCalSession(s: CalSession): string {
  const time = s.startTime ? fmtTime(s.startTime) + (s.endTime ? '–' + fmtTime(s.endTime) : '') : '';
  const who = s.presenter || 'Needs presenter';
  const where = s.location ? `, ${s.location}` : '';
  const dash = s.dashboard ? ` (${s.dashboard})` : '';
  return `${s.title}${time ? ' — ' + time : ''}, ${who}${where}${dash}`;
}

function formatCalendarBlock(sessions: CalSession[]): string {
  const byDate = new Map<string, CalSession[]>();
  for (const s of sessions) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date)!.push(s);
  }
  const parts: string[] = [];
  for (const ds of [...byDate.keys()].sort()) {
    parts.push(`${prettyDate(ds)}:\n${byDate.get(ds)!.map(s => '• ' + formatCalSession(s)).join('\n')}`);
  }
  return parts.join('\n');
}

async function loadAskerProfile(ctx: AskContext): Promise<any | null> {
  const { rows } = await query(
    `SELECT u.first_name AS "firstName", u.last_name AS "lastName", u.nickname, u.phone, u.email,
            u.role, d.name AS "deptName", jr.name AS "jobRoleName"
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN job_roles jr ON jr.id = u.job_role_id
     WHERE u.id = $1 AND u.company_id = $2`,
    [ctx.userId, ctx.companyId]);
  return rows[0] || null;
}

export async function answerQuestion(question: string, ctx: AskContext): Promise<string> {
  const q = question.trim();
  if (!q) return 'Ask me something like "who\'s on Friday night?"';
  const lower = q.toLowerCase();
  const today = new Date();

  // Load needed data lazily per intent.
  const isShort = /\bshort\b|understaffed|gaps?\b/.test(lower);
  const isCount = /\bhow many\b/.test(lower);
  const member = matchMember(q, ctx.members);
  const shiftTypes = matchShiftTypes(q, ctx.shiftTypes);
  const date = parseDate(q, today);
  const week = parseWeek(q, today);

  // --- "Are we short / where are we short" ---
  if (isShort) {
    const from = date || week?.from || fmtDate(today);
    const to = date || week?.to || fmtDate(today);
    // Get staffing targets.
    const { rows: targets } = await query(
      `SELECT st.name, t.target_count FROM staffing_targets t
       JOIN shift_types st ON st.id = t.shift_type_id
       WHERE t.company_id = $1`,
      [ctx.companyId]
    );
    if (!targets.length) {
      return 'No staffing targets are set up yet. Set them in Settings so I can check for gaps.';
    }
    const { rows: shifts } = await query(
      `SELECT s.date::text AS date, st.name AS "shiftTypeName", COUNT(*) AS count
       FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3
       GROUP BY s.date, st.name`,
      [ctx.companyId, from, to]
    );
    const byDateShift = new Map<string, number>();
    for (const s of shifts) byDateShift.set(s.date + '|' + s.shiftTypeName, Number(s.count));
    const gaps: string[] = [];
    const d = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    while (d <= end) {
      const ds = fmtDate(d);
      for (const t of targets) {
        const have = byDateShift.get(ds + '|' + t.name) || 0;
        if (have < t.target_count) {
          gaps.push(`${prettyDate(ds)}: ${t.name} — ${have}/${t.target_count}`);
        }
      }
      d.setDate(d.getDate() + 1);
    }
    if (!gaps.length) return `You're fully staffed ${date ? 'on ' + prettyDate(date) : 'for that period'}.`;
    return `Short spots:\n${gaps.join('\n')}`;
  }

  // --- "My" profile / settings — the asker's own account only. Personal
  // info (phone, email) is answered for the asker themselves, never for
  // another member, and never across companies (companyId is session-scoped).
  const isMyName = /\bwho am i\b|\bmy name\b/.test(lower);
  const isMyContact = /\bmy (phone|email)\b/.test(lower);
  const isMyRole = /\bmy (role|department|job)\b/.test(lower);
  const isMySettings = /\bmy settings\b|\bmy profile\b|\bmy account\b/.test(lower);
  const isCompanySettings = /\bcompany settings\b|\bgeneral settings\b/.test(lower);
  const isTimezoneQ = /\btime ?zone\b/.test(lower);
  if (isMyName || isMyContact || isMyRole || isMySettings || isCompanySettings || isTimezoneQ) {
    const me = await loadAskerProfile(ctx);
    if (!me) return 'I could not find your profile in this account.';
    const myName = me.nickname || `${me.firstName} ${me.lastName || ''}`.trim();
    const { rows: coRows } = await query('SELECT name FROM companies WHERE id = $1', [ctx.companyId]);
    const companyName = coRows[0]?.name || 'this company';
    if (isMyName) return `You're ${myName}, ${me.role} in ${me.deptName || 'no department'} at ${companyName}.`;
    if (isMyContact) {
      if (/\bphone\b/.test(lower)) return me.phone ? `Your phone is ${me.phone}.` : 'No phone number is saved on your profile.';
      return `Your email is ${me.email}.`;
    }
    if (isMyRole) return `You're ${me.role}${me.jobRoleName ? ` (${me.jobRoleName})` : ''} in ${me.deptName || 'no department'}.`;
    if (isTimezoneQ && !isMySettings && !isCompanySettings) {
      const { rows: tzRows } = await query(`SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`, [ctx.companyId]);
      return `The company timezone is ${tzRows[0]?.value || 'America/Chicago'}.`;
    }
    // Settings summary: the full picture, not one field.
    const lines = [`Your settings at ${companyName}:`, `• Name: ${myName}`, `• Role: ${me.role}${me.jobRoleName ? ` (${me.jobRoleName})` : ''}`, `• Department: ${me.deptName || 'none'}`];
    const { rows: prefRows } = await query(`SELECT key, value FROM user_settings WHERE user_id = $1`, [ctx.userId]);
    const prefs: Record<string, string> = {};
    for (const r of prefRows) prefs[r.key] = r.value;
    const prefBits: string[] = [];
    if (prefs.theme && prefs.theme !== 'system') prefBits.push(`theme ${prefs.theme}`);
    if (prefs.header_color) prefBits.push(`header colour ${prefs.header_color}`);
    if (prefs.footer_color) prefBits.push(`footer colour ${prefs.footer_color}`);
    lines.push(`• My preferences: ${prefBits.length ? prefBits.join(', ') : 'defaults'}`);
    if (ctx.role === 'owner' || ctx.role === 'scheduler') {
      const { rows: setRows } = await query(`SELECT key, value FROM company_settings WHERE company_id = $1`, [ctx.companyId]);
      const settings: Record<string, string> = { company_display_name: '', timezone: 'America/Chicago', week_start: 'monday', date_format: 'mdy', time_format: '12h', default_view: 'week' };
      for (const r of setRows) settings[r.key] = r.value;
      lines.push(`• Company display name: ${settings.company_display_name || companyName}`);
      lines.push(`• Timezone: ${settings.timezone}`);
      lines.push(`• Week starts: ${settings.week_start}`);
      lines.push(`• Date format: ${settings.date_format}, time format: ${settings.time_format}, default view: ${settings.default_view}`);
    } else if (isCompanySettings) {
      lines.push('• Company-wide settings are managed by the owner/scheduler.');
    }
    return lines.join('\n');
  }

  // --- Account lists: departments, shift types, calendars (dashboards). ---
  // Guarded so "what department is John in" still reaches the member branch.
  const calWords = /\b(sessions?|events?|calendars?|dashboards?|lectures?|classes?)\b/.test(lower);
  const presentingWords = /\bpresent(ing|er|ers)?\b/.test(lower);
  if ((/\bwhat\b|\blist\b|\bshow\b/.test(lower)) && !member) {
    if (/\bdepartments?\b/.test(lower)) {
      const clauses = ['company_id = $1']; const params: any[] = [ctx.companyId];
      if (ctx.visibleDeptIds !== null) { params.push(ctx.visibleDeptIds); clauses.push(`id = ANY($${params.length})`); }
      const { rows } = await query(`SELECT name FROM departments WHERE ${clauses.join(' AND ')} ORDER BY name`, params);
      if (!rows.length) return 'No departments are set up in this account yet.';
      return `Departments in this account:\n${rows.map((r: any) => '• ' + r.name).join('\n')}`;
    }
    if (/\bshift types?\b/.test(lower)) {
      const clauses = ['company_id = $1', 'is_active = true']; const params: any[] = [ctx.companyId];
      if (ctx.visibleDeptIds !== null) { params.push(ctx.visibleDeptIds); clauses.push(`(department_id IS NULL OR department_id = ANY($${params.length}))`); }
      const { rows } = await query(`SELECT name FROM shift_types WHERE ${clauses.join(' AND ')} ORDER BY sort_order, name`, params);
      if (!rows.length) return 'No shift types are set up in this account yet.';
      return `Shift types in this account:\n${rows.map((r: any) => '• ' + r.name).join('\n')}`;
    }
    if ((/\bcalendars?\b|\bdashboards?\b/.test(lower)) && !/\b(sessions?|events?|present(ing|er|ers)?)\b/.test(lower)) {
      const clauses = ['d.company_id = $1']; const params: any[] = [ctx.companyId];
      if (ctx.visibleDeptIds !== null) {
        params.push(ctx.visibleDeptIds);
        clauses.push(`(NOT EXISTS (SELECT 1 FROM dashboard_departments dd WHERE dd.dashboard_id = d.id) OR EXISTS (SELECT 1 FROM dashboard_departments dd WHERE dd.dashboard_id = d.id AND dd.department_id = ANY($${params.length})))`);
      }
      const { rows } = await query(`SELECT d.name FROM dashboards d WHERE ${clauses.join(' AND ')} ORDER BY d.name`, params);
      if (!rows.length) return 'No calendars are set up in this account yet.';
      return `Calendars in this account:\n${rows.map((r: any) => '• ' + r.name).join('\n')}`;
    }
  }

  // --- Calendar sessions / events across ALL calendars in this account. ---
  const needsPresenter = /\bneeds? (a )?presenter\b|\bno presenter\b|\bunassigned\b/.test(lower);
  const mySessions = /\bmy\b/.test(lower) && (calWords || presentingWords);
  if (calWords || presentingWords || needsPresenter || mySessions) {
    const from = date || week?.from || fmtDate(today);
    let to = date || week?.to || '';
    if (!to) { const d = new Date(today); d.setDate(d.getDate() + (needsPresenter ? 30 : 7)); to = fmtDate(d); }
    let sessions = await loadCalendarSessions(ctx, from, to);
    if (needsPresenter) sessions = sessions.filter(s => !s.presenterId);
    if (mySessions) sessions = sessions.filter(s => s.presenterId === ctx.userId);
    else if (member) sessions = sessions.filter(s => s.presenterId === member.id);
    if (/\bevents?\b/.test(lower)) sessions = sessions.filter(s => s.kind === 'event');
    const { rows: dashRows } = await query('SELECT name FROM dashboards WHERE company_id = $1', [ctx.companyId]);
    const namedDash = dashRows.map((r: any) => r.name).find((n: string) => n && lower.includes(n.toLowerCase()));
    if (namedDash) sessions = sessions.filter(s => s.dashboard === namedDash);
    const when = date ? prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`;
    if (!sessions.length) {
      if (member) return `${memberDisplay(member)} presents no sessions ${when}.`;
      if (mySessions) return `You present no sessions ${when}.`;
      if (needsPresenter) return `No sessions need a presenter ${when}.`;
      return `No calendar sessions ${when}${namedDash ? ' on ' + namedDash : ''}.`;
    }
    const head = member ? `${memberDisplay(member)}'s sessions` : mySessions ? 'Your sessions' : needsPresenter ? 'Sessions needing a presenter' : 'Calendar sessions';
    return `${head} ${when}:\n${formatCalendarBlock(sessions)}`;
  }

  // --- Person-specific: "what's John's schedule" / "how many shifts does Jane have" ---
  if (member) {
    const from = date || week?.from || fmtDate(today);
    const to = date || week?.to || (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return fmtDate(d); })();
    const { rows: shifts } = await query(
      `SELECT s.date::text AS date, st.name AS "shiftTypeName", s.published
       FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.user_id = $2 AND s.date >= $3 AND s.date <= $4
       ORDER BY s.date`,
      [ctx.companyId, member.id, from, to]
    );
    const name = memberDisplay(member);
    const memberSessions = (await loadCalendarSessions(ctx, from, to)).filter(s => s.presenterId === member.id);
    if (!shifts.length && !memberSessions.length) return `${name} has no shifts ${date ? 'on ' + prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`}.`;
    if (isCount) {
      return `${name} has ${shifts.length} shift${shifts.length === 1 ? '' : 's'} ${date ? 'on ' + prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`}.`;
    }
    const lines = shifts.map(s => `${prettyDate(s.date)}: ${s.shiftTypeName}${s.published ? '' : ' (draft)'}`);
    if (memberSessions.length) lines.push(`Calendar sessions ${name} presents:\n${formatCalendarBlock(memberSessions)}`);
    return `${name}'s schedule:\n${lines.join('\n')}`;
  }

  // --- "Who's on / who's working" ---
  if (/\bwho('s| is)\b/.test(lower) || /\bon\b/.test(lower) || /\bworking\b/.test(lower) || /\bschedule\b/.test(lower) || /\bhappening\b/.test(lower)) {
    const from = date || week?.from || fmtDate(today);
    const to = date || week?.to || from;
    let shiftFilter = '';
    const params: any[] = [ctx.companyId, from, to];
    if (shiftTypes.length) {
      shiftFilter = ` AND s.shift_type_id = ANY($${params.length + 1})`;
      params.push(shiftTypes.map(s => s.id));
    }
    const { rows: shifts } = await query(
      `SELECT s.date::text AS date, u.first_name AS "firstName", u.last_name AS "lastName",
              u.nickname, st.name AS "shiftTypeName", s.published, s.notes
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3${shiftFilter}
       ORDER BY s.date, st.sort_order, u.first_name`,
      params
    );
    const calSessions = await loadCalendarSessions(ctx, from, to);
    if (!shifts.length && !calSessions.length) {
      const when = date ? prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`;
      return `Nobody's scheduled ${when}${shiftTypes.length ? ' for ' + shiftTypes.map(s => s.name).join(', ') : ''}.`;
    }
    // Group by date.
    const byDate = new Map<string, typeof shifts>();
    for (const s of shifts) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s);
    }
    const parts: string[] = [];
    for (const [ds, list] of [...byDate.entries()].sort()) {
      const names = list.map(s => {
        const n = s.nickname || `${s.firstName} ${s.lastName || ''}`.trim();
        return `${n} (${s.shiftTypeName})${s.published ? '' : ' [draft]'}`;
      });
      parts.push(`${prettyDate(ds)}: ${names.join(', ')}`);
    }
    if (calSessions.length) parts.push(`Calendar:\n${formatCalendarBlock(calSessions)}`);
    if (isCount) {
      const total = shifts.length;
      return `${total} shift${total === 1 ? '' : 's'} scheduled ${date ? 'on ' + prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`}.`;
    }
    return parts.join('\n');
  }

  // --- Fallback ---
  return `I can answer things like:\n• "Who's on Friday night?"\n• "Who's working tomorrow?"\n• "Are we short next week?"\n• "What's John's schedule this week?"\n• "How many shifts does Jane have?"\n• "What sessions are on Friday?" / "What events are on the Calendars dashboard this week?"\n• "Which sessions need a presenter?"\n• "Tell me my settings" / "What's my name?"`;
}
