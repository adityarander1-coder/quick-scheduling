// routes/schedule.ts — Phase 3: scheduling core.
// Shift types, shifts, per-date publish state, day comments, rotations.
// All endpoints are company-scoped via the server session.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { requireRole } from '../middleware/auth';

const router = Router();

// ---------------------------------------------------------------------------
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
      `SELECT id, name, short_name AS "shortName", color, text_color AS "textColor",
              sort_order AS "sortOrder", is_active AS "isActive",
              start_time AS "startTime", end_time AS "endTime"
       FROM shift_types WHERE company_id = $1 ORDER BY sort_order, name`,
      [companyId]
    );
    res.json({ shiftTypes: rows });
  } catch (err) {
    console.error('[schedule] shift-types failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shift-types — create (owner/scheduler).
router.post('/shift-types', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { name, shortName, color, textColor, sortOrder } = req.body ?? {};
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'A shift type name is required.' });
      return;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO shift_types (id, company_id, name, short_name, color, text_color, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, companyId, String(name).trim(), String(shortName || '').trim(),
       String(color || '#3b82f6'), String(textColor || '#ffffff'), Number(sortOrder) || 0]
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
      `SELECT s.id, s.date::text AS date, s.notes,
              s.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
              u.nickname, s.shift_type_id AS "shiftTypeId",
              st.name AS "shiftTypeName", st.short_name AS "shiftTypeShort",
              st.color AS "shiftTypeColor", st.text_color AS "shiftTypeTextColor"
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3
       ORDER BY s.date, st.sort_order, u.first_name, u.last_name`,
      [companyId, from, to]
    );
    res.json({ shifts: rows });
  } catch (err) {
    console.error('[schedule] list shifts failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts — assign a shift (owner/scheduler).
router.post('/shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, date, notes } = req.body ?? {};
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
        `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, companyId, userId, shiftTypeId, date, notes ? String(notes) : null, req.session.userId!]
      );
    } catch (err: any) {
      if (err?.code === '23505') {
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

// ---------------------------------------------------------------------------
// Rotations
// ---------------------------------------------------------------------------

// GET /api/schedule/rotations — list with assignments.
router.get('/rotations', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: rots } = await query(
      `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate",
              is_active AS "isActive"
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
    const { name, cycleDays, startDate, assignments } = req.body ?? {};
    const cd = Number(cycleDays);
    if (!name || !String(name).trim() || !Number.isInteger(cd) || cd < 1 || cd > 84 || !isValidDate(startDate)) {
      res.status(400).json({ error: 'Name, cycle length (1–84 days), and a valid start date are required.' });
      return;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO rotations (id, company_id, name, cycle_days, start_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, companyId, String(name).trim(), cd, startDate, req.session.userId!]
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

// PUT /api/schedule/shift-types/:id — update times (owner/scheduler).
router.put('/shift-types/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { startTime, endTime, name, color } = req.body;
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

export default router;
