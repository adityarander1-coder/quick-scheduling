// util/planExecutor.ts — executes approved schedule change plans.

import crypto from 'node:crypto';
import { query } from '../db.js';
import { getDepartmentAccess } from './departmentAccess.js';

interface PlanChange {
  action: 'assign' | 'assign_recurring' | 'unassign' | 'move' | 'swap' | 'add_job_role' | 'rename_job_role' | 'delete_job_role' |
          'add_department' | 'rename_department' |
          'add_team_member' | 'update_team_member' |
          'add_shift_type' | 'rename_shift_type' |
          'set_staffing_target' |
          'bulk_publish' | 'bulk_unpublish' |
          'add_session' | 'update_session' | 'cancel_session';
  person?: string;
  fromPerson?: string;
  toPerson?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  // Recurring shift fields (assign_recurring)
  startDate?: string;
  intervalWeeks?: number;
  weekendsOff?: boolean;
  untilDate?: string;
  shiftType?: string;
  jobRoleName?: string;
  newJobRoleName?: string;
  department?: string;
  newDepartment?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  newShiftType?: string;
  targetCount?: number;
  // Calendar session fields (add_session / update_session / cancel_session)
  dashboard?: string;
  title?: string;
  sessionTitle?: string;
  sessionType?: string;
  presenter?: string;
  supervisor?: string;
  location?: string;
  startTime?: string;
  endTime?: string;
  scope?: 'date' | 'series';
  newDate?: string;
  recurRule?: string;
  recurInterval?: number;
  recurUntil?: string;
  notes?: string;
}

interface ExecuteResult {
  action: string;
  success: boolean;
  message: string;
}

/** Find a user ID by fuzzy name match. */
async function findUser(companyId: string, name: string): Promise<{ id: string; display: string } | null> {
  const { rows } = await query(
    `SELECT id, first_name, last_name, nickname FROM users
     WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  const lower = name.toLowerCase().trim();
  for (const u of rows) {
    const names = [
      u.nickname?.toLowerCase(),
      `${u.first_name} ${u.last_name}`.toLowerCase().trim(),
      u.first_name.toLowerCase(),
      u.last_name?.toLowerCase(),
    ].filter(Boolean);
    if (names.some(n => n === lower || (n.length >= 3 && lower.includes(n)) || (lower.length >= 3 && n.includes(lower)))) {
      return { id: u.id, display: u.nickname || `${u.first_name} ${u.last_name || ''}`.trim() };
    }
  }
  return null;
}

/** Find a shift type ID by fuzzy name match. */
async function findShiftType(companyId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  const lower = name.toLowerCase().trim();
  for (const st of rows) {
    if (st.name.toLowerCase() === lower || st.name.toLowerCase().includes(lower) || lower.includes(st.name.toLowerCase())) {
      return { id: st.id, name: st.name };
    }
  }
  // Keyword fallback.
  if (lower.includes('night')) {
    const night = rows.find((r: any) => r.name.toLowerCase().includes('night'));
    if (night) return { id: night.id, name: night.name };
  }
  if (lower.includes('day')) {
    const day = rows.find((r: any) => r.name.toLowerCase().includes('day') && !r.name.toLowerCase().includes('night'));
    if (day) return { id: day.id, name: day.name };
  }
  return null;
}

async function findDepartment(companyId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query(
    'SELECT id, name FROM departments WHERE company_id = $1',
    [companyId]
  );
  const lower = name.toLowerCase().trim();
  // Exact match first.
  for (const d of rows) {
    if (d.name.toLowerCase() === lower) return { id: d.id, name: d.name };
  }
  // Substring match only if unambiguous (exactly one candidate).
  const candidates = rows.filter((d: any) =>
    d.name.toLowerCase().includes(lower) || lower.includes(d.name.toLowerCase())
  );
  if (candidates.length === 1) return { id: candidates[0].id, name: candidates[0].name };
  // Ambiguous or no match — return null so the plan fails with "not found"
  // instead of guessing the wrong department.
  return null;
}

async function findMember(companyId: string, name: string): Promise<{ id: string; display: string } | null> {
  return findUser(companyId, name);
}

/**
 * Exclude rotation-generated instances for a user on a date (the "give off"
 * path for rotation days, which have no shift row). Returns the number of
 * rotation instances actually excluded.
 */
async function excludeRotationInstances(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeId: string | null
): Promise<number> {
  const { rows: rotations } = await query(
    `SELECT id, cycle_days AS "cycleDays", start_date::text AS "startDate"
     FROM rotations WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  let excluded = 0;
  for (const rot of rotations) {
    const { rows: assignments } = await query(
      `SELECT ra.cycle_day AS "cycleDay", ra.shift_type_id AS "shiftTypeId"
       FROM rotation_assignments ra
       JOIN users u ON u.id = ra.user_id
       WHERE ra.rotation_id = $1 AND ra.user_id = $2 AND u.is_active = true
         AND (u.end_date IS NULL OR u.end_date::text >= $3)`,
      [rot.id, userId, date]
    );
    if (!assignments.length) continue;
    const startDate = new Date(rot.startDate + 'T00:00:00');
    const target = new Date(date + 'T00:00:00');
    if (isNaN(startDate.getTime()) || isNaN(target.getTime()) || target < startDate) continue;
    const daysSinceStart = Math.floor((target.getTime() - startDate.getTime()) / 86400000);
    const cycleDay = (daysSinceStart % rot.cycleDays) + 1; // 1-indexed, matches schedule.ts
    const matches = assignments.filter(
      (a: any) => a.cycleDay === cycleDay && (!shiftTypeId || a.shiftTypeId === shiftTypeId)
    );
    if (!matches.length) continue;
    // Skip dates inside a pause period (vacation etc.).
    const { rows: pauses } = await query(
      `SELECT 1 FROM rotation_pauses
       WHERE rotation_id = $1 AND start_date::text <= $2 AND end_date::text >= $2 LIMIT 1`,
      [rot.id, date]
    );
    if (pauses.length) continue;
    for (const m of matches) {
      const ins = await query(
        `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
        [companyId, rot.id, userId, date, m.shiftTypeId]
      );
      if (ins.rowCount && ins.rowCount > 0) excluded++;
    }
  }
  return excluded;
}

/** Find one manual shift row for a user on a date, optionally filtered by shift type name. */
async function findShiftRow(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeName?: string
): Promise<{ id: string; shift_type_id: string; date: string; published: boolean; notes: string | null; shift_type_name: string } | null> {
  let stId: string | null = null;
  if (shiftTypeName) {
    const st = await findShiftType(companyId, shiftTypeName);
    if (!st) throw new Error(`Shift type not found: ${shiftTypeName}`);
    stId = st.id;
  }
  const params: any[] = [companyId, userId, date];
  let q = `SELECT s.id, s.shift_type_id, s.date::text AS date, s.published, s.notes, st.name AS shift_type_name
           FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
           WHERE s.company_id = $1 AND s.user_id = $2 AND s.date = $3`;
  if (stId) { q += ' AND s.shift_type_id = $4'; params.push(stId); }
  q += ' ORDER BY s.created_at LIMIT 1';
  const { rows } = await query(q, params);
  return rows[0] ?? null;
}

function noManualShiftMsg(display: string, date: string, shiftTypeName?: string): string {
  return `No shift found for ${display} on ${date}${shiftTypeName ? ` (${shiftTypeName})` : ''}. ` +
    `Only manually-assigned shifts can be swapped — rotation-generated shifts need the scheduler.`;
}

/* ------------------------------------------------------------------ */
/* Calendar sessions (dashboards) — added 2026-10-21 so Email        */
/* Q-Scheduler / the in-app Task agent can add, change and cancel    */
/* sessions with the same semantics as the session REST endpoints    */
/* (per-date overrides, series edits, editor permission rule). The   */
/* exported ops are shared with the quick-session email page.        */
/* ------------------------------------------------------------------ */

async function findDashboard(companyId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query('SELECT id, name FROM dashboards WHERE company_id = $1', [companyId]);
  const lower = name.toLowerCase().trim();
  for (const d of rows) if (d.name.toLowerCase() === lower) return { id: d.id, name: d.name };
  const cands = rows.filter((d: any) => d.name.toLowerCase().includes(lower) || lower.includes(d.name.toLowerCase()));
  if (cands.length === 1) return { id: cands[0].id, name: cands[0].name };
  return null;
}

async function dashboardDeptIdsE(dashboardId: string): Promise<string[]> {
  const { rows } = await query(
    'SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1',
    [dashboardId]
  ).catch(() => ({ rows: [] as any[] }));
  return rows.map((r: any) => r.department_id);
}

/** Mirror of the routes' cleanKind: label/key match, else 'session'. */
async function resolveKindKey(companyId: string, dashboardId: string, label?: string): Promise<string> {
  if (!label) return 'session';
  const key = label.trim().toLowerCase();
  if (!key) return 'session';
  const { rows } = await query('SELECT key, label FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2', [companyId, dashboardId]);
  for (const k of rows) if (k.key === key || String(k.label).toLowerCase() === key) return k.key;
  for (const k of rows) if (String(k.label).toLowerCase().includes(key) || key.includes(String(k.label).toLowerCase())) return k.key;
  return 'session';
}

/** Permission mirror of the routes' sessionEditCheck, for plan execution. */
async function canEditSessionTarget(
  companyId: string, createdBy: string | null, dashboardId: string | null, departmentId: string | null
): Promise<boolean> {
  if (!createdBy) return true; // email approve link: the token is the auth
  const { rows } = await query('SELECT role FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [createdBy, companyId]);
  const role = rows[0]?.role;
  if (role === 'owner') return true;
  if (role !== 'scheduler') return false;
  if (dashboardId) {
    const { rows: ed } = await query('SELECT user_id FROM dashboard_editors WHERE dashboard_id = $1', [dashboardId]);
    if (ed.length) return ed.some((r: any) => r.user_id === createdBy);
  }
  if (!departmentId) return false;
  const access = await getDepartmentAccess(createdBy, companyId);
  return access.edit.includes(departmentId);
}

function toDateStr(v: any): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Does this session row occur on the given date? (Preference check for
 *  targeting one series among same-title sessions; monthly/yearly are
 *  trusted rather than re-derived.) */
function sessionOccursOn(s: any, date: string): boolean {
  const start = toDateStr(s.session_date);
  if (!start || date < start) return false;
  if (s.recur_until && date > toDateStr(s.recur_until)) return false;
  const rule = s.recur_rule || 'none';
  if (rule === 'none') return date === start;
  const a = new Date(start + 'T00:00:00');
  const b = new Date(date + 'T00:00:00');
  const diffDays = Math.round((b.getTime() - a.getTime()) / 86400000);
  const interval = s.recur_interval || (rule === 'biweekly' ? 2 : 1);
  if (rule === 'daily') return diffDays % interval === 0;
  if (rule === 'weekly' || rule === 'biweekly') {
    const days = s.recur_days ? String(s.recur_days).split(',').map((x: string) => parseInt(x, 10)) : [a.getDay()];
    return days.includes(b.getDay()) && Math.floor(diffDays / 7) % interval === 0;
  }
  return true;
}

async function findSessionRow(companyId: string, dashboardId: string, title: string, dateHint?: string): Promise<any | null> {
  const { rows } = await query('SELECT * FROM academic_sessions WHERE company_id = $1 AND dashboard_id = $2', [companyId, dashboardId]);
  const lower = title.toLowerCase().trim();
  const exact = rows.filter((r: any) => String(r.title).toLowerCase() === lower);
  let cands = exact.length ? exact : rows.filter((r: any) => String(r.title).toLowerCase().includes(lower) || lower.includes(String(r.title).toLowerCase()));
  if (!cands.length) return null;
  if (dateHint) {
    const onDate = cands.filter((r: any) => sessionOccursOn(r, dateHint));
    if (onDate.length) cands = onDate;
  }
  cands.sort((x: any, y: any) => toDateStr(x.session_date).localeCompare(toDateStr(y.session_date)));
  return cands[0];
}

/** Mirror of the routes' upsertOverride. */
async function upsertOverrideE(companyId: string, sessionId: string, date: string, fields: Record<string, any>): Promise<void> {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const insertCols = ['company_id', 'session_id', 'date', ...cols];
  const values = [companyId, sessionId, date, ...cols.map((c) => fields[c])];
  const placeholders = insertCols.map((_, i) => '$' + (i + 1)).join(', ');
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await query(
    `INSERT INTO academic_session_overrides (${insertCols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (session_id, date) DO UPDATE SET ${updates}, updated_at = now()`,
    values
  );
}

async function getOverrideE(sessionId: string, date: string): Promise<any | null> {
  const { rows } = await query('SELECT * FROM academic_session_overrides WHERE session_id = $1 AND date = $2', [sessionId, date]);
  return rows[0] || null;
}

export interface SessionFields {
  title?: string;
  date?: string;
  startTime?: string | null;
  endTime?: string | null;
  presenterId?: string | null;
  supervisorId?: string | null;
  location?: string | null;
  kindKey?: string;
  departmentId?: string | null;
  notes?: string | null;
  meetingUrl?: string | null;
  recurRule?: string;
  recurInterval?: number;
  recurUntil?: string | null;
  recurCount?: number | null;
  recurDays?: number[];
}

/** Mirror of POST /academic-sessions. Returns the new session id. */
export async function insertSession(
  companyId: string, createdBy: string | null, dashboardId: string, f: SessionFields & { title: string; date: string }
): Promise<string> {
  const id = crypto.randomUUID();
  const rule = f.recurRule || 'none';
  await query(
    `INSERT INTO academic_sessions (id, company_id, title, lecturer_user_id, department_id, session_date, start_time, end_time, location, kind, notes, created_by, dashboard_id, recur_rule, recur_until, supervisor_user_id, recur_days, recur_interval, recur_count, meeting_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [id, companyId, f.title, f.presenterId ?? null, f.departmentId ?? null,
     f.date, f.startTime ?? null, f.endTime ?? null, f.location ?? null,
     f.kindKey || 'session', f.notes ?? null, createdBy, dashboardId, rule, rule !== 'none' ? (f.recurUntil ?? null) : null,
     f.supervisorId ?? null,
     rule === 'weekly' && f.recurDays && f.recurDays.length ? f.recurDays.join(',') : null,
     f.recurInterval || 1, f.recurCount ?? null, f.meetingUrl ?? null]
  );
  return id;
}

/** Series-level update: only the provided fields change. */
export async function updateSessionSeries(companyId: string, s: any, f: SessionFields): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  const set = (col: string, v: any) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (f.title !== undefined) set('title', f.title);
  if (f.date !== undefined) set('session_date', f.date);
  if (f.startTime !== undefined) set('start_time', f.startTime);
  if (f.endTime !== undefined) set('end_time', f.endTime);
  if (f.presenterId !== undefined) set('lecturer_user_id', f.presenterId);
  if (f.supervisorId !== undefined) set('supervisor_user_id', f.supervisorId);
  if (f.location !== undefined) set('location', f.location);
  if (f.kindKey !== undefined) set('kind', f.kindKey);
  if (f.departmentId !== undefined) set('department_id', f.departmentId);
  if (f.notes !== undefined) set('notes', f.notes);
  if (f.meetingUrl !== undefined) set('meeting_url', f.meetingUrl);
  if (!sets.length) return;
  vals.push(s.id, companyId);
  await query(`UPDATE academic_sessions SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND company_id = $${vals.length}`, vals);
}

/** One-date update via override. Returns names of fields a one-date
 *  change cannot carry (name / type / notes), for the result message. */
export async function updateSessionDate(companyId: string, s: any, date: string, f: SessionFields): Promise<string[]> {
  const fields: Record<string, any> = { cancelled: false };
  const skipped: string[] = [];
  if (f.presenterId !== undefined) { fields.has_lecturer = true; fields.lecturer_user_id = f.presenterId; }
  if (f.supervisorId !== undefined) { fields.has_supervisor = true; fields.supervisor_user_id = f.supervisorId; }
  if (f.location !== undefined) { fields.has_location = true; fields.location = f.location; }
  if (f.meetingUrl !== undefined) { fields.has_meeting_url = true; fields.meeting_url = f.meetingUrl; }
  if (f.startTime !== undefined || f.endTime !== undefined) {
    fields.has_times = true;
    fields.start_time = f.startTime !== undefined ? f.startTime : s.start_time;
    fields.end_time = f.endTime !== undefined ? f.endTime : s.end_time;
  }
  if (f.title !== undefined) skipped.push('the name');
  if (f.kindKey !== undefined) skipped.push('the session type');
  if (f.notes !== undefined) skipped.push('notes');
  await upsertOverrideE(companyId, s.id, date, fields);
  return skipped;
}

export async function cancelSessionDate(companyId: string, sessionId: string, date: string): Promise<void> {
  await upsertOverrideE(companyId, sessionId, date, { cancelled: true });
}

export async function deleteSessionRow(companyId: string, sessionId: string): Promise<void> {
  await query('DELETE FROM academic_sessions WHERE id = $1 AND company_id = $2', [sessionId, companyId]);
}

/** Move ONE date of a recurring series: cancel that date and create a
 *  one-off copy on the new date with the date's effective details. */
export async function moveSessionDate(
  companyId: string, createdBy: string | null, s: any, fromDate: string, toDate: string, f: SessionFields
): Promise<void> {
  const ov = await getOverrideE(s.id, fromDate);
  const eff: SessionFields & { title: string; date: string } = {
    title: f.title !== undefined ? f.title : s.title,
    date: toDate,
    presenterId: f.presenterId !== undefined ? f.presenterId : (ov && ov.has_lecturer ? ov.lecturer_user_id : s.lecturer_user_id),
    supervisorId: f.supervisorId !== undefined ? f.supervisorId : (ov && ov.has_supervisor ? ov.supervisor_user_id : s.supervisor_user_id),
    location: f.location !== undefined ? f.location : (ov && ov.has_location ? ov.location : s.location),
    startTime: f.startTime !== undefined ? f.startTime : (ov && ov.has_times ? ov.start_time : s.start_time),
    endTime: f.endTime !== undefined ? f.endTime : (ov && ov.has_times ? ov.end_time : s.end_time),
    meetingUrl: f.meetingUrl !== undefined ? f.meetingUrl : (ov && ov.has_meeting_url ? ov.meeting_url : s.meeting_url),
    kindKey: f.kindKey !== undefined ? f.kindKey : s.kind,
    departmentId: s.department_id,
    notes: f.notes !== undefined ? f.notes : s.notes,
    recurRule: 'none',
  };
  await cancelSessionDate(companyId, s.id, fromDate);
  await insertSession(companyId, createdBy, s.dashboard_id, eff);
}

function normTime(v?: string): string | null {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return String(v).trim() || null;
  return m[1].padStart(2, '0') + ':' + m[2];
}

function cleanRecurE(change: PlanChange): { recurRule: string; recurInterval: number; recurUntil: string | null } {
  let rule = ['daily', 'weekly', 'monthly', 'monthly-weekday', 'yearly'].includes(String(change.recurRule || ''))
    ? String(change.recurRule) : 'none';
  let interval = Math.floor(Number(change.recurInterval) || 1);
  if (interval < 1) interval = 1;
  if (interval > 52) interval = 52;
  return { recurRule: rule, recurInterval: rule === 'none' ? 1 : interval, recurUntil: rule !== 'none' ? (change.recurUntil || null) : null };
}

/** Execute a plan's changes. Returns per-change results. */
export async function executePlan(
  companyId: string,
  plan: { changes: PlanChange[] },
  executedBy: string
): Promise<ExecuteResult[]> {
  const results: ExecuteResult[] = [];
  // created_by is a uuid FK — only use executedBy when it's actually a user id.
  const createdBy = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executedBy)
    ? executedBy
    : null;
  // Notifications pre-pass: remember who presents/supervises sessions
  // that are about to be updated or cancelled (the change itself may
  // remove exactly the people who should hear about it).
  const sessionPeopleBefore = new Map<number, string[]>();
  for (let i = 0; i < (plan.changes || []).length; i++) {
    const change = plan.changes[i];
    if ((change.action === 'update_session' || change.action === 'cancel_session') && change.dashboard && change.sessionTitle) {
      try {
        const dash = await findDashboard(companyId, change.dashboard);
        if (dash) {
          const sess = await findSessionRow(companyId, dash.id, change.sessionTitle, change.newDate || change.date);
          if (sess) {
            let pres = sess.lecturer_user_id || null;
            let sup = sess.supervisor_user_id || null;
            if (change.date) {
              const { rows: ov } = await query(
                'SELECT lecturer_user_id, supervisor_user_id FROM academic_session_overrides WHERE session_id = $1 AND occ_date = $2',
                [sess.id, change.date]
              );
              if (ov.length) { pres = ov[0].lecturer_user_id ?? pres; sup = ov[0].supervisor_user_id ?? sup; }
            }
            sessionPeopleBefore.set(i, [...new Set([pres, sup].filter(Boolean))] as string[]);
          }
        }
      } catch { /* best-effort */ }
    }
  }
  for (const change of plan.changes || []) {
    try {
      if (change.action === 'assign' && change.person && change.date && change.shiftType) {
        const user = await findUser(companyId, change.person);
        const st = await findShiftType(companyId, change.shiftType);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        const inserted = await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           ON CONFLICT DO NOTHING`,
          [uuidv4(), companyId, user.id, st.id, change.date, createdBy]
        );
        if (inserted.rowCount === 0) {
          results.push({ action: 'assign', success: true, message: `Already on ${st.name} on ${change.date} — no change needed` });
        } else {
          results.push({ action: 'assign', success: true, message: `Assigned ${user.display} to ${st.name} on ${change.date}` });
        }
      } else if (change.action === 'assign_recurring' && change.person && change.shiftType && change.startDate && change.intervalWeeks && change.untilDate) {
        // One recurring change expands here, in code — Gemini only describes
        // the pattern, it never does the calendar math.
        const { expandRecurring } = await import('./planHelpers.js');
        const user = await findUser(companyId, change.person);
        const st = await findShiftType(companyId, change.shiftType);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const dates = expandRecurring(change.startDate, change.intervalWeeks, !!change.weekendsOff, change.untilDate);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        let added = 0;
        for (const d of dates) {
          const inserted = await query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
             VALUES ($1, $2, $3, $4, $5, true, $6)
             ON CONFLICT DO NOTHING`,
            [uuidv4(), companyId, user.id, st.id, d, createdBy]
          );
          if ((inserted as any).rowCount) added++;
        }
        results.push({ action: 'assign_recurring', success: true, message: `Assigned ${user.display} to ${st.name} every ${change.intervalWeeks} weeks from ${change.startDate}${change.weekendsOff ? ' (weekdays only)' : ''} until ${change.untilDate} (${added} new, ${dates.length - added} already on)` });
      } else if (change.action === 'swap' && change.fromPerson && change.toPerson) {
        // Swap exchanges two people's shifts. Same-day swap uses `date`;
        // cross-date swap uses fromDate/toDate. Runs in one transaction so a
        // half-applied swap is impossible.
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        if (!fromUser) throw new Error(`Person not found: ${change.fromPerson}`);
        if (!toUser) throw new Error(`Person not found: ${change.toPerson}`);
        const fromDate = change.fromDate || change.date;
        const toDate = change.toDate || change.date;
        if (!fromDate || !toDate) throw new Error('Swap needs a date (or fromDate/toDate).');
        const fromShift = await findShiftRow(companyId, fromUser.id, fromDate, change.shiftType);
        if (!fromShift) throw new Error(noManualShiftMsg(fromUser.display, fromDate, change.shiftType));
        const toShift = await findShiftRow(companyId, toUser.id, toDate, change.shiftType);
        const { withTransaction } = await import('../db.js');
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        if (!toShift) {
          // toPerson has no shift on that date: treat as a move of fromPerson's shift.
          await withTransaction(async (tx) => {
            const del = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [fromShift.id, companyId]);
            if (del.rowCount === 0) throw new Error(`Could not remove ${fromUser.display}'s shift on ${fromDate} — it may have changed.`);
            const ins = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [uuidv4(), companyId, toUser.id, fromShift.shift_type_id, toDate, fromShift.notes, fromShift.published, createdBy]
            );
            if (ins.rowCount === 0) throw new Error(`${toUser.display} is already on ${fromShift.shift_type_name} on ${toDate} — no change made.`);
          });
          results.push({ action: 'swap', success: true, message: `Moved ${fromUser.display}'s ${fromShift.shift_type_name} on ${fromDate} to ${toUser.display} on ${toDate} (${toUser.display} had no shift to swap)` });
        } else {
          // Exchange the two assignments: delete both rows, re-insert with
          // swapped people (avoids UNIQUE conflicts on same-type same-day swaps).
          await withTransaction(async (tx) => {
            const del1 = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [fromShift.id, companyId]);
            if (del1.rowCount === 0) throw new Error(`Could not remove ${fromUser.display}'s shift on ${fromDate} — it may have changed.`);
            const del2 = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [toShift.id, companyId]);
            if (del2.rowCount === 0) throw new Error(`Could not remove ${toUser.display}'s shift on ${toDate} — it may have changed.`);
            const ins1 = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [uuidv4(), companyId, toUser.id, fromShift.shift_type_id, fromDate, fromShift.notes, fromShift.published, createdBy]
            );
            if (ins1.rowCount === 0) throw new Error(`Could not place ${toUser.display} on ${fromShift.shift_type_name} on ${fromDate} — conflicting shift exists.`);
            const ins2 = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [uuidv4(), companyId, fromUser.id, toShift.shift_type_id, toDate, toShift.notes, toShift.published, createdBy]
            );
            if (ins2.rowCount === 0) throw new Error(`Could not place ${fromUser.display} on ${toShift.shift_type_name} on ${toDate} — conflicting shift exists.`);
          });
          const sameDay = fromDate === toDate;
          results.push({
            action: 'swap', success: true,
            message: sameDay
              ? `Swapped ${fromUser.display} (${fromShift.shift_type_name}) ↔ ${toUser.display} (${toShift.shift_type_name}) on ${fromDate}`
              : `Swapped ${fromUser.display}'s ${fromShift.shift_type_name} on ${fromDate} ↔ ${toUser.display}'s ${toShift.shift_type_name} on ${toDate}`,
          });
        }
      } else if (change.action === 'unassign' && change.person && change.date) {
        const user = await findUser(companyId, change.person);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        let q = 'DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3';
        const params: any[] = [companyId, user.id, change.date];
        let shiftTypeId: string | null = null;
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { q += ' AND shift_type_id = $4'; params.push(st.id); shiftTypeId = st.id; }
        }
        const deleted = await query(q, params);
        if (deleted.rowCount === 0) {
          // No direct shift row — the visible entry is rotation-generated, so
          // exclude the rotation instance(s) for that date instead.
          const excluded = await excludeRotationInstances(companyId, user.id, change.date, shiftTypeId);
          if (excluded > 0) {
            results.push({
              action: 'unassign', success: true,
              message: `Removed ${user.display} from ${change.date} (rotation day)`,
            });
          } else {
            results.push({
              action: 'unassign', success: false,
              message: `No shift found for ${user.display} on ${change.date} to remove.`,
            });
          }
        } else {
          results.push({ action: 'unassign', success: true, message: `Removed ${user.display} from ${change.date}` });
        }
      } else if (change.action === 'move' && change.fromPerson && change.toPerson && change.date) {
        // Move = unassign fromPerson + assign toPerson (same shift type).
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        if (!fromUser) throw new Error(`Person not found: ${change.fromPerson}`);
        if (!toUser) throw new Error(`Person not found: ${change.toPerson}`);
        // Find the shift to move.
        let shiftQ = 'SELECT shift_type_id FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 LIMIT 1';
        const shiftParams: any[] = [companyId, fromUser.id, change.date];
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { shiftQ = 'SELECT shift_type_id FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 LIMIT 1'; shiftParams.push(st.id); }
        }
        const { rows: srows } = await query(shiftQ, shiftParams);
        if (!srows.length) throw new Error(`No shift found for ${fromUser.display} on ${change.date}. Only manually-assigned shifts can be moved — rotation-generated shifts need the scheduler.`);
        const shiftTypeId = srows[0].shift_type_id;
        await query('DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4',
          [companyId, fromUser.id, change.date, shiftTypeId]);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT DO NOTHING`,
          [uuidv4(), companyId, toUser.id, shiftTypeId, change.date, createdBy]
        );
        results.push({ action: 'move', success: true, message: `Moved ${fromUser.display} → ${toUser.display} on ${change.date}` });
      } else if (change.action === 'add_job_role' && change.jobRoleName && change.department) {
        const { rows: depts } = await query(
          'SELECT id, name FROM departments WHERE company_id = $1',
          [companyId]
        );
        const deptLower = change.department.toLowerCase().trim();
        const dept = depts.find((d: any) =>
          d.name.toLowerCase() === deptLower ||
          d.name.toLowerCase().includes(deptLower) ||
          deptLower.includes(d.name.toLowerCase())
        );
        if (!dept) throw new Error(`Department not found: ${change.department}`);
        const { rows: existing } = await query(
          'SELECT id FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
          [companyId, dept.id, change.jobRoleName.trim()]
        );
        if (existing.length) {
          results.push({ action: 'add_job_role', success: true, message: `Job role "${change.jobRoleName}" already exists in ${dept.name} — no change needed` });
        } else {
          const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
          await query(
            'INSERT INTO job_roles (id, company_id, department_id, name) VALUES ($1, $2, $3, $4)',
            [uuidv4(), companyId, dept.id, change.jobRoleName.trim()]
          );
          results.push({ action: 'add_job_role', success: true, message: `Added job role "${change.jobRoleName}" to ${dept.name}` });
        }
      } else if (change.action === 'delete_job_role' && change.jobRoleName && change.department) {
        const dept = await findDepartment(companyId, change.department);
        if (!dept) throw new Error(`Department not found: ${change.department}`);
        const { rows: roleRows } = await query(
          'SELECT id FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
          [companyId, dept.id, change.jobRoleName.trim()]
        );
        if (!roleRows.length) throw new Error(`Job role not found: ${change.jobRoleName}`);
        const roleId = roleRows[0].id;
        // Clear the role from team members and shift-type eligibility, then delete.
        await query('UPDATE users SET job_role_id = NULL WHERE company_id = $1 AND job_role_id = $2', [companyId, roleId]);
        await query(
          `UPDATE shift_types SET eligible_job_role_ids = array_remove(eligible_job_role_ids, $2)
           WHERE company_id = $1 AND $2 = ANY(eligible_job_role_ids)`,
          [companyId, roleId]
        );
        await query('DELETE FROM job_roles WHERE id = $1 AND company_id = $2', [roleId, companyId]);
        results.push({ action: 'delete_job_role', success: true, message: `Deleted job role "${change.jobRoleName}" from ${dept.name}` });
      } else if (change.action === 'rename_job_role' && change.jobRoleName && change.newJobRoleName && change.department) {
        const dept = await findDepartment(companyId, change.department);
        if (!dept) throw new Error(`Department not found: ${change.department}`);
        const { rows } = await query(
          'UPDATE job_roles SET name = $1 WHERE company_id = $2 AND department_id = $3 AND lower(name) = lower($4) RETURNING id',
          [change.newJobRoleName.trim(), companyId, dept.id, change.jobRoleName.trim()]
        );
        if (!rows.length) throw new Error(`Job role not found: ${change.jobRoleName}`);
        results.push({ action: 'rename_job_role', success: true, message: `Renamed job role "${change.jobRoleName}" → "${change.newJobRoleName}" in ${dept.name}` });
      } else if (change.action === 'add_department' && change.department) {
        const { rows: existing } = await query(
          'SELECT id FROM departments WHERE company_id = $1 AND lower(name) = lower($2)',
          [companyId, change.department.trim()]
        );
        if (existing.length) {
          results.push({ action: 'add_department', success: true, message: `Department "${change.department}" already exists — no change needed` });
        } else {
          const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
          await query(
            'INSERT INTO departments (id, company_id, name) VALUES ($1, $2, $3)',
            [uuidv4(), companyId, change.department.trim()]
          );
          results.push({ action: 'add_department', success: true, message: `Added department "${change.department}"` });
        }
      } else if (change.action === 'rename_department' && change.department && change.newDepartment) {
        const dept = await findDepartment(companyId, change.department);
        if (!dept) throw new Error(`Department not found: ${change.department}`);
        await query(
          'UPDATE departments SET name = $1 WHERE id = $2',
          [change.newDepartment.trim(), dept.id]
        );
        results.push({ action: 'rename_department', success: true, message: `Renamed department "${change.department}" → "${change.newDepartment}"` });
      } else if (change.action === 'add_team_member' && change.firstName && change.lastName) {
        let deptId: string | null = null;
        if (change.department) {
          const dept = await findDepartment(companyId, change.department);
          if (!dept) throw new Error(`Department not found: ${change.department}`);
          deptId = dept.id;
        }
        let roleId: string | null = null;
        if (change.jobRoleName && deptId) {
          const { rows } = await query(
            'SELECT id FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
            [companyId, deptId, change.jobRoleName.trim()]
          );
          if (rows.length) roleId = rows[0].id;
        }
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        const memberId = uuidv4();
        await query(
          `INSERT INTO users (id, company_id, first_name, last_name, email, department_id, job_role_id, role, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'employee', true)`,
          [memberId, companyId, change.firstName.trim(), change.lastName.trim(),
           change.email ? change.email.trim() : null, deptId, roleId]
        );
        results.push({ action: 'add_team_member', success: true, message: `Added team member ${change.firstName} ${change.lastName}${change.department ? ` to ${change.department}` : ''}` });
      } else if (change.action === 'update_team_member' && change.person) {
        const member = await findMember(companyId, change.person);
        if (!member) throw new Error(`Team member not found: ${change.person}`);
        const updates: string[] = [];
        const params: any[] = [];
        let pi = 1;
        if (change.department) {
          const dept = await findDepartment(companyId, change.department);
          if (!dept) throw new Error(`Department not found: ${change.department}`);
          updates.push(`department_id = $${pi++}`); params.push(dept.id);
        }
        if (change.jobRoleName) {
          const { rows } = await query(
            'SELECT id, department_id FROM job_roles WHERE company_id = $1 AND lower(name) = lower($2)',
            [companyId, change.jobRoleName.trim()]
          );
          if (!rows.length) throw new Error(`Job role not found: ${change.jobRoleName}`);
          updates.push(`job_role_id = $${pi++}`); params.push(rows[0].id);
        }
        if (!updates.length) throw new Error('No updates specified for team member');
        params.push(member.id);
        await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${pi}`, params);
        results.push({ action: 'update_team_member', success: true, message: `Updated ${member.display}` });
      } else if (change.action === 'add_shift_type' && change.shiftType && change.department) {
        const dept = await findDepartment(companyId, change.department);
        if (!dept) throw new Error(`Department not found: ${change.department}`);
        const { rows: existing } = await query(
          'SELECT id FROM shift_types WHERE company_id = $1 AND lower(name) = lower($2)',
          [companyId, change.shiftType.trim()]
        );
        if (existing.length) {
          results.push({ action: 'add_shift_type', success: true, message: `Shift type "${change.shiftType}" already exists — no change needed` });
        } else {
          const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
          const stId = uuidv4();
          await query(
            `INSERT INTO shift_types (id, company_id, name, color, department_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [stId, companyId, change.shiftType.trim(), '#3b82f6', dept.id]
          );
          await query(
            'INSERT INTO shift_type_departments (shift_type_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [stId, dept.id]
          );
          results.push({ action: 'add_shift_type', success: true, message: `Added shift type "${change.shiftType}" to ${dept.name}` });
        }
      } else if (change.action === 'rename_shift_type' && change.shiftType && change.newShiftType) {
        const st = await findShiftType(companyId, change.shiftType);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        await query('UPDATE shift_types SET name = $1 WHERE id = $2', [change.newShiftType.trim(), st.id]);
        results.push({ action: 'rename_shift_type', success: true, message: `Renamed shift type "${change.shiftType}" → "${change.newShiftType}"` });
      } else if (change.action === 'set_staffing_target' && change.shiftType && change.targetCount !== undefined) {
        const st = await findShiftType(companyId, change.shiftType);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const count = Math.min(20, Math.max(0, Math.round(change.targetCount)));
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        await query(
          `INSERT INTO staffing_targets (id, company_id, shift_type_id, target_count, weekdays)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (company_id, shift_type_id)
           DO UPDATE SET target_count = $4`,
          [uuidv4(), companyId, st.id, count, [0,1,2,3,4,5,6]]
        );
        results.push({ action: 'set_staffing_target', success: true, message: `Set staffing target for "${change.shiftType}" to ${count} per day` });
      } else if ((change.action === 'bulk_publish' || change.action === 'bulk_unpublish') && change.fromDate && change.toDate) {
        const publish = change.action === 'bulk_publish';
        let shiftTypeId: string | null = null;
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
          shiftTypeId = st.id;
        }
        let q = `UPDATE shifts SET published = $1 WHERE company_id = $2 AND date >= $3 AND date <= $4`;
        const params: any[] = [publish, companyId, change.fromDate, change.toDate];
        if (shiftTypeId) { q += ` AND shift_type_id = $5`; params.push(shiftTypeId); }
        const updated = await query(q, params);
        const count = updated.rowCount || 0;
        results.push({
          action: change.action, success: true,
          message: `${publish ? 'Published' : 'Moved to draft'} ${count} shift(s) from ${change.fromDate} to ${change.toDate}${shiftTypeId ? ` (${change.shiftType})` : ''}`
        });
      } else if (change.action === 'add_session' && change.dashboard && change.title && change.date) {
        const dash = await findDashboard(companyId, change.dashboard);
        if (!dash) throw new Error(`Dashboard not found: ${change.dashboard}`);
        let deptId: string | null = null;
        if (change.department) {
          const dept = await findDepartment(companyId, change.department);
          if (!dept) throw new Error(`Department not found: ${change.department}`);
          deptId = dept.id;
        } else {
          const dd = await dashboardDeptIdsE(dash.id);
          if (dd.length === 1) deptId = dd[0];
        }
        const presenter = change.presenter ? await findUser(companyId, change.presenter) : null;
        if (change.presenter && !presenter) throw new Error(`Person not found: ${change.presenter}`);
        const supervisor = change.supervisor ? await findUser(companyId, change.supervisor) : null;
        if (change.supervisor && !supervisor) throw new Error(`Person not found: ${change.supervisor}`);
        if (!(await canEditSessionTarget(companyId, createdBy, dash.id, deptId))) {
          throw new Error(`No edit access to sessions on ${dash.name}.`);
        }
        const kindKey = await resolveKindKey(companyId, dash.id, change.sessionType);
        const rec = cleanRecurE(change);
        let actorId = createdBy;
        if (!actorId) {
          const { rows: ow } = await query("SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true LIMIT 1", [companyId]);
          actorId = ow[0]?.id ?? null;
        }
        await insertSession(companyId, actorId, dash.id, {
          title: change.title, date: change.date,
          startTime: normTime(change.startTime), endTime: normTime(change.endTime),
          presenterId: presenter?.id ?? null, supervisorId: supervisor?.id ?? null,
          location: change.location ? change.location.trim() : null,
          kindKey, departmentId: deptId, notes: change.notes ? change.notes.trim() : null,
          recurRule: rec.recurRule, recurInterval: rec.recurInterval, recurUntil: rec.recurUntil,
        });
        results.push({
          action: 'add_session', success: true,
          message: `Added "${change.title}" to ${dash.name} on ${change.date}` +
            (change.startTime ? ` at ${normTime(change.startTime)}` : '') +
            (presenter ? `, presenter ${presenter.display}` : '') +
            (rec.recurRule !== 'none' ? `, repeating ${rec.recurRule}${rec.recurInterval > 1 ? ` every ${rec.recurInterval}` : ''}` : ''),
        });
      } else if (change.action === 'update_session' && change.dashboard && change.sessionTitle) {
        const dash = await findDashboard(companyId, change.dashboard);
        if (!dash) throw new Error(`Dashboard not found: ${change.dashboard}`);
        const sess = await findSessionRow(companyId, dash.id, change.sessionTitle, change.newDate || change.date);
        if (!sess) throw new Error(`Session not found on ${dash.name}: "${change.sessionTitle}"`);
        if (!(await canEditSessionTarget(companyId, createdBy, dash.id, sess.department_id))) {
          throw new Error(`No edit access to sessions on ${dash.name}.`);
        }
        const f: SessionFields = {};
        if (change.title !== undefined && change.title !== sess.title) f.title = change.title;
        if (change.presenter !== undefined) {
          const p = change.presenter ? await findUser(companyId, change.presenter) : null;
          if (change.presenter && !p) throw new Error(`Person not found: ${change.presenter}`);
          f.presenterId = p?.id ?? null;
        }
        if (change.supervisor !== undefined) {
          const sv = change.supervisor ? await findUser(companyId, change.supervisor) : null;
          if (change.supervisor && !sv) throw new Error(`Person not found: ${change.supervisor}`);
          f.supervisorId = sv?.id ?? null;
        }
        if (change.location !== undefined) f.location = change.location ? change.location.trim() : null;
        if (change.startTime !== undefined) f.startTime = normTime(change.startTime);
        if (change.endTime !== undefined) f.endTime = normTime(change.endTime);
        if (change.sessionType !== undefined) f.kindKey = await resolveKindKey(companyId, dash.id, change.sessionType);
        if (change.notes !== undefined) f.notes = change.notes ? change.notes.trim() : null;
        const recurring = !!(sess.recur_rule && sess.recur_rule !== 'none');
        const scope: 'date' | 'series' = change.scope === 'series' ? 'series'
          : change.scope === 'date' ? 'date'
          : (recurring && change.date ? 'date' : 'series');
        let actorId = createdBy;
        if (!actorId) {
          const { rows: ow } = await query("SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true LIMIT 1", [companyId]);
          actorId = ow[0]?.id ?? null;
        }
        if (change.newDate) {
          if (!recurring || scope === 'series') {
            await updateSessionSeries(companyId, sess, { ...f, date: change.newDate });
            results.push({ action: 'update_session', success: true, message: `Moved "${sess.title}" on ${dash.name} to ${change.newDate}` });
          } else {
            if (!change.date) throw new Error('A date is needed to move just one date of a repeating session.');
            await moveSessionDate(companyId, actorId, sess, change.date, change.newDate, f);
            results.push({ action: 'update_session', success: true, message: `Moved "${sess.title}" on ${dash.name} from ${change.date} to ${change.newDate} (just that date)` });
          }
        } else if (scope === 'date' && recurring) {
          if (!change.date) throw new Error('A date is needed to change just one date of a repeating session.');
          const skipped = await updateSessionDate(companyId, sess, change.date, f);
          results.push({
            action: 'update_session', success: true,
            message: `Updated "${sess.title}" on ${dash.name} for ${change.date} (just this date)` +
              (skipped.length ? `. Note: ${skipped.join(' and ')} can only change for the whole series, so ${skipped.length > 1 ? 'those were' : 'that was'} left as-is.` : ''),
          });
        } else {
          await updateSessionSeries(companyId, sess, f);
          results.push({ action: 'update_session', success: true, message: `Updated "${sess.title}" on ${dash.name}${recurring ? ' (whole series)' : ''}` });
        }
      } else if (change.action === 'cancel_session' && change.dashboard && change.sessionTitle) {
        const dash = await findDashboard(companyId, change.dashboard);
        if (!dash) throw new Error(`Dashboard not found: ${change.dashboard}`);
        const sess = await findSessionRow(companyId, dash.id, change.sessionTitle, change.date);
        if (!sess) throw new Error(`Session not found on ${dash.name}: "${change.sessionTitle}"`);
        if (!(await canEditSessionTarget(companyId, createdBy, dash.id, sess.department_id))) {
          throw new Error(`No edit access to sessions on ${dash.name}.`);
        }
        const recurring = !!(sess.recur_rule && sess.recur_rule !== 'none');
        const scope: 'date' | 'series' = change.scope === 'series' ? 'series'
          : change.scope === 'date' ? 'date'
          : (recurring && change.date ? 'date' : 'series');
        if (scope === 'date' && recurring) {
          if (!change.date) throw new Error('A date is needed to cancel just one date of a repeating session.');
          await cancelSessionDate(companyId, sess.id, change.date);
          results.push({ action: 'cancel_session', success: true, message: `Cancelled "${sess.title}" on ${dash.name} for ${change.date} (just this date)` });
        } else {
          await deleteSessionRow(companyId, sess.id);
          results.push({ action: 'cancel_session', success: true, message: `Cancelled "${sess.title}" on ${dash.name}${recurring ? ' (whole series)' : ''}` });
        }
      } else {
        results.push({ action: change.action, success: false, message: `Unsupported or incomplete change: ${JSON.stringify(change)}` });
      }
    } catch (err: any) {
      results.push({ action: change.action, success: false, message: err?.message || 'Failed' });
    }
  }
  // Notifications (Phase 1): tell people what this approved plan changed
  // for them. Best-effort — a notification failure never fails the plan.
  try {
    const { notify, fmtDateLong } = await import('./notify.js');
    for (let i = 0; i < (plan.changes || []).length; i++) {
      const change = plan.changes[i];
      const result = results[i];
      if (!result || !result.success) continue;
      if (change.action === 'assign' && change.person && change.date && change.shiftType) {
        if (/^Already on/.test(result.message)) continue;
        const user = await findUser(companyId, change.person);
        if (user) await notify({
          companyId, userIds: [user.id], category: 'schedule', type: 'shift_assigned',
          title: `New shift: ${change.shiftType} on ${fmtDateLong(change.date)}`,
          body: `You were assigned ${change.shiftType} on ${fmtDateLong(change.date)}.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${user.id}`,
          bundleTitle: 'You were assigned {count} new shifts', excludeUserId: createdBy,
        });
      } else if (change.action === 'assign_recurring' && change.person && change.startDate) {
        const user = await findUser(companyId, change.person);
        if (user) await notify({
          companyId, userIds: [user.id], category: 'schedule', type: 'shift_assigned',
          title: `New recurring shifts: ${change.shiftType} from ${fmtDateLong(change.startDate)}`,
          body: `You were assigned ${change.shiftType} every ${change.intervalWeeks} weeks from ${fmtDateLong(change.startDate)} until ${change.untilDate ? fmtDateLong(change.untilDate) : 'further notice'}.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${user.id}`,
          bundleTitle: 'You were assigned {count} new shifts', excludeUserId: createdBy,
        });
      } else if (change.action === 'unassign' && change.person && change.date) {
        if (!/^Removed/.test(result.message)) continue;
        const user = await findUser(companyId, change.person);
        if (user) await notify({
          companyId, userIds: [user.id], category: 'schedule', type: 'shift_removed',
          title: `Shift removed${change.shiftType ? `: ${change.shiftType}` : ''} on ${fmtDateLong(change.date)}`,
          body: `Your shift on ${fmtDateLong(change.date)} was removed.`,
          link: 'my-schedule', bundleKey: `shift_removed:${user.id}`,
          bundleTitle: '{count} of your shifts were removed', excludeUserId: createdBy,
        });
      } else if (change.action === 'move' && change.fromPerson && change.toPerson && change.date) {
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        const stName = change.shiftType || 'Shift';
        if (fromUser) await notify({
          companyId, userIds: [fromUser.id], category: 'schedule', type: 'shift_removed',
          title: `Shift moved: ${stName} on ${fmtDateLong(change.date)}`,
          body: `Your ${stName} on ${fmtDateLong(change.date)} was moved to ${change.toPerson}.`,
          link: 'my-schedule', bundleKey: `shift_removed:${fromUser.id}`,
          bundleTitle: '{count} of your shifts were removed', excludeUserId: createdBy,
        });
        if (toUser) await notify({
          companyId, userIds: [toUser.id], category: 'schedule', type: 'shift_assigned',
          title: `New shift: ${stName} on ${fmtDateLong(change.date)}`,
          body: `You were assigned ${stName} on ${fmtDateLong(change.date)}.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${toUser.id}`,
          bundleTitle: 'You were assigned {count} new shifts', excludeUserId: createdBy,
        });
      } else if (change.action === 'swap' && change.fromPerson && change.toPerson) {
        const d = change.date || change.fromDate || '';
        for (const name of [change.fromPerson, change.toPerson]) {
          const u = await findUser(companyId, name);
          if (u) await notify({
            companyId, userIds: [u.id], category: 'schedule', type: 'shift_changed',
            title: `Shift swapped${d ? ` on ${fmtDateLong(d)}` : ''}`,
            body: `A shift swap between ${change.fromPerson} and ${change.toPerson} was applied${d ? ` for ${fmtDateLong(d)}` : ''}.`,
            link: 'my-schedule', bundleKey: `shift_changed:${u.id}`,
            bundleTitle: '{count} of your shifts changed', excludeUserId: createdBy,
          });
        }
      } else if ((change.action === 'bulk_publish' || change.action === 'bulk_unpublish') && change.fromDate && change.toDate) {
        const publish = change.action === 'bulk_publish';
        let q = `SELECT DISTINCT user_id FROM shifts WHERE company_id = $1 AND date >= $2 AND date <= $3 AND published = $4`;
        const params: any[] = [companyId, change.fromDate, change.toDate, publish];
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { q += ' AND shift_type_id = $5'; params.push(st.id); }
        }
        const { rows: affected } = await query(q, params);
        const ids = affected.map((r: any) => r.user_id);
        if (ids.length) await notify({
          companyId, userIds: ids, category: 'schedule', type: publish ? 'schedule_published' : 'shift_removed',
          title: publish
            ? `Your schedule was published (${fmtDateLong(change.fromDate)} – ${fmtDateLong(change.toDate)})`
            : `Your shifts were moved to draft (${fmtDateLong(change.fromDate)} – ${fmtDateLong(change.toDate)})`,
          body: publish
            ? `Your shifts between ${fmtDateLong(change.fromDate)} and ${fmtDateLong(change.toDate)} are published.`
            : `Your shifts between ${fmtDateLong(change.fromDate)} and ${fmtDateLong(change.toDate)} were moved back to draft.`,
          link: 'my-schedule', bundleKey: publish ? 'schedule_published' : 'shift_removed',
          bundleTitle: publish ? 'Your schedule was published: {count} shift(s)' : '{count} of your shifts were removed',
          excludeUserId: createdBy,
        });
      } else if (change.action === 'add_session' && change.title && change.date) {
        const people: string[] = [];
        if (change.presenter) { const p = await findUser(companyId, change.presenter); if (p) people.push(p.id); }
        if (change.supervisor) { const s = await findUser(companyId, change.supervisor); if (s) people.push(s.id); }
        if (people.length) await notify({
          companyId, userIds: people, category: 'calendar', type: 'session_assigned',
          title: `New session: "${change.title}" on ${fmtDateLong(change.date)}`,
          body: `You are on the session "${change.title}" (${change.dashboard}) on ${fmtDateLong(change.date)}${change.startTime ? ` at ${change.startTime}` : ''}.`,
          link: 'calendars', bundleKey: 'session_assigned', excludeUserId: createdBy,
        });
        if (!change.presenter) {
          // Session needs a presenter: tell the dashboard's department
          // members (digest-speed type — records in-app by default).
          const dash = await findDashboard(companyId, change.dashboard || '');
          if (dash) {
            const deptIds = await dashboardDeptIdsE(dash.id);
            if (deptIds.length) {
              const { rows: mem } = await query(
                'SELECT id FROM users WHERE company_id = $1 AND is_active = true AND department_id = ANY($2::uuid[])',
                [companyId, deptIds]
              );
              if (mem.length) await notify({
                companyId, userIds: mem.map((r: any) => r.id), category: 'calendar', type: 'session_needs_presenter',
                title: `A session needs a presenter: "${change.title}" on ${fmtDateLong(change.date)}`,
                body: `"${change.title}" (${change.dashboard}) on ${fmtDateLong(change.date)} has no presenter yet.`,
                link: 'calendars', bundleKey: 'session_needs_presenter', excludeUserId: createdBy,
              });
            }
          }
        }
      } else if (change.action === 'update_session' && change.sessionTitle) {
        const ids = new Set<string>(sessionPeopleBefore.get(i) || []);
        if (change.presenter) { const p = await findUser(companyId, change.presenter); if (p) ids.add(p.id); }
        if (change.supervisor) { const s = await findUser(companyId, change.supervisor); if (s) ids.add(s.id); }
        if (ids.size) await notify({
          companyId, userIds: [...ids], category: 'calendar', type: 'session_changed',
          title: `Session changed: "${change.title || change.sessionTitle}"`,
          body: `The session "${change.sessionTitle}" (${change.dashboard}) was updated${change.date ? ` for ${fmtDateLong(change.date)}` : ''}.`,
          link: 'calendars', bundleKey: 'session_changed', excludeUserId: createdBy,
        });
      } else if (change.action === 'cancel_session' && change.sessionTitle) {
        const ids = sessionPeopleBefore.get(i) || [];
        if (ids.length) await notify({
          companyId, userIds: ids, category: 'calendar', type: 'session_cancelled',
          title: `Session cancelled: "${change.sessionTitle}"`,
          body: `The session "${change.sessionTitle}" (${change.dashboard}) was cancelled${change.date ? ` for ${fmtDateLong(change.date)}` : ''}.`,
          link: 'calendars', bundleKey: 'session_cancelled', excludeUserId: createdBy,
        });
      }
    }
  } catch (e: any) {
    console.log(`[planExecutor] notification pass failed: ${e?.message || e}`);
  }
  return results;
}
