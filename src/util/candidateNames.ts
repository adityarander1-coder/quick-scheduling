// util/candidateNames.ts — candidate listing for Task + Email AI
// (Deepika, 2026-11-17): when the planner asks who to assign and
// the requester answers "Give me names", the names must be offered
// right there — tappable in Task, listed in prose by email —
// instead of the flip-to-Ask signpost. ONE shared list builder, so
// both doors offer the same people in the same order: the shift
// type's departments when the round names one (eligible-first
// under the 8bb7e5d department-scoped job-role rule), else the
// sender's department first, else the whole company. The tappable
// cap (10) matches collectNameProblems' slice; the none-of-these
// escape behind the same token covers the rest of the roster.
// The tap itself needs no new machinery: the item is an ordinary
// name item on the ordinary pending row, so tapping one runs the
// ordinary tap-to-replan with `"the person to assign" means X.`
// stitched onto the original request.

import crypto from 'node:crypto';
import type { ClarificationItem } from './planGate.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface CandidatePerson { id: string; name: string; }

export interface CandidateList {
  candidates: CandidatePerson[];
  shiftType: { id: string; name: string } | null;
  departmentNames: string[];
  /** True when the list was narrowed to specific departments
   * (a named shift type or the sender's own) — false when it
   * covers the whole company, so the detail text stays quiet
   * about departments in that case. */
  scoped: boolean;
}

const norm = (s: string) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

/** The shared candidate list, in display order. Scope comes from
 * the round's own words: a shift type named anywhere in them
 * narrows the list to that type's departments; otherwise the
 * sender's department leads; otherwise the whole company. */
export async function buildCandidateList(
  query: QueryFn,
  companyId: string,
  opts: { scopeText: string; senderEmail?: string | null; limit?: number }
): Promise<CandidateList> {
  const limit = opts.limit || 10;
  const { rows: urows } = await query(
    `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name,
            department_id AS "departmentId"
     FROM users WHERE company_id = $1 AND is_active = true
     ORDER BY lower(first_name), lower(last_name)`,
    [companyId]);
  const { rows: strows } = await query(
    `SELECT id, name, department_id AS "departmentId" FROM shift_types
     WHERE company_id = $1 AND is_active = true`,
    [companyId]);
  const { rows: sdrows } = await query(
    `SELECT std.shift_type_id AS "shiftTypeId", std.department_id AS "departmentId"
     FROM shift_type_departments std JOIN shift_types st ON st.id = std.shift_type_id
     WHERE st.company_id = $1`,
    [companyId]);
  const { rows: drows } = await query(
    'SELECT id, name FROM departments WHERE company_id = $1',
    [companyId]);
  const deptName = new Map<string, string>(drows.map((d: any) => [d.id, d.name]));
  const typeDepts = new Map<string, string[]>();
  for (const t of strows) typeDepts.set(t.id, t.departmentId ? [t.departmentId] : []);
  for (const sd of sdrows) {
    const list = typeDepts.get(sd.shiftTypeId) || [];
    if (!list.includes(sd.departmentId)) list.push(sd.departmentId);
    typeDepts.set(sd.shiftTypeId, list);
  }
  // The shift type the round is about, if any: the longest name
  // that appears in the round's words, so "Day Hospitalist" wins
  // over a shorter name it contains.
  const scopeLower = norm(opts.scopeText);
  let shiftType: { id: string; name: string } | null = null;
  for (const t of strows) {
    const name = norm(t.name);
    if (name && scopeLower.includes(name)) {
      if (!shiftType || name.length > norm(shiftType.name).length) {
        shiftType = { id: t.id, name: t.name };
      }
    }
  }
  let senderDeptId: string | null = null;
  if (opts.senderEmail) {
    try {
      const { rows: srows } = await query(
        'SELECT department_id FROM users WHERE company_id = $1 AND lower(email) = $2 AND is_active = true LIMIT 1',
        [companyId, String(opts.senderEmail).toLowerCase()]);
      senderDeptId = srows[0]?.department_id || null;
    } catch { /* sender department unknown — company order below */ }
  }
  let scopeDeptIds: string[] | null = null;
  if (shiftType) scopeDeptIds = typeDepts.get(shiftType.id) || [];
  else if (senderDeptId) scopeDeptIds = [senderDeptId];
  const scoped = !!scopeDeptIds && scopeDeptIds.length > 0;
  const inScope = (u: any) => !scoped || scopeDeptIds!.includes(u.departmentId);
  let pool = urows.filter(inScope);
  if (!pool.length) {
    // A scoped department with nobody in it still gets a list —
    // the whole company, department-first — rather than nothing.
    pool = urows.slice();
  }
  // Eligible-first for the named type (same rule as the manual
  // assign / pickup paths); without a type, everyone is equal.
  // Best-effort per person: an uncheckable person sorts last
  // instead of dropping out of the list.
  const eligible = new Map<string, boolean>();
  if (shiftType) {
    const { checkPersonEligible } = await import('./planExecutor.js');
    for (const u of pool) {
      try {
        eligible.set(u.id, (await checkPersonEligible(companyId, u.id, shiftType.id)).ok);
      } catch { eligible.set(u.id, false); }
    }
  }
  const deptRank = (u: any) => (senderDeptId && u.departmentId === senderDeptId ? 0 : 1);
  pool.sort((a: any, b: any) => {
    const ea = shiftType ? (eligible.get(a.id) ? 0 : 1) : 0;
    const eb = shiftType ? (eligible.get(b.id) ? 0 : 1) : 0;
    if (ea !== eb) return ea - eb;
    const da = deptRank(a), db = deptRank(b);
    if (da !== db) return da - db;
    return 0; // the query already ordered by name
  });
  const departmentNames = scoped
    ? [...new Set(scopeDeptIds!.map((id: string) => deptName.get(id)).filter((n): n is string => !!n))]
    : [];
  return {
    candidates: pool.slice(0, limit).map((u: any) => ({ id: u.id, name: u.name })),
    shiftType,
    departmentNames,
    scoped,
  };
}

/** The question line above the tappable names (Task). */
export function candidateTapDetail(list: CandidateList): string {
  const where = list.scoped && list.departmentNames.length
    ? ` in ${list.departmentNames.join(', ')}` : '';
  const toType = list.shiftType ? ` to ${list.shiftType.name}` : '';
  return `Here are the people${where} — tap a name to assign them${toType}.`;
}

/** The intro line above the prose name list (email). */
export function candidateReplyDetail(list: CandidateList): string {
  const where = list.scoped && list.departmentNames.length
    ? ` in ${list.departmentNames.join(', ')}` : '';
  const forType = list.shiftType ? ` for ${list.shiftType.name}` : '';
  return `Here are the people${where}${forType}:`;
}

/** Build + save the Task candidate clarification: one name item
 * whose tap answers the round's "who to assign" question and
 * replans the ORIGINAL request. Returns null when there is no
 * sender to key the pending row on, or nobody to offer. */
export async function buildCandidateClarification(
  query: QueryFn,
  companyId: string,
  opts: { scopeText: string; senderEmail: string; originalTask: string }
): Promise<{ detail: string; items: ClarificationItem[]; token: string; originalTask: string } | null> {
  const list = await buildCandidateList(query, companyId, {
    scopeText: opts.scopeText, senderEmail: opts.senderEmail,
  });
  if (!list.candidates.length) return null;
  const detail = candidateTapDetail(list);
  const item: ClarificationItem = {
    kind: 'name',
    fragment: 'the person to assign',
    field: 'person',
    label: 'the person to assign',
    question: 'Who would you like to assign?',
    candidates: list.candidates,
  };
  const token = crypto.randomBytes(24).toString('base64url');
  const { savePendingClarification } = await import('./pendingClarifications.js');
  await savePendingClarification(
    query, companyId, opts.senderEmail, 'In-app agent task', opts.originalTask,
    detail, null,
    { options: { items: [item] }, answerToken: token }
  );
  return { detail, items: [item], token, originalTask: opts.originalTask };
}
