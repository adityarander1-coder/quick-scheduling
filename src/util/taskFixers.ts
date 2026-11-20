// util/taskFixers.ts — the deterministic fixers, shared by BOTH doors
// (Deepika, 2026-11-19 — issue N2, same-brain break: these lived in
// schedule.ts only, so the email door never ran them and a
// clarification reply went straight to Gemini).
//
// Each core builds the SYNTHETIC PLAN (or a clarification) for a
// follow-up reply — a bare amount, a narrowing, a scope correction —
// and returns it WITHOUT finalizing: the Task door finalizes through
// finalizeTaskPlan (gate + insert), the email door drops the plan
// into its normal flow (normalizeClosePlan → gate → create). A fix
// made here lands in both doors; a fix made in one door's path is a
// bug waiting to happen in the other.
//
// The pending plan a fixer narrows or re-scopes is looked up by
// (company, source subject, sender) — 'In-app agent task' for the
// Task door, the original email's subject for the email door — and
// only when the caller passes the CURRENT thread's pending plan id
// does the lookup narrow to that one plan (Deepika, 2026-11-19 —
// N3: the current pending task must be marked as current, so an old
// plan can't leak into a new ask; without a current id the lookup
// falls back to the latest pending plan, as before).

import {
  parseAmountAnswer, isCloseHowManyQuestion, isAddHowManyQuestion, isAddScopeCorrection,
  resolveCloseContext,
  parseNarrowingReply, isScopeCorrection, parseMonthScope, matchMemberName,
  lastTaskTurn, extractRequestDates, monthScopeOfDate,
} from './requestUnderstanding.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;
type History = Array<{ q: string; a: string }>;

export interface FixerPlan { summary: string; changes: any[]; }
export type FixerResult =
  | { kind: 'plan'; plan: FixerPlan }
  | { kind: 'clarification'; question: string };

async function loadLists(query: QueryFn, companyId: string) {
  const [{ rows: stRows }, { rows: dRows }, { rows: uRows }] = await Promise.all([
    query('SELECT name FROM shift_types WHERE company_id = $1 AND is_active = true', [companyId]),
    query('SELECT name FROM departments WHERE company_id = $1', [companyId]),
    query(
      `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
       FROM users WHERE company_id = $1 AND is_active = true`, [companyId]),
  ]);
  return {
    shiftNames: stRows.map((r: any) => r.name),
    deptNames: dRows.map((r: any) => r.name),
    userNames: uRows.map((r: any) => r.name),
  };
}

async function latestPendingPlan(
  query: QueryFn, companyId: string, sourceSubject: string, senderEmail: string,
  currentPlanId?: string | null,
) {
  if (currentPlanId) {
    const { rows } = await query(
      `SELECT id, plan FROM schedule_plans
       WHERE company_id = $1 AND id = $2 AND status = 'pending'`,
      [companyId, currentPlanId]
    );
    if (rows[0]) return rows[0];
    return null;
  }
  const { rows } = await query(
    `SELECT id, plan FROM schedule_plans
     WHERE company_id = $1 AND source_subject = $2 AND status = 'pending'
       AND created_at >= now() - interval '24 hours' AND source_from = $3
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, sourceSubject, senderEmail || '']
  );
  return rows[0] || null;
}

async function rejectPlan(
  query: QueryFn, companyId: string, planId: string, decidedBy: string | null | undefined,
) {
  await query(
    `UPDATE schedule_plans SET status = 'rejected', decided_at = now(), decided_by = $2
     WHERE id = $1 AND company_id = $3 AND status = 'pending'`,
    [planId, decidedBy || null, companyId]
  );
}

/** Deterministic add-amount answer (Deepika, 2026-11-19 — add
 * open slots): a bare number reply to an add "how many?" question
 * rebuilds the add directly. Only fires when the last history
 * entry is an add how-many question, and only for a plain count —
 * "keep N" and "all of them" mean nothing for an add, so they fall
 * through to the planner. The context shape is the shared
 * open-slots context (resolveCloseContext), never a local copy. */
export async function buildAddAmountPlan(
  query: QueryFn, companyId: string, message: string, history: History,
): Promise<FixerPlan | null> {
  const amount = parseAmountAnswer(message);
  if (!amount || amount.mode !== 'count') return null;
  const last = history[history.length - 1];
  if (!last || !isAddHowManyQuestion(last.a)) return null;
  const { shiftNames, deptNames } = await loadLists(query, companyId);
  const today = new Date().toISOString().slice(0, 10);
  const ctx = resolveCloseContext(last.a, last.q, shiftNames, deptNames, today);
  if (!ctx) return null;
  const change: any = {
    action: 'add_open_slots',
    shiftType: ctx.shiftType,
    ...(ctx.date ? { date: ctx.date } : { fromDate: ctx.fromDate, toDate: ctx.toDate }),
    ...(ctx.department ? { department: ctx.department } : {}),
    addCount: amount.closeCount,
  };
  return {
    summary: `Add ${amount.closeCount} open ${ctx.shiftType} slot${amount.closeCount === 1 ? '' : 's'} per date${ctx.date ? ` on ${ctx.date}` : ` ${ctx.fromDate} – ${ctx.toDate}`}.`,
    changes: [change],
  };
}

/** Deterministic close-amount answer (issue A): a bare number /
 * "all of them" / "keep N" reply to a close "how many?" question
 * rebuilds the close directly. Only fires when the last history
 * entry is a close how-many question. */
export async function buildCloseAmountPlan(
  query: QueryFn, companyId: string, message: string, history: History,
): Promise<FixerPlan | null> {
  const amount = parseAmountAnswer(message);
  if (!amount) return null;
  const last = history[history.length - 1];
  if (!last || !isCloseHowManyQuestion(last.a)) return null;
  const { shiftNames, deptNames } = await loadLists(query, companyId);
  const today = new Date().toISOString().slice(0, 10);
  const ctx = resolveCloseContext(last.a, last.q, shiftNames, deptNames, today);
  if (!ctx) return null;
  const change: any = {
    action: 'close_open_slots',
    shiftType: ctx.shiftType,
    ...(ctx.date ? { date: ctx.date } : { fromDate: ctx.fromDate, toDate: ctx.toDate }),
    ...(ctx.department ? { department: ctx.department } : {}),
  };
  if (amount.mode === 'count') change.closeCount = amount.closeCount;
  else if (amount.mode === 'keep') change.keepCount = amount.keepCount;
  else change.closeAll = true;
  return {
    summary: `Close ${ctx.shiftType} slots${ctx.date ? ` on ${ctx.date}` : ` ${ctx.fromDate} – ${ctx.toDate}`}.`,
    changes: [change],
  };
}

/** Deterministic narrowing (issues D + N11): "No only fot day
 * hospitalist" after a pending plan rebuilds it narrowed to the
 * named type/department, keeping the dates the plan already had.
 * Generalised beyond closes — any pending plan can be narrowed
 * this way (assign / move / swap / close): changes carrying the
 * named type or department are kept, type-less changes (add a team
 * member) are kept too — narrowing never silently drops an
 * unrelated change. Only fires when the history does not end with
 * an open clarification question — answering a question is never a
 * narrowing. */
export async function narrowPendingPlan(
  query: QueryFn, companyId: string, message: string, history: History,
  senderEmail: string | null, sourceSubject: string,
  requesterUserId: string | null | undefined,
  currentPlanId?: string | null,
): Promise<FixerResult | null> {
  const { shiftNames, deptNames } = await loadLists(query, companyId);
  const scope = parseNarrowingReply(message, shiftNames, deptNames);
  if (!scope) return null;
  const last = history[history.length - 1];
  const row = await latestPendingPlan(query, companyId, sourceSubject, senderEmail || '', currentPlanId);
  if (!row) {
    // Path 2 (issue D): no pending plan — the reply answers the
    // "Which shift type(s)?" question the no-type request got, so
    // there is no plan to narrow. Rebuild the close from the last
    // TASK turn narrowed to the named type/department (same shape
    // as fixCloseScopePlan's Path 2). The trailing-'?' guard does
    // NOT apply here: the question being answered IS the type
    // question, and naming the type is the answer that builds the
    // plan. Non-close task turns resolve to no close context and
    // fall through to the planner as before.
    if (!scope.shiftType && !scope.department) return null;
    const taskTurn = lastTaskTurn(history);
    if (!taskTurn) return null;
    const today = new Date().toISOString().slice(0, 10);
    // The narrowing reply itself carries the type (first arg — the
    // resolver reads the type from either text); the range comes from
    // the task turn. Passing '' here would return null: a no-type
    // task turn names no shift type on its own.
    const ctx = resolveCloseContext(message, taskTurn.q, shiftNames, deptNames, today);
    if (!ctx) return null;
    const type = scope.shiftType || ctx.shiftType;
    if (!type) return null;
    const lastQ = taskTurn.q;
    // Add round (Deepika, 2026-11-19 — add open slots): the task
    // turn is an add request, so the rebuild is an add, not a
    // close — same type + dates, amount from the request's words.
    // With no number in the request there is nothing to add, so
    // the narrowing falls through to the planner, which asks how
    // many — an add amount is never guessed.
    if (/\badd\b/i.test(lastQ) && /\bslots?\b/i.test(lastQ)) {
      const addM = lastQ.match(/\badd\s+(\d{1,3})\b/i);
      if (!addM) return null;
      const change: any = {
        action: 'add_open_slots',
        shiftType: type,
        ...(ctx.date ? { date: ctx.date } : { fromDate: ctx.fromDate, toDate: ctx.toDate }),
        ...(scope.department || ctx.department ? { department: scope.department || ctx.department } : {}),
        addCount: parseInt(addM[1], 10),
      };
      const range = ctx.date ? `on ${ctx.date}` : `(${ctx.fromDate} – ${ctx.toDate})`;
      return { kind: 'plan', plan: { summary: `Add ${addM[1]} open ${type} slots per date ${range}.`, changes: [change] } };
    }
    const change: any = {
      action: 'close_open_slots',
      shiftType: type,
      ...(ctx.date ? { date: ctx.date } : { fromDate: ctx.fromDate, toDate: ctx.toDate }),
      ...(scope.department || ctx.department ? { department: scope.department || ctx.department } : {}),
    };
    const saysAll = /(delete|close)\s+all\b/i.test(lastQ) && !/\b(keep|excess|over|above|but)\b/i.test(lastQ);
    if (saysAll) change.closeAll = true;
    else {
      const keep = lastQ.match(/\bkeep\s+(\d{1,3})\b/i) || lastQ.match(/\bin excess of\s+(\d{1,3})\b/i);
      if (keep) change.keepCount = parseInt(keep[1], 10);
      else {
        const cnt = lastQ.match(/\bclose\s+(\d{1,3})\b/i);
        if (cnt) change.closeCount = parseInt(cnt[1], 10);
        else change.closeAll = true;
      }
    }
    const range = ctx.date ? `on ${ctx.date}` : `(${ctx.fromDate} – ${ctx.toDate})`;
    return { kind: 'plan', plan: { summary: `Close open slots for ${type} ${range}.`, changes: [change] } };
  }
  if (last && last.a && last.a.trim().endsWith('?')) return null;
  const changes = (row.plan?.changes || []);
  if (!changes.length) return null;
  const kept = changes.filter((c: any) =>
    (!scope.shiftType || c.shiftType === undefined || c.shiftType === scope.shiftType) &&
    (!scope.department || c.department === undefined || c.department === scope.department));
  if (!kept.length) {
    const types = [...new Set(changes.map((c: any) => c.shiftType).filter(Boolean))].join(', ');
    return {
      kind: 'clarification',
      question: types
        ? `The pending plan only covers ${types} — which of those did you mean?`
        : `The pending plan doesn't cover that — which shift type did you mean?`,
    };
  }
  await rejectPlan(query, companyId, row.id, requesterUserId);
  const allClose = kept.every((c: any) => c.action === 'close_open_slots');
  const allAdd = kept.every((c: any) => c.action === 'add_open_slots');
  const keptTypes = [...new Set(kept.map((c: any) => c.shiftType).filter(Boolean))].join(', ');
  const summary = allClose
    ? `Close open slots for ${keptTypes} (narrowed from the earlier plan).`
    : allAdd
      ? `Add open slots for ${keptTypes} (narrowed from the earlier plan).`
      : keptTypes
        ? `Narrowed from the earlier plan (${keptTypes}).`
        : `Narrowed from the earlier plan.`;
  return { kind: 'plan', plan: { summary, changes: kept } };
}

/** Deterministic scope correction (issue L): "I asked you about
 * the whole nov month" after a close request rebuilds that close
 * with the whole-month scope, never deflecting to Ask. Two paths:
 * a pending close plan exists → re-scope its changes to the month
 * (keeping type + mode — the correction is about the DATES, not
 * the amount); none exists (the first request was refused) →
 * rebuild from the last history turn's close request (type + "all"
 * from its wording, dates = the month). */
export async function fixCloseScopePlan(
  query: QueryFn, companyId: string, message: string, history: History,
  senderEmail: string | null, sourceSubject: string,
  requesterUserId: string | null | undefined,
  currentPlanId?: string | null,
): Promise<FixerPlan | null> {
  if (!isScopeCorrection(message, history)) return null;
  const today = new Date().toISOString().slice(0, 10);
  // The month comes from the correction, from the task turn being
  // corrected, or from that turn's DATE — a deflection in between
  // doesn't move it (N3: the last TASK turn, not the last turn, is
  // the one corrected). "What about the whole month?" names no
  // month and its task turn names a DATE ("nov 19"), not a month,
  // so the month is the month of that date (N1: Nov 19 → November);
  // with no date anywhere, "the whole month" is this month.
  const taskTurn = lastTaskTurn(history);
  let scope = parseMonthScope(message, today) || (taskTurn ? parseMonthScope(taskTurn.q, today) : null);
  if (!scope && taskTurn) {
    const dates = extractRequestDates(taskTurn.q, today);
    if (dates.length) scope = monthScopeOfDate(dates[0]);
  }
  if (!scope) scope = monthScopeOfDate(today);
  if (!scope) return null;
  const { shiftNames, deptNames } = await loadLists(query, companyId);
  // Path 1: a pending close plan to re-scope.
  const row = await latestPendingPlan(query, companyId, sourceSubject, senderEmail || '', currentPlanId);
  if (row) {
    const changes = (row.plan?.changes || []);
    if (changes.length && changes.every((c: any) => c.action === 'close_open_slots')) {
      await rejectPlan(query, companyId, row.id, requesterUserId);
      const rescoped = changes.map((c: any) => {
        const n: any = { ...c };
        delete n.date;
        n.fromDate = scope.fromDate;
        n.toDate = scope.toDate;
        return n;
      });
      const types = [...new Set(rescoped.map((c: any) => c.shiftType))].join(', ');
      return {
        summary: `Close open slots for ${types} for the whole month (${scope.fromDate} – ${scope.toDate}).`,
        changes: rescoped,
      };
    }
  }
  // Path 2: no pending plan — rebuild from the last TASK turn's
  // request (a deflection in between doesn't change which request
  // is being corrected).
  const lastTurn = lastTaskTurn(history);
  if (!lastTurn) return null;
  const lastQ = lastTurn.q;
  const ctx = resolveCloseContext('', lastQ, shiftNames, deptNames, today);
  if (!ctx) return null;
  const saysAll = /(delete|close)\s+all\b/i.test(lastQ) && !/\b(keep|excess|over|above|but)\b/i.test(lastQ);
  const change: any = {
    action: 'close_open_slots',
    shiftType: ctx.shiftType,
    fromDate: scope.fromDate,
    toDate: scope.toDate,
    ...(ctx.department ? { department: ctx.department } : {}),
  };
  if (saysAll) change.closeAll = true;
  else {
    const keep = lastQ.match(/\bkeep\s+(\d{1,3})\b/i) || lastQ.match(/\bin excess of\s+(\d{1,3})\b/i);
    if (keep) change.keepCount = parseInt(keep[1], 10);
    else {
      const cnt = lastQ.match(/\bclose\s+(\d{1,3})\b/i);
      if (cnt) change.closeCount = parseInt(cnt[1], 10);
      else change.closeAll = true;
    }
  }
  return {
    summary: `Close open slots for ${ctx.shiftType} for the whole month (${scope.fromDate} – ${scope.toDate}).`,
    changes: [change],
  };
}

/** Deterministic scope correction for adds (Deepika, 2026-11-19
 * — add open slots): "I asked you about the whole nov month"
 * after an add request rebuilds that add with the whole-month
 * scope, never deflecting to Ask. Mirror of fixCloseScopePlan.
 * Two paths: a pending add plan exists → re-scope its changes
 * to the month (keeping type + amount — the correction is about
 * the DATES, not the amount); none exists (the first request was
 * refused) → rebuild from the last history turn's add request
 * (type + amount from its wording, dates = the month). */
export async function fixAddScopePlan(
  query: QueryFn, companyId: string, message: string, history: History,
  senderEmail: string | null, sourceSubject: string,
  requesterUserId: string | null | undefined,
  currentPlanId?: string | null,
): Promise<FixerPlan | null> {
  if (!isAddScopeCorrection(message, history)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const taskTurn = lastTaskTurn(history);
  let scope = parseMonthScope(message, today) || (taskTurn ? parseMonthScope(taskTurn.q, today) : null);
  if (!scope && taskTurn) {
    const dates = extractRequestDates(taskTurn.q, today);
    if (dates.length) scope = monthScopeOfDate(dates[0]);
  }
  if (!scope) scope = monthScopeOfDate(today);
  if (!scope) return null;
  const { shiftNames, deptNames } = await loadLists(query, companyId);
  // Path 1: a pending add plan to re-scope.
  const row = await latestPendingPlan(query, companyId, sourceSubject, senderEmail || '', currentPlanId);
  if (row) {
    const changes = (row.plan?.changes || []);
    if (changes.length && changes.every((c: any) => c.action === 'add_open_slots')) {
      await rejectPlan(query, companyId, row.id, requesterUserId);
      const rescoped = changes.map((c: any) => {
        const n: any = { ...c };
        delete n.date;
        n.fromDate = scope.fromDate;
        n.toDate = scope.toDate;
        return n;
      });
      const types = [...new Set(rescoped.map((c: any) => c.shiftType))].join(', ');
      return {
        summary: `Add open slots for ${types} for the whole month (${scope.fromDate} – ${scope.toDate}).`,
        changes: rescoped,
      };
    }
  }
  // Path 2: no pending plan — rebuild from the last TASK turn's
  // request (a deflection in between doesn't change which request
  // is being corrected).
  const lastTurn = lastTaskTurn(history);
  if (!lastTurn) return null;
  const lastQ = lastTurn.q;
  const ctx = resolveCloseContext('', lastQ, shiftNames, deptNames, today);
  if (!ctx) return null;
  const addM = lastQ.match(/\badd\s+(\d{1,3})\b/i);
  if (!addM) return null;
  const change: any = {
    action: 'add_open_slots',
    shiftType: ctx.shiftType,
    fromDate: scope.fromDate,
    toDate: scope.toDate,
    ...(ctx.department ? { department: ctx.department } : {}),
    addCount: parseInt(addM[1], 10),
  };
  return {
    summary: `Add ${addM[1]} open ${ctx.shiftType} slots per date for the whole month (${scope.fromDate} – ${scope.toDate}).`,
    changes: [change],
  };
}

/** Typed reply to an open clarification (issue N4): the same
 * resolution lines as the tap path (clarify-task/:token), read off
 * the typed words. A typed full name that matches one candidate of
 * a name item answers that item; a typed name matching candidates
 * in several items answers each; unmatched items keep the tap
 * answers already recorded. Returns null when the typed text
 * matches nothing — the caller falls through to the planner with
 * the reply stitched to the original request, as the email door
 * does. Shift items are not typed-answerable (a date + type in
 * words is ambiguous); they fall through too. */
export function resolveTypedClarificationAnswer(
  row: { options?: { items: any[] } | null; answers?: Record<string, string> },
  message: string,
): { answers: Record<string, string>; lines: string[] } | null {
  const items: any[] = row.options?.items || [];
  if (!items.length) return null;
  const answers: Record<string, string> = { ...(row.answers || {}) };
  const lines: string[] = [];
  let matchedAny = false;
  items.forEach((item: any, i: number) => {
    if (answers[String(i)]) return; // already answered — keep the tap
    if (item.kind !== 'name' || !Array.isArray(item.candidates) || !item.candidates.length) return;
    const people = item.candidates.map((c: any) => {
      const parts = String(c.name || '').trim().split(/\s+/);
      return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '', nickname: null as string | null, _id: c.id, _name: c.name };
    });
    const hit = matchMemberName(message, people as any);
    if (!hit) return;
    matchedAny = true;
    answers[String(i)] = (hit as any)._id;
    lines.push(`"${item.fragment}" means ${(hit as any)._name}.`);
  });
  if (!matchedAny) return null;
  return { answers, lines };
}
