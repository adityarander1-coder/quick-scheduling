// routes/schedule.ts — Phase 3: scheduling core.
// Shift types, shifts, per-date publish state, day comments, rotations.
// All endpoints are company-scoped via the server session.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { requireRole } from '../middleware/auth';

const router = Router();

// Default shift types (hospital defaults, seeded per company on first use).
// Colors match the prototype: Day Hospitalist blue, Swing amber, Night dark.
// ---------------------------------------------------------------------------
const DEFAULT_SHIFT_TYPES = [
  { name: 'Day Hospitalist', shortName: 'DH', color: '#f06e5b', textColor: '#ffffff', sortOrder: 1, startTime: '08:00', endTime: '20:00' },
  { name: 'Swing Shift', shortName: 'SW', color: '#d98314', textColor: '#ffffff', sortOrder: 2, startTime: '12:00', endTime: '00:00' },
  { name: 'Night Hospitalist', shortName: 'NH', color: '#2672d8', textColor: '#ffffff', sortOrder: 3, startTime: '20:00', endTime: '08:00' },
  { name: 'Night NP', shortName: 'NNP', color: '#8a5fb0', textColor: '#ffffff', sortOrder: 4, startTime: '20:00', endTime: '08:00' },
  { name: 'Day NP', shortName: 'DNP', color: '#00a88f', textColor: '#ffffff', sortOrder: 5, startTime: '08:00', endTime: '20:00' },
];

/** Ensure the company has shift types; seed defaults if none exist. */
async function ensureShiftTypes(companyId: string) {
  const { rows } = await query(
    'SELECT id FROM shift_types WHERE company_id = $1 LIMIT 1',
    [companyId]
  );
  if (rows.length) return;
  for (const st of DEFAULT_SHIFT_TYPES) {
    await query(
      `INSERT INTO shift_types (id, company_id, name, short_name, color, text_color, sort_order, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [crypto.randomUUID(), companyId, st.name, st.shortName, st.color, st.textColor, st.sortOrder, (st as any).startTime || null, (st as any).endTime || null]
    );
  }
}

function isValidDate(s: any): boolean {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// ---------------------------------------------------------------------------
// Shift types
// ---------------------------------------------------------------------------

// GET /api/schedule/shift-types — list (seeds defaults on first call).
router.get('/shift-types', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await ensureShiftTypes(companyId);
    const { rows } = await query(
      `SELECT st.id, st.name, st.short_name AS "shortName", st.color, st.text_color AS "textColor",
              st.sort_order AS "sortOrder", st.is_active AS "isActive",
              st.start_time AS "startTime", st.end_time AS "endTime",
              st.department_id AS "departmentId", d.name AS "departmentName"
       FROM shift_types st LEFT JOIN departments d ON d.id = st.department_id
       WHERE st.company_id = $1 ORDER BY st.sort_order, st.name`,
      [companyId]
    );
    res.json({ shiftTypes: rows });
  } catch (err) {
    console.error('[schedule] shift-types failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Build a payroll PDF buffer from report data.
async function buildPayrollPdf(opts: {
  companyName: string; from: string; to: string;
  dates: { date: string; entries: { name: string; shift: string; hours: number }[]; totalHours: number }[];
  people: { name: string; shifts: number; hours: number }[];
  totalHours: number;
}): Promise<Buffer> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ margin: 50, size: 'letter' });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function fmtDay(ds: string): string {
    const dt = new Date(ds + 'T00:00:00');
    return `${dayNames[dt.getDay()]}, ${monthNames[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  }
  doc.fontSize(20).text('Payroll Hours', { underline: false });
  doc.fontSize(11).fillColor('#555').text(`${opts.companyName}`);
  doc.text(`${fmtDay(opts.from)} — ${fmtDay(opts.to)}`);
  doc.moveDown();
  doc.fillColor('#000').fontSize(14).text('By date');
  doc.moveDown(0.5);
  for (const d of opts.dates) {
    doc.fontSize(12).fillColor('#000').text(`${fmtDay(d.date)} — ${d.totalHours} hrs`, { underline: true });
    for (const e of d.entries) {
      doc.fontSize(10).fillColor('#333').text(`  ${e.name} — ${e.shift}: ${e.hours} hrs`);
    }
    doc.moveDown(0.5);
  }
  doc.moveDown();
  doc.fontSize(14).fillColor('#000').text('By person');
  doc.moveDown(0.5);
  for (const p of opts.people) {
    doc.fontSize(10).fillColor('#333').text(`${p.name}: ${p.shifts} shift${p.shifts === 1 ? '' : 's'}, ${p.hours} hrs`);
  }
  doc.moveDown();
  doc.fontSize(12).fillColor('#000').font('Helvetica-Bold').text(`Total: ${opts.totalHours} hrs`);
  doc.end();
  return done;
}

// POST /api/schedule/shift-types — create (owner/scheduler).
router.post('/shift-types', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { name, shortName, color, textColor, sortOrder, departmentId } = req.body ?? {};
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'A shift type name is required.' });
      return;
    }
    // Validate department belongs to company (if provided).
    let deptId: string | null = null;
    if (departmentId) {
      const { rows: dept } = await query(
        'SELECT id FROM departments WHERE id = $1 AND company_id = $2',
        [departmentId, companyId]
      );
      if (!dept.length) {
        res.status(400).json({ error: 'Department not found.' });
        return;
      }
      deptId = dept[0].id;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO shift_types (id, company_id, name, short_name, color, text_color, sort_order, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, companyId, String(name).trim(), String(shortName || '').trim(),
       String(color || '#3b82f6'), String(textColor || '#ffffff'), Number(sortOrder) || 0, deptId]
    );
    res.status(201).json({ id });
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'A shift type with that name already exists.' });
      return;
    }
    console.error('[schedule] create shift-type failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

// GET /api/schedule/shifts?from=YYYY-MM-DD&to=YYYY-MM-DD — list in range.
// Includes both manual shifts and rotation-generated shifts.
router.get('/shifts', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isValidDate(from) || !isValidDate(to)) {
      res.status(400).json({ error: 'Valid from and to dates (YYYY-MM-DD) are required.' });
      return;
    }
    const { rows } = await query(
      `SELECT s.id, s.date::text AS date, s.notes, s.published,
              s.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
              u.nickname, s.shift_type_id AS "shiftTypeId",
              st.name AS "shiftTypeName", st.short_name AS "shiftTypeShort",
              st.color AS "shiftTypeColor", st.text_color AS "shiftTypeTextColor",
              false AS "isRotation", NULL AS "rotationId", NULL AS "rotationName"
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3
       ORDER BY s.date, st.sort_order, u.first_name, u.last_name`,
      [companyId, from, to]
    );

    // Generate shifts from active rotations
    const { rows: rotations } = await query(
      `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate"
       FROM rotations WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );

    // Load rotation pause periods (vacations etc.)
    const { rows: pauseRows } = await query(
      `SELECT rotation_id AS "rotationId", start_date::text AS "startDate", end_date::text AS "endDate"
       FROM rotation_pauses
       WHERE company_id = $1 AND end_date >= $2 AND start_date <= $3`,
      [companyId, from, to]
    );
    const pauseMap = new Map<string, Array<{ start: string; end: string }>>();
    for (const p of pauseRows) {
      if (!pauseMap.has(p.rotationId)) pauseMap.set(p.rotationId, []);
      pauseMap.get(p.rotationId)!.push({ start: p.startDate, end: p.endDate });
    }
    const isPaused = (rotationId: string, dateStr: string): boolean => {
      const periods = pauseMap.get(rotationId);
      if (!periods) return false;
      return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
    };

    // Load rotation shift exclusions (deleted rotation instances)
    const { rows: exclRows } = await query(
      `SELECT rotation_id AS "rotationId", user_id AS "userId",
              date::text AS "date", shift_type_id AS "shiftTypeId"
       FROM rotation_shift_exclusions
       WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );
    const exclSet = new Set(exclRows.map((e: any) =>
      `${e.rotationId}|${e.userId}|${e.date}|${e.shiftTypeId}`
    ));

    // Load per-shift publish overrides for rotation shifts
    const { rows: pubRows } = await query(
      `SELECT rotation_id AS "rotationId", user_id AS "userId",
              date::text AS "date", shift_type_id AS "shiftTypeId", published
       FROM rotation_shift_publish
       WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );
    const pubMap = new Map(pubRows.map((p: any) =>
      [`${p.rotationId}|${p.userId}|${p.date}|${p.shiftTypeId}`, p.published]
    ));

    const rotationShifts: any[] = [];
    for (const rot of rotations) {
      const { rows: assignments } = await query(
        `SELECT ra.user_id AS "userId", ra.cycle_day AS "cycleDay",
                ra.shift_type_id AS "shiftTypeId",
                u.first_name AS "firstName", u.last_name AS "lastName", u.nickname,
                u.is_active AS "userActive", u.end_date AS "userEndDate",
                st.name AS "shiftTypeName", st.short_name AS "shiftTypeShort",
                st.color AS "shiftTypeColor", st.text_color AS "shiftTypeTextColor",
                st.sort_order AS "sortOrder"
         FROM rotation_assignments ra
         JOIN users u ON u.id = ra.user_id
         JOIN shift_types st ON st.id = ra.shift_type_id
         WHERE ra.rotation_id = $1 AND u.is_active = true`,
        [rot.id]
      );
      (rot as any).assignments = assignments;

      if (assignments.length === 0) continue;

      // Build map: cycleDay -> assignments
      const byDay = new Map<number, typeof assignments>();
      for (const a of assignments) {
        if (!byDay.has(a.cycleDay)) byDay.set(a.cycleDay, []);
        byDay.get(a.cycleDay)!.push(a);
      }

      const startDate = new Date(rot.startDate + 'T00:00:00');
      const fromDate = new Date(from + 'T00:00:00');
      const toDate = new Date(to + 'T00:00:00');
      const cycleDays = rot.cycleDays;

      // Iterate each date in range
      for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10);
        if (d < startDate) continue;

        const daysSinceStart = Math.floor((d.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const cycleDay = (daysSinceStart % cycleDays) + 1; // 1-indexed

        const dayAssignments = byDay.get(cycleDay);
        if (!dayAssignments) continue;

        for (const a of dayAssignments) {
          // Skip if employee has ended before this date
          if (a.userEndDate && dateStr > String(a.userEndDate).slice(0, 10)) continue;

          // Skip if a manual shift already exists for this user/date/shiftType
          // (manual shifts take precedence)
          const hasManual = rows.some((s: any) =>
            s.userId === a.userId && s.date === dateStr && s.shiftTypeId === a.shiftTypeId
          );
          if (hasManual) continue;

          // Skip if date is within a pause period (vacation etc.)
          if (isPaused(rot.id, dateStr)) continue;

          // Skip if this rotation instance was deleted (exclusion)
          const exclKey = `${rot.id}|${a.userId}|${dateStr}|${a.shiftTypeId}`;
          if (exclSet.has(exclKey)) continue;

          rotationShifts.push({
            id: `rot-${rot.id}-${a.userId}-${dateStr}`,
            date: dateStr,
            notes: null,
            published: pubMap.has(exclKey) ? pubMap.get(exclKey) : true,
            userId: a.userId,
            firstName: a.firstName,
            lastName: a.lastName,
            nickname: a.nickname,
            shiftTypeId: a.shiftTypeId,
            shiftTypeName: a.shiftTypeName,
            shiftTypeShort: a.shiftTypeShort,
            shiftTypeColor: a.shiftTypeColor,
            shiftTypeTextColor: a.shiftTypeTextColor,
            isRotation: true,
            rotationId: rot.id,
            rotationName: rot.name,
            _sortOrder: a.sortOrder,
          });
        }
      }
    }

    // Merge and sort
    // Also hide manual shifts for users whose rotation is paused on that date (vacation)
    const userPauseMap = new Map<string, Array<{ start: string; end: string }>>();
    for (const rot of rotations) {
      const periods = pauseMap.get(rot.id);
      if (!periods || !rot.assignments) continue;
      for (const a of rot.assignments as any[]) {
        if (!userPauseMap.has(a.userId)) userPauseMap.set(a.userId, []);
        userPauseMap.get(a.userId)!.push(...periods);
      }
    }
    const isUserPaused = (userId: string, dateStr: string): boolean => {
      const periods = userPauseMap.get(userId);
      if (!periods) return false;
      return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
    };
    const visibleManual = rows.filter((s: any) => !s.userId || !isUserPaused(s.userId, s.date));

    // Closed shifts (manually marked unavailable)
    const { rows: closedShifts } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId"
       FROM closed_shifts WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );

    // Extra open slots (manually added beyond targets)
    const { rows: extraSlots } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count
       FROM extra_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );

    const all = [...visibleManual, ...rotationShifts];
    all.sort((a: any, b: any) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const soA = a._sortOrder ?? 999;
      const soB = b._sortOrder ?? 999;
      if (soA !== soB) return soA - soB;
      const nA = `${a.firstName} ${a.lastName}`;
      const nB = `${b.firstName} ${b.lastName}`;
      return nA.localeCompare(nB);
    });

    res.json({ shifts: all, closedShifts, extraSlots });
  } catch (err) {
    console.error('[schedule] list shifts failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts — assign a shift (owner/scheduler).
router.post('/shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, date, notes, published } = req.body ?? {};
    if (!userId || !shiftTypeId || !isValidDate(date)) {
      res.status(400).json({ error: 'Team member, shift type, and a valid date are required.' });
      return;
    }
    // Verify member and shift type belong to this company.
    const { rows: urows } = await query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true',
      [userId, companyId]
    );
    if (!urows.length) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    const { rows: trows } = await query(
      'SELECT id FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) {
      res.status(404).json({ error: 'Shift type not found.' });
      return;
    }
    const id = crypto.randomUUID();
    try {
      await query(
        `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, companyId, userId, shiftTypeId, date, notes ? String(notes) : null, published !== false, req.session.userId!]
      );
    } catch (err: any) {
      if (err?.code === '23505') {
        // Tell the user exactly which shift already exists (helps diagnose hidden shifts).
        try {
          const { rows: existing } = await query(
            `SELECT s.date::text AS date, s.published, st.name AS "shiftTypeName",
                    st.is_active AS "shiftTypeActive", u.is_active AS "userActive"
             FROM shifts s
             JOIN shift_types st ON st.id = s.shift_type_id
             JOIN users u ON u.id = s.user_id
             WHERE s.company_id = $1 AND s.user_id = $2 AND s.date = $3 AND s.shift_type_id = $4`,
            [companyId, userId, date, shiftTypeId]
          );
          if (existing.length) {
            const ex = existing[0];
            res.status(409).json({
              error: `That team member already has "${ex.shiftTypeName}" on ${ex.date}` +
                (ex.published === false ? ' (currently in draft)' : '') +
                (ex.shiftTypeActive === false ? ' [shift type is inactive]' : '') +
                (ex.userActive === false ? ' [team member is inactive]' : '') + '.',
            });
            return;
          }
        } catch { /* fall through to generic message */ }
        res.status(409).json({ error: 'That team member already has this shift on that date.' });
        return;
      }
      throw err;
    }
    res.status(201).json({ id });
  } catch (err) {
    console.error('[schedule] assign shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/bulk — assign same shift across a date range (owner/scheduler).
router.post('/shifts/bulk', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, startDate, endDate, notes, published } = req.body ?? {};
    if (!userId || !shiftTypeId || !isValidDate(startDate) || !isValidDate(endDate)) {
      res.status(400).json({ error: 'Team member, shift type, and valid start/end dates are required.' });
      return;
    }
    if (endDate < startDate) {
      res.status(400).json({ error: 'End date must be on or after start date.' });
      return;
    }
    // Verify member and shift type belong to this company.
    const { rows: urows } = await query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true',
      [userId, companyId]
    );
    if (!urows.length) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    const { rows: trows } = await query(
      'SELECT id FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) {
      res.status(404).json({ error: 'Shift type not found.' });
      return;
    }
    // Build date list (cap at 93 days to prevent abuse)
    const dates: string[] = [];
    const d = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (d <= end && dates.length < 93) {
      dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    let created = 0;
    let skipped = 0;
    for (const date of dates) {
      try {
        await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [crypto.randomUUID(), companyId, userId, shiftTypeId, date, notes ? String(notes) : null, published !== false, req.session.userId!]
        );
        created++;
      } catch (err: any) {
        if (err?.code === '23505') { skipped++; continue; } // already has this shift
        throw err;
      }
    }
    res.status(201).json({ created, skipped });
  } catch (err) {
    console.error('[schedule] bulk assign failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/bulk-delete — delete shifts in a date list (owner/scheduler).
// Deletes manual shifts; for rotation shifts, adds skip periods so they don't appear.
router.post('/shifts/bulk-delete', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { dates, userIds } = req.body ?? {};
    if (!Array.isArray(dates) || !dates.length || dates.length > 366) {
      res.status(400).json({ error: 'Provide a list of dates (max 366).' });
      return;
    }
    const valid = dates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (!valid.length) {
      res.status(400).json({ error: 'No valid dates provided.' });
      return;
    }
    const userFilter = Array.isArray(userIds) && userIds.length
      ? 'AND user_id = ANY($3::uuid[])'
      : '';
    const params: any[] = [companyId, valid];
    if (userFilter) params.push(userIds);
    const { rowCount } = await query(
      `DELETE FROM shifts WHERE company_id = $1 AND date = ANY($2::date[]) ${userFilter}`,
      params
    );
    // For rotation shifts: add skip periods covering the range for the affected users' rotations.
    let paused = 0;
    const from = valid.slice().sort()[0];
    const to = valid.slice().sort()[valid.length - 1];
    const rotParams: any[] = [companyId];
    const rotUserFilter = Array.isArray(userIds) && userIds.length
      ? 'AND ra.user_id = ANY($2::uuid[])'
      : '';
    if (rotUserFilter) rotParams.push(userIds);
    const { rows: rots } = await query(
      `SELECT DISTINCT r.id AS rotation_id, ra.user_id
       FROM rotations r
       JOIN rotation_assignments ra ON ra.rotation_id = r.id
       WHERE r.company_id = $1 AND r.is_active = true ${rotUserFilter}`,
      rotParams
    );
    for (const rt of rots) {
      try {
        await query(
          `INSERT INTO rotation_pauses (id, rotation_id, company_id, start_date, end_date, reason)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [crypto.randomUUID(), rt.rotation_id, companyId, from, to, 'Bulk delete']
        );
        paused++;
      } catch { /* skip duplicates */ }
    }
    res.json({ deleted: rowCount || 0, paused });
  } catch (err) {
    console.error('[schedule] bulk delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/shifts/:id — remove a shift (owner/scheduler).
router.delete('/shifts/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query(
      'DELETE FROM shifts WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Shift not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/extra-slots — adjust open slots for dates (owner/scheduler).
// Body: { dates:[...], shiftTypeId, count } — count can be negative to remove slots.
router.post('/extra-slots', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.filter(isValidDate) : [];
    const { shiftTypeId } = req.body ?? {};
    const n = parseInt(req.body?.count, 10) || 0;
    const clamped = Math.max(-20, Math.min(20, n));
    if (!dates.length || !shiftTypeId || !clamped) {
      res.status(400).json({ error: 'Dates, shift type, and a non-zero count are required.' });
      return;
    }
    for (const d of dates) {
      await query(
        `INSERT INTO extra_open_slots (company_id, date, shift_type_id, count, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (company_id, date, shift_type_id)
         DO UPDATE SET count = extra_open_slots.count + EXCLUDED.count`,
        [companyId, d, shiftTypeId, clamped, req.session.userId!]
      );
      // Clean up zeroed-out adjustments.
      await query(
        'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count = 0',
        [companyId, d, shiftTypeId]
      );
    }
    res.json({ ok: true, dates: dates.length });
  } catch (err) {
    console.error('[schedule] adjust slots failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/extra-slots — remove extra open slots (owner/scheduler).
// Body: { dates:[...], shiftTypeId } — removes entirely; or { date, shiftTypeId, count } to reduce.
router.delete('/extra-slots', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.filter(isValidDate) : [];
    const { shiftTypeId } = req.body ?? {};
    if (!dates.length || !shiftTypeId) {
      res.status(400).json({ error: 'Dates and shift type are required.' });
      return;
    }
    await query(
      'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = ANY($2::date[]) AND shift_type_id = $3',
      [companyId, dates, shiftTypeId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] remove extra slots failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/closed-shifts — mark a shift type unavailable for a date (owner/scheduler).
router.post('/closed-shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { date, shiftTypeId } = req.body ?? {};
    if (!isValidDate(date) || !shiftTypeId) {
      res.status(400).json({ error: 'Date and shift type are required.' });
      return;
    }
    await query(
      `INSERT INTO closed_shifts (company_id, date, shift_type_id, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT (company_id, date, shift_type_id) DO NOTHING`,
      [companyId, date, shiftTypeId, req.session.userId!]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] close shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/closed-shifts — reopen a shift type for a date (owner/scheduler).
router.delete('/closed-shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { date, shiftTypeId } = req.body ?? {};
    if (!isValidDate(date) || !shiftTypeId) {
      res.status(400).json({ error: 'Date and shift type are required.' });
      return;
    }
    await query(
      'DELETE FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
      [companyId, date, shiftTypeId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] reopen shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/:id/apply-range — apply shift changes across a date range (owner/scheduler).
// Body: { userId, shiftTypeId, notes, published, dates:[...] }.
// For the original shift's date: updates it. For other dates: creates or updates that person's shift.
router.post('/shifts/:id/apply-range', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, notes, published, dates } = req.body ?? {};
    const dateList = Array.isArray(dates) ? dates.filter(isValidDate) : [];
    if (!dateList.length || !userId || !shiftTypeId) {
      res.status(400).json({ error: 'Dates, team member, and shift type are required.' });
      return;
    }
    // Get the original shift to know its date.
    const { rows: orig } = await query(
      'SELECT date::text AS date FROM shifts WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!orig.length) { res.status(404).json({ error: 'Shift not found.' }); return; }
    const origDate = orig[0].date;
    let updated = 0, created = 0;
    for (const d of dateList) {
      if (d === origDate) {
        // Update the original shift.
        const { rowCount } = await query(
          `UPDATE shifts SET user_id = $1, shift_type_id = $2, notes = $3,
            published = COALESCE($4, published), updated_at = now()
           WHERE id = $5 AND company_id = $6`,
          [userId, shiftTypeId, notes || null, published, req.params.id, companyId]
        );
        updated += rowCount || 0;
      } else {
        // Upsert for other dates: update if this person already has this shift type that day, else create.
        const { rows: existing } = await query(
          `SELECT id FROM shifts WHERE company_id = $1 AND date = $2 AND user_id = $3 AND shift_type_id = $4 LIMIT 1`,
          [companyId, d, userId, shiftTypeId]
        );
        if (existing.length) {
          await query(
            `UPDATE shifts SET notes = $1, published = COALESCE($2, published), updated_at = now()
             WHERE id = $3 AND company_id = $4`,
            [notes || null, published, existing[0].id, companyId]
          );
          updated++;
        } else {
          await query(
            `INSERT INTO shifts (company_id, date, user_id, shift_type_id, notes, published, created_by)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6, true), $7)`,
            [companyId, d, userId, shiftTypeId, notes || null, published, req.session.userId!]
          );
          created++;
        }
      }
    }
    res.json({ ok: true, updated, created });
  } catch (err) {
    console.error('[schedule] apply-range failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/shifts/:id — update one manual shift (owner/scheduler).
router.put('/shifts/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, date, notes, published } = req.body ?? {};
    if (!isValidDate(date) || !userId || !shiftTypeId) {
      res.status(400).json({ error: 'Date, team member, and shift type are required.' });
      return;
    }
    // Prevent duplicates.
    const { rows: dup } = await query(
      `SELECT id FROM shifts WHERE company_id = $1 AND date = $2 AND user_id = $3 AND shift_type_id = $4 AND id <> $5 LIMIT 1`,
      [companyId, date, userId, shiftTypeId, req.params.id]
    );
    if (dup.length) {
      res.status(409).json({ error: 'This person already has this shift on that date.' });
      return;
    }
    const { rowCount } = await query(
      `UPDATE shifts SET user_id = $1, shift_type_id = $2, date = $3, notes = $4,
        published = COALESCE($5, published), updated_at = now()
       WHERE id = $6 AND company_id = $7`,
      [userId, shiftTypeId, date, notes || null, published, req.params.id, companyId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Shift not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/:id/publish-state — publish/unpublish one manual shift.
router.post('/shifts/:id/publish-state', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { published } = req.body ?? {};
    const { rowCount } = await query(
      'UPDATE shifts SET published = $1 WHERE id = $2 AND company_id = $3',
      [published !== false, req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Shift not found.' });
      return;
    }
    res.json({ ok: true, published: published !== false });
  } catch (err) {
    console.error('[schedule] shift publish-state failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rotation-shifts/publish-state — publish/unpublish one rotation shift instance.
// Body: { rotationId, userId, date, shiftTypeId, published }
router.post('/rotation-shifts/publish-state', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rotationId, userId, date, shiftTypeId, published } = req.body ?? {};
    if (!rotationId || !userId || !date || !shiftTypeId) {
      res.status(400).json({ error: 'rotationId, userId, date, and shiftTypeId are required.' });
      return;
    }
    await query(
      `INSERT INTO rotation_shift_publish (company_id, rotation_id, user_id, date, shift_type_id, published)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, rotation_id, user_id, date, shift_type_id)
       DO UPDATE SET published = EXCLUDED.published`,
      [companyId, rotationId, userId, date, shiftTypeId, published !== false]
    );
    res.json({ ok: true, published: published !== false });
  } catch (err) {
    console.error('[schedule] rotation shift publish-state failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/rotation-shifts — delete a rotation-generated shift instance
// Body: { rotationId, userId, date, shiftTypeId }
router.post('/rotation-shifts/delete', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rotationId, userId, date, shiftTypeId } = req.body ?? {};
    if (!rotationId || !userId || !date) {
      res.status(400).json({ error: 'rotationId, userId, and date are required.' });
      return;
    }
    await query(
      `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
      [companyId, rotationId, userId, date, shiftTypeId || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete rotation shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Publish state
// ---------------------------------------------------------------------------

// GET /api/schedule/days?from=&to= — publish state for dates in range.
router.get('/days', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isValidDate(from) || !isValidDate(to)) {
      res.status(400).json({ error: 'Valid from and to dates (YYYY-MM-DD) are required.' });
      return;
    }
    const { rows } = await query(
      `SELECT date::text AS date, is_published AS "isPublished"
       FROM schedule_days WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );
    const map: Record<string, boolean> = {};
    for (const r of rows) map[r.date] = r.isPublished;
    res.json({ days: map });
  } catch (err) {
    console.error('[schedule] days failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/days/publish — {dates:[...]} (owner/scheduler).
router.post('/days/publish', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.filter(isValidDate) : [];
    if (!dates.length) {
      res.status(400).json({ error: 'At least one valid date is required.' });
      return;
    }
    for (const d of dates) {
      await query(
        `INSERT INTO schedule_days (company_id, date, is_published, published_at, published_by)
         VALUES ($1, $2, true, now(), $3)
         ON CONFLICT (company_id, date)
         DO UPDATE SET is_published = true, published_at = now(), published_by = $3`,
        [companyId, d, req.session.userId!]
      );
    }
    res.json({ ok: true, published: dates.length });
  } catch (err) {
    console.error('[schedule] publish failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/days/unpublish — {dates:[...]} (owner/scheduler).
router.post('/days/unpublish', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.filter(isValidDate) : [];
    if (!dates.length) {
      res.status(400).json({ error: 'At least one valid date is required.' });
      return;
    }
    for (const d of dates) {
      await query(
        `INSERT INTO schedule_days (company_id, date, is_published)
         VALUES ($1, $2, false)
         ON CONFLICT (company_id, date)
         DO UPDATE SET is_published = false, published_at = null, published_by = null`,
        [companyId, d]
      );
    }
    res.json({ ok: true, unpublished: dates.length });
  } catch (err) {
    console.error('[schedule] unpublish failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


// POST /api/schedule/shifts/bulk-publish-state — publish/unpublish specific members' shifts in a date range.
// Body: { dates:[...], userIds:[...], published: bool }. Handles manual + rotation shifts.
router.post('/shifts/bulk-publish-state', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.filter(isValidDate) : [];
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const published = req.body?.published !== false;
    if (!dates.length || !userIds.length) {
      res.status(400).json({ error: 'Dates and team members are required.' });
      return;
    }
    // Manual shifts
    const { rowCount } = await query(
      `UPDATE shifts SET published = $1
       WHERE company_id = $2 AND date = ANY($3::date[]) AND user_id = ANY($4::uuid[])`,
      [published, companyId, dates, userIds]
    );
    // Rotation shifts: generate instances and upsert publish overrides
    let rotCount = 0;
    const { rows: rotations } = await query(
      `SELECT id, cycle_days AS "cycleDays", start_date::text AS "startDate"
       FROM rotations WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    for (const rot of rotations) {
      const { rows: assignments } = await query(
        `SELECT user_id AS "userId", cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId"
         FROM rotation_assignments WHERE rotation_id = $1 AND user_id = ANY($2::uuid[])`,
        [rot.id, userIds]
      );
      if (!assignments.length) continue;
      const byDay = new Map<number, typeof assignments>();
      for (const a of assignments) {
        if (!byDay.has(a.cycleDay)) byDay.set(a.cycleDay, []);
        byDay.get(a.cycleDay)!.push(a);
      }
      const startDate = new Date(rot.startDate + 'T00:00:00');
      for (const dateStr of dates) {
        const d = new Date(dateStr + 'T00:00:00');
        if (d < startDate) continue;
        const daysSinceStart = Math.floor((d.getTime() - startDate.getTime()) / 86400000);
        const cycleDay = (daysSinceStart % rot.cycleDays) + 1;
        const dayAssignments = byDay.get(cycleDay);
        if (!dayAssignments) continue;
        for (const a of dayAssignments) {
          await query(
            `INSERT INTO rotation_shift_publish (company_id, rotation_id, user_id, date, shift_type_id, published)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (company_id, rotation_id, user_id, date, shift_type_id)
             DO UPDATE SET published = EXCLUDED.published`,
            [companyId, rot.id, a.userId, dateStr, a.shiftTypeId, published]
          );
          rotCount++;
        }
      }
    }
    res.json({ ok: true, updated: (rowCount || 0) + rotCount });
  } catch (err) {
    console.error('[schedule] bulk publish-state failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Day comments
// ---------------------------------------------------------------------------

// GET /api/schedule/comments?from=&to= — list in range.
router.get('/comments', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isValidDate(from) || !isValidDate(to)) {
      res.status(400).json({ error: 'Valid from and to dates (YYYY-MM-DD) are required.' });
      return;
    }
    const { rows } = await query(
      `SELECT dc.id, dc.date::text AS date, dc.comment,
              dc.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName"
       FROM day_comments dc
       LEFT JOIN users u ON u.id = dc.user_id
       WHERE dc.company_id = $1 AND dc.date >= $2 AND dc.date <= $3
       ORDER BY dc.date, dc.created_at`,
      [companyId, from, to]
    );
    res.json({ comments: rows });
  } catch (err) {
    console.error('[schedule] list comments failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/comments — {date, userId?, comment} (owner/scheduler).
router.post('/comments', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { date, userId, comment } = req.body ?? {};
    if (!isValidDate(date) || !comment || !String(comment).trim()) {
      res.status(400).json({ error: 'A valid date and comment text are required.' });
      return;
    }
    if (userId) {
      const { rows } = await query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2',
        [userId, companyId]
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Team member not found.' });
        return;
      }
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO day_comments (id, company_id, date, user_id, comment, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, companyId, date, userId || null, String(comment).trim(), req.session.userId!]
    );
    res.status(201).json({ id });
  } catch (err) {
    console.error('[schedule] add comment failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/comments/:id (owner/scheduler).
router.delete('/comments/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query(
      'DELETE FROM day_comments WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Comment not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete comment failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/comments/:id — edit a comment (owner/scheduler).
router.put('/comments/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { comment } = req.body ?? {};
    if (!comment || !String(comment).trim()) {
      res.status(400).json({ error: 'Comment text is required.' });
      return;
    }
    const { rowCount } = await query(
      'UPDATE day_comments SET comment = $1 WHERE id = $2 AND company_id = $3',
      [String(comment).trim().slice(0, 2000), req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Comment not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] edit comment failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Rotations
// ---------------------------------------------------------------------------

// GET /api/schedule/rotations — list with assignments.
router.get('/rotations', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: rots } = await query(
      `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate",
              is_active AS "isActive",
              start_time::text AS "startTime", end_time::text AS "endTime", notes
       FROM rotations WHERE company_id = $1 ORDER BY name`,
      [companyId]
    );
    for (const r of rots) {
      const { rows: asg } = await query(
        `SELECT ra.id, ra.user_id AS "userId", ra.cycle_day AS "cycleDay",
                ra.shift_type_id AS "shiftTypeId",
                u.first_name AS "firstName", u.last_name AS "lastName",
                st.name AS "shiftTypeName", st.color AS "shiftTypeColor"
         FROM rotation_assignments ra
         JOIN users u ON u.id = ra.user_id
         JOIN shift_types st ON st.id = ra.shift_type_id
         WHERE ra.rotation_id = $1 ORDER BY ra.cycle_day`,
        [r.id]
      );
      r.assignments = asg;
    }
    res.json({ rotations: rots });
  } catch (err) {
    console.error('[schedule] list rotations failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rotations — create (owner/scheduler).
// Body: {name, cycleDays (1–84), startDate, assignments: [{userId, cycleDay, shiftTypeId}]}
router.post('/rotations', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { name, cycleDays, startDate, assignments, startTime, endTime, notes } = req.body ?? {};
    const cd = Number(cycleDays);
    if (!name || !String(name).trim() || !Number.isInteger(cd) || cd < 1 || cd > 84 || !isValidDate(startDate)) {
      res.status(400).json({ error: 'Name, cycle length (1–84 days), and a valid start date are required.' });
      return;
    }
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const st = startTime && timeRe.test(startTime) ? startTime : null;
    const et = endTime && timeRe.test(endTime) ? endTime : null;
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO rotations (id, company_id, name, cycle_days, start_date, created_by, start_time, end_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, companyId, String(name).trim(), cd, startDate, req.session.userId!, st, et,
       notes ? String(notes).trim().slice(0, 500) : null]
    );
    if (Array.isArray(assignments)) {
      for (const a of assignments) {
        const day = Number(a.cycleDay);
        if (!a.userId || !a.shiftTypeId || !Number.isInteger(day) || day < 1 || day > cd) continue;
        try {
          await query(
            `INSERT INTO rotation_assignments (id, rotation_id, user_id, cycle_day, shift_type_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [crypto.randomUUID(), id, a.userId, day, a.shiftTypeId]
          );
        } catch { /* skip duplicates/invalid refs */ }
      }
    }
    res.status(201).json({ id });
  } catch (err) {
    console.error('[schedule] create rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rotations/:id/apply — generate shifts from rotation
// over a date range (owner/scheduler). Skips dates that already have the
// same user+shift-type assigned.
router.post('/rotations/:id/apply', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to)) {
      res.status(400).json({ error: 'Valid from and to dates (YYYY-MM-DD) are required.' });
      return;
    }
    const { rows: rots } = await query(
      `SELECT id, cycle_days AS "cycleDays", start_date::text AS "startDate", is_active AS "isActive"
       FROM rotations WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    if (!rots.length || !rots[0].isActive) {
      res.status(404).json({ error: 'Rotation not found or inactive.' });
      return;
    }
    const rot = rots[0];
    const { rows: asg } = await query(
      'SELECT user_id AS "userId", cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId" FROM rotation_assignments WHERE rotation_id = $1',
      [rot.id]
    );
    const startMs = Date.parse(rot.startDate + 'T00:00:00Z');
    const fromMs = Date.parse(from + 'T00:00:00Z');
    const toMs = Date.parse(to + 'T00:00:00Z');
    let created = 0;
    for (let ms = fromMs; ms <= toMs; ms += 86400000) {
      const d = new Date(ms).toISOString().slice(0, 10);
      const dayIndex = Math.floor((ms - startMs) / 86400000);
      if (dayIndex < 0) continue;
      const cycleDay = (dayIndex % rot.cycleDays) + 1;
      for (const a of asg) {
        if (a.cycleDay !== cycleDay) continue;
        try {
          await query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [crypto.randomUUID(), companyId, a.userId, a.shiftTypeId, d, req.session.userId!]
          );
          created++;
        } catch { /* skip duplicates */ }
      }
    }
    res.json({ ok: true, created });
  } catch (err) {
    console.error('[schedule] apply rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/rotations/:id (owner/scheduler).
router.delete('/rotations/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query(
      'DELETE FROM rotations WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Rotation not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/schedule/rotations/:id — toggle active/paused
router.patch('/rotations/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { isActive } = req.body ?? {};
    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive (boolean) is required.' });
      return;
    }
    const { rows } = await query(
      'UPDATE rotations SET is_active = $1 WHERE id = $2 AND company_id = $3 RETURNING id, is_active AS "isActive"',
      [isActive, req.params.id, companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Rotation not found.' });
      return;
    }
    res.json({ ok: true, rotation: rows[0] });
  } catch (err) {
    console.error('[schedule] toggle rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/vacation-check?userId=xxx&date=YYYY-MM-DD — is this person on vacation that date?
router.get('/vacation-check', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const userId = String(req.query.userId || '');
    const date = String(req.query.date || '');
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'userId and date are required.' });
      return;
    }
    const { rows } = await query(
      `SELECT p.id AS "pauseId", p.rotation_id AS "rotationId",
              p.start_date::text AS "startDate", p.end_date::text AS "endDate", p.reason,
              r.name AS "rotationName"
       FROM rotation_pauses p
       JOIN rotations r ON r.id = p.rotation_id
       JOIN rotation_assignments ra ON ra.rotation_id = r.id AND ra.user_id = $2
       WHERE p.company_id = $1 AND p.start_date <= $3 AND p.end_date >= $3
       LIMIT 1`,
      [companyId, userId, date]
    );
    res.json({ onVacation: rows.length > 0, vacation: rows[0] || null });
  } catch (err) {
    console.error('[schedule] vacation check failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/rotations/:id/pauses — list pause periods
router.get('/rotations/:id/pauses', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT id, start_date::text AS "startDate", end_date::text AS "endDate", reason
       FROM rotation_pauses WHERE rotation_id = $1 AND company_id = $2 ORDER BY start_date`,
      [req.params.id, companyId]
    );
    res.json({ pauses: rows });
  } catch (err) {
    console.error('[schedule] list pauses failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rotations/:id/pauses — add a pause period
router.post('/rotations/:id/pauses', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { startDate, endDate, reason } = req.body ?? {};
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required.' });
      return;
    }
    if (endDate < startDate) {
      res.status(400).json({ error: 'End date must be on or after start date.' });
      return;
    }
    // Verify rotation belongs to company
    const { rows: rotRows } = await query(
      'SELECT id FROM rotations WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rotRows.length) {
      res.status(404).json({ error: 'Rotation not found.' });
      return;
    }
    const { rows } = await query(
      `INSERT INTO rotation_pauses (company_id, rotation_id, start_date, end_date, reason)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, start_date::text AS "startDate", end_date::text AS "endDate", reason`,
      [companyId, req.params.id, startDate, endDate, reason || null]
    );
    res.json({ ok: true, pause: rows[0] });
  } catch (err) {
    console.error('[schedule] add pause failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/rotations/:id/pauses/:pauseId — remove a pause period
router.delete('/rotations/:id/pauses/:pauseId', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query(
      'DELETE FROM rotation_pauses WHERE id = $1 AND rotation_id = $2 AND company_id = $3',
      [req.params.pauseId, req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Pause not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete pause failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/rotations/:id/pauses/:pauseId — update a pause period's dates/reason
router.put('/rotations/:id/pauses/:pauseId', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { startDate, endDate, reason } = req.body ?? {};
    if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
      res.status(400).json({ error: 'Valid start and end dates are required.' });
      return;
    }
    const { rowCount } = await query(
      `UPDATE rotation_pauses SET start_date = $1, end_date = $2, reason = $3
       WHERE id = $4 AND rotation_id = $5 AND company_id = $6`,
      [startDate, endDate, reason != null ? String(reason) : null, req.params.pauseId, req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Pause not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update pause failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Staffing targets — how many of each shift type are needed per day.
// ---------------------------------------------------------------------------

// GET /api/schedule/staffing-targets — list with shift type info.
router.get('/staffing-targets', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await ensureShiftTypes(companyId);
    const { rows } = await query(
      `SELECT st.id AS "shiftTypeId", st.name, st.color,
              COALESCE(t.target_count, 0) AS "targetCount",
              COALESCE(t.weekdays, '{0,1,2,3,4,5,6}') AS weekdays,
              t.start_date::text AS "startDate", t.end_date::text AS "endDate"
       FROM shift_types st
       LEFT JOIN staffing_targets t ON t.shift_type_id = st.id AND t.company_id = $1
       WHERE st.company_id = $1 AND st.is_active = true
       ORDER BY st.sort_order, st.name`,
      [companyId]
    );
    res.json({ targets: rows });
  } catch (err) {
    console.error('[schedule] list staffing targets failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/staffing-targets — save all targets (owner/scheduler).
router.put('/staffing-targets', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const targets = req.body.targets;
    if (!Array.isArray(targets)) {
      res.status(400).json({ error: 'targets must be an array.' });
      return;
    }
    for (const t of targets) {
      const count = Math.min(20, Math.max(0, parseInt(t.targetCount) || 0));
      await query(
        `INSERT INTO staffing_targets (id, company_id, shift_type_id, target_count, weekdays, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, shift_type_id)
         DO UPDATE SET target_count = $4, weekdays = $5, start_date = $6, end_date = $7`,
        [crypto.randomUUID(), companyId, t.shiftTypeId, count,
         Array.isArray(t.weekdays) ? t.weekdays : [0,1,2,3,4,5,6],
         t.startDate || null, t.endDate || null]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] save staffing targets failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Shift settings — default start/end times per shift type.
// ---------------------------------------------------------------------------

// PUT /api/schedule/shift-types/:id — update (owner/scheduler).
router.put('/shift-types/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { startTime, endTime, name, color, departmentId } = req.body;
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const updates: string[] = [];
    const vals: any[] = [];
    let i = 1;
    if (startTime !== undefined) {
      if (!timeRe.test(startTime)) { res.status(400).json({ error: 'Invalid start time.' }); return; }
      updates.push(`start_time = $${i++}`); vals.push(startTime);
    }
    if (endTime !== undefined) {
      if (!timeRe.test(endTime)) { res.status(400).json({ error: 'Invalid end time.' }); return; }
      updates.push(`end_time = $${i++}`); vals.push(endTime);
    }
    if (name !== undefined && typeof name === 'string' && name.trim()) {
      updates.push(`name = $${i++}`); vals.push(name.trim());
    }
    if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) {
      updates.push(`color = $${i++}`); vals.push(color);
    }
    if (departmentId !== undefined) {
      if (departmentId) {
        const { rows: dept } = await query(
          'SELECT id FROM departments WHERE id = $1 AND company_id = $2',
          [departmentId, companyId]
        );
        if (!dept.length) { res.status(400).json({ error: 'Department not found.' }); return; }
        updates.push(`department_id = $${i++}`); vals.push(dept[0].id);
      } else {
        updates.push(`department_id = $${i++}`); vals.push(null);
      }
    }
    if (!updates.length) { res.status(400).json({ error: 'Nothing to update.' }); return; }
    vals.push(req.params.id, companyId);
    const { rowCount } = await query(
      `UPDATE shift_types SET ${updates.join(', ')} WHERE id = $${i++} AND company_id = $${i}`,
      vals
    );
    if (!rowCount) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update shift type failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/shift-types/:id — delete (owner/scheduler).
// Shifts using this type are kept; the type is deactivated instead if in use.
router.delete('/shift-types/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT id FROM shifts WHERE shift_type_id = $1 AND company_id = $2 LIMIT 1',
      [req.params.id, companyId]
    );
    if (rows.length) {
      await query(
        'UPDATE shift_types SET is_active = false WHERE id = $1 AND company_id = $2',
        [req.params.id, companyId]
      );
    } else {
      const { rowCount } = await query(
        'DELETE FROM shift_types WHERE id = $1 AND company_id = $2',
        [req.params.id, companyId]
      );
      if (!rowCount) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete shift type failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Employee Link — public schedule sharing
// ---------------------------------------------------------------------------

function hashShareToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// GET /api/schedule/share — list share links (owner/scheduler).
router.get('/share', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT s.id, s.label, s.created_at AS "createdAt",
              s.department_id AS "departmentId", d.name AS "departmentName",
              s.shift_type_id AS "shiftTypeId", st.name AS "shiftTypeName"
       FROM schedule_shares s
       LEFT JOIN departments d ON d.id = s.department_id
       LEFT JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 ORDER BY s.created_at DESC`,
      [companyId]
    );
    res.json({ links: rows, hasLink: rows.length > 0 });
  } catch (err) {
    console.error('[schedule] get share failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/share — generate a share link (owner/scheduler).
// Body: { departmentId?: uuid | null, shiftTypeId?: uuid | null, label?: string }
router.post('/share', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { departmentId, shiftTypeId, label } = req.body ?? {};
    let deptId: string | null = null;
    if (departmentId) {
      const { rows: drows } = await query('SELECT id, name FROM departments WHERE id = $1 AND company_id = $2', [departmentId, companyId]);
      if (!drows.length) { res.status(404).json({ error: 'Department not found.' }); return; }
      deptId = drows[0].id;
    }
    let stId: string | null = null;
    if (shiftTypeId) {
      const { rows: srows } = await query('SELECT id, name FROM shift_types WHERE id = $1 AND company_id = $2 AND active = true', [shiftTypeId, companyId]);
      if (!srows.length) { res.status(404).json({ error: 'Shift type not found.' }); return; }
      stId = srows[0].id;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashShareToken(token);
    const { rows } = await query(
      'INSERT INTO schedule_shares (id, company_id, token_hash, department_id, shift_type_id, label) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [crypto.randomUUID(), companyId, tokenHash, deptId, stId, label ? String(label).slice(0, 120) : null]
    );
    const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.status(201).json({ id: rows[0].id, shareLink: `${base}/view.html?t=${token}` });
  } catch (err) {
    console.error('[schedule] create share failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/share/:id — disable a share link (owner/scheduler).
router.delete('/share/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM schedule_shares WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete share failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/share — disable all share links (owner/scheduler). Kept for backwards compat.
router.delete('/share', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM schedule_shares WHERE company_id = $1', [companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete share failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/public?token=xxx&from=YYYY-MM-DD&to=YYYY-MM-DD — public read-only schedule.
// Returns only published dates.
router.get('/public', async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token || '');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!token || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'Invalid request.' });
      return;
    }
    const { rows: shares } = await query(
      'SELECT company_id, department_id, shift_type_id FROM schedule_shares WHERE token_hash = $1',
      [hashShareToken(token)]
    );
    if (!shares.length) {
      res.status(404).json({ error: 'This link is not valid.' });
      return;
    }
    const companyId = shares[0].company_id;
    const deptId = shares[0].department_id;
    const shiftTypeId = shares[0].shift_type_id;
    // Only published dates and published shifts. Optionally scoped to a department and/or shift type.
    const shiftParams: any[] = [companyId, from, to];
    let extraFilter = '';
    if (deptId) { shiftParams.push(deptId); extraFilter += ` AND (u.department_id = $${shiftParams.length} OR st.department_id = $${shiftParams.length})`; }
    if (shiftTypeId) { shiftParams.push(shiftTypeId); extraFilter += ` AND s.shift_type_id = $${shiftParams.length}`; }
    const { rows: shifts } = await query(
      `SELECT s.id, s.date::text AS date, s.notes,
              s.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
              u.nickname, s.shift_type_id AS "shiftTypeId",
              st.name AS "shiftTypeName", st.color AS "shiftTypeColor",
              st.text_color AS "shiftTypeTextColor",
              false AS "isRotation", NULL AS "rotationId", NULL AS "rotationName"
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       JOIN shift_types st ON st.id = s.shift_type_id
       JOIN schedule_days d ON d.company_id = s.company_id AND d.date = s.date AND d.is_published = true
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3 AND s.published = true ${extraFilter}
       ORDER BY s.date, st.sort_order, u.first_name, u.last_name`,
      shiftParams
    );
    const { rows: types } = await query(
      `SELECT id, name, color, text_color AS "textColor", sort_order AS "sortOrder"
       FROM shift_types WHERE company_id = $1 AND is_active = true ORDER BY sort_order, name`,
      [companyId]
    );
    const { rows: comp } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
    res.json({
      companyName: comp.length ? comp[0].name : '',
      shifts,
      shiftTypes: types,
    });
  } catch (err) {
    console.error('[schedule] public schedule failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/open-slots-message — generate a copy-paste message listing
// open slots for a date range, grouped by shift type (owner/scheduler).
router.post('/open-slots-message', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to, shiftTypeIds, note, template } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    // Get shift types (all active, or filtered).
    let typeFilter = '';
    const typeParams: any[] = [companyId];
    if (Array.isArray(shiftTypeIds) && shiftTypeIds.length) {
      typeFilter = 'AND st.id = ANY($2::uuid[])';
      typeParams.push(shiftTypeIds);
    }
    const { rows: types } = await query(
      `SELECT st.id, st.name, st.sort_order AS "sortOrder" FROM shift_types st
       WHERE st.company_id = $1 AND st.is_active = true ${typeFilter}
       ORDER BY st.sort_order, st.name`,
      typeParams
    );
    if (!types.length) {
      res.json({ message: 'No shift types found.' });
      return;
    }
    // Get staffing targets, slot adjustments, closed shifts, and assigned shifts.
    const { rows: targets } = await query(
      `SELECT shift_type_id AS "shiftTypeId", target_count AS "targetCount",
              weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
       FROM staffing_targets WHERE company_id = $1`,
      [companyId]
    );
    const { rows: adjustments } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count
       FROM extra_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );
    const { rows: closed } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId"
       FROM closed_shifts WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, from, to]
    );
    const { rows: assigned } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", COUNT(*) AS count
       FROM shifts WHERE company_id = $1 AND date >= $2 AND date <= $3
       GROUP BY date, shift_type_id`,
      [companyId, from, to]
    );
    const closedSet = new Set(closed.map((c: any) => c.date + '|' + c.shiftTypeId));
    const assignedMap = new Map(assigned.map((a: any) => [a.date + '|' + a.shiftTypeId, parseInt(a.count, 10)]));
    const adjMap = new Map<string, number>();
    adjustments.forEach((a: any) => {
      const k = a.date + '|' + a.shiftTypeId;
      adjMap.set(k, (adjMap.get(k) || 0) + (a.count || 0));
    });
    // Build date list.
    const dates: string[] = [];
    const d = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    while (d <= end && dates.length < 93) {
      dates.push(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    function fmtDay(ds: string): string {
      const dt = new Date(ds + 'T00:00:00');
      return `${dayNames[dt.getDay()]} ${monthNames[dt.getMonth()]} ${dt.getDate()}`;
    }
    // Calculate open slots per type per date.
    const lines: string[] = [];
    const fromFmt = fmtDay(from), toFmt = fmtDay(to);
    if (template === 'personal') {
      lines.push(`Hello, can you work the following dates? (${fromFmt} to ${toFmt})`);
    } else {
      lines.push(`Can someone work the following shifts? (${fromFmt} to ${toFmt})`);
    }
    if (note && String(note).trim()) lines.push(`Note: ${String(note).trim()}`);
    lines.push('');
    let hasAny = false;
    for (const t of types) {
      const typeLines: string[] = [];
      for (const ds of dates) {
        const key = ds + '|' + t.id;
        if (closedSet.has(key)) continue;
        // Find target for this weekday.
        let target = 0;
        const dt = new Date(ds + 'T00:00:00');
        for (const tg of targets) {
          if (tg.shiftTypeId !== t.id) continue;
          const weekdays = tg.weekdays || [0, 1, 2, 3, 4, 5, 6];
          if (!weekdays.includes(dt.getDay())) continue;
          if (tg.startDate && ds < tg.startDate) continue;
          if (tg.endDate && ds > tg.endDate) continue;
          target = tg.targetCount || 0;
          break;
        }
        const extra = adjMap.get(key) || 0;
        if (!target && !extra) continue;
        const filled = assignedMap.get(key) || 0;
        const open = Math.max(0, target + extra - filled);
        if (open > 0) {
          typeLines.push(`• ${fmtDay(ds)} — ${open} slot${open === 1 ? '' : 's'}`);
        }
      }
      if (typeLines.length) {
        hasAny = true;
        lines.push(`*${t.name}*`);
        lines.push(...typeLines);
        lines.push('');
      }
    }
    if (!hasAny) {
      res.json({ message: `No open shifts from ${fromFmt} to ${toFmt}.` });
      return;
    }
    lines.push('Reply to pick up a shift.');
    res.json({ message: lines.join('\n') });
  } catch (err) {
    console.error('[schedule] open-slots-message failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Availability links — staff submit availability via shareable link (no login)
// ---------------------------------------------------------------------------

// GET /api/schedule/availability — list availability requests (owner/scheduler).
router.get('/availability', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT id, title, note, from_date::text AS "fromDate", to_date::text AS "toDate",
              created_at AS "createdAt",
              (SELECT COUNT(DISTINCT name) FROM availability_responses r WHERE r.request_id = availability_requests.id) AS "responseCount"
       FROM availability_requests WHERE company_id = $1 ORDER BY created_at DESC`,
      [companyId]
    );
    res.json({ requests: rows });
  } catch (err) {
    console.error('[schedule] list availability failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/availability — create an availability request (owner/scheduler).
router.post('/availability', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { fromDate, toDate, title, note } = req.body ?? {};
    if (!isValidDate(fromDate) || !isValidDate(toDate) || fromDate > toDate) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashShareToken(token);
    const { rows } = await query(
      `INSERT INTO availability_requests (company_id, token_hash, title, note, from_date, to_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [companyId, tokenHash, title ? String(title).slice(0, 120) : null, note ? String(note).slice(0, 500) : null, fromDate, toDate, req.session.userId!]
    );
    const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.status(201).json({ id: rows[0].id, link: `${base}/availability.html?t=${token}` });
  } catch (err) {
    console.error('[schedule] create availability failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/availability/:id — delete a request (owner/scheduler).
router.delete('/availability/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM availability_requests WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete availability failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/availability/:id/responses — view responses (owner/scheduler).
router.get('/availability/:id/responses', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: reqs } = await query(
      'SELECT id, title, from_date::text AS "fromDate", to_date::text AS "toDate" FROM availability_requests WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!reqs.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const { rows: responses } = await query(
      `SELECT name, date::text AS date, available FROM availability_responses
       WHERE request_id = $1 ORDER BY name, date`,
      [req.params.id]
    );
    res.json({ request: reqs[0], responses });
  } catch (err) {
    console.error('[schedule] availability responses failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/availability/public?token=xxx — public request details (no auth).
router.get('/availability/public', async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token || '');
    if (!token) { res.status(400).json({ error: 'Invalid link.' }); return; }
    const { rows } = await query(
      `SELECT ar.id, ar.title, ar.note, ar.from_date::text AS "fromDate", ar.to_date::text AS "toDate",
              c.name AS "companyName"
       FROM availability_requests ar JOIN companies c ON c.id = ar.company_id
       WHERE ar.token_hash = $1`,
      [hashShareToken(token)]
    );
    if (!rows.length) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    res.json({ request: rows[0] });
  } catch (err) {
    console.error('[schedule] public availability failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/availability/public/respond — submit availability (no auth).
router.post('/availability/public/respond', async (req: Request, res: Response) => {
  try {
    const { token, name, dates } = req.body ?? {};
    if (!token || !name || typeof name !== 'string' || !name.trim() || !dates || typeof dates !== 'object') {
      res.status(400).json({ error: 'Name and availability are required.' });
      return;
    }
    const { rows } = await query('SELECT id, from_date::text AS "fromDate", to_date::text AS "toDate" FROM availability_requests WHERE token_hash = $1', [hashShareToken(String(token))]);
    if (!rows.length) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    const reqId = rows[0].id;
    const cleanName = String(name).trim().slice(0, 80);
    const entries = Object.entries(dates as Record<string, boolean>);
    if (!entries.length || entries.length > 93) { res.status(400).json({ error: 'Invalid dates.' }); return; }
    for (const [ds, avail] of entries) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) || ds < rows[0].fromDate || ds > rows[0].toDate) continue;
      await query(
        `INSERT INTO availability_responses (request_id, name, date, available)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (request_id, name, date) DO UPDATE SET available = EXCLUDED.available`,
        [reqId, cleanName, ds, !!avail]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] availability respond failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Shared payroll data computation (used by report, PDF, and email).
async function getPayrollData(companyId: string, from: string, to: string, personId?: string | null) {
  const params: any[] = [companyId, from, to];
  let personFilter = '';
  if (personId) {
    params.push(personId);
    personFilter = ` AND u.id = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT u.id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName", u.nickname,
            s.date::text AS date,
            st.name AS "shiftTypeName",
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
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins <= 0) mins += 24 * 60;
    return Math.round((mins / 60) * 100) / 100;
  }
  const byPerson = new Map<string, { name: string; shifts: number; hours: number }>();
  const byDate = new Map<string, { date: string; entries: { name: string; shift: string; hours: number }[]; totalHours: number }>();
  for (const r of rows) {
    const name = r.nickname || `${r.firstName} ${r.lastName || ''}`.trim();
    const h = hoursFor(r.startTime, r.endTime);
    const cur = byPerson.get(name) || { name, shifts: 0, hours: 0 };
    cur.shifts += 1;
    cur.hours = Math.round((cur.hours + h) * 100) / 100;
    byPerson.set(name, cur);
    const d: { date: string; entries: { name: string; shift: string; hours: number }[]; totalHours: number } =
      byDate.get(r.date) || { date: r.date, entries: [], totalHours: 0 };
    d.entries.push({ name, shift: r.shiftTypeName, hours: h });
    d.totalHours = Math.round((d.totalHours + h) * 100) / 100;
    byDate.set(r.date, d);
  }
  const people = [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  const dates = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totalHours = Math.round(people.reduce((s, p) => s + p.hours, 0) * 100) / 100;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(ds: string): string {
    const dt = new Date(ds + 'T00:00:00');
    return `${dayNames[dt.getDay()]} ${monthNames[dt.getMonth()]} ${dt.getDate()}`;
  }
  const lines = [`Payroll hours — ${fmtDay(from)} to ${fmtDay(to)}`, ''];
  for (const d of dates) {
    lines.push(`${fmtDay(d.date)} (${d.totalHours} hrs)`);
    for (const e of d.entries) {
      lines.push(`  ${e.name} — ${e.shift} (${e.hours} hrs)`);
    }
    lines.push('');
  }
  lines.push('By person:');
  for (const p of people) {
    lines.push(`${p.name}: ${p.shifts} shift${p.shifts === 1 ? '' : 's'}, ${p.hours} hrs`);
  }
  lines.push('');
  lines.push(`Total: ${totalHours} hrs`);
  return { message: lines.join('\n'), people, dates, totalHours };
}

// POST /api/schedule/payroll-report — hours worked for a date range (owner/scheduler).
// Body: { from, to, personId?: uuid | null }
router.post('/payroll-report', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to, personId } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    const data = await getPayrollData(companyId, from, to, personId || null);
    res.json(data);
  } catch (err) {
    console.error('[schedule] payroll-report failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/payroll-report.pdf — download PDF (owner/scheduler).
router.post('/payroll-report.pdf', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to, personId } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    const { rows: crows } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
    const companyName = crows[0]?.name || 'Company';
    const data = await getPayrollData(companyId, from, to, personId || null);
    const pdf = await buildPayrollPdf({ companyName, from, to, ...data });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${from}-to-${to}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error('[schedule] payroll pdf failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/payroll-email — email the payroll report now (owner/scheduler).
// Body: { from, to, personId?: uuid | null, email: string }
router.post('/payroll-email', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to, personId, email } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      res.status(400).json({ error: 'A valid email address is required.' });
      return;
    }
    const { rows: crows } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
    const companyName = crows[0]?.name || 'Company';
    const data = await getPayrollData(companyId, from, to, personId || null);
    const pdf = await buildPayrollPdf({ companyName, from, to, ...data });
    const { sendMailWithAttachment } = await import('../util/mailer.js');
    await sendMailWithAttachment({
      to: String(email),
      subject: `Payroll hours ${from} to ${to} — ${companyName}`,
      text: data.message,
      html: `<pre>${data.message.replace(/</g, '&lt;')}</pre>`,
      attachments: [{ filename: `payroll-${from}-to-${to}.pdf`, content: pdf }],
    });
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[schedule] payroll email failed:', err);
    res.status(500).json({ error: err?.message || 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/payroll-schedules — list automatic report schedules (owner/scheduler).
router.get('/payroll-schedules', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT ps.id, ps.email, ps.frequency, ps.day_of_week AS "dayOfWeek", ps.day_of_month AS "dayOfMonth",
              ps.range_days AS "rangeDays", ps.last_sent_at AS "lastSentAt", ps.next_run_at AS "nextRunAt",
              ps.person_id AS "personId", u.first_name AS "personFirst", u.last_name AS "personLast", u.nickname AS "personNick"
       FROM payroll_schedules ps LEFT JOIN users u ON u.id = ps.person_id
       WHERE ps.company_id = $1 ORDER BY ps.created_at DESC`,
      [companyId]
    );
    res.json({ schedules: rows });
  } catch (err) {
    console.error('[schedule] list payroll schedules failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/payroll-schedules — create automatic schedule (owner/scheduler).
// Body: { email, frequency: 'weekly'|'monthly', dayOfWeek?: 0-6, dayOfMonth?: 1-28, personId?: uuid|null, rangeDays?: 1-62 }
router.post('/payroll-schedules', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { email, frequency, dayOfWeek, dayOfMonth, personId, rangeDays } = req.body ?? {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      res.status(400).json({ error: 'A valid email address is required.' });
      return;
    }
    if (frequency !== 'weekly' && frequency !== 'monthly') {
      res.status(400).json({ error: 'Frequency must be weekly or monthly.' });
      return;
    }
    if (frequency === 'weekly' && (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6)) {
      res.status(400).json({ error: 'Pick a day of the week.' });
      return;
    }
    if (frequency === 'monthly' && (dayOfMonth == null || dayOfMonth < 1 || dayOfMonth > 28)) {
      res.status(400).json({ error: 'Pick a day of the month (1-28).' });
      return;
    }
    const rd = Math.min(62, Math.max(1, parseInt(String(rangeDays)) || 7));
    let pid: string | null = null;
    if (personId) {
      const { rows: urows } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND active = true', [personId, companyId]);
      if (!urows.length) { res.status(404).json({ error: 'Person not found.' }); return; }
      pid = urows[0].id;
    }
    // Compute next run: next occurrence of the chosen day.
    const now = new Date();
    let next = new Date(now);
    if (frequency === 'weekly') {
      const diff = ((dayOfWeek - now.getDay()) + 7) % 7;
      next.setDate(now.getDate() + (diff === 0 ? 7 : diff));
    } else {
      next.setDate(dayOfMonth);
      if (next <= now) next.setMonth(next.getMonth() + 1);
    }
    next.setHours(6, 0, 0, 0); // 6 AM server time
    const { rows } = await query(
      `INSERT INTO payroll_schedules (company_id, email, frequency, day_of_week, day_of_month, person_id, range_days, next_run_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [companyId, String(email), frequency,
       frequency === 'weekly' ? dayOfWeek : null,
       frequency === 'monthly' ? dayOfMonth : null,
       pid, rd, next.toISOString(), req.session.userId!]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('[schedule] create payroll schedule failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/payroll-schedules/:id — delete schedule (owner/scheduler).
router.delete('/payroll-schedules/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM payroll_schedules WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete payroll schedule failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
