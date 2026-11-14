// util/scheduleMode.ts — background rotations (Deepika, 2026-11-13):
// the per-company schedule mode flag + generation coverage reads.
//
//   live       — today's drawing: every read draws occurrences from the
//                pattern (the default; production stays here until the
//                Stage 4 flip, on her explicit go).
//   generated  — stored rows only: the schedule shows what was drafted
//                (and published) from the rotations, nothing else.
//
// The flag lives in company_settings ('schedule_mode'), the existing
// per-company key/value home — no companies-table change. Readers
// default to 'live' when the key is absent, so every company that
// never opted in keeps today's behaviour.

type QueryFn = (text: string, params: any[]) => Promise<{ rows: any[] }>;

export type ScheduleMode = 'live' | 'generated';

export const SCHEDULE_MODE_KEY = 'schedule_mode';

/** The company's schedule mode ('live' when the key is absent). */
export async function getScheduleMode(
  q: QueryFn, companyId: string
): Promise<ScheduleMode> {
  try {
    const { rows } = await q(
      'SELECT value FROM company_settings WHERE company_id = $1 AND key = $2 LIMIT 1',
      [companyId, SCHEDULE_MODE_KEY]
    );
    return rows.length && rows[0].value === 'generated' ? 'generated' : 'live';
  } catch {
    return 'live';
  }
}

export async function isGeneratedMode(q: QueryFn, companyId: string): Promise<boolean> {
  return (await getScheduleMode(q, companyId)) === 'generated';
}

/** Flip the flag (owner-only endpoint; the Stage 4 migration tool). */
export async function setScheduleMode(
  q: QueryFn, companyId: string, mode: ScheduleMode
): Promise<void> {
  await q(
    `INSERT INTO company_settings (company_id, key, value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [companyId, SCHEDULE_MODE_KEY, mode]
  );
}

function dayNum(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}
function dateOfDayNum(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/**
 * Dates in [from, to] covered by at least one generation for this
 * company (any rotation). A date is "drafted" when a generation
 * covers it — the grid's "Not drafted yet" state and the plan
 * gate's undrafted-date clarification both read this. Per-rotation
 * coverage is finer (one rotation may be drafted while another is
 * not); the date-level rule is the v1 granularity, and the draft
 * panel shows the per-rotation truth.
 */
export async function getDraftedDates(
  q: QueryFn, companyId: string, from: string, to: string
): Promise<Set<string>> {
  const covered = new Set<string>();
  const { rows } = await q(
    `SELECT range_start::text AS "rangeStart", range_end::text AS "rangeEnd"
     FROM rotation_generations
     WHERE company_id = $1 AND range_end >= $2 AND range_start <= $3`,
    [companyId, from, to]
  );
  const fromN = dayNum(from);
  const toN = dayNum(to);
  for (const r of rows) {
    const s = Math.max(fromN, dayNum(r.rangeStart));
    const e = Math.min(toN, dayNum(r.rangeEnd));
    for (let n = s; n <= e; n++) covered.add(dateOfDayNum(n));
  }
  return covered;
}

/** Dates in [from, to] with no generation covering them, ascending. */
export async function getUndraftedDates(
  q: QueryFn, companyId: string, from: string, to: string
): Promise<string[]> {
  const covered = await getDraftedDates(q, companyId, from, to);
  const out: string[] = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) {
    const d = dateOfDayNum(n);
    if (!covered.has(d)) out.push(d);
  }
  return out;
}

/**
 * The most recent generation per rotation (for the D6 badge and the
 * draft panel): rotation id -> { id, createdAt }.
 */
export async function getLastGenerations(
  q: QueryFn, companyId: string, rotationIds: string[]
): Promise<Map<string, { id: string; createdAt: string }>> {
  const out = new Map<string, { id: string; createdAt: string }>();
  if (!rotationIds.length) return out;
  const { rows } = await q(
    `SELECT DISTINCT ON (rotation_id) rotation_id AS "rotationId", id,
            created_at::text AS "createdAt"
     FROM rotation_generations
     WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
     ORDER BY rotation_id, created_at DESC`,
    [companyId, rotationIds]
  );
  for (const r of rows) out.set(r.rotationId, { id: r.id, createdAt: r.createdAt });
  return out;
}
