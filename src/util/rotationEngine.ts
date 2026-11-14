// util/rotationEngine.ts — background rotations (Deepika, 2026-11-13):
// ONE shared generator that turns any pattern (per-person AND group)
// into stored draft shifts.
//
// It adapts drawRotationOccurrences (schedule.ts) and getShiftsForRange
// (shiftRange.ts) — the same cycle math, the same line dealing, the
// same vacation / pause / exclusion / end-date rules — with the
// generation-only rules from the settled design:
//
//   D4 — generation SKIPS a date when the person already has a stored
//     shift that date (ANY type, not the draw's same-type manual
//     precedence), or a stored shift on an adjacent date that conflicts
//     by time (overlap or <8h rest — the overnight case, e.g. Swing
//     7 PM–7 AM then Day Hospitalist 7 AM–7 PM). A stored shift is one
//     that exists when the draft runs — including rows an earlier
//     rotation in the SAME draft action just wrote. Rotations are
//     processed group-first, then per-person (each in client order):
//     the group ("special") shift wins the day, exactly like the
//     draw's special-precedence pass, which this sequential check
//     subsumes — so there is no separate precedence pass here.
//   D4 — generation also skips vacation/pause dates, and group
//     patterns deal around vacation at generation time (same as the
//     draw). Previously-deleted instances are NOT a fixed skip: the
//     caller clears exclusions for a fresh re-draft, or keeps them
//     for a keep-changes re-draft (D1) — the engine just honours
//     whatever exclusions exist.
//   Keep-both (Nov 13) — skips are PER-PERSON only: a stored shift
//     for Bul never suppresses another person's occurrence. A
//     hand-added person and the rotation's person for the same day
//     both draft.
//   Rule 7 — a per-person pattern whose assignee has passed their
//     last working day produces OPEN slots (departed entries), never
//     silent disappearances. Group rotations are excluded: groups
//     re-deal their own turns (D8, recommendation (a)).
//   Past is truth — generation into the past is refused outright
//     (opts.allowPast is the migration-only exception, and it CREATES
//     history rather than changing it).
//
// The engine never reads the mode flag: it is mode-agnostic. The
// /generate endpoint refuses live-mode companies; the Stage 4
// migration tool calls generateRotation directly while still live.

import { withTransaction } from '../db.js';
import { getShiftTypeTimes, makeTimedShift, findShiftConflict } from './shiftConflicts.js';
import type { AuditEntry } from './audit.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>;

export interface EngineOccurrence {
  userId: string;
  date: string;
  shiftTypeId: string;
  shiftTypeName: string;
  shiftTypeShort: string;
  shiftTypeColor: string;
  shiftTypeTextColor: string;
  sortOrder: number;
  firstName: string;
  lastName: string;
  nickname: string | null;
  rotationId: string;
  rotationName: string;
  published: boolean;
  /** True for group-rotation ("special") occurrences. */
  special: boolean;
}

export interface DepartedEntry {
  date: string;
  userId: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  shiftTypeId: string;
  shiftTypeName: string;
  rotationId: string;
  rotationName: string;
  endDate: string;
}

export interface SkipCounts {
  vacation: number;
  alreadyHasShift: number;
  ended: number;
  excluded: number;
  past: number;
}

export interface SkipDetail {
  userId: string;
  personName: string;
  date: string;
  shiftTypeId: string;
  shiftTypeName: string;
  reason: keyof SkipCounts;
  detail?: string;
}

export interface RotationCompute {
  occurrences: EngineOccurrence[];
  departed: DepartedEntry[];
  skipped: SkipCounts;
  skippedDetail: SkipDetail[];
}

export interface GenerationContext {
  vacMap: Map<string, Array<{ start: string; end: string }>>;
  pauseMap: Map<string, Array<{ start: string; end: string }>>;
  exclSet: Set<string>;
  pubMap: Map<string, boolean>;
  typeTimes: Map<string, any>;
  assignmentsByRotation: Map<string, any[]>;
  membersByGroup: Map<string, any[]>;
  groupTypes: Map<string, any>;
}

const emptySkipped = (): SkipCounts => ({ vacation: 0, alreadyHasShift: 0, ended: 0, excluded: 0, past: 0 });

function dayNum(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}
function dateOfDayNum(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(dateStr: string, n: number): string {
  return dateOfDayNum(dayNum(dateStr) + n);
}

function personDisplay(a: any): string {
  return a.nickname || `${a.firstName || ''} ${a.lastName || ''}`.trim() || 'Team member';
}

/**
 * Shared context for one generate call (pauses, vacations, exclusions,
 * publish overrides, type times, members) — loaded once, reused for
 * every rotation in the call. Stored rows are NOT in the context:
 * they are re-queried per rotation so a rotation sees rows an
 * earlier rotation in the same transaction just wrote (D4).
 */
export async function loadGenerationContext(
  q: QueryFn, companyId: string, from: string, to: string,
  rotationIds: string[]
): Promise<GenerationContext> {
  const { rows: vacRows } = await q(
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
  const { rows: pauseRows } = await q(
    `SELECT rotation_id AS "rotationId", start_date::text AS "startDate", end_date::text AS "endDate"
     FROM rotation_pauses
     WHERE company_id = $1 AND end_date >= $2 AND start_date <= $3`,
    [companyId, from, to]
  );
  const pauseMap = new Map<string, Array<{ start: string; end: string }>>();
  for (const p of pauseRows) {
    if (!pauseMap.has(p.rotationId)) pauseMap.set(p.rotationId, []);
    pauseMap.get(p.rotationId)!.push({ start: p.startDate, end: p.endDate });
  }
  const { rows: exclRows } = await q(
    `SELECT rotation_id AS "rotationId", user_id AS "userId",
            date::text AS "date", shift_type_id AS "shiftTypeId"
     FROM rotation_shift_exclusions
     WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const exclSet = new Set(exclRows.map((e: any) =>
    `${e.rotationId}|${e.userId}|${e.date}|${e.shiftTypeId}`
  ));
  const { rows: pubRows } = await q(
    `SELECT rotation_id AS "rotationId", user_id AS "userId",
            date::text AS "date", shift_type_id AS "shiftTypeId", published
     FROM rotation_shift_publish
     WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const pubMap = new Map(pubRows.map((p: any) =>
    [`${p.rotationId}|${p.userId}|${p.date}|${p.shiftTypeId}`, p.published]
  ));
  const typeTimes = await getShiftTypeTimes(q, companyId);

  const assignmentsByRotation = new Map<string, any[]>();
  if (rotationIds.length) {
    const { rows: allAssignments } = await q(
      `SELECT ra.rotation_id AS "rotationId", ra.user_id AS "userId", ra.cycle_day AS "cycleDay",
              ra.shift_type_id AS "shiftTypeId",
              u.first_name AS "firstName", u.last_name AS "lastName", u.nickname,
              u.is_active AS "userActive", u.end_date::text AS "userEndDate",
              st.name AS "shiftTypeName", st.short_name AS "shiftTypeShort",
              st.color AS "shiftTypeColor", st.text_color AS "shiftTypeTextColor",
              st.sort_order AS "sortOrder"
       FROM rotation_assignments ra
       JOIN users u ON u.id = ra.user_id
       JOIN shift_types st ON st.id = ra.shift_type_id
       WHERE ra.rotation_id = ANY($1)`,
      [rotationIds]
    );
    for (const a of allAssignments) {
      if (!assignmentsByRotation.has(a.rotationId)) assignmentsByRotation.set(a.rotationId, []);
      assignmentsByRotation.get(a.rotationId)!.push(a);
    }
  }
  const { rows: rotations } = await q(
    `SELECT id, group_id AS "groupId", group_ids AS "groupIds",
            group_shift_type_id AS "groupShiftTypeId"
     FROM rotations WHERE company_id = $1 AND id = ANY($2::uuid[])`,
    [companyId, rotationIds]
  );
  const allGroupIds: string[] = [];
  const groupTypeIds = new Set<string>();
  for (const rot of rotations) {
    if ((rot as any).groupId && (rot as any).groupShiftTypeId) {
      groupTypeIds.add((rot as any).groupShiftTypeId);
      for (const gid of String((rot as any).groupIds || (rot as any).groupId)
        .split(',').map((x: string) => x.trim()).filter(Boolean)) {
        if (!allGroupIds.includes(gid)) allGroupIds.push(gid);
      }
    }
  }
  const membersByGroup = new Map<string, any[]>();
  if (allGroupIds.length) {
    const { rows: allMembers } = await q(
      `SELECT gm.group_id AS "groupId", gm.user_id AS "userId",
              u.first_name AS "firstName", u.last_name AS "lastName",
              u.nickname, u.end_date::text AS "userEndDate"
       FROM rotation_group_members gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ANY($1) AND u.is_active = true
       ORDER BY gm.group_id, gm.position`,
      [allGroupIds]
    );
    for (const m of allMembers) {
      if (!membersByGroup.has(m.groupId)) membersByGroup.set(m.groupId, []);
      membersByGroup.get(m.groupId)!.push(m);
    }
  }
  const groupTypes = new Map<string, any>();
  if (groupTypeIds.size) {
    const { rows: typeRows } = await q(
      `SELECT id, name AS "shiftTypeName", short_name AS "shiftTypeShort",
              color AS "shiftTypeColor", text_color AS "shiftTypeTextColor",
              sort_order AS "sortOrder"
       FROM shift_types WHERE id = ANY($1)`,
      [[...groupTypeIds]]
    );
    for (const t of typeRows) groupTypes.set(t.id, t);
  }
  return { vacMap, pauseMap, exclSet, pubMap, typeTimes, assignmentsByRotation, membersByGroup, groupTypes };
}

/** Stored rows for the company in [from-1, to+1] (the ±1 day feeds the
 *  adjacent-date conflict check). Re-queried per rotation so same-call
 *  inserts are visible. */
export async function loadStoredRows(
  q: QueryFn, companyId: string, from: string, to: string
): Promise<Array<{ userId: string; date: string; shiftTypeId: string }>> {
  const { rows } = await q(
    `SELECT user_id AS "userId", date::text AS date, shift_type_id AS "shiftTypeId"
     FROM shifts WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, addDays(from, -1), addDays(to, 1)]
  );
  return rows;
}

export interface ComputeOpts {
  /** 'draft' (all rows published=false) or 'published' (migration:
   *  published = override ?? true). */
  publishMode?: 'draft' | 'published';
  /** Collect rule-7 departed entries (per-person rotations only). */
  collectDeparted?: boolean;
  /** Company-today, for the departed window (defaults to UTC today). */
  today?: string;
}

/**
 * Compute one rotation's occurrences for [from, to] — the draw's math
 * with the generation rules. `storedRows` is the CURRENT stored state
 * (re-queried per rotation by the caller). Skips are counted with
 * reasons; nothing is written here.
 */
export function computeRotationOccurrences(
  ctx: GenerationContext,
  rot: any,
  from: string,
  to: string,
  storedRows: Array<{ userId: string; date: string; shiftTypeId: string }>,
  opts?: ComputeOpts
): RotationCompute {
  const skipped = emptySkipped();
  const skippedDetail: SkipDetail[] = [];
  const occurrences: EngineOccurrence[] = [];
  const departed: DepartedEntry[] = [];
  const publishMode = opts?.publishMode || 'draft';
  const today = opts?.today || from;

  const onVacation = (userId: string, dateStr: string): boolean => {
    const periods = ctx.vacMap.get(userId);
    if (!periods) return false;
    return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
  };
  const isPaused = (rotationId: string, dateStr: string): boolean => {
    const periods = ctx.pauseMap.get(rotationId);
    if (!periods) return false;
    return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
  };
  const skip = (
    userId: string, personName: string, date: string, shiftTypeId: string, shiftTypeName: string,
    reason: keyof SkipCounts, detail?: string
  ) => {
    skipped[reason]++;
    if (skippedDetail.length < 200) {
      skippedDetail.push({ userId, personName, date, shiftTypeId, shiftTypeName, reason, detail });
    }
  };
  // D4: the person already has a stored shift that date (ANY type),
  // or a stored shift on an adjacent date that conflicts by time
  // (overlap or <8h rest — the overnight case). Returns the
  // conflicting stored shift's type name for the summary, or null.
  const storedConflict = (userId: string, date: string, shiftTypeId: string): string | null => {
    const sameDay = storedRows.filter((s) => s.userId === userId && s.date === date);
    if (sameDay.length) {
      const t = ctx.typeTimes.get(sameDay[0].shiftTypeId);
      return t ? t.name : 'a shift';
    }
    const prev = addDays(date, -1);
    const next = addDays(date, 1);
    const neighbours = storedRows.filter((s) =>
      s.userId === userId && (s.date === prev || s.date === next));
    if (!neighbours.length) return null;
    const proposed = makeTimedShift(ctx.typeTimes, userId, { date, shiftTypeId });
    for (const n of neighbours) {
      const timed = makeTimedShift(ctx.typeTimes, userId, n);
      if (findShiftConflict('This person', [timed], proposed)) {
        const t = ctx.typeTimes.get(n.shiftTypeId);
        return t ? t.name : 'a shift';
      }
    }
    return null;
  };
  const publishedFor = (userId: string, date: string, shiftTypeId: string): boolean => {
    if (publishMode === 'draft') return false;
    const key = `${rot.id}|${userId}|${date}|${shiftTypeId}`;
    return ctx.pubMap.has(key) ? ctx.pubMap.get(key)! : true;
  };
  const pushOcc = (a: any, date: string, shiftTypeId: string, special: boolean) => {
    occurrences.push({
      userId: a.userId, date, shiftTypeId,
      shiftTypeName: a.shiftTypeName,
      shiftTypeShort: a.shiftTypeShort || '',
      shiftTypeColor: a.shiftTypeColor || '#3b82f6',
      shiftTypeTextColor: a.shiftTypeTextColor || '#ffffff',
      sortOrder: typeof a.sortOrder === 'number' ? a.sortOrder : 999,
      firstName: a.firstName || '', lastName: a.lastName || '', nickname: a.nickname || null,
      rotationId: rot.id, rotationName: rot.name,
      published: publishedFor(a.userId, date, shiftTypeId),
      special,
    });
  };

  // ---- Group rotation: line dealing, replayed from the rotation start.
  if (rot.groupId && rot.groupShiftTypeId) {
    const groupIds = String(rot.groupIds || rot.groupId)
      .split(',').map((x: string) => x.trim()).filter(Boolean);
    const gType = ctx.groupTypes.get(rot.groupShiftTypeId);
    const groupsMembers: any[][] = groupIds.map((gid) => {
      if (!gType) return [];
      return (ctx.membersByGroup.get(gid) || []).map((m) => ({
        userId: m.userId, firstName: m.firstName, lastName: m.lastName,
        nickname: m.nickname, userEndDate: m.userEndDate,
        shiftTypeName: gType.shiftTypeName, shiftTypeShort: gType.shiftTypeShort,
        shiftTypeColor: gType.shiftTypeColor, shiftTypeTextColor: gType.shiftTypeTextColor,
        sortOrder: gType.sortOrder,
      }));
    });
    const daySet = new Set(
      String(rot.groupDays || '').split(',').map((x: string) => Number(x)).filter((n: number) => n >= 1)
    );
    if (groupsMembers.length && groupsMembers.some((g) => g.length) && daySet.size) {
      const stId = rot.groupShiftTypeId as string;
      const unit = rot.turnUnit || 'shift';
      const tDays = Math.max(1, Number(rot.turnDays) || 1);
      const wStart = Number.isInteger(rot.weekStart) ? rot.weekStart : 1;
      const dayMs = 86400000;
      const startMs = Date.parse(rot.startDate + 'T00:00:00Z');
      const fromMs = Date.parse(from + 'T00:00:00Z');
      const toMs = Date.parse(to + 'T00:00:00Z');
      const anchorMs = startMs - ((new Date(startMs).getUTCDay() - wStart + 7) % 7) * dayMs;
      let occ = 0;
      let blockIdx = -1;
      let lastKey: string | null = null;
      const queues: any[][] = groupsMembers.map((g) => g.slice());
      let currentMember: any = null;
      for (let ms = startMs; ms <= toMs; ms += dayMs) {
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
        if (ms < fromMs) continue;
        if (isPaused(rot.id, dateStr)) continue;
        if (rot.endDate && dateStr > rot.endDate) continue;
        const m = currentMember;
        if (!m) continue;
        if (onVacation(m.userId, dateStr)) {
          skip(m.userId, personDisplay(m), dateStr, stId, m.shiftTypeName, 'vacation');
          continue;
        }
        if (m.userEndDate && dateStr > String(m.userEndDate).slice(0, 10)) {
          skip(m.userId, personDisplay(m), dateStr, stId, m.shiftTypeName, 'ended');
          continue;
        }
        const exclKey = `${rot.id}|${m.userId}|${dateStr}|${stId}`;
        if (ctx.exclSet.has(exclKey)) {
          skip(m.userId, personDisplay(m), dateStr, stId, m.shiftTypeName, 'excluded', 'previously deleted');
          continue;
        }
        const conflict = storedConflict(m.userId, dateStr, stId);
        if (conflict) {
          skip(m.userId, personDisplay(m), dateStr, stId, m.shiftTypeName, 'alreadyHasShift', `already has ${conflict}`);
          continue;
        }
        pushOcc(m, dateStr, stId, true);
      }
    }
    return { occurrences, departed, skipped, skippedDetail };
  }

  // ---- Per-person rotation: cycle math over [from, to].
  const assignments = ctx.assignmentsByRotation.get(rot.id) || [];
  if (!assignments.length) return { occurrences, departed, skipped, skippedDetail };
  const byDay = new Map<number, typeof assignments>();
  for (const a of assignments) {
    if (!byDay.has(a.cycleDay)) byDay.set(a.cycleDay, []);
    byDay.get(a.cycleDay)!.push(a);
  }
  const startDate = new Date(rot.startDate + 'T00:00:00');
  const fromDate = new Date(from + 'T00:00:00');
  const toDate = new Date(to + 'T00:00:00');
  for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    if (d < startDate) continue;
    if (rot.endDate && dateStr > rot.endDate) break;
    const daysSinceStart = Math.floor((Date.parse(dateStr + 'T00:00:00Z') - Date.parse(rot.startDate + 'T00:00:00Z')) / 86400000);
    const cycleDay = (daysSinceStart % rot.cycleDays) + 1;
    const dayAssignments = byDay.get(cycleDay);
    if (!dayAssignments) continue;
    for (const a of dayAssignments) {
      const endD = a.userEndDate ? String(a.userEndDate).slice(0, 10) : null;
      const departedDate = !!(endD && dateStr > endD);
      if (!departedDate && a.userActive === false) continue;
      if (departedDate) {
        // Rule 7: the shifts they would have worked after their last
        // working day open for cover — collected here, stamped as
        // open slots by the generator (group rotations excluded).
        if (opts?.collectDeparted && endD! >= from && endD! <= to && dateStr >= today) {
          departed.push({
            date: dateStr, userId: a.userId, firstName: a.firstName, lastName: a.lastName,
            nickname: a.nickname, shiftTypeId: a.shiftTypeId, shiftTypeName: a.shiftTypeName,
            rotationId: rot.id, rotationName: rot.name, endDate: endD,
          });
        } else {
          skip(a.userId, personDisplay(a), dateStr, a.shiftTypeId, a.shiftTypeName, 'ended');
        }
        continue;
      }
      if (isPaused(rot.id, dateStr)) {
        skip(a.userId, personDisplay(a), dateStr, a.shiftTypeId, a.shiftTypeName, 'vacation');
        continue;
      }
      const exclKey = `${rot.id}|${a.userId}|${dateStr}|${a.shiftTypeId}`;
      if (ctx.exclSet.has(exclKey)) {
        skip(a.userId, personDisplay(a), dateStr, a.shiftTypeId, a.shiftTypeName, 'excluded', 'previously deleted');
        continue;
      }
      const conflict = storedConflict(a.userId, dateStr, a.shiftTypeId);
      if (conflict) {
        skip(a.userId, personDisplay(a), dateStr, a.shiftTypeId, a.shiftTypeName, 'alreadyHasShift', `already has ${conflict}`);
        continue;
      }
      pushOcc(a, dateStr, a.shiftTypeId, false);
    }
  }
  return { occurrences, departed, skipped, skippedDetail };
}

// ---------------------------------------------------------------------------
// Orchestration: generate (and re-generate) rotations into stored rows.
// ---------------------------------------------------------------------------

export interface GenerateOpts {
  rotationIds: string[];
  from: string;
  to: string;
  /** 'keep' = hand fixes + deletions stay, the rest refreshes;
   *  'fresh' = replace every still-draft row of the rotation in range,
   *  clear its exclusions there (deleted people return). */
  mode: 'keep' | 'fresh';
  /** Dry run: compute only, write nothing (the D1 choice dialog). */
  dryRun?: boolean;
  /** Migration only: allow past dates (creates history, never changes it). */
  allowPast?: boolean;
  /** 'draft' (default) or 'published' (migration: rows are published). */
  publishMode?: 'draft' | 'published';
  createdBy: string;
}

export interface PerRotationSummary {
  rotationId: string;
  rotationName: string;
  generationId: string | null;
  created: number;
  replacedDrafts: number;
  keptDrafts: number;
  openedSlots: number;
  skipped: SkipCounts;
}

export interface GenerateSummary {
  generationIds: string[];
  created: number;
  replacedDrafts: number;
  keptDrafts: number;
  openedSlots: number;
  skipped: SkipCounts;
  skippedDetail: SkipDetail[];
  perRotation: PerRotationSummary[];
  /** Dry run only: still-draft rows of these rotations in the range. */
  existingDrafts?: number;
  /** Dry run only: exclusions (previously deleted instances) in range. */
  deletedCount?: number;
  /** Dry run only: occurrences that would be created. */
  wouldCreate?: number;
  /**
   * The rows this generation (would) create — { userId, date,
   * shiftTypeId, rotationId, rotationName }. Dry run: would-be rows;
   * real run: actually inserted rows. The Stage 4 migration report
   * compares these against the live draw, per person per week.
   */
  createdRows?: Array<{ userId: string; date: string; shiftTypeId: string; rotationId: string; rotationName: string }>;
  /**
   * Audit entries for the caller to write AFTER the transaction
   * commits (auditLog uses the global query — writing inside the
   * transaction would leave phantom rows on a rollback).
   */
  auditEntries?: AuditEntry[];
}

/** Bump a rotation's change marker (D6 badge). Called on every
 *  pattern mutation: rotation edit, assignment change, group
 *  membership change, pause change. */
export async function touchRotation(q: QueryFn, rotationId: string): Promise<void> {
  await q('UPDATE rotations SET updated_at = now() WHERE id = $1', [rotationId]);
}

export async function touchRotationsForGroup(q: QueryFn, groupId: string): Promise<void> {
  await q(
    `UPDATE rotations SET updated_at = now()
     WHERE group_id = $1 OR (',' || COALESCE(group_ids, '') || ',' LIKE '%,' || $1 || ',%')`,
    [groupId]
  );
}

function addSkipped(into: SkipCounts, add: SkipCounts): void {
  into.vacation += add.vacation;
  into.alreadyHasShift += add.alreadyHasShift;
  into.ended += add.ended;
  into.excluded += add.excluded;
  into.past += add.past;
}

/**
 * Reconcile this rotation's rule-7 open slots in the range against
 * the desired counts (departed entries grouped by date+type).
 * Per-rotation accounting: each rotation owns its own slots; the
 * shared extra_open_slots row is just the sum. Grants add ledger
 * rows + extra counts; removals delete ledger rows (oldest first)
 * and decrement extra counts, clamped at zero so a claimed slot is
 * never disturbed (the claimer's real shift row is untouched).
 */
async function reconcileOpenSlots(
  tx: QueryFn, companyId: string, rotationId: string, generationId: string,
  from: string, to: string, desired: Map<string, number>
): Promise<number> {
  // Existing ledger for this rotation, in range.
  const { rows: genRows } = await tx(
    `SELECT id FROM rotation_generations WHERE company_id = $1 AND rotation_id = $2`,
    [companyId, rotationId]
  );
  const genIds = genRows.map((r: any) => r.id);
  const existing = new Map<string, number>();
  const ledgerRows: Array<{ id: string; date: string; shiftTypeId: string; count: number }> = [];
  if (genIds.length) {
    const { rows } = await tx(
      `SELECT id, date::text AS date, shift_type_id AS "shiftTypeId", count
       FROM generation_open_slots
       WHERE generation_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3
       ORDER BY created_at ASC`,
      [genIds, from, to]
    );
    for (const r of rows) {
      const k = `${r.date}|${r.shiftTypeId}`;
      existing.set(k, (existing.get(k) || 0) + r.count);
      ledgerRows.push({ id: r.id, date: r.date, shiftTypeId: r.shiftTypeId, count: r.count });
    }
  }
  const keys = new Set<string>([...desired.keys(), ...existing.keys()]);
  // Flip-after-publish (Deepika, 2026-11-14 — found by the
  // generated-mode-parity suite): a LIVE publish already granted
  // this rotation's rule-7 opens into publish_batch_open_slots
  // (active batches only). Generation must net against those too,
  // or the same slot is granted a second time — and again on every
  // re-draft. The publish ledger is per-rotation, so it nets
  // exactly like the generation ledger; it only ever raises `have`,
  // never `want` (an undo owns it, and the removal branch below
  // only ever removes generation-ledger rows — the `taken` math
  // stays exact because it counts what the generation loop
  // actually removed).
  {
    const { rows: pubRows } = await tx(
      `SELECT l.date::text AS date, l.shift_type_id AS "shiftTypeId",
              COALESCE(SUM(l.count), 0)::int AS n
       FROM publish_batch_open_slots l
       JOIN publish_batches b ON b.id = l.batch_id
       WHERE l.company_id = $1 AND l.rotation_id = $2 AND b.undone_at IS NULL
         AND l.date >= $3 AND l.date <= $4
       GROUP BY l.date, l.shift_type_id`,
      [companyId, rotationId, from, to]
    );
    for (const r of pubRows) {
      const k = `${r.date}|${r.shiftTypeId}`;
      existing.set(k, (existing.get(k) || 0) + r.n);
    }
  }
  let netOpened = 0;
  for (const k of keys) {
    const want = desired.get(k) || 0;
    const have = existing.get(k) || 0;
    const [date, shiftTypeId] = k.split('|');
    if (want > have) {
      const grant = want - have;
      await tx(
        `INSERT INTO generation_open_slots (generation_id, company_id, date, shift_type_id, count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (generation_id, date, shift_type_id)
         DO UPDATE SET count = generation_open_slots.count + EXCLUDED.count`,
        [generationId, companyId, date, shiftTypeId, grant]
      );
      await tx(
        `INSERT INTO extra_open_slots (company_id, date, shift_type_id, count, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, date, shift_type_id)
         DO UPDATE SET count = extra_open_slots.count + EXCLUDED.count`,
        [companyId, date, shiftTypeId, grant, null]
      );
      netOpened += grant;
    } else if (want < have) {
      let remove = have - want;
      for (const lr of ledgerRows.filter((x) => `${x.date}|${x.shiftTypeId}` === k)) {
        if (remove <= 0) break;
        const take = Math.min(lr.count, remove);
        if (take >= lr.count) await tx('DELETE FROM generation_open_slots WHERE id = $1', [lr.id]);
        else await tx('UPDATE generation_open_slots SET count = count - $1 WHERE id = $2', [take, lr.id]);
        remove -= take;
      }
      const taken = have - want - remove;
      if (taken > 0) {
        await tx(
          `UPDATE extra_open_slots SET count = GREATEST(0, count - $1)
           WHERE company_id = $2 AND date = $3 AND shift_type_id = $4`,
          [taken, companyId, date, shiftTypeId]
        );
        await tx(
          'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count = 0',
          [companyId, date, shiftTypeId]
        );
        netOpened -= taken;
      }
    }
  }
  return netOpened;
}

/**
 * Generate (or re-generate) rotations into stored draft rows.
 * Runs inside the caller's transaction (pass a tx query fn) — the
 * endpoint and the migration tool both wrap it in withTransaction.
 * Rotations are processed group-first, then per-person (client order
 * within each class): the group shift wins a contested day, exactly
 * like the draw's special precedence.
 */
/**
 * Today's date (YYYY-MM-DD) in the company's own timezone, read
 * through the PASSED query fn — never the global query. This
 * matters: generateRotations runs inside the caller's transaction,
 * and on PGlite (local dev / fixture) the global query shares the
 * transaction's single connection — calling it from inside the tx
 * deadlocks forever (the tx waits for the query, the query waits
 * for the tx). Production's pool hides it; the fixture does not.
 * Mirrors notifyJobs.companyTodayStr semantics.
 */
async function txTodayStr(q: QueryFn, companyId: string): Promise<string> {
  let tz = 'America/Chicago';
  try {
    const { rows } = await q(
      `SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`,
      [companyId]
    );
    const v = rows[0]?.value;
    if (v) { new Intl.DateTimeFormat('en-US', { timeZone: v }); tz = v; }
  } catch { /* bad or missing stored timezone — default */ }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export async function generateRotations(
  tx: QueryFn, companyId: string, opts: GenerateOpts
): Promise<GenerateSummary> {
  const { rotationIds, from, to } = opts;
  const mode = opts.mode || 'fresh';
  const publishMode = opts.publishMode || 'draft';
  if (!Array.isArray(rotationIds) || !rotationIds.length) {
    throw Object.assign(new Error('Pick at least one rotation.'), { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    throw Object.assign(new Error('Pick a valid date range.'), { status: 400 });
  }
  if (dayNum(to) - dayNum(from) > 366) {
    throw Object.assign(new Error('Generate at most a year at a time.'), { status: 400 });
  }
  const today = await txTodayStr(tx, companyId);
  if (!opts.allowPast && from < today) {
    throw Object.assign(new Error('Cannot draft dates in the past — the past is truth.'), { status: 400 });
  }

  const { rows: rots } = await tx(
    `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate",
            end_date::text AS "endDate",
            group_id AS "groupId", group_ids AS "groupIds", group_shift_type_id AS "groupShiftTypeId",
            group_days AS "groupDays", turn_unit AS "turnUnit",
            turn_days AS "turnDays", week_start AS "weekStart"
     FROM rotations WHERE company_id = $1 AND id = ANY($2::uuid[]) AND is_active = true`,
    [companyId, rotationIds]
  );
  if (rots.length !== rotationIds.length) {
    throw Object.assign(new Error('A rotation was not found or is inactive.'), { status: 404 });
  }
  const byId = new Map<string, any>(rots.map((r: any) => [r.id, r]));
  const ordered = [
    ...rotationIds.filter((id) => byId.get(id)?.groupId && byId.get(id)?.groupShiftTypeId),
    ...rotationIds.filter((id) => !(byId.get(id)?.groupId && byId.get(id)?.groupShiftTypeId)),
  ];
  const ctx = await loadGenerationContext(tx, companyId, from, to, rotationIds);

  // ---- Dry run: compute only (the D1 choice dialog reads this).
  if (opts.dryRun) {
    let storedRows = await loadStoredRows(tx, companyId, from, to);
    const { rows: draftRows } = await tx(
      `SELECT COUNT(*)::int AS n FROM shifts
       WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
         AND published = false AND date >= $3 AND date <= $4`,
      [companyId, rotationIds, from, to]
    );
    const { rows: exclRows } = await tx(
      `SELECT COUNT(*)::int AS n FROM rotation_shift_exclusions
       WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
         AND date >= $3 AND date <= $4`,
      [companyId, rotationIds, from, to]
    );
    const skipped = emptySkipped();
    const skippedDetail: SkipDetail[] = [];
    const perRotation: PerRotationSummary[] = [];
    const createdRows: GenerateSummary['createdRows'] = [];
    let wouldCreate = 0;
    for (const id of ordered) {
      const rot = byId.get(id);
      const comp = computeRotationOccurrences(ctx, rot, from, to, storedRows, {
        publishMode, collectDeparted: true, today,
      });
      addSkipped(skipped, comp.skipped);
      skippedDetail.push(...comp.skippedDetail);
      wouldCreate += comp.occurrences.length;
      for (const o of comp.occurrences) {
        createdRows.push({ userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId, rotationId: id, rotationName: rot.name });
      }
      // Simulate: later rotations see these rows as stored (D4).
      for (const o of comp.occurrences) {
        storedRows.push({ userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId });
      }
      perRotation.push({
        rotationId: id, rotationName: rot.name, generationId: null,
        created: comp.occurrences.length, replacedDrafts: 0, keptDrafts: 0,
        openedSlots: comp.departed.length, skipped: comp.skipped,
      });
    }
    return {
      generationIds: [], created: 0, replacedDrafts: 0, keptDrafts: 0, openedSlots: 0,
      skipped, skippedDetail, perRotation,
      existingDrafts: draftRows[0]?.n || 0, deletedCount: exclRows[0]?.n || 0, wouldCreate, createdRows,
    };
  }

  // ---- Real generation.
  const summary: GenerateSummary = {
    generationIds: [], created: 0, replacedDrafts: 0, keptDrafts: 0, openedSlots: 0,
    skipped: emptySkipped(), skippedDetail: [], perRotation: [], auditEntries: [], createdRows: [],
  };
  const auditEntries: AuditEntry[] = summary.auditEntries!;
  let storedRows = await loadStoredRows(tx, companyId, from, to);
  const crypto = await import('node:crypto');
  for (const id of ordered) {
    const rot = byId.get(id);
    const generationId = crypto.randomUUID();
    await tx(
      `INSERT INTO rotation_generations
         (id, company_id, rotation_id, rotation_name, range_start, range_end, mode, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [generationId, companyId, id, rot.name, from, to, mode, opts.createdBy]
    );
    summary.generationIds.push(generationId);

    let replacedDrafts = 0;
    let keptDrafts = 0;
    if (mode === 'fresh') {
      // Replace every still-draft row of this rotation in the range
      // (hand-added rows have rotation_id NULL and are never touched;
      // published rows are never touched) and clear its exclusions
      // there, so deleted people return.
      const { rows: del } = await tx(
        `DELETE FROM shifts
         WHERE company_id = $1 AND rotation_id = $2 AND published = false
           AND date >= $3 AND date <= $4
         RETURNING user_id AS "userId", date::text AS date, shift_type_id AS "shiftTypeId"`,
        [companyId, id, from, to]
      );
      replacedDrafts = del.length;
      summary.replacedDrafts += replacedDrafts;
      // Clear this rotation's exclusions in range, so deleted people
      // return — and drop the same keys from the in-memory context,
      // or the compute just below would still see them and skip the
      // returning dates as 'excluded' (the context was loaded before
      // this loop and goes stale on this delete).
      const { rows: clearedExcl } = await tx(
        `DELETE FROM rotation_shift_exclusions
         WHERE company_id = $1 AND rotation_id = $2 AND date >= $3 AND date <= $4
         RETURNING rotation_id AS "rotationId", user_id AS "userId",
                   date::text AS date, shift_type_id AS "shiftTypeId"`,
        [companyId, id, from, to]
      );
      for (const e of clearedExcl) {
        ctx.exclSet.delete(`${e.rotationId}|${e.userId}|${e.date}|${e.shiftTypeId}`);
      }
      // The deleted draft rows leave the in-memory stored set too.
      const delKeys = new Set(del.map((r: any) => `${r.userId}|${r.date}|${r.shiftTypeId}`));
      storedRows = storedRows.filter((s) => !delKeys.has(`${s.userId}|${s.date}|${s.shiftTypeId}`));
      // Audit the replaced drafts, one row per person (mirrors the
      // publish flow's per-person rows). Entries are RETURNED, not
      // written here: auditLog uses the global query, so writing
      // inside this transaction would leave phantom rows on a
      // rollback — the caller writes them after the commit.
      const byUser = new Map<string, number>();
      for (const r of del) byUser.set(r.userId, (byUser.get(r.userId) || 0) + 1);
      for (const [uid, n] of byUser) {
        const { rows: nm } = await tx(
          'SELECT nickname, first_name, last_name FROM users WHERE id = $1', [uid]
        );
        const personName = nm.length
          ? (nm[0].nickname || `${nm[0].first_name || ''} ${nm[0].last_name || ''}`.trim() || null) : null;
        auditEntries.push({
          companyId, date: today, action: 'deleted', category: 'schedule',
          personName, source: 'rotation', changedBy: opts.createdBy,
          affectedUserId: uid, scheduleDate: from, scheduleDateEnd: to,
          rotationName: rot.name,
          description: `Re-drafted from the rotation — ${n} draft shift(s) replaced (${from} – ${to})`,
          details: { generationId, rotationId: id, count: n, from, to, mode: 'fresh' },
        });
      }
    } else {
      // Keep-changes: count the still-draft rows that stay in place.
      const { rows: kept } = await tx(
        `SELECT COUNT(*)::int AS n FROM shifts
         WHERE company_id = $1 AND rotation_id = $2 AND published = false
           AND date >= $3 AND date <= $4`,
        [companyId, id, from, to]
      );
      keptDrafts = kept[0]?.n || 0;
      summary.keptDrafts += keptDrafts;
    }

    const comp = computeRotationOccurrences(ctx, rot, from, to, storedRows, {
      publishMode, collectDeparted: true, today,
    });
    addSkipped(summary.skipped, comp.skipped);
    summary.skippedDetail.push(...comp.skippedDetail);

    // Insert survivors as draft rows (published mode: migration rows
    // are already published). ON CONFLICT is a backstop for a
    // concurrent writer; the D4 check above is the real guard.
    let created = 0;
    const createdByUser = new Map<string, number>();
    for (const o of comp.occurrences) {
      const { rows: ins } = await tx(
        `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by, rotation_id, generation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (company_id, user_id, date, shift_type_id) DO NOTHING
         RETURNING id`,
        [crypto.randomUUID(), companyId, o.userId, o.shiftTypeId, o.date,
         o.published, opts.createdBy, o.rotationId, generationId]
      );
      if (ins.length) {
        created++;
        createdByUser.set(o.userId, (createdByUser.get(o.userId) || 0) + 1);
        summary.createdRows!.push({ userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId, rotationId: id, rotationName: rot.name });
        storedRows.push({ userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId });
      }
    }
    summary.created += created;

    // Rule 7: departed entries become open slots (per-rotation ledger).
    const desired = new Map<string, number>();
    for (const d of comp.departed) {
      const k = `${d.date}|${d.shiftTypeId}`;
      desired.set(k, (desired.get(k) || 0) + 1);
    }
    const openedSlots = await reconcileOpenSlots(tx, companyId, id, generationId, from, to, desired);
    summary.openedSlots += openedSlots;

    await tx(
      `UPDATE rotation_generations SET created_count = $1, skipped_count = $2 WHERE id = $3`,
      [created, comp.skipped.vacation + comp.skipped.alreadyHasShift + comp.skipped.ended + comp.skipped.excluded + comp.skipped.past, generationId]
    );
    summary.perRotation.push({
      rotationId: id, rotationName: rot.name, generationId, created,
      replacedDrafts, keptDrafts, openedSlots, skipped: comp.skipped,
    });

    // Audit the new drafts, one row per person (the Change report
    // documents every change; a generation is a bulk action, so it
    // is broken down by person like a bulk publish). Returned, not
    // written — see the note above.
    if (created) {
      for (const [uid, n] of createdByUser) {
        const { rows: nm } = await tx(
          'SELECT nickname, first_name, last_name FROM users WHERE id = $1', [uid]
        );
        const personName = nm.length
          ? (nm[0].nickname || `${nm[0].first_name || ''} ${nm[0].last_name || ''}`.trim() || null) : null;
        auditEntries.push({
          companyId, date: today, action: 'created', category: 'schedule',
          personName, source: 'rotation', changedBy: opts.createdBy,
          affectedUserId: uid, scheduleDate: from, scheduleDateEnd: to,
          rotationName: rot.name,
          description: publishMode === 'published'
            ? `Published from rotation — ${n} shift(s) (${from} – ${to})`
            : `Drafted from rotation — ${n} draft shift(s) (${from} – ${to})`,
          details: { generationId, rotationId: id, count: n, from, to, mode },
        });
      }
    }
  }
  return summary;
}

/** Run a generation outside an existing transaction (convenience for
 *  the migration tool and suites that own their own tx). */
export async function generateRotationsTx(
  companyId: string, opts: GenerateOpts
): Promise<GenerateSummary> {
  return withTransaction(async (tx) => {
    const q: QueryFn = (text, params) => tx.query(text, params);
    return generateRotations(q, companyId, opts);
  });
}
