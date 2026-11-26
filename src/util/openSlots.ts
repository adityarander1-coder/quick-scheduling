/**
 * openSlots.ts — the shared open-slot writes (Deepika, 2026-11-20 —
 * fix list: "Close this slot" must REALLY delete the slot, and draft
 * opens must be born DRAFT; detached open slots: once drafted,
 * detached — no mark, no live link to the rotation or the target).
 *
 * Open slots are STORED, not computed — for stored-model types
 * (generated AND produced by an active rotation). For one date+type
 * the stored opens are:
 *   extra_open_slots (published opens, including a draft shortfall a
 *     publish moved here) + draft_open_slots (the draft's own opens,
 *     unclaimable until published) − suppressed_open_slots (opens a
 *     manager closed, hidden until the next draft/publish pulls them
 *     back). The staffing target matters only when a draft stores
 *     its shortfall and when an explicit request (AI top-up / add)
 *     is computed — the display never consults it.
 * Computed-model types — live-mode (direct-pull) types and
 * rotation-less generated types (e.g. Day NP, whose target always
 * counts per the Nov 15 rule) — keep the computed formula:
 *   max(0, target + extra - filled - suppressed)
 * where `extra` is extra_open_slots (never negative from a close
 * anymore), `filled` is the GRID's filled count — stored shifts
 * plus the rotation occurrences the grid draws for live types
 * (a generated type never draws, so its filled is stored-only).
 * There is NO closed flag any more (Deepika, 2026-11-21 — "why is
 * it hanging on to not letting us add"): a whole-type close
 * deletes the slots and suppresses exactly the visible shortfall
 * with stored rows, so a later add lands on the date and shows.
 * Live-mode types never go through the draft/publish clearing
 * here: the draft panel refuses live rotations, and the publish
 * paths filter to generated types before calling
 * publishOpenSlotsForPairs (the bulk open-slot publish passes
 * includeLive so a live type's draft opens can be republished).
 *
 * This module imports nothing from the routes, the planner, or the
 * engine — every helper takes the caller's query fn (inside the
 * caller's transaction where one exists), so there are no cycles.
 * The one exception is scheduleMode, a sibling util: closeTypeForDate
 * needs the undrafted check (on an undrafted generated date the
 * target contributes 0 to the grid, so nothing is suppressed there),
 * and the stored-model checks need getStoredModelTypeIds (which
 * itself imports nothing from the routes). The History snapshot
 * stays the caller's job for the same reason.
 * Whole-type closes (bulk, day dialog, AI closeAll) all go through
 * closeTypeForDate: it applies the SAME single-slot delete
 * (deleteOneOpenSlot) to every visible open for the date+type,
 * sweeps any stored row the loop cannot reach, and suppresses
 * exactly the visible shortfall — "when i say close any where it
 * should be gone" (Deepika, 2026-11-20) and "use the SAME function
 * for both the per-slot X and the type-close" (Deepika, 2026-11-21).
 */

import { getGeneratedTypeIds, getNotDraftedByType, getStoredModelDates, getUndraftedDatesForType } from './scheduleMode.js';
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

/** Draft opens for one date+type (0 when none). */
export async function draftOpenTotal(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string
): Promise<number> {
  const { rows } = await q(
    'SELECT count FROM draft_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  return rows.length ? Number(rows[0].count) || 0 : 0;
}

/**
 * The stored opens for one date+type (Deepika, 2026-11-20 —
 * detached open slots): extra + draft − suppressed, 0 when the day
 * is closed for the type. No target, no filled count — the opens
 * are rows, not a computation. `published` is the claimable part
 * (total minus the draft positions, which render first).
 */
export async function storedOpenSlots(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string
): Promise<{ extra: number; draft: number; suppressed: number; closed: boolean; total: number; published: number }> {
  // No closed flag any more (migration 121, Deepika, 2026-11-21):
  // the closed_shifts table is always empty, so a date is never
  // closed by a flag — a close suppresses the shortfall instead.
  // `closed` stays in the return shape for the claim endpoint's
  // callers and is always false.
  const closed = false;
  const { rows: erows } = await q(
    'SELECT COALESCE(SUM(count), 0)::int AS n FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const extra = Number(erows[0]?.n || 0);
  const draft = await draftOpenTotal(q, companyId, date, shiftTypeId);
  const suppressed = await suppressedTotal(q, companyId, date, shiftTypeId);
  const total = Math.max(0, extra + draft - suppressed);
  return { extra, draft, suppressed, closed, total, published: Math.max(0, total - draft) };
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

// Consume one manually-added extra open slot without ever writing count = 0:
// migration 020's CHECK (count <> 0) kills a plain decrement 1 → 0 before any
// delete-at-zero cleanup can run (found 2026-11-06 — last-slot claims 500'd on
// every claim path). One atomic statement instead: decrement when count > 1,
// delete the row when count = 1. Returns true when a slot was consumed.
export async function consumeExtraOpenSlot(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string
): Promise<boolean> {
  const { rows } = await q(
    `WITH dec AS (
       UPDATE extra_open_slots SET count = count - 1
        WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count > 1
        RETURNING 1 AS taken
     ), del AS (
       DELETE FROM extra_open_slots
        WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count = 1
          AND NOT EXISTS (SELECT 1 FROM dec)
        RETURNING 1 AS taken
     )
     SELECT taken FROM dec UNION ALL SELECT taken FROM del`,
    [companyId, date, shiftTypeId]
  );
  return rows.length > 0;
}

/**
 * Filling a stored open slot (Deepika, 2026-11-20 — detached open
 * slots): when a person is ASSIGNED onto a date+type, they take one
 * stored open if one exists. The claim endpoint, the gap-offer
 * claim and the pickup link already consumed on taking a slot; the
 * assign doors did not, so an assigned person left the open
 * standing beside them — the day showed the person working AND the
 * open still there to be claimed again (double-fill), and the
 * top-up total (filled + open) grew with every assign instead of
 * staying put. A published assign takes a published extra, falling
 * back to a draft open when there is no published extra (the date's
 * opens are draft — drafted, not yet published — so the assign fills
 * one of them); a draft assign takes a draft open first (same state),
 * falling back to a published extra. When neither pool has one, the
 * assign just adds headcount — a manager may always staff above the
 * stored opens.
 *
 * Which pool the slot came from, for callers that must give it back
 * (the import-undo returns the open to the pool the import took it
 * from, or the draft/published split comes back wrong).
 */
export type ConsumedOpenPool = 'extra' | 'draft';
export async function consumeOpenSlotForAssignDetailed(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  published: boolean, createdBy: string | null
): Promise<ConsumedOpenPool | null> {
  if (!published) {
    const draft = await draftOpenTotal(q, companyId, date, shiftTypeId);
    if (draft > 0) {
      await setDraftOpenCount(q, companyId, date, shiftTypeId, draft - 1, createdBy);
      return 'draft';
    }
    return (await consumeExtraOpenSlot(q, companyId, date, shiftTypeId)) ? 'extra' : null;
  }
  // A published assign takes a published extra first. When there is
  // no published extra, it takes a draft open if one stands there:
  // the date's opens are draft (drafted, not yet published), so the
  // assign fills one of them — leaving the draft count untouched
  // would strand it beside the filled shift, the stored total would
  // over-count, and the same open could be claimed again.
  if (await consumeExtraOpenSlot(q, companyId, date, shiftTypeId)) return 'extra';
  const draft = await draftOpenTotal(q, companyId, date, shiftTypeId);
  if (draft > 0) {
    await setDraftOpenCount(q, companyId, date, shiftTypeId, draft - 1, createdBy);
    return 'draft';
  }
  return null;
}
export async function consumeOpenSlotForAssign(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  published: boolean, createdBy: string | null
): Promise<boolean> {
  return (await consumeOpenSlotForAssignDetailed(q, companyId, date, shiftTypeId, published, createdBy)) !== null;
}

/**
 * Mirror of the consume above (Deepika, 2026-11-25 — upload
 * consumes opens): return one stored open to the pool it was taken
 * from. Used by the import-undo — undoing an import must give back
 * exactly the opens the import consumed, to the same pool, or the
 * draft/published split comes back wrong and the total drifts. The
 * caller only calls this for rows whose import recorded a pool; a
 * row whose import consumed nothing returns nothing here.
 */
export async function returnConsumedOpenSlot(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  from: ConsumedOpenPool, createdBy: string | null
): Promise<void> {
  if (from === 'draft') {
    const draft = await draftOpenTotal(q, companyId, date, shiftTypeId);
    await setDraftOpenCount(q, companyId, date, shiftTypeId, draft + 1, createdBy);
    return;
  }
  await q(
    `INSERT INTO extra_open_slots (company_id, date, shift_type_id, count, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (company_id, date, shift_type_id)
     DO UPDATE SET count = extra_open_slots.count + 1`,
    [companyId, date, shiftTypeId, createdBy]
  );
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
 * date+type pulls it back. The draft count itself is never touched
 * by a close (Deepika, 2026-11-20 — detached open slots): the
 * suppression alone removes the position, and the remaining
 * positions keep their draft/published split (the UI renders
 * min(draft, total) positions as draft). Decrementing the draft
 * AND suppressing would double-count against the stored total
 * (extra + draft − suppressed) — one closed slot would drop it by
 * two, and the next close would find nothing left to close.
 * Returns the split, so callers can reverse each part exactly.
 * Safety (Deepika, 2026-11-21): when no visible open is left the
 * primitive refuses (no-op, no suppression row) — a raw count past
 * the visible total can never store a phantom suppression. */
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
  // The draft count is never touched by a close (see the header):
  // the suppression below removes the position, and the draft count
  // keeps counting the positions the draft created, so the stored
  // total (extra + draft − suppressed) drops by exactly one.
  await q(
    `INSERT INTO suppressed_open_slots (company_id, date, shift_type_id, count, created_by)
     VALUES ($1, $2, $3, 1, $4)
     ON CONFLICT (company_id, date, shift_type_id)
     DO UPDATE SET count = suppressed_open_slots.count + 1`,
    [companyId, date, shiftTypeId, createdBy]
  );
  return { fromExtra: false, fromDraft: false, suppressed: true };
}

/**
 * Close `count` visible opens for one date+type — the close itself
 * (Deepika, 2026-11-20: "when it says close slot it goes away
 * permanently"). It is the shared single-slot delete above, applied
 * `count` times: stored extras go first (really deleted, never a
 * negative row), then computed shortfall opens are suppressed until
 * the next draft/publish pulls them back. The draft count is never
 * touched by a close (the single-slot delete's rule) — draftDeleted
 * is always 0 here, kept in the split so the undo payload shape is
 * unchanged; the whole-type close below is the one that sweeps draft
 * rows. Returns the split, so the undo payload can reverse each
 * part exactly. A count past the visible total stops at the last
 * visible open: the primitive refuses the extra turns, so nothing
 * phantom is stored.
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
 *      shortfall opens suppressed; the draft count is never touched
 *      by the loop — the sweep below is what clears draft rows).
 *      The visible count is the clamped stored-model count
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
 * Publishing the day publishes the opens with it (Deepika,
 * 2026-11-20 — "when i publish them then they should go to be
 * available"): for every GENERATED (date, type) pair the publish
 * touched, the draft-open rows go (the opens become published) and
 * the closures go (a suppressed or closed day is pulled back).
 * For GENERATED pairs (rotation-backed AND rotation-less) the
 * draft's stored shortfall MOVES into extra_open_slots — the
 * published store — so the opens stay visible after the draft row
 * goes, with no live link back to the target. Since the redesign
 * (Deepika, 2026-11-23) step 1 stores EVERY generated type's
 * target as draft opens — Day NP included — the move covers every
 * generated pair, not only rotation-backed ones. The move is the
 * draft's count minus what this publish itself stamped into filled
 * positions (opts.stampedByPair, per "date|type"): a publish that
 * stamps people into the open positions fills them, so they stop
 * being opens. A target change after the draft does NOT shrink the
 * move — the draft is detached from the target. The move is never
 * more than the draft stored: a publish that removes people does
 * not invent opens here. When opts.batchId is given (the bulk
 * publish), each move is ledgered in publish_batch_draft_moves so
 * undoing the batch can put the opens back to draft exactly; the
 * flip path and AI publish pass no batch and record nothing.
 * Live types never move: their opens are computed from the target,
 * so there is nothing stored to move (they keep the base behavior
 * — clear the draft rows and the closures, no move, no ledger).
 * Live types are filtered out by default — their opens were never
 * draft and their closures are not this rule's business. The bulk
 * publish-open-slots function (Deepika, 2026-11-22) passes
 * includeLive: a live type's opens CAN be draft — a per-slot
 * unpublish writes the draft rows — and once draft they must be
 * republishable in bulk, or they strand (Nephrology, Nov 22).
 */
export async function publishOpenSlotsForPairs(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[],
  generatedTypeIds: Set<string>, includeLive = false,
  opts?: { batchId?: string | null; stampedByPair?: Map<string, number> }): Promise<{ moved: number }> {
  const list = dedupePairs(pairs).filter((p) => includeLive || generatedTypeIds.has(p.shiftTypeId));
  if (!list.length) return { moved: 0 };
  // Stored vs computed dates (Nov 23): the move must only ADD
  // draft opens to the published count where the date reads STORED
  // (extra + draft − suppressed). On a COMPUTED date the grid
  // already counts shortfall + extra − suppressed, so the draft
  // opens sit inside that count already — moving them would
  // double-count the same positions (publish-picker: rotation-free
  // Picker Ward stood extra 2 + draft 2 for the same 2 positions,
  // and the move made extra 4). On a computed date only the draft
  // opens BEYOND the already-published count move, so hand-added
  // opens on an undrafted date still publish instead of stranding.
  const storedKeys = new Set<string>();
  {
    const dates = list.map((p) => p.date).sort();
    const storedByType = await getStoredModelDates(q, companyId, generatedTypeIds, dates[0], dates[dates.length - 1]);
    for (const [typeId, ds] of Object.entries(storedByType)) {
      for (const d of ds) storedKeys.add(`${d}|${typeId}`);
    }
  }
  // The move covers every GENERATED pair in the list (rotation-backed
  // and rotation-less alike — step 1 stores both); live pairs (only
  // present when includeLive) never move.
  const storedList = list.filter((p) => generatedTypeIds.has(p.shiftTypeId));
  let moved = 0;
  for (const p of storedList) {
    const draft = await draftOpenTotal(q, companyId, p.date, p.shiftTypeId);
    if (draft > 0) {
      const stamped = opts?.stampedByPair?.get(pairKey(p)) || 0;
      // Only the VISIBLE draft opens move to published extras: a
      // draft open a close suppressed is gone for good (Deepika,
      // 2026-11-20 — "when it says close slot it goes away
      // permanently") — moving the raw draft count would resurrect
      // it as a published extra. The suppression is cleared below,
      // so the closed position never comes back. (A close never
      // touches the draft count — deleteOneOpenSlot's rule — so the
      // suppressed opens are still sitting in `draft` here.)
      const suppressed = await suppressedTotal(q, companyId, p.date, p.shiftTypeId);
      let move: number;
      if (storedKeys.has(pairKey(p))) {
        move = Math.max(0, draft - suppressed - stamped);
      } else {
        // Computed date: the published count already includes
        // shortfall + extra − suppressed — read after this
        // publish's adds, so the shortfall is post-add and the
        // stamped subtraction must NOT be repeated inside it.
        const shortfall = await shortfallFor(q, companyId, p.date, p.shiftTypeId);
        const extra = (await storedOpenSlots(q, companyId, p.date, p.shiftTypeId)).extra;
        const alreadyPublished = Math.max(0, shortfall + extra - suppressed);
        move = Math.max(0, draft - suppressed - stamped - alreadyPublished);
      }
      if (move > 0) {
        moved += move;
        await q(
          `INSERT INTO extra_open_slots (company_id, date, shift_type_id, count, created_by)
           VALUES ($1, $2, $3, $4, NULL)
           ON CONFLICT (company_id, date, shift_type_id)
           DO UPDATE SET count = extra_open_slots.count + EXCLUDED.count`,
          [companyId, p.date, p.shiftTypeId, move]
        );
        if (opts?.batchId) {
          await q(
            `INSERT INTO publish_batch_draft_moves (batch_id, company_id, date, shift_type_id, count)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (batch_id, date, shift_type_id)
             DO UPDATE SET count = publish_batch_draft_moves.count + EXCLUDED.count`,
            [opts.batchId, companyId, p.date, p.shiftTypeId, move]
          );
        }
      }
    }
  }
  await clearDraftOpenSlots(q, companyId, list);
  await clearOpenSlotClosures(q, companyId, list);
  return { moved };
}

/**
 * Unpublishing the day unpublishes the opens with it (Deepika,
 * 2026-11-22 — "Unpublish could have moved the current open
 * slots"): for every GENERATED (date, type) pair the unpublish
 * touches, every currently-visible published open becomes a draft
 * open — the published extras MOVE into the draft count and the
 * extra rows are deleted, so the visible total is UNCHANGED by the
 * move (Deepika, 2026-11-23 — move fix: draft_new = draft_old +
 * extra, extra_new = 0). The old code SET the draft count to the
 * visible total and never deleted the extras, so publish → move
 * compounded (extra 2 → draft 4 → extra 6 → draft 8) and the move
 * no-op'd whenever drafts already stood there ("Nothing moved"
 * with published extras standing — the masking bug). The move acts
 * whenever extra > 0, regardless of existing draft opens.
 * Live types are filtered out by default — the same rule as the
 * publish mirror: their opens were never draft and their closures
 * are not this rule's business. The bulk move-open-slots-to-draft
 * function (Deepika, 2026-11-22) passes includeLive: move-to-draft
 * covers NO open slots at all today, rotation or not, and a live
 * type's opens must move with the rest — the publish mirror above
 * takes includeLive too, so a live type moved to draft can always
 * be published back (never stranded).
 *
 * Stored vs computed dates — the same map the grid reads
 * (getStoredModelDates, plus the client's draft > 0 rule): on a
 * STORED date the shortfall is already inside the draft count, so
 * the move only carries the published extras across (draft_new =
 * draft_old + extra). On a COMPUTED date the draft count is empty
 * and the grid counts shortfall + extra − suppressed, so the move
 * materialises the whole visible count as draft opens (visible +
 * suppressed cover) — the shortfall positions become stored draft
 * opens instead of vanishing when the extras go. A close stays
 * closed either way: suppressions are never cleared here, and the
 * visible count after the move equals the visible count before it,
 * so a suppressed date still shows 0. Pairs are EVERY date in the
 * unpublish range for the type — not only pairs with shifts that
 * flipped: the Dec 12–17 live case had no shifts at all, only 3
 * stored published extras per date, and the old flip-only read
 * found nothing to move. The visible count is the grid's own count
 * (stored model, target 0 on undrafted generated dates —
 * getNotDraftedByType, the same map the grid reads, so a
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
  // The grid's per-date stored determination (getStoredModelDates):
  // a drafted date reads stored opens for ALL generated types, and
  // the client ALSO flips to stored when draft opens stand for the
  // pair — the move must use the same test, or it would SET a
  // stored date's draft count from the computed formula (the old
  // bug) or strand a computed date's extras in draft rows the grid
  // never counts.
  const storedKeys = new Set<string>();
  {
    const storedByType = await getStoredModelDates(q, companyId, generatedTypeIds, from, to);
    for (const [typeId, ds] of Object.entries(storedByType)) {
      for (const d of ds) storedKeys.add(`${d}|${typeId}`);
    }
  }
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
    const extra = Math.max(0, extras.get(k) || 0);
    const draftBefore = drafts.get(k) || 0;
    const supp = suppressed.get(k) || 0;
    // MOVE, not SET (Deepika, 2026-11-23): the published extras
    // cross into the draft count and the extra rows are deleted, so
    // the visible total does not change. On a STORED date the
    // shortfall already sits inside the draft count, so the move
    // only adds the extras (draft_new = draft_old + extra). On a
    // COMPUTED date the draft count is empty and the grid counts
    // shortfall + extra − suppressed, so the move materialises the
    // whole visible count as draft opens (visible + suppressed
    // cover) — the shortfall positions become stored draft opens
    // instead of vanishing when the extras go. Suppressions are
    // never cleared: a suppressed date still shows 0 after the
    // move, and a pair with nothing visible and no extras to move
    // is left alone (no draft rows written onto a closed date).
    const stored = storedKeys.has(k) || draftBefore > 0;
    let draftNew: number;
    let visible: number;
    let moved: number;
    if (stored) {
      visible = Math.max(0, extra + draftBefore - supp);
      draftNew = draftBefore + extra;
      moved = extra;
    } else {
      const shortfall = Math.max(0, effTarget - f);
      visible = Math.max(0, shortfall + extra - supp);
      draftNew = visible + supp;
      moved = visible;
    }
    if (extra > 0 || (visible > 0 && draftNew > draftBefore)) {
      if (extra > 0) {
        // Delete the extra row entirely — never update count to 0
        // (migration 020 CHECK count <> 0).
        await q(
          'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
          [companyId, p.date, p.shiftTypeId]
        );
      }
      await setDraftOpenCount(q, companyId, p.date, p.shiftTypeId, draftNew, createdBy);
      opensMoved += moved;
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
