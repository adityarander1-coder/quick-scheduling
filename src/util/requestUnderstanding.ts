// util/requestUnderstanding.ts — ONE shared understanding layer
// (Deepika, 2026-11-19 — "focus on how to improve understanding /
// we cant keep fixing everytime it makes a mistake").
//
// Every action in the app reads a request through THESE functions,
// never through its own copy: deterministic reading of dates and
// ranges ("nov month" → Nov 1–30), amounts ("1" → close 1),
// shift types, departments, and corrections ("I meant the whole
// month" rebuilds the pending plan). The data window follows the
// request's target range ± 2 weeks (extractRequestRange, used by
// buildScheduleContext). ASK reads through them too (issue M):
// an open-slots question resolves its type and month here, and a
// person's name only ever matches as whole words.
//
// The seam (Deepika, 2026-11-19 — "Gemini is so advanced why are
// we not able to fix the code that it understands better focussed
// to our app"): Gemini knows language but not OUR app, so Gemini
// returns the INTENT in plain terms and this layer resolves exact
// dates, IDs and open counts against the real schedule —
// normalizeClosePlan re-derives a close plan's scope, type and
// amount from the request's own words before the gate ever sees
// it. A fix made here is inherited by the next action; a fix made
// in one action's path is a bug waiting to happen in the next.
//
// Pure functions only — no DB imports, so they are unit-testable
// on their own. Both doors (email + in-app Task) use them.

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+month)?/i;
const MONTH_RE_G = new RegExp(MONTH_RE.source, 'gi');

/** A bare month scope ("nov month", "for November", "the whole nov
 * month"): the WHOLE calendar month — first to last day — nearest
 * occurrence on/after today (a month whose last day is already past
 * rolls to next year, matching the planner's relative-date rule).
 * A month word carrying a day number ("nov 19", "19 nov", "19th of
 * November") is a specific DATE, never the month — it is skipped,
 * so a single-day request is never widened to the whole month
 * (Deepika, 2026-11-19 — issue L: "close all … on nov 19" must
 * stay Nov 19). "may" is also a verb, so it counts as a month only
 * when the phrasing says so ("in May", "for May", "May month") —
 * "May I close…" is a request, not the month of May. */
export function parseMonthScope(text: string, today: string): { fromDate: string; toDate: string; monthLabel: string } | null {
  const src = text || '';
  for (const m of src.matchAll(MONTH_RE_G)) {
    const word = (m[1] || '').toLowerCase();
    const before = src.slice(0, m.index ?? 0);
    const after = src.slice((m.index ?? 0) + m[0].length);
    if (/^\s*[,.]?\s*\d{1,2}(?:st|nd|rd|th)?\b/.test(after)) continue;
    if (/(?:^|\s)\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s*$/.test(before)) continue;
    if (word === 'may'
      && !/(?:\b(?:in|for|whole|the|during|of))\s*$/.test(before)
      && !/^\s*month\b/i.test(after)) continue;
    const mi = MONTH_NAMES.indexOf(word.slice(0, 3));
    if (mi < 0) continue;
    const pad = (n: number) => String(n).padStart(2, '0');
    const monthOf = (y: number) => {
      const lastDay = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();
      return { fromDate: `${y}-${pad(mi + 1)}-01`, toDate: `${y}-${pad(mi + 1)}-${pad(lastDay)}` };
    };
    let y = parseInt(today.slice(0, 4), 10);
    let scope = monthOf(y);
    if (scope.toDate < today) scope = monthOf(y + 1);
    return { ...scope, monthLabel: MONTH_NAMES[mi] };
  }
  return null;
}

/** The whole-month scope containing one ISO date ("2026-11-19" →
 * Nov 1–30). Used when a correction says "the whole month" without
 * naming it: the month is the month of the date in the turn being
 * corrected, not today's month (Deepika, 2026-11-19 — N1: "What
 * about the whole month?" after a Nov 19 close means November). */
export function monthScopeOfDate(dateStr: string): { fromDate: string; toDate: string; monthLabel: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr || '').trim());
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10) - 1;
  if (mi < 0 || mi > 11) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(y, mi + 1, 0)).getUTCDate();
  return { fromDate: `${y}-${pad(mi + 1)}-01`, toDate: `${y}-${pad(mi + 1)}-${pad(lastDay)}`, monthLabel: MONTH_NAMES[mi] };
}

const REQUEST_MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};
const REQUEST_WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Deterministic (no-AI) extraction of the dates a schedule request
 * is about, resolved against `today` (YYYY-MM-DD). Recognises ISO
 * dates, US numeric dates (12/2, 12/02/2026), month-name dates
 * ("dec 2", "December 2nd", "2 Dec"), today/tomorrow, "in N
 * days/weeks", and weekday names (bare/"this" = the coming one,
 * "next" = the following week's — the ±14-day slice around the
 * extracted dates makes the exact weekday convention forgiving).
 * A yearless month/day resolves to its coming occurrence: this
 * year, unless that date is more than 14 days in the past, in
 * which case next year's. Returns sorted unique YYYY-MM-DD dates;
 * an empty array means "no date could be extracted with
 * confidence" and callers fall back to the near window.
 */
export function extractRequestDates(text: string, today: string): string[] {
  const found = new Set<string>();
  const t = ` ${String(text || '').toLowerCase()} `;
  const base = new Date(today + 'T00:00:00Z');
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const mk = (y: number, mo: number, da: number): Date | null => {
    if (mo < 0 || mo > 11 || da < 1 || da > 31) return null;
    const d = new Date(Date.UTC(y, mo, da));
    return d.getUTCFullYear() === y && d.getUTCMonth() === mo && d.getUTCDate() === da ? d : null;
  };
  const yearless = (mo: number, da: number) => {
    let d = mk(base.getUTCFullYear(), mo, da);
    if (!d) return;
    if ((base.getTime() - d.getTime()) / 86400000 > 14) {
      d = mk(base.getUTCFullYear() + 1, mo, da);
      if (!d) return;
    }
    found.add(iso(d));
  };
  for (const m of t.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    const d = mk(+m[1], +m[2] - 1, +m[3]);
    if (d) found.add(iso(d));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      const d = mk(y, +m[1] - 1, +m[2]);
      if (d) found.add(iso(d));
    } else yearless(+m[1] - 1, +m[2]);
  }
  const MON = Object.keys(REQUEST_MONTHS).join('|');
  for (const m of t.matchAll(new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?\\b`, 'g'))) {
    if (m[3]) {
      const d = mk(+m[3], REQUEST_MONTHS[m[1]], +m[2]);
      if (d) found.add(iso(d));
    } else yearless(REQUEST_MONTHS[m[1]], +m[2]);
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MON})\\b`, 'g'))) {
    yearless(REQUEST_MONTHS[m[2]], +m[1]);
  }
  // Same-month day range ("dec 2-10" — Deepika's own phrasing in
  // the Dec 2–10 Task): the month word carries two day numbers,
  // and BOTH dates count. Without this the range collapsed to the
  // first day alone, so "what about other days" had no other days
  // to ask about.
  for (const m of t.matchAll(new RegExp(`\\b(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—]\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) {
    yearless(REQUEST_MONTHS[m[1]], +m[2]);
    yearless(REQUEST_MONTHS[m[1]], +m[3]);
  }
  if (/\btoday\b/.test(t)) found.add(today);
  if (/\btomorrow\b/.test(t)) {
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + 1); found.add(iso(d));
  }
  for (const m of t.matchAll(/\bin\s+(\d{1,3})\s+(day|week)s?\b/g)) {
    const n = +m[1] * (m[2] === 'week' ? 7 : 1);
    if (n > 0 && n <= 366) {
      const d = new Date(base); d.setUTCDate(d.getUTCDate() + n); found.add(iso(d));
    }
  }
  const WD = Object.keys(REQUEST_WEEKDAYS).join('|');
  for (const m of t.matchAll(new RegExp(`\\b(next|this)?\\s*(${WD})\\b`, 'g'))) {
    let delta = (REQUEST_WEEKDAYS[m[2]] - base.getUTCDay() + 7) % 7;
    if (m[1] === 'next') delta += 7;
    const d = new Date(base); d.setUTCDate(d.getUTCDate() + delta); found.add(iso(d));
  }
  return [...found].sort();
}

/**
 * The request's TARGET RANGE (Deepika, 2026-11-19 — "the access
 * should change as per request"): the span the request is about —
 * a bare month ("nov month" → the whole month), a relative month
 * ("this month" / "next month"), a week ("next week" → Mon–Sun),
 * or the earliest..latest of the dates extractRequestDates finds
 * (one date → that day; "dec 7 to dec 8" → the range). A month
 * word carrying a day number ("nov 19") is a date, never the month
 * (parseMonthScope's guard). Returns null when no scope can be
 * read — callers fall back to the near window. Scope only ever
 * selects DATES; the data itself stays this company's schedule.
 */
export function extractRequestRange(text: string, today: string): [string, string] | null {
  const t = ` ${String(text || '').toLowerCase()} `;
  const base = new Date(today + 'T00:00:00Z');
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  let start: string | null = null;
  let end: string | null = null;
  const take = (s: string, e: string) => {
    if (!start || s < start) start = s;
    if (!end || e > end) end = e;
  };
  // Bare month scope (whole calendar month).
  const scope = parseMonthScope(text, today);
  if (scope) take(scope.fromDate, scope.toDate);
  // Relative month ("this month" / "next month" / "last month").
  const relMonth = t.match(/\b(this|next|last)\s+month\b/);
  if (relMonth) {
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth() + (relMonth[1] === 'next' ? 1 : relMonth[1] === 'last' ? -1 : 0);
    take(iso(new Date(Date.UTC(y, m, 1))), iso(new Date(Date.UTC(y, m + 1, 0))));
  }
  // Week scope ("this week" / "next week" / "last week", Mon–Sun).
  const relWeek = t.match(/\b(this|next|last)\s+week\b/);
  if (relWeek) {
    const dow = (base.getUTCDay() + 6) % 7; // Mon=0
    const monday = new Date(base);
    monday.setUTCDate(monday.getUTCDate() - dow + (relWeek[1] === 'next' ? 7 : relWeek[1] === 'last' ? -7 : 0));
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    take(iso(monday), iso(sunday));
  }
  // Explicit dates (one day, or the span of a range).
  const dates = extractRequestDates(text, today);
  if (dates.length) take(dates[0], dates[dates.length - 1]);
  return start && end ? [start, end] : null;
}

const NAME_ESC = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Match a shift type name in free text — the ONE type matcher every
 * door and action uses (Deepika, 2026-11-19 — issue M: "day
 * hospitalists" must be the Day Hospitalist type, never a person).
 * Strict first: the full name with an optional trailing "s" as whole
 * words. Then the name with spaces removed ("dayhospitalists" for a
 * glued typo). Then a distinctive long word from the name
 * ("hospitalist" inside "daybhospitalists" — a stray letter breaks
 * the glued form but not the distinctive word). A distinctive word
 * must start at a word boundary, or be glued to another word of the
 * SAME type name ("day" in "dayb…"), so "night" inside "tonight"
 * never matches Night Hospitalist. Short words ("day", "night")
 * only break ties between types that already matched a distinctive
 * word, so "daybhospitalists" picks Day over Night (both contain
 * "hospitalist") while "hospitalists" alone stays ambiguous. */
export function matchShiftType(text: string, shiftNames: string[]): string | null {
  const hay = (text || '').replace(/\s+/g, ' ').trim();
  if (!hay) return null;
  for (const n of shiftNames) {
    if (new RegExp(`\\b${NAME_ESC(n)}s?\\b`, 'i').test(hay)) return n;
  }
  const nospace = hay.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const n of shiftNames) {
    const nn = n.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (nn && nospace.includes(nn)) return n;
  }
  let best: string | null = null;
  let bestScore = 0;
  for (const n of shiftNames) {
    const words = n.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    let score = 0;
    for (const w of words) {
      const stem = w.replace(/s$/, '');
      if (w.length < 5 || stem.length < 5) continue;
      const m = new RegExp(`${NAME_ESC(stem)}s?`, 'i').exec(hay);
      if (!m) continue;
      const atBoundary = m.index === 0 || /[^a-z0-9]/i.test(hay[m.index - 1]);
      const prefix = hay.slice(0, m.index).match(/[a-z0-9]+$/i)?.[0] || '';
      const gluedToOwnWord = words.some((ow) => ow !== w && ow.length >= 3 && prefix.toLowerCase().includes(ow));
      if (atBoundary || gluedToOwnWord) score += 2;
    }
    if (score >= 2) {
      for (const w of words) {
        if (w.length < 5 && hay.toLowerCase().includes(w)) score += 1;
      }
    }
    if (score > bestScore) { bestScore = score; best = n; }
  }
  return bestScore >= 2 ? best : null;
}

export interface PersonName { firstName: string; lastName: string; nickname?: string | null; }

/** Match a team member by name in free text — the ONE person matcher
 * (Deepika, 2026-11-19 — issue M). Names match as WHOLE words only:
 * "Man" never matches inside "many", "Che" never inside "schedule".
 * Full name and nickname first per member (the order the Ask engine
 * already used), then first name, then last name — member order
 * decides ties, as before. */
export function matchMemberName<T extends PersonName>(text: string, members: T[]): T | null {
  const hay = (text || '').replace(/\s+/g, ' ').trim();
  if (!hay) return null;
  // Best match wins; a tie at the top is ambiguous, never a guess
  // (Deepika, 2026-11-19 — issue M: "Fay Close" in the question
  // must resolve to Fay Close, not to Fay Flag on a first-name
  // match — the old code returned the first member in list order
  // whose ANY name form matched). Full name and nickname are exact
  // identities (3); a bare first name is weaker (2) and never beats
  // another person's full name in the same text. A bare last name
  // is never an exact pick (plan gate rule, Nov 10) and is not
  // tried at all — "Close" in "close the slots" is not a person.
  let best: T | null = null;
  let bestScore = 0;
  let tied = false;
  const word = (n: string) => new RegExp(`\\b${NAME_ESC(n)}\\b`, 'i').test(hay);
  for (const m of members) {
    let score = 0;
    const full = `${m.firstName} ${m.lastName || ''}`.trim();
    if (full.length >= 3 && word(full)) score = Math.max(score, 3);
    if (m.nickname && m.nickname.length >= 3 && word(m.nickname)) score = Math.max(score, 3);
    if (m.firstName && m.firstName.length >= 3 && word(m.firstName)) score = Math.max(score, 2);
    if (score === 0) continue;
    if (score > bestScore) { best = m; bestScore = score; tied = false; }
    else if (score === bestScore) { tied = true; }
  }
  return tied ? null : best;
}

export type YesNoAnswer = 'yes' | 'no';

/** A bare Yes/No reply: "yes", "no", "yeah", "nope", "ok", "not now".
 * Bare words only — a sentence with a task verb is a new task, never
 * an answer. Shared: Gemini still asks yes/no questions ("Would you
 * like me to do that?"), and a bare reply to one must be read HERE,
 * never by the model (Deepika, 2026-11-19 — issue N5: "No" →
 * "I could not understand the task well enough to build a plan."). */
export function parseYesNoAnswer(message: string): YesNoAnswer | null {
  const m = (message || '').trim().toLowerCase().replace(/[.!?]$/, '').trim();
  if (!m) return null;
  if (/^(yes|yeah|yep|yup|sure|ok|okay|please do|do it|go ahead)$/.test(m)) return 'yes';
  if (/^(no|nope|nah|not now|never mind|don'?t|no thanks|no thank you)$/.test(m)) return 'no';
  return null;
}

/** Did this answer ask a yes/no question — the only question a bare
 * Yes/No may answer? Ends with "?" and carries a yes/no verb
 * (would / could / should / shall / do you / want me to). */
export function isYesNoQuestion(answerText: string): boolean {
  const q = (answerText || '').trim();
  if (!/\?\s*$/.test(q)) return false;
  return /\b(would|could|should|shall|do you|want me to|shall i|can i|may i)\b/i.test(q);
}

/** A request for the add-member FORM: "give/show/open me the form"
 * (standalone, or inside an open add-member round), or a bare "the
 * form" inside that round. Shared by both doors (Deepika, 2026-11-19
 * — issue N10: "Give me the form" had no route to the form — it
 * matched neither the add-member trigger nor an add_team_member-only
 * plan, so it fell to the planner and errored). */
export function isFormRequest(message: string, history: Array<{ q: string; a: string }>): boolean {
  const m = (message || '').trim();
  if (/^(?:please\s+)?(?:give|show|open|bring|bring\s+up|display)\s+(?:me\s+)?the\s+form\b/i.test(m)) return true;
  if (/^the\s+form\.?$/i.test(m)) {
    const last = history[history.length - 1];
    if (!last) return false;
    const hay = `${last.q}\n${last.a}`;
    return /add\s+(?:(?:a|an|new)\s+)*team\s+members?\b/i.test(hay)
      || /first and last name/i.test(hay);
  }
  return false;
}

/** A bare name: 1–3 name-shaped words, no task verb, no digits —
 * the prefill for the add-member form when a name was already given
 * in the round. Mirrors the client's qsBareName, so both doors
 * prefill the same way. */
export function parseBareName(message: string): { firstName: string; lastName: string } | null {
  const words = String(message || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return null;
  if (!words.every((w) => /^[A-Za-z][A-Za-z'’\-]*$/.test(w))) return null;
  if (/^(add|close|assign|move|swap|delete|remove|give|show|open|please|can|could|yes|no|the|form)$/i.test(words[0])) return null;
  return { firstName: words[0], lastName: words.slice(1).join(' ') };
}

/** The request's scope in one read — shift type + dates/range +
 * department, resolved against the LIVE lists. Any action can call
 * this instead of growing its own date/type parsing: the type
 * matches with a trailing "s" allowed ("day hospitalists" is Day
 * Hospitalist), the dates come from extractRequestRange. */
export interface RequestScope {
  shiftType?: string;
  department?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
}

export function resolveRequestScope(
  text: string,
  shiftNames: string[],
  deptNames: string[],
  today: string,
): RequestScope {
  const hay = (text || '').replace(/\s+/g, ' ').trim();
  const scope: RequestScope = {};
  const st = matchShiftType(hay, shiftNames);
  if (st) scope.shiftType = st;
  const dp = deptNames.find((n) => new RegExp(`\\b${NAME_ESC(n)}\\b`, 'i').test(hay));
  if (dp) scope.department = dp;
  const range = extractRequestRange(text, today);
  if (range) {
    if (range[0] === range[1]) scope.date = range[0];
    else { scope.fromDate = range[0]; scope.toDate = range[1]; }
  }
  return scope;
}

export type AmountAnswer =
  | { mode: 'count'; closeCount: number }
  | { mode: 'keep'; keepCount: number }
  | { mode: 'all' };

/** A bare amount answer: "1", "2", "all of them", "keep 5", "close 3".
 * Nothing else counts — a sentence with a task verb is a new task.
 * Shared by every action whose clarification asks "how many?":
 * Gemini is non-deterministic on bare numbers ("1" failed Nov 25,
 * "2" worked Nov 20), so the number is read HERE, never by the
 * model. */
export function parseAmountAnswer(message: string): AmountAnswer | null {
  const m = (message || '').trim().toLowerCase().replace(/[.!?]$/, '').trim();
  if (!m) return null;
  const num = m.match(/^(\d{1,3})$/);
  if (num) return { mode: 'count', closeCount: parseInt(num[1], 10) };
  if (/^(all|all of them|close all|close them all|everything|the whole type)$/.test(m)) return { mode: 'all' };
  const keep = m.match(/^(?:keep|leave)\s+(\d{1,3})$/);
  if (keep) return { mode: 'keep', keepCount: parseInt(keep[1], 10) };
  const close = m.match(/^(?:close|shut)\s+(\d{1,3})$/);
  if (close) return { mode: 'count', closeCount: parseInt(close[1], 10) };
  return null;
}

/** Is this question text a close "how many?" question — the only
 * question a bare amount answer may answer? Matches the gate's
 * modes question ("How many open … slots should I close …?"), the
 * short missing-amount question ("How many open slots should I
 * close?") and the missing-amount problem text ("no close amount
 * given"). NOTE: the "open" pattern is `open .*slots` (no space
 * after `.*`) — `open .* slots` never matches "open slots",
 * because the space before `.*` eats the only space. */
export function isCloseHowManyQuestion(questionText: string): boolean {
  const q = (questionText || '').toLowerCase();
  return /how many open .*slots should i (close|keep)/.test(q)
    || /no close amount given/.test(q);
}

/** Is this question text an add "how many?" question — the only
 * question a bare amount answer may answer for an add? Matches
 * the gate's add question ("How many open … slots should I add
 * …?") and the missing-amount question ("no add amount given").
 * Mirror of isCloseHowManyQuestion (Deepika, 2026-11-19 — add
 * open slots: a bare "3" after the gate asks how many to add
 * must rebuild the add, never fall to the planner). */
export function isAddHowManyQuestion(questionText: string): boolean {
  const q = (questionText || '').toLowerCase();
  return /how many open .*slots should i add/.test(q)
    || /no add amount given/.test(q);
}

/** The add-shaped scope correction (Deepika, 2026-11-19 — add
 * open slots): the correction above, where the turn being
 * corrected is an add-open-slots request. Mirror of
 * isScopeCorrection. */
export function isAddScopeCorrection(message: string, history: Array<{ q: string; a: string }>): boolean {
  if (!isTaskCorrection(message, history)) return false;
  const lastTurn = lastTaskTurn(history);
  if (!lastTurn) return false;
  const lastQ = lastTurn.q || '';
  return /\badd\b/i.test(lastQ) && /\bslots?\b/i.test(lastQ);
}

/**
 * The intent seam for adds (Deepika, 2026-11-19 — add open slots):
 * the mirror of normalizeClosePlan. Gemini returns the INTENT in
 * plain terms; this pass resolves exact dates, types and amounts
 * from the REQUEST's own words against the live lists, before the
 * gate ever sees the plan.
 *
 * - Type: a plural ("day hospitalists") is the live type.
 * - Amount, from the request's words — the model's guess never
 *   overrides them: "add 3" is addCount 3.
 * - TOP-UP (Deepika, 2026-11-20 — "make it total 14"): a total
 *   word ("total 14", "make it total 14", "total slots upto 14",
 *   "make it 14") is targetTotal 14, never addCount — and the
 *   "add 2" inside "add 2 open slots to make it 14" is the
 *   DIFFERENCE the system works out, so it must never override
 *   the total. A plain "add 14 open slots" (no total word) stays
 *   addCount 14.
 * - HISTORY ORDERING (Deepika, 2026-11-21 — the mirror of the
 *   close-side fix in 9af328e): the request text is the CURRENT
 *   message + the thread history (finalizeTaskPlan joins them so a
 *   bare-number answer still sees the dates it answers) — so the
 *   amount mode comes from the EARLIEST amount signal in the text,
 *   not from whichever mode is checked first: a previous request's
 *   "make it total 14" sitting in history must never override the
 *   current message's plain "add 3". When the current message
 *   carries no amount at all, the earliest signal is the history's,
 *   and it applies. One carve-out: inside ONE sentence ("add 2
 *   open slots to make it 14") the add number is the difference,
 *   so a total signal in the same sentence as an earlier add signal
 *   still wins — a single-message add with no thread history
 *   behaves exactly as before.
 * - Month scope: an add change sitting inside the named month
 *   without covering it is widened to the whole month ("nov month"
 *   → Nov 1–30, never today).
 * Mutates the plan's changes in place; leaves non-add changes
 * and fully-specified adds untouched.
 */
export function normalizeAddPlan(
  plan: any,
  requestText: string,
  shiftNames: string[],
  today: string,
): void {
  const text = requestText || '';
  const scope = parseMonthScope(text, today);
  // Top-up total, from the request's words: "total slots upto 14",
  // "total 14 slots", "make it total 14", "make it 14", "up to 14
  // total slots". The earliest total signal across the three
  // patterns wins (not whichever pattern is listed first) — the
  // same earliest-across-patterns shape normalizeClosePlan uses.
  const totalPats = [
    /\btotal\s+(?:slots?\s+)?(?:up\s*to|upto|of)?\s*(\d{1,3})\b/i,
    /\bmake\s+it\s+(?:total\s+)?(\d{1,3})\b/i,
    /\bup\s*to\s+(\d{1,3})\s+(?:total\s+)?slots?\b/i,
  ];
  const addPat = /\badd\s+(\d{1,3})\b/i;
  const firstMatch = (re: RegExp): { n: number; idx: number } | null => {
    const m = text.match(re);
    if (!m || m[1] === undefined || m.index === undefined) return null;
    return { n: parseInt(m[1], 10), idx: m.index };
  };
  const totalCands = totalPats.map(firstMatch).filter((x): x is { n: number; idx: number } => !!x);
  const totalM = totalCands.length ? totalCands.reduce((a, b) => (a.idx <= b.idx ? a : b)) : null;
  const addM = firstMatch(addPat);
  // Earliest amount signal wins — except a total signal in the
  // same sentence as an earlier add signal, where the add is the
  // difference and the total wins (the top-up sentence). A sentence
  // ends at '.', '!' , '?' or a line break: the current message
  // and each history turn sit on their own lines, so a history
  // signal can never share a sentence with the current message.
  let mode: 'total' | 'add' | null = null;
  let amount = 0;
  if (totalM && addM) {
    if (totalM.idx < addM.idx) { mode = 'total'; amount = totalM.n; }
    else if (!/[.!?\n]/.test(text.slice(addM.idx, totalM.idx))) { mode = 'total'; amount = totalM.n; }
    else { mode = 'add'; amount = addM.n; }
  } else if (totalM) { mode = 'total'; amount = totalM.n; }
  else if (addM) { mode = 'add'; amount = addM.n; }
  for (const c of plan?.changes || []) {
    if (c?.action !== 'add_open_slots') continue;
    if (c.shiftType) {
      const hit = shiftNames.find((n) => new RegExp(`^${NAME_ESC(n)}s?$`, 'i').test(String(c.shiftType).trim()));
      if (hit) c.shiftType = hit;
    }
    if (mode === 'total') {
      const n = amount;
      if (c.targetTotal !== n) { delete c.addCount; c.targetTotal = n; }
    } else if (mode === 'add') {
      const n = amount;
      if (c.addCount !== n) { delete c.targetTotal; c.addCount = n; }
    }
    if (scope) {
      if (c.fromDate === scope.fromDate && c.toDate === scope.toDate) continue;
      const first = c.date || c.fromDate;
      const last = c.toDate || c.date || c.fromDate;
      if (!first || !last || first < scope.fromDate || last > scope.toDate) continue;
      delete c.date;
      c.fromDate = scope.fromDate;
      c.toDate = scope.toDate;
    }
  }
}

export interface CloseContext {
  shiftType: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  department?: string;
}

/** Resolve the shift type + date(s) (+ department, when named) a
 * close amount answers. The gate's "how many?" question names the
 * type and dates in ISO form; the missing-amount question names
 * neither, so the original task is the fallback ("dec 21", "nov
 * 20–24"). Dates come from the shared range reader, never from a
 * local regex — a bare month ("nov month") resolves to the whole
 * month, a day ("nov 19") stays that day. */
export function resolveCloseContext(
  questionText: string,
  originalTask: string,
  shiftNames: string[],
  deptNames: string[],
  today: string,
): CloseContext | null {
  const normWs = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
  const hay = [normWs(questionText), normWs(originalTask)];
  let shiftType: string | null = null;
  for (const h of hay) {
    const f = matchShiftType(h, shiftNames);
    if (f) { shiftType = f; break; }
  }
  if (!shiftType) return null;
  let department: string | undefined;
  for (const h of hay) {
    const f = deptNames.find((n) => new RegExp(`\\b${NAME_ESC(n)}\\b`, 'i').test(h));
    if (f) { department = f; break; }
  }
  // ISO dates named in the question text win (the gate's question
  // echoes the plan's dates in ISO form).
  const iso = [...hay.join(' ').matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((m) => m[1]);
  if (iso.length === 1) return { shiftType, date: iso[0], department };
  if (iso.length >= 2) return { shiftType, fromDate: iso[0], toDate: iso[1], department };
  const range = extractRequestRange(originalTask, today);
  if (!range) return null;
  if (range[0] === range[1]) return { shiftType, date: range[0], department };
  return { shiftType, fromDate: range[0], toDate: range[1], department };
}

export interface NarrowingScope { shiftType?: string; department?: string; }

/** A narrowing reply to a pending plan: "No only fot day
 * hospitalist", "just day hospitalist", "for Internal Medicine".
 * Shape is narrow on purpose — an optional "no", then only/just/for,
 * then a type or department name, and NOTHING else. A task verb or a
 * date makes it a new task, not a narrowing. Shared: any action's
 * pending plan can be narrowed this way, not just a close. */
export function parseNarrowingReply(
  message: string,
  shiftNames: string[],
  deptNames: string[],
): NarrowingScope | null {
  const m = (message || '').trim();
  if (!/^(no[,.]?\s+)?(only|just|for)\s+/i.test(m)) return null;
  if (/\b(close|assign|add|move|swap|delete|remove|publish|set|change|give|make|create|schedule)\b/i.test(m)) return null;
  if (/\b(20\d{2}-\d{2}-\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(m)) return null;
  const scope: NarrowingScope = {};
  const st = matchShiftType(m, shiftNames);
  if (st) scope.shiftType = st;
  const dp = deptNames.find((n) => new RegExp(`\\b${NAME_ESC(n)}\\b`, 'i').test(m));
  if (dp) scope.department = dp;
  return (scope.shiftType || scope.department) ? scope : null;
}

/** The last turn that gave an instruction (not a question) — a
 * deflection or a question asked in between doesn't erase the task
 * being corrected (Deepika, 2026-11-19 — N3: a correction after a
 * deflection still rebuilds the pending plan, even after a reload).
 * A turn counts as a task when its question doesn't end with '?'
 * and doesn't open with a question word. */
export function lastTaskTurn(history: Array<{ q: string; a: string }>): { q: string; a: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const q = (history[i]?.q || '').trim();
    if (!q) continue;
    if (/\?\s*$/.test(q)) continue;
    if (/^\s*(what|which|how|when|where|who|why|is|are|can|could|do|does|did|am)\b/i.test(q)) continue;
    return history[i];
  }
  return null;
}

/** A follow-up that corrects the instruction just given — "I asked
 * you about the whole nov month", "I meant the whole month", "not
 * just that day" — is a TASK refinement, never a question and never
 * a flip-to-Ask deflection. Shared: any task can be corrected this
 * way. Narrow on purpose: a correction pattern in the message, a
 * history to correct, and the last TASK turn's message a task, not
 * a question — a deflection in between doesn't break the link. */
export function isTaskCorrection(message: string, history: Array<{ q: string; a: string }>): boolean {
  const m = (message || '').trim();
  if (!history.length) return false;
  const correction = /^\s*i asked you about\b/i.test(m)
    || /\b(i meant|not just|not only)\b/i.test(m)
    || /\bwhole (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+month\b/i.test(m)
    || /\bthe whole month\b/i.test(m);
  if (!correction) return false;
  return !!lastTaskTurn(history);
}

/** Expand a bare follow-up question from the thread (Deepika,
 * 2026-11-21 — Task answers questions: "What about other days?!"
 * names nothing, so the Ask engine alone falls back). When the
 * message is a "what about" follow-up and the last task turn names
 * a shift type + date range, the question becomes a standalone
 * open-slots question over the dates the last answer did NOT
 * already cover ("How many open Day Hospitalist slots are there
 * from 2026-12-03 to 2026-12-10?"). ISO dates keep the expansion
 * exact whatever day it runs. The range is the contiguous span
 * from the first uncovered date to the range end — a covered date
 * in the middle still shows in the per-date answer, so nothing is
 * hidden. Returns null when no expansion applies — the caller
 * then asks the engine the raw message, which answers or falls
 * back in its own words. */
export function expandThreadFollowUp(
  message: string,
  history: Array<{ q: string; a: string }>,
  shiftNames: string[],
  today: string,
): string | null {
  const m = (message || '').trim();
  if (!/^\s*what about\b/i.test(m) && !/^\s*and (the )?(other|rest)\b/i.test(m)) return null;
  const lastTask = lastTaskTurn(history);
  if (!lastTask) return null;
  const type = matchShiftType(lastTask.q, shiftNames);
  const range = extractRequestRange(lastTask.q, today);
  if (!type || !range) return null;
  // Dates the last answer already covered — ISO dates it names
  // ("2026-12-02" in the gate's refusal) plus pretty dates
  // ("Dec 2" in a plan summary).
  const covered = new Set<string>();
  const lastA = history[history.length - 1]?.a || '';
  for (const d of lastA.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || []) covered.add(d);
  for (const d of extractRequestDates(lastA, today)) covered.add(d);
  let from = range[0];
  while (from < range[1] && covered.has(from)) {
    const d = new Date(from + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    from = d.toISOString().slice(0, 10);
  }
  if (covered.has(from)) return null; // every date already covered
  return `How many open ${type} slots are there from ${from} to ${range[1]}?`;
}

/** The close-shaped scope correction (Deepika, 2026-11-19 — issue
 * L): the correction above, where the turn being corrected is a
 * close/delete-slots request. */
export function isScopeCorrection(message: string, history: Array<{ q: string; a: string }>): boolean {
  if (!isTaskCorrection(message, history)) return false;
  const lastTurn = lastTaskTurn(history);
  if (!lastTurn) return false;
  const lastQ = lastTurn.q || '';
  return /\b(close|delete)\b/i.test(lastQ) && /\bslots?\b/i.test(lastQ);
}

/**
 * The intent seam for closes (Deepika, 2026-11-19 — issues C, D,
 * L): Gemini returns the INTENT in plain terms; this pass resolves
 * exact dates, types and amounts from the REQUEST's own words
 * against the live lists, before the gate ever sees the plan.
 * Runs in BOTH doors (finalizeTaskPlan + processScheduleEmail).
 *
 * - Type: a plural ("day hospitalists") is the live type.
 * - Amount, from the request's words — the model's guess never
 *   overrides them: "delete all" / "close all" is closeAll, never
 *   keepCount 0; "excess of 13" / "keep 13" is keepCount 13;
 *   "close 5" is closeCount 5; "keep total 14" / "close excess
 *   ... to keep ... to 14" is keepTotal 14 (the TOTAL — filled +
 *   open — stays at 14, close only the excess).
 * - Month scope: a close change sitting inside the named month
 *   without covering it is widened to the whole month ("nov month"
 *   → Nov 1–30, never today). A "keep N" / "in excess of N"
 *   request keeps its mode — "all" there means "all over N".
 * Mutates the plan's changes in place; leaves non-close changes
 * and fully-specified closes untouched.
 */
export function normalizeClosePlan(
  plan: any,
  requestText: string,
  shiftNames: string[],
  today: string,
): void {
  const text = requestText || '';
  const scope = parseMonthScope(text, today);
  const saysAll = /\b(delete|close)\s+all\b/i.test(text) && !/\b(keep|excess|over|above|but)\b/i.test(text);
  // Keep-TOTAL (Deepika, 2026-11-21 — "close excess slots for dec
  // 2-10 to keep day hospitalist slot to 14 per day"): the TOTAL
  // (filled + open) stays at N, close only the excess. The signal
  // is "total" ("keep total 14", "total 14") or "excess ... keep
  // ... to/at N". "excess of 13" (no 'keep ... to/at') stays
  // keepCount 13, and a plain "keep 13" stays keepCount 13.
  //
  // The request text is the CURRENT message + the thread history
  // (finalizeTaskPlan joins them so a bare-number answer still
  // sees the dates it answers) — so the amount mode comes from
  // the EARLIEST amount signal in the text, not from whichever
  // mode is checked first: a previous request's "keep total 13"
  // sitting in history must never override the current message's
  // plain "keep 2". When the current message carries no amount at
  // all, the earliest signal is the history's, and it applies.
  const totalPats = [
    /\bkeep\s+(?:the\s+)?total\s+(?:slots?\s+)?(?:of\s+|at\s+|to\s+)?(\d{1,3})\b/i,
    /\btotal\s+(?:slots?\s+)?(?:up\s*to|upto|of|at|to)?\s*(\d{1,3})\b/i,
    /\bexcess\b[^.\n]*?\bkeep\b[^.\n]*?\b(?:to|at)\s+(\d{1,3})\b/i,
  ];
  const keepPat = /\b(?:excess of|keep|leave)\s+(\d{1,3})\b/i;
  const closePat = /\bclose\s+(\d{1,3})\b/i;
  const firstMatch = (re: RegExp): { n: number; idx: number } | null => {
    const m = text.match(re);
    if (!m || m[1] === undefined) return null;
    return { n: parseInt(m[1], 10), idx: text.indexOf(m[0]) };
  };
  const totalCands = totalPats.map(firstMatch).filter((x): x is { n: number; idx: number } => !!x);
  const totalM = totalCands.length ? totalCands.reduce((a, b) => (a.idx <= b.idx ? a : b)) : null;
  const keepM = firstMatch(keepPat);
  const closeM = firstMatch(closePat);
  // Earliest amount signal wins; ties keep the old priority
  // (total, then keep, then close).
  const modeOrder: Array<{ mode: 'total' | 'keep' | 'close'; n: number; idx: number } | null> = [
    totalM ? { mode: 'total', ...totalM } : null,
    keepM ? { mode: 'keep', ...keepM } : null,
    closeM ? { mode: 'close', ...closeM } : null,
  ];
  const earliest = modeOrder.filter((x): x is { mode: 'total' | 'keep' | 'close'; n: number; idx: number } => !!x)
    .sort((a, b) => a.idx - b.idx || (a.mode === 'total' ? 0 : a.mode === 'keep' ? 1 : 2) - (b.mode === 'total' ? 0 : b.mode === 'keep' ? 1 : 2))[0] || null;
  for (const c of plan?.changes || []) {
    if (c?.action !== 'close_open_slots') continue;
    if (c.shiftType) {
      const hit = shiftNames.find((n) => new RegExp(`^${NAME_ESC(n)}s?$`, 'i').test(String(c.shiftType).trim()));
      if (hit) c.shiftType = hit;
    }
    if (saysAll) {
      if (c.keepCount !== undefined || c.closeCount !== undefined || !c.closeAll) {
        delete c.keepCount; delete c.closeCount; c.closeAll = true;
      }
    } else if (earliest?.mode === 'total') {
      const n = earliest.n;
      if (c.keepTotal !== n) { delete c.closeAll; delete c.closeCount; delete c.keepCount; c.keepTotal = n; }
    } else if (earliest?.mode === 'keep') {
      const n = earliest.n;
      if (c.keepCount !== n) { delete c.closeAll; delete c.closeCount; c.keepCount = n; }
    } else if (earliest?.mode === 'close') {
      const n = earliest.n;
      if (c.closeCount !== n) { delete c.closeAll; delete c.keepCount; c.closeCount = n; }
    }
    if (scope) {
      if (c.fromDate === scope.fromDate && c.toDate === scope.toDate) continue;
      const first = c.date || c.fromDate;
      const last = c.toDate || c.date || c.fromDate;
      if (!first || !last || first < scope.fromDate || last > scope.toDate) continue;
      delete c.date;
      c.fromDate = scope.fromDate;
      c.toDate = scope.toDate;
      if (saysAll) { delete c.keepCount; delete c.closeCount; c.closeAll = true; }
    }
  }
}
