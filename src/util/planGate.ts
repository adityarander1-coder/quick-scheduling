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
  kind: 'name';
  fragment: string;
  field: string;
  label: string;
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
