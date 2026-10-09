// util/payrollScheduler.ts — checks for due automatic payroll report schedules
// and emails them. Runs on server startup and every 30 minutes via setInterval.
// Note: on free-tier hosting the server may sleep; schedules are also checked
// opportunistically so a due report still goes out when the server wakes.
import { query } from '../db.js';
import { sendMail } from './mailer.js';

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function runDueSchedules(): Promise<void> {
  try {
    // Atomically claim due schedules by pushing next_run_at far out,
    // so concurrent checks don't double-send. Real next run is set after sending.
    const { rows } = await query(
      `UPDATE payroll_schedules
       SET next_run_at = now() + interval '1 hour'
       WHERE id IN (
         SELECT id FROM payroll_schedules WHERE next_run_at <= now() ORDER BY next_run_at LIMIT 5
       ) RETURNING *`
    );
    for (const s of rows) {
      try {
        await sendScheduledReport(s);
        // Compute next run.
        const now = new Date();
        let next = new Date(now);
        if (s.frequency === 'weekly') {
          next.setDate(now.getDate() + 7);
        } else {
          next.setMonth(next.getMonth() + 1);
        }
        next.setHours(6, 0, 0, 0);
        await query(
          'UPDATE payroll_schedules SET last_sent_at = now(), next_run_at = $2 WHERE id = $1',
          [s.id, next.toISOString()]
        );
        console.log(`[payroll] sent scheduled report ${s.id} to ${s.email}`);
      } catch (err) {
        console.error(`[payroll] scheduled report ${s.id} failed:`, err);
        // Push next run out by a day so a failing schedule doesn't spam retries.
        await query(
          "UPDATE payroll_schedules SET next_run_at = now() + interval '1 day' WHERE id = $1",
          [s.id]
        );
      }
    }
  } catch (err) {
    console.error('[payroll] scheduler check failed:', err);
  }
}

async function sendScheduledReport(s: any): Promise<void> {
  const rangeDays = Math.min(62, Math.max(1, s.range_days || 7));
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - (rangeDays - 1));
  const fromStr = fmtDate(from);
  const toStr = fmtDate(to);

  // Reuse the shared payroll data logic via a direct query (same as getPayrollData).
  const params: any[] = [s.company_id, fromStr, toStr];
  let personFilter = '';
  if (s.person_id) {
    params.push(s.person_id);
    personFilter = ` AND u.id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT u.first_name AS "firstName", u.last_name AS "lastName", u.nickname,
            s.date::text AS date, st.name AS "shiftTypeName",
            st.start_time::text AS "startTime", st.end_time::text AS "endTime"
     FROM shifts s
     JOIN users u ON u.id = s.user_id
     JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3${personFilter}
     ORDER BY s.date, u.first_name, u.last_name`,
    params
  );
  function hoursFor(start: string | null, end: string | null): number {
    if (!start || !end) return 0;
    const [sh, sm] = start!.split(':').map(Number);
    const [eh, em] = end!.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;
    return Math.round((mins / 60) * 100) / 100;
  }
  const byPerson = new Map<string, { name: string; shifts: number; hours: number }>();
  for (const r of rows) {
    const name = r.nickname || `${r.firstName} ${r.lastName || ''}`.trim();
    const h = hoursFor(r.startTime, r.endTime);
    const cur = byPerson.get(name) || { name, shifts: 0, hours: 0 };
    cur.shifts += 1;
    cur.hours = Math.round((cur.hours + h) * 100) / 100;
    byPerson.set(name, cur);
  }
  const people = [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  const totalHours = Math.round(people.reduce((x, p) => x + p.hours, 0) * 100) / 100;
  const { rows: crows } = await query('SELECT name FROM companies WHERE id = $1', [s.company_id]);
  const companyName = crows[0]?.name || 'Company';

  const lines = [`Payroll hours — ${fromStr} to ${toStr}`, ''];
  for (const p of people) {
    lines.push(`${p.name}: ${p.shifts} shift${p.shifts === 1 ? '' : 's'}, ${p.hours} hrs`);
  }
  lines.push('');
  lines.push(`Total: ${totalHours} hrs`);
  const text = lines.join('\n');

  await sendMail({
    to: s.email,
    subject: `Payroll hours ${fromStr} to ${toStr} — ${companyName}`,
    text,
    html: `<pre>${text.replace(/</g, '&lt;')}</pre>`,
  });
}

export function startPayrollScheduler(): void {
  // Run once at startup (delayed so DB is ready), then every 30 minutes.
  setTimeout(() => { runDueSchedules(); }, 60_000);
  setInterval(() => { runDueSchedules(); }, 30 * 60_000);
}
