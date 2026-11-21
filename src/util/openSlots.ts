/**
 * openSlots.ts — the shared open-slot writes (Deepika, 2026-11-20 —
 * fix list: "Close this slot" must REALLY delete the slot, and draft
 * opens must be born DRAFT).
 *
 * The open count for a date+type is:
 *   closed ? 0 : max(0, target + extra - filled - suppressed)
 * where `extra` is extra_open_slots (never negative from a close
 * anymore), `filled` is stored shifts, and `suppressed` is
 * suppressed_open_slots — computed opens a manager closed, which
 * stay closed until the next draft/publish of that date+type pulls
 * them back from the rotation (target - filled). Live-mode types
 * never go through the draft/publish clearing here: the draft panel
 * refuses live rotations, and the publish paths filter to generated
 * types before calling publishOpenSlotsForPairs.
 *
 * This module imports nothing from the routes, the planner, or the
 * engine — every helper takes the caller's query fn (inside the
 * caller's transaction where one exists), so there are no cycles.
 */

export type OpenSlotQuery = (
  text: string,
  params?: any[]
) => Promise<{ rows: any[]; rowCount?: number }>;

export interface OpenSlotPair { date: string; shiftTypeId: string }

function pairKey(p: OpenSlotPair): string {
  return `${p.date}|${p.shiftTypeId}`;
}

function dedupePairs(pairs: OpenSlotPair[]): OpenSlotPair[] {
  const seen = new Set<string>();
  const out: OpenSlotPair[] = [];
  for (const p of pairs) {
    if (!p || !p.date || !p.shiftTypeId) continue;
    const k = pairKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ date: p.date, shiftTypeId: p.shiftTypeId });
  }
  return out;
}

/** Suppressed opens for one date+type (0 when none). */
export async function suppressedTotal(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string
): Promise<number> {
  const { rows } = await q(
    `SELECT COALESCE(SUM(count), 0)::int AS n FROM suppressed_open_slots
     WHERE company_id = $1 AND date = $2 AND shift_type_id = $3`,
    [companyId, date, shiftTypeId]
  );
  return Number(rows[0]?.n || 0);
}

/** Suppressed opens for a range, keyed "date|shiftTypeId". */
export async function suppressedMap(
  q: OpenSlotQuery, companyId: string, from: string, to: string
): Promise<Map<string, number>> {
  const { rows } = await q(
    `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COALESCE(SUM(count), 0)::int AS n
     FROM suppressed_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3
     GROUP BY date, shift_type_id`,
    [companyId, from, to]
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(`${r.date}|${r.shiftTypeId}`, Number(r.n || 0));
  return out;
}

/**
 * Close `count` visible opens for one date+type — the close itself
 * (Deepika, 2026-11-20: "when it says close slot it goes away
 * permanently"). Extra slots go first: a stored positive row is
 * really deleted (delete at 0, never a negative row). Whatever is
 * left over is shortfall — computed opens with no stored row — so it
 * is recorded in suppressed_open_slots until the next draft/publish
 * of that date+type pulls it back. Returns the split, so the undo
 * payload can reverse each part exactly. Callers must only close
 * opens that are actually visible (they already guard on the total).
 */
export async function closeOpenSlots(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  count: number, createdBy: string | null
): Promise<{ extraDeleted: number; suppressed: number }> {
  if (!Number.isInteger(count) || count <= 0) return { extraDeleted: 0, suppressed: 0 };
  const { rows: cur } = await q(
    'SELECT count FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 FOR UPDATE',
    [companyId, date, shiftTypeId]
  );
  const positive = cur.length ? Math.max(0, Number(cur[0].count) || 0) : 0;
  const fromExtra = Math.min(positive, count);
  if (fromExtra > 0) {
    const next = positive - fromExtra;
    if (next === 0) {
      await q(
        'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
        [companyId, date, shiftTypeId]
      );
    } else {
      await q(
        'UPDATE extra_open_slots SET count = $1 WHERE company_id = $2 AND date = $3 AND shift_type_id = $4',
        [next, companyId, date, shiftTypeId]
      );
    }
  }
  const remainder = count - fromExtra;
  if (remainder > 0) {
    await q(
      `INSERT INTO suppressed_open_slots (company_id, date, shift_type_id, count, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, date, shift_type_id)
       DO UPDATE SET count = suppressed_open_slots.count + EXCLUDED.count`,
      [companyId, date, shiftTypeId, remainder, createdBy]
    );
  }
  return { extraDeleted: fromExtra, suppressed: remainder };
}

/**
 * Clear every closure for the given (date, type) pairs — the
 * "pulled back from rotations when drafted or published" half of
 * the rule (Deepika, 2026-11-20). Deletes the whole-type closed
 * flag, the suppressed shortfall closes, and any legacy negative
 * extra row still sitting there (no path writes one anymore; the
 * migration moved them all, this is the backstop). Positive extra
 * rows are real added slots and are never touched.
 */
export async function clearOpenSlotClosures(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[]
): Promise<void> {
  const list = dedupePairs(pairs);
  for (const p of list) {
    await q(
      'DELETE FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
      [companyId, p.date, p.shiftTypeId]
    );
    await q(
      'DELETE FROM suppressed_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
      [companyId, p.date, p.shiftTypeId]
    );
    await q(
      'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count < 0',
      [companyId, p.date, p.shiftTypeId]
    );
  }
}

/**
 * Set the draft-open count for one date+type (the draft's own
 * opens). 0 deletes the row, like extra_open_slots. The count is
 * SET, not added — a re-draft re-derives it from the shortfall, so
 * a stale count never lingers once the shortfall is gone.
 */
export async function setDraftOpenCount(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  count: number, createdBy: string | null
): Promise<void> {
  if (!Number.isInteger(count) || count <= 0) {
    await q(
      'DELETE FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
      [companyId, date, shiftTypeId]
    );
    return;
  }
  await q(
    `INSERT INTO draft_open_slots (company_id, date, shift_type_id, count, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, date, shift_type_id)
     DO UPDATE SET count = EXCLUDED.count, updated_at = now()`,
    [companyId, date, shiftTypeId, count, createdBy]
  );
}

/** Delete every draft-open row for the given (date, type) pairs. */
export async function clearDraftOpenSlots(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[]
): Promise<void> {
  const list = dedupePairs(pairs);
  for (const p of list) {
    await q(
      'DELETE FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
      [companyId, p.date, p.shiftTypeId]
    );
  }
}

/**
 * Publishing the day publishes the opens with it (Deepika,
 * 2026-11-20 — "when i publish them then they should go to be
 * available"): for every GENERATED (date, type) pair the publish
 * touched, the draft-open rows go (the opens become published) and
 * the closures go (a suppressed or closed day is pulled back). Live
 * types are filtered out by the caller — their opens were never
 * draft and their closures are not this rule's business.
 */
export async function publishOpenSlotsForPairs(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[],
  generatedTypeIds: Set<string>
): Promise<void> {
  const list = dedupePairs(pairs).filter((p) => generatedTypeIds.has(p.shiftTypeId));
  if (!list.length) return;
  await clearDraftOpenSlots(q, companyId, list);
  await clearOpenSlotClosures(q, companyId, list);
}

/**
 * The rotation's own opens for one date+type: staffing-target
 * shortfall (target - filled, clamped at 0), the same math the
 * draft uses — used when a publish is undone, so the day goes back
 * to draft opens instead of staying published. Extras are not part
 * of it: they were published before and stay published.
 */
export async function shortfallFor(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string
): Promise<number> {
  const { rows: trows } = await q(
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
  const { rows: frows } = await q(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const filled = Number(frows[0]?.n || 0);
  return Math.max(0, target - filled);
}
