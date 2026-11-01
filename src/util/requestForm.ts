// util/requestForm.ts — the Email Q-Scheduler request form
// (Deepika, 2026-11-01). One implementation serves the in-app form
// (behind the ✉️ Email Q-Scheduler button) and the no-login form page
// linked from our emails. A submission is composed into the app's own
// standard wording and enters the SAME engine as a hand-written email
// (processScheduleEmail) — approvals, reports and notifications are
// untouched; only the writing of the request is new.
//
// Shift identity in the form is the tuple (person, shift type, date) —
// the same identity the composed email carries — so manual and
// rotation-generated shifts work uniformly (getShiftsForRange).

import { query } from '../db.js';
import { getShiftsForRange, ShiftEntry } from './shiftRange.js';
import { getDepartmentAccess } from './departmentAccess.js';
import { processScheduleEmail } from './emailPoller.js';

type QueryFn = typeof query;

export interface FormUser {
  id: string;
  name: string;
  email: string;
  altEmail: string | null;
  role: string;
  departmentId: string | null;
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmtLong(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return dateStr;
  return `${DAY[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function todayStr(): string { return iso(new Date()); }
function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
}
function isDateStr(s: any): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

// ---------------------------------------------------------------------------
// Data pack — everything the form page needs, scoped to the viewer.
// ---------------------------------------------------------------------------

export interface FormPack {
  me: { id: string; name: string; email: string; altEmail: string | null; role: string };
  fromLocked: string | null; // clarification links: the From is fixed
  canAssign: boolean;
  window: { from: string; to: string };
  myShifts: Array<{ date: string; shiftTypeId: string; shiftTypeName: string }>;
  team: Array<{ id: string; name: string }>;
  teamShifts: Array<{ userId: string; date: string; shiftTypeId: string; shiftTypeName: string }>;
  openShifts: Array<{ date: string; shiftTypeId: string; shiftTypeName: string; open: number }>;
  shiftTypes: Array<{ id: string; name: string }>;
  dashboards: Array<{ id: string; name: string }>;
  sessions: Array<{
    id: string; dashboardId: string; date: string; title: string;
    startTime: string; endTime: string; presenterId: string | null; presenterName: string;
    supervisorName: string; location: string; recurring: boolean; needsPresenter: boolean;
  }>;
  rooms: string[];
  prefill: any;
  banner: string | null;
}

export async function buildFormPack(
  q: QueryFn, companyId: string, user: FormUser, opts?: { fromLocked?: string | null; prefill?: any }
): Promise<FormPack> {
  const from = addDays(todayStr(), -7);
  const to = addDays(todayStr(), 60);
  const all = await getShiftsForRange(q, companyId, from, to);

  // Department visibility for other people's shifts (owner: all;
  // scheduler: edit+view departments; employee: own department).
  let visibleDeptIds: Set<string> | null = null; // null = all
  if (user.role === 'scheduler') {
    const acc = await getDepartmentAccess(user.id, companyId);
    visibleDeptIds = new Set([...(acc.edit || []), ...(acc.view || [])]);
  } else if (user.role === 'employee') {
    visibleDeptIds = new Set(user.departmentId ? [user.departmentId] : []);
  }
  const { rows: teamRows } = await q(
    `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, department_id
     FROM users WHERE company_id = $1 AND is_active = true ORDER BY first_name, last_name`,
    [companyId]
  );
  const teamAll = teamRows.map((r: any) => ({ id: r.id, name: r.name, departmentId: r.department_id }));
  const visibleUsers = new Set(
    teamAll.filter((t: any) => !visibleDeptIds || (t.departmentId && visibleDeptIds.has(t.departmentId)) || t.id === user.id).map((t: any) => t.id)
  );

  const myShifts = all.filter((s) => s.userId === user.id && s.shiftTypeId)
    .map((s) => ({ date: s.date, shiftTypeId: s.shiftTypeId as string, shiftTypeName: s.shiftTypeName }));
  const teamShifts = all.filter((s) => s.userId !== user.id && s.shiftTypeId && visibleUsers.has(s.userId as string))
    .map((s) => ({ userId: s.userId as string, date: s.date, shiftTypeId: s.shiftTypeId as string, shiftTypeName: s.shiftTypeName }));

  // Open slots for pickup: target + extra − assigned, skipping closed.
  const { rows: targets } = await q(
    `SELECT shift_type_id, target_count, weekdays, start_date::text AS sd, end_date::text AS ed FROM staffing_targets WHERE company_id = $1`,
    [companyId]);
  const { rows: extras } = await q(
    'SELECT date::text AS date, shift_type_id, count FROM extra_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3',
    [companyId, from, to]);
  const { rows: closed } = await q(
    'SELECT date::text AS date, shift_type_id FROM closed_shifts WHERE company_id = $1 AND date >= $2 AND date <= $3',
    [companyId, from, to]);
  const { rows: stRows } = await q(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true ORDER BY sort_order, name', [companyId]);
  const stName = new Map(stRows.map((r: any) => [r.id, r.name]));
  const assigned = new Map<string, number>();
  for (const s of all) {
    const k = `${s.date}|${s.shiftTypeId}`;
    assigned.set(k, (assigned.get(k) || 0) + 1);
  }
  const extraMap = new Map(extras.map((r: any) => [`${r.date}|${r.shift_type_id}`, Number(r.count) || 0]));
  const closedSet = new Set(closed.map((r: any) => `${r.date}|${r.shift_type_id}`));
  const openShifts: FormPack['openShifts'] = [];
  const today = todayStr();
  for (const t of targets) {
    const days: number[] = String(t.weekdays || '{0,1,2,3,4,5,6}').replace(/[{}]/g, '').split(',').map((x: string) => parseInt(x, 10));
    for (let d = today; d <= to; d = addDays(d, 1)) {
      if (t.sd && d < t.sd) continue;
      if (t.ed && d > t.ed) continue;
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      if (!days.includes(dow)) continue;
      const k = `${d}|${t.shift_type_id}`;
      if (closedSet.has(k)) continue;
      const open = (Number(t.target_count) || 0) + (extraMap.get(k) || 0) - (assigned.get(k) || 0);
      if (open > 0) openShifts.push({ date: d, shiftTypeId: t.shift_type_id, shiftTypeName: stName.get(t.shift_type_id) || 'Shift', open });
    }
  }
  // Extra slots on types without a target row still count as open.
  for (const [k, count] of extraMap) {
    const [d, stId] = k.split('|');
    if (d < today || closedSet.has(k)) continue;
    if (targets.some((t: any) => t.shift_type_id === stId)) continue;
    const open = count - (assigned.get(k) || 0);
    if (open > 0) openShifts.push({ date: d, shiftTypeId: stId, shiftTypeName: stName.get(stId) || 'Shift', open });
  }
  openShifts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.shiftTypeName.localeCompare(b.shiftTypeName)));

  // Sessions: expand occurrences in the window, overrides applied.
  const { rows: dashes } = await q('SELECT id, name FROM dashboards WHERE company_id = $1 ORDER BY name', [companyId]);
  const { rows: roomRows } = await q('SELECT name FROM rooms WHERE company_id = $1 ORDER BY name', [companyId]);
  const { rows: sess } = await q(
    `SELECT s.id, s.dashboard_id, s.title, s.session_date::text AS sdate, s.start_time::text AS stime, s.end_time::text AS etime,
            s.recur_rule, s.recur_interval, s.recur_days, s.recur_until::text AS runtil, s.location,
            s.lecturer_user_id, s.supervisor_user_id,
            TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) AS pname,
            TRIM(COALESCE(sv.first_name,'') || ' ' || COALESCE(sv.last_name,'')) AS sname
     FROM academic_sessions s
     LEFT JOIN users l ON l.id = s.lecturer_user_id
     LEFT JOIN users sv ON sv.id = s.supervisor_user_id
     WHERE s.company_id = $1 ORDER BY s.session_date`,
    [companyId]);
  const { rows: ovr } = await q(
    `SELECT session_id, date::text AS date, lecturer_user_id, supervisor_user_id, location, start_time::text AS stime, end_time::text AS etime,
            cancelled, has_lecturer, has_supervisor, has_location, has_times
     FROM academic_session_overrides WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]);
  const ovrMap = new Map(ovr.map((o: any) => [`${o.session_id}|${o.date}`, o]));
  const nameOf = new Map(teamAll.map((t: any) => [t.id, t.name]));
  const sessions: FormPack['sessions'] = [];
  for (const s of sess) {
    const recurring = !!(s.recur_rule && s.recur_rule !== 'none');
    const startD = s.sdate;
    const endD = recurring ? (s.runtil && s.runtil < to ? s.runtil : to) : s.sdate;
    const daysList: number[] = s.recur_days
      ? String(s.recur_days).split(',').map((x: string) => parseInt(x, 10)).filter((n: number) => !isNaN(n))
      : [new Date(startD + 'T00:00:00Z').getUTCDay()];
    const interval = Math.max(1, Number(s.recur_interval) || 1);
    for (let d = startD < from ? from : startD; d <= endD; d = addDays(d, 1)) {
      if (d < startD) continue;
      if (recurring) {
        if (s.recur_rule === 'monthly') {
          if (new Date(d + 'T00:00:00Z').getUTCDate() !== new Date(startD + 'T00:00:00Z').getUTCDate()) continue;
        } else {
          if (!daysList.includes(new Date(d + 'T00:00:00Z').getUTCDay())) continue;
          const weeks = Math.floor((new Date(d + 'T00:00:00Z').getTime() - new Date(startD + 'T00:00:00Z').getTime()) / (7 * 86400000));
          if (weeks % interval !== 0) continue;
        }
      }
      const o = ovrMap.get(`${s.id}|${d}`);
      if (o && o.cancelled) continue;
      const presenterId = o && o.has_lecturer ? o.lecturer_user_id : s.lecturer_user_id;
      sessions.push({
        id: s.id, dashboardId: s.dashboard_id, date: d, title: s.title,
        startTime: o && o.has_times && o.stime ? String(o.stime).slice(0, 5) : (s.stime ? String(s.stime).slice(0, 5) : ''),
        endTime: o && o.has_times && o.etime ? String(o.etime).slice(0, 5) : (s.etime ? String(s.etime).slice(0, 5) : ''),
        presenterId: presenterId || null,
        presenterName: presenterId ? (nameOf.get(presenterId) || '') : '',
        supervisorName: (o && o.has_supervisor ? (o.supervisor_user_id ? nameOf.get(o.supervisor_user_id) || '' : '') : s.sname) || '',
        location: (o && o.has_location ? o.location : s.location) || '',
        recurring,
        needsPresenter: !presenterId,
      });
      if (sessions.length > 400) break;
    }
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.title.localeCompare(b.title)));

  const canAssign = user.role === 'owner'
    || (user.role === 'scheduler' && (await getDepartmentAccess(user.id, companyId)).edit.length > 0);

  return {
    me: { id: user.id, name: user.name, email: user.email, altEmail: user.altEmail, role: user.role },
    fromLocked: opts?.fromLocked || null,
    canAssign,
    window: { from, to },
    myShifts, team: teamAll.map((t: any) => ({ id: t.id, name: t.name })), teamShifts,
    openShifts,
    shiftTypes: stRows.map((r: any) => ({ id: r.id, name: r.name })),
    dashboards: dashes.map((d: any) => ({ id: d.id, name: d.name })),
    sessions,
    rooms: roomRows.map((r: any) => r.name),
    prefill: opts?.prefill || null,
    banner: null,
  };
}

// ---------------------------------------------------------------------------
// Validation + composition. The server resolves every id itself and
// writes the canonical wording — the client's text is never trusted.
// ---------------------------------------------------------------------------

export interface Composed { subject: string; body: string }
type ResolveResult = { ok: true; composed: Composed; changes: any[] | null; openCover?: { date: string; shiftTypeId: string; shiftTypeName: string } } | { ok: false; error: string };

function sig(name: string, from: string): string {
  return `\n\n— Sent from the Quick Scheduling app by ${name} (${from})`;
}
function noteLine(note: any): string {
  const n = String(note || '').trim().slice(0, 500);
  return n ? `\n\nNote: ${n}` : '';
}
function timeRange(st: string, et: string): string {
  if (st && et) return `, ${st}–${et}`;
  if (st) return ` at ${st}`;
  return '';
}

async function shiftExists(q: QueryFn, companyId: string, userId: string, shiftTypeId: string, date: string): Promise<ShiftEntry | null> {
  const all = await getShiftsForRange(q, companyId, date, date);
  return all.find((s) => s.userId === userId && s.shiftTypeId === shiftTypeId && s.date === date) || null;
}

async function sessionOn(q: QueryFn, companyId: string, sessionId: string, date: string): Promise<any | null> {
  const { rows } = await q(
    `SELECT s.id, s.dashboard_id, s.title, s.session_date::text AS sdate, s.start_time::text AS stime, s.end_time::text AS etime,
            s.recur_rule, s.recur_interval, s.recur_days, s.recur_until::text AS runtil, s.location,
            s.lecturer_user_id, s.supervisor_user_id, d.name AS dash_name,
            TRIM(COALESCE(l.first_name,'') || ' ' || COALESCE(l.last_name,'')) AS pname,
            TRIM(COALESCE(sv.first_name,'') || ' ' || COALESCE(sv.last_name,'')) AS sname
     FROM academic_sessions s JOIN dashboards d ON d.id = s.dashboard_id
     LEFT JOIN users l ON l.id = s.lecturer_user_id
     LEFT JOIN users sv ON sv.id = s.supervisor_user_id
     WHERE s.company_id = $1 AND s.id = $2`,
    [companyId, sessionId]);
  if (!rows.length) return null;
  const s = rows[0];
  const recurring = !!(s.recur_rule && s.recur_rule !== 'none');
  if (!recurring) {
    if (s.sdate !== date) return null;
  } else {
    if (date < s.sdate) return null;
    if (s.runtil && date > s.runtil) return null;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (s.recur_rule === 'monthly') {
      if (new Date(date + 'T00:00:00Z').getUTCDate() !== new Date(s.sdate + 'T00:00:00Z').getUTCDate()) return null;
    } else {
      const daysList: number[] = s.recur_days
        ? String(s.recur_days).split(',').map((x: string) => parseInt(x, 10)).filter((n: number) => !isNaN(n))
        : [new Date(s.sdate + 'T00:00:00Z').getUTCDay()];
      if (!daysList.includes(dow)) return null;
      const weeks = Math.floor((new Date(date + 'T00:00:00Z').getTime() - new Date(s.sdate + 'T00:00:00Z').getTime()) / (7 * 86400000));
      if (weeks % Math.max(1, Number(s.recur_interval) || 1) !== 0) return null;
    }
  }
  const { rows: ovr } = await q(
    `SELECT lecturer_user_id, supervisor_user_id, location, start_time::text AS stime, end_time::text AS etime,
            cancelled, has_lecturer, has_supervisor, has_location, has_times
     FROM academic_session_overrides WHERE company_id = $1 AND session_id = $2 AND date = $3`,
    [companyId, sessionId, date]);
  const o = ovr[0];
  if (o && o.cancelled) return null;
  const { rows: team } = await q(
    `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM users WHERE company_id = $1 AND is_active = true`,
    [companyId]);
  const nameOf = new Map(team.map((t: any) => [t.id, t.name]));
  const presenterId = o && o.has_lecturer ? o.lecturer_user_id : s.lecturer_user_id;
  return {
    ...s,
    recurring,
    date,
    startTime: o && o.has_times && o.stime ? String(o.stime).slice(0, 5) : (s.stime ? String(s.stime).slice(0, 5) : ''),
    endTime: o && o.has_times && o.etime ? String(o.etime).slice(0, 5) : (s.etime ? String(s.etime).slice(0, 5) : ''),
    presenterId: presenterId || null,
    presenterName: presenterId ? (nameOf.get(presenterId) || s.pname || '') : '',
    supervisorName: (o && o.has_supervisor ? (o.supervisor_user_id ? nameOf.get(o.supervisor_user_id) || '' : '') : s.sname) || '',
    location: (o && o.has_location ? o.location : s.location) || '',
  };
}

async function memberName(q: QueryFn, companyId: string, userId: string): Promise<string | null> {
  const { rows } = await q(
    `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM users WHERE company_id = $1 AND id = $2 AND is_active = true`,
    [companyId, userId]);
  return rows.length ? rows[0].name : null;
}

export const FORM_ACTIONS = [
  'swap', 'request_off', 'pickup', 'cover', 'move_shift', 'cancel_shift', 'assign',
  'session_add', 'session_move', 'session_cancel', 'session_presenter', 'session_room_supervisor', 'session_pickup',
  'question',
] as const;

export async function validateAndCompose(
  q: QueryFn, companyId: string, user: FormUser, fromEmail: string,
  action: string, f: any, canAssign: boolean
): Promise<ResolveResult> {
  const bad = (error: string): ResolveResult => ({ ok: false, error });
  const good = (subject: string, body: string, changes: any[] | null = null): ResolveResult =>
    ({ ok: true, composed: { subject, body }, changes });
  const note = noteLine(f && f.note);
  const S = (name: string) => `${name} — ${user.name}`;

  switch (action) {
    case 'swap': {
      // Multiple pairs in one request (Deepika 2026-11-01: "when
      // swapping only one date is able to be swapped — I should be
      // able to do multiple"). The form sends both pick lists; pairs
      // are matched in date order (first of mine ↔ first of theirs).
      const cleanPicks = (v: any) => (Array.isArray(v) ? v : [])
        .filter((p: any) => p && isDateStr(p.date) && p.shiftTypeId)
        .map((p: any) => ({ date: p.date as string, shiftTypeId: String(p.shiftTypeId) }))
        .sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
      const myPicks = cleanPicks(f.myPicks);
      const theirPicks = cleanPicks(f.theirPicks);
      if (!f.theirUserId) return bad('Choose the person to swap with.');
      if (!myPicks.length) return bad('Pick your shift(s) on the calendar.');
      if (!theirPicks.length) return bad("Pick their shift(s) on the calendar.");
      if (myPicks.length !== theirPicks.length) {
        return bad(`You picked ${myPicks.length} of your shifts and ${theirPicks.length} of theirs — pick the same number of each so they pair up.`);
      }
      if (myPicks.length > 14) return bad('That is a lot of swaps for one request — please keep it to 14 pairs or fewer.');
      const changes: any[] = [];
      const lines: string[] = [];
      let partnerName = '';
      for (let i = 0; i < myPicks.length; i++) {
        const mine = await shiftExists(q, companyId, user.id, myPicks[i].shiftTypeId, myPicks[i].date);
        if (!mine) return bad('One of your picked shifts could not be found — pick it again.');
        const theirs = await shiftExists(q, companyId, String(f.theirUserId), theirPicks[i].shiftTypeId, theirPicks[i].date);
        if (!theirs) return bad("One of their picked shifts could not be found — pick it again.");
        partnerName = theirs.personName;
        lines.push(`my ${mine.shiftTypeName} shift on ${fmtLong(myPicks[i].date)} with ${theirs.personName}'s ${theirs.shiftTypeName} shift on ${fmtLong(theirPicks[i].date)}`);
        // Same type on both sides: the executor's single swap change.
        // Different types: unassign both + cross-assign (the executor's
        // swap resolves one type per side).
        if (mine.shiftTypeName === theirs.shiftTypeName) {
          changes.push({ action: 'swap', fromPerson: user.name, toPerson: theirs.personName, toUserId: String(f.theirUserId), fromDate: myPicks[i].date, toDate: theirPicks[i].date, shiftType: mine.shiftTypeName });
        } else {
          changes.push(
            { action: 'unassign', person: user.name, date: myPicks[i].date, shiftType: mine.shiftTypeName },
            { action: 'unassign', person: theirs.personName, date: theirPicks[i].date, shiftType: theirs.shiftTypeName },
            { action: 'assign', person: theirs.personName, date: myPicks[i].date, shiftType: mine.shiftTypeName },
            { action: 'assign', person: user.name, date: theirPicks[i].date, shiftType: theirs.shiftTypeName },
          );
        }
      }
      const wording = lines.length === 1
        ? `Please swap ${lines[0]}.`
        : `Please swap these shifts with ${partnerName}: ${lines.join('; ')}.`;
      return good(S('Swap request'), `${wording}${note}${sig(user.name, fromEmail)}`, changes);
    }
    case 'request_off': {
      const dates: string[] = Array.isArray(f.dates) ? [...new Set<string>((f.dates as any[]).filter(isDateStr))].sort() : [];
      if (!dates.length) return bad('Pick at least one date.');
      if (dates.length > 31) return bad('That is a lot of dates — please split it into two requests.');
      const mine = (await getShiftsForRange(q, companyId, dates[0], dates[dates.length - 1]))
        .filter((s) => s.userId === user.id && dates.includes(s.date));
      if (!mine.length) return bad("You're not scheduled on any of those dates, so there's nothing to take off. If a schedule isn't published yet, ask again once it is.");
      const sched = ` I am scheduled for ${mine.map((s) => `${s.shiftTypeName} on ${fmtLong(s.date)}`).join('; ')} — please take me off those shifts.`;
      return good(S('Request off'),
        `Please give me off on ${dates.map(fmtLong).join('; ')}.${sched}${note}${sig(user.name, fromEmail)}`,
        mine.map((s) => ({ action: 'unassign', person: user.name, date: s.date, shiftType: s.shiftTypeName })));
    }
    case 'pickup': {
      if (!isDateStr(f.date) || !f.shiftTypeId) return bad('Pick an open shift.');
      const { rows } = await q('SELECT name FROM shift_types WHERE company_id = $1 AND id = $2', [companyId, String(f.shiftTypeId)]);
      if (!rows.length) return bad('That shift type could not be found.');
      return good(S('Pick up shift'),
        `I would like to pick up the open ${rows[0].name} shift on ${fmtLong(f.date)}.${note}${sig(user.name, fromEmail)}`,
        [{ action: 'assign', person: user.name, date: f.date, shiftType: rows[0].name }]);
    }
    case 'cover': {
      // Cover is a BROADCAST, not a named-person ask (Deepika
      // 2026-11-01): it goes to everyone with the requester's job
      // role and the first to pick it up gets it. processFormRequest
      // turns this into an open shift_requests row — no plan, no
      // admin approval; the pickup itself is the decision.
      if (!isDateStr(f.myDate)) return bad('Pick the shift you need covered.');
      const mine = await shiftExists(q, companyId, user.id, String(f.myShiftTypeId || ''), f.myDate);
      if (!mine) return bad('That shift of yours could not be found — pick it again.');
      return {
        ok: true,
        composed: {
          subject: S('Cover request'),
          body: `Please find cover for my ${mine.shiftTypeName} shift on ${fmtLong(f.myDate)}. It is open to everyone with my job role — the first to pick it up gets it.${note}${sig(user.name, fromEmail)}`,
        },
        changes: null,
        openCover: { date: f.myDate, shiftTypeId: String(f.myShiftTypeId), shiftTypeName: mine.shiftTypeName },
      };
    }
    case 'move_shift': {
      if (!isDateStr(f.myDate) || !isDateStr(f.newDate)) return bad('Pick your shift and the new date.');
      if (f.myDate === f.newDate) return bad('The new date is the same as the current date.');
      const mine = await shiftExists(q, companyId, user.id, String(f.myShiftTypeId || ''), f.myDate);
      if (!mine) return bad('That shift of yours could not be found — pick it again.');
      return good(S('Move shift'),
        `Please move my ${mine.shiftTypeName} shift from ${fmtLong(f.myDate)} to ${fmtLong(f.newDate)}.${note}${sig(user.name, fromEmail)}`,
        [
          { action: 'unassign', person: user.name, date: f.myDate, shiftType: mine.shiftTypeName },
          { action: 'assign', person: user.name, date: f.newDate, shiftType: mine.shiftTypeName },
        ]);
    }
    case 'cancel_shift': {
      if (!isDateStr(f.myDate)) return bad('Pick the shift to cancel.');
      const mine = await shiftExists(q, companyId, user.id, String(f.myShiftTypeId || ''), f.myDate);
      if (!mine) return bad('That shift of yours could not be found — pick it again.');
      return good(S('Cancel shift'),
        `Please cancel my ${mine.shiftTypeName} shift on ${fmtLong(f.myDate)}.${note}${sig(user.name, fromEmail)}`,
        [{ action: 'unassign', person: user.name, date: f.myDate, shiftType: mine.shiftTypeName }]);
    }
    case 'assign': {
      if (!canAssign) return bad('Your role cannot assign shifts.');
      const dates: string[] = Array.isArray(f.dates) ? [...new Set<string>((f.dates as any[]).filter(isDateStr))].sort() : [];
      if (!dates.length) return bad('Pick at least one date.');
      if (dates.length > 31) return bad('Please split that into two requests.');
      const who = await memberName(q, companyId, String(f.userId || ''));
      if (!who) return bad('Pick a team member.');
      const { rows } = await q('SELECT name FROM shift_types WHERE company_id = $1 AND id = $2', [companyId, String(f.shiftTypeId || '')]);
      if (!rows.length) return bad('Pick a shift type.');
      return good(S('Assign shift'),
        `Please assign ${who} to ${rows[0].name} on ${dates.map(fmtLong).join('; ')}.${note}${sig(user.name, fromEmail)}`,
        dates.map((d) => ({ action: 'assign', person: who, date: d, shiftType: rows[0].name })));
    }
    case 'session_add': {
      const title = String(f.title || '').trim().slice(0, 120);
      if (!title) return bad('Give the session a title.');
      if (!isDateStr(f.date)) return bad('Pick a date.');
      const { rows: dash } = await q('SELECT name FROM dashboards WHERE company_id = $1 AND id = $2', [companyId, String(f.dashboardId || '')]);
      if (!dash.length) return bad('Pick a calendar.');
      let extra = '';
      let presenterName: string | null = null;
      if (f.presenterId) {
        presenterName = await memberName(q, companyId, String(f.presenterId));
        if (!presenterName) return bad('That presenter could not be found.');
        extra += ` Presenter: ${presenterName}.`;
      }
      if (f.room) extra += ` Room: ${String(f.room).trim().slice(0, 60)}.`;
      if (f.weekly) extra += ' It repeats weekly.';
      const times = f.startTime ? `, ${String(f.startTime).slice(0, 5)}${f.endTime ? '–' + String(f.endTime).slice(0, 5) : ''}` : '';
      const change: any = { action: 'add_session', dashboard: dash[0].name, title, date: f.date };
      if (f.startTime) change.startTime = String(f.startTime).slice(0, 5);
      if (f.endTime) change.endTime = String(f.endTime).slice(0, 5);
      if (presenterName) change.presenter = presenterName;
      if (f.room) change.location = String(f.room).trim().slice(0, 60);
      if (f.weekly) { change.recurRule = 'weekly'; change.recurInterval = 1; }
      return good(S('Add session'),
        `Please add a session "${title}" on the ${dash[0].name} calendar on ${fmtLong(f.date)}${times}.${extra}${note}${sig(user.name, fromEmail)}`,
        [change]);
    }
    case 'session_move': {
      const s = await sessionOn(q, companyId, String(f.sessionId || ''), String(f.date || ''));
      if (!s) return bad('That session could not be found — pick it again.');
      if (!isDateStr(f.newDate)) return bad('Pick the new date.');
      const scope = s.recurring ? (f.scope === 'series' ? ' Apply it to the whole series.' : ' This date only — the rest of the series stays as it is.') : '';
      const newTime = f.newStartTime ? ` at ${String(f.newStartTime).slice(0, 5)}` : (s.startTime ? ` at ${s.startTime}` : '');
      const change: any = { action: 'update_session', dashboard: s.dash_name, sessionTitle: s.title, date: s.date, newDate: f.newDate };
      if (s.recurring) change.scope = f.scope === 'series' ? 'series' : 'date';
      if (f.newStartTime) change.startTime = String(f.newStartTime).slice(0, 5);
      return good(S('Move session'),
        `Please move the ${s.title} session on the ${s.dash_name} calendar from ${fmtLong(s.date)}${timeRange(s.startTime, s.endTime)} to ${fmtLong(f.newDate)}${newTime}.${scope}${note}${sig(user.name, fromEmail)}`,
        [change]);
    }
    case 'session_cancel': {
      const s = await sessionOn(q, companyId, String(f.sessionId || ''), String(f.date || ''));
      if (!s) return bad('That session could not be found — pick it again.');
      const scope = s.recurring ? (f.scope === 'series' ? ' Cancel the whole series.' : ' This date only.') : '';
      const change: any = { action: 'cancel_session', dashboard: s.dash_name, sessionTitle: s.title, date: s.date };
      if (s.recurring) change.scope = f.scope === 'series' ? 'series' : 'date';
      return good(S('Cancel session'),
        `Please cancel the ${s.title} session on the ${s.dash_name} calendar on ${fmtLong(s.date)}${timeRange(s.startTime, s.endTime)}.${scope}${note}${sig(user.name, fromEmail)}`,
        [change]);
    }
    case 'session_presenter': {
      const s = await sessionOn(q, companyId, String(f.sessionId || ''), String(f.date || ''));
      if (!s) return bad('That session could not be found — pick it again.');
      const n = await memberName(q, companyId, String(f.presenterId || ''));
      if (!n) return bad('Pick the new presenter.');
      const scope = s.recurring ? (f.scope === 'series' ? ' Apply it to the whole series.' : ' This date only.') : '';
      const change: any = { action: 'update_session', dashboard: s.dash_name, sessionTitle: s.title, date: s.date, presenter: n };
      if (s.recurring) change.scope = f.scope === 'series' ? 'series' : 'date';
      return good(S('Change presenter'),
        `Please change the presenter of the ${s.title} session on the ${s.dash_name} calendar on ${fmtLong(s.date)}${timeRange(s.startTime, s.endTime)} from ${s.presenterName || '(no presenter)'} to ${n}.${scope}${note}${sig(user.name, fromEmail)}`,
        [change]);
    }
    case 'session_room_supervisor': {
      const s = await sessionOn(q, companyId, String(f.sessionId || ''), String(f.date || ''));
      if (!s) return bad('That session could not be found — pick it again.');
      const parts: string[] = [];
      const change: any = { action: 'update_session', dashboard: s.dash_name, sessionTitle: s.title, date: s.date };
      if (f.room !== undefined && String(f.room).trim() !== (s.location || '')) {
        parts.push(`room to ${String(f.room).trim().slice(0, 60) || '(none)'}`);
        change.location = String(f.room).trim().slice(0, 60);
      }
      if (f.supervisorId) {
        const n = await memberName(q, companyId, String(f.supervisorId));
        if (!n) return bad('That supervisor could not be found.');
        parts.push(`supervisor to ${n}`);
        change.supervisor = n;
      }
      if (!parts.length) return bad('Change the room or pick a supervisor first.');
      const scope = s.recurring ? (f.scope === 'series' ? ' Apply it to the whole series.' : ' This date only.') : '';
      if (s.recurring) change.scope = f.scope === 'series' ? 'series' : 'date';
      return good(S('Change session'),
        `Please change the ${parts.join(' and ')} for the ${s.title} session on the ${s.dash_name} calendar on ${fmtLong(s.date)}${timeRange(s.startTime, s.endTime)}.${scope}${note}${sig(user.name, fromEmail)}`,
        [change]);
    }
    case 'session_pickup': {
      const s = await sessionOn(q, companyId, String(f.sessionId || ''), String(f.date || ''));
      if (!s) return bad('That session could not be found — pick it again.');
      if (s.presenterId) return bad('That session already has a presenter.');
      return good(S('Pick up session'),
        `I would like to present the ${s.title} session on the ${s.dash_name} calendar on ${fmtLong(s.date)}${timeRange(s.startTime, s.endTime)} — it needs a presenter.${note}${sig(user.name, fromEmail)}`,
        [{ action: 'update_session', dashboard: s.dash_name, sessionTitle: s.title, date: s.date, scope: 'date', presenter: user.name }]);
    }
    case 'question': {
      const text = String(f.text || '').trim().slice(0, 1500);
      if (text.length < 3) return bad('Write your question first.');
      return good(text.slice(0, 80), `${text}${sig(user.name, fromEmail)}`);
    }
    default:
      return bad('Unknown action.');
  }
}

// ---------------------------------------------------------------------------
// Submission: store, then act. Change requests are built DIRECTLY from
// the form's picks into a pending plan (Deepika 2026-11-01: "if we are
// using the form, why do we need AI? It could be built in") — no AI in
// that loop, so a form request is exact and works even while the AI is
// down. Only the free-text "Ask a question" action goes through the
// email engine (rules first, AI as backup), like a hand-written email.
// ---------------------------------------------------------------------------

export const OUTCOME_MESSAGES: Record<string, string> = {
  plan_created: "Sent ✓ Your request is with the approvers — you'll get an email when they decide.",
  swap_with_partner: "Sent ✓ Your swap request went to your swap partner first — if they agree, it goes to the approvers for final approval.",
  cover_posted: "Posted ✓ Everyone with your job role can see it — the first to pick it up gets the shift.",
  question_answered: 'Sent ✓ The answer is on its way to your email.',
  clarification_sent: 'Sent ✓ One more detail was needed — check your email: you can reply in words, or tap the form button there to finish it.',
  skipped: 'Received ✓',
  queued: "Received ✓ The assistant is temporarily unavailable, so your question is saved and will be answered automatically as soon as it's back. You don't need to send it again.",
};

async function loadRowUser(q: QueryFn, row: any): Promise<FormUser | null> {
  if (!row.user_id) return null;
  const { rows } = await q(
    `SELECT id, first_name, last_name, email, alt_email, role, department_id FROM users
     WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [row.user_id, row.company_id]
  );
  if (!rows.length) return null;
  const u = rows[0];
  return {
    id: u.id,
    name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
    email: u.email,
    altEmail: u.alt_email || null,
    role: u.role,
    departmentId: u.department_id || null,
  };
}

export async function processFormRequest(q: QueryFn, row: any): Promise<{ status: string; outcome: string | null; message?: string }> {
  const sourceId = `form:${row.id}`;
  // Never plan twice: a plan already exists for this submission.
  const { rows: existing } = await q(
    'SELECT 1 FROM schedule_plans WHERE company_id = $1 AND source_email_id = $2 LIMIT 1', [row.company_id, sourceId]);
  if (existing.length) {
    await q("UPDATE form_requests SET status = 'done', outcome = 'plan_created', processed_at = now() WHERE id = $1", [row.id]);
    return { status: 'done', outcome: 'plan_created' };
  }
  const attempts = Number(row.attempts || 0) + 1;
  await q('UPDATE form_requests SET attempts = $1 WHERE id = $2', [attempts, row.id]);

  const user = await loadRowUser(q, row);
  if (!user) {
    await q("UPDATE form_requests SET status = 'failed', outcome = 'no_user', processed_at = now() WHERE id = $1", [row.id]);
    return { status: 'failed', outcome: 'no_user' };
  }
  const canAssign = user.role === 'owner'
    || (user.role === 'scheduler' && (await getDepartmentAccess(user.id, row.company_id)).edit.length > 0);
  const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : (row.fields || {});
  const resolved = await validateAndCompose(q, row.company_id, user, row.from_email, row.action, fields, canAssign);
  if (!resolved.ok) {
    await q("UPDATE form_requests SET status = 'failed', outcome = 'invalid', processed_at = now() WHERE id = $1", [row.id]);
    return { status: 'failed', outcome: 'invalid', message: resolved.error };
  }

  // Cover (Deepika 2026-11-01): a broadcast open request, NOT a
  // plan. It goes to everyone with the requester's job role; the
  // first to pick it up gets the shift (the pickup is the decision —
  // no admin stage). Only real shift rows can carry a request
  // (migration 034): rotation-generated entries have no row, and a
  // scheduler arranges cover for those, like the in-app requests.
  if (row.action === 'cover' && resolved.openCover) {
    const oc = resolved.openCover;
    const { rows: srows } = await q(
      'SELECT id FROM shifts WHERE company_id = $1 AND user_id = $2 AND shift_type_id = $3 AND date = $4 LIMIT 1',
      [row.company_id, user.id, oc.shiftTypeId, oc.date]);
    if (!srows.length) {
      await q("UPDATE form_requests SET status = 'failed', outcome = 'invalid', processed_at = now() WHERE id = $1", [row.id]);
      return { status: 'failed', outcome: 'invalid', message: 'That shift comes from a rotation, so it cannot be posted for cover — please ask a scheduler to arrange cover for it.' };
    }
    const shiftId = srows[0].id;
    const { rows: existingReq } = await q(
      "SELECT id FROM shift_requests WHERE company_id = $1 AND shift_id = $2 AND status = 'pending' LIMIT 1",
      [row.company_id, shiftId]);
    if (existingReq.length) {
      await q("UPDATE form_requests SET status = 'failed', outcome = 'invalid', processed_at = now() WHERE id = $1", [row.id]);
      return { status: 'failed', outcome: 'invalid', message: 'There is already an open request for that shift.' };
    }
    const { randomUUID } = await import('crypto');
    await q(
      `INSERT INTO shift_requests (id, company_id, request_type, shift_id, requester_id, target_user_id, status)
       VALUES ($1, $2, 'pickup', $3, $4, NULL, 'pending')`,
      [randomUUID(), row.company_id, shiftId, user.id]);
    try {
      const { notify } = await import('./notify.js');
      const { rows: meRows } = await q('SELECT job_role_id FROM users WHERE id = $1', [user.id]);
      const myRole = meRows.length ? meRows[0].job_role_id : null;
      const { rows: peers } = myRole
        ? await q('SELECT id FROM users WHERE company_id = $1 AND is_active = true AND job_role_id = $2 AND id <> $3', [row.company_id, myRole, user.id])
        : await q('SELECT id FROM users WHERE company_id = $1 AND is_active = true AND id <> $2', [row.company_id, user.id]);
      if (peers.length) {
        await notify({
          companyId: row.company_id, userIds: peers.map((p: any) => p.id), category: 'schedule', type: 'request_to_you',
          title: `${user.name} needs cover`,
          body: `${user.name} needs cover for ${oc.shiftTypeName} on ${oc.date}. First to pick it up gets it.`,
          link: 'requests', bundleKey: 'request_to_you',
          bundleTitle: '{count} requests are waiting for you',
          excludeUserId: user.id,
        });
      }
    } catch { /* non-fatal */ }
    await q("UPDATE form_requests SET status = 'done', outcome = 'cover_posted', processed_at = now() WHERE id = $1", [row.id]);
    return { status: 'done', outcome: 'cover_posted' };
  }

  // Free-text question: the one form action that still needs the
  // engine (rules + AI answer it like a hand-written email).
  if (row.action === 'question' || !resolved.changes) {
    const prefill = row.prefill || null;
    const engineSubject = row.source === 'clarification' && prefill && prefill.originalSubject
      ? `Re: ${prefill.originalSubject}` : row.subject;
    const result = { checked: 1, newPlans: 0, questionsAnswered: 0, errors: [] as string[] };
    let outcome: any;
    try {
      outcome = await processScheduleEmail(
        q, row.company_id,
        {
          from: row.from_email, fromName: user.name, cc: null,
          subject: engineSubject, body: row.body, attachments: [],
          messageId: null,
          inReplyTo: prefill && prefill.messageId ? prefill.messageId : null,
          references: prefill && prefill.messageId ? prefill.messageId : null,
        },
        sourceId, result, {}
      );
    } catch {
      outcome = undefined;
    }
    if (!outcome) {
      const status = attempts >= 3 ? 'failed' : 'queued';
      await q('UPDATE form_requests SET status = $1, processed_at = now() WHERE id = $2', [status, row.id]);
      return { status, outcome: null };
    }
    if (outcome.kind === 'sender_not_staff') {
      await q("UPDATE form_requests SET status = 'failed', outcome = 'sender_not_staff', processed_at = now() WHERE id = $1", [row.id]);
      return { status: 'failed', outcome: 'sender_not_staff' };
    }
    await q('UPDATE form_requests SET status = $1, outcome = $2, processed_at = now() WHERE id = $3',
      ['done', outcome.kind, row.id]);
    return { status: 'done', outcome: outcome.kind };
  }

  // Change request: build the pending plan directly from the picks.
  const { createPendingPlanFromChanges } = await import('./emailPoller.js');
  const { standingFormFooter } = await import('./formLinks.js');
  // The plan summary is the request itself (first sentences of the
  // composed wording, signature off) — approvers read it in the email
  // subject, the Requests list and the bell, so a bare "Swap request —
  // Name" is not enough (Deepika 2026-11-01).
  const summary = resolved.composed.body.split('\n\n— Sent from the Quick Scheduling app')[0].replace(/^Please /, '').trim();
  const plan = { summary: summary.charAt(0).toUpperCase() + summary.slice(1), changes: resolved.changes, emailType: 'change_request' };
  let footer: { text: string; html: string } | null = null;
  try { footer = await standingFormFooter(q, row.company_id, row.from_email); } catch { /* best-effort */ }
  let createdPlanId: string | null = null;
  try {
    createdPlanId = await createPendingPlanFromChanges(q, row.company_id, plan, {
      sourceId,
      subject: resolved.composed.subject,
      cc: null,
      body: resolved.composed.body,
      senderAddress: row.from_email,
      senderName: user.name,
      fromAddr: null,
      fromLine: `${user.name} <${row.from_email}>`,
      requesterFooter: footer || undefined,
      // Swaps stage at the partner first (Deepika 2026-11-01).
      partnerUserId: row.action === 'swap' ? (String(fields.theirUserId || '') || null) : null,
    });
  } catch {
    const status = attempts >= 3 ? 'failed' : 'queued';
    await q('UPDATE form_requests SET status = $1, processed_at = now() WHERE id = $2', [status, row.id]);
    return { status, outcome: null };
  }

  // A clarification resolved through the form: close the pending
  // clarification (so nothing double-processes) and save the lesson —
  // their original words -> this clean request — for the example book.
  if (row.source === 'clarification' && row.prefill) {
    try {
      const { clearPendingClarification } = await import('./pendingClarifications.js');
      await clearPendingClarification(q, row.company_id, row.from_email);
    } catch { /* best-effort */ }
    try {
      const { saveLearningExample } = await import('./emailLearning.js');
      const original = row.prefill.originalBody || row.prefill.originalSubject || '';
      if (original) await saveLearningExample(q, row.company_id, original, resolved.composed.body, 'clarification-form');
    } catch { /* best-effort */ }
  }

  // A swap plan may have been staged at the partner — the success
  // message must say where it actually went.
  let finalOutcome = 'plan_created';
  if (createdPlanId) {
    try {
      const { rows: pst } = await q('SELECT status FROM schedule_plans WHERE id = $1', [createdPlanId]);
      if (pst.length && pst[0].status === 'awaiting_partner') finalOutcome = 'swap_with_partner';
    } catch { /* keep the default message */ }
  }
  await q('UPDATE form_requests SET status = $1, outcome = $2, processed_at = now() WHERE id = $3', ['done', finalOutcome, row.id]);
  return { status: 'done', outcome: finalOutcome };
}

/** Retry queued submissions (a question waiting on the AI, or a rare
 * database hiccup) — called by the poll scheduler each cycle;
 * attempt-capped at 3 total tries. */
export async function sweepQueuedFormRequests(q: QueryFn): Promise<void> {
  try {
    const { rows } = await q(
      `SELECT * FROM form_requests WHERE status = 'queued' AND attempts < 3 ORDER BY created_at LIMIT 5`);
    for (const row of rows) {
      if (row.source === 'clarification') {
        const { rows: links } = await q(
          "SELECT prefill FROM form_links WHERE company_id = $1 AND sender_email = $2 AND kind = 'clarification' AND prefill IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [row.company_id, row.from_email]);
        if (links.length) row.prefill = links[0].prefill;
      }
      await processFormRequest(q, row);
    }
  } catch (err: any) {
    console.log(`[form] queue sweep failed: ${err.message}`);
  }
}
