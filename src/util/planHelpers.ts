// util/planHelpers.ts — pure helpers for the Task planner (no DB imports,
// so they are unit-testable on their own). Used by the in-app Task routes
// and by planExecutor for recurring assignments.

/** Expand a recurring shift pattern into dated assignments.
 *  Occurrence weeks start at startDate and step intervalWeeks * 7 days.
 *  Within each 7-day window, weekendsOff skips Saturday/Sunday.
 *  untilDate is inclusive. Throws when the pattern would create too many
 *  shifts (guard against runaway expansions). */
export function expandRecurring(
  startDate: string,
  intervalWeeks: number,
  weekendsOff: boolean,
  untilDate?: string
): string[] {
  const start = new Date(startDate + 'T00:00:00Z');
  if (isNaN(start.getTime())) throw new Error('Invalid start date for recurring assignment.');
  const step = Math.max(1, Math.floor(intervalWeeks) || 1) * 7;
  const until = untilDate ? new Date(untilDate + 'T00:00:00Z') : null;
  if (until && isNaN(until.getTime())) throw new Error('Invalid end date for recurring assignment.');
  const out: string[] = [];
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  for (let w = new Date(start); ; w.setUTCDate(w.getUTCDate() + step)) {
    if (until && w > until) break;
    for (let i = 0; i < 7; i++) {
      const d = new Date(w);
      d.setUTCDate(w.getUTCDate() + i);
      if (until && d > until) break;
      const dow = d.getUTCDay();
      if (weekendsOff && (dow === 0 || dow === 6)) continue;
      out.push(fmt(d));
      if (out.length > 200) {
        throw new Error('That pattern creates more than 200 shifts — please give a shorter end date.');
      }
    }
    if (!until) break; // no end date: single occurrence week only (caller validates)
    if (w.getTime() + step * 86400000 > until.getTime() + 7 * 86400000 && out.length) {
      // loop guard: next window starts after `until`
      if (new Date(w.getTime() + step * 86400000) > until) break;
    }
  }
  return out;
}

function norm(s: string): string {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Match a typed name against real roster/shift names.
 *  exact: full-name match, or a unique first-name / last-name match.
 *  suggestions: up to 5 names containing the typed text (starts-with first).
 *  none: no resemblance at all. */
export function matchName(
  input: string,
  names: string[]
): { status: 'exact'; name: string } | { status: 'suggestions'; names: string[] } | { status: 'none' } {
  const q = norm(input);
  if (!q) return { status: 'none' };
  const clean = names.map((n) => n.trim()).filter(Boolean);
  const exactFull = clean.find((n) => norm(n) === q);
  if (exactFull) return { status: 'exact', name: exactFull };
  if (!q.includes(' ')) {
    const firsts = clean.filter((n) => norm(n).split(' ')[0] === q);
    if (firsts.length === 1) return { status: 'exact', name: firsts[0] };
    const lasts = clean.filter((n) => {
      const parts = norm(n).split(' ');
      return parts[parts.length - 1] === q;
    });
    if (lasts.length === 1) return { status: 'exact', name: lasts[0] };
    if (firsts.length > 1 || lasts.length > 1) {
      return { status: 'suggestions', names: [...new Set([...firsts, ...lasts])].slice(0, 5) };
    }
  }
  const subs = clean.filter((n) => norm(n).includes(q) || q.includes(norm(n).split(' ')[0]));
  if (subs.length) {
    subs.sort((a, b) => {
      const aStart = norm(a).startsWith(q) ? 0 : 1;
      const bStart = norm(b).startsWith(q) ? 0 : 1;
      return aStart - bStart;
    });
    return { status: 'suggestions', names: subs.slice(0, 5) };
  }
  return { status: 'none' };
}

/** Turn a planner failure into the honest user-facing reason — no more
 *  one generic "I had trouble understanding" line for every cause. */
export function classifyPlanError(message: string): string {
  const m = message || '';
  if (/API key not configured/i.test(m)) {
    return 'The scheduling AI is not connected yet. Ask your admin to add the AI key, then try again.';
  }
  if (/503|429|overloaded|rate limit|service unavailable/i.test(m)) {
    return 'The AI service is busy right now — please try again in a moment.';
  }
  if (/valid JSON/i.test(m)) {
    return "I had trouble reading the AI's answer — please send your task again.";
  }
  return 'I could not turn that into a plan. Try rephrasing it, or break it into smaller steps.';
}
