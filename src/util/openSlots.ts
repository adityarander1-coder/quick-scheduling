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
 *     back); 0 when the day is closed for the type.
 * The staffing target matters only when a draft stores its shortfall
 * and when an explicit request (AI top-up / add) is computed — the
 * display never consults it. Computed-model types — live-mode
 * (direct-pull) types and rotation-less generated types (e.g. Day NP,
 * whose target always counts per the Nov 15 rule) — keep the legacy
 * formula (target + extra − suppressed − filled) in the display +
 * gate + executor, exactly as before.
 *
 * This module imports nothing from the routes, the planner, or the
 * engine — every helper takes the caller's query fn (inside the
 * caller's transaction where one exists), so there are no cycles.
 * The one import is scheduleMode, which itself imports nothing.
 */

import { getStoredModelTypeIds } from './scheduleMode.js';

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
  const { rows: crows } = await q(
    'SELECT 1 FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const closed = crows.length > 0;
  const { rows: erows } = await q(
    'SELECT COALESCE(SUM(count), 0)::int AS n FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const extra = Number(erows[0]?.n || 0);
  const draft = await draftOpenTotal(q, companyId, date, shiftTypeId);
  const suppressed = await suppressedTotal(q, companyId, date, shiftTypeId);
  const total = closed ? 0 : Math.max(0, extra + draft - suppressed);
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
 * staying put. A published assign takes a published extra; a draft
 * assign takes a draft open first (same state), falling back to a
 * published extra. When neither pool has one, the assign just adds
 * headcount — a manager may always staff above the stored opens.
 * Returns true when a slot was consumed.
 */
export async function consumeOpenSlotForAssign(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  published: boolean, createdBy: string | null
): Promise<boolean> {
  if (!published) {
    const draft = await draftOpenTotal(q, companyId, date, shiftTypeId);
    if (draft > 0) {
      await setDraftOpenCount(q, companyId, date, shiftTypeId, draft - 1, createdBy);
      return true;
    }
  }
  return consumeExtraOpenSlot(q, companyId, date, shiftTypeId);
}

/**
 * Close `count` visible opens for one date+type — the close itself
 * (Deepika, 2026-11-20: "when it says close slot it goes away
 * permanently"). Extra slots go first: a stored positive row is
 * really deleted (delete at 0, never a negative row). Whatever is
 * left over is a stored shortfall open — the draft's own opens in
 * draft_open_slots — so it is recorded in suppressed_open_slots
 * until the next draft/publish of that date+type pulls it back. The
 * draft count itself is never touched by a close, so the remaining
 * positions keep their draft/published split (the UI renders
 * min(draft, total) positions as draft). Returns the split, so the
 * undo payload can reverse each part exactly. Callers must only
 * close opens that are actually visible (they already guard on the
 * total).
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
 * available"): for every STORED-MODEL (date, type) pair the publish
 * touched, the draft's stored shortfall MOVES into extra_open_slots
 * — the published store — so the opens stay visible after the draft
 * row goes, with no live link back to the target. The move is the
 * draft's count minus what this publish itself stamped into filled
 * positions (opts.stampedByPair, per "date|type"): a publish that
 * stamps people into the open positions fills them, so they stop
 * being opens. A target change after the draft does NOT shrink the
 * move — the draft is detached from the target. The move is never
 * more than the draft stored: a publish that removes people does
 * not invent opens here. The closures go too (a suppressed or
 * closed day is pulled back). Rotation-less generated pairs keep the
 * base behavior — clear the draft rows and the closures, no move, no
 * ledger (their opens are computed from the target, so there is
 * nothing stored to move). Live types are filtered out by the
 * caller — their opens were never draft and their closures are not
 * this rule's business. When opts.batchId is given (the bulk
 * publish), each move is ledgered in publish_batch_draft_moves so
 * undoing the batch can put the opens back to draft exactly; the
 * flip path and AI publish pass no batch and record nothing.
 */
export async function publishOpenSlotsForPairs(
  q: OpenSlotQuery, companyId: string, pairs: OpenSlotPair[],
  generatedTypeIds: Set<string>,
  opts?: { batchId?: string | null; stampedByPair?: Map<string, number> }
): Promise<void> {
  const list = dedupePairs(pairs).filter((p) => generatedTypeIds.has(p.shiftTypeId));
  if (!list.length) return;
  const storedModel = await getStoredModelTypeIds(q, companyId);
  const storedList = list.filter((p) => storedModel.has(p.shiftTypeId));
  for (const p of storedList) {
    const draft = await draftOpenTotal(q, companyId, p.date, p.shiftTypeId);
    if (draft > 0) {
      const stamped = opts?.stampedByPair?.get(pairKey(p)) || 0;
      const move = Math.max(0, draft - stamped);
      if (move > 0) {
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
