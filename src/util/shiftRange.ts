// util/shiftRange.ts — shared logic to get all visible shifts (manual + rotation-generated)
// for a date range. Used by the /shifts API endpoint and email question answering.
import { getShiftTypeTimes, makeTimedShift, findShiftConflict } from './shiftConflicts.js';

export interface ShiftEntry {
  id: string;
  date: string;
  personName: string;
  shiftTypeName: string;
  published: boolean;
  isRotation: boolean;
  /** Carried for callers that need the tuple identity (e.g. the
   * request form's pickers); display callers ignore them. */
  userId?: string;
  shiftTypeId?: string;
  rotationId?: string;
  /** Internal: a group-rotation ("special") shift during generation. */
  _special?: boolean;
}

type QueryFn = (text: string, params: any[]) => Promise<{ rows: any[] }>;

/**
 * Get all visible shifts for a company in a date range, including:
 * - Manual shifts from the shifts table
 * - Rotation-generated shifts (respecting pauses, exclusions, publish overrides)
 * Manual shifts take precedence over rotation shifts for the same user/date/shiftType.
 */
export async function getShiftsForRange(
  query: QueryFn,
  companyId: string,
  from: string,
  to: string
): Promise<ShiftEntry[]> {
  // Manual shifts
  const { rows: manualRows } = await query(
    `SELECT s.date::text AS date,
            COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS "personName",
            st.name AS "shiftTypeName", s.published,
            s.user_id AS "userId", s.shift_type_id AS "shiftTypeId"
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3`,
    [companyId, from, to]
  );

  // Active rotations
  const { rows: rotations } = await query(
    `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate",
            group_id AS "groupId", group_ids AS "groupIds", group_shift_type_id AS "groupShiftTypeId",
            group_days AS "groupDays", turn_unit AS "turnUnit",
            turn_days AS "turnDays", week_start AS "weekStart"
     FROM rotations WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );

  // Vacation ranges per person (pauses attach to the rotations a
  // person is assigned to) — group turns skip a member on vacation.
  const { rows: vacRows } = await query(
    `SELECT ra.user_id AS "userId", p.start_date::text AS "startDate", p.end_date::text AS "endDate"
     FROM rotation_pauses p
     JOIN rotation_assignments ra ON ra.rotation_id = p.rotation_id
     WHERE p.company_id = $1`,
    [companyId]
  );
  const vacMap = new Map<string, Array<{ start: string; end: string }>>();
  for (const v of vacRows) {
    if (!vacMap.has(v.userId)) vacMap.set(v.userId, []);
    vacMap.get(v.userId)!.push({ start: v.startDate, end: v.endDate });
  }
  const onVacation = (userId: string, dateStr: string): boolean => {
    const periods = vacMap.get(userId);
    if (!periods) return false;
    return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
  };

  // Pause periods
  const { rows: pauseRows } = await query(
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
  const isPaused = (rotationId: string, dateStr: string): boolean => {
    const periods = pauseMap.get(rotationId);
    if (!periods) return false;
    return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
  };

  // Exclusions (deleted rotation instances)
  const { rows: exclRows } = await query(
    `SELECT rotation_id AS "rotationId", user_id AS "userId",
            date::text AS "date", shift_type_id AS "shiftTypeId"
     FROM rotation_shift_exclusions
     WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const exclSet = new Set(exclRows.map((e: any) =>
    `${e.rotationId}|${e.userId}|${e.date}|${e.shiftTypeId}`
  ));

  // Publish overrides
  const { rows: pubRows } = await query(
    `SELECT rotation_id AS "rotationId", user_id AS "userId",
            date::text AS "date", shift_type_id AS "shiftTypeId", published
     FROM rotation_shift_publish
     WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const pubMap = new Map(pubRows.map((p: any) =>
    [`${p.rotationId}|${p.userId}|${p.date}|${p.shiftTypeId}`, p.published]
  ));

  const rotationShifts: ShiftEntry[] = [];
  const userPauseMap = new Map<string, Array<{ start: string; end: string }>>();

  for (const rot of rotations) {
    const { rows: assignments } = await query(
      `SELECT ra.user_id AS "userId", ra.cycle_day AS "cycleDay",
              ra.shift_type_id AS "shiftTypeId",
              COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS "personName",
              u.is_active AS "userActive", u.end_date AS "userEndDate",
              st.name AS "shiftTypeName"
       FROM rotation_assignments ra
       JOIN users u ON u.id = ra.user_id
       JOIN shift_types st ON st.id = ra.shift_type_id
       WHERE ra.rotation_id = $1 AND u.is_active = true`,
      [rot.id]
    );

    // Group rotation ("special shift", Deepika 2026-11-04): members
    // take turns in fixed order; turns are a pure function of the
    // date, counted from the rotation's start.
    if ((rot as any).groupId && (rot as any).groupShiftTypeId) {
      const groupIds = String((rot as any).groupIds || (rot as any).groupId)
        .split(',').map((x: string) => x.trim()).filter(Boolean);
      const groupsMembers: any[][] = [];
      for (const gid of groupIds) {
        const { rows: members } = await query(
          `SELECT gm.user_id AS "userId",
                  COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS "personName",
                  u.end_date AS "userEndDate", st.name AS "shiftTypeName"
           FROM rotation_group_members gm
           JOIN users u ON u.id = gm.user_id
           JOIN shift_types st ON st.id = $2
           WHERE gm.group_id = $1 AND u.is_active = true
           ORDER BY gm.position`,
          [gid, (rot as any).groupShiftTypeId]
        );
        groupsMembers.push(members);
      }
      const daySet = new Set(
        String((rot as any).groupDays || '').split(',').map((x: string) => Number(x)).filter((n: number) => n >= 1)
      );
      if (groupsMembers.length && groupsMembers.some((g) => g.length) && daySet.size) {
        const stId = (rot as any).groupShiftTypeId as string;
        const unit = (rot as any).turnUnit || 'shift';
        const tDays = Math.max(1, Number((rot as any).turnDays) || 1);
        const wStart = Number.isInteger((rot as any).weekStart) ? (rot as any).weekStart : 1;
        const dayMs = 86400000;
        const startMs = Date.parse(rot.startDate + 'T00:00:00Z');
        const fromMs = Date.parse(from + 'T00:00:00Z');
        const toMs = Date.parse(to + 'T00:00:00Z');
        const anchorMs = startMs - ((new Date(startMs).getUTCDay() - wStart + 7) % 7) * dayMs;
        let occ = 0;
        let blockIdx = -1;
        let lastKey: string | null = null;
        // Vacation swap (mirrors schedule.ts): a member on vacation
        // at their turn's start is owed the next turn; the next
        // available member in the order takes the whole turn.
        const dealState = groupsMembers.map(() => ({ ptr: 0, owed: [] as number[] }));
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
            const gm = groupsMembers[gIdx];
            const st = dealState[gIdx];
            currentMember = null;
            if (st.owed.length && !onVacation(gm[st.owed[0]].userId, dateStr)) {
              currentMember = gm[st.owed.shift()!];
            } else if (gm.length) {
              for (let step = 0; step < gm.length; step++) {
                const idx = (st.ptr + step) % gm.length;
                if (!onVacation(gm[idx].userId, dateStr)) {
                  currentMember = gm[idx];
                  st.ptr = (idx + 1) % gm.length;
                  break;
                }
                if (!st.owed.includes(idx)) st.owed.push(idx);
              }
            }
          }
          if (ms < fromMs) continue;
          const m = currentMember;
          if (!m) continue;
          if (m.userEndDate && dateStr > String(m.userEndDate).slice(0, 10)) continue;
          const hasManual = manualRows.some((s: any) =>
            s.userId === m.userId && s.date === dateStr && s.shiftTypeId === stId
          );
          if (hasManual) continue;
          if (isPaused(rot.id, dateStr)) continue;
          if (onVacation(m.userId, dateStr)) continue;
          const exclKey = `${rot.id}|${m.userId}|${dateStr}|${stId}`;
          if (exclSet.has(exclKey)) continue;
          rotationShifts.push({
            id: `rot-${rot.id}-${m.userId}-${dateStr}`,
            date: dateStr,
            personName: m.personName,
            shiftTypeName: m.shiftTypeName,
            published: pubMap.has(exclKey) ? pubMap.get(exclKey) : true,
            isRotation: true,
            userId: m.userId,
            shiftTypeId: stId,
            rotationId: rot.id,
            _special: true,
          });
        }
      }
      continue;
    }

    if (assignments.length === 0) continue;

    // Track pause periods per user
    const periods = pauseMap.get(rot.id);
    if (periods) {
      for (const a of assignments) {
        if (!userPauseMap.has(a.userId)) userPauseMap.set(a.userId, []);
        userPauseMap.get(a.userId)!.push(...periods);
      }
    }

    const byDay = new Map<number, typeof assignments>();
    for (const a of assignments) {
      if (!byDay.has(a.cycleDay)) byDay.set(a.cycleDay, []);
      byDay.get(a.cycleDay)!.push(a);
    }

    const startDate = new Date(rot.startDate + 'T00:00:00');
    const fromDate = new Date(from + 'T00:00:00');
    const toDate = new Date(to + 'T00:00:00');
    const cycleDays = rot.cycleDays;

    for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      if (d < startDate) continue;

      const daysSinceStart = Math.floor((d.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      const cycleDay = (daysSinceStart % cycleDays) + 1;

      const dayAssignments = byDay.get(cycleDay);
      if (!dayAssignments) continue;

      for (const a of dayAssignments) {
        if (a.userEndDate && dateStr > String(a.userEndDate).slice(0, 10)) continue;

        // Manual shifts take precedence
        const hasManual = manualRows.some((s: any) =>
          s.userId === a.userId && s.date === dateStr && s.shiftTypeId === a.shiftTypeId
        );
        if (hasManual) continue;
        if (isPaused(rot.id, dateStr)) continue;

        const exclKey = `${rot.id}|${a.userId}|${dateStr}|${a.shiftTypeId}`;
        if (exclSet.has(exclKey)) continue;

        rotationShifts.push({
          id: `rot-${rot.id}-${a.userId}-${dateStr}`,
          date: dateStr,
          personName: a.personName,
          shiftTypeName: a.shiftTypeName,
          published: pubMap.has(exclKey) ? pubMap.get(exclKey) : true,
          isRotation: true,
          userId: a.userId,
          shiftTypeId: a.shiftTypeId,
        });
      }
    }
  }

  // Hide manual shifts for users paused on that date
  const isUserPaused = (userId: string, dateStr: string): boolean => {
    const periods = userPauseMap.get(userId);
    if (!periods) return false;
    return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
  };
  const visibleManual: ShiftEntry[] = manualRows
    .filter((s: any) => !s.userId || !isUserPaused(s.userId, s.date))
    .map((s: any) => ({
      id: `manual-${s.date}-${s.userId}`,
      date: s.date,
      personName: s.personName,
      shiftTypeName: s.shiftTypeName,
      published: s.published,
      isRotation: false,
      userId: s.userId,
      shiftTypeId: s.shiftTypeId,
    }));

  // Special-shift precedence (Deepika 2026-11-04): a group-rotation
  // shift takes preference over the same person's OTHER rotation
  // shifts — a clashing normal occurrence is not generated. Manual
  // shifts are never touched.
  if (rotationShifts.some((s) => s._special)) {
    const typeTimes = await getShiftTypeTimes(query, companyId);
    const specialsByUser = new Map<string, any[]>();
    for (const s of rotationShifts) {
      if (!s._special || !s.userId || !s.shiftTypeId) continue;
      if (!specialsByUser.has(s.userId)) specialsByUser.set(s.userId, []);
      specialsByUser.get(s.userId)!.push(makeTimedShift(typeTimes, s.userId, s as any));
    }
    for (let i = rotationShifts.length - 1; i >= 0; i--) {
      const s = rotationShifts[i];
      if (s._special) { delete s._special; continue; }
      if (!s.userId || !s.shiftTypeId) continue;
      const specials = specialsByUser.get(s.userId);
      if (!specials || !specials.length) continue;
      const timed = makeTimedShift(typeTimes, s.userId, s as any);
      if (specials.some((sp: any) => !!findShiftConflict('This person', [sp], timed))) {
        rotationShifts.splice(i, 1);
      }
    }
  }

  return [...visibleManual, ...rotationShifts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.personName.localeCompare(b.personName);
  });
}
