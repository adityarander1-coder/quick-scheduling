// util/planExecutor.ts — executes approved schedule change plans.

import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { getDepartmentAccess, shiftTypesDepartmentIds } from './departmentAccess.js';
import { closeOpenSlots, closeTypeForDate, publishOpenSlotsForPairs, suppressedTotal } from './openSlots.js';
import { getGeneratedTypeIds } from './scheduleMode.js';
import { saveSpeakers, loadSpeakers, loadBeneficiaries, saveBeneficiaries } from './sessionPeople.js';
import { deleteExternalMeetingQuiet } from './meetingProviders.js';
import { unusablePasswordHash } from './invites.js';

interface PlanChange {
  action: 'assign' | 'assign_recurring' | 'unassign' | 'move' | 'swap' | 'add_job_role' | 'rename_job_role' |
          'add_department' | 'rename_department' |
          'add_team_member' | 'update_team_member' |
          'add_shift_type' | 'rename_shift_type' |
          'add_rotation' |
          'change_member_role_in_department' |
          'set_staffing_target' |
          'bulk_publish' | 'bulk_unpublish' |
          'close_open_slots' |
          'add_open_slots' |
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
  // Close-open-slots fields (close_open_slots, Deepika 2026-11-19):
  // exactly one of these three says HOW MUCH to close. The
  // `department` field (above) says WHICH department the close is
  // for — named in the instruction, or defaulted by the gate to the
  // type's only department (Deepika, 2026-11-19).
  closeCount?: number; // close this many open slots per date
  keepCount?: number; // keep this many open per date, close the rest
  closeAll?: boolean; // close the whole type for the date(s)
  // Add-open-slots field (add_open_slots, Deepika 2026-11-19):
  addCount?: number; // add this many open slots per date
  // Open-slot top-up field (add_open_slots, Deepika 2026-11-20):
  targetTotal?: number; // top up so the TOTAL (filled + open) reaches this per date
  // Per-person rotation fields (add_rotation, Deepika 2026-11-17)
  weekdays?: number[]; // 0=Sun..6=Sat, weekly pattern
  cycleWeeks?: number; // 1 = every week, 2 = every other week (default 1)
  days?: number[]; // explicit cycle days, 1-based (alternative to weekdays)
  cycleDays?: number; // cycle length in days, 1-84 (with days; default 7)
  endDate?: string; // optional last day of the rotation (Rule 7)
  rotationName?: string; // optional name; default "Person — ShiftType"
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
  /**
   * Role-rule warning attached at plan-creation time (warn-and-override):
   * the change assigns someone whose job role is not on the shift type's
   * eligible list. Shown in every plan preview; approving the plan
   * overrides it. Never blocks plan creation or execution.
   */
  warning?: string;
  /**
   * Schedule-conflict note attached at plan-creation time (Deepika
   * 2026-11-01): the swap would double-book someone or leave them
   * under 8 hours of rest. Unlike the role-rule warning this is NOT
   * overridable — shown in every plan preview, and at execution the
   * conflicting swap change is skipped and reported as failed with
   * this reason.
   */
  conflict?: string;
}

interface ExecuteResult {
  action: string;
  success: boolean;
  message: string;
  /** Expanded dates for assign_recurring (used by the Change-report audit). */
  dates?: string[];
  /** Resolved display name, when the executor looked the person up. */
  personDisplay?: string;
  /** Stored rows this change removed (user/date/type) — the Change
   *  report checks each one for a draft the removal left behind. */
  removedSlots?: Array<{ userId: string; date: string; shiftTypeId: string }>;
}

/**
 * Find a user ID by EXACT name match (Deepika, 2026-11-10 — the
 * "Kum" → Binod Kumar incident: the old resolver accepted substring
 * matches, so "kum" silently resolved to the first "Kumar" on the
 * roster). Resolution order, mirroring findDepartment's
 * don't-guess standard:
 *   1. exact full name, or exact nickname — when unique;
 *   2. a UNIQUE first name;
 *   3. a UNIQUE last name.
 * A substring-only match, or any tie, returns null so the change
 * fails with a plain "not guessing" error instead of acting on the
 * wrong person. Deterministic ORDER BY throughout. (Plan creation
 * is gated even earlier by planGate.ts, which rewrites plan names
 * to canonical full names — this resolver is the second line.)
 */
async function findUser(companyId: string, name: string): Promise<{ id: string; display: string } | null> {
  const { rows } = await query(
    `SELECT id, first_name, last_name, nickname FROM users
     WHERE company_id = $1 AND is_active = true
     ORDER BY lower(first_name), lower(last_name), created_at`,
    [companyId]
  );
  const lower = (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!lower) return null;
  const full = (u: any) => `${u.first_name} ${u.last_name || ''}`.toLowerCase().trim().replace(/\s+/g, ' ');
  const found = (u: any) => ({ id: u.id as string, display: u.nickname || `${u.first_name} ${u.last_name || ''}`.trim() });
  const unique = (hits: any[]) => (hits.length === 1 ? found(hits[0]) : null);
  // 1. Exact full name or exact nickname.
  const exactFull = rows.filter((u: any) => full(u) === lower);
  if (exactFull.length) return unique(exactFull);
  const exactNick = rows.filter((u: any) => u.nickname && u.nickname.toLowerCase().trim() === lower);
  if (exactNick.length) return unique(exactNick);
  // 2. Unique first name. A tie is ambiguous — never fall through
  //    to a different interpretation of the same word.
  const firsts = rows.filter((u: any) => (u.first_name || '').toLowerCase() === lower);
  if (firsts.length) return unique(firsts);
  // 3. Unique last name.
  const lasts = rows.filter((u: any) => u.last_name && u.last_name.toLowerCase() === lower);
  if (lasts.length) return unique(lasts);
  return null;
}

/** The executor's person-resolution failure line (Deepika, 2026-11-10). */
function noExactMatch(name: string): string {
  return `No team member matches "${name}" exactly — not guessing. Use the full name as it appears on the team list.`;
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
 * Resolve an add_rotation change's pattern into the manual flow's
 * shape — a cycle length (1–84 days) and the 1-based cycle days the
 * person works (cycle day 1 = the start date), exactly what Settings
 * → Rotations stores in rotations + rotation_assignments. The
 * planner speaks weekdays ("Monday Wednesday Friday every week"),
 * so the weekday form is converted here, deterministically, from the
 * start date — the planner never does calendar math by hand. The
 * explicit form ("7 on / 7 off" → days 1–7 of a 14-day cycle) passes
 * through as given. Shared with the plan gate, so a bad pattern is
 * refused as a clarification before any plan is built. Throws a
 * plain-words error when the pattern cannot be resolved.
 */
export function resolveRotationPattern(change: {
  startDate?: string; weekdays?: unknown; cycleWeeks?: unknown; days?: unknown; cycleDays?: unknown;
}): { cycleDays: number; days: number[] } {
  const start = String(change.startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(new Date(start + 'T00:00:00Z').getTime())) {
    throw new Error('A valid start date is needed for the rotation.');
  }
  const startWeekday = new Date(start + 'T00:00:00Z').getUTCDay();
  const daysArr = Array.isArray(change.days)
    ? (change.days as any[]).map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n)) : [];
  const wds = Array.isArray(change.weekdays)
    ? (change.weekdays as any[]).map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
  if (daysArr.length) {
    let cd: number;
    if (change.cycleDays === undefined || change.cycleDays === null || change.cycleDays === '') {
      const maxDay = Math.max(...daysArr);
      if (maxDay > 7) throw new Error('How long is the rotation cycle in days? The pattern days go past one week.');
      cd = 7;
    } else {
      cd = Number(change.cycleDays);
    }
    if (!Number.isInteger(cd) || cd < 1 || cd > 84) throw new Error('The rotation cycle must be 1–84 days.');
    const bad = daysArr.find((d) => d < 1 || d > cd);
    if (bad !== undefined) throw new Error(`Day ${bad} of the pattern falls outside the ${cd}-day cycle.`);
    return { cycleDays: cd, days: [...new Set(daysArr)].sort((a, b) => a - b) };
  }
  if (wds.length) {
    const cw = change.cycleWeeks === undefined || change.cycleWeeks === null || change.cycleWeeks === ''
      ? 1 : Number(change.cycleWeeks);
    if (!Number.isInteger(cw) || cw < 1 || cw > 12) throw new Error('The rotation must repeat every 1–12 weeks.');
    const cycleDays = cw * 7;
    const out = new Set<number>();
    for (let w = 0; w < cw; w++) {
      for (const wd of wds) out.add(w * 7 + ((wd - startWeekday + 7) % 7) + 1);
    }
    return { cycleDays, days: [...out].sort((a, b) => a - b) };
  }
  throw new Error('The rotation needs its days — for example, Monday Wednesday Friday every week.');
}

/** Short weekday names for rotation pattern descriptions (0=Sun). */
export function weekdayShort(wd: number): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][wd] || '';
}

/**
 * Group-rotation occurrence for one user on one date (Deepika,
 * 2026-11-13 — Bul/Swing delete bug): a group rotation has no
 * rotation_assignments rows — its members live in
 * rotation_group_members and are dealt at draw time — so the
 * assignment query in findRotationOccurrences can never see it.
 * Replay the line dealing from the rotation start with the SAME
 * math as drawRotationOccurrences (schedule.ts) and shiftRange.ts:
 * turn blocks counted by dealing, the front member serves and goes
 * to the back, a member on vacation at a turn's start keeps the
 * front spot while the next member covers the whole turn. Returns
 * the occurrence when the dealt member is this user on this date,
 * else null. The manual-row / exclusion checks are deliberately
 * NOT mirrored here: this answers "does the pattern deal this
 * person here", the same contract as the per-person branch (which
 * also ignores manual rows).
 */
async function findGroupRotationOccurrence(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeId: string | null,
  rot: any,
  vacMap: Map<string, Array<{ start: string; end: string }>>,
  queryFn: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>
): Promise<{ rotationId: string; shiftTypeId: string } | null> {
  const stId = rot.groupShiftTypeId as string;
  if (shiftTypeId && stId !== shiftTypeId) return null;
  // The draw yields no members when the group shift type row is gone.
  const { rows: typeRows } = await queryFn(
    'SELECT id FROM shift_types WHERE id = $1 AND company_id = $2',
    [stId, companyId]
  );
  if (!typeRows.length) return null;
  const groupIds = String(rot.groupIds || rot.groupId || '')
    .split(',').map((x: string) => x.trim()).filter(Boolean);
  if (!groupIds.length) return null;
  const daySet = new Set(
    String(rot.groupDays || '').split(',').map((x: string) => Number(x)).filter((n: number) => n >= 1)
  );
  if (!daySet.size) return null;
  const { rows: memberRows } = await queryFn(
    `SELECT gm.group_id AS "groupId", gm.user_id AS "userId",
            u.end_date::text AS "userEndDate"
     FROM rotation_group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ANY($1) AND u.is_active = true
     ORDER BY gm.group_id, gm.position`,
    [groupIds]
  );
  const membersByGroup = new Map<string, any[]>();
  for (const m of memberRows) {
    if (!membersByGroup.has(m.groupId)) membersByGroup.set(m.groupId, []);
    membersByGroup.get(m.groupId)!.push(m);
  }
  const groupsMembers: any[][] = groupIds.map((gid: string) => membersByGroup.get(gid) || []);
  if (!groupsMembers.some((g) => g.length)) return null;
  const unit = rot.turnUnit || 'shift';
  const tDays = Math.max(1, Number(rot.turnDays) || 1);
  const wStart = Number.isInteger(rot.weekStart) ? rot.weekStart : 1;
  const dayMs = 86400000;
  const startMs = Date.parse(rot.startDate + 'T00:00:00Z');
  const targetMs = Date.parse(date + 'T00:00:00Z');
  if (isNaN(startMs) || isNaN(targetMs) || targetMs < startMs) return null;
  if (rot.endDate && date > String(rot.endDate).slice(0, 10)) return null;
  const anchorMs = startMs - ((new Date(startMs).getUTCDay() - wStart + 7) % 7) * dayMs;
  const onVacation = (uid: string, dateStr: string): boolean => {
    const periods = vacMap.get(uid);
    if (!periods) return false;
    return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
  };
  const queues: any[][] = groupsMembers.map((g) => g.slice());
  let occ = 0;
  let blockIdx = -1;
  let lastKey: string | null = null;
  let currentMember: any = null;
  for (let ms = startMs; ms <= targetMs; ms += dayMs) {
    const dayIndex = Math.floor((ms - startMs) / dayMs);
    const cycleDay = (dayIndex % rot.cycleDays) + 1;
    if (!daySet.has(cycleDay)) continue;
    const dateStr = new Date(ms).toISOString().slice(0, 10);
    let key: string;
    if (unit === 'week') key = 'w' + Math.floor((ms - anchorMs) / (7 * dayMs));
    else if (unit === 'days') key = 'd' + Math.floor(occ / tDays);
    else key = 's' + occ;
    occ++;
    if (key !== lastKey) {
      lastKey = key;
      blockIdx++;
      const gIdx = blockIdx % groupsMembers.length;
      const q = queues[gIdx];
      currentMember = null;
      for (let qi = 0; qi < q.length; qi++) {
        if (!onVacation(q[qi].userId, dateStr)) {
          currentMember = q[qi];
          q.splice(qi, 1);
          q.push(currentMember);
          break;
        }
      }
    }
    if (dateStr !== date) continue;
    // Target date: the draw's own checks, in the draw's order.
    const { rows: pauses } = await queryFn(
      `SELECT 1 FROM rotation_pauses
       WHERE rotation_id = $1 AND start_date::text <= $2 AND end_date::text >= $2 LIMIT 1`,
      [rot.id, date]
    );
    if (pauses.length) return null;
    if (!currentMember) return null;
    if (onVacation(currentMember.userId, dateStr)) return null;
    if (currentMember.userEndDate && dateStr > String(currentMember.userEndDate).slice(0, 10)) return null;
    if (currentMember.userId !== userId) return null;
    return { rotationId: rot.id, shiftTypeId: stId };
  }
  return null;
}

/**
 * Every rotation occurrence for a user on a date (optionally one
 * shift type): active rotations whose assignment lands on that cycle
 * day, with pause periods skipped. Group rotations deal their
 * members in turn (see findGroupRotationOccurrence) and are covered
 * the same way. This is the "does the pattern draw here" rule,
 * shared by excludeRotationInstances and the Change report's draft
 * detection (audit.ts) — one source of truth, so the report can
 * never disagree with the schedule draw.
 */
export async function findRotationOccurrences(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeId: string | null,
  queryFn: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }> = query
): Promise<Array<{ rotationId: string; shiftTypeId: string }>> {
  const { rows: rotations } = await queryFn(
    `SELECT id, cycle_days AS "cycleDays", start_date::text AS "startDate",
            end_date::text AS "endDate",
            group_id AS "groupId", group_ids AS "groupIds",
            group_shift_type_id AS "groupShiftTypeId",
            group_days AS "groupDays", turn_unit AS "turnUnit",
            turn_days AS "turnDays", week_start AS "weekStart"
     FROM rotations WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  // Vacation ranges per person — the SAME construction as the draw
  // (drawRotationOccurrences / shiftRange): pauses attach to the
  // rotations a person is assigned to; 'Bulk delete' pauses are NOT
  // vacations. Group members have no assignment rows, so their
  // vacations are invisible here exactly as they are in the draw —
  // the replay below must agree with the draw, not improve on it.
  const { rows: vacRows } = await queryFn(
    `SELECT ra.user_id AS "userId", p.start_date::text AS "startDate", p.end_date::text AS "endDate"
     FROM rotation_pauses p
     JOIN rotation_assignments ra ON ra.rotation_id = p.rotation_id
     WHERE p.company_id = $1 AND (p.reason IS NULL OR p.reason <> 'Bulk delete')`,
    [companyId]
  );
  const vacMap = new Map<string, Array<{ start: string; end: string }>>();
  for (const v of vacRows) {
    if (!vacMap.has(v.userId)) vacMap.set(v.userId, []);
    vacMap.get(v.userId)!.push({ start: v.startDate, end: v.endDate });
  }
  const found: Array<{ rotationId: string; shiftTypeId: string }> = [];
  for (const rot of rotations) {
    const startDate = new Date(rot.startDate + 'T00:00:00');
    const target = new Date(date + 'T00:00:00');
    if (isNaN(startDate.getTime()) || isNaN(target.getTime()) || target < startDate) continue;
    const daysSinceStart = Math.floor((target.getTime() - startDate.getTime()) / 86400000);
    const cycleDay = (daysSinceStart % rot.cycleDays) + 1; // 1-indexed, matches schedule.ts
    // Per-person branch: the assignment lands on this cycle day.
    const { rows: assignments } = await queryFn(
      `SELECT ra.cycle_day AS "cycleDay", ra.shift_type_id AS "shiftTypeId"
       FROM rotation_assignments ra
       JOIN users u ON u.id = ra.user_id
       WHERE ra.rotation_id = $1 AND ra.user_id = $2 AND u.is_active = true
         AND (u.end_date IS NULL OR u.end_date::text >= $3)`,
      [rot.id, userId, date]
    );
    const matches = assignments.filter(
      (a: any) => a.cycleDay === cycleDay && (!shiftTypeId || a.shiftTypeId === shiftTypeId)
    );
    if (matches.length) {
      // Skip dates inside a pause period (vacation etc.).
      const { rows: pauses } = await queryFn(
        `SELECT 1 FROM rotation_pauses
         WHERE rotation_id = $1 AND start_date::text <= $2 AND end_date::text >= $2 LIMIT 1`,
        [rot.id, date]
      );
      if (!pauses.length) {
        for (const m of matches) found.push({ rotationId: rot.id, shiftTypeId: m.shiftTypeId });
      }
    }
    // Group branch: the rotation deals its members in turn (no
    // assignment rows exist), so the assignment query above can
    // never see it — replay the dealing and report the occurrence
    // when the dealt member is this user on this date.
    if (rot.groupId && rot.groupShiftTypeId) {
      const g = await findGroupRotationOccurrence(companyId, userId, date, shiftTypeId, rot, vacMap, queryFn);
      if (g) found.push(g);
    }
  }
  return found;
}

/**
 * Exclude every rotation occurrence for a user on a date — ALL shift
 * types, not just one. Returns the exclusions actually inserted
 * (empty when the person holds no rotation day there), so callers
 * can offer exact undo. ON CONFLICT DO NOTHING keeps this
 * idempotent. queryFn lets callers run it inside a transaction.
 * (Deepika, 2026-11-12 — dual-source fix: a stored row suppresses
 * the occurrence in the draw, so removing the row alone lets it pop
 * back. Deepika, 2026-11-13 — delete completely, widened: a stored
 * row can suppress occurrences of OTHER types that day — a published
 * group-origin row suppresses any conflicting type — so a stored
 * removal must sweep every occurrence for that person/date, or the
 * person pops back as a draft of another type. Day-scoped only:
 * other days are untouched, rotations are untouched, and stored
 * rows of other types are never deleted — exclusions suppress DRAWN
 * occurrences only. Callers that remove NO stored row must NOT use
 * this helper — see the unassign no-row branch, which excludes only
 * the one type it was asked to remove.)
 */
export async function excludeRotationInstances(
  companyId: string,
  userId: string,
  date: string,
  queryFn: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }> = query
): Promise<Array<{ rotationId: string; userId: string; date: string; shiftTypeId: string }>> {
  const occ = await findRotationOccurrences(companyId, userId, date, null, queryFn);
  const excluded: Array<{ rotationId: string; userId: string; date: string; shiftTypeId: string }> = [];
  for (const o of occ) {
    const ins = await queryFn(
      `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
      [companyId, o.rotationId, userId, date, o.shiftTypeId]
    );
    if (ins.rowCount && ins.rowCount > 0) excluded.push({ rotationId: o.rotationId, userId, date, shiftTypeId: o.shiftTypeId });
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

type SwapSide =
  | { kind: 'manual'; row: { id: string; shift_type_id: string; date: string; published: boolean; notes: string | null; shift_type_name: string } }
  | { kind: 'rotation'; rotationId: string; shiftTypeId: string; shiftTypeName: string };

/**
 * Resolve one side of a swap: what is this user working on this date?
 * A manual shift row wins first (today's swap behavior, unchanged). If
 * there is no manual row, fall back to the rotation-generated instance
 * for that day — computed with the same rules the schedule read path
 * uses (active rotation, active user, end date, cycle math, pause skip),
 * minus instances already excluded (a day the person is already off).
 * Returns null when the user has neither. Throws when a named shift
 * type does not exist, mirroring findShiftRow.
 */
async function resolveSwapSide(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeName?: string
): Promise<SwapSide | null> {
  const manual = await findShiftRow(companyId, userId, date, shiftTypeName);
  if (manual) return { kind: 'manual', row: manual };
  let wantedTypeId: string | null = null;
  if (shiftTypeName) {
    const st = await findShiftType(companyId, shiftTypeName);
    if (!st) throw new Error(`Shift type not found: ${shiftTypeName}`);
    wantedTypeId = st.id;
  }
  // Rotation day: findRotationOccurrences is the shared, group-aware
  // read (Deepika, 2026-11-13 — the assignment-only loop below it
  // could never see a group rotation: members live in
  // rotation_group_members and are dealt at draw time, so an AI swap
  // with a group-rotation day on either side resolved to null, the
  // swap degraded to a move, and the conflict guard refused it).
  // Pause handling matches the old loop (a paused rotation day is
  // not a side); exclusions are checked here because
  // findRotationOccurrences reports the drawn occurrence whether or
  // not it was already excluded.
  const occ = await findRotationOccurrences(companyId, userId, date, wantedTypeId);
  for (const o of occ) {
    const { rows: excl } = await query(
      `SELECT 1 FROM rotation_shift_exclusions
       WHERE rotation_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 LIMIT 1`,
      [o.rotationId, userId, date, o.shiftTypeId]
    );
    if (excl.length) continue; // already off this rotation day
    const { rows: stRows } = await query(
      'SELECT name FROM shift_types WHERE id = $1', [o.shiftTypeId]
    );
    return {
      kind: 'rotation',
      rotationId: o.rotationId,
      shiftTypeId: o.shiftTypeId,
      shiftTypeName: stRows[0]?.name || 'rotation shift',
    };
  }
  return null;
}

function noShiftFoundMsg(display: string, date: string, shiftTypeName?: string): string {
  return `No shift found for ${display} on ${date}${shiftTypeName ? ` (${shiftTypeName})` : ''} — checked manual assignments and rotation days.`;
}

/* ------------------------------------------------------------------ */
/* Calendar sessions (dashboards) — added 2026-10-21 so Email        */
/* Q-Scheduler / the in-app Task agent can add, change and cancel    */
/* sessions with the same semantics as the session REST endpoints    */
/* (per-date overrides, series edits, editor permission rule). The   */
/* exported ops are shared with the quick-session email page.        */
/* ------------------------------------------------------------------ */

async function findDashboard(companyId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query('SELECT id, name FROM dashboards WHERE company_id = $1 AND archived_at IS NULL', [companyId]);
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
  const access = await getDepartmentAccess(createdBy, companyId);
  if (departmentId) return access.edit.includes(departmentId);
  // Inherit model (2026-11-07): no department of its own — Edit access
  // to any of the calendar's departments (any Edit department when the
  // calendar is unrestricted).
  if (dashboardId) {
    const edit = access.edit || [];
    if (!edit.length) return false;
    const dd = await dashboardDeptIdsE(dashboardId);
    if (!dd.length) return true;
    return dd.some((d) => edit.includes(d));
  }
  return false;
}

/**
 * May this user edit in this department? Owner: yes. Scheduler:
 * only departments they have EDIT access to. Anyone else: no.
 * createdBy is the approver's id, or null for an email approve
 * link — there the token is the auth, and the approve page already
 * ran its own department-access pre-check (getPlanDepartmentIds in
 * schedule.ts). Gates any department-scoped AI write (per-department
 * role changes, close_open_slots) — unlike update_team_member,
 * whose direct UPDATE has no department-access check (flagged
 * 2026-11-19, not repeated).
 */
async function canEditDepartment(
  companyId: string, createdBy: string | null, departmentId: string
): Promise<boolean> {
  if (!createdBy) return true; // email approve link: the token is the auth
  const { rows } = await query('SELECT role FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [createdBy, companyId]);
  const role = rows[0]?.role;
  if (role === 'owner') return true;
  if (role !== 'scheduler') return false;
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
  // EVENT model: the presenter is Speaker 1 in the speakers list too.
  if (f.presenterId) await saveSpeakers(query as any, id, [{ userId: f.presenterId }]);
  return id;
}

/** Organizing department for a plan/form-created session (Deepika,
 *  2026-11-07): the creator's manageable departments on the calendar
 *  (Edit access ∩ the calendar's; owner → the calendar's). Exactly
 *  one → it; several → the calendar's first matching; none or an
 *  unknown/token creator → NULL (the piece-1 inherit behaviour)
 *  rather than guessing. */
export async function resolveOrganizingDeptE(companyId: string, createdBy: string | null, dashboardId: string): Promise<string | null> {
  const dIds = await dashboardDeptIdsE(dashboardId);
  if (!createdBy) return null;
  const { rows } = await query('SELECT role FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [createdBy, companyId]);
  const role = rows[0]?.role;
  if (role === 'owner') return dIds.length ? dIds[0] : null;
  if (role !== 'scheduler') return null;
  const { rows: ed } = await query('SELECT user_id FROM dashboard_editors WHERE dashboard_id = $1', [dashboardId]);
  if (ed.length) return ed.some((r: any) => r.user_id === createdBy) && dIds.length ? dIds[0] : null;
  const access = await getDepartmentAccess(createdBy, companyId);
  const edit = access.edit || [];
  if (dIds.length) {
    for (const d of dIds) if (edit.includes(d)) return d;
    return null;
  }
  return edit[0] || null;
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
  if (f.presenterId !== undefined) {
    // Keep Speaker 1 in step with the lecturer mirror (other
    // speakers and guest rows keep their spots).
    const spMap = await loadSpeakers(query as any, [s.id]);
    const sp = (spMap.get(s.id) || []).map((x: any) => x.userId ? { userId: x.userId } : { guestName: x.name, guestEmail: x.guestEmail });
    const rest = sp.length && sp[0].userId ? sp.slice(1) : sp;
    const next = f.presenterId ? [{ userId: f.presenterId }, ...rest.filter((x: any) => x.userId !== f.presenterId)] : rest;
    await saveSpeakers(query as any, s.id, next as any);
  }
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
  // A generated meeting dies with its session (best effort, 091).
  const { rows } = await query('SELECT meeting_provider, meeting_external_id FROM academic_sessions WHERE id = $1 AND company_id = $2', [sessionId, companyId]).catch(() => ({ rows: [] as any[] }));
  await query('DELETE FROM academic_sessions WHERE id = $1 AND company_id = $2', [sessionId, companyId]);
  if (rows[0] && rows[0].meeting_provider && rows[0].meeting_external_id) {
    void deleteExternalMeetingQuiet(companyId, rows[0].meeting_provider, rows[0].meeting_external_id);
  }
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
  const newId = await insertSession(companyId, createdBy, s.dashboard_id, eff);
  // The one-off copy carries the series' speakers + beneficiaries;
  // insertSession already wrote Speaker 1 from the effective
  // presenter — replace that with the full list, adjusted when the
  // moved date's own presenter differs.
  const spMap = await loadSpeakers(query as any, [s.id]);
  const sp = (spMap.get(s.id) || []).map((x: any) => x.userId ? { userId: x.userId } : { guestName: x.name, guestEmail: x.guestEmail });
  if (sp.length) {
    let list = sp;
    const seriesFirst = s.lecturer_user_id || null;
    if ((eff.presenterId ?? null) !== seriesFirst) {
      const rest = sp.length && sp[0].userId ? sp.slice(1) : sp;
      list = eff.presenterId ? [{ userId: eff.presenterId }, ...rest.filter((x: any) => x.userId !== eff.presenterId)] : rest;
    }
    await saveSpeakers(query as any, newId, list as any);
  }
  const benMap = await loadBeneficiaries(query as any, [s.id]);
  const ben = benMap.get(s.id);
  if (ben && (ben.departmentIds.length || ben.userIds.length)) {
    await saveBeneficiaries(query as any, newId, ben.departmentIds, ben.userIds);
  }
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
/**
 * Check one person against one shift type's eligible job-role list.
 * Same gate as the manual-assign / pickup paths: a non-empty list means
 * the member's linked job role must be in the list. An empty list means
 * all roles of the shift type's own departments (Deepika, 2026-11-14);
 * a type with no departments stays open to everyone. Members with no
 * role set fail department-scoped types.
 */
export async function checkPersonEligible(
  companyId: string,
  userId: string,
  shiftTypeId: string
): Promise<{ ok: true } | { ok: false; roleName: string | null; eligibleNames: string }> {
  const { rows: trows } = await query(
    `SELECT st.eligible_job_role_ids,
            COALESCE((SELECT json_agg(std.department_id) FROM shift_type_departments std WHERE std.shift_type_id = st.id), '[]') AS "departmentIds",
            st.department_id AS "departmentId"
     FROM shift_types st WHERE st.id = $1 AND st.company_id = $2`,
    [shiftTypeId, companyId]
  );
  if (!trows.length) return { ok: true };
  const list: string[] = Array.isArray(trows[0].eligible_job_role_ids) ? trows[0].eligible_job_role_ids : [];
  const deptIds: string[] = Array.isArray(trows[0].departmentIds) ? [...trows[0].departmentIds] : [];
  if (trows[0].departmentId && !deptIds.includes(trows[0].departmentId)) deptIds.push(trows[0].departmentId);
  // Cross-department pull (Deepika, 2026-11-19): a member holds one job
  // role PER department (home + pulled-in). The role that decides
  // eligibility is the one in the shift type's own departments; with an
  // explicit eligible list, ANY of their roles may qualify.
  const { roleInDepartments, userRoles } = await import('./memberships.js');
  const inTypeDept = deptIds.length ? await roleInDepartments(companyId, userId, deptIds) : null;
  const roleId: string | null = inTypeDept ? inTypeDept.roleId : null;
  let roleName: string | null = null;
  if (roleId) {
    const { rows: prows } = await query(
      'SELECT name FROM job_roles WHERE id = $1 AND company_id = $2',
      [roleId, companyId]
    );
    roleName = prows.length ? prows[0].name : null;
  }
  if (list.length) {
    if (roleId && list.includes(roleId)) return { ok: true };
    // A role in ANOTHER department may still be on the list (e.g. the
    // same role name linked in two departments is two different roles —
    // the list holds role ids, so check every role the member holds).
    const allRoles = await userRoles(companyId, userId);
    if (allRoles.some((r) => list.includes(r.roleId))) return { ok: true };
    const { rows: rrows } = await query(
      'SELECT name FROM job_roles WHERE id = ANY($1::uuid[]) AND company_id = $2 ORDER BY lower(name)',
      [list, companyId]
    );
    const eligibleNames = rrows.map((r: any) => r.name).join(', ') || 'specific job roles';
    return { ok: false, roleName, eligibleNames };
  }
  // Empty list: "all roles" = all roles of the type's own departments.
  if (!deptIds.length) return { ok: true };
  const { rows: drows } = await query(
    'SELECT name FROM departments WHERE id = ANY($1::uuid[]) AND company_id = $2 ORDER BY lower(name)',
    [deptIds, companyId]
  );
  const deptNames = drows.map((r: any) => r.name).join(', ') || 'its departments';
  if (roleId) return { ok: true };
  return { ok: false, roleName, eligibleNames: `any job role in ${deptNames}` };
}

/**
 * Warn-and-override validation for a plan's changes (Deepika, 2026-10-26).
 * Attaches a `warning` to every assign / assign_recurring / move / swap
 * change that puts someone on a shift type their job role is not eligible
 * for, and returns how many changes were flagged. Best-effort by design:
 * an unresolvable person/shift (or any error) skips that change's warning
 * instead of blocking plan creation — execution still decides the change,
 * and approval is the override.
 */
export async function validatePlanEligibility(companyId: string, changes: PlanChange[]): Promise<number> {
  let warned = 0;
  const check = async (personDisplay: string, userId: string, shiftTypeId: string, shiftTypeName: string) => {
    const res = await checkPersonEligible(companyId, userId, shiftTypeId);
    if (res.ok) return null;
    return `Role-rule warning: ${personDisplay} (${res.roleName || 'no job role set'}) → ${shiftTypeName} allows only: ${res.eligibleNames}. Approving overrides this rule.`;
  };
  for (const c of changes || []) {
    try {
      if ((c.action === 'assign' || c.action === 'assign_recurring') && c.person && c.shiftType) {
        const user = await findUser(companyId, c.person);
        const st = await findShiftType(companyId, c.shiftType);
        if (!user || !st) continue;
        const w = await check(user.display, user.id, st.id, st.name);
        if (w) { c.warning = w; warned++; }
      } else if (c.action === 'move' && c.fromPerson && c.toPerson && (c.date || c.fromDate)) {
        const fromUser = await findUser(companyId, c.fromPerson);
        const toUser = await findUser(companyId, c.toPerson);
        if (!fromUser || !toUser) continue;
        const row = await findShiftRow(companyId, fromUser.id, (c.date || c.fromDate)!, c.shiftType);
        if (!row) continue;
        const w = await check(toUser.display, toUser.id, row.shift_type_id, row.shift_type_name);
        if (w) { c.warning = w; warned++; }
      } else if (c.action === 'swap' && c.fromPerson && c.toPerson) {
        const fromUser = await findUser(companyId, c.fromPerson);
        const toUser = await findUser(companyId, c.toPerson);
        if (!fromUser || !toUser) continue;
        const fromDate = c.fromDate || c.date;
        const toDate = c.toDate || c.date;
        if (!fromDate || !toDate) continue;
        const fromSide = await resolveSwapSide(companyId, fromUser.id, fromDate, c.shiftType);
        if (!fromSide) continue;
        const fromTypeId = fromSide.kind === 'manual' ? fromSide.row.shift_type_id : fromSide.shiftTypeId;
        const fromTypeName = fromSide.kind === 'manual' ? fromSide.row.shift_type_name : fromSide.shiftTypeName;
        const warnings: string[] = [];
        const w1 = await check(toUser.display, toUser.id, fromTypeId, fromTypeName);
        if (w1) warnings.push(w1);
        const toSide = await resolveSwapSide(companyId, toUser.id, toDate, c.shiftType);
        if (toSide) {
          const toTypeId = toSide.kind === 'manual' ? toSide.row.shift_type_id : toSide.shiftTypeId;
          const toTypeName = toSide.kind === 'manual' ? toSide.row.shift_type_name : toSide.shiftTypeName;
          const w2 = await check(fromUser.display, fromUser.id, toTypeId, toTypeName);
          if (w2) warnings.push(w2);
        }
        if (warnings.length) { c.warning = warnings.join(' '); warned++; }
      }
    } catch { /* a warning must never block plan creation */ }
  }
  return warned;
}

/**
 * Simulate one resolved swap and return the conflict reason, or null
 * when both people's post-swap schedules are safe (no double-booking,
 * at least 8 hours of rest around every shift). Shared by the
 * creation-time validation (validatePlanConflicts) and the
 * execution-time guard in executePlan, so a swap that was fine when
 * the plan was written but has become impossible since is still
 * refused at approval time.
 */
async function swapConflictReason(
  companyId: string,
  fromUser: { id: string; display: string },
  toUser: { id: string; display: string },
  fromSide: SwapSide,
  toSide: SwapSide | null,
  fromDate: string,
  toDate: string
): Promise<string | null> {
  const { checkSwapConflicts } = await import('./shiftConflicts.js');
  const typeOf = (side: SwapSide) => side.kind === 'manual'
    ? { shiftTypeId: side.row.shift_type_id, shiftTypeName: side.row.shift_type_name }
    : { shiftTypeId: side.shiftTypeId, shiftTypeName: side.shiftTypeName };
  const fromType = typeOf(fromSide);
  const toType = toSide ? typeOf(toSide) : null;
  return checkSwapConflicts(query, companyId, [
    {
      userId: fromUser.id, personName: fromUser.display,
      gives: [{ date: fromDate, ...fromType }],
      receives: toType ? [{ date: toDate, ...toType }] : [],
    },
    {
      userId: toUser.id, personName: toUser.display,
      gives: toType ? [{ date: toDate, ...toType }] : [],
      // Mirrors the executor: with an exchange, toUser covers
      // fromDate; a move (no shift to exchange) lands on toDate.
      receives: [{ date: toSide ? fromDate : toDate, ...fromType }],
    },
  ]);
}

/**
 * Conflict validation for a plan's swap changes (Deepika, 2026-11-01:
 * the system must catch impossible moves, not leave them for admins
 * to spot). Attaches a `conflict` note to every swap change whose
 * post-swap schedules would double-book someone or leave them under
 * 8 hours of rest, and returns how many changes were flagged.
 * Best-effort like validatePlanEligibility: an unresolvable swap
 * skips the note instead of blocking plan creation — but unlike the
 * role-rule warning, a flagged swap is NOT applied at execution
 * (executePlan re-checks and fails it with the reason).
 */
export async function validatePlanConflicts(companyId: string, changes: PlanChange[]): Promise<number> {
  let flagged = 0;
  for (const c of changes || []) {
    try {
      if (c.action !== 'swap' || !c.fromPerson || !c.toPerson) continue;
      const fromUser = await findUser(companyId, c.fromPerson);
      const toUser = await findUser(companyId, c.toPerson);
      if (!fromUser || !toUser) continue;
      const fromDate = c.fromDate || c.date;
      const toDate = c.toDate || c.date;
      if (!fromDate || !toDate) continue;
      const fromSide = await resolveSwapSide(companyId, fromUser.id, fromDate, c.shiftType);
      if (!fromSide) continue;
      const toSide = await resolveSwapSide(companyId, toUser.id, toDate, c.shiftType);
      const reason = await swapConflictReason(companyId, fromUser, toUser, fromSide, toSide, fromDate, toDate);
      if (reason) { c.conflict = reason; flagged++; }
    } catch { /* a validation note must never block plan creation */ }
  }
  return flagged;
}

/**
 * Human-readable job-role rules for the planner prompt, restricted types
 * only: e.g. ["Red Team: only PGY1, PGY2, PGY3"]. A type with an explicit
 * list names its roles; a department-scoped type with an EMPTY list is
 * also restricted (Deepika, 2026-11-14 — "all roles" means all roles of
 * the type's own departments) and reads e.g. "Resident Day: only any
 * job role in Residents". Empty when nothing is restricted (everyone
 * may take every shift type). A global type with an empty list stays
 * open to everyone and is not listed.
 */
export async function getShiftTypeRules(companyId: string): Promise<string[]> {
  const { rows: stRows } = await query(
    `SELECT st.name, st.eligible_job_role_ids,
            COALESCE((SELECT json_agg(std.department_id) FROM shift_type_departments std WHERE std.shift_type_id = st.id), '[]') AS "departmentIds",
            st.department_id AS "departmentId"
     FROM shift_types st WHERE st.company_id = $1 AND st.is_active = true`,
    [companyId]
  );
  const deptIdsOf = (r: any): string[] => {
    const ids: string[] = Array.isArray(r.departmentIds) ? [...r.departmentIds] : [];
    if (r.departmentId && !ids.includes(r.departmentId)) ids.push(r.departmentId);
    return ids;
  };
  const hasList = (r: any) => Array.isArray(r.eligible_job_role_ids) && r.eligible_job_role_ids.length;
  const explicit = stRows.filter(hasList);
  const scopedEmpty = stRows.filter((r: any) => !hasList(r) && deptIdsOf(r).length > 0);
  if (!explicit.length && !scopedEmpty.length) return [];
  const roleIds = [...new Set(explicit.flatMap((r: any) => r.eligible_job_role_ids))];
  const deptIds = [...new Set(scopedEmpty.flatMap((r: any) => deptIdsOf(r)))];
  const { rows: rRows } = roleIds.length
    ? await query('SELECT id, name FROM job_roles WHERE id = ANY($1::uuid[]) AND company_id = $2', [roleIds, companyId])
    : { rows: [] };
  const { rows: dRows } = deptIds.length
    ? await query('SELECT id, name FROM departments WHERE id = ANY($1::uuid[]) AND company_id = $2', [deptIds, companyId])
    : { rows: [] };
  const byId = new Map(rRows.map((r: any) => [r.id, r.name]));
  const deptById = new Map(dRows.map((r: any) => [r.id, r.name]));
  return [
    ...explicit.map((r: any) =>
      `${r.name}: only ${r.eligible_job_role_ids.map((id: string) => byId.get(id) || 'a job role').join(', ')}`),
    ...scopedEmpty.map((r: any) =>
      `${r.name}: only any job role in ${deptIdsOf(r).map((id: string) => deptById.get(id) || 'its departments').join(', ')}`),
  ];
}

/**
 * Open-slot totals for one type+date, mirroring the manual route's
 * openSlotTotals (schedule.ts:8892) — the formula the grid itself
 * uses: max(0, target + extra − filled), 0 when the day is closed
 * for the type. Rotation occurrences are NOT counted in `filled`
 * (same as the manual close): a close only ever suppresses
 * computed opens, never a stored shift row, so it can never remove
 * a person. Used by close_open_slots (gate re-checks at execution).
 */
async function openTotals(companyId: string, date: string, shiftTypeId: string): Promise<{ total: number; closed: boolean; filled: number; raw: number }> {
  const { rows: crows } = await query(
    'SELECT 1 FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  if (crows.length) return { total: 0, closed: true, filled: 0, raw: 0 };
  const { rows: trows } = await query(
    `SELECT target_count, weekdays, start_date::text AS start_date, end_date::text AS end_date
     FROM staffing_targets WHERE company_id = $1 AND shift_type_id = $2`,
    [companyId, shiftTypeId]
  );
  let target = 0;
  if (trows.length) {
    const t = trows[0];
    const dow = new Date(date + 'T12:00:00').getDay();
    const wdays: number[] = Array.isArray(t.weekdays) ? t.weekdays : [0, 1, 2, 3, 4, 5, 6];
    const sd: string | null = t.start_date || null;
    const ed: string | null = t.end_date || null;
    if (wdays.indexOf(dow) !== -1 && !(sd && date < sd) && !(ed && date > ed)) {
      target = Number(t.target_count) || 0;
    }
  }
  const { rows: erows } = await query(
    'SELECT COALESCE(SUM(count), 0)::int AS n FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const extra = erows[0]?.n || 0;
  // Suppressed opens (Deepika, 2026-11-20 — "close this slot"
  // really deletes it): computed opens a manager closed stay
  // closed — they subtract from the visible total until the next
  // draft/publish of this date+type pulls them back.
  const suppressed = await suppressedTotal(query as any, companyId, date, shiftTypeId);
  // Filled = stored shifts PLUS rotation-drawn holders (Deepika,
  // 2026-11-19 — audit B sharpening, same as the gate: the grid
  // shows stored + drawn holders, so the approval-time re-check
  // must count both, or a closeCount larger than the real opens
  // would over-close into the extra pool). Falls back to the
  // stored-only count when the drawn read fails.
  let filled: number;
  try {
    const { getShiftsForRange } = await import('./shiftRange.js');
    const drawn = await getShiftsForRange(query, companyId, date, date);
    filled = drawn.filter((e: any) => e.shiftTypeId === shiftTypeId).length;
  } catch (drawErr: any) {
    console.error('[plan-executor] drawn-holders read failed, using stored shifts only:', drawErr?.message);
    const { rows: frows } = await query(
      'SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
      [companyId, date, shiftTypeId]
    );
    filled = frows[0]?.n || 0;
  }
  return { total: Math.max(0, target + extra - filled - suppressed), closed: false, filled, raw: target + extra - filled - suppressed };
}

/**
 * Adjust extra_open_slots by `delta` — positive only, since
 * 2026-11-20 (Deepika — "when it says close slot it goes away
 * permanently"): closes never write a negative row any more, they
 * go through closeOpenSlots (src/util/openSlots.ts), which really
 * deletes stored extras and suppresses the shortfall. The row is
 * deleted when the adjustment lands exactly on 0 (CHECK count <> 0,
 * migration 020), and the read + write run in one transaction with a
 * row lock so two simultaneous adjustments can't interleave.
 */
async function adjustExtraOpenSlots(companyId: string, date: string, shiftTypeId: string, delta: number, createdBy: string | null): Promise<void> {
  const { withTransaction } = await import('../db.js');
  await withTransaction(async (tx) => {
    const cur = await tx.query(
      'SELECT count FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 FOR UPDATE',
      [companyId, date, shiftTypeId]
    );
    const next = (cur.rows.length ? Number(cur.rows[0].count) : 0) + delta;
    if (next === 0) {
      await tx.query(
        'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
        [companyId, date, shiftTypeId]
      );
    } else {
      await tx.query(
        `INSERT INTO extra_open_slots (company_id, date, shift_type_id, count, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, date, shift_type_id)
         DO UPDATE SET count = extra_open_slots.count + EXCLUDED.count`,
        [companyId, date, shiftTypeId, delta, createdBy]
      );
    }
  });
}

/**
 * Open-slot grant for a person-shift delete (Deepika, 2026-11-20 —
 * "When i delete someones shift ... i delete someone it should
 * open empty slot"). Generalises the old group-only grant
 * (ensureOpenSlotForGroupDelete, 2026-11-13 — Bul/Swing): deleting
 * a person's shift must leave it as an empty open slot so someone
 * else can pick it up, not delete the whole shift.
 *
 * Called POST-delete, pre-grant. s = target + extra − filled (the
 * unclamped `raw` from openTotals). Grant g = max(0, count − s):
 * the visible opens after the grant are max(count, s) — exactly
 * `count` more than the opens the delete alone would leave
 * (s clamped at 0). Standard cases match the old group grant
 * exactly (s === 0 → grant count; s ≥ count → grant 0); absorption
 * cases (no-target multi-filled days, over-target days) grant more
 * so the deleted shift actually SHOWS. Never when the day is closed
 * for the type. Recomputing after the delete makes it idempotent:
 * a second delete on the same date/type sees the first grant and
 * adds nothing more than its own count. Returns the number granted.
 */
export async function ensureOpenSlotForDelete(
  companyId: string, date: string, shiftTypeId: string, createdBy: string | null, count = 1
): Promise<number> {
  try {
    const totals = await openTotals(companyId, date, shiftTypeId);
    if (totals.closed) return 0;
    const grant = Math.max(0, count - totals.raw);
    if (grant <= 0) return 0;
    await adjustExtraOpenSlots(companyId, date, shiftTypeId, grant, createdBy);
    return grant;
  } catch (err) {
    console.error('[plan-executor] delete open-slot grant failed:', (err as any)?.message);
    return 0;
  }
}

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
        if (!user) throw new Error(noExactMatch(change.person));
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
        if (!user) throw new Error(noExactMatch(change.person));
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
        results.push({ action: 'assign_recurring', success: true, dates, personDisplay: user.display, message: `Assigned ${user.display} to ${st.name} every ${change.intervalWeeks} weeks from ${change.startDate}${change.weekendsOff ? ' (weekdays only)' : ''} until ${change.untilDate} (${added} new, ${dates.length - added} already on)` });
      } else if (change.action === 'swap' && change.fromPerson && change.toPerson) {
        // Swap exchanges two people's shifts. Same-day swap uses `date`;
        // cross-date swap uses fromDate/toDate. Runs in one transaction so a
        // half-applied swap is impossible.
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        if (!fromUser) throw new Error(noExactMatch(change.fromPerson));
        if (!toUser) throw new Error(noExactMatch(change.toPerson));
        const fromDate = change.fromDate || change.date;
        const toDate = change.toDate || change.date;
        if (!fromDate || !toDate) throw new Error('Swap needs a date (or fromDate/toDate).');
        const fromSide = await resolveSwapSide(companyId, fromUser.id, fromDate, change.shiftType);
        if (!fromSide) throw new Error(noShiftFoundMsg(fromUser.display, fromDate, change.shiftType));
        const toSide = await resolveSwapSide(companyId, toUser.id, toDate, change.shiftType);
        const fromTypeName = fromSide.kind === 'manual' ? fromSide.row.shift_type_name : fromSide.shiftTypeName;
        const fromRot = fromSide.kind === 'rotation' ? ' (rotation day)' : '';
        const toTypeName = toSide ? (toSide.kind === 'manual' ? toSide.row.shift_type_name : toSide.shiftTypeName) : null;
        const toRot = toSide && toSide.kind === 'rotation' ? ' (rotation day)' : '';
        // Conflict guard (Deepika 2026-11-01): never apply a swap
        // that double-books someone or leaves them under 8 hours of
        // rest — skip it and report it failed with the reason, even
        // when the plan was approved. Re-checked live here because
        // the schedule may have changed since the plan was written.
        const conflictReason = await swapConflictReason(companyId, fromUser, toUser, fromSide, toSide, fromDate, toDate);
        if (conflictReason) throw new Error(`Swap not applied — ${conflictReason}`);
        const { withTransaction } = await import('../db.js');
        await withTransaction(async (tx) => {
          // Remove fromUser's shift: delete a manual row, or exclude a
          // rotation day (the rotation pattern itself is untouched).
          // Dual-source (Deepika, 2026-11-12): a manual row suppresses
          // the rotation occurrence in the draw, so a person can hold
          // the same shift twice. Deleting the row alone lets the
          // occurrence pop back — exclude it too.
          if (fromSide.kind === 'manual') {
            const del = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [fromSide.row.id, companyId]);
            if (del.rowCount === 0) throw new Error(`Could not remove ${fromUser.display}'s shift on ${fromDate} — it may have changed.`);
            await excludeRotationInstances(companyId, fromUser.id, fromDate, tx.query);
          } else {
            const ins = await tx.query(
              `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
              [companyId, fromSide.rotationId, fromUser.id, fromDate, fromSide.shiftTypeId]
            );
            if (ins.rowCount === 0) throw new Error(`${fromUser.display}'s shift on ${fromDate} may have changed — please review and try again.`);
          }
          if (toSide) {
            // Remove toUser's shift the same way, then hand each person
            // the other's shift: toUser covers fromDate, fromUser covers
            // toDate (same-day swaps: both on that date).
            if (toSide.kind === 'manual') {
              const del = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [toSide.row.id, companyId]);
              if (del.rowCount === 0) throw new Error(`Could not remove ${toUser.display}'s shift on ${toDate} — it may have changed.`);
              await excludeRotationInstances(companyId, toUser.id, toDate, tx.query);
            } else {
              const ins = await tx.query(
                `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
                 VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
                [companyId, toSide.rotationId, toUser.id, toDate, toSide.shiftTypeId]
              );
              if (ins.rowCount === 0) throw new Error(`${toUser.display}'s shift on ${toDate} may have changed — please review and try again.`);
            }
          }
          // toUser receives fromUser's shift as a manual row. When there
          // was no shift to exchange, this is the move: toUser covers it
          // on toDate instead of fromDate.
          const fromTypeId = fromSide.kind === 'manual' ? fromSide.row.shift_type_id : fromSide.shiftTypeId;
          const coverDate = toSide ? fromDate : toDate;
          const ins2 = await tx.query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), companyId, toUser.id, fromTypeId, coverDate, fromSide.kind === 'manual' ? fromSide.row.notes : null, fromSide.kind === 'manual' ? fromSide.row.published : true, createdBy]
          );
          if (ins2.rowCount === 0) throw new Error(`Could not place ${toUser.display} on ${fromTypeName} on ${coverDate} — conflicting shift exists.`);
          // fromUser receives toUser's shift (exchange only).
          if (toSide) {
            const toTypeId = toSide.kind === 'manual' ? toSide.row.shift_type_id : toSide.shiftTypeId;
            const ins3 = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [crypto.randomUUID(), companyId, fromUser.id, toTypeId, toDate, toSide.kind === 'manual' ? toSide.row.notes : null, toSide.kind === 'manual' ? toSide.row.published : true, createdBy]
            );
            if (ins3.rowCount === 0) throw new Error(`Could not place ${fromUser.display} on ${toTypeName} on ${toDate} — conflicting shift exists.`);
          }
        });
        // Report (Deepika, 2026-11-13): the stored rows this swap
        // removed — the approve path checks each vacated slot for a
        // draft the removal left behind.
        const removedSlots: Array<{ userId: string; date: string; shiftTypeId: string }> = [];
        if (fromSide.kind === 'manual') removedSlots.push({ userId: fromUser.id, date: fromDate, shiftTypeId: fromSide.row.shift_type_id });
        if (toSide && toSide.kind === 'manual') removedSlots.push({ userId: toUser.id, date: toDate, shiftTypeId: toSide.row.shift_type_id });
        if (!toSide) {
          results.push({ action: 'swap', success: true, removedSlots, message: `Moved ${fromUser.display}'s ${fromTypeName}${fromRot} on ${fromDate} to ${toUser.display} on ${toDate} (${toUser.display} had no shift to swap)` });
        } else {
          const sameDay = fromDate === toDate;
          results.push({
            action: 'swap', success: true, removedSlots,
            message: sameDay
              ? `Swapped ${fromUser.display} (${fromTypeName}${fromRot}) ↔ ${toUser.display} (${toTypeName}${toRot}) on ${fromDate}`
              : `Swapped ${fromUser.display}'s ${fromTypeName}${fromRot} on ${fromDate} ↔ ${toUser.display}'s ${toTypeName}${toRot} on ${toDate}`,
          });
        }
      } else if (change.action === 'unassign' && change.person && change.date) {
        const user = await findUser(companyId, change.person);
        if (!user) throw new Error(noExactMatch(change.person));
        let q = 'DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3';
        const params: any[] = [companyId, user.id, change.date];
        let shiftTypeId: string | null = null;
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { q += ' AND shift_type_id = $4'; params.push(st.id); shiftTypeId = st.id; }
        }
        q += ' RETURNING shift_type_id';
        const deleted = await query(q, params);
        if (deleted.rowCount === 0) {
          // No direct shift row — the visible entry is rotation-generated, so
          // exclude the rotation instance(s) for that date instead. This
          // stays TYPE-SCOPED on purpose (Deepika, 2026-11-13 — widened
          // sweep): no stored shift was removed here, so there is nothing
          // to "delete completely" — the person's other rotation
          // occurrences that day are theirs to keep. The shared
          // excludeRotationInstances sweeps all types, which is exactly
          // wrong here, so the exclusion is inserted directly.
          const occ = await findRotationOccurrences(companyId, user.id, change.date, shiftTypeId);
          let excluded = 0;
          const excludedByType = new Map<string, number>();
          for (const o of occ) {
            const ins = await query(
              `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
              [companyId, o.rotationId, user.id, change.date, o.shiftTypeId]
            );
            if (ins.rowCount) {
              excluded += ins.rowCount;
              excludedByType.set(o.shiftTypeId, (excludedByType.get(o.shiftTypeId) || 0) + 1);
            }
          }
          if (excluded > 0) {
            // Delete opens a slot (Deepika, 2026-11-20): the excluded
            // occurrence leaves its shift as an empty open slot, same
            // as a stored-row unassign above.
            let slotNote = '';
            for (const [stId, n] of excludedByType) {
              await ensureOpenSlotForDelete(companyId, change.date as string, stId, createdBy, n);
              const after = await openTotals(companyId, change.date as string, stId);
              if (!after.closed && after.total >= 1) {
                const { rows: nm } = await query('SELECT name FROM shift_types WHERE id = $1 AND company_id = $2', [stId, companyId]);
                const typeName = nm[0]?.name || change.shiftType || 'shift';
                slotNote += ` — leaves ${after.total} open ${typeName} slot${after.total === 1 ? '' : 's'} on ${change.date}`;
              }
            }
            results.push({
              action: 'unassign', success: true,
              message: `Removed ${user.display} from ${change.date} (rotation day)${slotNote}`,
            });
          } else {
            results.push({
              action: 'unassign', success: false,
              message: `No shift found for ${user.display} on ${change.date} to remove.`,
            });
          }
        } else {
          // Dual-source (Deepika, 2026-11-12): the deleted row may have
          // been suppressing a rotation occurrence for the same
          // person/date/type. Exclude it too, or it pops back the moment
          // the row is gone.
          await excludeRotationInstances(companyId, user.id, change.date);
          const removedSlots = (deleted.rows || []).map((r: any) => ({ userId: user.id, date: change.date as string, shiftTypeId: r.shift_type_id }));
          // Delete opens a slot (Deepika, 2026-11-20): every removed
          // person-shift leaves one open slot for its date+type.
          // Grouped per (date, type) so an unassign that spans types
          // grants once per type; the parenthetical names the slot
          // whenever the day shows one open afterwards (grant or
          // natural rise from the target), never on a closed day.
          let slotNote = '';
          {
            const byPair = new Map<string, { count: number; shiftTypeId: string }>();
            for (const s of removedSlots) {
              const k = `${s.date}|${s.shiftTypeId}`;
              const e = byPair.get(k) || { count: 0, shiftTypeId: s.shiftTypeId };
              e.count += 1;
              byPair.set(k, e);
            }
            for (const [, e] of byPair) {
              await ensureOpenSlotForDelete(companyId, change.date as string, e.shiftTypeId, createdBy, e.count);
              const after = await openTotals(companyId, change.date as string, e.shiftTypeId);
              if (!after.closed && after.total >= 1) {
                const { rows: nm } = await query('SELECT name FROM shift_types WHERE id = $1 AND company_id = $2', [e.shiftTypeId, companyId]);
                const typeName = nm[0]?.name || change.shiftType || 'shift';
                slotNote += ` — leaves ${after.total} open ${typeName} slot${after.total === 1 ? '' : 's'} on ${change.date}`;
              }
            }
          }
          results.push({ action: 'unassign', success: true, removedSlots, message: `Removed ${user.display} from ${change.date}${slotNote}` });
        }
      } else if (change.action === 'move' && change.fromPerson && change.toPerson && (change.date || change.fromDate)) {
        // Move = unassign fromPerson + assign toPerson (same shift
        // type). The source side resolves exactly like a swap side
        // (resolveSwapSide): a stored row is deleted; a ROTATION-drawn
        // occurrence is excluded for fromPerson and re-created as a
        // stored row for toPerson (Deepika, 2026-11-10 — previously
        // move threw "rotation-generated shifts need the scheduler",
        // so even a perfectly-named plan could not move a rotation
        // day, while unassign/swap already handled them). One
        // transaction so a half-applied move is impossible.
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        if (!fromUser) throw new Error(noExactMatch(change.fromPerson));
        if (!toUser) throw new Error(noExactMatch(change.toPerson));
        const date = (change.date || change.fromDate)!;
        const side = await resolveSwapSide(companyId, fromUser.id, date, change.shiftType);
        if (!side) throw new Error(noShiftFoundMsg(fromUser.display, date, change.shiftType));
        const typeId = side.kind === 'manual' ? side.row.shift_type_id : side.shiftTypeId;
        const typeName = side.kind === 'manual' ? side.row.shift_type_name : side.shiftTypeName;
        const { withTransaction } = await import('../db.js');
        await withTransaction(async (tx) => {
          if (side.kind === 'manual') {
            const del = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [side.row.id, companyId]);
            if (del.rowCount === 0) throw new Error(`Could not remove ${fromUser.display}'s shift on ${date} — it may have changed.`);
            // Dual-source (Deepika, 2026-11-12): see the swap above —
            // exclude any rotation occurrence the deleted row was hiding.
            await excludeRotationInstances(companyId, fromUser.id, date, tx.query);
          } else {
            const ins = await tx.query(
              `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
              [companyId, side.rotationId, fromUser.id, date, side.shiftTypeId]
            );
            if (ins.rowCount === 0) throw new Error(`${fromUser.display}'s shift on ${date} may have changed — please review and try again.`);
          }
          const ins2 = await tx.query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), companyId, toUser.id, typeId, date,
             side.kind === 'manual' ? side.row.notes : null,
             side.kind === 'manual' ? side.row.published : true, createdBy]
          );
          if (ins2.rowCount === 0) throw new Error(`Could not place ${toUser.display} on ${typeName} on ${date} — conflicting shift exists.`);
        });
        results.push({
          action: 'move', success: true,
          removedSlots: side.kind === 'manual'
            ? [{ userId: fromUser.id, date, shiftTypeId: side.row.shift_type_id }] : [],
          message: `Moved ${fromUser.display} → ${toUser.display} on ${date}${side.kind === 'rotation' ? ' (rotation day)' : ''}`,
        });
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
        // 004_names.sql contract: new writes set first_name, last_name,
        // AND name. The AI can never supply a password, so the new member
        // gets an unusable hash (mirroring the manual invite flow) and
        // email stays NULL when the plan supplies none (migration 116) —
        // no login until invited, exactly like a manually added member.
        const passwordHash = await unusablePasswordHash();
        await query(
          `INSERT INTO users (id, company_id, first_name, last_name, name, email, department_id, job_role_id, password_hash, role, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'employee', true)`,
          [memberId, companyId, change.firstName.trim(), change.lastName.trim(),
           `${change.firstName.trim()} ${change.lastName.trim()}`,
           change.email ? change.email.trim() : null, deptId, roleId, passwordHash]
        );
        results.push({ action: 'add_team_member', success: true, message: `Added team member ${change.firstName} ${change.lastName}${change.department ? ` to ${change.department}` : ''}` });
      } else if (change.action === 'update_team_member' && change.person) {
        const member = await findMember(companyId, change.person);
        if (!member) throw new Error(noExactMatch(change.person));
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
      } else if (change.action === 'change_member_role_in_department' && change.person && change.department && change.jobRoleName) {
        // Per-department role change (Deepika, 2026-11-19 — "Can i change
        // role later?" + "add this to the list of things AI can do"): the
        // job role in ONE specific department, on instruction. The named
        // department is the person's HOME department → users.job_role_id;
        // a pulled-in department → the membership row. The person must
        // be a member of that department (home or pulled-in), and the
        // role must belong to that department — the old role never
        // carries over. Scoping is enforced here (canEditDepartment),
        // unlike update_team_member above, whose direct UPDATE has no
        // department-access check (flagged 2026-11-19, not repeated).
        const member = await findMember(companyId, change.person);
        if (!member) throw new Error(noExactMatch(change.person));
        const dept = await findDepartment(companyId, change.department);
        if (!dept) throw new Error(`Department not found: ${change.department}`);
        if (!(await canEditDepartment(companyId, createdBy, dept.id))) {
          throw new Error(`You don't have edit access to ${dept.name} — a scheduler can only change roles in departments they administer.`);
        }
        const { rows: roleRows } = await query(
          'SELECT id, name FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
          [companyId, dept.id, change.jobRoleName.trim()]
        );
        if (!roleRows.length) throw new Error(`Job role not found in ${dept.name}: ${change.jobRoleName}`);
        const role = roleRows[0];
        const { rows: urows } = await query(
          'SELECT department_id FROM users WHERE id = $1 AND company_id = $2',
          [member.id, companyId]
        );
        if (String(urows[0]?.department_id || '') === dept.id) {
          await query('UPDATE users SET job_role_id = $1 WHERE id = $2', [role.id, member.id]);
        } else {
          const { rows: mrows } = await query(
            'SELECT id FROM user_department_memberships WHERE user_id = $1 AND company_id = $2 AND department_id = $3',
            [member.id, companyId, dept.id]
          );
          if (!mrows.length) throw new Error(`${member.display} is not a team member of ${dept.name} yet — pull them in first.`);
          await query(
            'UPDATE user_department_memberships SET job_role_id = $1 WHERE user_id = $2 AND company_id = $3 AND department_id = $4',
            [role.id, member.id, companyId, dept.id]
          );
        }
        results.push({
          action: 'change_member_role_in_department', success: true,
          message: `Changed ${member.display}'s job role in ${dept.name} to ${role.name}`,
          personDisplay: member.display,
        });
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
            [stId, companyId, change.shiftType.trim(), '#7fc8bc', dept.id]
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
      } else if (change.action === 'add_rotation' && change.person && change.shiftType && change.startDate) {
        // Per-person rotation (Deepika, 2026-11-17): mirrors the
        // manual Settings → Rotations create exactly — same rows
        // (rotations + one rotation_assignments row per pattern day),
        // same validation, same defaults. Group rotations and pairing
        // are NOT covered: this is one person, one shift type, one
        // repeating pattern. No eligibility gate — the manual flow
        // has none (known open gap, flagged 2026-11-14). Times come
        // from the shift type's Settings times, as the manual form
        // pulls them on the type pick (Deepika, 2026-11-09).
        const member = await findMember(companyId, change.person);
        if (!member) throw new Error(noExactMatch(change.person));
        const st = await findShiftType(companyId, change.shiftType);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const { cycleDays, days } = resolveRotationPattern(change);
        const { rows: trows } = await query(
          'SELECT start_time, end_time FROM shift_types WHERE id = $1 AND company_id = $2',
          [st.id, companyId]
        );
        const rotStartTime = trows[0]?.start_time || null;
        const rotEndTime = trows[0]?.end_time || null;
        const endDate = change.endDate && /^\d{4}-\d{2}-\d{2}$/.test(String(change.endDate))
          && String(change.endDate) >= String(change.startDate) ? String(change.endDate) : null;
        const rotName = (change.rotationName || '').trim() || `${member.display} — ${st.name}`;
        const rotId = crypto.randomUUID();
        await query(
          `INSERT INTO rotations (id, company_id, name, cycle_days, start_date, created_by, start_time, end_time, notes,
                                  group_id, group_ids, group_shift_type_id, group_days, turn_unit, turn_days, week_start, end_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
          [rotId, companyId, rotName, cycleDays, change.startDate, createdBy, rotStartTime, rotEndTime, null,
           null, null, null, null, null, null, null, endDate]
        );
        let insertFailed = false;
        for (const d of days) {
          try {
            await query(
              `INSERT INTO rotation_assignments (id, rotation_id, user_id, cycle_day, shift_type_id)
               VALUES ($1, $2, $3, $4, $5)`,
              [crypto.randomUUID(), rotId, member.id, d, st.id]
            );
          } catch { insertFailed = true; break; }
        }
        if (insertFailed) {
          // Roll the whole create back — a half-saved pattern is the
          // same silent trap the manual route guards against.
          await query('DELETE FROM rotations WHERE id = $1', [rotId]);
          throw new Error('Could not save the rotation pattern — the person or shift type no longer exists.');
        }
        const wds = Array.isArray(change.weekdays) ? change.weekdays : null;
        const patternText = wds && wds.length
          ? `${wds.map((w: number) => weekdayShort(w)).join(', ')} every ${change.cycleWeeks && Number(change.cycleWeeks) > 1 ? `${change.cycleWeeks} weeks` : 'week'}`
          : `cycle days ${days.join(', ')} of a ${cycleDays}-day cycle`;
        results.push({
          action: 'add_rotation', success: true,
          message: `Created rotation "${rotName}" — ${patternText} from ${change.startDate}${endDate ? ` until ${endDate}` : ''}`,
        });
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
        // Publishing the day publishes the opens with it (Deepika,
        // 2026-11-20): remember which (date, type) pairs actually
        // flip from draft, so their draft opens + closures can go
        // with them. Unpublish leaves the opens alone — the draft is
        // what marks opens draft, and a re-draft re-derives them.
        let flipPairs: Array<{ date: string; shiftTypeId: string }> = [];
        if (publish) {
          const { rows: fr } = await query(
            `SELECT DISTINCT date::text AS date, shift_type_id AS "shiftTypeId" FROM shifts
             WHERE company_id = $1 AND date >= $2 AND date <= $3 AND published = false
             ${shiftTypeId ? 'AND shift_type_id = $4' : ''}`,
            shiftTypeId
              ? [companyId, change.fromDate, change.toDate, shiftTypeId]
              : [companyId, change.fromDate, change.toDate]
          );
          flipPairs = fr.map((r: any) => ({ date: r.date, shiftTypeId: r.shiftTypeId }));
        }
        const updated = await query(q, params);
        const count = updated.rowCount || 0;
        if (publish && flipPairs.length) {
          const generated = await getGeneratedTypeIds(query as any, companyId);
          await publishOpenSlotsForPairs(query as any, companyId, flipPairs, generated);
        }
        results.push({
          action: change.action, success: true,
          message: `${publish ? 'Published' : 'Moved to draft'} ${count} shift(s) from ${change.fromDate} to ${change.toDate}${shiftTypeId ? ` (${change.shiftType})` : ''}`
        });
      } else if (change.action === 'close_open_slots' && change.shiftType && (change.date || (change.fromDate && change.toDate))) {
        // Close open slots (Deepika, 2026-11-19 — walkthrough item 1):
        // the AI's first way to touch open slots. Only ever closes
        // EMPTY slots — the write only ever touches extra_open_slots
        // (a stored extra row is really deleted), suppressed_open_
        // slots (a computed shortfall open, closed until the next
        // draft/publish pulls it back) and closed_shifts; no stored
        // shift row is ever deleted, so no person is ever removed.
        // No negative extra row is ever written (Deepika, 2026-11-20
        // — "when it says close slot it goes away permanently").
        // Exactly one mode: closeCount (close N per date), keepCount
        // (keep N per date, close the rest), or closeAll (close the
        // whole type for the date — the shared closeTypeForDate
        // helper really deletes every stored row and sets the flag;
        // Deepika, 2026-11-20 — "close any where it should be gone").
        const st = await findShiftType(companyId, change.shiftType);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        // Department (Deepika, 2026-11-19 — "It needs to know which
        // department and which shift"): the close is for ONE
        // department. Re-resolved at approval time — a plan written
        // before this build carries no department, so default from
        // the type's departments when there is exactly one; refuse
        // when the type spans several or none. Access is enforced
        // here (canEditDepartment): a scheduler may only close slots
        // in departments they administer. The gate cannot check
        // this — it never sees the requester. The write itself still
        // hits the shared type+date pool (staffing_targets /
        // extra_open_slots / closed_shifts have no department
        // column), exactly like the manual close — the department
        // scopes who may close and labels the close, it does not
        // split the pool.
        const closeDeptIds = await shiftTypesDepartmentIds([st.id], companyId);
        const { rows: closeDeptRows } = await query(
          'SELECT id, name FROM departments WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY name',
          [companyId, closeDeptIds]
        );
        const closeTypeDepts = closeDeptRows.map((r: any) => ({ id: r.id, name: r.name }));
        let closeDept: { id: string; name: string } | null = null;
        if (change.department && String(change.department).trim()) {
          closeDept = await findDepartment(companyId, change.department);
          if (!closeDept) throw new Error(`Department not found: ${change.department}`);
          if (!closeTypeDepts.some((d) => d.id === closeDept!.id)) {
            const where = closeTypeDepts.length
              ? `${st.name} belongs to ${closeTypeDepts.map((d) => d.name).join(' and ')}`
              : `${st.name} isn't assigned to any department yet`;
            throw new Error(`${st.name} isn't part of ${closeDept.name} — ${where}.`);
          }
        } else if (closeTypeDepts.length === 1) {
          closeDept = closeTypeDepts[0];
        }
        if (!closeDept) {
          throw new Error(`Which department should I close the open ${st.name} slots in? It belongs to ${closeTypeDepts.map((d) => d.name).join(' and ')} — name one.`);
        }
        if (!(await canEditDepartment(companyId, createdBy, closeDept.id))) {
          throw new Error(`You don't have edit access to ${closeDept.name} — a scheduler can only close slots in departments they administer.`);
        }
        const modes = [
          change.closeAll === true ? 'all' : null,
          typeof change.keepCount === 'number' ? 'keep' : null,
          typeof change.closeCount === 'number' ? 'count' : null,
        ].filter(Boolean) as string[];
        if (modes.length !== 1) {
          throw new Error(`Say how many open ${st.name} slots to close — a number, "keep N", or the whole type for the day.`);
        }
        const mode = modes[0];
        if (mode === 'count' && !(Number.isInteger(change.closeCount) && (change.closeCount as number) >= 1)) {
          throw new Error(`Close how many open ${st.name} slots? Give a whole number of 1 or more.`);
        }
        if (mode === 'keep' && !(Number.isInteger(change.keepCount) && (change.keepCount as number) >= 0)) {
          throw new Error(`Keep how many open ${st.name} slots? Give a whole number of 0 or more.`);
        }
        const first = String(change.date || change.fromDate);
        const last = String(change.toDate || change.date || change.fromDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || first > last) {
          throw new Error(`Give a valid date or date range to close ${st.name} slots for.`);
        }
        const dates: string[] = [];
        {
          let cur = first;
          while (cur <= last && dates.length < 400) {
            dates.push(cur);
            const dd = new Date(cur + 'T00:00:00Z');
            dd.setUTCDate(dd.getUTCDate() + 1);
            cur = dd.toISOString().slice(0, 10);
          }
          if (cur <= last) throw new Error('That date range is too long — pick a range under a year.');
        }
        let slotsClosed = 0;
        let daysClosed = 0;
        const skipped: string[] = [];
        for (const d of dates) {
          const t = await openTotals(companyId, d, st.id);
          if (mode === 'all') {
            if (t.closed) { skipped.push(`${d} (already closed)`); continue; }
            // A close-all that would close nothing is a no-op the
            // gate refuses at plan time (Deepika, 2026-11-19 — Dec 2
            // formed a plan despite no open slots shown): at
            // approval time the same rule applies — skip the empty
            // day instead of writing a closed_shifts row for it,
            // and fail honestly when nothing closed anywhere.
            if (t.total <= 0) { skipped.push(`${d} (no open slots)`); continue; }
            // Whole-type close (Deepika, 2026-11-20 — "when i say
            // close any where it should be gone"): the shared helper
            // really deletes every stored row for the date+type
            // (extras, draft opens, suppressed rows) and sets the
            // closed flag — the same write the Bulk Actions close
            // and the day dialog make. Same-brain: both doors.
            const closed = await closeTypeForDate(query as any, companyId, d, st.id, createdBy);
            if (closed.flagSet) { daysClosed++; slotsClosed += t.total; }
            else skipped.push(`${d} (already closed)`);
          } else {
            const want = mode === 'count'
              ? Math.min(change.closeCount as number, t.total)
              : Math.max(0, t.total - (change.keepCount as number));
            if (want <= 0) {
              skipped.push(t.closed
                ? `${d} (closed for ${st.name})`
                : `${d} (no open slots${mode === 'keep' ? ` over ${change.keepCount}` : ''})`);
              continue;
            }
            // The close runs in its own transaction (row lock on the
            // extra row, same as the old adjustExtraOpenSlots write).
            await withTransaction(async (tx) => {
              await closeOpenSlots(tx.query, companyId, d, st.id, want, createdBy);
            });
            slotsClosed += want;
          }
        }
        const range = dates.length > 1 ? `, ${first} – ${last}` : ` on ${first}`;
        if (mode === 'all') {
          if (daysClosed === 0) {
            results.push({ action: change.action, success: false, message: skipped.length
              ? `No open ${st.name} slots to close in ${closeDept.name}${range.replace(/^, /, ' for ')} — ${skipped.join('; ')}.`
              : `${st.name} is already closed in ${closeDept.name}${range.replace(/^, /, ' for ')}.` });
          } else {
            results.push({ action: change.action, success: true, message: `Closed ${st.name} in ${closeDept.name}${range} (${slotsClosed} open slot${slotsClosed === 1 ? '' : 's'} closed; only empty slots are closed)${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}` });
          }
        } else if (slotsClosed === 0) {
          results.push({ action: change.action, success: false, message: `No open ${st.name} slots to close in ${closeDept.name}${range.replace(/^, /, ' for ')}${skipped.length ? ` — ${skipped.join('; ')}` : ''}.` });
        } else {
          results.push({
            action: change.action, success: true,
            message: `Closed ${slotsClosed} open ${st.name} slot${slotsClosed === 1 ? '' : 's'} in ${closeDept.name}${mode === 'keep' ? ` (kept ${change.keepCount} per day)` : ''}${range}${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}`,
          });
        }
      } else if (change.action === 'add_open_slots' && change.shiftType && (change.date || (change.fromDate && change.toDate))) {
        // Add open slots (Deepika, 2026-11-19 — "Can you add 3 open
        // slots for day hospitalists for nov month"): the mirror of
        // the close above, and the opposite write — a POSITIVE
        // adjustment to extra_open_slots, so the computed opens grow
        // by addCount per date. Only ever adds EMPTY slots: no
        // stored shift row is ever created or touched, so no person
        // is ever assigned. Department resolution + access check are
        // the close's, verbatim: the department scopes WHO may add
        // and labels the add; the pool itself (extra_open_slots,
        // keyed company+date+type) is shared. A date already CLOSED
        // for the type is skipped — the add would be invisible
        // there — and a plan whose every date is closed fails
        // honestly instead of silently adding nothing.
        const st = await findShiftType(companyId, change.shiftType);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const addDeptIds = await shiftTypesDepartmentIds([st.id], companyId);
        const { rows: addDeptRows } = await query(
          'SELECT id, name FROM departments WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY name',
          [companyId, addDeptIds]
        );
        const addTypeDepts = addDeptRows.map((r: any) => ({ id: r.id, name: r.name }));
        let addDept: { id: string; name: string } | null = null;
        if (change.department && String(change.department).trim()) {
          addDept = await findDepartment(companyId, change.department);
          if (!addDept) throw new Error(`Department not found: ${change.department}`);
          if (!addTypeDepts.some((d) => d.id === addDept!.id)) {
            const where = addTypeDepts.length
              ? `${st.name} belongs to ${addTypeDepts.map((d) => d.name).join(' and ')}`
              : `${st.name} isn't assigned to any department yet`;
            throw new Error(`${st.name} isn't part of ${addDept.name} — ${where}.`);
          }
        } else if (addTypeDepts.length === 1) {
          addDept = addTypeDepts[0];
        }
        if (!addDept) {
          throw new Error(`Which department should I add the open ${st.name} slots in? It belongs to ${addTypeDepts.map((d) => d.name).join(' and ')} — name one.`);
        }
        if (!(await canEditDepartment(companyId, createdBy, addDept.id))) {
          throw new Error(`You don't have edit access to ${addDept.name} — a scheduler can only add slots in departments they administer.`);
        }
        // Exactly one amount mode (Deepika, 2026-11-20 — top-up):
        // addCount (add N per date) or targetTotal (top up so the
        // total — filled + open — reaches N per date). The gate
        // checks first; this is the approval-time backstop.
        const addModes = [
          typeof change.addCount === 'number' ? 'count' : null,
          typeof change.targetTotal === 'number' ? 'total' : null,
        ].filter(Boolean) as string[];
        if (addModes.length !== 1) {
          throw new Error(`Say how many open ${st.name} slots to add per date — a number, or a total to reach.`);
        }
        const addMode = addModes[0];
        if (addMode === 'count' && !(Number.isInteger(change.addCount) && (change.addCount as number) >= 1 && (change.addCount as number) <= 20)) {
          throw new Error(`Add how many open ${st.name} slots per date? Give a whole number from 1 to 20.`);
        }
        if (addMode === 'total' && !(Number.isInteger(change.targetTotal) && (change.targetTotal as number) >= 1)) {
          throw new Error(`What total should ${st.name} reach per date? Give a whole number of 1 or more.`);
        }
        const first = String(change.date || change.fromDate);
        const last = String(change.toDate || change.date || change.fromDate);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !/^\d{4}-\d{2}-\d{2}$/.test(last) || first > last) {
          throw new Error(`Give a valid date or date range to add ${st.name} slots for.`);
        }
        const dates: string[] = [];
        {
          let cur = first;
          while (cur <= last && dates.length < 400) {
            dates.push(cur);
            const dd = new Date(cur + 'T00:00:00Z');
            dd.setUTCDate(dd.getUTCDate() + 1);
            cur = dd.toISOString().slice(0, 10);
          }
          if (cur <= last) throw new Error('That date range is too long — pick a range under a year.');
        }
        const { rows: closedRows } = await query(
          `SELECT date::text AS date FROM closed_shifts
           WHERE company_id = $1 AND shift_type_id = $2 AND date >= $3 AND date <= $4`,
          [companyId, st.id, first, last]
        );
        const closedSet = new Set(closedRows.map((r: any) => r.date));
        let slotsAdded = 0;
        const skipped: string[] = [];
        for (const d of dates) {
          if (closedSet.has(d)) { skipped.push(`${d} (closed for ${st.name})`); continue; }
          if (addMode === 'total') {
            // Top-up (Deepika, 2026-11-20 — "make it total 14"):
            // the delta is re-computed at approval time from the
            // live schedule (filled + open), never taken from the
            // plan — a date already at the target is skipped, and
            // a delta over 20 fails honestly instead of clamping.
            const t = await openTotals(companyId, d, st.id);
            const delta = Math.max(0, (change.targetTotal as number) - (t.filled + t.total));
            if (delta === 0) { skipped.push(`${d} (already at ${change.targetTotal} total)`); continue; }
            if (delta > 20) {
              throw new Error(`Adding open ${st.name} slots to reach ${change.targetTotal} per date would need ${delta} on ${d} — I can add at most 20 open slots per date.`);
            }
            await adjustExtraOpenSlots(companyId, d, st.id, delta, createdBy);
            slotsAdded += delta;
          } else {
            await adjustExtraOpenSlots(companyId, d, st.id, change.addCount as number, createdBy);
            slotsAdded += change.addCount as number;
          }
        }
        const range = dates.length > 1 ? `, ${first} – ${last}` : ` on ${first}`;
        if (slotsAdded === 0) {
          results.push({ action: change.action, success: false, message: addMode === 'total'
            ? `${st.name} is already at ${change.targetTotal} total in ${addDept.name}${range.replace(/^, /, ' for ')} — adding open slots there would do nothing${skipped.length ? ` — ${skipped.join('; ')}` : ''}.`
            : `${st.name} is already closed in ${addDept.name}${range.replace(/^, /, ' for ')} — adding open slots there would do nothing${skipped.length ? ` — ${skipped.join('; ')}` : ''}.` });
        } else {
          results.push({
            action: change.action, success: true,
            message: addMode === 'total'
              ? `Added ${slotsAdded} open ${st.name} slot${slotsAdded === 1 ? '' : 's'} in ${addDept.name} (topped up to ${change.targetTotal} total per date${range})${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}`
              : `Added ${slotsAdded} open ${st.name} slot${slotsAdded === 1 ? '' : 's'} in ${addDept.name} (${change.addCount} per date${range})${skipped.length ? ` — skipped: ${skipped.join('; ')}` : ''}`,
          });
        }
      } else if (change.action === 'add_session' && change.dashboard && change.title && change.date) {
        const dash = await findDashboard(companyId, change.dashboard);
        if (!dash) throw new Error(`Dashboard not found: ${change.dashboard}`);
        // EVENT model (2026-11-07): the organizing department
        // resolves from the creator's manageable departments on the
        // calendar; when that is ambiguous or empty it stays NULL
        // (inherit) rather than guessing. The presenter pick becomes
        // Speaker 1 via insertSession.
        const organizingDeptId = await resolveOrganizingDeptE(companyId, createdBy, dash.id);
        const presenter = change.presenter ? await findUser(companyId, change.presenter) : null;
        if (change.presenter && !presenter) throw new Error(noExactMatch(change.presenter));
        // A supervisor on the change is IGNORED, never an error:
        // supervisors were retired (Deepika, 2026-11-07), and a plan
        // written before that (or by the AI from an old email) must
        // still execute cleanly — it just sets no supervisor.
        if (!(await canEditSessionTarget(companyId, createdBy, dash.id, null))) {
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
          presenterId: presenter?.id ?? null,
          departmentId: organizingDeptId,
          location: change.location ? change.location.trim() : null,
          kindKey, notes: change.notes ? change.notes.trim() : null,
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
          if (change.presenter && !p) throw new Error(noExactMatch(change.presenter));
          f.presenterId = p?.id ?? null;
        }
        // change.supervisor is deliberately NOT applied (retired
        // 2026-11-07) — see the add_session note above. The rest of
        // the change still applies normally.
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
  // Warn-and-override record: a change that carried a role-rule warning was
  // approved with eyes open — note the override on its result message so
  // the post-approval record stays honest.
  for (let i = 0; i < (plan.changes || []).length; i++) {
    const w = (plan.changes[i] as any)?.warning;
    const r = results[i];
    if (w && r && r.success && r.message) r.message += ' (Role-rule warning overridden.)';
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
        if (people.length) await notify({
          companyId, userIds: people, category: 'calendar', type: 'session_assigned',
          title: `New session: "${change.title}" on ${fmtDateLong(change.date)}`,
          body: `You are on the session "${change.title}" (${change.dashboard}) on ${fmtDateLong(change.date)}${change.startTime ? ` at ${change.startTime}` : ''}.`,
          link: 'calendars', bundleKey: 'session_assigned', excludeUserId: createdBy,
        });
        if (!change.presenter) {
          // Session needs a speaker: tell the dashboard's department
          // members (digest-speed type — records in-app by default).
          // (Generic wording: the plan path doesn't resolve the
          // session type's person label.)
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
                title: `A session needs a speaker: "${change.title}" on ${fmtDateLong(change.date)}`,
                body: `"${change.title}" (${change.dashboard}) on ${fmtDateLong(change.date)} has no speaker yet.`,
                link: 'calendars', bundleKey: 'session_needs_presenter', excludeUserId: createdBy,
              });
            }
          }
        }
      } else if (change.action === 'update_session' && change.sessionTitle) {
        const ids = new Set<string>(sessionPeopleBefore.get(i) || []);
        if (change.presenter) { const p = await findUser(companyId, change.presenter); if (p) ids.add(p.id); }
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
