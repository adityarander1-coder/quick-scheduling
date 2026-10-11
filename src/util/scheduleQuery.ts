// util/scheduleQuery.ts — answer schedule questions from emails.
// Queries published shifts and formats answers.

interface Question {
  kind: 'schedule_for_dates' | 'who_is_on' | 'person_schedule' | 'general';
  startDate?: string;
  endDate?: string;
  person?: string;
  shiftType?: string;
}

interface ShiftRow {
  date: string;
  person_name: string;
  shift_type: string;
  published: boolean;
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
    // Default to today + 7 days for general questions
    const today = new Date().toISOString().split('T')[0];
    startDate = today;
    endDate = today;
  }

  // Build the query
  let sql = `
    SELECT s.date::text AS date,
           COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS person_name,
           st.name AS shift_type,
           s.published
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    JOIN shift_types st ON st.id = s.shift_type_id
    WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3
  `;
  const params: any[] = [companyId, startDate, endDate];

  // Filter by person if specified
  if (q.person) {
    params.push(`%${q.person}%`);
    sql += ` AND (u.first_name || ' ' || u.last_name ILIKE $${params.length} OR u.nickname ILIKE $${params.length})`;
  }

  // Filter by shift type if specified
  if (q.shiftType) {
    params.push(`%${q.shiftType}%`);
    sql += ` AND st.name ILIKE $${params.length}`;
  }

  sql += ` ORDER BY s.date, st.name, person_name`;

  const { rows } = await query(sql, params) as { rows: ShiftRow[] };

  if (!rows.length) {
    const dateStr = startDate === endDate ? startDate : `${startDate} to ${endDate}`;
    return {
      answer: `No shifts found for ${dateStr}${q.person ? ` for ${q.person}` : ''}.`,
      found: false,
    };
  }

  // Format the answer
  const byDate: Record<string, ShiftRow[]> = {};
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  const lines: string[] = [];
  const sortedDates = Object.keys(byDate).sort();

  if (kind === 'who_is_on' || kind === 'schedule_for_dates') {
    for (const d of sortedDates) {
      const dateObj = new Date(d + 'T12:00:00');
      const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      lines.push(`${dateLabel}:`);
      for (const s of byDate[d]) {
        lines.push(`  • ${s.person_name} — ${s.shift_type}`);
      }
    }
  } else if (kind === 'person_schedule') {
    const personName = byDate[sortedDates[0]][0].person_name;
    lines.push(`${personName}'s schedule:`);
    for (const d of sortedDates) {
      const dateObj = new Date(d + 'T12:00:00');
      const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const shifts = byDate[d].map(s => s.shift_type).join(', ');
      lines.push(`  • ${dateLabel}: ${shifts}`);
    }
  } else {
    // General: list all
    for (const d of sortedDates) {
      const dateObj = new Date(d + 'T12:00:00');
      const dateLabel = dateObj.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      lines.push(`${dateLabel}:`);
      for (const s of byDate[d]) {
        lines.push(`  • ${s.person_name} — ${s.shift_type}`);
      }
    }
  }

  return { answer: lines.join('\n'), found: true };
}
