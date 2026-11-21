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
 * The History snapshot stays the caller's job for the same reason.
 * Whole-type closes (bulk, day dialog, AI closeAll) all go through
 * closeTypeForDate: it applies the SAME single-slot delete
 * (deleteOneOpenSlot) to every visible open for the date+type,
 * sweeps any stored row the loop cannot reach, and sets the closed
 * flag — "when i say close any where it should be gone" (Deepika,
 * 2026-11-20) and "use the SAME function for both the per-slot X
 * and the type-close" (Deepika, 2026-11-21).
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
 * callers can reverse each part exactly. Callers must only delete
 * opens that are actually visible.
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
 * the undo payload can reverse each part exactly. Callers must only
 * close opens that are actually visible (they already guard on the
 * total).
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
  /** Visible opens before the close (0 when already closed). */
  totalBefore: number;
  /** Stored draft-open count before the close. */
  draftBefore: number;
  /** Stored extras really deleted (never negative). */
  extraDeleted: number;
  /** Stored draft opens really deleted. */
  draftDeleted: number;
  /** Suppressed rows really deleted. */
  suppressedDeleted: number;
  /** True when this call newly set the closed flag. */
  flagSet: boolean;
}

/**
 * Close a whole shift type for one date — the shared whole-type
 * close (Deepika, 2026-11-20 — "when i say close any where it
 * should be gone" · "it cannot store from any where"; 2026-11-21 —
 * "use the SAME function for both the per-slot X and the type-close":
 * the type-close is just that same delete applied to all open slots
 * of the type for the date). In one transaction, for that (company,
 * date, type):
 *   1. Applies deleteOneOpenSlot once per visible open — the SAME
 *      delete the per-slot X uses (stored extras really deleted,
 *      shortfall opens suppressed, draft counts decremented).
 *   2. Sweeps any stored row the loop cannot reach: extras hidden
 *      by an over-suppression, draft rows taller than the visible
 *      shortfall, and every suppressed row (pre-existing and the
 *      loop's own, which never persist past this transaction).
 *   3. INSERTs the closed_shifts row (ON CONFLICT DO NOTHING —
 *      the flag is what keeps the type shut and blocks new adds).
 * Nothing stored survives: a later re-draft creates only the fresh
 * shortfall. The History snapshot is the caller's job (it uses the
 * pool, not the caller's query fn). Returns the breakdown, so the
 * undo payload can reverse each part exactly — suppressedDeleted
 * counts only the suppressions that existed BEFORE this close, so
 * an undo restores the day exactly as it was. Runs even on an
 * already-closed date — stored rows added while closed are deleted
 * too.
 */
export async function closeTypeForDate(
  q: OpenSlotQuery, companyId: string, date: string, shiftTypeId: string,
  createdBy: string | null
): Promise<CloseTypeResult> {
  const { rows: crows } = await q(
    'SELECT 1 FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const alreadyClosed = crows.length > 0;
  let target = 0;
  if (!alreadyClosed) {
    const { rows: trows } = await q(
      `SELECT target_count, weekdays, start_date::text AS start_date, end_date::text AS end_date
       FROM staffing_targets WHERE company_id = $1 AND shift_type_id = $2`,
      [companyId, shiftTypeId]
    );
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
  const totalBefore = alreadyClosed ? 0 : Math.max(0, target + extra - filled - suppressed);
  // The SAME delete every close path uses (Deepika, 2026-11-21):
  // the shared single-slot delete, applied once per visible open
  // for the date+type. A whole-type close is just that delete, once
  // per open slot — plus the closed flag below.
  let extraDeleted = 0;
  let draftDeleted = 0;
  for (let i = 0; i < totalBefore; i++) {
    const r = await deleteOneOpenSlot(q, companyId, date, shiftTypeId, createdBy);
    if (r.fromExtra) extraDeleted++;
    if (r.fromDraft) draftDeleted++;
  }
  // Sweep what the loop cannot reach, so the close still deletes
  // EVERY stored row for the date+type (never weakened): extras
  // hidden by an over-suppression (visible opens fewer than stored
  // extras), draft rows taller than the visible shortfall, and every
  // suppressed row — the pre-existing ones and the loop's own, which
  // never persist past this transaction.
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
  await q(
    'DELETE FROM suppressed_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const ins = await q(
    `INSERT INTO closed_shifts (company_id, date, shift_type_id, created_by)
     VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, date, shift_type_id) DO NOTHING`,
    [companyId, date, shiftTypeId, createdBy]
  );
  return {
    totalBefore, draftBefore: draft,
    extraDeleted, draftDeleted,
    // Only the suppressions that existed BEFORE this close: the
    // undo re-inserts exactly these. The loop's own suppressions
    // were transient (deleted by the sweep above) — restoring them
    // would leave the shortfall opens suppressed after an undo,
    // when they were visible before the close.
    suppressedDeleted: suppressed,
    flagSet: (ins.rowCount || 0) > 0,
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
