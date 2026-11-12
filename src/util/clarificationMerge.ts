// util/clarificationMerge.ts — the ONE clarification merge
// (Deepika, 2026-11-11 — "the brain should be the same"): every
// question source merges into a single detail + a single items
// list before the one clarification is built — the gate's items,
// the planner question's quoted fragments, the planner's
// change-field values, and the requester's own words (the planner
// canonicalizes names before the gate sees them, so 'muh' can only
// be recovered from the original request). BOTH doors call this —
// email processScheduleEmail and in-app Task finalizeTaskPlan —
// and neither keeps its own copy, so a fix or a question lands in
// both at once. The merge must be COMPLETE — every undecidable
// element gets a row — or the question stays prose-only: a
// confident-looking button set that cannot resolve the request is
// worse than no buttons. Incomplete fields and conflict blocks
// have no button kind, so they stay prose.

import type { ClarificationItem } from './planGate.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface MergeClarificationInputs {
  /** The question text as it stands (gate question / incomplete
   * summary / the planner's own question / the generic line). */
  detail: string;
  plan: any;
  /** The requester's own words (email body or Task text). */
  requestText: string;
  /** The gate's structured items, if the gate ran and blocked. */
  gateItems?: any[] | null;
  /** The gate's question text, when the gate blocked. */
  gateQuestion?: string | null;
  /** True when the gate's question is a holder mismatch (its first
   * sentence is kept as context above the rows). */
  gateHolderMismatch?: boolean;
  /** True when the gate blocked on a schedule conflict (prose-only). */
  gateBlockedByConflict?: boolean;
  /** Incomplete change fields (changeProblems count) — any > 0
   * stays prose. */
  incompleteCount?: number;
  today: string;
}

/**
 * Merge every question source into one detail + one items list.
 * On any failure returns the seed detail with no items (the caller
 * keeps its prose behavior) — a failed merge must never lose the
 * question itself.
 */
export async function mergeClarificationItems(
  query: QueryFn,
  companyId: string,
  opts: MergeClarificationInputs
): Promise<{ detail: string; items: ClarificationItem[] | null }> {
  const originalDetail = opts.detail;
  let detail = opts.detail;
  let gateQuestion = opts.gateQuestion ?? null;
  let gateHolderMismatch = !!opts.gateHolderMismatch;
  try {
    const { deriveNameAmbiguityItems, deriveShiftChoiceItems, deriveHolderMismatch, resolveNameValues, deriveNameItemsFromRequest } = await import('./planGate.js');
    const { buildDetailFromItems } = await import('./clarifyOptions.js');
    const { extractRequestDates } = await import('./emailPoller.js');
    const plan = opts.plan;
    const requestText = opts.requestText;
    const gateShiftItems: any[] = ((opts.gateItems || []).filter((it: any) => it.kind === 'shift'));
    const gateNameItems: any[] = ((opts.gateItems || []).filter((it: any) => it.kind !== 'shift'));
    const seenFrag = new Set<string>();
    const nameItems: any[] = [];
    const pushName = (it: any) => {
      const k = String(it.fragment || '').toLowerCase();
      if (!k || seenFrag.has(k)) return;
      seenFrag.add(k);
      nameItems.push(it);
    };
    for (const it of gateNameItems) pushName(it);
    const derived = await deriveNameAmbiguityItems(query, companyId, detail);
    for (const it of derived.items) pushName(it);
    const changeValues: string[] = [];
    for (const ch of (plan.changes || [])) {
      for (const f of ['person', 'fromPerson', 'toPerson']) if ((ch as any)[f]) changeValues.push(String((ch as any)[f]));
    }
    if (changeValues.length) {
      const fromChanges = await resolveNameValues(query, companyId, changeValues);
      for (const it of fromChanges.items) pushName(it);
    }
    for (const it of await deriveNameItemsFromRequest(query, companyId, requestText)) pushName(it);
    // Name rows read in the requester's own word order.
    const lowerReq = requestText.toLowerCase();
    nameItems.sort((a, b) => {
      const ia = lowerReq.indexOf(String(a.fragment || '').toLowerCase());
      const ib = lowerReq.indexOf(String(b.fragment || '').toLowerCase());
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    // Shift choice for a planner-composed holder question:
    // recomputed deterministically from the schedule, never
    // parsed from the prose. The gate's own shift item already
    // covers the gate-driven case.
    let shiftItems = gateShiftItems;
    if (!shiftItems.length && nameItems.length) {
      const dates = extractRequestDates(requestText, opts.today);
      const typeNames: string[] = [...new Set<string>((plan.changes || []).map((c: any): string => c.shiftType).filter(Boolean))];
      // Dates-are-the-problem (Deepika, 2026-11-11): the planner
      // declined to emit a change, but the request names specific
      // people — if one of them holds nothing of the requested
      // type on a requested date, say so in the gate's own words
      // instead of asking which shift is being given up from a
      // list that excludes them. Only single-candidate name rows
      // are checkable; anything else keeps the current behavior.
      const mismatch = await deriveHolderMismatch(query, companyId, {
        dates,
        shiftTypeNames: typeNames,
        people: nameItems.filter((it: any) => (it.candidates || []).length === 1).map((it: any) => it.candidates[0]),
        text: requestText,
      });
      if (mismatch) {
        gateQuestion = mismatch.question;
        gateHolderMismatch = true;
        shiftItems = mismatch.items;
      }
      // A mismatch with no shift options of its own (one holder
      // that day) must not eat the shift row: the fallback below
      // can still offer a real choice from the named people's
      // own shifts that day. Only a mismatch WITH options
      // replaces the all-holders list.
      if (!shiftItems.length) {
        shiftItems = await deriveShiftChoiceItems(query, companyId, {
          dates, shiftTypeNames: typeNames,
          fragments: nameItems.map((it) => it.fragment), text: requestText,
        });
      }
    }
    // Order (Deepika's confirmed order for the live case):
    // taker, shift, giver — the shift row sits after the first
    // name row.
    const merged: any[] = [...nameItems];
    for (const s of shiftItems) merged.splice(merged.length ? 1 : 0, 0, s);
    const complete = merged.length > 0
      && !derived.unresolved.length
      && !opts.gateBlockedByConflict
      && !(opts.incompleteCount || 0);
    if (complete) {
      const sentences = buildDetailFromItems(merged, detail);
      if (gateHolderMismatch && gateQuestion) {
        // The holder fact is what-is-known context the rows
        // don't state; the gate's proposal sentence is dropped
        // (the shift row is the decision now).
        const first = String(gateQuestion).match(/^.*?[.!?](\s|$)/);
        detail = `${first ? first[0].trim() : gateQuestion} ${sentences}`;
      } else {
        detail = sentences;
      }
      return { detail, items: merged };
    }
    return { detail, items: null };
  } catch (mergeErr: any) {
    console.log(`[clarify-merge] Clarification merge failed: ${mergeErr?.message}`);
    return { detail: originalDetail, items: null };
  }
}
