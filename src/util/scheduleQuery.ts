// util/scheduleQuery.ts — answer schedule questions from emails.
// Uses shared shiftRange logic (manual + rotation-generated shifts).

import { getShiftsForRange } from './shiftRange.js';

interface Question {
  kind: 'schedule_for_dates' | 'who_is_on' | 'person_schedule' | 'general';
  startDate?: string;
  endDate?: string;
  person?: string;
  shiftType?: string;
}

export async function querySchedule(
  query: (text: string, params: any[]) => Promise<{ rows: any[] }>,
  companyId: string,
  q: Question
): Promise<{ answer: string; found: boolean }> {
  const kind = q.kind || 'general';

  // Determine date range
  let startDate = q.startDate;
  let endDate = q.endDate || q.startDate;
  if (!startDate) {
    const today = new Date().toISOString().split('T')[0];
    startDate = today;
    endDate = today;
  }

  // Get all shifts (manual + rotation) for the range
  let shifts = await getShiftsForRange(query, companyId, startDate!, endDate!);

  // Filter by person if specified
  if (q.person) {
    const needle = q.person.toLowerCase();
    shifts = shifts.filter(s => s.personName.toLowerCase().includes(needle));
  }

  // Filter by shift type if specified
  if (q.shiftType) {
    const needle = q.shiftType.toLowerCase();
    shifts = shifts.filter(s => s.shiftTypeName.toLowerCase().includes(needle));
  }

  if (!shifts.length) {
    const dateStr = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    return {
      answer: `No shifts found for ${dateStr}${q.person ? ` for ${q.person}` : ''}.`,
      found: false,
    };
  }

  // Group by date
  const byDate: Record<string, typeof shifts> = {};
  for (const s of shifts) {
    if (!byDate[s.date]) byDate[s.date] = [];
    byDate[s.date].push(s);
  }

  const lines: string[] = [];
  const sortedDates = Object.keys(byDate).sort();
  const fmtDate = (d: string, short = false) => {
    const dateObj = new Date(d + 'T12:00:00');
    return dateObj.toLocaleDateString('en-US', short
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { weekday: 'long', month: 'short', day: 'numeric' });
  };

  if (kind === 'person_schedule' && sortedDates.length) {
    const personName = byDate[sortedDates[0]][0].personName;
    lines.push(`${personName}'s schedule:`);
    for (const d of sortedDates) {
      const shiftList = byDate[d].map(s => `${s.shiftTypeName}${s.published ? '' : ' (draft)'}`).join(', ');
      lines.push(`  • ${fmtDate(d, true)}: ${shiftList}`);
    }
  } else {
    for (const d of sortedDates) {
      lines.push(`${fmtDate(d)}:`);
      for (const s of byDate[d]) {
        const status = s.published ? '' : ' (draft)';
        lines.push(`  • ${s.personName} — ${s.shiftTypeName}${status}`);
      }
    }
  }

  return { answer: lines.join('\n'), found: true };
}
