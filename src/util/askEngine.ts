// util/askEngine.ts — rule-based natural language Q&A over the schedule.
// Handles: who's on/working [when] [shift], staffing gaps, person schedules,
// shift counts. All data comes from live schedule tables.

import { query } from '../db.js';

interface ShiftType { id: string; name: string; }
interface Member { id: string; name: string; firstName: string; lastName: string; nickname: string | null; }

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function fmtDate(d: Date): string {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function prettyDate(ds: string): string {
  const dt = new Date(ds + 'T00:00:00');
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getDay()]} ${months[dt.getMonth()]} ${dt.getDate()}`;
}

/** Parse a date reference from the question. Returns YYYY-MM-DD or null. */
function parseDate(q: string, today: Date): string | null {
  const lower = q.toLowerCase();
  // today / tomorrow / yesterday
  if (/\btoday\b/.test(lower)) return fmtDate(today);
  if (/\btomorrow\b/.test(lower)) { const d = new Date(today); d.setDate(d.getDate() + 1); return fmtDate(d); }
  if (/\byesterday\b/.test(lower)) { const d = new Date(today); d.setDate(d.getDate() - 1); return fmtDate(d); }
  // "next Monday" / "this Friday" / bare "Friday"
  const dayMatch = lower.match(/\b(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (dayMatch) {
    const target = DAY_NAMES.indexOf(dayMatch[2]);
    const d = new Date(today);
    let diff = (target - d.getDay() + 7) % 7;
    if (dayMatch[1] === 'next') diff = diff === 0 ? 7 : diff + 7;
    else if (diff === 0) diff = 0; // today if it's that day
    d.setDate(d.getDate() + diff);
    return fmtDate(d);
  }
  // "Oct 15" / "October 15"
  const mdMatch = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})\b/);
  if (mdMatch) {
    const m = MONTHS[mdMatch[1]];
    const day = parseInt(mdMatch[2], 10);
    let year = today.getFullYear();
    const d = new Date(year, m, day);
    if (d < today && (today.getTime() - d.getTime()) > 30 * 24 * 3600 * 1000) year += 1; // likely next year
    return fmtDate(new Date(year, m, day));
  }
  // "2026-10-15"
  const isoMatch = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];
  return null;
}

/** Parse a week range: "this week" / "next week". Returns {from, to} or null. */
function parseWeek(q: string, today: Date): { from: string; to: string } | null {
  const lower = q.toLowerCase();
  const isNext = /\bnext week\b/.test(lower);
  const isThis = /\bthis week\b/.test(lower);
  if (!isNext && !isThis) return null;
  const d = new Date(today);
  // Week starts Monday.
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow + (isNext ? 7 : 0));
  const from = fmtDate(d);
  d.setDate(d.getDate() + 6);
  return { from, to: fmtDate(d) };
}

export interface AskContext {
  companyId: string;
  shiftTypes: ShiftType[];
  members: Member[];
}

/** Find shift types matching words in the question. */
function matchShiftTypes(q: string, shiftTypes: ShiftType[]): ShiftType[] {
  const lower = q.toLowerCase();
  const matched: ShiftType[] = [];
  // Direct name match.
  for (const st of shiftTypes) {
    if (lower.includes(st.name.toLowerCase())) { matched.push(st); continue; }
    // Keyword heuristics.
    const n = st.name.toLowerCase();
    if (/\bnight\b/.test(lower) && n.includes('night')) matched.push(st);
    else if (/\bday\b/.test(lower) && !/\btoday\b/.test(lower) && n.includes('day') && !n.includes('night')) matched.push(st);
    else if (/\bswing\b/.test(lower) && n.includes('swing')) matched.push(st);
    else if (/\bevening\b/.test(lower) && (n.includes('swing') || n.includes('evening'))) matched.push(st);
  }
  return [...new Map(matched.map(s => [s.id, s])).values()];
}

/** Find a team member by name in the question (fuzzy). */
function matchMember(q: string, members: Member[]): Member | null {
  const lower = q.toLowerCase();
  // Try full name, nickname, first name, last name.
  for (const m of members) {
    const names = [
      m.nickname?.toLowerCase(),
      `${m.firstName} ${m.lastName}`.toLowerCase().trim(),
      m.firstName.toLowerCase(),
      m.lastName.toLowerCase(),
    ].filter(Boolean) as string[];
    for (const n of names) {
      if (n.length >= 3 && lower.includes(n)) return m;
    }
  }
  return null;
}

function memberDisplay(m: { firstName: string; lastName: string; nickname: string | null }): string {
  return m.nickname || `${m.firstName} ${m.lastName || ''}`.trim();
}

export async function answerQuestion(question: string, ctx: AskContext): Promise<string> {
  const q = question.trim();
  if (!q) return 'Ask me something like "who\'s on Friday night?"';
  const lower = q.toLowerCase();
  const today = new Date();

  // Load needed data lazily per intent.
  const isShort = /\bshort\b|understaffed|gaps?\b/.test(lower);
  const isCount = /\bhow many\b/.test(lower);
  const member = matchMember(q, ctx.members);
  const shiftTypes = matchShiftTypes(q, ctx.shiftTypes);
  const date = parseDate(q, today);
  const week = parseWeek(q, today);

  // --- "Are we short / where are we short" ---
  if (isShort) {
    const from = date || week?.from || fmtDate(today);
    const to = date || week?.to || fmtDate(today);
    // Get staffing targets.
    const { rows: targets } = await query(
      `SELECT st.name, t.target_count FROM staffing_targets t
       JOIN shift_types st ON st.id = t.shift_type_id
       WHERE t.company_id = $1`,
      [ctx.companyId]
    );
    if (!targets.length) {
      return 'No staffing targets are set up yet. Set them in Settings so I can check for gaps.';
    }
    const { rows: shifts } = await query(
      `SELECT s.date::text AS date, st.name AS "shiftTypeName", COUNT(*) AS count
       FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3
       GROUP BY s.date, st.name`,
      [ctx.companyId, from, to]
    );
    const byDateShift = new Map<string, number>();
    for (const s of shifts) byDateShift.set(s.date + '|' + s.shiftTypeName, Number(s.count));
    const gaps: string[] = [];
    const d = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    while (d <= end) {
      const ds = fmtDate(d);
      for (const t of targets) {
        const have = byDateShift.get(ds + '|' + t.name) || 0;
        if (have < t.target_count) {
          gaps.push(`${prettyDate(ds)}: ${t.name} — ${have}/${t.target_count}`);
        }
      }
      d.setDate(d.getDate() + 1);
    }
    if (!gaps.length) return `You're fully staffed ${date ? 'on ' + prettyDate(date) : 'for that period'}.`;
    return `Short spots:\n${gaps.join('\n')}`;
  }

  // --- Person-specific: "what's John's schedule" / "how many shifts does Jane have" ---
  if (member) {
    const from = date || week?.from || fmtDate(today);
    const to = date || week?.to || (() => { const d = new Date(today); d.setDate(d.getDate() + 7); return fmtDate(d); })();
    const { rows: shifts } = await query(
      `SELECT s.date::text AS date, st.name AS "shiftTypeName", s.published
       FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.user_id = $2 AND s.date >= $3 AND s.date <= $4
       ORDER BY s.date`,
      [ctx.companyId, member.id, from, to]
    );
    const name = memberDisplay(member);
    if (!shifts.length) return `${name} has no shifts ${date ? 'on ' + prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`}.`;
    if (isCount) {
      return `${name} has ${shifts.length} shift${shifts.length === 1 ? '' : 's'} ${date ? 'on ' + prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`}.`;
    }
    const lines = shifts.map(s => `${prettyDate(s.date)}: ${s.shiftTypeName}${s.published ? '' : ' (draft)'}`);
    return `${name}'s schedule:\n${lines.join('\n')}`;
  }

  // --- "Who's on / who's working" ---
  if (/\bwho('s| is)\b/.test(lower) || /\bon\b/.test(lower) || /\bworking\b/.test(lower) || /\bschedule\b/.test(lower)) {
    const from = date || week?.from || fmtDate(today);
    const to = date || week?.to || from;
    let shiftFilter = '';
    const params: any[] = [ctx.companyId, from, to];
    if (shiftTypes.length) {
      shiftFilter = ` AND s.shift_type_id = ANY($${params.length + 1})`;
      params.push(shiftTypes.map(s => s.id));
    }
    const { rows: shifts } = await query(
      `SELECT s.date::text AS date, u.first_name AS "firstName", u.last_name AS "lastName",
              u.nickname, st.name AS "shiftTypeName", s.published, s.notes
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3${shiftFilter}
       ORDER BY s.date, st.sort_order, u.first_name`,
      params
    );
    if (!shifts.length) {
      const when = date ? prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`;
      return `Nobody's scheduled ${when}${shiftTypes.length ? ' for ' + shiftTypes.map(s => s.name).join(', ') : ''}.`;
    }
    // Group by date.
    const byDate = new Map<string, typeof shifts>();
    for (const s of shifts) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s);
    }
    const parts: string[] = [];
    for (const [ds, list] of [...byDate.entries()].sort()) {
      const names = list.map(s => {
        const n = s.nickname || `${s.firstName} ${s.lastName || ''}`.trim();
        return `${n} (${s.shiftTypeName})${s.published ? '' : ' [draft]'}`;
      });
      parts.push(`${prettyDate(ds)}: ${names.join(', ')}`);
    }
    if (isCount) {
      const total = shifts.length;
      return `${total} shift${total === 1 ? '' : 's'} scheduled ${date ? 'on ' + prettyDate(date) : `from ${prettyDate(from)} to ${prettyDate(to)}`}.`;
    }
    return parts.join('\n');
  }

  // --- Fallback ---
  return `I can answer things like:\n• "Who's on Friday night?"\n• "Who's working tomorrow?"\n• "Are we short next week?"\n• "What's John's schedule this week?"\n• "How many shifts does Jane have?"`;
}
