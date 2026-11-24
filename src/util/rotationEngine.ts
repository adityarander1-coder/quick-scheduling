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
//     draw). Previously-deleted instances stay deleted: a draft
//     never clears exclusions (keep current changes, Deepika
//     2026-11-23) — the engine just honours whatever exclusions
//     exist.
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

// Draft once, detached from then on (Deepika, 2026-11-22 — "no
// connection to rotations or targets once drafted", and 2026-11-23
// the detach shipped): a draft copies the pattern into stored rows
// and then never listens to the rotation or the target again —
// later edits to either move nothing already drafted. The grid and
// the plan gate read the stored counts, so a drafted date shows
// exactly what is stored and nothing computed sneaks back in.
// Draft redesign (Deepika, 2026-11-23): one press of Draft runs
// step by step — step 1 pulls the targets and stores them as draft
// open slots, step 2 drafts the schedule from the rotations into
// those slots. The rotation engine NEVER reads the target: the
// target is read only in step 1, and the rotations only decide WHO
// fills a slot, never whether the slot exists. Excess rotation
// people still get their draft shift (the target never caps who
// gets a shift — it only creates the open slots). The draft is
// always additive now (keep current changes): it never deletes,
// replaces, or re-creates anything already on the schedule —
// published shifts, draft shifts, stored opens and closes all
// stay, and step 1 only adds the missing shortfall.

import { withTransaction } from '../db.js';
import { getShiftTypeTimes, makeTimedShift, findShiftConflict } from './shiftConflicts.js';
import { getGeneratedTypeIds, getTypesWithRotations } from './scheduleMode.js';
import { setDraftOpenCount, draftOpenTotal, clearOpenSlotClosures, clearDraftOpenSlots } from './openSlots.js';
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
  rotationIds: string[],
  opts?: { ignoreBulkExclusions?: boolean }
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
     WHERE company_id = $1 AND date >= $2 AND date <= $3${opts?.ignoreBulkExclusions ? ` AND origin <> 'bulk'` : ''}`,
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
  /**
   * Partial draft: only these users' occurrences (group dealing runs
   * unchanged — an unpicked member's turn produces no row and counts
   * as nothing). Absent = everyone.
   */
  onlyUserIds?: Set<string>;
  /** Partial draft: only these shift types' occurrences. */
  onlyShiftTypeIds?: Set<string>;
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
        // Partial draft: an unpicked member's turn produces no row
        // and counts as nothing (not a skip) — the dealing above
        // already ran unchanged, so the turn is still theirs, it
        // just isn't drafted.
        if (opts?.onlyUserIds && !opts.onlyUserIds.has(m.userId)) continue;
        if (opts?.onlyShiftTypeIds && !opts.onlyShiftTypeIds.has(stId)) continue;
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
      // Partial draft: occurrences only for picked people/types — an
      // unpicked person counts as nothing (not a skip, and a departed
      // unpicked person opens no slot).
      if (opts?.onlyUserIds && !opts.onlyUserIds.has(a.userId)) continue;
      if (opts?.onlyShiftTypeIds && !opts.onlyShiftTypeIds.has(a.shiftTypeId)) continue;
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
   *  'fresh' = replace every still-draft row of the rotation in
   *  range, clear every exclusion in scope (one-by-one AND bulk)
   *  and every closed-open suppression for the draft's types, so
   *  deleted people and closed opens come back (Deepika,
   *  2026-11-24: "Bring back everything I deleted"). Published
   *  rows and hand-added rows (rotation_id NULL) are never
   *  touched, in either mode. */
  mode: 'keep' | 'fresh';
  /** Dry run: compute only, write nothing (the D1 choice dialog). */
  dryRun?: boolean;
  /** Migration only: allow past dates (creates history, never changes it). */
  allowPast?: boolean;
  /** 'draft' (default) or 'published' (migration: rows are published). */
  publishMode?: 'draft' | 'published';
  /**
   * Partial draft (Deepika, 2026-11-14 — pick by shift + employees):
   * draft ONLY these team members' turns. The group dealing runs
   * unchanged; unpicked members' turns produce no rows and count as
   * nothing (not a skip, no open slot). Absent = everyone.
   */
  userIds?: string[];
  /**
   * Partial draft: draft ONLY these shift types. Absent = every type
   * the rotation produces.
   */
  shiftTypeIds?: string[];
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
  /** Step 1 (targets first): how many draft open slots the target
   *  store added in this call. */
  targetsStored: number;
  /**
   * Draft-open rule (Deepika, 2026-11-14): the staffing-target
   * shortfall this draft opens, summed over the range — the positions
   * still needed after the rotation's people are placed. Since the
   * redesign step 1 IS the shortfall store (as draft opens), this
   * now equals targetsStored.
   */
  openedShortfall: number;
  skipped: SkipCounts;
  skippedDetail: SkipDetail[];
  perRotation: PerRotationSummary[];
  /** Dry run only: still-draft rows of these rotations in the range. */
  existingDrafts?: number;
  /** Dry run only: exclusions (previously deleted instances) in range. */
  deletedCount?: number;
  /**
   * Dry run only: bulk-delete exclusions in range — the ones this
   * draft would clear so the range re-drafts. Real run only: how
   * many bulk-delete exclusions the draft actually cleared.
   */
  bulkDeletedCount?: number;
  clearedBulkExclusions?: number;
  /**
   * Fresh only, real run: how many exclusions of ANY origin the
   * fresh reset cleared in scope (one-by-one AND bulk), split
   * below. Keep mode clears bulk only, so clearedExclusions
   * equals clearedBulkExclusions there.
   */
  clearedExclusions?: number;
  clearedExclusionsSingle?: number;
  /** Fresh only, real run: suppressed opens cleared in scope. */
  clearedSuppressions?: number;
  /** Fresh only, real run: draft-open rows cleared in scope. */
  clearedDraftOpens?: number;
  /**
   * Fresh only, real run: extra opens removed as stale delete
   * grants — deleting a shift grants one extra open for the
   * vacated position, and fresh refills it from the rotation, so
   * the grant would stand beside the returning person as a
   * phantom open. Capped per date+type by the exclusions cleared,
   * so a hand-added extra survives whenever the deletes don't
   * cover it.
   */
  clearedStaleExtras?: number;
  /**
   * Dry run only: what a fresh re-draft of this same call would
   * clear — the confirmation counts for the "Re-draft from the
   * rotations" button. Exclusions in scope, split by origin;
   * suppressed opens for the step-1 types; still-draft rows of
   * the rotations in scope; draft-open rows for the step-1 types;
   * stale delete-granted extras (see clearedStaleExtras).
   */
  freshExclusions?: number;
  freshExclusionsSingle?: number;
  freshExclusionsBulk?: number;
  freshSuppressions?: number;
  freshDraftShifts?: number;
  freshDraftOpens?: number;
  freshStaleExtras?: number;
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
  // Existing ledger for this rotation, in range — rule-7 rows only
  // (shortfall rows live beside them under kind='shortfall' and are
  // reconciled separately; mixing the two would net a rule-7 grant
  // against a shortfall and silently eat one or the other).
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
       WHERE generation_id = ANY($1::uuid[]) AND date >= $2 AND date <= $3 AND kind = 'rule7'
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
        `INSERT INTO generation_open_slots (generation_id, company_id, date, shift_type_id, count, kind)
         VALUES ($1, $2, $3, $4, $5, 'rule7')
         ON CONFLICT (generation_id, date, shift_type_id, kind)
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
        // A zero count would violate the extra_open_slots CHECK
        // (count <> 0) — the row must be DELETED, never UPDATEed
        // to 0 (the old code UPDATEed with GREATEST(0, ...) first
        // and let the cleanup DELETE run after, so the UPDATE 500ed
        // and the whole draft rolled back).
        const { rows: exRows } = await tx(
          'SELECT count FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
          [companyId, date, shiftTypeId]
        );
        const exCount = exRows.length ? Number(exRows[0].count) : 0;
        const newCount = Math.max(0, exCount - taken);
        if (newCount === 0) {
          await tx('DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
            [companyId, date, shiftTypeId]);
        } else {
          await tx('UPDATE extra_open_slots SET count = $1 WHERE company_id = $2 AND date = $3 AND shift_type_id = $4',
            [newCount, companyId, date, shiftTypeId]);
        }
        netOpened -= taken;
      }
    }
  }
  return netOpened;
}

// ---------------------------------------------------------------------------
// Step 1 — targets first (Deepika, 2026-11-23 — draft redesign):
// when a shift type is drafted, the draft FIRST pulls the staffing
// target and stores it as draft open slots — net of everything
// already on the schedule for that date+type (published shifts,
// draft shifts, stored extras, draft opens). The shortfall is per
// date+type across the WHOLE draft call, never per rotation: two
// rotations sharing a type must not each store the same gap.
// Suppressions are NOT subtracted and NEVER cleared here: a close
// suppresses the shortfall with a stored row, and the added draft
// opens sit under that suppression — the visible total stays 0 on
// a closed day, and a later target raise still shows its new
// slots (the added rows cover the suppressed ones first). This
// supersedes the Nov 20 rule that a draft pulls closed days back:
// a draft preserves closes now (keep current changes). A type
// with no target gets no opens. Live types are excluded: their
// target already counts on the grid, so there is nothing to store
// for them. Step 1 is the ONLY place the draft reads the target —
// the rotation engine below never does.
// ---------------------------------------------------------------------------

interface ShortfallTarget {
  shiftTypeId: string;
  targetCount: number;
  weekdays: number[];
  startDate: string | null;
  endDate: string | null;
}

/** Staffing targets for the shortfall computation —
 *  mirrors the grid's targetCountFor (weekdays + date range). */
async function loadShortfallInputs(
  tx: QueryFn, companyId: string, from: string, to: string
): Promise<{ targets: ShortfallTarget[] }> {
  const { rows: trows } = await tx(
    `SELECT shift_type_id AS "shiftTypeId", target_count AS "targetCount",
            weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
     FROM staffing_targets WHERE company_id = $1`,
    [companyId]
  );
  const targets = trows.map((t: any) => ({
    shiftTypeId: t.shiftTypeId,
    targetCount: Number(t.targetCount) || 0,
    weekdays: Array.isArray(t.weekdays) ? t.weekdays : [0, 1, 2, 3, 4, 5, 6],
    startDate: t.startDate || null,
    endDate: t.endDate || null,
  }));
  return { targets };
}

function targetForShortfall(targets: ShortfallTarget[], shiftTypeId: string, dateStr: string): number {
  for (const t of targets) {
    if (t.shiftTypeId !== shiftTypeId) continue;
    const dow = new Date(dateStr + 'T00:00:00').getDay();
    if (!t.weekdays.includes(dow)) return 0;
    if (t.startDate && dateStr < t.startDate) return 0;
    if (t.endDate && dateStr > t.endDate) return 0;
    return t.targetCount;
  }
  return 0;
}

/** Shift types a draft call produces (per-person assignments + group
 *  types), intersected with the picked types on a partial draft. A
 *  type whose rotation placed nobody (vacation, pause, ended) is
 *  still in scope — its shortfall is the full target. */
function producedTypeIds(
  ctx: GenerationContext, rots: any[], onlyShiftTypeIds?: Set<string>
): Set<string> {
  const out = new Set<string>();
  for (const rot of rots) {
    if (rot.groupId && rot.groupShiftTypeId) out.add(rot.groupShiftTypeId as string);
    for (const a of ctx.assignmentsByRotation.get(rot.id) || []) out.add(a.shiftTypeId);
  }
  if (onlyShiftTypeIds) for (const t of [...out]) if (!onlyShiftTypeIds.has(t)) out.delete(t);
  return out;
}

/** Step 1's type set: the types this draft stores targets for —
 *  the types its rotations produce, plus picked rotation-less
 *  types, plus any generated type with a target that already has
 *  stored shifts in the range (the FOOTPRINT — March 2027
 *  evidence: Day Hospitalist Mar 8–14 stood 12 draft shifts, the
 *  draft's picks didn't include DH, and the base stored no draft
 *  opens for its 2–3/day shortfall; the type is live in that
 *  range, so its target shortfall must be stored), plus — on a
 *  FULL draft (every active rotation, no user/type picks) — every
 *  generated type with a target, so a rotation-less type like Day
 *  NP gets its slots too. Shared by the real run and the dry run,
 *  so the preview agrees with the draft it previews. */
async function step1TypeSet(
  tx: QueryFn, companyId: string, ctx: GenerationContext, rots: any[],
  rotationIds: string[], onlyShiftTypeIds: Set<string> | undefined,
  onlyUserIds: Set<string> | undefined, rotationless: Set<string>,
  storedRows: Array<{ userId: string; date: string; shiftTypeId: string }>,
  from: string, to: string
): Promise<Set<string>> {
  const step1Types = new Set([...producedTypeIds(ctx, rots, onlyShiftTypeIds), ...rotationless]);
  const footprint = new Set<string>();
  for (const s of storedRows) {
    if (s.date < from || s.date > to) continue;
    footprint.add(s.shiftTypeId);
  }
  // generated + withTarget are loaded once, only when a branch
  // below needs them (footprint present, or a possible full draft).
  let generated: Set<string> | null = null;
  let withTarget: Set<string> | null = null;
  const loadTargetedGenerated = async () => {
    if (!generated) {
      generated = await getGeneratedTypeIds(tx as any, companyId);
      const inputs0 = await loadShortfallInputs(tx, companyId, from, to);
      withTarget = new Set(inputs0.targets.map((t) => t.shiftTypeId));
    }
    return { generated: generated!, withTarget: withTarget! };
  };
  if (footprint.size) {
    const { generated: gen, withTarget: wt } = await loadTargetedGenerated();
    for (const t of footprint) if (gen.has(t) && wt.has(t)) step1Types.add(t);
  }
  // Picked types (Deepika, 2026-11-23 — draft fix): the draft's
  // picks ARE its scope. A picked generated type with a target gets
  // its shortfall stored even when no rotation in the call produces
  // it — its rotation wasn't picked, its members weren't picked, or
  // its group days fall outside the range (live March 2027: Day
  // Hospitalist stood 0 draft opens on two ranges although its
  // target is 14/day). Live types stay out: their target already
  // counts on the grid, so there is nothing to store for them.
  if (onlyShiftTypeIds?.size) {
    const { generated: gen, withTarget: wt } = await loadTargetedGenerated();
    for (const t of onlyShiftTypeIds) if (gen.has(t) && wt.has(t)) step1Types.add(t);
  }
  if (!onlyShiftTypeIds && !onlyUserIds) {
    const { rows: allRots } = await tx(
      'SELECT id FROM rotations WHERE company_id = $1 AND is_active = true',
      [companyId]
    );
    const allIds = new Set(allRots.map((r: any) => r.id));
    const isFullDraft = rotationIds.length > 0 && rotationIds.every((id) => allIds.has(id))
      && allIds.size === rotationIds.length;
    if (isFullDraft) {
      const { generated: gen, withTarget: wt } = await loadTargetedGenerated();
      for (const t of gen) if (wt.has(t)) step1Types.add(t);
    }
  }
  return step1Types;
}

/** Rotation-less types a draft call must open from the target
 *  (Deepika, 2026-11-15 — "all shifts should show in drafts even
 *  there is no rotation"): picked shift types that are generated AND
 *  produced by no ACTIVE rotation in the company. A rotation-less
 *  type places nobody, so the shortfall pass treats it as
 *  rotation-places-0 — its shortfall is the full target minus stored
 *  shifts. Only EXPLICITLY picked types count: a full draft drafts
 *  rotations and never auto-includes types no rotation produces.
 *  Live types are excluded: their target already counts on the grid,
 *  so there is no draft to do for them. */
async function getRotationlessTypeIds(
  tx: QueryFn, companyId: string, onlyShiftTypeIds?: Set<string>
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!onlyShiftTypeIds?.size) return out;
  const [generatedTypes, withRotations] = await Promise.all([
    getGeneratedTypeIds(tx as any, companyId),
    getTypesWithRotations(tx as any, companyId),
  ]);
  for (const t of onlyShiftTypeIds) {
    if (generatedTypes.has(t) && !withRotations.has(t)) out.add(t);
  }
  return out;
}

/** Stored open-slot state for the range, keyed "date|shiftTypeId":
 *  published extras, draft opens, suppressions. Step 1 nets all
 *  three against the target; suppressions are read so the caller
 *  can see them, but they are NOT subtracted from the new count
 *  (see the step-1 header: the added rows sit under a suppression
 *  and the visible total stays 0 on a closed day). */
interface OpenSlotState {
  extra: Map<string, number>;
  draft: Map<string, number>;
  suppressed: Map<string, number>;
}

async function loadOpenSlotState(
  tx: QueryFn, companyId: string, from: string, to: string
): Promise<OpenSlotState> {
  const read = async (table: string) => {
    const { rows } = await tx(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COALESCE(SUM(count), 0)::int AS n
       FROM ${table} WHERE company_id = $1 AND date >= $2 AND date <= $3
       GROUP BY date, shift_type_id`,
      [companyId, from, to]
    );
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.date}|${r.shiftTypeId}`, Number(r.n || 0));
    return m;
  };
  const [extra, draft, suppressed] = await Promise.all([
    read('extra_open_slots'),
    read('draft_open_slots'),
    read('suppressed_open_slots'),
  ]);
  return { extra, draft, suppressed };
}

/** Step 1 math (pure — no writes): the draft opens to ADD per
 *  date|type, net of everything already there:
 *    new = max(0, target − published − draftShifts − extras − draftOpens)
 *  `storedRows` is the CURRENT stored state (drafts + published +
 *  hand-added rows all count as filled). Past dates never open
 *  (past is truth). Suppressions are deliberately NOT subtracted:
 *  a closed day's added rows sit under its suppression, so the
 *  visible total stays 0 and a later target raise still shows its
 *  new slots. A date already at or above its target total adds
 *  nothing. */
function computeTargetStoreAdditions(
  inputs: { targets: ShortfallTarget[] },
  storedRows: Array<{ userId: string; date: string; shiftTypeId: string }>,
  state: OpenSlotState,
  from: string, to: string, typeIds: Set<string>, today: string
): Map<string, number> {
  const placed = new Map<string, number>();
  for (const s of storedRows) {
    if (s.date < from || s.date > to) continue;
    if (!typeIds.has(s.shiftTypeId)) continue;
    const k = `${s.date}|${s.shiftTypeId}`;
    placed.set(k, (placed.get(k) || 0) + 1);
  }
  const additions = new Map<string, number>();
  for (let n = dayNum(from); n <= dayNum(to); n++) {
    const date = dateOfDayNum(n);
    if (date < today) continue; // past is truth — never open the past
    for (const typeId of typeIds) {
      const t = targetForShortfall(inputs.targets, typeId, date);
      if (!t) continue;
      const k = `${date}|${typeId}`;
      const already = (placed.get(k) || 0)
        + (state.extra.get(k) || 0)
        + (state.draft.get(k) || 0);
      const add = Math.max(0, t - already);
      if (add > 0) additions.set(k, add);
    }
  }
  return additions;
}

/**
 * Step 1 — store the targets (writes). Adds each addition to the
 * draft-open count (ADDITIVE, never a set: a re-draft only adds
 * what is still missing). For rotation-less types the coverage is
 * recorded in the shortfall ledger under one dedicated generation
 * for this call (rotation_id NULL — the schema allows it; the
 * generation is the draft batch, not a rotation): one row per
 * covered (date, type), count = the added slots (0 when the date
 * is already at its target — the row is the coverage marker, so
 * the date still reads as drafted and a later target raise does
 * not resurrect its opens as computed ones). Rotation-backed
 * types need no ledger rows: their own generations cover the
 * range. Returns the total stored.
 */
async function storeTargetSlots(
  tx: QueryFn, companyId: string, createdBy: string | null,
  from: string, to: string, mode: string,
  additions: Map<string, number>, typeIds: Set<string>
): Promise<{ stored: number; generationId: string | null }> {
  let stored = 0;
  // One coverage generation for the whole step-1 store (rotation
  // NULL — the generation is the draft batch, not a rotation).
  // Created whenever step 1 runs for any type, so the ledger
  // markers below exist for every stored type.
  let covGenId: string | null = null;
  if (typeIds.size) {
    const crypto = await import('node:crypto');
    covGenId = crypto.randomUUID();
    await tx(
      `INSERT INTO rotation_generations
         (id, company_id, rotation_id, rotation_name, range_start, range_end, mode, created_by, user_ids)
       VALUES ($1, $2, NULL, 'Target slots (no rotation)', $3, $4, $5, $6, NULL)`,
      [covGenId, companyId, from, to, mode, createdBy]
    );
  }
  for (let n = dayNum(from); n <= dayNum(to); n++) {
    const date = dateOfDayNum(n);
    for (const typeId of typeIds) {
      const k = `${date}|${typeId}`;
      const add = additions.get(k) || 0;
      if (add > 0) {
        const cur = await draftOpenTotal(tx, companyId, date, typeId);
        await setDraftOpenCount(tx, companyId, date, typeId, cur + add, createdBy);
        stored += add;
      }
      // Coverage marker for every step-1 type: the row says this
      // date+type was target-stored by this draft, even when it
      // added nothing (already at target) — so the grid reads
      // STORED for it after publish, instead of the computed count
      // double-counting the stored extras beside the shortfall.
      // generation_open_slots has no CHECK on count, so a 0 row is
      // a valid marker. (Was rotation-less-only; the March 2027
      // footprint types — stored shifts, no rotation in the draft
      // — need the same coverage, or a published footprint date
      // reads computed and shows shortfall + extra.)
      if (covGenId) {
        await tx(
          `INSERT INTO generation_open_slots (generation_id, company_id, date, shift_type_id, count, kind)
           VALUES ($1, $2, $3, $4, $5, 'shortfall')
           ON CONFLICT (generation_id, date, shift_type_id, kind)
           DO UPDATE SET count = EXCLUDED.count`,
          [covGenId, companyId, date, typeId, add]
        );
      }
    }
  }
  return { stored, generationId: covGenId };
}

/**
 * Reconcile the shortfall opens against the desired counts. The
 * desired total is per date+type across the whole call, so existing
 * grants are read across ALL generations in range (any rotation's):
 * a re-draft of a subset nets the total down instead of stacking on
 * a stale grant from a rotation that was not re-drafted. New grants
 * are written under the first generation of this call that produces
 * the type; removals take the oldest rows first. Types outside this
 * call's scope are left alone — their grants belong to their own
 * draft. Returns the net grants/removals and the total shortfall
 * this draft now owns.
 */
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
  const mode = opts.mode || 'keep';
  const publishMode = opts.publishMode || 'draft';
  if (!Array.isArray(rotationIds) || (!rotationIds.length && !opts.shiftTypeIds?.length)) {
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

  // Partial draft (Deepika, 2026-11-14 — pick by shift + employees):
  // the compute and the dry-run counts below are all scoped to the
  // picked people/types. Absent = the whole rotation, exactly as
  // before.
  const onlyUserIds = opts.userIds?.length ? new Set(opts.userIds) : undefined;
  const onlyShiftTypeIds = opts.shiftTypeIds?.length ? new Set(opts.shiftTypeIds) : undefined;

  // Bulk-deleted ranges re-draft (Deepika, 2026-11-23 — draft fix):
  // a bulk delete clears a range so it can be re-drafted, and its
  // exclusions are range-clear markers. The draft clears them in
  // its own scope (rotations, picked types/users, range) BEFORE
  // computing occurrences, so the people come back. Fresh mode
  // (Deepika, 2026-11-24 — "Bring back everything I deleted")
  // clears exclusions of EVERY origin in the same scope — the
  // one-by-one deletes come back too. Keep mode still clears bulk
  // only: one-by-one deletes stay. Draft mode only; the migration
  // stamps live truth and must not clear anything. The dry run
  // never writes: it computes with bulk exclusions ignored instead
  // (below); the fresh dry-run counts below preview the full
  // clear.
  let clearedBulkExclusions = 0;
  let clearedExclusions = 0;
  let clearedExclusionsSingle = 0;
  // Fresh only: exclusions cleared per date+type — the cap for the
  // stale-extra removal in the fresh reset below (one extra per
  // cleared exclusion, so a hand-added extra survives whenever
  // the deletes don't cover it).
  const clearedExclusionsByPair = new Map<string, number>();
  if (publishMode === 'draft' && !opts.dryRun) {
    const clearParams: any[] = [companyId, rotationIds, from, to];
    let clearScope = '';
    if (onlyShiftTypeIds) {
      clearScope += ` AND shift_type_id = ANY($${clearParams.length + 1}::uuid[])`;
      clearParams.push([...onlyShiftTypeIds]);
    }
    if (onlyUserIds) {
      clearScope += ` AND user_id = ANY($${clearParams.length + 1}::uuid[])`;
      clearParams.push([...onlyUserIds]);
    }
    const originFilter = mode === 'fresh' ? '' : ` AND origin = 'bulk'`;
    const cleared = await tx(
      `DELETE FROM rotation_shift_exclusions
       WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
         AND date >= $3 AND date <= $4${originFilter}${clearScope}
       RETURNING origin, date::text AS date, shift_type_id AS "shiftTypeId"`,
      clearParams
    );
    clearedExclusions = cleared.rowCount || 0;
    for (const r of cleared.rows || []) {
      if (r.origin === 'bulk') clearedBulkExclusions++;
      else clearedExclusionsSingle++;
      const k = `${r.date}|${r.shiftTypeId}`;
      clearedExclusionsByPair.set(k, (clearedExclusionsByPair.get(k) || 0) + 1);
    }
  }
  // The dry run previews the real run, so it computes as if the
  // bulk exclusions were already cleared; the real run above
  // deleted them, so it reads the plain context.
  const ctx = await loadGenerationContext(tx, companyId, from, to, rotationIds,
    opts.dryRun ? { ignoreBulkExclusions: true } : undefined);
  const compOpts = { publishMode, collectDeparted: true, today, onlyUserIds, onlyShiftTypeIds };
  // Rotation-less types (Deepika, 2026-11-15): picked generated types
  // no active rotation produces. A call with no rotations at all is
  // only valid when it picks at least one such type — otherwise
  // there is nothing to draft.
  const rotationless = await getRotationlessTypeIds(tx, companyId, onlyShiftTypeIds);
  if (!rotationIds.length && !rotationless.size) {
    throw Object.assign(new Error('Nothing to draft for these picks — no rotation covers the shifts you picked.'), { status: 400 });
  }
  // Dry-run counts scope to the picked users when a partial draft
  // is running (parameter $5 on the queries below).
  const userScope = onlyUserIds ? ' AND user_id = ANY($5)' : '';
  const userParams: any[] = onlyUserIds ? [[...onlyUserIds]] : [];

  // ---- Dry run: compute only (the D1 choice dialog reads this).
  if (opts.dryRun) {
    let storedRows = await loadStoredRows(tx, companyId, from, to);
    const { rows: draftRows } = await tx(
      `SELECT COUNT(*)::int AS n FROM shifts
       WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
         AND published = false AND date >= $3 AND date <= $4${userScope}`,
      [companyId, rotationIds, from, to, ...userParams]
    );
    const { rows: exclRows } = await tx(
      `SELECT COUNT(*)::int AS n FROM rotation_shift_exclusions
       WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
         AND date >= $3 AND date <= $4 AND origin = 'single'${userScope}`,
      [companyId, rotationIds, from, to, ...userParams]
    );
    // Bulk-delete exclusions in scope: the draft clears these, so
    // the people come back — they are NOT "people you deleted" for
    // the dialog's promise, and wouldCreate above already counts
    // them as placeable.
    const { rows: bulkRows } = await tx(
      `SELECT COUNT(*)::int AS n FROM rotation_shift_exclusions
       WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
         AND date >= $3 AND date <= $4 AND origin = 'bulk'${userScope}`,
      [companyId, rotationIds, from, to, ...userParams]
    );
    // Fresh preview (Deepika, 2026-11-24): what "Re-draft from the
    // rotations" would clear on this same call — the confirmation
    // counts. Scoped exactly like the real fresh reset below
    // (rotations, picked types/users, range). The exclusion and
    // draft-shift counts are type-scoped, unlike the keep dialog's
    // counts above: fresh must never report a row outside its
    // scope as coming back.
    let freshExclusions = 0, freshExclusionsSingle = 0, freshExclusionsBulk = 0;
    let freshSuppressions = 0, freshDraftShifts = 0, freshDraftOpens = 0;
    let freshStaleExtras = 0;
    const freshExclByPair = new Map<string, number>();
    {
      const fParams: any[] = [companyId, rotationIds, from, to];
      let fScope = '';
      if (onlyShiftTypeIds) {
        fScope += ` AND shift_type_id = ANY($${fParams.length + 1}::uuid[])`;
        fParams.push([...onlyShiftTypeIds]);
      }
      if (onlyUserIds) {
        fScope += ` AND user_id = ANY($${fParams.length + 1}::uuid[])`;
        fParams.push([...onlyUserIds]);
      }
      const { rows: fExcl } = await tx(
        `SELECT origin, COUNT(*)::int AS n FROM rotation_shift_exclusions
         WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
           AND date >= $3 AND date <= $4${fScope}
         GROUP BY origin`,
        fParams
      );
      for (const r of fExcl) {
        freshExclusions += r.n;
        if (r.origin === 'bulk') freshExclusionsBulk += r.n;
        else freshExclusionsSingle += r.n;
      }
      const { rows: fShifts } = await tx(
        `SELECT COUNT(*)::int AS n FROM shifts
         WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
           AND published = false AND date >= $3 AND date <= $4${fScope}`,
        fParams
      );
      freshDraftShifts = fShifts[0]?.n || 0;
      const { rows: fExclPairs } = await tx(
        `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COUNT(*)::int AS n
         FROM rotation_shift_exclusions
         WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
           AND date >= $3 AND date <= $4${fScope}
         GROUP BY date, shift_type_id`,
        fParams
      );
      for (const r of fExclPairs) freshExclByPair.set(`${r.date}|${r.shiftTypeId}`, r.n);
    }
    const skipped = emptySkipped();
    const skippedDetail: SkipDetail[] = [];
    const perRotation: PerRotationSummary[] = [];
    const createdRows: GenerateSummary['createdRows'] = [];
    let wouldCreate = 0;
    // Step 1 preview: the same math as the real run, on the CURRENT
    // stored set — BEFORE any simulated placement. Step 1 runs
    // before the rotations place anyone, so the simulated
    // occurrences must NOT count as filled here (the old code
    // computed after the simulation and under-reported by exactly
    // the placements: 14 instead of 21 for target 3 + 1 holder).
    let targetsStored = 0;
    let dryAdditions: Map<string, number> | null = null;
    if (publishMode === 'draft') {
      const typeIds = await step1TypeSet(tx, companyId, ctx, rots, rotationIds, onlyShiftTypeIds, onlyUserIds, rotationless, storedRows, from, to);
      if (typeIds.size) {
        const inputs = await loadShortfallInputs(tx, companyId, from, to);
        const state = await loadOpenSlotState(tx, companyId, from, to);
        const additions = computeTargetStoreAdditions(inputs, storedRows, state, from, to, typeIds, today);
        dryAdditions = additions;
        for (const v of additions.values()) targetsStored += v;
        // Fresh preview, continued: suppressed opens and draft
        // opens for the step-1 types — the closed positions a
        // fresh re-draft would reopen, and the draft opens it
        // would rebuild from the target.
        const typeList = [...typeIds];
        const { rows: fSupp } = await tx(
          `SELECT COALESCE(SUM(count), 0)::int AS n FROM suppressed_open_slots
           WHERE company_id = $1 AND date >= $2 AND date <= $3 AND shift_type_id = ANY($4::text[])`,
          [companyId, from, to, typeList]
        );
        freshSuppressions = fSupp[0]?.n || 0;
        const { rows: fDraft } = await tx(
          `SELECT COALESCE(SUM(count), 0)::int AS n FROM draft_open_slots
           WHERE company_id = $1 AND date >= $2 AND date <= $3 AND shift_type_id = ANY($4::text[])`,
          [companyId, from, to, typeList]
        );
        freshDraftOpens = fDraft[0]?.n || 0;
        // Stale delete-granted extras, as the real reset would
        // remove them: up to one extra per exclusion cleared on
        // the date+type.
        const { rows: fExtra } = await tx(
          `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COALESCE(SUM(count), 0)::int AS n
           FROM extra_open_slots
           WHERE company_id = $1 AND date >= $2 AND date <= $3 AND shift_type_id = ANY($4::uuid[])
           GROUP BY date, shift_type_id`,
          [companyId, from, to, typeList]
        );
        for (const r of fExtra) {
          const cap = freshExclByPair.get(`${r.date}|${r.shiftTypeId}`) || 0;
          freshStaleExtras += Math.min(r.n, cap);
        }
      }
    }
    // Net, like the real run: the simulated placements take stored
    // draft opens, so the preview's shortfall is what step 1 stored
    // minus what step 2 would fill.
    let openedShortfall = targetsStored;
    const dryPlaced = new Map<string, number>();
    for (const id of ordered) {
      const rot = byId.get(id);
      const comp = computeRotationOccurrences(ctx, rot, from, to, storedRows, compOpts);
      addSkipped(skipped, comp.skipped);
      skippedDetail.push(...comp.skippedDetail);
      wouldCreate += comp.occurrences.length;
      for (const o of comp.occurrences) {
        createdRows.push({ userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId, rotationId: id, rotationName: rot.name });
      }
      // Simulate: later rotations see these rows as stored (D4).
      for (const o of comp.occurrences) {
        storedRows.push({ userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId });
        const k = `${o.date}|${o.shiftTypeId}`;
        dryPlaced.set(k, (dryPlaced.get(k) || 0) + 1);
      }
      perRotation.push({
        rotationId: id, rotationName: rot.name, generationId: null,
        created: comp.occurrences.length, replacedDrafts: 0, keptDrafts: 0,
        // Rule 7 grants run only for publishMode 'published' (the
        // migration); in draft mode the departed slots are already
        // inside step 1's stored shortfall, so nothing is opened
        // here.
        openedSlots: 0, skipped: comp.skipped,
      });
    }
    if (dryAdditions) {
      let remaining = 0;
      for (const [k, add] of dryAdditions) {
        remaining += Math.max(0, add - (dryPlaced.get(k) || 0));
      }
      openedShortfall = remaining;
    }
    return {
      generationIds: [], created: 0, replacedDrafts: 0, keptDrafts: 0, openedSlots: 0,
      targetsStored,
      openedShortfall,
      skipped, skippedDetail, perRotation,
      existingDrafts: draftRows[0]?.n || 0, deletedCount: exclRows[0]?.n || 0,
      bulkDeletedCount: bulkRows[0]?.n || 0, wouldCreate, createdRows,
      freshExclusions, freshExclusionsSingle, freshExclusionsBulk,
      freshSuppressions, freshDraftShifts, freshDraftOpens, freshStaleExtras,
    };
  }

  // ---- Real generation.
  const summary: GenerateSummary = {
    generationIds: [], created: 0, replacedDrafts: 0, keptDrafts: 0, openedSlots: 0,
    targetsStored: 0, clearedBulkExclusions, clearedExclusions, clearedExclusionsSingle,
    clearedSuppressions: 0, clearedDraftOpens: 0, clearedStaleExtras: 0,
    openedShortfall: 0,
    skipped: emptySkipped(), skippedDetail: [], perRotation: [], auditEntries: [], createdRows: [],
  };
  const auditEntries: AuditEntry[] = summary.auditEntries!;
  let storedRows = await loadStoredRows(tx, companyId, from, to);
  const crypto = await import('node:crypto');
  // One generation id per rotation, fixed up front: the fresh
  // reset below audits the drafts it replaces, and the loop
  // stamps the same id on the rows it creates.
  const generationIdByRotation = new Map<string, string>(
    ordered.map((rid) => [rid, crypto.randomUUID()])
  );

  // Step 1's type set is computed BEFORE any fresh reset: the
  // footprint reads the stored shifts, and fresh deletes the
  // call's draft shifts below — computing after the reset would
  // risk dropping a type whose only footprint was a draft the
  // reset just removed.
  const step1Types = publishMode === 'draft'
    ? await step1TypeSet(tx, companyId, ctx, rots, rotationIds, onlyShiftTypeIds, onlyUserIds, rotationless, storedRows, from, to)
    : new Set<string>();

  // ---- Fresh reset (Deepika, 2026-11-24 — "Bring back everything
  // I deleted"). Runs BEFORE step 1, in draft mode only, and only
  // when mode is 'fresh'. Order matters: step 1's math reads the
  // stored shifts and the open-slot state, so the reset runs
  // BEFORE step 1 computes — otherwise step 1 would store against
  // the old drafts and step 2 would consume opens that were never
  // re-stored. Exclusions were already cleared above (before the
  // context load) — all origins in fresh, bulk only in keep.
  // The reset clears, in the draft's scope (rotations, picked
  // types/users, range; step-1 types for the open slots):
  //   - every still-draft row of the call's rotations (hand-added
  //     rows have rotation_id NULL and are never touched;
  //     published rows are never touched);
  //   - every closed-open suppression for the step-1 types, so
  //     closed days come back as opens;
  //   - every draft-open row for the step-1 types, so step 1
  //     rebuilds the shortfall from the target as it is now (the
  //     additive store would otherwise keep a stale count).
  // Positive extra rows are real added slots and are never
  // touched. Past dates are never reopened.
  const freshReplacedByRotation = new Map<string, number>();
  if (publishMode === 'draft' && mode === 'fresh') {
    // 1. Still-draft rows of the call's rotations in scope.
    {
      const delParams: any[] = [companyId, rotationIds, from, to];
      let delScope = '';
      if (onlyShiftTypeIds) {
        delScope += ` AND shift_type_id = ANY($${delParams.length + 1}::uuid[])`;
        delParams.push([...onlyShiftTypeIds]);
      }
      if (onlyUserIds) {
        delScope += ` AND user_id = ANY($${delParams.length + 1}::uuid[])`;
        delParams.push([...onlyUserIds]);
      }
      const { rows: del } = await tx(
        `DELETE FROM shifts
         WHERE company_id = $1 AND rotation_id = ANY($2::uuid[]) AND published = false
           AND date >= $3 AND date <= $4${delScope}
         RETURNING rotation_id AS "rotationId", user_id AS "userId",
                   date::text AS date, shift_type_id AS "shiftTypeId"`,
        delParams
      );
      for (const r of del) {
        freshReplacedByRotation.set(r.rotationId, (freshReplacedByRotation.get(r.rotationId) || 0) + 1);
      }
      // The deleted rows leave the in-memory stored set too, or
      // step 1 below would count them as filled.
      const delKeys = new Set(del.map((r: any) => `${r.userId}|${r.date}|${r.shiftTypeId}`));
      storedRows = storedRows.filter((s) => !delKeys.has(`${s.userId}|${s.date}|${s.shiftTypeId}`));
      // Audit the replaced drafts, one row per person (mirrors the
      // publish flow's per-person rows). Entries are RETURNED, not
      // written here: auditLog uses the global query, so writing
      // inside this transaction would leave phantom rows on a
      // rollback — the caller writes them after the commit.
      const byUser = new Map<string, { n: number; rotationId: string }>();
      for (const r of del) {
        const e = byUser.get(r.userId) || { n: 0, rotationId: r.rotationId };
        e.n++;
        byUser.set(r.userId, e);
      }
      for (const [uid, e] of byUser) {
        const { rows: nm } = await tx(
          'SELECT nickname, first_name, last_name FROM users WHERE id = $1', [uid]
        );
        const personName = nm.length
          ? (nm[0].nickname || `${nm[0].first_name || ''} ${nm[0].last_name || ''}`.trim() || null) : null;
        auditEntries.push({
          companyId, date: today, action: 'deleted', category: 'schedule',
          personName, source: 'rotation', changedBy: opts.createdBy,
          affectedUserId: uid, scheduleDate: from, scheduleDateEnd: to,
          rotationName: byId.get(e.rotationId)?.name,
          description: `Re-drafted from the rotation — ${e.n} draft shift(s) replaced (${from} – ${to})`,
          details: { generationId: generationIdByRotation.get(e.rotationId), rotationId: e.rotationId, count: e.n, from, to, mode: 'fresh' },
        });
      }
    }
    // 2. Closed-open suppressions + draft opens for the step-1
    // types, so closed days come back and the shortfall rebuilds.
    if (step1Types.size) {
      const pairs: Array<{ date: string; shiftTypeId: string }> = [];
      for (let n = dayNum(from); n <= dayNum(to); n++) {
        const date = dateOfDayNum(n);
        if (date < today) continue; // past is truth — never reopen the past
        for (const typeId of step1Types) pairs.push({ date, shiftTypeId: typeId });
      }
      const typeList = [...step1Types];
      const { rows: suppRows } = await tx(
        `SELECT COALESCE(SUM(count), 0)::int AS n FROM suppressed_open_slots
         WHERE company_id = $1 AND date >= $2 AND date <= $3 AND shift_type_id = ANY($4::text[])`,
        [companyId, from, to, typeList]
      );
      summary.clearedSuppressions = suppRows[0]?.n || 0;
      const { rows: draftRows2 } = await tx(
        `SELECT COALESCE(SUM(count), 0)::int AS n FROM draft_open_slots
         WHERE company_id = $1 AND date >= $2 AND date <= $3 AND shift_type_id = ANY($4::text[])`,
        [companyId, from, to, typeList]
      );
      summary.clearedDraftOpens = draftRows2[0]?.n || 0;
      await clearOpenSlotClosures(tx, companyId, pairs);
      await clearDraftOpenSlots(tx, companyId, pairs);
    }
    // 3. Stale delete-granted extras: deleting a shift grants one
    // extra open for the vacated position (ensureOpenSlotForDelete),
    // and fresh refills those positions from the rotation — the
    // granted extras would otherwise stand beside the returning
    // people as phantom opens, and step 1 would under-store
    // against them. Remove up to one extra per cleared exclusion
    // on the date+type — never more than the deletes, so a
    // hand-added extra survives whenever the deletes don't cover
    // it. Step 1 below then rebuilds the shortfall from the target
    // against the genuine extras only.
    if (step1Types.size && clearedExclusionsByPair.size) {
      let staleExtras = 0;
      for (let n = dayNum(from); n <= dayNum(to); n++) {
        const date = dateOfDayNum(n);
        if (date < today) continue; // past is truth — never reopen the past
        for (const typeId of step1Types) {
          const cap = clearedExclusionsByPair.get(`${date}|${typeId}`) || 0;
          if (!cap) continue;
          const { rows: exRows } = await tx(
            'SELECT count FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 FOR UPDATE',
            [companyId, date, typeId]
          );
          const cur = exRows.length ? Number(exRows[0].count) || 0 : 0;
          const take = Math.min(cur, cap);
          if (!take) continue;
          staleExtras += take;
          if (take >= cur) {
            await tx(
              'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
              [companyId, date, typeId]
            );
          } else {
            await tx(
              'UPDATE extra_open_slots SET count = $1 WHERE company_id = $2 AND date = $3 AND shift_type_id = $4',
              [cur - take, companyId, date, typeId]
            );
          }
        }
      }
      summary.clearedStaleExtras = staleExtras;
    }
  }

  // ---- Step 1 — targets first (Deepika, 2026-11-23). Pull the
  // staffing targets and store them as draft open slots, BEFORE
  // any rotation places anyone. Runs for draft mode only (the
  // Stage 4 migration stamps live truth and must not open
  // anything). The type set is the draft's scope: the types its
  // rotations produce, plus picked rotation-less types, plus any
  // generated type with a target that already has stored shifts
  // in the range (the footprint — March 2027: DH stood 12 draft
  // shifts, the draft's picks didn't include it, and no draft
  // opens were stored), plus — on a FULL draft (every active
  // rotation, no user/type picks) — every generated type with a
  // target, so a rotation-less type like Day NP gets its slots too.
  // step1Additions is kept for the net openedShortfall below.
  let step1Additions: Map<string, number> | null = null;
  if (publishMode === 'draft') {
    if (step1Types.size) {
      const inputs = await loadShortfallInputs(tx, companyId, from, to);
      const state = await loadOpenSlotState(tx, companyId, from, to);
      const additions = computeTargetStoreAdditions(inputs, storedRows, state, from, to, step1Types, today);
      step1Additions = additions;
      const res = await storeTargetSlots(tx, companyId, opts.createdBy, from, to, mode, additions, step1Types);
      summary.targetsStored = res.stored;
      summary.openedShortfall = res.stored;
      if (res.generationId) summary.generationIds.push(res.generationId);
    }
  }
  // Step 2's consumption: each new draft shift takes one stored
  // draft open for its date+type (applied once, after all
  // rotations have placed, so the count is exact).
  const consumedStep2 = new Map<string, number>();
  for (const id of ordered) {
    const rot = byId.get(id);
    const generationId = generationIdByRotation.get(id)!;
    await tx(
      `INSERT INTO rotation_generations
         (id, company_id, rotation_id, rotation_name, range_start, range_end, mode, created_by, user_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [generationId, companyId, id, rot.name, from, to, mode, opts.createdBy,
       onlyUserIds ? [...onlyUserIds] : null]
    );
    summary.generationIds.push(generationId);

    // Keep current changes (Deepika, 2026-11-23): in keep mode a
    // draft never deletes draft shifts — count the still-draft
    // rows that stay in place (picked members only, on a partial
    // draft). In fresh mode the reset above already replaced the
    // in-scope drafts, so replacedDrafts comes from the reset and
    // this counts only what fresh left alone (unpicked types).
    const replacedDrafts = freshReplacedByRotation.get(id) || 0;
    summary.replacedDrafts += replacedDrafts;
    let keptDrafts = 0;
    {
      const { rows: kept } = await tx(
        `SELECT COUNT(*)::int AS n FROM shifts
         WHERE company_id = $1 AND rotation_id = $2 AND published = false
           AND date >= $3 AND date <= $4${userScope}`,
        [companyId, id, from, to, ...userParams]
      );
      keptDrafts = kept[0]?.n || 0;
      summary.keptDrafts += keptDrafts;
    }

    const comp = computeRotationOccurrences(ctx, rot, from, to, storedRows, compOpts);
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
        // Step 2 consumes one stored draft open for this date+type
        // (draft mode only — the migration stamps live truth and
        // opens nothing). Applied in one batch after the loop, so
        // the count is exact however many rotations placed.
        if (publishMode === 'draft') {
          const k = `${o.date}|${o.shiftTypeId}`;
          consumedStep2.set(k, (consumedStep2.get(k) || 0) + 1);
        }
      }
    }
    summary.created += created;

    // Rule 7: departed entries become open slots (per-rotation
    // ledger) — for the Stage 4 migration (publishMode
    // 'published') ONLY. In draft mode the departed slots are
    // already inside step 1's stored shortfall, so a rule-7 grant
    // here would double-count them.
    let openedSlots = 0;
    if (publishMode === 'published') {
      const desired = new Map<string, number>();
      for (const d of comp.departed) {
        const k = `${d.date}|${d.shiftTypeId}`;
        desired.set(k, (desired.get(k) || 0) + 1);
      }
      openedSlots = await reconcileOpenSlots(tx, companyId, id, generationId, from, to, desired);
      summary.openedSlots += openedSlots;
    }

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

  // Step 2's consumption, applied once: each new draft shift takes
  // one stored draft open for its date+type (floor 0 — excess
  // rotation people still got their draft shift, so the count
  // never goes negative). The old post-loop shortfall pass is gone:
  // step 1 already stored the targets before the rotations placed,
  // and keep mode never clears suppressions (keep current changes).
  // Fresh mode cleared them in the reset above, before step 1.
  if (publishMode === 'draft') {
    for (const [k, take] of consumedStep2) {
      const [date, shiftTypeId] = k.split('|');
      const cur = await draftOpenTotal(tx, companyId, date, shiftTypeId);
      await setDraftOpenCount(tx, companyId, date, shiftTypeId, Math.max(0, cur - take), opts.createdBy);
    }
  }
  // openedShortfall is NET (the user-facing "Opened N open
  // positions still needed" — the step-1 opens still standing
  // after step 2 placed people into them), not the gross step-1
  // store: each placement takes one stored draft open for its
  // date+type, so a pair keeps max(0, stored − placed) opens.
  if (publishMode === 'draft' && step1Additions) {
    let remaining = 0;
    for (const [k, add] of step1Additions) {
      remaining += Math.max(0, add - (consumedStep2.get(k) || 0));
    }
    summary.openedShortfall = remaining;
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
