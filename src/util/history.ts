/**
 * History snapshots (Deepika, 2026-11-17) — a safety-net copy of the
 * schedule, view-only, NO restore anywhere.
 *
 * A snapshot is saved on every publish, every change to a published
 * shift, and every draft change. Each row is a FROZEN copy of the
 * schedule as it stood at capture time: the stored shifts + drawn
 * rotation occurrences the grid was showing (names frozen at capture
 * — a later rename never rewrites a copy), plus the open-slot maps
 * and staffing targets so the copy view can recompute opens exactly.
 *
 * Scoping: a snapshot carries the departments its change touched; the
 * list and the copy view show a scheduler only entries touching a
 * department they can see (an empty set is owner-only). The by-date
 * filter reads created_date — the date in the company's own timezone.
 * Last 100 snapshots per company are kept; the 101st insert prunes
 * the oldest.
 *
 * Snapshots must never break the change they follow: recordHistorySnapshot
 * catches everything and returns null on failure.
 */
import crypto from 'crypto';
import { query } from '../db.js';
import { getDepartmentAccess, shiftTypesDepartmentIds, usersDepartmentIds } from './departmentAccess.js';
import { getGeneratedTypeIds, getNotDraftedByType } from './scheduleMode.js';
import { companyTodayStr } from './notifyJobs.js';

export type HistoryTrigger = 'publish' | 'published-change' | 'draft-change';

export const HISTORY_KEEP = 100;

function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

function displayName(u: any): string | null {
  if (!u) return null;
  return u.nickname || `${u.first_name || ''} ${u.last_name || ''}`.trim() || null;
}

/**
 * Capture the schedule as the grid shows it right now, over [from, to]:
 * the same stored rows + drawn rotation occurrences + open-slot maps
 * GET /shifts returns (manager view — drafts included), plus frozen
 * shift-type and staffing-target reference data so the copy view can
 * recompute opens exactly as the grid did. Names are copied at
 * capture time, so a later rename never rewrites the copy.
 *
 * drawRotationOccurrences lives in the schedule router, which imports
 * this module for the hooks — so it is imported lazily here to keep
 * the module graph acyclic.
 */
export async function captureScheduleState(companyId: string, from: string, to: string): Promise<any> {
  const { rows } = await query(
    `SELECT s.id, s.date::text AS date, s.notes, s.published,
            s.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
            u.nickname, s.shift_type_id AS "shiftTypeId",
            st.name AS "shiftTypeName", st.short_name AS "shiftTypeShort",
            st.color AS "shiftTypeColor", st.text_color AS "shiftTypeTextColor",
            false AS "isRotation", NULL AS "rotationId", NULL AS "rotationName"
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3
     ORDER BY s.date, st.sort_order, u.first_name, u.last_name`,
    [companyId, from, to]
  );
  const generatedTypes = await getGeneratedTypeIds(query, companyId);
  const { drawRotationOccurrences } = await import('../routes/schedule.js');
  const drawn = await drawRotationOccurrences(query, companyId, from, to, rows, { skipShiftTypeIds: generatedTypes });
  const all = [...rows, ...drawn.occurrences];
  all.sort((a: any, b: any) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const soA = a._sortOrder ?? 999;
    const soB = b._sortOrder ?? 999;
    if (soA !== soB) return soA - soB;
    const nA = `${a.firstName} ${a.lastName}`;
    const nB = `${b.firstName} ${b.lastName}`;
    return nA.localeCompare(nB);
  });
  // There is no closed flag any more (Deepika, 2026-11-21) — the
  // snapshot carries an empty list for shape-compat, so frozen
  // copies made after the build never show a flag.
  const closedShifts: any[] = [];
  const { rows: extraSlots } = await query(
    `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count
     FROM extra_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const { rows: unpublishedRows } = await query(
    `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COUNT(*)::int AS n
     FROM shifts WHERE company_id = $1 AND published = false AND date >= $2 AND date <= $3
     GROUP BY date, shift_type_id`,
    [companyId, from, to]
  );
  const unpublishedCounts: Record<string, number> = {};
  for (const r of unpublishedRows) unpublishedCounts[`${r.date}|${r.shiftTypeId}`] = r.n;
  const { rows: draftOpenRows } = await query(
    `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count AS n
     FROM draft_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const draftOpenCounts: Record<string, number> = {};
  for (const r of draftOpenRows) draftOpenCounts[`${r.date}|${r.shiftTypeId}`] = r.n;
  const { rows: typeRows } = await query(
    `SELECT id, name, short_name AS "shortName", color, text_color AS "textColor"
     FROM shift_types WHERE company_id = $1 ORDER BY sort_order, name`,
    [companyId]
  );
  const { rows: targetRows } = await query(
    `SELECT shift_type_id AS "shiftTypeId", target_count AS "targetCount",
            weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
     FROM staffing_targets WHERE company_id = $1`,
    [companyId]
  );
  // The undrafted-date map the grid uses to suppress opens on dates
  // nothing was drafted for yet — frozen too, so the copy view
  // recomputes opens exactly as the grid did at capture time.
  const notDraftedByType = await getNotDraftedByType(query, companyId, generatedTypes, from, to);
  return {
    from, to,
    shifts: all, closedShifts, extraSlots, unpublishedCounts, draftOpenCounts,
    shiftTypes: typeRows, targets: targetRows, notDraftedByType,
    includesDrafts: true,
  };
}

/**
 * Save one frozen copy after a change. The window covers the affected
 * dates with 14 days of history before and 62 days after (capped at
 * 120 days total, so a year-long publish does not capture a year of
 * drawn occurrences). Never throws — a failed copy must never break
 * the change it follows. Returns the snapshot id, or null.
 */
export async function recordHistorySnapshot(opts: {
  companyId: string;
  actorId: string | null;
  trigger: HistoryTrigger;
  summary: string;
  from: string;
  to: string;
  departmentIds?: string[];
  shiftTypeIds?: string[];
  userIds?: string[];
}): Promise<string | null> {
  try {
    const companyId = opts.companyId;
    const lo = isValidDate(opts.from) && isValidDate(opts.to)
      ? (opts.from <= opts.to ? opts.from : opts.to)
      : await companyTodayStr(companyId);
    const hi = isValidDate(opts.from) && isValidDate(opts.to)
      ? (opts.from <= opts.to ? opts.to : opts.from)
      : lo;
    let windowFrom = addDays(lo, -14);
    let windowTo = addDays(hi, 62);
    if (dayDiff(windowFrom, windowTo) > 120) windowTo = addDays(windowFrom, 120);

    let actorName: string | null = null;
    if (opts.actorId) {
      const { rows } = await query(
        'SELECT first_name, last_name, nickname FROM users WHERE id = $1',
        [opts.actorId]
      );
      if (rows.length) actorName = displayName(rows[0]);
    }
    const deptSet = new Set<string>([...(opts.departmentIds || [])].filter(Boolean));
    const [stDepts, uDepts] = await Promise.all([
      shiftTypesDepartmentIds(opts.shiftTypeIds || [], companyId),
      usersDepartmentIds(opts.userIds || [], companyId),
    ]);
    for (const d of [...stDepts, ...uDepts]) deptSet.add(d);
    const departmentIds = [...deptSet];

    const data = await captureScheduleState(companyId, windowFrom, windowTo);
    const createdDate = await companyTodayStr(companyId);
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO schedule_history_snapshots
         (id, company_id, created_date, created_by, created_by_name,
          trigger, summary, department_ids, window_from, window_to, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, companyId, createdDate, opts.actorId || null, actorName,
       opts.trigger, opts.summary || '', departmentIds, windowFrom, windowTo,
       JSON.stringify(data)]
    );
    // Keep the last 100 per company; the 101st drops the oldest.
    await query(
      `DELETE FROM schedule_history_snapshots
       WHERE company_id = $1 AND id IN (
         SELECT id FROM schedule_history_snapshots
         WHERE company_id = $1 ORDER BY created_at DESC OFFSET $2
       )`,
      [companyId, HISTORY_KEEP]
    );
    return id;
  } catch (err) {
    console.error('[history] snapshot failed:', (err as any)?.message || err);
    return null;
  }
}

export interface HistoryListEntry {
  id: string;
  createdAt: string;
  createdDate: string;
  createdByName: string | null;
  trigger: HistoryTrigger;
  summary: string;
  windowFrom: string;
  windowTo: string;
  link: string;
}

function toListEntry(r: any): HistoryListEntry {
  return {
    id: r.id,
    createdAt: r.created_at,
    createdDate: r.created_date,
    createdByName: r.created_by_name || null,
    trigger: r.trigger,
    summary: r.summary || '',
    windowFrom: r.window_from,
    windowTo: r.window_to,
    link: '/history-view.html?id=' + r.id,
  };
}

async function visibleDepartmentIds(userId: string, companyId: string, role: string): Promise<string[] | null> {
  if (role === 'owner') return null; // owner sees everything
  const access = await getDepartmentAccess(userId, companyId);
  return access.view || [];
}

/**
 * The History list, newest first (max 100). `date` is a company-local
 * date (YYYY-MM-DD) — the by-date view. A scheduler sees only entries
 * touching a department they can see; entries with no departments
 * are owner-only (they never overlap a scheduler's list).
 */
export async function listHistorySnapshots(
  companyId: string, userId: string, role: string, date?: string
): Promise<{ entries: HistoryListEntry[]; total: number }> {
  const view = await visibleDepartmentIds(userId, companyId, role);
  const params: any[] = [companyId];
  let where = 'WHERE company_id = $1';
  if (view !== null) {
    params.push(view);
    where += ` AND department_ids && $${params.length}::text[]`;
  }
  if (date && isValidDate(date)) {
    params.push(date);
    where += ` AND created_date = $${params.length}::date`;
  }
  const { rows } = await query(
    `SELECT id, created_at, created_date::text AS created_date,
            created_by_name, trigger, summary,
            window_from::text AS window_from, window_to::text AS window_to
     FROM schedule_history_snapshots ${where}
     ORDER BY created_at DESC LIMIT ${HISTORY_KEEP}`,
    params
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS n FROM schedule_history_snapshots ${where}`,
    params
  );
  return { entries: rows.map(toListEntry), total: countRows[0]?.n || 0 };
}

/** One frozen copy, or null when missing / out of the caller's scope. */
export async function getHistorySnapshot(
  companyId: string, userId: string, role: string, id: string
): Promise<any | null> {
  const { rows } = await query(
    `SELECT id, created_at, created_date::text AS created_date,
            created_by_name, trigger, summary,
            window_from::text AS window_from, window_to::text AS window_to,
            department_ids, data
     FROM schedule_history_snapshots WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (role !== 'owner') {
    const view = await visibleDepartmentIds(userId, companyId, role);
    const depts: string[] = row.department_ids || [];
    if (!depts.some((d) => (view || []).includes(d))) return null;
  }
  return {
    ...toListEntry(row),
    departmentIds: row.department_ids || [],
    data: row.data,
  };
}

/**
 * One snapshot for an approved AI plan (email or in-app Task — the
 * same brain, so the same hook). Called after the plan executes, at
 * both approve call sites. Results that changed nothing ("already
 * on…", "no change needed") do not count, and a settings-only plan
 * (no shift dates at all) takes no copy.
 */
export async function snapshotPlanExecution(
  companyId: string, actorId: string | null, plan: any, results: any[]
): Promise<string | null> {
  try {
    const changes = (plan?.plan?.changes) || [];
    const noop = /no change needed|already on|already exists/i;
    const ok = (results || []).filter((r: any) => r && r.success !== false && !(r.message && noop.test(String(r.message))));
    if (!ok.length) return null;
    const dates: string[] = [];
    const userIds = new Set<string>();
    const typeIds = new Set<string>();
    const typeNames = new Set<string>();
    for (const r of ok) {
      for (const s of (r.removedSlots || [])) {
        if (s?.userId) userIds.add(s.userId);
        if (s?.shiftTypeId) typeIds.add(s.shiftTypeId);
        if (isValidDate(s?.date)) dates.push(s.date);
      }
      if (Array.isArray(r.dates)) for (const d of r.dates) if (isValidDate(d)) dates.push(d);
    }
    const personNames = new Set<string>();
    for (const c of changes) {
      for (const d of [c.date, c.fromDate, c.toDate]) if (isValidDate(d)) dates.push(d);
      if (isValidDate(c.startDate)) dates.push(c.startDate);
      if (isValidDate(c.untilDate)) dates.push(c.untilDate);
      if (c.shiftType) typeNames.add(String(c.shiftType));
      for (const p of [c.person, c.fromPerson, c.toPerson]) if (p) personNames.add(String(p));
    }
    if (personNames.size) {
      const { rows } = await query(
        'SELECT id, nickname, first_name, last_name FROM users WHERE company_id = $1',
        [companyId]
      );
      for (const u of rows) {
        const disp = `${u.first_name || ''} ${u.last_name || ''}`.trim();
        if (personNames.has(u.nickname) || personNames.has(disp)) userIds.add(u.id);
      }
    }
    if (typeNames.size) {
      const { rows } = await query('SELECT id, name FROM shift_types WHERE company_id = $1', [companyId]);
      for (const t of rows) if (typeNames.has(t.name)) typeIds.add(t.id);
    }
    if (!dates.length && !userIds.size && !typeIds.size) return null;
    const sorted = [...new Set(dates)].sort();
    const firstMsg = (ok[0]?.message || '').toString();
    return recordHistorySnapshot({
      companyId, actorId, trigger: 'published-change',
      summary: `AI plan applied — ${ok.length} change${ok.length === 1 ? '' : 's'}${firstMsg ? `: ${firstMsg}` : ''}`,
      from: sorted[0] || await companyTodayStr(companyId),
      to: sorted[sorted.length - 1] || sorted[0] || await companyTodayStr(companyId),
      shiftTypeIds: [...typeIds], userIds: [...userIds],
    });
  } catch (err) {
    console.error('[history] plan snapshot failed:', (err as any)?.message || err);
    return null;
  }
}
