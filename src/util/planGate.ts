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
import { resolveRotationPattern } from './planExecutor.js';
import { getShiftsForRange } from './shiftRange.js';
import { checkShiftConflict, checkSwapConflicts } from './shiftConflicts.js';
import { getGeneratedTypeIds, getUndraftedDatesForType, getTypesWithRotations } from './scheduleMode.js';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

/** One structured name-ambiguity item (Deepika, 2026-11-10 —
 * clickable clarification options): the fragment exactly as written,
 * the plan field it came from, and the roster candidates it could
 * mean. The email path stores these with the pending clarification
 * so the question can be answered by tapping a name. Candidates
 * ALWAYS come from this module's roster resolution — never from
 * parsing names out of prose. */
export interface NameAmbiguityItem {
  kind: 'name';
  fragment: string;
  field: string;
  label: string;
  /** Optional row question, shown instead of the "Who did you
   * mean by …?" template — used by rows that offer a candidate
   * list rather than disambiguating a fragment (Deepika,
   * 2026-11-17: "Give me names" lists who to assign). Absent on
   * every existing item, so their rendering is unchanged. */
  question?: string;
  candidates: { id: string; name: string }[];
}

/** One structured shift-choice item (Deepika, 2026-11-11 — the
 * one-email fix): when the question is WHICH shift is being given
 * up, the candidate shifts are tappable too — each option is a
 * (holder, shift type, date) tuple taken from the real schedule,
 * never from parsing the question's prose. */
export interface ShiftChoiceOption {
  holderId: string;
  holderName: string;
  shiftTypeId: string;
  shiftTypeName: string;
  date: string;
}

export interface ShiftChoiceItem {
  kind: 'shift';
  label: string;
  date: string;
  options: ShiftChoiceOption[];
}

/** Any row of a clarification's options block. Legacy stored rows
 * (migration 103) carry no `kind` on name items — readers treat a
 * missing kind as 'name'. */
export type ClarificationItem = NameAmbiguityItem | ShiftChoiceItem;

export type GateResult =
  | { ok: true }
  | { ok: false; question: string; items?: ClarificationItem[]; holderMismatch?: boolean; blockedBy?: 'conflict' };

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
 * (Deepika, 2026-11-10; one-email fix 2026-11-11): the planner
 * writes prose only, so the candidate sets are reconstructed
 * deterministically — take the fragments the question itself quotes
 * and resolve each against the roster with the gate's exact rule.
 * A fragment becomes an item when it resolves to at least one
 * candidate AND it was not already written as that person's full
 * name — a quoted full name is settled, a fragment or first name
 * gets a tappable row (one candidate → one full-name button, never
 * Yes/No). Returns the items plus the plausible fragments that
 * resolved to NOBODY — those mean the question cannot be fully
 * buttonized and the caller must fall back to prose.
 */
export async function deriveNameAmbiguityItems(
  query: QueryFn, companyId: string, questionText: string
): Promise<{ items: NameAmbiguityItem[]; unresolved: string[] }> {
  const fragments = extractQuotedFragments(questionText);
  const { items, unresolved } = await resolveNameValues(query, companyId, fragments);
  return { items: items.slice(0, 4), unresolved };
}

/**
 * Resolve arbitrary written name values against the roster and
 * build name items for them — shared by the quoted-fragment
 * derivation above and by the planner's change-field values (the
 * raw person words, before the gate canonicalizes them). A value
 * written exactly as a roster full name is settled and gets no
 * row; anything else that resolves to at least one candidate gets
 * one. Values resolving to nobody, and non-name-looking values,
 * are skipped (and, for quoted fragments, reported unresolved by
 * the caller above).
 */
export async function resolveNameValues(
  query: QueryFn, companyId: string, values: string[]
): Promise<{ items: NameAmbiguityItem[]; unresolved: string[] }> {
  const roster = await loadGateRoster(query, companyId);
  const items: NameAmbiguityItem[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const fragment = String(raw || '').trim();
    if (!fragment) continue;
    // Plausible name fragments only: letters, up to 3 words.
    if (!/^[\p{L}][\p{L}\s.'-]*$/u.test(fragment) || fragment.split(/\s+/).length > 3) continue;
    const key = norm(fragment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const res = resolvePerson(fragment, roster);
    if (res.kind === 'none') { unresolved.push(fragment); continue; }
    const cands = res.kind === 'user' ? [res.user] : res.candidates;
    if (!cands.length) { unresolved.push(fragment); continue; }
    // Written exactly as the (only) candidate's full name: settled.
    if (res.kind === 'user' && norm(fragment) === norm(res.user.fullName)) continue;
    items.push({
      kind: 'name',
      fragment,
      field: 'person',
      label: 'the person',
      candidates: cands.map((u) => ({ id: u.id, name: u.fullName })),
    });
  }
  return { items, unresolved };
}

/**
 * Name items from the sender's OWN words (Deepika, 2026-11-11 —
 * the one-email fix): the planner canonicalizes names before the
 * gate ever sees them ('muh' becomes its guess 'Muh Ras'), so the
 * planner's outputs alone cannot recover which written words were
 * ambiguous. Scan the original request text for name-like words
 * and resolve each with the gate's exact rule. A word is skipped
 * when it is part of an exact full-name mention ('Bon' inside
 * 'Bon Dah' is settled), a month/weekday, a shift-type word, or
 * an ordinary word that resolves to nobody. One word → one item
 * when it resolves to ≥1 candidate (1 → a single full-name
 * button, never Yes/No). Items read in first-appearance order.
 */
const REQUEST_STOPWORDS = new Set([
  // Months + weekdays (also names of people in some rosters — the
  // request's dates, never its people).
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'fri', 'sat', 'sun',
  // Ordinary request words.
  'could', 'you', 'please', 'assign', 'assigned', 'move', 'moving', 'swap', 'swapping', 'cover', 'covering',
  'take', 'taking', 'takes', 'took', 'from', 'to', 'the', 'on', 'for', 'of', 'in', 'at', 'by', 'with',
  'he', 'she', 'his', 'her', 'hers', 'him', 'they', 'them', 'their', 'it', 'its', 'is', 'are', 'was', 'were',
  'be', 'been', 'me', 'my', 'i', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'do', 'does', 'did',
  'am', 'as', 'have', 'has', 'had', 'we', 'us', 'our', 'your', 'all', 'any', 'some', 'one', 'two',
  'need', 'needs', 'want', 'wants', 'work', 'working', 'off', 'sick', 'leave', 'vacation', 'holiday',
  'next', 'last', 'this', 'that', 'there', 'here', 'who', 'what', 'when', 'where', 'which', 'not', 'no', 'yes',
  'also', 'just', 'only', 'originally', 'okay', 'ok', 'hey', 'hi', 'hello', 'thanks', 'thank', 'someone', 'anyone',
  'today', 'tomorrow', 'sometime', 'sometimes', 'shifts', 'shift', 'schedule', 'scheduled', 'date', 'dates',
  'change', 'changes', 'give', 'given', 'giving', 'up', 'out', 'per', 'every', 'each', 'first', 'second',
]);

export async function deriveNameItemsFromRequest(
  query: QueryFn, companyId: string, text: string
): Promise<NameAmbiguityItem[]> {
  const roster = await loadGateRoster(query, companyId);
  // Ordinal strip (Deepika, 2026-11-11 — the "17th" → "th" phantom):
  // a date's ordinal suffix is not a word, so it never reaches the
  // tokenizer — "17th" reads as "17" and no "th" token can
  // substring-match Tis Tha. Both doors (email + Task) scan through
  // here, so one strip fixes both.
  const scanText = String(text || '').replace(/(\d+)(?:st|nd|rd|th)\b/gi, '$1');
  const lower = scanText.toLowerCase();
  // Words settled by an exact full-name mention in the text.
  const settled = new Set<string>();
  for (const u of roster) {
    const name = u.fullName.toLowerCase();
    if (!name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, 'u').test(lower)) {
      for (const w of name.split(/\s+/)) settled.add(w);
    }
  }
  // Shift-type words are never names ('Day' in 'Day Hospitalist').
  const stop = new Set(REQUEST_STOPWORDS);
  try {
    const { rows } = await query(
      'SELECT name FROM shift_types WHERE company_id = $1 AND is_active = true', [companyId]);
    for (const r of rows) for (const w of String(r.name || '').toLowerCase().split(/[^a-z]+/)) if (w) stop.add(w);
  } catch { /* shift types unreadable — the static list still applies */ }
  const items: NameAmbiguityItem[] = [];
  const seen = new Set<string>();
  const tokens = scanText.match(/[\p{L}]+(?:['’][\p{L}]+)*/gu) || [];
  for (const rawTok of tokens) {
    const tok = rawTok.replace(/['’]s$/i, '').trim();
    if (!tok || tok.length < 2) continue;
    const key = tok.toLowerCase();
    if (seen.has(key) || settled.has(key) || stop.has(key)) continue;
    seen.add(key);
    const res = resolvePerson(tok, roster);
    if (res.kind === 'none') continue;
    const cands = res.kind === 'user' ? [res.user] : res.candidates;
    if (!cands.length) continue;
    if (res.kind === 'user' && norm(tok) === norm(res.user.fullName)) continue;
    items.push({
      kind: 'name',
      fragment: tok,
      field: 'person',
      label: 'the person',
      candidates: cands.map((u) => ({ id: u.id, name: u.fullName })),
    });
    if (items.length >= 4) break;
  }
  return items;
}

/**
 * Structured shift-choice items for a planner-composed question
 * (Deepika, 2026-11-11 — the one-email fix): the options are
 * recomputed DETERMINISTICALLY from schedule data — never parsed
 * out of the question's prose. For each requested date: the holders
 * of each requested shift type that day, plus the shifts the
 * question's named people hold that day (any type). An item is
 * returned only when a date offers a real choice (≥2 options).
 * Shift-type names are taken from the change fields AND from the
 * request text itself (a planner-composed holder question may
 * carry no changes at all).
 */
export async function deriveShiftChoiceItems(
  query: QueryFn, companyId: string,
  opts: { dates: string[]; shiftTypeNames: string[]; fragments: string[]; text?: string }
): Promise<ShiftChoiceItem[]> {
  const dates = [...new Set((opts.dates || []).filter(Boolean))].sort();
  if (!dates.length) return [];
  const roster = await loadGateRoster(query, companyId);
  const { rows: strows } = await query(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  const typeByName = new Map(strows.map((r: any) => [norm(r.name), { id: r.id, name: r.name }]));
  const types = new Map<string, { id: string; name: string }>();
  const addType = (n: string) => {
    const t = typeByName.get(norm(n));
    if (t) types.set(t.id, t);
  };
  for (const n of opts.shiftTypeNames || []) addType(n);
  const lowerText = String(opts.text || '').toLowerCase();
  if (lowerText) for (const r of strows) {
    if (lowerText.includes(String(r.name || '').toLowerCase())) addType(String(r.name));
  }
  if (!types.size) return [];
  const shiftDay = (ds: string, n: number) => {
    const d = new Date(ds + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const entries = await getShiftsForRange(query, companyId, shiftDay(dates[0], -2), shiftDay(dates[dates.length - 1], 2));
  const items: ShiftChoiceItem[] = [];
  for (const date of dates) {
    const seen = new Set<string>();
    const options: ShiftChoiceOption[] = [];
    const push = (e: any) => {
      if (!e.userId || !e.shiftTypeId) return;
      const k = `${e.userId}|${e.shiftTypeId}|${date}`;
      if (seen.has(k)) return;
      seen.add(k);
      const u = roster.find((r) => r.id === e.userId);
      options.push({
        holderId: e.userId,
        holderName: u ? u.fullName : (e.personName || ''),
        shiftTypeId: e.shiftTypeId,
        shiftTypeName: e.shiftTypeName,
        date,
      });
    };
    // Holders of each requested type that day…
    for (const e of entries) if (e.date === date && types.has(e.shiftTypeId!)) push(e);
    // …plus the shifts the question's named people hold that day.
    for (const f of opts.fragments || []) {
      const res = resolvePerson(f, roster);
      const cands = res.kind === 'user' ? [res.user] : res.kind === 'ambiguous' ? res.candidates : [];
      for (const c of cands) {
        for (const e of entries) if (e.date === date && e.userId === c.id) push(e);
      }
    }
    if (options.length >= 2) {
      items.push({ kind: 'shift', label: `Which shift is being given up on ${date}?`, date, options: options.slice(0, 4) });
    }
  }
  return items;
}

export interface HolderMismatch {
  question: string;
  items: ShiftChoiceItem[];
}

/**
 * Holder-mismatch check for the no-changes path (Deepika, 2026-11-11
 * — "if dates was the issue it would have been nice it tells us
 * thats the problem"): the planner declined to emit a change, but
 * the request names specific people. When a named person holds
 * NOTHING of the requested type on a requested date, the dates are
 * the problem — say so in the gate's own words instead of asking
 * which shift is being given up from a list that excludes them.
 * Returns the FIRST mismatch in request order (person order, then
 * date order), mirroring the gate's one-problem-at-a-time rule.
 * Only fires when the holder is genuinely checkable: the name item
 * resolved to exactly one roster person — pass those people in.
 * Ambiguous or unknown fragments are the caller's problem to
 * exclude; anything else returns null and the caller keeps the
 * current behavior. The question is one sentence — the merge keeps
 * only the first sentence of a holder-mismatch question as context.
 */
export async function deriveHolderMismatch(
  query: QueryFn, companyId: string,
  opts: { dates: string[]; shiftTypeNames: string[]; people: { id: string; name: string }[]; text?: string }
): Promise<HolderMismatch | null> {
  const dates = [...new Set((opts.dates || []).filter(Boolean))].sort();
  const people = (opts.people || []).filter((p) => p && p.id && p.name);
  if (!dates.length || !people.length) return null;
  // Move/swap only: the mismatch means "someone must give this shift
  // up". For an assign the named person is the TAKER — not holding
  // the shift yet is expected, not a problem — so a request that
  // only assigns never fires this, however its names read.
  const MOVE_SWAP = /\b(swap|swapping|move|moving|moves|switch|switching|exchange|exchanging|trade|trading)\b|\btake\s+over\b|\btaking\s+over\b|\btake\s+it\s+from\b|\btaking\s+it\s+from\b|\bgive\s+up\b|\bgiving\s+up\b|\bcover\s+for\b|\binstead\b/i;
  if (!MOVE_SWAP.test(String(opts.text || ''))) return null;
  const roster = await loadGateRoster(query, companyId);
  const { rows: strows } = await query(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  const typeByName = new Map(strows.map((r: any) => [norm(r.name), { id: r.id, name: r.name }]));
  const types = new Map<string, { id: string; name: string }>();
  const addType = (n: string) => {
    const t = typeByName.get(norm(n));
    if (t) types.set(t.id, t);
  };
  for (const n of opts.shiftTypeNames || []) addType(n);
  const lowerText = String(opts.text || '').toLowerCase();
  if (lowerText) for (const r of strows) {
    if (lowerText.includes(String(r.name || '').toLowerCase())) addType(String(r.name));
  }
  if (!types.size) return null;
  const shiftDay = (ds: string, n: number) => {
    const d = new Date(ds + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const entries = await getShiftsForRange(query, companyId, shiftDay(dates[0], -2), shiftDay(dates[dates.length - 1], 2));
  const holdersOf = (date: string, typeId: string): string[] =>
    [...new Set(entries.filter((e) => e.date === date && e.shiftTypeId === typeId).map((e) => e.personName))];
  // Shift options for the mismatch date — the gate's own shape: the
  // holders of the requested type that day, plus the shifts the
  // named person actually holds that day (any other type). A real
  // choice needs ≥2 options; with fewer the question stands alone.
  const shiftItemFor = (date: string, typeId: string, personId: string): ShiftChoiceItem[] => {
    const seen = new Set<string>();
    const options: ShiftChoiceOption[] = [];
    const push = (e: any) => {
      if (!e.userId || !e.shiftTypeId || !e.date) return;
      const k = `${e.userId}|${e.shiftTypeId}|${e.date}`;
      if (seen.has(k)) return;
      seen.add(k);
      const u = roster.find((r) => r.id === e.userId);
      options.push({
        holderId: e.userId,
        holderName: u ? u.fullName : (e.personName || ''),
        shiftTypeId: e.shiftTypeId,
        shiftTypeName: e.shiftTypeName,
        date: e.date,
      });
    };
    for (const e of entries) if (e.date === date && e.shiftTypeId === typeId) push(e);
    for (const e of entries) if (e.date === date && e.userId === personId && e.shiftTypeId !== typeId) push(e);
    return options.length >= 2
      ? [{ kind: 'shift', label: `Which shift is being given up on ${date}?`, date, options: options.slice(0, 4) }]
      : [];
  };
  for (const person of people) {
    for (const date of dates) {
      for (const type of types.values()) {
        const mine = entries.filter((e) => e.userId === person.id && e.date === date && e.shiftTypeId === type.id);
        if (mine.length) continue;
        const holders = holdersOf(date, type.id);
        if (holders.length) {
          // Holder-list cap (Deepika, 2026-11-11): the sentence names
          // at most the first 4 holders — the shift-item options
          // already cap at 4, and a 12-name sentence is noise. The
          // full holder set still rides on the shift row.
          const shown = holders.slice(0, 4);
          const holderList = holders.length > 4
            ? `${shown.join(' and ')} and ${holders.length - 4} other${holders.length - 4 === 1 ? '' : 's'}`
            : shown.join(' and ');
          return {
            question: `${person.name} has no ${type.name} on ${date} — ${holderList} ${holders.length === 1 ? 'does' : 'do'}.`,
            items: shiftItemFor(date, type.id, person.id),
          };
        }
        return {
          question: `Nobody is scheduled for ${type.name} on ${date}.`,
          items: [],
        };
      }
    }
  }
  return null;
}

const PERSON_FIELDS: Array<{ actions: string[]; field: string; label: string }> = [
  { actions: ['assign', 'assign_recurring', 'unassign', 'update_team_member', 'add_rotation'], field: 'person', label: 'the person' },
  { actions: ['change_member_role_in_department'], field: 'person', label: 'the person' },
  { actions: ['move', 'swap'], field: 'fromPerson', label: 'the person to move from' },
  { actions: ['move', 'swap'], field: 'toPerson', label: 'the person to move to' },
  { actions: ['add_session', 'update_session'], field: 'presenter', label: 'the presenter' },
  { actions: ['add_session', 'update_session'], field: 'supervisor', label: 'the supervisor' },
];

/**
 * Open-slot inputs for rotation-less types (Deepika, 2026-11-16 —
 * the Day NP plan-gate change): the same three sources the display
 * uses to show open slots (schedule.ts open-slots-message and the
 * draft shortfall) — the staffing target for the weekday, extra open
 * slots, and closed days. Filled counts come from the gate's own
 * `entries` (getShiftsForRange), which for a rotation-less type are
 * exactly its stored shifts — no rotation ever draws it.
 */
interface OpenSlotInputs {
  targets: { shiftTypeId: string; targetCount: number; weekdays: number[] | null; startDate: string | null; endDate: string | null }[];
  extra: Map<string, number>;
  closed: Set<string>;
}

async function loadOpenSlotInputs(
  query: QueryFn, companyId: string, from: string, to: string
): Promise<OpenSlotInputs> {
  const [{ rows: trows }, { rows: erows }, { rows: crows }] = await Promise.all([
    query(
      `SELECT shift_type_id AS "shiftTypeId", target_count AS "targetCount",
              weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
       FROM staffing_targets WHERE company_id = $1`,
      [companyId]
    ),
    query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count
       FROM extra_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    ),
    query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId"
       FROM closed_shifts WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    ),
  ]);
  const extra = new Map<string, number>();
  for (const r of erows) {
    const k = `${r.date}|${r.shiftTypeId}`;
    extra.set(k, (extra.get(k) || 0) + (r.count || 0));
  }
  return {
    targets: trows,
    extra,
    closed: new Set(crows.map((r: any) => `${r.date}|${r.shiftTypeId}`)),
  };
}

/** Capacity (target + extra) for one type+date; 0 when the day is
 * closed for the type or no staffing target covers it. Mirrors the
 * display's first-matching-target rule (weekday, then start/end). */
function openSlotCapacity(inputs: OpenSlotInputs, typeId: string, date: string): number {
  if (inputs.closed.has(`${date}|${typeId}`)) return 0;
  const dt = new Date(date + 'T00:00:00');
  let target = 0;
  for (const tg of inputs.targets) {
    if (tg.shiftTypeId !== typeId) continue;
    const weekdays = tg.weekdays || [0, 1, 2, 3, 4, 5, 6];
    if (!weekdays.includes(dt.getDay())) continue;
    if (tg.startDate && date < tg.startDate) continue;
    if (tg.endDate && date > tg.endDate) continue;
    target = tg.targetCount || 0;
    break;
  }
  return target + (inputs.extra.get(`${date}|${typeId}`) || 0);
}

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

  // The AI can NEVER delete a job role (Deepika, 2026-11-17 — "it
  // can add but cannot delete"): refuse plainly, in both doors,
  // before any other check. This is the deterministic backstop for
  // a planner slip or a stale plan written before the removal — the
  // planner no longer lists the action, and the executor no longer
  // has a branch for it, so this is the third lock.
  if (list.some((c) => c.action === 'delete_job_role')) {
    return { ok: false, question: `I can't delete job roles — the AI can add a job role but never delete one. An admin can delete it in Settings → Job roles.` };
  }

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
              kind: 'name' as const,
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

  // ---- 1b. rotation changes ------------------------------------------
  // add_rotation: the person is resolved exactly by step 1 above.
  // The shift type must exist, the start date must be valid, and the
  // pattern must resolve — anything missing or ambiguous is one
  // clarification, never a guess. No eligibility gate, matching the
  // manual flow (known open gap, flagged 2026-11-14).
  {
    const rotChanges = list.filter((c) => c.action === 'add_rotation');
    if (rotChanges.length) {
      const { rows: strows } = await query(
        'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
        [companyId]
      );
      const typeByName = new Map(strows.map((r: any) => [norm(r.name), { id: r.id, name: r.name }]));
      for (const c of rotChanges) {
        if (!c.person || !String(c.person).trim()) {
          return { ok: false, question: `Who should the rotation be for?` };
        }
        const personName = String(c.person);
        const type = c.shiftType ? typeByName.get(norm(c.shiftType)) || null : null;
        if (!type) {
          return { ok: false, question: c.shiftType
            ? `I couldn't find a shift type called "${c.shiftType}". Which shift type should the rotation be for?`
            : `Which shift type should ${personName}'s rotation be for?` };
        }
        if (!c.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.startDate))
          || Number.isNaN(new Date(String(c.startDate) + 'T00:00:00Z').getTime())) {
          return { ok: false, question: `When should ${personName}'s ${type.name} rotation start?` };
        }
        try {
          resolveRotationPattern(c);
        } catch (err: any) {
          return { ok: false, question: err?.message || `Which days should ${personName} work on the ${type.name} rotation?` };
        }
      }
    }
  }

  // ---- 1c. close open slots -----------------------------------------
  // close_open_slots (Deepika, 2026-11-19 — walkthrough item 1): the
  // shift type must exist (exact name, never a guess), the date or
  // range must be valid, and exactly one close mode must be given
  // (closeCount / keepCount / closeAll). The gate also refuses a
  // plan that would close nothing — no opens on a date, already at
  // or below the keep count, or already closed — with one plain
  // clarification, the same as the N1 refusals above. The executor
  // re-checks at approval time, so a plan that was fine when written
  // but has since become empty still fails honestly instead of
  // silently closing nothing.
  {
    const closeChanges = list.filter((c) => c.action === 'close_open_slots');
    if (closeChanges.length) {
      const { rows: strows } = await query(
        'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
        [companyId]
      );
      const typeByName = new Map(strows.map((r: any) => [norm(r.name), { id: r.id, name: r.name }]));
      const validDate = (d: any) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)
        && !Number.isNaN(new Date(d + 'T00:00:00Z').getTime());
      for (const c of closeChanges) {
        const type = c.shiftType ? typeByName.get(norm(c.shiftType)) || null : null;
        if (!type) {
          return { ok: false, question: c.shiftType
            ? `I couldn't find a shift type called "${c.shiftType}". Which shift type should I close open slots for?`
            : `Which shift type should I close open slots for?` };
        }
        const first = c.date || c.fromDate;
        const last = c.toDate || c.date || c.fromDate;
        if (!first || !validDate(first) || (c.toDate && !validDate(c.toDate)) || (first && last && String(first) > String(last))) {
          return { ok: false, question: `Which date${c.fromDate || c.toDate ? 's' : ''} should I close open ${type.name} slots for?` };
        }
        const modes = [
          c.closeAll === true ? 'all' : null,
          typeof c.keepCount === 'number' ? 'keep' : null,
          typeof c.closeCount === 'number' ? 'count' : null,
        ].filter(Boolean);
        if (modes.length !== 1) {
          return { ok: false, question: `How many open ${type.name} slots should I close ${String(first)}${String(first) !== String(last) ? ` to ${String(last)}` : ''} — one, all of them, or keep a number and close the rest?` };
        }
        const mode = modes[0];
        if (mode === 'count' && !(Number.isInteger(c.closeCount) && c.closeCount >= 1)) {
          return { ok: false, question: `How many open ${type.name} slots should I close? Give a whole number of 1 or more.` };
        }
        if (mode === 'keep' && !(Number.isInteger(c.keepCount) && c.keepCount >= 0)) {
          return { ok: false, question: `How many open ${type.name} slots should I keep? Give a whole number of 0 or more.` };
        }
        // Existence check: is there anything open to close on every
        // touched date? Capacity = target + extra (0 when closed);
        // filled = stored shifts that date/type.
        const touched: string[] = [];
        {
          let cur = String(first);
          while (cur <= String(last) && touched.length < 400) {
            touched.push(cur);
            const dd = new Date(cur + 'T00:00:00Z');
            dd.setUTCDate(dd.getUTCDate() + 1);
            cur = dd.toISOString().slice(0, 10);
          }
        }
        const inputs = await loadOpenSlotInputs(query, companyId, touched[0], touched[touched.length - 1]);
        const { rows: frows } = await query(
          `SELECT date::text AS date, COUNT(*)::int AS n FROM shifts
           WHERE company_id = $1 AND shift_type_id = $2 AND date >= $3 AND date <= $4 GROUP BY date`,
          [companyId, type.id, touched[0], touched[touched.length - 1]]
        );
        const filledByDate = new Map(frows.map((r: any) => [r.date, r.n]));
        const opensOn = (d: string) => {
          const capacity = openSlotCapacity(inputs, type.id, d);
          return { opens: Math.max(0, capacity - (filledByDate.get(d) || 0)), closed: inputs.closed.has(`${d}|${type.id}`), capacity };
        };
        if (mode === 'all') {
          if (touched.every((d) => inputs.closed.has(`${d}|${type.id}`))) {
            return { ok: false, question: `${type.name} is already closed${touched.length > 1 ? ` for ${String(first)} – ${String(last)}` : ` on ${String(first)}`}.` };
          }
        } else {
          const bad = touched.find((d) => {
            const { opens } = opensOn(d);
            return mode === 'count' ? opens <= 0 : opens <= (c.keepCount as number);
          });
          if (bad) {
            const { opens, closed, capacity } = opensOn(bad);
            if (mode === 'count') {
              const why = closed
                ? `that day is closed for ${type.name}`
                : capacity > 0
                  ? `all ${capacity} are already filled`
                  : `no staffing target is set for ${type.name} that day`;
              return { ok: false, question: `There are no open ${type.name} slots on ${bad} — ${why}.` };
            }
            return { ok: false, question: `There are only ${opens} open ${type.name} slot${opens === 1 ? '' : 's'} on ${bad} — already at or below ${c.keepCount} to keep, so there is nothing over ${c.keepCount} to close.` };
          }
        }
      }
    }
  }

  // ---- 1d. per-department role change --------------------------------
  // change_member_role_in_department (Deepika, 2026-11-19 — "Can i
  // change role later?" + "add this to the list of things AI can
  // do"): the person is resolved exactly by step 1 above. The
  // department must exist (exact name, never a guess), the role must
  // exist IN that department (roles are per-department — a role from
  // another department never carries over), and the person must be a
  // member of that department (home or pulled-in — otherwise the
  // answer is to pull them in first). Anything missing or
  // unresolvable is one clarification, never a guess. The executor
  // re-checks at approval time, so a plan that was fine when written
  // but whose membership has since changed still fails honestly.
  {
    const roleChanges = list.filter((c) => c.action === 'change_member_role_in_department');
    if (roleChanges.length) {
      const { rows: drows } = await query(
        'SELECT id, name FROM departments WHERE company_id = $1', [companyId]
      );
      const deptByName = new Map(drows.map((r: any) => [norm(r.name), { id: r.id, name: r.name }]));
      for (const c of roleChanges) {
        const personName = String(c.person || '').trim();
        const dept = c.department ? deptByName.get(norm(c.department)) || null : null;
        if (!dept) {
          return { ok: false, question: c.department
            ? `I couldn't find a department called "${c.department}". Which department should ${personName || 'this person'}'s role change be in?`
            : `Which department should ${personName || 'this person'}'s role change be in?` };
        }
        if (!c.jobRoleName || !String(c.jobRoleName).trim()) {
          return { ok: false, question: `Which job role should ${personName} have in ${dept.name}?` };
        }
        const { rows: rrows } = await query(
          'SELECT id, name FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
          [companyId, dept.id, String(c.jobRoleName).trim()]
        );
        if (!rrows.length) {
          return { ok: false, question: `I couldn't find a job role called "${c.jobRoleName}" in ${dept.name}. Which role in ${dept.name} should ${personName} have?` };
        }
        c.jobRoleName = rrows[0].name; // canonical — the executor matches by name
        const person = resolved.get(c)?.get('person');
        if (!person) continue; // step 1 already refused an unresolvable person
        const { rows: urows } = await query(
          `SELECT u.department_id, EXISTS (
             SELECT 1 FROM user_department_memberships m
             WHERE m.user_id = u.id AND m.company_id = $1 AND m.department_id = $2
           ) AS is_member
           FROM users u WHERE u.id = $3 AND u.company_id = $1`,
          [companyId, dept.id, person.id]
        );
        const isHome = String(urows[0]?.department_id || '') === dept.id;
        if (!isHome && !urows[0]?.is_member) {
          return { ok: false, question: `${personName} is not a team member of ${dept.name} yet — should I pull them into ${dept.name} first, or did you mean a different department?` };
        }
      }
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

  // N1 (background rotations, Deepika 2026-11-13 — per department,
  // 2026-11-14): for a generated shift type the AI sees stored
  // shifts only — an undrafted date has no holder to verify
  // against, so the workability loop below would ask a misleading
  // holder-mismatch question ("X doesn't hold that shift" when
  // nobody has been drafted for it yet). Clarify FIRST: the date is
  // not drafted yet, and the fix is to draft it. Live types skip
  // this — their holders draw from the rotation as always.
  //
  // Rotation-less types are never "not drafted" (Deepika, 2026-11-15
  // display rule, extended to the gate 2026-11-16): no rotation can
  // ever draft them, so the draft-first refusal never fires for
  // them. Assigns onto one still need an open slot (shortfall > 0)
  // on every touched date — a full date refuses with one
  // clarification, same as today. Moves/swaps don't consume a slot,
  // so they skip N1 and the holder checks below govern.
  {
    const generatedTypes = await getGeneratedTypeIds(query, companyId);
    const withRotations = await getTypesWithRotations(query, companyId);
    let openInputs: OpenSlotInputs | null = null;
    for (const c of dated) {
      const type = resolveType(c.shiftType);
      if (!type || !generatedTypes.has(type.id)) continue;
      const touched: string[] = [];
      for (const d of [c.date, c.fromDate, c.toDate, c.startDate]) if (d) touched.push(String(d));
      // A range change touches every date in its span.
      if (c.action === 'assign_recurring' && c.fromDate && c.toDate) {
        let cur = String(c.fromDate);
        while (cur <= String(c.toDate) && touched.length < 400) {
          touched.push(cur);
          const dd = new Date(cur + 'T00:00:00Z');
          dd.setUTCDate(dd.getUTCDate() + 1);
          cur = dd.toISOString().slice(0, 10);
        }
      }
      if (!touched.length) continue;
      touched.sort();
      if (!withRotations.has(type.id)) {
        if (c.action !== 'assign' && c.action !== 'assign_recurring') continue;
        if (!openInputs) openInputs = await loadOpenSlotInputs(query, companyId, dates[0], dates[dates.length - 1]);
        const per = resolved.get(c)!;
        const person = per.get('person');
        const bad = touched.find((d) => {
          // Already on it — the workability loop no-ops, no slot needed.
          if (person && heldBy(person.id, d, type.id).length) return false;
          const filled = new Set(
            entries.filter((e) => e.date === d && e.shiftTypeId === type.id).map((e) => e.userId)
          ).size;
          return openSlotCapacity(openInputs!, type.id, d) - filled <= 0;
        });
        if (bad) {
          const closedDay = openInputs.closed.has(`${bad}|${type.id}`);
          const capacity = openSlotCapacity(openInputs, type.id, bad);
          const why = closedDay
            ? `that day is closed for ${type.name}`
            : capacity > 0
              ? `all ${capacity} are already filled`
              : `no staffing target is set for ${type.name} that day`;
          const next = closedDay
            ? 'Pick a date with an open slot.'
            : 'Pick a date with an open slot, or add an extra open slot for that day first.';
          return { ok: false, question: `There are no open ${type.name} slots on ${bad} — ${why}. ${next}` };
        }
        continue;
      }
      const undrafted = new Set(await getUndraftedDatesForType(
        query, companyId, type.id, touched[0], touched[touched.length - 1]
      ));
      const bad = touched.find((d) => undrafted.has(d));
      if (bad) {
        return { ok: false, question: `I can't plan a change for ${bad} yet — that date hasn't been drafted from the rotations. Draft the schedule for that date first (Bulk Actions → Draft schedule from rotation), then ask again.` };
      }
    }
  }

  // Shift-choice options for a holder mismatch (Deepika, 2026-11-11
  // — the one-email fix): the holders of the requested type that
  // day, plus the shifts the from-person actually holds that day.
  // The options are schedule facts the gate already computed, so
  // the question can be answered by tapping a shift instead of
  // only in prose. A real choice needs ≥2 options.
  const toShiftOption = (e: any): ShiftChoiceOption | null => {
    if (!e.userId || !e.shiftTypeId || !e.date) return null;
    const u = roster.find((r) => r.id === e.userId);
    return {
      holderId: e.userId,
      holderName: u ? u.fullName : (e.personName || ''),
      shiftTypeId: e.shiftTypeId,
      shiftTypeName: e.shiftTypeName,
      date: e.date,
    };
  };
  const shiftOptionsFor = (date: string, typeId: string | null, fromUserId: string): ShiftChoiceOption[] => {
    const seen = new Set<string>();
    const opts: ShiftChoiceOption[] = [];
    const push = (e: any) => {
      const o = toShiftOption(e);
      if (!o) return;
      const k = `${o.holderId}|${o.shiftTypeId}|${o.date}`;
      if (seen.has(k)) return;
      seen.add(k);
      opts.push(o);
    };
    for (const e of entries) if (e.date === date && typeId && e.shiftTypeId === typeId) push(e);
    for (const e of entries) if (e.date === date && e.userId === fromUserId && e.shiftTypeId !== typeId) push(e);
    return opts.slice(0, 4);
  };
  const shiftItemFor = (date: string, typeId: string | null, fromUserId: string): ShiftChoiceItem[] => {
    const opts = shiftOptionsFor(date, typeId, fromUserId);
    return opts.length >= 2
      ? [{ kind: 'shift', label: `Which shift is being given up on ${date}?`, date, options: opts }]
      : [];
  };

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
      if (reason) return { ok: false, question: reason, blockedBy: 'conflict' };
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
              items: shiftItemFor(date, type.id, fromUser.id),
              holderMismatch: true,
            };
          }
          return {
            ok: false,
            question: `Nobody is scheduled for ${type.name} on ${date}, so there is no shift to move. Should I assign ${toUser.fullName} to ${type.name} on ${date} instead?`,
            holderMismatch: true,
          };
        }
        return {
          ok: false,
          question: `${fromUser.fullName} isn't working on ${date}, so there is no shift to move. Who holds the shift you mean?`,
          holderMismatch: true,
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
      if (reason) return { ok: false, question: reason, blockedBy: 'conflict' };
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
              items: shiftItemFor(fromDate, type.id, fromUser.id),
              holderMismatch: true,
            };
          }
          return {
            ok: false,
            question: `Nobody is scheduled for ${type.name} on ${fromDate}, so there is nothing to swap. Did you mean a different date?`,
            holderMismatch: true,
          };
        }
        return {
          ok: false,
          question: `${fromUser.fullName} isn't working on ${fromDate}, so there is no shift to swap. Who holds the shift you mean?`,
          holderMismatch: true,
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
      if (reason) return { ok: false, question: reason, blockedBy: 'conflict' };
    }
  }
  return { ok: true };
}
