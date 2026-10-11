// util/shiftRange.ts — shared logic to get all visible shifts (manual + rotation-generated)
// for a date range. Used by the /shifts API endpoint and email question answering.

export interface ShiftEntry {
  id: string;
  date: string;
  personName: string;
  shiftTypeName: string;
  published: boolean;
  isRotation: boolean;
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
    `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate"
     FROM rotations WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );

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
    }));

  return [...visibleManual, ...rotationShifts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.personName.localeCompare(b.personName);
  });
}
