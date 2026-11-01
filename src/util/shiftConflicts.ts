// util/shiftConflicts.ts — shared overlap / rest-gap conflict checks
// (Deepika, 2026-11-01: "build it such these overlooks don't happen").
//
// One helper decides whether giving a person a shift is safe against
// everything else they already work — manual rows AND rotation-
// generated instances, via the shared schedule-read logic
// (getShiftsForRange). Two failure kinds:
//   - overlap: the new shift runs at the same time as an existing one;
//   - rest: fewer than 8 hours between the end of one shift and the
//     start of the next, in either direction (e.g. a Night shift ending
//     7 AM and a Day shift starting 7 AM the same morning = 0 hours).
// Overnight shifts (end <= start) roll their end into the next day,
// the same convention payroll uses for hours.
//
// Shift types with no start/end time cannot be checked for rest, so
// they fall back to the conservative rule: any other assignment whose
// occupied date touches the same date is a conflict. (The rest-gap
// check itself is skipped when either side is untimed — there is no
// honest number to compute.)

import { getShiftsForRange } from './shiftRange.js';

type QueryFn = (text: string, params: any[]) => Promise<{ rows: any[] }>;

export const MIN_REST_MINUTES = 8 * 60;

export interface ShiftTuple {
  date: string; // YYYY-MM-DD
  shiftTypeId: string;
  shiftTypeName?: string;
}

export interface TimedShift extends ShiftTuple {
  userId: string;
  shiftTypeName: string;
  /** Minutes after midnight on `date`; endMin is already rolled
   * (+1440) for overnight shifts. Both null when the type is untimed. */
  startMin: number | null;
  endMin: number | null;
  timed: boolean;
}

interface TypeTime { name: string; startMin: number | null; endMin: number | null; timed: boolean }

function parseHM(t: any): number | null {
  if (t === null || t === undefined) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

async function loadShiftTypeTimes(q: QueryFn, companyId: string): Promise<Map<string, TypeTime>> {
  const { rows } = await q(
    'SELECT id, name, start_time, end_time FROM shift_types WHERE company_id = $1',
    [companyId]
  );
  const map = new Map<string, TypeTime>();
  for (const r of rows) {
    const startMin = parseHM(r.start_time);
    const endMin = parseHM(r.end_time);
    map.set(r.id, {
      name: r.name,
      startMin,
      endMin,
      timed: startMin !== null && endMin !== null,
    });
  }
  return map;
}

function toTimed(userId: string, tuple: ShiftTuple, types: Map<string, TypeTime>): TimedShift {
  const tt = types.get(tuple.shiftTypeId);
  const timed = !!tt && tt.timed;
  let startMin: number | null = null;
  let endMin: number | null = null;
  if (timed) {
    startMin = tt!.startMin;
    endMin = tt!.endMin;
    if (endMin! <= startMin!) endMin = endMin! + 1440; // overnight (or 24h)
  }
  return {
    userId,
    date: tuple.date,
    shiftTypeId: tuple.shiftTypeId,
    shiftTypeName: tuple.shiftTypeName || (tt ? tt.name : 'shift'),
    startMin, endMin, timed,
  };
}

/** Shift-type times for a company (id -> name/start/end), for callers
 * that build proposed shifts against a preloaded window. */
export async function getShiftTypeTimes(q: QueryFn, companyId: string): Promise<Map<string, TypeTime>> {
  return loadShiftTypeTimes(q, companyId);
}

/** Build the timed form of a (person, shift type, date) tuple. */
export function makeTimedShift(
  types: Map<string, TypeTime>, userId: string, tuple: ShiftTuple
): TimedShift {
  return toTimed(userId, tuple, types);
}

/** All of a company's visible assignments (manual + rotation) in a
 * window, with shift-type times attached. */
export async function loadTimedShifts(
  q: QueryFn, companyId: string, from: string, to: string
): Promise<TimedShift[]> {
  const types = await loadShiftTypeTimes(q, companyId);
  const all = await getShiftsForRange(q, companyId, from, to);
  const out: TimedShift[] = [];
  for (const s of all) {
    if (!s.userId || !s.shiftTypeId) continue;
    out.push(toTimed(s.userId, { date: s.date, shiftTypeId: s.shiftTypeId, shiftTypeName: s.shiftTypeName }, types));
  }
  return out;
}

// --- date / time formatting for plain-language reasons -------------------

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayNum(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}
function dateOfDayNum(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}
function addDays(dateStr: string, n: number): string {
  return dateOfDayNum(dayNum(dateStr) + n);
}
export function fmtDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${DOW[d.getUTCDay()]}, ${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function fmtClock(minOfDay: number): string {
  const h24 = Math.floor(minOfDay / 60) % 24;
  const mi = minOfDay % 60;
  const ampm = h24 >= 12 ? 'PM' : 'AM';
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(mi).padStart(2, '0')} ${ampm}`;
}
/** "7:00 AM Tue, Nov 3" for an absolute minute (day*1440 + minute). */
function fmtMoment(absMin: number): string {
  const day = Math.floor(absMin / 1440);
  return `${fmtClock(absMin - day * 1440)} ${fmtDay(dateOfDayNum(day))}`;
}
function fmtRange(s: TimedShift): string {
  if (!s.timed) return '';
  return ` (${fmtClock(s.startMin!)}–${fmtClock(s.endMin! % 1440)})`;
}
function fmtHours(min: number): string {
  if (min <= 0) return '0 hours';
  if (min % 60 === 0) return min === 60 ? '1 hour' : `${min / 60} hours`;
  return `${(min / 60).toFixed(1)} hours`;
}

// --- the core check --------------------------------------------------------

function startAbs(s: TimedShift): number {
  return dayNum(s.date) * 1440 + (s.timed ? s.startMin! : 0);
}
function endAbs(s: TimedShift): number {
  return dayNum(s.date) * 1440 + (s.timed ? s.endMin! : 1440);
}
function occupiedDates(s: TimedShift): string[] {
  if (s.timed && s.endMin! > 1440) return [s.date, addDays(s.date, 1)];
  return [s.date];
}

/**
 * Why `proposed` cannot be added to `existing` for this person, or
 * null when it is safe. Deterministic: existing shifts are considered
 * in chronological order and the first conflict wins.
 */
export function findShiftConflict(
  personName: string, existing: TimedShift[], proposed: TimedShift
): string | null {
  const sorted = [...existing].sort((a, b) => startAbs(a) - startAbs(b));
  for (const ex of sorted) {
    if (!ex.timed || !proposed.timed) {
      // Conservative fallback: no honest rest math without times, so
      // a shared occupied date is a conflict.
      const shared = occupiedDates(ex).find((d) => occupiedDates(proposed).includes(d));
      if (shared) {
        return `${personName} is already working ${ex.shiftTypeName} on ${fmtDay(ex.date)} — ` +
          `it clashes with ${proposed.shiftTypeName} on ${fmtDay(proposed.date)} ` +
          `(one of these shift types has no set start/end times, so the day can't be shared safely).`;
      }
      continue;
    }
    const exStart = startAbs(ex), exEnd = endAbs(ex);
    const pStart = startAbs(proposed), pEnd = endAbs(proposed);
    if (exStart < pEnd && pStart < exEnd) {
      return `${personName} is already working ${ex.shiftTypeName} on ${fmtDay(ex.date)}${fmtRange(ex)} — ` +
        `it overlaps ${proposed.shiftTypeName} on ${fmtDay(proposed.date)}${fmtRange(proposed)}.`;
    }
    // Not overlapping: the gap between the two, whichever comes first.
    const first = exEnd <= pStart
      ? { shift: ex, end: exEnd, next: proposed, nextStart: pStart }
      : { shift: proposed, end: pEnd, next: ex, nextStart: exStart };
    const gap = first.nextStart - first.end;
    if (gap < MIN_REST_MINUTES) {
      return `${personName} would get only ${fmtHours(gap)} of rest — ` +
        `${first.shift.shiftTypeName} ends ${fmtMoment(first.end)} and ` +
        `${first.next.shiftTypeName} starts ${fmtMoment(first.nextStart)}. ` +
        `At least 8 hours of rest is needed.`;
    }
  }
  return null;
}

const sameTuple = (a: ShiftTuple, b: ShiftTuple) =>
  a.date === b.date && a.shiftTypeId === b.shiftTypeId;

/**
 * Check ONE proposed shift for one person against everything else
 * they work (optionally ignoring the tuples in `exclude` — e.g. the
 * shift being handed to them is one they already hold under another
 * arrangement). Returns the plain-language reason, or null.
 */
export async function checkShiftConflict(
  q: QueryFn, companyId: string,
  args: {
    userId: string; personName: string;
    proposed: ShiftTuple; exclude?: ShiftTuple[];
  }
): Promise<string | null> {
  const from = addDays(args.proposed.date, -2);
  const to = addDays(args.proposed.date, 2);
  const all = await loadTimedShifts(q, companyId, from, to);
  const types = await loadShiftTypeTimes(q, companyId);
  const proposed = toTimed(args.userId, args.proposed, types);
  const existing = all.filter((s) =>
    s.userId === args.userId &&
    !(args.exclude || []).some((x) => sameTuple(x, s)));
  return findShiftConflict(args.personName, existing, proposed);
}

export interface SwapParty {
  userId: string;
  personName: string;
  /** Shifts this person gives away in the swap. */
  gives: ShiftTuple[];
  /** Shifts this person ends up working after the swap. */
  receives: ShiftTuple[];
}

/**
 * Simulate a swap for BOTH parties: each person's post-swap schedule
 * (their existing assignments minus what they give away, plus what
 * they receive, pair by pair) must be conflict-free. Returns the
 * first plain-language reason, or null when the swap is safe.
 */
export async function checkSwapConflicts(
  q: QueryFn, companyId: string, parties: SwapParty[]
): Promise<string | null> {
  const receiveDates = parties.flatMap((p) => p.receives.map((r) => r.date)).sort();
  if (!receiveDates.length) return null;
  const from = addDays(receiveDates[0], -2);
  const to = addDays(receiveDates[receiveDates.length - 1], 2);
  const all = await loadTimedShifts(q, companyId, from, to);
  const types = await loadShiftTypeTimes(q, companyId);
  for (const party of parties) {
    const existing = all.filter((s) =>
      s.userId === party.userId &&
      !party.gives.some((g) => sameTuple(g, s)));
    const accepted: TimedShift[] = [];
    for (const recv of party.receives) {
      const proposed = toTimed(party.userId, recv, types);
      const reason = findShiftConflict(party.personName, [...existing, ...accepted], proposed);
      if (reason) return reason;
      accepted.push(proposed);
    }
  }
  return null;
}
