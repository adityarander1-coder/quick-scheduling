// util/planGate.ts — the exact-name + workability gate for AI-built
// plans (Deepika, 2026-11-10, after the live "Kum" → Binod Kumar
// incident: the planner named a man who was not on the Dec 2 schedule
// at all, and no layer checked).
//
// Every plan the planner produces (email path AND in-app Task path)
// passes through here BEFORE a pending plan may be created:
//
//   1. EXACT NAMES. Every person a change names (person / fromPerson /
//      toPerson / presenter / supervisor) must resolve EXACTLY against
//      the company's active roster — full name, the person's unique
//      stored first name, or unique nickname (planHelpers.matchName
//      semantics, tightened in one place: a bare last name is a
//      candidate for a question here, not an identity — see
//      resolvePerson). Resolved fields are rewritten to the canonical full
//      name. Anything else — a fragment like "Kum", a shared first
//      name, a name nobody has — BLOCKS the plan and becomes ONE
//      precise clarification question naming the candidates. Never a
//      guess, never a substring pick.
//
//   2. WORKABILITY. A move/swap's from-person must actually hold that
//      shift (type + date) in the real schedule — stored shifts OR
//      pattern-drawn occurrences, read through getShiftsForRange, the
//      same source the grid uses. If someone else holds it, the
//      question names the actual holder. And giving a shift TO a
//      person is checked with the shared conflict rules (overlap or
//      < 8h rest, occurrences included): a hard conflict blocks the
//      plan and becomes a question naming the conflict.
//
// The form path never comes through here — it builds changes from
// picked IDs inside createPendingPlanFromChanges, exact by
// construction. Callers route a blocked plan through the EXISTING
// clarification machinery (email: pendingClarifications; in-app Task:
// the clarification reply), never a parallel system.

import { matchName } from './planHelpers.js';
import { getShiftsForRange } from './shiftRange.js';
import { checkShiftConflict, checkSwapConflicts } from './shiftConflicts.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

/** One structured name-ambiguity item (Deepika, 2026-11-10 —
 * clickable clarification options): the fragment exactly as written,
 * the plan field it came from, and the roster candidates it could
 * mean. The email path stores these with the pending clarification
 * so the question can be answered by tapping a name. Candidates
 * ALWAYS come from this module's roster resolution — never from
 * parsing names out of prose. */
export interface NameAmbiguityItem {
  fragment: string;
  field: string;
  label: string;
  candidates: { id: string; name: string }[];
}

export type GateResult =
  | { ok: true }
  | { ok: false; question: string; items?: NameAmbiguityItem[] };

interface RosterUser {
  id: string;
  firstName: string;
  lastName: string;
  nickname: string | null;
  fullName: string;
  display: string;
}

const norm = (s: string) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');

type Resolution =
  | { kind: 'user'; user: RosterUser }
  | { kind: 'ambiguous'; candidates: RosterUser[] }
  | { kind: 'none'; suggestions: string[] };

/** The company's active roster in gate order (shared by the gate
 * itself and the clarification-item derivation below). */
export async function loadGateRoster(query: QueryFn, companyId: string): Promise<RosterUser[]> {
  const { rows: urows } = await query(
    `SELECT id, first_name, last_name, nickname FROM users
     WHERE company_id = $1 AND is_active = true
     ORDER BY lower(first_name), lower(last_name)`,
    [companyId]
  );
  return urows.map((u: any) => {
    const fullName = `${u.first_name || ''} ${u.last_name || ''}`.trim().replace(/\s+/g, ' ');
    return {
      id: u.id,
      firstName: u.first_name || '',
      lastName: u.last_name || '',
      nickname: u.nickname || null,
      fullName,
      display: u.nickname || fullName,
    };
  });
}

/** Resolve one typed name against the roster, Deepika's exact rule. */
function resolvePerson(input: string, roster: RosterUser[]): Resolution {
  const q = norm(input);
  if (!q) return { kind: 'none', suggestions: [] };
  // 1. Exact full name. Two active members sharing one full name is
  //    genuinely ambiguous — report, never pick the first row.
  const fullHits = roster.filter((u) => norm(u.fullName) === q);
  if (fullHits.length === 1) return { kind: 'user', user: fullHits[0] };
  if (fullHits.length > 1) return { kind: 'ambiguous', candidates: fullHits };
  // 2. Exact nickname (the name the person is known by), when unique.
  const nickHits = roster.filter((u) => u.nickname && norm(u.nickname) === q);
  if (nickHits.length === 1) return { kind: 'user', user: nickHits[0] };
  if (nickHits.length > 1) return { kind: 'ambiguous', candidates: nickHits };
  // 3. matchName semantics over full names — with ONE tightening.
  //    matchName (the Ask path) resolves a UNIQUE bare last name as
  //    exact; the plan gate does not. Deepika's rule for plans is
  //    full name / unique first name / nickname, and the incident is
  //    precisely a last-name fragment: "Kum" must become a question
  //    naming the candidates (Sha Kum by last name, Binod Kumar by
  //    resemblance), never a silent pick of either. The executor's
  //    findUser keeps unique-last resolution for already-created
  //    plans; only plan CREATION is stricter, because a wrong pick
  //    here moves someone's shifts.
  const m = matchName(input, roster.map((u) => u.fullName));
  if (m.status === 'exact') {
    const hits = roster.filter((u) => u.fullName === m.name);
    if (hits.length !== 1) return { kind: 'ambiguous', candidates: hits };
    const u = hits[0];
    if (!q.includes(' ') && norm(u.firstName) !== q && norm(u.lastName) === q) {
      const cands = roster
        .filter((x) => norm(x.lastName) === q || norm(x.fullName).includes(q));
      return { kind: 'ambiguous', candidates: [...new Map(cands.map((x) => [x.id, x])).values()] };
    }
    return { kind: 'user', user: u };
  }
  if (m.status === 'suggestions') {
    const byName = new Map(roster.map((u) => [u.fullName, u]));
    const cands = m.names.map((n) => byName.get(n)).filter((u): u is RosterUser => !!u);
    return { kind: 'ambiguous', candidates: cands.length ? cands : [] };
  }
  return { kind: 'none', suggestions: [] };
}

function nameQuestion(fieldLabel: string, input: string, res: Resolution): string {
  if (res.kind === 'ambiguous') {
    return `Who do you mean by "${input}" (${fieldLabel})? It could be ${res.candidates.map((u) => u.fullName).join(' or ')} — please use the full name.`;
  }
  return `I don't see a team member named "${input}" (${fieldLabel}). Please check the name and use their full name as it appears on the team list.`;
}

/** Quoted fragments in a question text ('You wrote 'dah' and "Kum"')
 * — the spans a question itself flags as the unclear words. */
export function extractQuotedFragments(text: string): string[] {
  const out: string[] = [];
  const re = /["“”]([^"“”]{1,50})["“”]|'([^']{1,50})'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || '')))) {
    const f = (m[1] ?? m[2] ?? '').trim();
    if (f) out.push(f);
  }
  return [...new Set(out)];
}

/**
 * Structured items for a PLANNER-composed clarification question
 * (Deepika, 2026-11-10): the planner writes prose only, so the
 * candidate sets are reconstructed deterministically — take the
 * fragments the question itself quotes and resolve each against the
 * roster with the gate's exact rule. A fragment becomes an item
 * ONLY when that resolution is genuinely ambiguous (≥1 candidate);
 * exact and unknown fragments are skipped, so an open-ended
 * question yields no items and behaves exactly as before.
 */
export async function deriveNameAmbiguityItems(
  query: QueryFn, companyId: string, questionText: string
): Promise<NameAmbiguityItem[]> {
  const fragments = extractQuotedFragments(questionText);
  if (!fragments.length) return [];
  const roster = await loadGateRoster(query, companyId);
  const items: NameAmbiguityItem[] = [];
  const seen = new Set<string>();
  for (const fragment of fragments) {
    if (items.length >= 4) break;
    // Plausible name fragments only: letters, up to 3 words.
    if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(fragment) || fragment.split(/\s+/).length > 3) continue;
    const key = norm(fragment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const res = resolvePerson(fragment, roster);
    if (res.kind !== 'ambiguous' || !res.candidates.length) continue;
    items.push({
      fragment,
      field: 'person',
      label: 'the person',
      candidates: res.candidates.map((u) => ({ id: u.id, name: u.fullName })),
    });
  }
  return items;
}

const PERSON_FIELDS: Array<{ actions: string[]; field: string; label: string }> = [
  { actions: ['assign', 'assign_recurring', 'unassign', 'update_team_member'], field: 'person', label: 'the person' },
  { actions: ['move', 'swap'], field: 'fromPerson', label: 'the person to move from' },
  { actions: ['move', 'swap'], field: 'toPerson', label: 'the person to move to' },
  { actions: ['add_session', 'update_session'], field: 'presenter', label: 'the presenter' },
  { actions: ['add_session', 'update_session'], field: 'supervisor', label: 'the supervisor' },
];

/**
 * Gate a plan's changes. Mutates the changes it can resolve (person
 * fields are rewritten to canonical full names, like the Task path's
 * collectNameProblems already does). Returns the FIRST blocking
 * problem as one precise question — Deepika's rule: ask only when
 * genuinely undecidable, and ask once.
 */
export async function gatePlanChanges(
  query: QueryFn,
  companyId: string,
  changes: any[]
): Promise<GateResult> {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length) return { ok: true };

  const roster = await loadGateRoster(query, companyId);
  // ---- 1. exact names -------------------------------------------------
  const resolved = new Map<any, Map<string, RosterUser>>();
  for (const c of list) {
    const per = new Map<string, RosterUser>();
    resolved.set(c, per);
    for (const { actions, field, label } of PERSON_FIELDS) {
      if (!actions.includes(c.action)) continue;
      const raw = c[field];
      if (raw === undefined || raw === null || String(raw).trim() === '') continue;
      const res = resolvePerson(String(raw), roster);
      if (res.kind !== 'user') {
        // A genuine ambiguity also emits the structured item, so
        // the clarification can be answered by tapping a name.
        const items = res.kind === 'ambiguous' && res.candidates.length
          ? [{
              fragment: String(raw),
              field,
              label,
              candidates: res.candidates.map((u) => ({ id: u.id, name: u.fullName })),
            }]
          : undefined;
        return { ok: false, question: nameQuestion(label, String(raw), res), items };
      }
      per.set(field, res.user);
      c[field] = res.user.fullName; // canonical — downstream lookups stay exact
    }
  }

  // ---- 2. workability ---------------------------------------------------
  const SHIFT_ACTIONS = ['assign', 'assign_recurring', 'move', 'swap'];
  const dated = list.filter((c) => SHIFT_ACTIONS.includes(c.action) && (c.date || c.fromDate || c.startDate));
  if (!dated.length) return { ok: true };

  const { rows: strows } = await query(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  const typeByName = new Map(strows.map((r: any) => [norm(r.name), { id: r.id, name: r.name }]));
  const resolveType = (name?: string) => (name ? typeByName.get(norm(name)) || null : null);

  const dates: string[] = [];
  for (const c of dated) {
    for (const d of [c.date, c.fromDate, c.toDate, c.startDate]) if (d) dates.push(String(d));
  }
  dates.sort();
  const shiftDay = (ds: string, n: number) => {
    const d = new Date(ds + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const from = shiftDay(dates[0], -2);
  const to = shiftDay(dates[dates.length - 1], 2);
  const entries = await getShiftsForRange(query, companyId, from, to);
  const heldBy = (userId: string, date: string, typeId?: string | null) =>
    entries.filter((e) => e.userId === userId && e.date === date && (!typeId || e.shiftTypeId === typeId));
  const holdersOf = (date: string, typeId: string): string[] =>
    [...new Set(entries.filter((e) => e.date === date && e.shiftTypeId === typeId).map((e) => e.personName))];

  for (const c of dated) {
    const per = resolved.get(c)!;
    if (c.action === 'assign' || c.action === 'assign_recurring') {
      const person = per.get('person');
      const date = String(c.action === 'assign' ? c.date : c.startDate || '');
      const type = resolveType(c.shiftType);
      if (!person || !date || !type) continue;
      if (heldBy(person.id, date, type.id).length) continue; // already on it — executor no-ops
      const reason = await checkShiftConflict(query, companyId, {
        userId: person.id,
        personName: person.display,
        proposed: { date, shiftTypeId: type.id, shiftTypeName: type.name },
      });
      if (reason) return { ok: false, question: reason };
    } else if (c.action === 'move') {
      const fromUser = per.get('fromPerson');
      const toUser = per.get('toPerson');
      const date = String(c.date || c.fromDate || '');
      if (!fromUser || !toUser || !date) continue;
      const type = resolveType(c.shiftType);
      const mine = heldBy(fromUser.id, date, type?.id);
      if (!mine.length) {
        if (type) {
          const holders = holdersOf(date, type.id);
          if (holders.length) {
            return {
              ok: false,
              question: `${fromUser.fullName} has no ${type.name} on ${date} — ${holders.join(' and ')} ${holders.length === 1 ? 'does' : 'do'}. Should I move ${holders[0]}'s ${type.name} on ${date} to ${toUser.fullName} instead?`,
            };
          }
          return {
            ok: false,
            question: `Nobody is scheduled for ${type.name} on ${date}, so there is no shift to move. Should I assign ${toUser.fullName} to ${type.name} on ${date} instead?`,
          };
        }
        return {
          ok: false,
          question: `${fromUser.fullName} isn't working on ${date}, so there is no shift to move. Who holds the shift you mean?`,
        };
      }
      const held = mine[0];
      if (heldBy(toUser.id, date, held.shiftTypeId).length) continue; // already on it — no-op
      const reason = await checkShiftConflict(query, companyId, {
        userId: toUser.id,
        personName: toUser.display,
        proposed: { date, shiftTypeId: held.shiftTypeId!, shiftTypeName: held.shiftTypeName },
        exclude: [],
      });
      if (reason) return { ok: false, question: reason };
    } else if (c.action === 'swap') {
      const fromUser = per.get('fromPerson');
      const toUser = per.get('toPerson');
      const fromDate = String(c.fromDate || c.date || '');
      const toDate = String(c.toDate || c.date || '');
      if (!fromUser || !toUser || !fromDate || !toDate) continue;
      const type = resolveType(c.shiftType);
      const fromHeld = heldBy(fromUser.id, fromDate, type?.id);
      if (!fromHeld.length) {
        if (type) {
          const holders = holdersOf(fromDate, type.id);
          if (holders.length) {
            return {
              ok: false,
              question: `${fromUser.fullName} has no ${type.name} on ${fromDate} — ${holders.join(' and ')} ${holders.length === 1 ? 'does' : 'do'}. A swap needs ${fromUser.fullName} to be working that shift.`,
            };
          }
          return {
            ok: false,
            question: `Nobody is scheduled for ${type.name} on ${fromDate}, so there is nothing to swap. Did you mean a different date?`,
          };
        }
        return {
          ok: false,
          question: `${fromUser.fullName} isn't working on ${fromDate}, so there is no shift to swap. Who holds the shift you mean?`,
        };
      }
      const fromTuple = { date: fromDate, shiftTypeId: fromHeld[0].shiftTypeId!, shiftTypeName: fromHeld[0].shiftTypeName };
      const toHeld = heldBy(toUser.id, toDate, type?.id);
      const toTuple = toHeld.length
        ? { date: toDate, shiftTypeId: toHeld[0].shiftTypeId!, shiftTypeName: toHeld[0].shiftTypeName }
        : null;
      const reason = await checkSwapConflicts(query, companyId, [
        {
          userId: fromUser.id, personName: fromUser.display,
          gives: [fromTuple],
          receives: toTuple ? [toTuple] : [],
        },
        {
          userId: toUser.id, personName: toUser.display,
          gives: toTuple ? [toTuple] : [],
          // Mirrors the executor: with an exchange, toUser covers
          // fromDate; a move (no shift to exchange) lands on toDate.
          receives: [{ date: toTuple ? fromDate : toDate, shiftTypeId: fromTuple.shiftTypeId, shiftTypeName: fromTuple.shiftTypeName }],
        },
      ]);
      if (reason) return { ok: false, question: reason };
    }
  }
  return { ok: true };
}
