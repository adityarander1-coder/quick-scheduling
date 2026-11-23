/**
 * openSlots.ts — the shared open-slot writes (Deepika, 2026-11-20 —
 * fix list: "Close this slot" must REALLY delete the slot, and draft
 * opens must be born DRAFT).
 *
 * The open count for a date+type is:
 *   max(0, target + extra - filled - suppressed)
 * where `extra` is extra_open_slots (never negative from a close
 * anymore), `filled` is the GRID's filled count — stored shifts
 * plus the rotation occurrences the grid draws for live types
 * (a generated type never draws, so its filled is stored-only) —
 * and `suppressed` is suppressed_open_slots — computed opens a
 * manager closed, which stay closed until the next draft/publish
 * of that date+type pulls them back from the rotation
 * (target - filled). There is NO closed flag any more (Deepika,
 * 2026-11-21 — "why is it hanging on to not letting us add"): a
 * whole-type close deletes the slots and suppresses exactly the
 * visible shortfall with stored rows, so a later add lands on the
 * date and shows. Live-mode types never go through the
 * draft/publish clearing here: the draft panel refuses live
 * rotations, and the publish paths filter to generated types
 * before calling publishOpenSlotsForPairs.
 *
 * The stored-model count (Deepika, 2026-11-20/21 — "the
 * calculation should come from real schedule, not from rotation"):
 * for a GENERATED type the opens are
 *   max(0, max(0, target - filled) + extra - suppressed)
 * — the shortfall (target - filled) is clamped at 0 BEFORE the
 * stored extras are added, so over-target filled never eats stored
 * extras. It equals the formula above whenever filled <= target.
 * storedTotals below is that count, from the stored schedule only
 * (draft + published shifts + stored open slots); live-mode types
 * keep the computed formula above.
 *
 * This module imports nothing from the routes, the planner, or the
 * engine — every helper takes the caller's query fn (inside the
 * caller's transaction where one exists), so there are no cycles.
 * The one exception is scheduleMode, a sibling util: closeTypeForDate
 * needs the undrafted check (on an undrafted generated date the
 * target contributes 0 to the grid, so nothing is suppressed there).
 * The History snapshot stays the caller's job for the same reason.
 * Whole-type closes (bulk, day dialog, AI closeAll) all go through
 * closeTypeForDate: it applies the SAME single-slot delete
 * (deleteOneOpenSlot) to every visible open for the date+type,
 * sweeps any stored row the loop cannot reach, and suppresses
 * exactly the visible shortfall — "when i say close any where it
 * should be gone" (Deepika, 2026-11-20) and "use the SAME function
 * for both the per-slot X and the type-close" (Deepika, 2026-11-21).
 */

import { getGeneratedTypeIds, getNotDraftedByType, getUndraftedDatesForType } from './scheduleMode.js';
import { getShiftsForRange } from './shiftRange.js';

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

export interface DeleteOneOpenSlotResult {
  /** True when a stored extra row lost one. */
  fromExtra: boolean;
  /** True when the stored draft-open count lost one. */
  fromDraft: boolean;
  /** True when a computed shortfall open was suppressed. */
  suppressed: boolean;
}

/**
 * Delete exactly ONE visible open slot for a date+type — the ONE
 * delete every close path uses (Deepika, 2026-11-21 — "use the SAME
 * function for both the per-slot X and the type-close"). A stored
 * extra goes first: it is really deleted (delete at 0, never a
 * negative row). Otherwise the slot is a computed shortfall open,
 * so it is suppressed until the next draft/publish of that
 * date+type pulls it back — and when that open was a draft open,
 * the stored draft count loses one too, so the draft badge never
 * sits one too high (the old X left it there and the UI clamped).
 * The two are NOT double-counting: the manager count is
 * target + extra − suppressed − filled (openCountFor) — the draft
 * count never enters it, it only decides how many of the visible
 * positions render with the DRAFT badge. Returns the split, so
 * callers can reverse each part exactly. Safety (Deepika,
 * 2026-11-21): when no visible open is left the primitive refuses
 * (no-op, no suppression row) — a raw count past the visible total
 * can never store a phantom suppression.
 */
export async function deleteOneOpenSlot(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  createdBy: string | null
): Promise<DeleteOneOpenSlotResult> {
  const { rows: cur } = await q(
    'SELECT count FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 FOR UPDATE',
    [companyId, date, shiftTypeId]
  );
  const positive = cur.length ? Math.max(0, Number(cur[0].count) || 0) : 0;
  if (positive > 0) {
    if (positive === 1) {
      await q(
        'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
        [companyId, date, shiftTypeId]
      );
    } else {
      await q(
        'UPDATE extra_open_slots SET count = $1 WHERE company_id = $2 AND date = $3 AND shift_type_id = $4',
        [positive - 1, companyId, date, shiftTypeId]
      );
    }
    return { fromExtra: true, fromDraft: false, suppressed: false };
  }
  // Safety (Deepika, 2026-11-21 — "if she closes 5 when only 4
  // opens exist, the 5th must NOT be stored"): with no stored extra
  // left, refuse when no visible open is left. The suppression
  // insert below would otherwise write a phantom +1 row that hides
  // a later add. Callers already clamp to the visible total; this
  // is the last line of defence, so a raw count can never
  // over-suppress. No row is written and nothing is decremented.
  const totals = await storedTotals(q, companyId, date, shiftTypeId);
  let visible = totals.opens;
  if (visible > 0) {
    // Undrafted generated dates show only stored extras (the
    // target counts 0) — and there are none left here — so nothing
    // is visible even when the raw target has a shortfall.
    const generatedIds = await getGeneratedTypeIds(q, companyId);
    if (generatedIds.has(shiftTypeId) &&
        (await getUndraftedDatesForType(q, companyId, shiftTypeId, date, date)).includes(date)) {
      visible = 0;
    }
  }
  if (visible <= 0) return { fromExtra: false, fromDraft: false, suppressed: false };
  const { rows: drows } = await q(
    'SELECT count FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 FOR UPDATE',
    [companyId, date, shiftTypeId]
  );
  const draft = drows.length ? Math.max(0, Number(drows[0].count) || 0) : 0;
  if (draft > 0) {
    if (draft === 1) {
      await q(
        'DELETE FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
        [companyId, date, shiftTypeId]
      );
    } else {
      await q(
        'UPDATE draft_open_slots SET count = $1 WHERE company_id = $2 AND date = $3 AND shift_type_id = $4',
        [draft - 1, companyId, date, shiftTypeId]
      );
    }
  }
  await q(
    `INSERT INTO suppressed_open_slots (company_id, date, shift_type_id, count, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (company_id, date, shift_type_id)
     DO UPDATE SET count = suppressed_open_slots.count + 1`,
    [companyId, date, shiftTypeId, createdBy]
  );
  return { fromExtra: false, fromDraft: draft > 0, suppressed: true };
}

/**
 * Close `count` visible opens for one date+type — the close itself
 * (Deepika, 2026-11-20: "when it says close slot it goes away
 * permanently"). It is the shared single-slot delete above, applied
 * `count` times: stored extras go first (really deleted, never a
 * negative row), then computed shortfall opens are suppressed until
 * the next draft/publish pulls them back — and a draft open that is
 * closed loses its stored draft count too. Returns the split, so
 * the undo payload can reverse each part exactly. A count past the
 * visible total stops at the last visible open: the primitive
 * refuses the extra turns, so nothing phantom is stored.
 *
 * Whole-type closes go through closeTypeForDate below: the same
 * single-slot delete, applied to every visible open for the
 * date+type, plus a sweep of any stored row the loop cannot reach
 * and the closed flag.
 */
export async function closeOpenSlots(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  count: number, createdBy: string | null
): Promise<{ extraDeleted: number; draftDeleted: number; suppressed: number }> {
  if (!Number.isInteger(count) || count <= 0) return { extraDeleted: 0, draftDeleted: 0, suppressed: 0 };
  let extraDeleted = 0;
  let draftDeleted = 0;
  let suppressed = 0;
  for (let i = 0; i < count; i++) {
    const r = await deleteOneOpenSlot(q, companyId, date, shiftTypeId, createdBy);
    if (r.fromExtra) extraDeleted++;
    if (r.fromDraft) draftDeleted++;
    if (r.suppressed) suppressed++;
  }
  return { extraDeleted, draftDeleted, suppressed };
}

export interface CloseTypeResult {
  /** Visible opens before the close (clamped stored-model count). */
  totalBefore: number;
  /** Stored draft-open count before the close. */
  draftBefore: number;
  /** Stored extras really deleted (never negative). */
  extraDeleted: number;
  /** Stored draft opens really deleted. */
  draftDeleted: number;
  /** Suppressions that existed BEFORE this close. */
  suppressedDeleted: number;
  /** Suppression left behind: exactly the visible shortfall. */
  suppressedCreated: number;
}

/**
 * Close a whole shift type for one date — the shared whole-type
 * close (Deepika, 2026-11-20 — "when i say close any where it
 * should be gone" · "it cannot store from any where"; 2026-11-21 —
 * "use the SAME function for both the per-slot X and the type-close":
 * the type-close is just that same delete applied to all open slots
 * of the type for the date). There is NO closed flag any more
 * (Deepika, 2026-11-21 — "why is it hanging on to not letting us
 * add"): in one transaction, for that (company, date, type):
 *   1. Applies deleteOneOpenSlot once per visible open — the SAME
 *      delete the per-slot X uses (stored extras really deleted,
 *      shortfall opens suppressed, draft counts decremented). The
 *      visible count is the clamped stored-model count
 *      max(0, max(0, target - filled) + extra - suppressed), so
 *      over-target filled never eats stored extras.
 *   2. Sweeps any stored row the loop cannot reach: extras hidden
 *      by an over-suppression and draft rows taller than the
 *      visible shortfall.
 *   3. Normalizes the suppression to exactly the visible shortfall
 *      (deletes every suppressed row, inserts one row of
 *      `shortfall` when it is > 0) — so opens land at 0 and no
 *      over-suppression survives to eat a future add.
 * Nothing stored survives except that one suppression row: a later
 * add (manual or AI) lands on the date and shows, and a later
 * re-draft clears the suppression and creates only the fresh
 * shortfall. The History snapshot is the caller's job (it uses the
 * pool, not the caller's query fn). Returns the breakdown, so the
 * undo payload can reverse each part exactly — suppressedDeleted
 * counts only the suppressions that existed BEFORE this close, so
 * an undo restores the day exactly as it was. Runs even on a date
 * with no opens — stored rows added while the shortfall was 0 are
 * deleted too.
 *
 * Undrafted generated dates (decision N2): the grid counts the
 * staffing target as 0 there — only manually added extras count —
 * so the effective target is 0 and nothing is suppressed. (Without
 * this, closing an undrafted date would leave a suppression that
 * hides the next extra added to it.)
 */
export async function closeTypeForDate(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  createdBy: string | null
): Promise<CloseTypeResult> {
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
  const { rows: erows } = await q(
    'SELECT COALESCE(SUM(count), 0)::int AS n FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const extra = Number(erows[0]?.n || 0);
  const suppressed = await suppressedTotal(q, companyId, date, shiftTypeId);
  const { rows: frows } = await q(
    'SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const filled = Number(frows[0]?.n || 0);
  const { rows: drows } = await q(
    'SELECT count FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const draft = drows.length ? Number(drows[0].count) || 0 : 0;
  // Undrafted generated dates show only extras (target counts 0) —
  // suppressing the target shortfall there would hide future adds.
  const generatedIds = await getGeneratedTypeIds(q, companyId);
  const undrafted = generatedIds.has(shiftTypeId)
    ? (await getUndraftedDatesForType(q, companyId, shiftTypeId, date, date)).includes(date)
    : false;
  const effectiveTarget = undrafted ? 0 : target;
  const shortfall = Math.max(0, effectiveTarget - filled);
  const totalBefore = Math.max(0, shortfall + extra - suppressed);
  // The SAME delete every close path uses (Deepika, 2026-11-21):
  // the shared single-slot delete, applied once per visible open
  // for the date+type.
  let extraDeleted = 0;
  let draftDeleted = 0;
  for (let i = 0; i < totalBefore; i++) {
    const r = await deleteOneOpenSlot(q, companyId, date, shiftTypeId, createdBy);
    if (r.fromExtra) extraDeleted++;
    if (r.fromDraft) draftDeleted++;
  }
  // Sweep what the loop cannot reach, so the close still deletes
  // EVERY stored extra/draft row for the date+type (never
  // weakened): extras hidden by an over-suppression (visible opens
  // fewer than stored extras) and draft rows taller than the
  // visible shortfall.
  const delExtra = await q(
    'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 RETURNING count',
    [companyId, date, shiftTypeId]
  );
  // A legacy negative row is still deleted (never re-created); the
  // undo only ever re-adds the positive part.
  extraDeleted += Math.max(0, delExtra.rows.reduce((n: number, r: any) => n + (Number(r.count) || 0), 0));
  const delDraft = await q(
    'DELETE FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 RETURNING count',
    [companyId, date, shiftTypeId]
  );
  draftDeleted += Math.max(0, delDraft.rows.reduce((n: number, r: any) => n + (Number(r.count) || 0), 0));
  // Normalize the suppression to exactly the visible shortfall:
  // the loop's own suppressions are transient (deleted here) and
  // only this one row persists, so opens land at 0 and a future
  // add is never eaten.
  await q(
    'DELETE FROM suppressed_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  if (shortfall > 0) {
    await q(
      `INSERT INTO suppressed_open_slots (company_id, date, shift_type_id, count, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, date, shiftTypeId, shortfall, createdBy]
    );
  }
  return {
    totalBefore, draftBefore: draft,
    extraDeleted, draftDeleted,
    // Only the suppressions that existed BEFORE this close: the
    // undo re-inserts exactly these. The loop's own suppressions
    // were transient (deleted by the normalization above) —
    // restoring them would leave the shortfall opens suppressed
    // after an undo, when they were visible before the close.
    suppressedDeleted: suppressed,
    suppressedCreated: shortfall,
  };
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
 * types are filtered out by default — their opens were never
 * draft and their closures are not this rule's business. The bulk
 * publish-open-slots function (Deepika, 2026-11-22) passes
 * includeLive: a live type's opens CAN be draft — a per-slot
 * unpublish writes the draft rows — and once draft they must be
 * republishable in bulk, or they strand (Nephrology, Nov 22).
 */
export async function publishOpenSlotsForPairs(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[],
  generatedTypeIds: Set<string>, includeLive = false
): Promise<void> {
  const list = dedupePairs(pairs).filter((p) => includeLive || generatedTypeIds.has(p.shiftTypeId));
  if (!list.length) return;
  await clearDraftOpenSlots(q, companyId, list);
  await clearOpenSlotClosures(q, companyId, list);
}

/**
 * Unpublishing the day unpublishes the opens with it (Deepika,
 * 2026-11-22 — "Unpublish could have moved the current open
 * slots"): for every GENERATED (date, type) pair the unpublish
 * touches, every currently-visible published open becomes a draft
 * open — the stored draft-open count is raised to the visible
 * total, so the opens render as draft and a later publish (which
 * clears the draft rows, above) brings them back as published.
 * Live types are filtered out by default — the same rule as the
 * publish mirror: their opens were never draft and their closures
 * are not this rule's business. The bulk move-open-slots-to-draft
 * function (Deepika, 2026-11-22) passes includeLive: move-to-draft
 * covers NO open slots at all today, rotation or not, and a live
 * type's opens must move with the rest — the publish mirror above
 * takes includeLive too, so a live type moved to draft can always
 * be published back (never stranded).
 *
 * A stored extra has no published flag of its own (extra_open_
 * slots is just a count), so a published extra IS an extra no
 * draft count covers yet; the computed shortfall moves with it,
 * because the grid shows one open count, not two. The pairs are
 * EVERY date in the unpublish range for the type — not only pairs
 * with shifts that flipped: the Dec 12–17 live case had no shifts
 * at all, only 3 stored published extras per date, and the old
 * flip-only read found nothing to move. The visible count is the
 * grid's own count (stored model, target 0 on undrafted generated
 * dates — getNotDraftedByType, the same map the grid reads, so a
 * rotation-less generated type is never "not drafted").
 *
 * Returns how many opens newly became draft, so the caller can
 * report the true moved count — and report a 0-move plainly
 * instead of "applied".
 */
export async function unpublishOpenSlotsForPairs(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[],
  generatedTypeIds: Set<string>, createdBy: string | null, includeLive = false
): Promise<{ opensMoved: number; pairsTouched: number }> {
  const list = dedupePairs(pairs).filter((p) => includeLive || generatedTypeIds.has(p.shiftTypeId));
  if (!list.length) return { opensMoved: 0, pairsTouched: 0 };
  // One batched read per table for the whole range, then the grid's
  // own per-pair math in memory.
  const dates = [...new Set(list.map((p) => p.date))].sort();
  const typeIds = [...new Set(list.map((p) => p.shiftTypeId))];
  const from = dates[0];
  const to = dates[dates.length - 1];
  const notDrafted = await getNotDraftedByType(q, companyId, generatedTypeIds, from, to);
  const { rows: trows } = await q(
    `SELECT shift_type_id AS "shiftTypeId", target_count, weekdays,
            start_date::text AS start_date, end_date::text AS end_date
     FROM staffing_targets WHERE company_id = $1 AND shift_type_id = ANY($2::uuid[])`,
    [companyId, typeIds]
  );
  const targets = new Map<string, any>();
  for (const r of trows) if (!targets.has(r.shiftTypeId)) targets.set(r.shiftTypeId, r);
  // draft_open_slots / suppressed_open_slots carry shift_type_id
  // as TEXT (migrations 111/119), extra_open_slots as UUID —
  // the ANY() cast must match the column, or Postgres refuses
  // with "operator does not exist: text = uuid".
  const sumBy = async (table: string, idCast: 'uuid' | 'text') => {
    const { rows } = await q(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COALESCE(SUM(count), 0)::int AS n
       FROM ${table} WHERE company_id = $1 AND date >= $2 AND date <= $3 AND shift_type_id = ANY($4::${idCast}[])
       GROUP BY date, shift_type_id`,
      [companyId, from, to, typeIds]
    );
    const m = new Map<string, number>();
    for (const r of rows) m.set(`${r.date}|${r.shiftTypeId}`, Number(r.n || 0));
    return m;
  };
  const extras = await sumBy('extra_open_slots', 'uuid');
  const suppressed = await sumBy('suppressed_open_slots', 'text');
  const drafts = await sumBy('draft_open_slots', 'text');
  // Filled is the GRID's filled count — stored shifts PLUS the
  // rotation occurrences the grid draws. The old read counted the
  // shifts table only, which is identical for generated types
  // (they never draw) but WRONG for live types: a drawn occurrence
  // fills the slot in the grid, so a live type with a rotation
  // holding the target shows 0 opens while the stored-only math
  // sees the whole target as open — and this helper would draft
  // that phantom open (Live Ward, Nov 22: 1 drawn filled, target
  // 1, no extras — stored math said 1 visible open, the grid said
  // 0). getShiftsForRange IS the grid's count (stored rows for
  // generated types, stored + drawn for live ones, a stored row
  // suppressing its own occurrence, so nobody is double-counted).
  const filled = new Map<string, number>();
  for (const s of await getShiftsForRange(q, companyId, from, to)) {
    if (!s.shiftTypeId) continue;
    const k = `${s.date}|${s.shiftTypeId}`;
    filled.set(k, (filled.get(k) || 0) + 1);
  }
  let opensMoved = 0;
  let pairsTouched = 0;
  for (const p of list) {
    const k = pairKey(p);
    const t = targets.get(p.shiftTypeId);
    let target = 0;
    if (t) {
      const dow = new Date(p.date + 'T12:00:00').getDay();
      const wdays: number[] = Array.isArray(t.weekdays) ? t.weekdays : [0, 1, 2, 3, 4, 5, 6];
      const sd: string | null = t.start_date || null;
      const ed: string | null = t.end_date || null;
      if (wdays.indexOf(dow) !== -1 && !(sd && p.date < sd) && !(ed && p.date > ed)) {
        target = Number(t.target_count) || 0;
      }
    }
    // Undrafted generated dates count the target as 0 — only stored
    // extras show there (the N2 rule, read from the grid's own map).
    const undrafted = (notDrafted[p.shiftTypeId] || []).includes(p.date);
    const effTarget = undrafted ? 0 : target;
    const f = filled.get(k) || 0;
    const visible = Math.max(0, Math.max(0, effTarget - f) + (extras.get(k) || 0) - (suppressed.get(k) || 0));
    const draftBefore = drafts.get(k) || 0;
    if (visible > draftBefore) {
      await setDraftOpenCount(q, companyId, p.date, p.shiftTypeId, visible, createdBy);
      opensMoved += visible - draftBefore;
      pairsTouched++;
    }
  }
  return { opensMoved, pairsTouched };
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

export interface StoredTotals {
  /** Visible opens. */
  opens: number;
  /** Stored shifts (draft + published) for the date+type. */
  filled: number;
  /** filled + opens — the number a top-up target compares against. */
  total: number;
  /** Stored extra_open_slots SUM. */
  extra: number;
  /** Stored suppressed_open_slots SUM. */
  suppressed: number;
  /** The staffing target that applied (0 when none / out of range). */
  target: number;
}

/**
 * The stored-model totals for one date+type (Deepika, 2026-11-20/21
 * — "the calculation should come from real schedule, not from
 * rotation" · "stored or real current active schedule" · "drafts +
 * published"). For a GENERATED type the opens are
 *   closed ? 0 : max(0, max(0, target - filled) + extra - suppressed)
 * The shortfall is clamped at 0 BEFORE the stored extras are added,
 * so over-target filled never eats stored extras — the failure the
 * top-up fix corrects (12 filled against target 11 + 2 extras must
 * read 2 opens, not 1). It equals the computed formula
 * max(0, target + extra - filled - suppressed) whenever filled <=
 * target, so nothing changes for at/under-target dates. The target
 * is resolved exactly like shortfallFor (first staffing_targets row,
 * gated by weekday + start/end dates). The draft_open_slots count
 * is deliberately NOT added: publish deletes those rows, and the
 * computed shortfall persists as visible opens with a draft count
 * of 0 (Dec 4 production: 11 filled published, 8 opens, 0 draft —
 * 3 shortfall + 5 extras). Live-mode types must NOT use this
 * helper — they keep the computed formula.
 */
export async function storedTotals(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string
): Promise<StoredTotals> {
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
  const { rows: erows } = await q(
    'SELECT COALESCE(SUM(count), 0)::int AS n FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const extra = Number(erows[0]?.n || 0);
  const suppressed = await suppressedTotal(q, companyId, date, shiftTypeId);
  const opens = Math.max(0, Math.max(0, target - filled) + extra - suppressed);
  return { opens, filled, total: filled + opens, extra, suppressed, target };
}
