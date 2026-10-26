// routes/schedule.ts — Phase 3: scheduling core.
// Shift types, shifts, per-date publish state, day comments, rotations.
// All endpoints are company-scoped via the server session.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, withTransaction } from '../db';
import { requireRole } from '../middleware/auth';
import {
  getDepartmentAccess,
  shiftTypesDepartmentIds,
  usersDepartmentIds,
  assignmentRelevantDepartments,
  rotationRelevantDepartments,
  requireActiveDepartment,
} from '../util/departmentAccess';
import bcrypt from 'bcryptjs';
import { escHtml } from '../util/mailer';
import { auditLog, todayStr } from '../util/audit.js';
import { ensureInboundAddress, fullInboundAddress, inboundDomain } from '../util/inboundAddresses.js';
import * as XLSX from 'xlsx';
import { parseScheduleDocument, isGeminiConfigured } from '../util/gemini';
import { notify, fmtDateLong, eligibleMemberIds, deptApproverIds, planApproverIds, deptMemberIds } from '../util/notify.js';

const router = Router();

/**
 * Get all department IDs affected by a plan's changes. Used to check the
 * approver's department access before executing.
 */
async function getPlanDepartmentIds(companyId: string, plan: any): Promise<string[]> {
  const deptIds = new Set<string>();
  const changes = plan?.changes || [];
  for (const c of changes) {
    // Direct department reference.
    if (c.department) {
      const { rows } = await query('SELECT id FROM departments WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, String(c.department).trim()]);
      if (rows.length) deptIds.add(rows[0].id);
    }
    // Shift type → its departments (look up ID by name first).
    if (c.shiftType) {
      const { rows: stRows } = await query('SELECT id FROM shift_types WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, String(c.shiftType).trim()]);
      if (stRows.length) {
        const ids = await shiftTypesDepartmentIds([stRows[0].id], companyId);
        ids.forEach((id: string) => deptIds.add(id));
      }
    }
    // Person → their home department (look up ID by name first).
    if (c.person || c.fromPerson || c.toPerson) {
      const names = [c.person, c.fromPerson, c.toPerson].filter(Boolean);
      for (const n of names) {
        const { rows: uRows } = await query(
          `SELECT id FROM users WHERE company_id = $1 AND lower(first_name || ' ' || last_name) = lower($2)`,
          [companyId, String(n).trim()]
        );
        if (uRows.length) {
          const ids = await usersDepartmentIds([uRows[0].id], companyId);
          ids.forEach((id: string) => deptIds.add(id));
        }
      }
    }
  }
  return [...deptIds];
}


/** Look up display names for a shift (person + shift type). */
async function shiftDisplayNames(companyId: string, userId: string, shiftTypeId: string) {
  const { rows } = await query(
    `SELECT u.nickname, u.first_name, u.last_name, st.name AS "shiftTypeName"
     FROM users u, shift_types st
     WHERE u.id = $1 AND st.id = $2 AND u.company_id = $3 AND st.company_id = $3`,
    [userId, shiftTypeId, companyId]
  );
  if (!rows.length) return { personName: null, shiftTypeName: null };
  const r = rows[0];
  return {
    personName: r.nickname || `${r.first_name || ''} ${r.last_name || ''}`.trim() || null,
    shiftTypeName: r.shiftTypeName || null,
  };
}

// Default shift types (generic, seeded per company on first use).
// Kept industry-neutral — every company renames/adds their own.
// ---------------------------------------------------------------------------
const DEFAULT_SHIFT_TYPES = [
  { name: 'Morning Shift', shortName: 'AM', color: '#2672d8', textColor: '#ffffff', sortOrder: 1, startTime: '08:00', endTime: '16:00' },
  { name: 'Day Shift', shortName: 'DAY', color: '#00a9a4', textColor: '#ffffff', sortOrder: 2, startTime: '09:00', endTime: '17:00' },
  { name: 'Evening Shift', shortName: 'EVE', color: '#d98314', textColor: '#ffffff', sortOrder: 3, startTime: '16:00', endTime: '00:00' },
  { name: 'Night Shift', shortName: 'NIGHT', color: '#3b4a5c', textColor: '#ffffff', sortOrder: 4, startTime: '00:00', endTime: '08:00' },
];

// Per-industry example shifts (chosen at signup via the industry picker).
// ---------------------------------------------------------------------------
const INDUSTRY_SHIFT_TYPES: Record<string, typeof DEFAULT_SHIFT_TYPES> = {
  hospital: [
    { name: 'Day Shift', shortName: 'DAY', color: '#2672d8', textColor: '#ffffff', sortOrder: 1, startTime: '08:00', endTime: '20:00' },
    { name: 'Night Shift', shortName: 'NIGHT', color: '#3b4a5c', textColor: '#ffffff', sortOrder: 2, startTime: '20:00', endTime: '08:00' },
    { name: 'Swing Shift', shortName: 'SWING', color: '#d98314', textColor: '#ffffff', sortOrder: 3, startTime: '12:00', endTime: '00:00' },
  ],
  restaurant: [
    { name: 'Breakfast Shift', shortName: 'BFST', color: '#d98314', textColor: '#ffffff', sortOrder: 1, startTime: '06:00', endTime: '11:00' },
    { name: 'Lunch Shift', shortName: 'LNCH', color: '#2672d8', textColor: '#ffffff', sortOrder: 2, startTime: '11:00', endTime: '16:00' },
    { name: 'Dinner Shift', shortName: 'DNR', color: '#8a5fb0', textColor: '#ffffff', sortOrder: 3, startTime: '16:00', endTime: '22:00' },
  ],
  retail: [
    { name: 'Opening Shift', shortName: 'OPEN', color: '#2672d8', textColor: '#ffffff', sortOrder: 1, startTime: '08:00', endTime: '16:00' },
    { name: 'Midday Shift', shortName: 'MID', color: '#00a9a4', textColor: '#ffffff', sortOrder: 2, startTime: '10:00', endTime: '18:00' },
    { name: 'Closing Shift', shortName: 'CLOSE', color: '#3b4a5c', textColor: '#ffffff', sortOrder: 3, startTime: '14:00', endTime: '22:00' },
  ],
  warehouse: [
    { name: '1st Shift', shortName: '1ST', color: '#2672d8', textColor: '#ffffff', sortOrder: 1, startTime: '06:00', endTime: '14:00' },
    { name: '2nd Shift', shortName: '2ND', color: '#d98314', textColor: '#ffffff', sortOrder: 2, startTime: '14:00', endTime: '22:00' },
    { name: '3rd Shift', shortName: '3RD', color: '#3b4a5c', textColor: '#ffffff', sortOrder: 3, startTime: '22:00', endTime: '06:00' },
  ],
};

/** Seed shift types for a company from an explicit list. */
async function seedShiftTypes(companyId: string, list: typeof DEFAULT_SHIFT_TYPES) {
  for (const st of list) {
    await query(
      `INSERT INTO shift_types (id, company_id, name, short_name, color, text_color, sort_order, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [crypto.randomUUID(), companyId, st.name, st.shortName, st.color, st.textColor, st.sortOrder, (st as any).startTime || null, (st as any).endTime || null]
    );
  }
}

/** Shift types for an industry key; falls back to the generic set. */
export function shiftTypesForIndustry(industry: string): typeof DEFAULT_SHIFT_TYPES {
  return INDUSTRY_SHIFT_TYPES[industry] || DEFAULT_SHIFT_TYPES;
}

/** Ensure the company has shift types; seed defaults if none exist. */
async function ensureShiftTypes(companyId: string) {
  const { rows } = await query(
    'SELECT id FROM shift_types WHERE company_id = $1 LIMIT 1',
    [companyId]
  );
  if (rows.length) return;
  // Prefer the company's chosen industry; fall back to generic.
  let industry = 'other';
  try {
    const c = await query('SELECT industry FROM companies WHERE id = $1', [companyId]);
    if (c.rows.length && c.rows[0].industry) industry = c.rows[0].industry;
  } catch { /* industry column may not exist yet on older DBs */ }
  await seedShiftTypes(companyId, shiftTypesForIndustry(industry));
}

function isValidDate(s: any): boolean {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

/**
 * Validate a shift type's eligible job role ids. Each role must exist in the
 * company, and when the shift type has departments, the role's department
 * must be one of them. Returns null ids when the field was not provided
 * (leave unchanged); empty array = everyone eligible.
 */
async function validateEligibleRoles(
  raw: unknown,
  companyId: string,
  shiftDeptIds: string[]
): Promise<{ ok: true; ids: string[] | null } | { ok: false; error: string }> {
  if (raw === undefined || raw === null) return { ok: true, ids: null };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'Eligible job roles must be a list.' };
  }
  const ids: string[] = [];
  for (const v of raw) {
    const id = String(v ?? '').trim();
    if (!id || ids.includes(id)) continue;
    const { rows } = await query(
      'SELECT id, department_id FROM job_roles WHERE id = $1 AND company_id = $2',
      [id, companyId]
    );
    if (!rows.length) return { ok: false, error: 'A selected job role was not found.' };
    if (shiftDeptIds.length && !shiftDeptIds.includes(rows[0].department_id)) {
      return { ok: false, error: 'Job roles must belong to the shift type\u2019s department.' };
    }
    ids.push(rows[0].id);
  }
  return { ok: true, ids };
}

/**
 * Check whether a member may claim an open slot for a shift type.
 * Symmetric/bidirectional: the shift type's eligible list is the single gate.
 * Empty/NULL list = everyone eligible; otherwise the member's linked job
 * role must be in the list. Members with no role set can only claim
 * unrestricted shifts.
 */
async function checkShiftEligibility(
  companyId: string,
  memberId: string,
  eligibleIds: string[] | null | undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
  const list: string[] = Array.isArray(eligibleIds) ? eligibleIds : [];
  if (!list.length) return { ok: true };
  const { rows: urows } = await query(
    'SELECT job_role_id FROM users WHERE id = $1 AND company_id = $2',
    [memberId, companyId]
  );
  const memberRoleId: string | null = urows.length ? urows[0].job_role_id : null;
  if (memberRoleId && list.includes(memberRoleId)) return { ok: true };
  const { rows: rrows } = await query(
    'SELECT name FROM job_roles WHERE id = ANY($1::uuid[]) AND company_id = $2 ORDER BY lower(name)',
    [list, companyId]
  );
  const names = rrows.map((r) => r.name).join(', ') || 'specific job roles';
  return {
    ok: false,
    error: `This shift can only be picked up by: ${names}.`,
  };
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
              st.department_id AS "departmentId",
              st.eligible_job_role_ids AS "eligibleJobRoleIds",
              COALESCE((SELECT json_agg(std.department_id) FROM shift_type_departments std WHERE std.shift_type_id = st.id), '[]') AS "departmentIds"
       FROM shift_types st
       WHERE st.company_id = $1 ORDER BY st.sort_order, st.name`,
      [companyId]
    );
    // Department scoping: schedulers see shift types they can view (any of the
    // type's departments, or department-less "global" types). Owner sees all.
    let types = rows;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      types = rows.filter((st: any) => {
        const depts: string[] = st.departmentIds || [];
        return !depts.length || depts.some((d) => access.view.includes(d));
      });
    }
    res.json({ shiftTypes: types });
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
    const { name, shortName, color, textColor, sortOrder, departmentId, departmentIds, eligibleJobRoleIds } = req.body ?? {};
    if (!name || !String(name).trim()) {
      res.status(400).json({ error: 'A shift type name is required.' });
      return;
    }
    // Validate departments belong to company (accept departmentIds array or legacy departmentId).
    const deptIds: string[] = Array.isArray(departmentIds) ? departmentIds : (departmentId ? [departmentId] : []);
    const validDeptIds: string[] = [];
    for (const d of deptIds) {
      const { rows: dept } = await query(
        'SELECT id FROM departments WHERE id = $1 AND company_id = $2',
        [String(d), companyId]
      );
      if (!dept.length) {
        res.status(400).json({ error: 'Department not found.' });
        return;
      }
      validDeptIds.push(dept[0].id);
    }
    // Department scoping: the scheduler's active department must be one of
    // the type's departments (owner bypasses).
    if (!(await requireActiveDepartment(req, res, validDeptIds))) return;
    // Eligible job roles: each must belong to the shift type's department(s).
    const elig = await validateEligibleRoles(eligibleJobRoleIds, companyId, validDeptIds);
    if (!elig.ok) {
      res.status(400).json({ error: elig.error });
      return;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO shift_types (id, company_id, name, short_name, color, text_color, sort_order, department_id, eligible_job_role_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, companyId, String(name).trim(), String(shortName || '').trim(),
       String(color || '#3b82f6'), String(textColor || '#ffffff'), Number(sortOrder) || 0,
       validDeptIds[0] || null, elig.ids]
    );
    for (const dd of validDeptIds) {
      await query(
        'INSERT INTO shift_type_departments (shift_type_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, dd]
      );
    }
    await auditLog({
      companyId, date: todayStr(), action: 'created', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      shiftTypeName: String(name).trim(),
      description: `Added shift type "${String(name).trim()}"`,
    });
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

// POST /api/schedule/shifts — assign a shift (owner/scheduler; department-scoped for schedulers).
router.post('/shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, date, notes, published } = req.body ?? {};
    if (!userId || !shiftTypeId || !isValidDate(date)) {
      res.status(400).json({ error: 'Team member, shift type, and a valid date are required.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of
    // the shift type's departments or the member's home department.
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments([{ userId, shiftTypeId }], companyId)
    ))) return;
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
      'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) {
      res.status(404).json({ error: 'Shift type not found.' });
      return;
    }
    // Job role enforcement: member's role must be eligible for this shift type.
    const eligibility = await checkShiftEligibility(companyId, userId, trows[0].eligible_job_role_ids);
    if (!eligibility.ok) {
      res.status(403).json({ error: eligibility.error });
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
    // Audit: shift created.
    const names = await shiftDisplayNames(companyId, userId, shiftTypeId);
    auditLog({
      companyId, date, action: 'created',
      personName: names.personName, shiftTypeName: names.shiftTypeName,
      source: 'manual', changedBy: req.session.userId!,
    });
    // Notify: only published shifts notify (drafts stay silent).
    if (published !== false) {
      notify({
        companyId, userIds: [userId], category: 'schedule', type: 'shift_assigned',
        title: `New shift: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
        body: `You were assigned ${names.shiftTypeName} on ${fmtDateLong(date)}.`,
        link: 'my-schedule', bundleKey: `shift_assigned:${userId}`,
        bundleTitle: 'You were assigned {count} new shifts',
        excludeUserId: req.session.userId!,
      });
    }
  } catch (err) {
    console.error('[schedule] assign shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/bulk — assign same shift across a date range (owner/scheduler; department-scoped).
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
    // Department scoping: the scheduler's active department must be one of
    // the shift type's departments or the member's home department.
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments([{ userId, shiftTypeId }], companyId)
    ))) return;
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
      'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) {
      res.status(404).json({ error: 'Shift type not found.' });
      return;
    }
    // Job role enforcement.
    const eligibility = await checkShiftEligibility(companyId, userId, trows[0].eligible_job_role_ids);
    if (!eligibility.ok) {
      res.status(403).json({ error: eligibility.error });
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
    if (created > 0 && published !== false) {
      const names = await shiftDisplayNames(companyId, userId, shiftTypeId);
      notify({
        companyId, userIds: [userId], category: 'schedule', type: 'shift_assigned',
        title: `You were assigned ${created} shifts: ${names.shiftTypeName}, ${fmtDateLong(startDate)} – ${fmtDateLong(endDate)}`,
        body: `${created} ${names.shiftTypeName} shifts from ${fmtDateLong(startDate)} to ${fmtDateLong(endDate)}.`,
        link: 'my-schedule', bundleKey: `shift_assigned:${userId}`,
        bundleTitle: 'You were assigned {count} new shifts',
        payload: { count: created },
        excludeUserId: req.session.userId!,
      });
    }
  } catch (err) {
    console.error('[schedule] bulk assign failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/block-assign — Block view "Make schedule": assign
// employees to shift-week blocks (or shifts to employee-week blocks), or a
// shift+employee over a date range. Body: { assignments: [{ userId,
// shiftTypeId, dates: [YYYY-MM-DD, ...] }], published }. Mirrors /shifts/bulk
// rules per group (department scoping + job-role eligibility), but a group
// that fails a check is SKIPPED and counted instead of failing the batch, so
// a multi-block selection spanning departments/roles reports honestly.
router.post('/block-assign', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { assignments, published } = req.body ?? {};
    if (!Array.isArray(assignments) || !assignments.length || assignments.length > 200) {
      res.status(400).json({ error: 'Provide between 1 and 200 assignment groups.' });
      return;
    }
    // Scheduler: resolve the active department once (same rule as
    // requireActiveDepartment); every group must belong to it.
    let activeDept: string | null = null;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      const rawHeader = req.headers['x-active-department'];
      const header = String(Array.isArray(rawHeader) ? rawHeader[0] : (rawHeader ?? '')).trim();
      if (header) {
        if (!access.edit.includes(header)) {
          res.status(403).json({ error: 'You do not have edit access to the active department.' });
          return;
        }
        activeDept = header;
      } else if (access.edit.length === 1) {
        activeDept = access.edit[0];
      } else {
        res.status(403).json({ error: 'Select an active department to make changes.' });
        return;
      }
    }
    let created = 0, already = 0, ineligible = 0, outOfScope = 0, invalid = 0, totalDates = 0;
    let firstRoleError: string | null = null;
    const createdByUser = new Map<string, { count: number; shiftTypeId: string; shiftTypeName: string; firstDate: string; lastDate: string }>();
    for (const group of assignments) {
      const userId = group?.userId, shiftTypeId = group?.shiftTypeId;
      const rawDates: any[] = Array.isArray(group?.dates) ? group.dates : [];
      const dates: string[] = [...new Set<string>(rawDates.filter((d: any) => typeof d === 'string' && isValidDate(d)))];
      if (!userId || !shiftTypeId || !dates.length) { invalid++; continue; }
      totalDates += dates.length;
      if (totalDates > 5000) {
        res.status(400).json({ error: 'Too many dates in one request (max 5000).' });
        return;
      }
      // Member + shift type must exist in this company.
      const { rows: urows } = await query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true',
        [userId, companyId]
      );
      const { rows: trows } = await query(
        'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
        [shiftTypeId, companyId]
      );
      if (!urows.length || !trows.length) { invalid++; continue; }
      // Department scoping (scheduler only; owner bypasses).
      if (activeDept) {
        const relevant = await assignmentRelevantDepartments([{ userId, shiftTypeId }], companyId);
        if (!relevant.length || !relevant.includes(activeDept)) { outOfScope++; continue; }
      }
      // Job-role eligibility for this (member, shift type) pair.
      const eligibility = await checkShiftEligibility(companyId, userId, trows[0].eligible_job_role_ids);
      if (!eligibility.ok) {
        ineligible++;
        if (!firstRoleError) firstRoleError = eligibility.error;
        continue;
      }
      for (const date of dates) {
        try {
          await query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [crypto.randomUUID(), companyId, userId, shiftTypeId, date, null, published !== false, req.session.userId!]
          );
          created++;
          const tally = createdByUser.get(userId) || { count: 0, shiftTypeId, shiftTypeName: '', firstDate: date, lastDate: date };
          tally.count++;
          if (date < tally.firstDate) tally.firstDate = date;
          if (date > tally.lastDate) tally.lastDate = date;
          createdByUser.set(userId, tally);
        } catch (err: any) {
          if (err?.code === '23505') { already++; continue; }
          throw err;
        }
      }
    }
    res.status(201).json({ created, already, ineligible, outOfScope, invalid, roleError: firstRoleError });
    // Notify each member who received published shifts (drafts stay silent).
    if (published !== false) {
      for (const [uid, tally] of createdByUser) {
        const names = await shiftDisplayNames(companyId, uid, tally.shiftTypeId);
        notify({
          companyId, userIds: [uid], category: 'schedule', type: 'shift_assigned',
          title: tally.count === 1
            ? `New shift: ${names.shiftTypeName} on ${fmtDateLong(tally.firstDate)}`
            : `You were assigned ${tally.count} shifts: ${names.shiftTypeName}, ${fmtDateLong(tally.firstDate)} – ${fmtDateLong(tally.lastDate)}`,
          body: `${tally.count} ${names.shiftTypeName} shift(s) between ${fmtDateLong(tally.firstDate)} and ${fmtDateLong(tally.lastDate)}.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${uid}`,
          bundleTitle: 'You were assigned {count} new shifts',
          payload: { count: tally.count },
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] block assign failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Normalize a spreadsheet date cell to YYYY-MM-DD ('' when unreadable).
// Text dates are interpreted as UTC calendar days — never local time — so a
// date can never shift a day because of the server's timezone.
function normalizeImportDate(raw: string): string {
  const t = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  if (/\d/.test(t)) {
    const parsed = new Date(t);
    if (!isNaN(parsed.getTime())) {
      return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}`;
    }
  }
  return '';
}

// Excel serial day number → YYYY-MM-DD (serials are pure calendar days).
function excelSerialToDate(serial: number): string {
  const d = new Date(Math.round((serial - 25569) * 86400000));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// A spreadsheet cell as a date: serial numbers and Date objects convert;
// strings go through the text normalizer.
function importCellDate(cell: any): string {
  if (typeof cell === 'number' && isFinite(cell)) return excelSerialToDate(cell);
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return `${cell.getUTCFullYear()}-${String(cell.getUTCMonth() + 1).padStart(2, '0')}-${String(cell.getUTCDate()).padStart(2, '0')}`;
  }
  return normalizeImportDate(String(cell ?? ''));
}

// Minimal CSV parser (quotes, escaped quotes, commas/newlines in quotes).
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQuotes = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// POST /api/schedule/import-parse — read an uploaded schedule file
// (spreadsheet/CSV or PDF) and return candidate assignment rows for the
// import preview. NOTHING is created here; the client previews the rows
// and confirms through /block-assign. Body: { filename, dataBase64 }.
router.post('/import-parse', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { filename, dataBase64 } = req.body ?? {};
    if (!dataBase64 || typeof dataBase64 !== 'string') {
      res.status(400).json({ error: 'No file data was received.' });
      return;
    }
    const buf = Buffer.from(dataBase64, 'base64');
    if (!buf.length) {
      res.status(400).json({ error: 'That file appears to be empty.' });
      return;
    }
    if (buf.length > 8 * 1024 * 1024) {
      res.status(413).json({ error: 'That file is too large (max 8 MB).' });
      return;
    }
    const fname = String(filename || '').toLowerCase();
    const isPdf = fname.endsWith('.pdf') || buf.subarray(0, 4).toString('latin1') === '%PDF';
    const { rows: memRows } = await query(
      'SELECT first_name AS "firstName", last_name AS "lastName" FROM users WHERE company_id = $1 AND is_active = true ORDER BY first_name, last_name',
      [companyId]
    );
    const members = memRows.map((u: any) => `${u.firstName} ${u.lastName}`.trim());
    const { rows: stRows } = await query(
      'SELECT name FROM shift_types WHERE company_id = $1 AND is_active = true ORDER BY sort_order, name',
      [companyId]
    );
    const shiftTypes = stRows.map((s: any) => s.name);
    const today = todayStr();
    if (isPdf) {
      if (!isGeminiConfigured()) {
        res.status(422).json({ error: 'PDF import uses the AI reader, which is not configured for this workspace.' });
        return;
      }
      const rows = await parseScheduleDocument({ pdfBase64: dataBase64, members, shiftTypes, today });
      res.json({ rows, source: 'ai' });
      return;
    }
    // CSV/text files are parsed as plain text on purpose: spreadsheet
    // libraries interpret date strings in the server's local timezone and
    // can shift them a day. Excel files keep raw cell values so date
    // serials convert exactly (see the cell normalizer below).
    let rawGrid: any[][];
    const isZip = buf.subarray(0, 2).toString('latin1') === 'PK';
    if (!isZip && (fname.endsWith('.csv') || fname.endsWith('.txt') || !fname.endsWith('.xls'))) {
      rawGrid = parseCsvText(buf.toString('utf8'));
    } else {
      let wb: XLSX.WorkBook;
      try {
        wb = XLSX.read(buf, { type: 'buffer' });
      } catch {
        res.status(400).json({ error: 'That file could not be read as a spreadsheet or CSV.' });
        return;
      }
      const ws = wb.Sheets[wb.SheetNames[0]];
      rawGrid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    }
    const cellText = (c: any): string => {
      if (c instanceof Date) return importCellDate(c);
      if (typeof c === 'number' && isFinite(c) && c >= 20000 && c <= 80000) return excelSerialToDate(c);
      return String(c ?? '');
    };
    const grid: string[][] = rawGrid
      .map((r) => (r || []).map((c) => cellText(c).trim()))
      .filter((r) => r.some((c) => c !== ''));
    if (!grid.length) {
      res.json({ rows: [], source: 'sheet' });
      return;
    }
    // List format: a header row in the first 5 rows naming date/member/shift columns.
    const colKind = (s: string): 'date' | 'member' | 'shift' | null => {
      const t = s.toLowerCase();
      if (/date|day/.test(t)) return 'date';
      if (/member|employee|name|staff|person|doctor|provider/.test(t)) return 'member';
      if (/shift|type|assignment|duty/.test(t)) return 'shift';
      return null;
    };
    let headerIdx = -1;
    let cols: Record<string, number> = {};
    for (let i = 0; i < Math.min(5, grid.length); i++) {
      const found: Record<string, number> = {};
      grid[i].forEach((cell, ci) => {
        const k = colKind(cell);
        if (k && found[k] === undefined) found[k] = ci;
      });
      if (found.date !== undefined && found.member !== undefined && found.shift !== undefined) {
        headerIdx = i; cols = found; break;
      }
    }
    if (headerIdx >= 0) {
      const rows: any[] = [];
      for (let i = headerIdx + 1; i < grid.length && rows.length <= 2000; i++) {
        const r = grid[i];
        const member = r[cols.member] || '';
        const shift = r[cols.shift] || '';
        const dateRaw = r[cols.date] || '';
        if (!member && !shift && !dateRaw) continue;
        rows.push({ member, shift, date: normalizeImportDate(dateRaw), dateRaw });
      }
      res.json({ rows, source: 'sheet' });
      return;
    }
    // Any other layout (block grids etc.) — the AI reads the sheet as CSV text.
    if (!isGeminiConfigured()) {
      res.status(422).json({ error: 'This sheet has no Date / Team member / Shift columns, and the AI reader is not configured to read other layouts.' });
      return;
    }
    const csv = grid.map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\n');
    const rows = await parseScheduleDocument({ text: csv, members, shiftTypes, today });
    res.json({ rows, source: 'ai' });
  } catch (err: any) {
    console.error('[schedule] import parse failed:', err);
    res.status(500).json({ error: String(err?.message || 'Could not read that file.').slice(0, 200) });
  }
});

// POST /api/schedule/shifts/bulk-delete — delete shifts in a date list (owner/scheduler; department-scoped).
// Deletes manual shifts; for rotation shifts, adds skip periods so they don't appear.
router.post('/shifts/bulk-delete', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { dates, userIds } = req.body ?? {};
    const shiftTypeId = typeof req.body?.shiftTypeId === 'string' && req.body.shiftTypeId ? req.body.shiftTypeId : '';
    if (!Array.isArray(dates) || !dates.length || dates.length > 366) {
      res.status(400).json({ error: 'Provide a list of dates (max 366).' });
      return;
    }
    const valid = dates.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (!valid.length) {
      res.status(400).json({ error: 'No valid dates provided.' });
      return;
    }
    if (shiftTypeId) {
      const stRows = await query('SELECT id FROM shift_types WHERE id = $1 AND company_id = $2', [shiftTypeId, companyId]);
      if (!stRows.rows.length) {
        res.status(400).json({ error: 'Unknown shift type.' });
        return;
      }
    }
    // Department scoping: the scheduler's active department must be one of
    // the affected members' home departments (no userIds = company-wide;
    // needs an active Edit department).
    if (!(await requireActiveDepartment(
      req, res,
      await usersDepartmentIds(Array.isArray(userIds) ? userIds : [], companyId)
    ))) return;
    const params: any[] = [companyId, valid];
    const userFilter = Array.isArray(userIds) && userIds.length
      ? `AND user_id = ANY($${params.length + 1}::uuid[])`
      : '';
    if (userFilter) params.push(userIds);
    // Optional shift-type filter (Bulk Actions tab): only that type's shifts.
    const typeFilter = shiftTypeId
      ? `AND shift_type_id = $${params.length + 1}`
      : '';
    if (typeFilter) params.push(shiftTypeId);
    // Capture published rows first so their people can be told (below).
    const { rows: doomed } = await query(
      `SELECT user_id, shift_type_id, date::text AS date FROM shifts
       WHERE company_id = $1 AND date = ANY($2::date[]) AND published = true ${userFilter} ${typeFilter}`,
      params
    );
    const { rowCount } = await query(
      `DELETE FROM shifts WHERE company_id = $1 AND date = ANY($2::date[]) ${userFilter} ${typeFilter}`,
      params
    );
    // For rotation shifts: add skip periods covering the range for the affected users' rotations.
    let paused = 0;
    const from = valid.slice().sort()[0];
    const to = valid.slice().sort()[valid.length - 1];
    const rotParams: any[] = [companyId];
    const rotUserFilter = Array.isArray(userIds) && userIds.length
      ? `AND ra.user_id = ANY($${rotParams.length + 1}::uuid[])`
      : '';
    if (rotUserFilter) rotParams.push(userIds);
    // With a type filter, only pause rotations that produce that type
    // (strictly narrower than the unfiltered all-rotations pause).
    const rotTypeFilter = shiftTypeId
      ? `AND EXISTS (SELECT 1 FROM rotation_assignments ra2 WHERE ra2.rotation_id = r.id AND ra2.shift_type_id = $${rotParams.length + 1})`
      : '';
    if (rotTypeFilter) rotParams.push(shiftTypeId);
    const { rows: rots } = await query(
      `SELECT DISTINCT r.id AS rotation_id, ra.user_id
       FROM rotations r
       JOIN rotation_assignments ra ON ra.rotation_id = r.id
       WHERE r.company_id = $1 AND r.is_active = true ${rotUserFilter} ${rotTypeFilter}`,
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
    // Notify people whose published shifts were removed (grouped per person).
    if (doomed.length) {
      const perUser = new Map<string, { count: number; shiftTypeId: string; firstDate: string; lastDate: string }>();
      for (const r of doomed) {
        const t = perUser.get(r.user_id) || { count: 0, shiftTypeId: r.shift_type_id, firstDate: r.date, lastDate: r.date };
        t.count++;
        if (r.date < t.firstDate) t.firstDate = r.date;
        if (r.date > t.lastDate) t.lastDate = r.date;
        perUser.set(r.user_id, t);
      }
      for (const [uid, t] of perUser) {
        const names = await shiftDisplayNames(companyId, uid, t.shiftTypeId);
        notify({
          companyId, userIds: [uid], category: 'schedule', type: 'shift_removed',
          title: t.count === 1
            ? `Shift removed: ${names.shiftTypeName} on ${fmtDateLong(t.firstDate)}`
            : `${t.count} of your shifts were removed (${fmtDateLong(t.firstDate)} – ${fmtDateLong(t.lastDate)})`,
          body: `${t.count} published shift(s) between ${fmtDateLong(t.firstDate)} and ${fmtDateLong(t.lastDate)} were removed.`,
          link: 'my-schedule', bundleKey: `shift_removed:${uid}`,
          bundleTitle: '{count} of your shifts were removed',
          payload: { count: t.count },
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] bulk delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/shifts/:id — remove a shift (owner/scheduler; department-scoped).
router.delete('/shifts/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    // Fetch details for audit before deleting.
    const { rows: srows } = await query(
      `SELECT s.date::text AS date, s.user_id AS "userId", s.shift_type_id AS "shiftTypeId", s.published
       FROM shifts s WHERE s.id = $1 AND s.company_id = $2`,
      [req.params.id, companyId]
    );
    if (srows.length) {
      // Department scoping: the scheduler's active department must be one of
      // the shift type's departments or the member's home department.
      if (!(await requireActiveDepartment(
        req, res,
        await assignmentRelevantDepartments(
          [{ userId: srows[0].userId, shiftTypeId: srows[0].shiftTypeId }], companyId)
      ))) return;
    }
    const { rowCount } = await query(
      'DELETE FROM shifts WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Shift not found.' });
      return;
    }
    res.json({ ok: true });
    if (srows.length) {
      const s = srows[0];
      const names = await shiftDisplayNames(companyId, s.userId, s.shiftTypeId);
      auditLog({
        companyId, date: s.date, action: 'deleted',
        personName: names.personName, shiftTypeName: names.shiftTypeName,
        source: 'manual', changedBy: req.session.userId!,
      });
      if (s.published) {
        notify({
          companyId, userIds: [s.userId], category: 'schedule', type: 'shift_removed',
          title: `Shift removed: ${names.shiftTypeName} on ${fmtDateLong(s.date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(s.date)} was removed.`,
          link: 'my-schedule', bundleKey: `shift_removed:${s.userId}`,
          bundleTitle: '{count} of your shifts were removed',
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] delete shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/extra-slots — adjust open slots for dates (owner/scheduler; department-scoped).
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
    // Department scoping: the scheduler's active department must be one of
    // the shift type's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds([shiftTypeId], companyId)
    ))) return;
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
    // Tell eligible members about newly opened pickup slots.
    if (clamped > 0) {
      const eligible = await eligibleMemberIds(companyId, shiftTypeId);
      if (eligible.length) {
        const { rows: trows } = await query('SELECT name FROM shift_types WHERE id = $1', [shiftTypeId]);
        const stName = trows[0]?.name || 'Shift';
        for (const d of dates) {
          notify({
            companyId, userIds: eligible, category: 'schedule', type: 'open_shift',
            title: `Open shift available: ${stName} on ${fmtDateLong(d)}`,
            body: `An open ${stName} slot is available on ${fmtDateLong(d)}.`,
            link: 'my-schedule', bundleKey: 'open_shift',
            bundleTitle: '{count} open shifts are available to pick up',
            excludeUserId: req.session.userId!,
          });
        }
      }
    }
  } catch (err) {
    console.error('[schedule] adjust slots failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/extra-slots — remove extra open slots (owner/scheduler; department-scoped).
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
    // Department scoping: the scheduler's active department must be one of
    // the shift type's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds([shiftTypeId], companyId)
    ))) return;
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

// POST /api/schedule/closed-shifts — mark a shift type unavailable for a date (owner/scheduler; department-scoped).
router.post('/closed-shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { date, shiftTypeId } = req.body ?? {};
    if (!isValidDate(date) || !shiftTypeId) {
      res.status(400).json({ error: 'Date and shift type are required.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of
    // the shift type's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds([shiftTypeId], companyId)
    ))) return;
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

// DELETE /api/schedule/closed-shifts — reopen a shift type for a date (owner/scheduler; department-scoped).
router.delete('/closed-shifts', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { date, shiftTypeId } = req.body ?? {};
    if (!isValidDate(date) || !shiftTypeId) {
      res.status(400).json({ error: 'Date and shift type are required.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of
    // the shift type's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds([shiftTypeId], companyId)
    ))) return;
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
      'SELECT date::text AS date, user_id AS "userId", shift_type_id AS "shiftTypeId", published FROM shifts WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!orig.length) { res.status(404).json({ error: 'Shift not found.' }); return; }
    // Department scoping: the scheduler's active department must be one of
    // the new or original shift's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments(
        [{ userId, shiftTypeId }, { userId: orig[0].userId, shiftTypeId: orig[0].shiftTypeId }],
        companyId)
    ))) return;
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
    // Notify: the original person lost the original date's shift if it was
    // reassigned; the new person hears about newly created published rows.
    const finalPublished = published !== null && published !== undefined ? published !== false : true;
    if (orig[0].userId !== userId && orig[0].published) {
      const names = await shiftDisplayNames(companyId, orig[0].userId, orig[0].shiftTypeId);
      notify({
        companyId, userIds: [orig[0].userId], category: 'schedule', type: 'shift_removed',
        title: `Shift removed: ${names.shiftTypeName} on ${fmtDateLong(origDate)}`,
        body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(origDate)} was reassigned.`,
        link: 'my-schedule', bundleKey: `shift_removed:${orig[0].userId}`,
        bundleTitle: '{count} of your shifts were removed',
        excludeUserId: req.session.userId!,
      });
    }
    if (created > 0 && finalPublished) {
      const names = await shiftDisplayNames(companyId, userId, shiftTypeId);
      notify({
        companyId, userIds: [userId], category: 'schedule', type: 'shift_assigned',
        title: `You were assigned ${created} shifts: ${names.shiftTypeName}`,
        body: `${created} ${names.shiftTypeName} shift(s) were added for you.`,
        link: 'my-schedule', bundleKey: `shift_assigned:${userId}`,
        bundleTitle: 'You were assigned {count} new shifts',
        payload: { count: created },
        excludeUserId: req.session.userId!,
      });
    }
  } catch (err) {
    console.error('[schedule] apply-range failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/shifts/:id — update one manual shift (owner/scheduler; department-scoped).
router.put('/shifts/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { userId, shiftTypeId, date, notes, published } = req.body ?? {};
    if (!isValidDate(date) || !userId || !shiftTypeId) {
      res.status(400).json({ error: 'Date, team member, and shift type are required.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of
    // the new or existing shift's departments.
    const { rows: existRows } = await query(
      'SELECT user_id AS "userId", shift_type_id AS "shiftTypeId", date::text AS date, published FROM shifts WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (existRows.length) {
      if (!(await requireActiveDepartment(
        req, res,
        await assignmentRelevantDepartments(
          [{ userId, shiftTypeId }, { userId: existRows[0].userId, shiftTypeId: existRows[0].shiftTypeId }],
          companyId)
      ))) return;
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
    // Audit: shift updated.
    const names = await shiftDisplayNames(companyId, userId, shiftTypeId);
    auditLog({
      companyId, date, action: 'updated',
      personName: names.personName, shiftTypeName: names.shiftTypeName,
      source: 'manual', changedBy: req.session.userId!,
      details: { shiftId: req.params.id },
    });
    // Notify about meaningful changes to published shifts.
    if (existRows.length) {
      const old = existRows[0];
      const finalPublished = published !== null && published !== undefined ? published !== false : old.published !== false;
      const actor = req.session.userId!;
      if (old.published && !finalPublished) {
        notify({
          companyId, userIds: [old.userId], category: 'schedule', type: 'shift_removed',
          title: `Shift unpublished: ${names.shiftTypeName} on ${fmtDateLong(old.date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(old.date)} was moved back to draft.`,
          link: 'my-schedule', bundleKey: `shift_removed:${old.userId}`,
          bundleTitle: '{count} of your shifts were removed',
          excludeUserId: actor,
        });
      } else if (finalPublished && old.userId !== userId) {
        const oldNames = await shiftDisplayNames(companyId, old.userId, old.shiftTypeId);
        if (old.published) {
          notify({
            companyId, userIds: [old.userId], category: 'schedule', type: 'shift_removed',
            title: `Shift removed: ${oldNames.shiftTypeName} on ${fmtDateLong(old.date)}`,
            body: `Your ${oldNames.shiftTypeName} shift on ${fmtDateLong(old.date)} was reassigned.`,
            link: 'my-schedule', bundleKey: `shift_removed:${old.userId}`,
            bundleTitle: '{count} of your shifts were removed',
            excludeUserId: actor,
          });
        }
        notify({
          companyId, userIds: [userId], category: 'schedule', type: 'shift_assigned',
          title: `New shift: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
          body: `You were assigned ${names.shiftTypeName} on ${fmtDateLong(date)}.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${userId}`,
          bundleTitle: 'You were assigned {count} new shifts',
          excludeUserId: actor,
        });
      } else if (finalPublished && old.published && (old.date !== date || old.shiftTypeId !== shiftTypeId)) {
        const oldNames = await shiftDisplayNames(companyId, old.userId, old.shiftTypeId);
        notify({
          companyId, userIds: [userId], category: 'schedule', type: 'shift_changed',
          title: `Shift changed: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
          body: `Your shift changed from ${oldNames.shiftTypeName} on ${fmtDateLong(old.date)} to ${names.shiftTypeName} on ${fmtDateLong(date)}.`,
          link: 'my-schedule', bundleKey: `shift_changed:${userId}`,
          bundleTitle: '{count} of your shifts changed',
          excludeUserId: actor,
        });
      } else if (finalPublished && !old.published) {
        notify({
          companyId, userIds: [userId], category: 'schedule', type: 'shift_assigned',
          title: `Shift published: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(date)} is now published.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${userId}`,
          bundleTitle: 'You were assigned {count} new shifts',
          excludeUserId: actor,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] update shift failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/:id/publish-state — publish/unpublish one manual shift (owner/scheduler; department-scoped).
router.post('/shifts/:id/publish-state', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { published } = req.body ?? {};
    const { rows: srows } = await query(
      `SELECT s.date::text AS date, s.user_id AS "userId", s.shift_type_id AS "shiftTypeId", s.published
       FROM shifts s WHERE s.id = $1 AND s.company_id = $2`,
      [req.params.id, companyId]
    );
    if (srows.length) {
      if (!(await requireActiveDepartment(
        req, res,
        await assignmentRelevantDepartments(
          [{ userId: srows[0].userId, shiftTypeId: srows[0].shiftTypeId }], companyId)
      ))) return;
    }
    const { rowCount } = await query(
      'UPDATE shifts SET published = $1 WHERE id = $2 AND company_id = $3',
      [published !== false, req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Shift not found.' });
      return;
    }
    res.json({ ok: true, published: published !== false });
    if (srows.length) {
      const s = srows[0];
      const names = await shiftDisplayNames(companyId, s.userId, s.shiftTypeId);
      auditLog({
        companyId, date: s.date,
        action: published !== false ? 'published' : 'unpublished',
        personName: names.personName, shiftTypeName: names.shiftTypeName,
        source: 'manual', changedBy: req.session.userId!,
      });
      if (published !== false && !s.published) {
        notify({
          companyId, userIds: [s.userId], category: 'schedule', type: 'shift_assigned',
          title: `Shift published: ${names.shiftTypeName} on ${fmtDateLong(s.date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(s.date)} is now published.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${s.userId}`,
          bundleTitle: 'You were assigned {count} new shifts',
          excludeUserId: req.session.userId!,
        });
      } else if (published === false && s.published) {
        notify({
          companyId, userIds: [s.userId], category: 'schedule', type: 'shift_removed',
          title: `Shift unpublished: ${names.shiftTypeName} on ${fmtDateLong(s.date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(s.date)} was moved back to draft.`,
          link: 'my-schedule', bundleKey: `shift_removed:${s.userId}`,
          bundleTitle: '{count} of your shifts were removed',
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] shift publish-state failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rotation-shifts/publish-state — publish/unpublish one rotation shift instance (owner/scheduler; department-scoped).
// Body: { rotationId, userId, date, shiftTypeId, published }
router.post('/rotation-shifts/publish-state', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rotationId, userId, date, shiftTypeId, published } = req.body ?? {};
    if (!rotationId || !userId || !date || !shiftTypeId) {
      res.status(400).json({ error: 'rotationId, userId, date, and shiftTypeId are required.' });
      return;
    }
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments([{ userId, shiftTypeId }], companyId)
    ))) return;
    const { rows: prevRows } = await query(
      `SELECT published FROM rotation_shift_publish
       WHERE company_id = $1 AND rotation_id = $2 AND user_id = $3 AND date = $4 AND shift_type_id = $5`,
      [companyId, rotationId, userId, date, shiftTypeId]
    );
    const wasPublished = prevRows.length ? prevRows[0].published !== false : true;
    await query(
      `INSERT INTO rotation_shift_publish (company_id, rotation_id, user_id, date, shift_type_id, published)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, rotation_id, user_id, date, shift_type_id)
       DO UPDATE SET published = EXCLUDED.published`,
      [companyId, rotationId, userId, date, shiftTypeId, published !== false]
    );
    res.json({ ok: true, published: published !== false });
    if (wasPublished !== (published !== false)) {
      const names = await shiftDisplayNames(companyId, userId, shiftTypeId);
      if (published !== false) {
        notify({
          companyId, userIds: [userId], category: 'schedule', type: 'shift_assigned',
          title: `Shift published: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(date)} is now published.`,
          link: 'my-schedule', bundleKey: `shift_assigned:${userId}`,
          bundleTitle: 'You were assigned {count} new shifts',
          excludeUserId: req.session.userId!,
        });
      } else {
        notify({
          companyId, userIds: [userId], category: 'schedule', type: 'shift_removed',
          title: `Shift unpublished: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(date)} was moved back to draft.`,
          link: 'my-schedule', bundleKey: `shift_removed:${userId}`,
          bundleTitle: '{count} of your shifts were removed',
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] rotation shift publish-state failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/rotation-shifts — delete a rotation-generated shift instance (owner/scheduler; department-scoped).
// Body: { rotationId, userId, date, shiftTypeId }
router.post('/rotation-shifts/delete', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rotationId, userId, date, shiftTypeId } = req.body ?? {};
    if (!rotationId || !userId || !date) {
      res.status(400).json({ error: 'rotationId, userId, and date are required.' });
      return;
    }
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments([{ userId, shiftTypeId }], companyId)
    ))) return;
    await query(
      `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
      [companyId, rotationId, userId, date, shiftTypeId || null]
    );
    res.json({ ok: true });
    // Audit: rotation shift excluded (removed).
    const { rows: rrows } = await query(
      'SELECT name FROM rotations WHERE id = $1 AND company_id = $2',
      [rotationId, companyId]
    );
    const names = shiftTypeId ? await shiftDisplayNames(companyId, userId, shiftTypeId) : { personName: null, shiftTypeName: null };
    auditLog({
      companyId, date, action: 'rotation_excluded',
      personName: names.personName, shiftTypeName: names.shiftTypeName,
      source: 'rotation', rotationName: rrows[0]?.name || null,
      changedBy: req.session.userId!,
    });
    // Notify the person (rotation instances are published unless an
    // override says otherwise).
    if (shiftTypeId) {
      const { rows: prevRows } = await query(
        `SELECT published FROM rotation_shift_publish
         WHERE company_id = $1 AND rotation_id = $2 AND user_id = $3 AND date = $4 AND shift_type_id = $5`,
        [companyId, rotationId, userId, date, shiftTypeId]
      );
      const wasPublished = prevRows.length ? prevRows[0].published !== false : true;
      if (wasPublished) {
        notify({
          companyId, userIds: [userId], category: 'schedule', type: 'shift_removed',
          title: `Shift removed: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
          body: `Your ${names.shiftTypeName} shift on ${fmtDateLong(date)} was removed.`,
          link: 'my-schedule', bundleKey: `shift_removed:${userId}`,
          bundleTitle: '{count} of your shifts were removed',
          excludeUserId: req.session.userId!,
        });
      }
    }
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
      auditLog({ companyId, date: d, action: 'published', changedBy: req.session.userId! });
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
      auditLog({ companyId, date: d, action: 'unpublished', changedBy: req.session.userId! });
    }
    res.json({ ok: true, unpublished: dates.length });
  } catch (err) {
    console.error('[schedule] unpublish failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


// POST /api/schedule/shifts/bulk-publish-state — publish/unpublish specific members' shifts in a date range (owner/scheduler; department-scoped).
// Body: { dates:[...], userIds:[...], published: bool }. Handles manual + rotation shifts.
// Optional shiftTypeId limits the action to one shift type; with an empty
// userIds it applies to everyone in scope (active department / company).
router.post('/shifts/bulk-publish-state', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dates = Array.isArray(req.body?.dates) ? req.body.dates.filter(isValidDate) : [];
    let userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const published = req.body?.published !== false;
    // Optional shift-type filter (Bulk Actions tab): limits the action to
    // one shift type. Must belong to this company.
    const shiftTypeId = typeof req.body?.shiftTypeId === 'string' && req.body.shiftTypeId ? req.body.shiftTypeId : '';
    if (!dates.length || (!userIds.length && !shiftTypeId)) {
      res.status(400).json({ error: 'Dates and team members are required.' });
      return;
    }
    if (shiftTypeId) {
      const stRows = await query('SELECT id FROM shift_types WHERE id = $1 AND company_id = $2', [shiftTypeId, companyId]);
      if (!stRows.rows.length) {
        res.status(400).json({ error: 'Unknown shift type.' });
        return;
      }
    }
    // Department scoping: members given → their home departments (unchanged).
    // No members + filter → the shift type's departments; the user list then
    // resolves to the active department (scheduler) or company-wide (owner).
    const deptCheck = userIds.length
      ? await requireActiveDepartment(
        req, res,
        await usersDepartmentIds(userIds, companyId)
      )
      : await requireActiveDepartment(
        req, res,
        await shiftTypesDepartmentIds([shiftTypeId], companyId)
      );
    if (!deptCheck) return;
    if (!userIds.length) {
      const scopeSql = deptCheck.departmentId
        ? 'SELECT id FROM users WHERE company_id = $1 AND is_active = true AND department_id = $2'
        : 'SELECT id FROM users WHERE company_id = $1 AND is_active = true';
      const scopeParams = deptCheck.departmentId ? [companyId, deptCheck.departmentId] : [companyId];
      const { rows: allUsers } = await query(scopeSql, scopeParams);
      userIds = allUsers.map((r: any) => r.id);
      if (!userIds.length) {
        res.status(400).json({ error: 'No team members found.' });
        return;
      }
    }
    // Manual shifts — capture the rows that will flip so their people
    // can be told (published-only rule: flips are the notification).
    const typeFilter = shiftTypeId ? ` AND shift_type_id = $${5}` : '';
    const typeParams = shiftTypeId ? [shiftTypeId] : [];
    const { rows: flipRows } = await query(
      `SELECT user_id, date::text AS date FROM shifts
       WHERE company_id = $1 AND date = ANY($2::date[]) AND user_id = ANY($3::uuid[]) AND published = $4${typeFilter}`,
      [companyId, dates, userIds, !published, ...typeParams]
    );
    const { rowCount } = await query(
      `UPDATE shifts SET published = $1
       WHERE company_id = $2 AND date = ANY($3::date[]) AND user_id = ANY($4::uuid[])${typeFilter}`,
      [published, companyId, dates, userIds, ...typeParams]
    );
    // Rotation shifts: generate instances and upsert publish overrides
    let rotCount = 0;
    const rotFlips = new Map<string, number>();
    const { rows: rotations } = await query(
      `SELECT id, cycle_days AS "cycleDays", start_date::text AS "startDate"
       FROM rotations WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    for (const rot of rotations) {
      const rotTypeFilter = shiftTypeId ? ' AND shift_type_id = $3' : '';
      const rotTypeParams = shiftTypeId ? [shiftTypeId] : [];
      const { rows: assignments } = await query(
        `SELECT user_id AS "userId", cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId"
         FROM rotation_assignments WHERE rotation_id = $1 AND user_id = ANY($2::uuid[])${rotTypeFilter}`,
        [rot.id, userIds, ...rotTypeParams]
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
          const { rows: prevRows } = await query(
            `SELECT published FROM rotation_shift_publish
             WHERE company_id = $1 AND rotation_id = $2 AND user_id = $3 AND date = $4 AND shift_type_id = $5`,
            [companyId, rot.id, a.userId, dateStr, a.shiftTypeId]
          );
          const wasPublished = prevRows.length ? prevRows[0].published !== false : true;
          await query(
            `INSERT INTO rotation_shift_publish (company_id, rotation_id, user_id, date, shift_type_id, published)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (company_id, rotation_id, user_id, date, shift_type_id)
             DO UPDATE SET published = EXCLUDED.published`,
            [companyId, rot.id, a.userId, dateStr, a.shiftTypeId, published]
          );
          if (wasPublished !== published) rotFlips.set(a.userId, (rotFlips.get(a.userId) || 0) + 1);
          rotCount++;
        }
      }
    }
    res.json({ ok: true, updated: (rowCount || 0) + rotCount });
    // Notify per person about the flips (manual + rotation combined).
    {
      const perUser = new Map<string, { count: number; firstDate: string; lastDate: string }>();
      for (const r of flipRows) {
        const t = perUser.get(r.user_id) || { count: 0, firstDate: r.date, lastDate: r.date };
        t.count++;
        if (r.date < t.firstDate) t.firstDate = r.date;
        if (r.date > t.lastDate) t.lastDate = r.date;
        perUser.set(r.user_id, t);
      }
      for (const [uid, n] of rotFlips) {
        const t = perUser.get(uid) || { count: 0, firstDate: dates[0], lastDate: dates[dates.length - 1] };
        t.count += n;
        perUser.set(uid, t);
      }
      const sortedDates = dates.slice().sort();
      for (const [uid, t] of perUser) {
        if (published) {
          notify({
            companyId, userIds: [uid], category: 'schedule', type: 'schedule_published',
            title: `Your schedule was published: ${t.count} shift(s), ${fmtDateLong(t.firstDate)} – ${fmtDateLong(t.lastDate)}`,
            body: `${t.count} of your shifts between ${fmtDateLong(t.firstDate)} and ${fmtDateLong(t.lastDate)} are now published.`,
            link: 'my-schedule', bundleKey: `schedule_published:${uid}`,
            bundleTitle: 'Your schedule was published: {count} shift(s)',
            payload: { count: t.count },
            excludeUserId: req.session.userId!,
          });
        } else {
          notify({
            companyId, userIds: [uid], category: 'schedule', type: 'shift_removed',
            title: `${t.count} of your shifts were unpublished (${fmtDateLong(sortedDates[0])} – ${fmtDateLong(sortedDates[sortedDates.length - 1])})`,
            body: `${t.count} of your published shifts were moved back to draft.`,
            link: 'my-schedule', bundleKey: `shift_removed:${uid}`,
            bundleTitle: '{count} of your shifts were removed',
            payload: { count: t.count },
            excludeUserId: req.session.userId!,
          });
        }
      }
    }
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

// POST /api/schedule/rotations — create (owner/scheduler; department-scoped).
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
    // Department scoping: the scheduler's active department must be one of
    // the departments touched by the assignments.
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments(Array.isArray(assignments) ? assignments : [], companyId)
    ))) return;
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
    // Audit: rotation created.
    await auditLog({
      companyId, date: todayStr(), action: 'created', category: 'settings',
      source: 'manual', rotationName: String(name).trim(),
      changedBy: req.session.userId!,
      description: `Created rotation "${String(name).trim()}"`,
      details: { rotationId: id, kind: 'rotation' },
    });
    res.status(201).json({ id });
  } catch (err) {
    console.error('[schedule] create rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rotations/:id/apply — generate shifts from rotation
// over a date range (owner/scheduler; department-scoped). Skips dates that already have the
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
    // Department scoping: the scheduler's active department must be one of the
    // rotation's departments (shift type departments or member home departments).
    if (!(await requireActiveDepartment(req, res, await rotationRelevantDepartments(req.params.id)))) return;
    const rot = rots[0];
    const { rows: asg } = await query(
      'SELECT user_id AS "userId", cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId" FROM rotation_assignments WHERE rotation_id = $1',
      [rot.id]
    );
    const startMs = Date.parse(rot.startDate + 'T00:00:00Z');
    const fromMs = Date.parse(from + 'T00:00:00Z');
    const toMs = Date.parse(to + 'T00:00:00Z');
    let created = 0;
    const perUser = new Map<string, { count: number; shiftTypeId: string }>();
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
          const t = perUser.get(a.userId) || { count: 0, shiftTypeId: a.shiftTypeId };
          t.count++;
          perUser.set(a.userId, t);
        } catch { /* skip duplicates */ }
      }
    }
    res.json({ ok: true, created });
    // Notify assignees (rotation rows are published by default).
    for (const [uid, t] of perUser) {
      const names = await shiftDisplayNames(companyId, uid, t.shiftTypeId);
      notify({
        companyId, userIds: [uid], category: 'schedule', type: 'shift_assigned',
        title: `You were assigned ${t.count} shifts: ${names.shiftTypeName}, ${fmtDateLong(from)} – ${fmtDateLong(to)}`,
        body: `${t.count} ${names.shiftTypeName} shift(s) from a rotation, ${fmtDateLong(from)} to ${fmtDateLong(to)}.`,
        link: 'my-schedule', bundleKey: `shift_assigned:${uid}`,
        bundleTitle: 'You were assigned {count} new shifts',
        payload: { count: t.count },
        excludeUserId: req.session.userId!,
      });
    }
  } catch (err) {
    console.error('[schedule] apply rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/rotations/:id (owner/scheduler; department-scoped).
router.delete('/rotations/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: rrows } = await query(
      'SELECT name FROM rotations WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    // Department scoping: the scheduler's active department must be one of the rotation's departments.
    if (!(await requireActiveDepartment(req, res, await rotationRelevantDepartments(req.params.id)))) return;
    const { rowCount } = await query(
      'DELETE FROM rotations WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Rotation not found.' });
      return;
    }
    const rotName = rrows[0]?.name || 'Rotation';
    await auditLog({
      companyId, date: todayStr(), action: 'deleted', category: 'settings',
      source: 'manual', rotationName: rrows[0]?.name || null,
      changedBy: req.session.userId!,
      description: `Deleted rotation "${rotName}"`,
      details: { rotationId: req.params.id, kind: 'rotation' },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/schedule/rotations/:id — toggle active/paused (owner/scheduler; department-scoped)
router.patch('/rotations/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { isActive } = req.body ?? {};
    if (typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'isActive (boolean) is required.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of the rotation's departments.
    if (!(await requireActiveDepartment(req, res, await rotationRelevantDepartments(req.params.id)))) return;
    const { rows } = await query(
      'UPDATE rotations SET is_active = $1 WHERE id = $2 AND company_id = $3 RETURNING id, is_active AS "isActive"',
      [isActive, req.params.id, companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Rotation not found.' });
      return;
    }
    const { rows: rnRows } = await query(
      'SELECT name FROM rotations WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    const tglName = rnRows.length ? rnRows[0].name : 'Rotation';
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      source: 'manual', rotationName: tglName, changedBy: req.session.userId!,
      description: `${isActive ? 'Activated' : 'Paused'} rotation "${tglName}"`,
    });
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

// POST /api/schedule/rotations/:id/pauses — add a pause period (owner/scheduler; department-scoped)
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
    // Department scoping: the scheduler's active department must be one of the rotation's departments.
    if (!(await requireActiveDepartment(req, res, await rotationRelevantDepartments(req.params.id)))) return;
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

// DELETE /api/schedule/rotations/:id/pauses/:pauseId — remove a pause period (owner/scheduler; department-scoped)
router.delete('/rotations/:id/pauses/:pauseId', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    // Department scoping: the scheduler's active department must be one of the rotation's departments.
    if (!(await requireActiveDepartment(req, res, await rotationRelevantDepartments(req.params.id)))) return;
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

// PUT /api/schedule/rotations/:id/pauses/:pauseId — update a pause period's dates/reason (owner/scheduler; department-scoped)
router.put('/rotations/:id/pauses/:pauseId', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { startDate, endDate, reason } = req.body ?? {};
    if (!isValidDate(startDate) || !isValidDate(endDate) || startDate > endDate) {
      res.status(400).json({ error: 'Valid start and end dates are required.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of the rotation's departments.
    if (!(await requireActiveDepartment(req, res, await rotationRelevantDepartments(req.params.id)))) return;
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
// Department-scoped for schedulers (view scope); owner sees all.
router.get('/staffing-targets', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await ensureShiftTypes(companyId);
    const { rows } = await query(
      `SELECT st.id AS "shiftTypeId", st.name, st.color,
              COALESCE(t.target_count, 0) AS "targetCount",
              COALESCE(t.weekdays, '{0,1,2,3,4,5,6}') AS weekdays,
              t.start_date::text AS "startDate", t.end_date::text AS "endDate",
              COALESCE((SELECT json_agg(std.department_id) FROM shift_type_departments std WHERE std.shift_type_id = st.id), '[]') AS "departmentIds"
       FROM shift_types st
       LEFT JOIN staffing_targets t ON t.shift_type_id = st.id AND t.company_id = $1
       WHERE st.company_id = $1 AND st.is_active = true
       ORDER BY st.sort_order, st.name`,
      [companyId]
    );
    // Department scoping: schedulers see targets for shift types they can view
    // (any of the type's departments, or department-less "global" types).
    let targets = rows;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      targets = rows.filter((t: any) => {
        const depts: string[] = t.departmentIds || [];
        return !depts.length || depts.some((d) => access.view.includes(d));
      });
    }
    res.json({ targets });
  } catch (err) {
    console.error('[schedule] list staffing targets failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/staffing-targets — save all targets (owner/scheduler; department-scoped).
router.put('/staffing-targets', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const targets = req.body.targets;
    if (!Array.isArray(targets)) {
      res.status(400).json({ error: 'targets must be an array.' });
      return;
    }
    // Department scoping: the scheduler's active department must be one of the
    // targeted shift types' departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds(targets.map((t: any) => t?.shiftTypeId), companyId)
    ))) return;
    const savedNames: string[] = [];
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
      savedNames.push(`${t.shiftTypeId}:${count}`);
    }
    if (targets.length) {
      const { rows: stNames } = await query(
        `SELECT id, name FROM shift_types WHERE id = ANY($1) AND company_id = $2`,
        [targets.map((t: any) => t.shiftTypeId), companyId]
      );
      const nameById: any = {};
      stNames.forEach((r: any) => { nameById[r.id] = r.name; });
      const desc = targets.map((t: any) =>
        `"${nameById[t.shiftTypeId] || 'shift'}" → ${Math.min(20, Math.max(0, parseInt(t.targetCount) || 0))}`
      ).join(', ');
      await auditLog({
        companyId, date: todayStr(), action: 'updated', category: 'settings',
        source: 'manual', changedBy: req.session.userId!,
        description: `Set staffing targets: ${desc}`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] save staffing targets failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Notification settings — who gets Email AI approve/reject emails.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// General settings — per-company app customization (owner + scheduler).
// ---------------------------------------------------------------------------
const GENERAL_DEFAULTS: Record<string, string> = {
  company_display_name: '',
  timezone: 'America/Chicago',
  week_start: 'monday',
  date_format: 'mdy',      // mdy | dmy | ymd
  time_format: '12h',      // 12h | 24h
  default_view: 'week',    // day | week | month
};

// Personal per-user settings (each person chooses their own).
const PERSONAL_DEFAULTS: Record<string, string> = {
  theme: 'system',         // light | dark | system
  header_color: '',        // hex, empty = theme default
  footer_color: '',        // hex, empty = theme default
};

// GET /api/schedule/general-settings
router.get('/general-settings', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT key, value FROM company_settings WHERE company_id = $1', [companyId]);
    const settings = { ...GENERAL_DEFAULTS };
    for (const r of rows) settings[r.key] = r.value;
    res.json({ settings });
  } catch (err) {
    console.error('[schedule] get general settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/general-settings — owner + scheduler (admin-level setting).
router.put('/general-settings', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const body = req.body || {};
    const allowed = Object.keys(GENERAL_DEFAULTS);
    // Validate values.
    if (body.week_start && !['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].includes(body.week_start))
      { res.status(400).json({ error: 'Invalid week start day.' }); return; }
    if (body.date_format && !['mdy', 'dmy', 'ymd'].includes(body.date_format))
      { res.status(400).json({ error: 'Invalid date format.' }); return; }
    if (body.time_format && !['12h', '24h'].includes(body.time_format))
      { res.status(400).json({ error: 'Invalid time format.' }); return; }
    if (body.default_view && !['day', 'week', 'month'].includes(body.default_view))
      { res.status(400).json({ error: 'Invalid default view.' }); return; }
    if (body.timezone && !/^[A-Za-z_]+\/[A-Za-z_]+$/.test(body.timezone))
      { res.status(400).json({ error: 'Invalid timezone.' }); return; }
    const changed: string[] = [];
    for (const k of allowed) {
      if (body[k] !== undefined) {
        const v = String(body[k]).slice(0, 200);
        await query(
          `INSERT INTO company_settings (company_id, key, value, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [companyId, k, v]);
        changed.push(k);
      }
    }
    try {
      const { auditLog, todayStr } = await import('../util/audit.js');
      if (changed.length) await auditLog({
        companyId, date: todayStr(), action: 'updated',
        source: 'manual', category: 'settings',
        changedBy: (req.session as any)?.userId || null,
        description: `General settings updated: ${changed.join(', ')}`,
      });
    } catch {}
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] put general settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Personal settings — per-user appearance (theme, header/footer colors).
// ---------------------------------------------------------------------------

// GET /api/schedule/personal-settings — any signed-in user (their own).
router.get('/personal-settings', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const { rows } = await query(
      'SELECT key, value FROM user_settings WHERE user_id = $1', [userId]);
    const settings = { ...PERSONAL_DEFAULTS };
    for (const r of rows) settings[r.key] = r.value;
    res.json({ settings });
  } catch (err) {
    console.error('[schedule] get personal settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/personal-settings — any signed-in user (their own).
router.put('/personal-settings', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const userId = req.session.userId!;
    const body = req.body || {};
    if (body.theme && !['light', 'dark', 'system'].includes(body.theme))
      { res.status(400).json({ error: 'Invalid theme.' }); return; }
    for (const ck of ['header_color', 'footer_color']) {
      if (body[ck] && !/^#[0-9a-fA-F]{6}$/.test(body[ck]))
        { res.status(400).json({ error: 'Colors must be hex like #1a73e8.' }); return; }
    }
    const allowed = Object.keys(PERSONAL_DEFAULTS);
    for (const k of allowed) {
      if (body[k] !== undefined) {
        const v = String(body[k]).slice(0, 200);
        await query(
          `INSERT INTO user_settings (user_id, key, value, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [userId, k, v]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] put personal settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/notification-settings — owner only.
router.get('/notification-settings', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT notify_owner, notify_schedulers FROM company_notification_settings WHERE company_id = $1',
      [companyId]
    );
    res.json(rows.length ? rows[0] : { notify_owner: true, notify_schedulers: true });
  } catch (err) {
    console.error('[schedule] get notification settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Email AI notification settings — per-department primary + CC recipients.
// ---------------------------------------------------------------------------

// GET /api/schedule/dept-notifications — owner sees all; scheduler sees own edit departments.
router.get('/dept-notifications', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const role = (req.session as any)?.role;
    const userId = (req.session as any)?.userId;
    let deptFilter = '';
    let deptParams: any[] = [companyId];
    if (role !== 'owner') {
      const access = await getDepartmentAccess(userId, companyId);
      if (!access.edit.length) { res.json({ departments: [], users: [] }); return; }
      deptFilter = ' AND d.id = ANY($2)';
      deptParams.push(access.edit);
    }
    const { rows: depts } = await query(`SELECT d.id, d.name FROM departments d WHERE d.company_id = $1${deptFilter} ORDER BY d.name`, deptParams);
    const { rows: settings } = await query('SELECT department_id, primary_user_id, cc_user_ids, extra_emails FROM department_notification_settings WHERE company_id = $1', [companyId]);
    const byDept: any = {};
    settings.forEach((s: any) => { byDept[s.department_id] = s; });
    const { rows: users } = await query(
      "SELECT id, first_name, last_name, email, role FROM users WHERE company_id = $1 AND is_active = true AND role IN ('owner','scheduler') ORDER BY first_name, last_name",
      [companyId]
    );
    res.json({
      departments: depts.map((d: any) => ({
        id: d.id, name: d.name,
        primaryUserId: byDept[d.id]?.primary_user_id || null,
        ccUserIds: byDept[d.id]?.cc_user_ids || [],
        extraEmails: byDept[d.id]?.extra_emails || [],
      })),
      users: users.map((u: any) => ({ id: u.id, name: (u.first_name + ' ' + u.last_name).trim(), email: u.email, role: u.role })),
    });
  } catch (err) {
    console.error('[schedule] get dept notifications failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/dept-notifications — owner: all departments; scheduler: only own edit departments.
router.put('/dept-notifications', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const role = (req.session as any)?.role;
    const userId = (req.session as any)?.userId;
    let allowedDepts: Set<string> | null = null;
    if (role !== 'owner') {
      const access = await getDepartmentAccess(userId, companyId);
      allowedDepts = new Set(access.edit);
    }
    const settings = req.body.settings;
    if (!Array.isArray(settings)) { res.status(400).json({ error: 'settings must be an array.' }); return; }
    for (const s of settings) {
      if (!s.departmentId) continue;
      if (allowedDepts && !allowedDepts.has(s.departmentId)) continue;
      const { rows: drows } = await query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [s.departmentId, companyId]);
      if (!drows.length) continue;
      const primaryUserId = s.primaryUserId || null;
      const ccUserIds = Array.isArray(s.ccUserIds) ? s.ccUserIds.filter(Boolean) : [];
      const extraEmails = Array.isArray(s.extraEmails)
        ? [...new Set(s.extraEmails.map((e: string) => String(e).trim().toLowerCase()).filter((e: string) => e.includes('@')))]
        : [];
      await query(
        `INSERT INTO department_notification_settings (department_id, company_id, primary_user_id, cc_user_ids, extra_emails, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (department_id) DO UPDATE SET primary_user_id = $3, cc_user_ids = $4, extra_emails = $5, updated_at = now()`,
        [s.departmentId, companyId, primaryUserId, ccUserIds, extraEmails]
      );
    }
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      description: 'Updated Email Q-Scheduler notification recipients',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] save dept notifications failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/notification-settings — owner only (legacy).
router.put('/notification-settings', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const notifyOwner = req.body.notifyOwner !== false;
    const notifySchedulers = req.body.notifySchedulers === true;
    await query(
      `INSERT INTO company_notification_settings (company_id, notify_owner, notify_schedulers, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (company_id) DO UPDATE SET notify_owner = $2, notify_schedulers = $3, updated_at = now()`,
      [companyId, notifyOwner, notifySchedulers]
    );
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      description: 'Updated notification settings',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] save notification settings failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Shift settings — default start/end times per shift type.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-company email inbox — Settings → Email inbox (owner only).
// Each company connects its OWN Gmail mailbox for Email Q-Scheduler.
// The app password is stored encrypted and NEVER returned by any route.
// ---------------------------------------------------------------------------

// GET /api/schedule/email-inbox — connection status (no password, ever).
router.get('/email-inbox', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT gmail_user, is_active, last_polled_at, last_error FROM company_inboxes WHERE company_id = $1',
      [companyId]
    );
    if (rows.length) {
      res.json({
        connected: true, gmailUser: rows[0].gmail_user, isActive: rows[0].is_active,
        lastPolledAt: rows[0].last_polled_at, lastError: rows[0].last_error, legacyFallback: false,
      });
      return;
    }
    // No inbox row: the legacy single env inbox covers this company only if
    // it is pinned to it (or no company is pinned).
    const legacy = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
      && (!process.env.GMAIL_COMPANY_ID || process.env.GMAIL_COMPANY_ID === companyId);
    res.json({
      connected: false, gmailUser: null, isActive: false,
      lastPolledAt: null, lastError: null, legacyFallback: legacy,
      legacyUser: legacy ? process.env.GMAIL_USER : null,
    });
  } catch (err) {
    console.error('[schedule] get email inbox failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/email-inbox — connect (or update) this company's inbox.
router.put('/email-inbox', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const gmailUser = String(req.body.gmailUser || '').trim().toLowerCase();
    const appPassword = String(req.body.appPassword || '').replace(/\s+/g, '');
    const isActive = req.body.isActive !== false;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gmailUser)) { res.status(400).json({ error: 'Enter a valid Gmail address.' }); return; }
    if (!appPassword || appPassword.length < 8) { res.status(400).json({ error: 'Enter the 16-character Gmail app password (spaces are fine — they are stripped).' }); return; }
    const { encryptInboxPassword, hasDedicatedInboxKey } = await import('../util/inboxCrypto.js');
    if (!hasDedicatedInboxKey()) {
      console.warn('[schedule] Saving inbox without COMPANY_INBOX_KEY (key derived from SESSION_SECRET). Set COMPANY_INBOX_KEY in Render before real customers connect inboxes.');
    }
    await query(
      `INSERT INTO company_inboxes (company_id, gmail_user, gmail_app_password_enc, is_active, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (company_id) DO UPDATE SET gmail_user = $2, gmail_app_password_enc = $3, is_active = $4, updated_at = now(), last_error = NULL`,
      [companyId, gmailUser, encryptInboxPassword(appPassword), isActive]
    );
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      description: `Connected email inbox ${gmailUser}`,
    });
    res.json({ ok: true, gmailUser });
  } catch (err) {
    console.error('[schedule] save email inbox failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/email-inbox/test — verify IMAP login works.
// Tests the stored inbox, or body creds (unsaved) when given.
router.post('/email-inbox/test', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    let creds: { user: string; password: string } | undefined;
    const bodyUser = String(req.body.gmailUser || '').trim().toLowerCase();
    const bodyPass = String(req.body.appPassword || '').replace(/\s+/g, '');
    if (bodyUser && bodyPass) {
      creds = { user: bodyUser, password: bodyPass };
    } else {
      const { rows } = await query('SELECT gmail_user, gmail_app_password_enc FROM company_inboxes WHERE company_id = $1', [companyId]);
      if (!rows.length) { res.status(400).json({ ok: false, error: 'No inbox connected yet.' }); return; }
      const { decryptInboxPassword } = await import('../util/inboxCrypto.js');
      creds = { user: rows[0].gmail_user, password: decryptInboxPassword(rows[0].gmail_app_password_enc) };
    }
    const { listUnreadUids } = await import('../util/gmailImap.js');
    const uids = await listUnreadUids(1, creds);
    res.json({ ok: true, unread: uids.length });
  } catch (err: any) {
    console.error('[schedule] email inbox test failed:', err.message);
    res.json({ ok: false, error: 'Could not sign in to that mailbox. Check the address and app password — the Gmail account needs 2-Step Verification on, and the password must be a Gmail app password, not your normal password.' });
  }
});

// DELETE /api/schedule/email-inbox — disconnect (falls back to legacy env inbox, if any).
router.delete('/email-inbox', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM company_inboxes WHERE company_id = $1', [companyId]);
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      description: 'Disconnected email inbox',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete email inbox failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/inbound-addresses — this company's in-app addresses
// (owner only). Local parts are shown in full when a sending domain is
// configured; until then the address is the local part alone.
router.get('/inbound-addresses', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT ia.id, ia.department_id, ia.local_part, ia.is_active, d.name AS department_name
       FROM inbound_addresses ia
       LEFT JOIN departments d ON d.id = ia.department_id
       WHERE ia.company_id = $1 ORDER BY d.name NULLS FIRST, ia.local_part`,
      [companyId]
    );
    res.json({
      domainConfigured: !!inboundDomain(),
      addresses: rows.map((r: any) => ({
        id: r.id, departmentId: r.department_id, departmentName: r.department_name,
        localPart: r.local_part, address: fullInboundAddress(r.local_part), isActive: r.is_active,
      })),
    });
  } catch (err) {
    console.error('[schedule] list inbound addresses failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/inbound-addresses/ensure — get or create the address
// for a department (or the company when departmentId is omitted). Owner only.
router.post('/inbound-addresses/ensure', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const departmentId = req.body.departmentId ? String(req.body.departmentId) : null;
    const row = await ensureInboundAddress(query, companyId, departmentId);
    res.json({ id: row.id, departmentId: row.department_id, localPart: row.local_part, address: fullInboundAddress(row.local_part), isActive: row.is_active });
  } catch (err: any) {
    console.error('[schedule] ensure inbound address failed:', err);
    res.status(400).json({ error: err?.message || 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/shift-types/:id — update (owner/scheduler).
router.put('/shift-types/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { startTime, endTime, name, color, departmentId, departmentIds, eligibleJobRoleIds } = req.body;
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
    var deptIdsForJoin: string[] | null = null;
    if (departmentIds !== undefined || departmentId !== undefined) {
      const rawIds: string[] = Array.isArray(departmentIds) ? departmentIds : (departmentId ? [departmentId] : []);
      deptIdsForJoin = [];
      for (const d of rawIds) {
        const { rows: dept } = await query(
          'SELECT id FROM departments WHERE id = $1 AND company_id = $2',
          [String(d), companyId]
        );
        if (!dept.length) { res.status(400).json({ error: 'Department not found.' }); return; }
        deptIdsForJoin.push(dept[0].id);
      }
      updates.push(`department_id = $${i++}`); vals.push(deptIdsForJoin[0] || null);
    }
    // Eligible job roles: each must belong to the shift type's (effective)
    // department(s); empty list = everyone eligible.
    if (eligibleJobRoleIds !== undefined) {
      const effectiveDepts = deptIdsForJoin !== null
        ? deptIdsForJoin
        : await shiftTypesDepartmentIds([req.params.id], companyId);
      const elig = await validateEligibleRoles(eligibleJobRoleIds, companyId, effectiveDepts);
      if (!elig.ok) {
        res.status(400).json({ error: elig.error });
        return;
      }
      updates.push(`eligible_job_role_ids = $${i++}`); vals.push(elig.ids);
    }
    if (!updates.length) { res.status(400).json({ error: 'Nothing to update.' }); return; }
    // Department scoping: the scheduler's active department must be one of the
    // shift type's current or incoming departments.
    {
      const existing = await shiftTypesDepartmentIds([req.params.id], companyId);
      const relevant = deptIdsForJoin !== null ? [...new Set([...existing, ...deptIdsForJoin])] : existing;
      if (!(await requireActiveDepartment(req, res, relevant))) return;
    }
    vals.push(req.params.id, companyId);
    const { rowCount } = await query(
      `UPDATE shift_types SET ${updates.join(', ')} WHERE id = $${i++} AND company_id = $${i}`,
      vals
    );
    if (!rowCount) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    if (deptIdsForJoin !== null) {
      await query('DELETE FROM shift_type_departments WHERE shift_type_id = $1', [req.params.id]);
      for (const dd of deptIdsForJoin) {
        await query(
          'INSERT INTO shift_type_departments (shift_type_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [req.params.id, dd]
        );
      }
    }
    const { rows: strows } = await query('SELECT name FROM shift_types WHERE id = $1', [req.params.id]);
    const stName = strows[0] ? strows[0].name : 'Shift type';
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      shiftTypeName: stName, source: 'manual', changedBy: req.session.userId!,
      description: `Updated shift type "${stName}"`,
      details: { shiftTypeId: req.params.id, kind: 'shift_type' },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update shift type failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/shift-types/:id — delete (owner/scheduler; department-scoped).
// Shifts using this type are kept; the type is deactivated instead if in use.
router.delete('/shift-types/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    // Department scoping: the scheduler's active department must be one of the shift type's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds([req.params.id], companyId)
    ))) return;
    const { rows } = await query(
      'SELECT id FROM shifts WHERE shift_type_id = $1 AND company_id = $2 LIMIT 1',
      [req.params.id, companyId]
    );
    const { rows: stNameRows } = await query(
      'SELECT name FROM shift_types WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    const delName = stNameRows.length ? stNameRows[0].name : 'Shift type';
    if (rows.length) {
      await query(
        'UPDATE shift_types SET is_active = false WHERE id = $1 AND company_id = $2',
        [req.params.id, companyId]
      );
      await auditLog({
        companyId, date: todayStr(), action: 'deleted', category: 'settings',
        shiftTypeName: delName, source: 'manual', changedBy: req.session.userId!,
        description: `Deactivated shift type "${delName}" (in use)`,
      });
    } else {
      const { rowCount } = await query(
        'DELETE FROM shift_types WHERE id = $1 AND company_id = $2',
        [req.params.id, companyId]
      );
      if (!rowCount) { res.status(404).json({ error: 'Shift type not found.' }); return; }
      await auditLog({
        companyId, date: todayStr(), action: 'deleted', category: 'settings',
        shiftTypeName: delName, source: 'manual', changedBy: req.session.userId!,
        description: `Deleted shift type "${delName}"`,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete shift type failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shift-types/:id/restore — reactivate a soft-deleted shift type (owner/scheduler; department-scoped).
router.post('/shift-types/:id/restore', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    // Department scoping: the scheduler's active department must be one of the shift type's departments.
    if (!(await requireActiveDepartment(
      req, res,
      await shiftTypesDepartmentIds([req.params.id], companyId)
    ))) return;
    const { rowCount } = await query(
      'UPDATE shift_types SET is_active = true WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    const { rows: rsRows } = await query(
      'SELECT name FROM shift_types WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    const rsName = rsRows.length ? rsRows[0].name : 'Shift type';
    await auditLog({
      companyId, date: todayStr(), action: 'created', category: 'settings',
      shiftTypeName: rsName, source: 'manual', changedBy: req.session.userId!,
      description: `Restored shift type "${rsName}"`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] restore shift type failed:', err);
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
// Returns only published shifts (per-shift state; the date itself does not
// need to be published — departments publish on their own cadence).
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
    // Only published shifts. Optionally scoped to a department and/or shift type.
    const shiftParams: any[] = [companyId, from, to];
    let extraFilter = '';
    if (deptId) { shiftParams.push(deptId); extraFilter += ` AND (u.department_id = $${shiftParams.length} OR EXISTS (SELECT 1 FROM shift_type_departments std WHERE std.shift_type_id = s.shift_type_id AND std.department_id = $${shiftParams.length}))`; }
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
// ---------------------------------------------------------------------------
// Pickup links — no-login page showing ONLY open shifts in a date range.
// Staff pick their name and tap to pick up a shift (direct assignment).
// ---------------------------------------------------------------------------

// POST /api/schedule/pickup-links — create a pickup link (owner/scheduler).
// Body: { from, to, departmentId?, shiftTypeId?, label? }
router.post('/pickup-links', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to, departmentId, shiftTypeId, shiftTypeIds, label } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      res.status(400).json({ error: 'Valid from/to dates are required.' }); return;
    }
    // Limit range to 90 days.
    const days = (new Date(to).getTime() - new Date(from).getTime()) / 86400000;
    if (days > 90) { res.status(400).json({ error: 'Date range is limited to 90 days.' }); return; }
    let deptId: string | null = null;
    if (departmentId) {
      const { rows: drows } = await query('SELECT id FROM departments WHERE id = $1 AND company_id = $2', [departmentId, companyId]);
      if (!drows.length) { res.status(404).json({ error: 'Department not found.' }); return; }
      deptId = drows[0].id;
    }
    let stIds: string[] = [];
    const rawIds: string[] = Array.isArray(shiftTypeIds) && shiftTypeIds.length ? shiftTypeIds : (shiftTypeId ? [shiftTypeId] : []);
    if (rawIds.length) {
      const { rows: srows } = await query(
        'SELECT id FROM shift_types WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active = true',
        [rawIds, companyId]);
      stIds = srows.map((r: any) => r.id);
      if (!stIds.length) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    }
    const token = crypto.randomBytes(32).toString('hex');
    const { rows } = await query(
      `INSERT INTO pickup_links (company_id, token_hash, label, from_date, to_date, department_id, shift_type_id, shift_type_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [companyId, hashShareToken(token), label ? String(label).slice(0, 120) : null, from, to, deptId,
       stIds.length === 1 ? stIds[0] : null, stIds.length ? stIds : null]
    );
    const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.status(201).json({ id: rows[0].id, pickupLink: `${base}/pickup.html?t=${token}` });
  } catch (err) {
    console.error('[schedule] create pickup link failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/pickup-links — list (owner/scheduler).
router.get('/pickup-links', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT p.id, p.label, p.from_date::text AS "from", p.to_date::text AS "to",
              p.created_at AS "createdAt",
              d.name AS "departmentName",
              COALESCE(
                (SELECT string_agg(st2.name, ', ' ORDER BY st2.sort_order)
                 FROM shift_types st2 WHERE st2.id = ANY(p.shift_type_ids)),
                st.name
              ) AS "shiftTypeName"
       FROM pickup_links p
       LEFT JOIN departments d ON d.id = p.department_id
       LEFT JOIN shift_types st ON st.id = p.shift_type_id
       WHERE p.company_id = $1 ORDER BY p.created_at DESC`,
      [companyId]
    );
    res.json({ links: rows });
  } catch (err) {
    console.error('[schedule] list pickup links failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/pickup-links/:id — disable (owner/scheduler).
router.delete('/pickup-links/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query('DELETE FROM pickup_links WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete pickup link failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/pickup/:token — public: ONLY open slots in range + team names. No login.
router.get('/pickup/:token', async (req: Request, res: Response) => {
  try {
    const { rows: links } = await query(
      `SELECT company_id, from_date::text AS "from", to_date::text AS "to",
              department_id, shift_type_id, shift_type_ids, label
       FROM pickup_links WHERE token_hash = $1`,
      [hashShareToken(req.params.token)]
    );
    if (!links.length) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    const pl = links[0];
    const companyId = pl.company_id;
    // Shift types (optionally filtered).
    const typeParams: any[] = [companyId];
    let typeFilter = '';
    const effTypeIds: string[] = Array.isArray(pl.shift_type_ids) && pl.shift_type_ids.length
      ? pl.shift_type_ids : (pl.shift_type_id ? [pl.shift_type_id] : []);
    if (effTypeIds.length) { typeParams.push(effTypeIds); typeFilter = 'AND st.id = ANY($2::uuid[])'; }
    const { rows: types } = await query(
      `SELECT st.id, st.name, st.sort_order AS "sortOrder" FROM shift_types st
       WHERE st.company_id = $1 AND st.is_active = true ${typeFilter}
       ORDER BY st.sort_order, st.name`,
      typeParams
    );
    // Targets, adjustments, closed, assigned — same open-slot math as broadcast.
    const { rows: targets } = await query(
      `SELECT shift_type_id AS "shiftTypeId", target_count AS "targetCount",
              weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
       FROM staffing_targets WHERE company_id = $1`, [companyId]);
    const { rows: adjustments } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count
       FROM extra_open_slots WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, pl.from, pl.to]);
    const { rows: closed } = await query(
      `SELECT date::text AS date, shift_type_id AS "shiftTypeId"
       FROM closed_shifts WHERE company_id = $1 AND date >= $2 AND date <= $3`,
      [companyId, pl.from, pl.to]);
    const shiftParams: any[] = [companyId, pl.from, pl.to];
    let deptFilter = '';
    if (pl.department_id) {
      shiftParams.push(pl.department_id);
      deptFilter = ` AND (st.department_id = $${shiftParams.length} OR EXISTS (SELECT 1 FROM shift_type_departments std WHERE std.shift_type_id = s.shift_type_id AND std.department_id = $${shiftParams.length}))`;
    }
    const { rows: assigned } = await query(
      `SELECT s.date::text AS date, s.shift_type_id AS "shiftTypeId", COUNT(*) AS count
       FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
       WHERE s.company_id = $1 AND s.date >= $2 AND s.date <= $3 ${deptFilter}
       GROUP BY s.date, s.shift_type_id`,
      shiftParams);
    const closedSet = new Set(closed.map((c: any) => c.date + '|' + c.shiftTypeId));
    const assignedMap = new Map(assigned.map((a: any) => [a.date + '|' + a.shiftTypeId, parseInt(a.count, 10)]));
    const adjMap = new Map<string, number>();
    adjustments.forEach((a: any) => {
      const k = a.date + '|' + a.shiftTypeId;
      adjMap.set(k, (adjMap.get(k) || 0) + (a.count || 0));
    });
    // Build open slots list.
    const openSlots: any[] = [];
    const d = new Date(pl.from + 'T00:00:00');
    const end = new Date(pl.to + 'T00:00:00');
    const targetByType = new Map(targets.map((t: any) => [t.shiftTypeId, t]));
    while (d <= end) {
      const ds = d.toISOString().slice(0, 10);
      const dow = d.getDay();
      for (const t of types) {
        const key = ds + '|' + t.id;
        if (closedSet.has(key)) continue;
        const tgt = targetByType.get(t.id);
        let open = adjMap.get(key) || 0;
        if (tgt) {
          const wdays: number[] = tgt.weekdays || [0,1,2,3,4,5,6];
          if (wdays.indexOf(dow) === -1) continue;
          if ((tgt.startDate && ds < tgt.startDate) || (tgt.endDate && ds > tgt.endDate)) continue;
          open += Math.max(0, (tgt.targetCount || 0) - (assignedMap.get(key) || 0));
        }
        if (open > 0) openSlots.push({ date: ds, shiftTypeId: t.id, shiftTypeName: t.name, open });
      }
      d.setDate(d.getDate() + 1);
    }
    // Team member names for the pickup picker (no other details).
    const { rows: members } = await query(
      `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
       FROM users WHERE company_id = $1 AND is_active = true
       ORDER BY first_name, last_name`,
      [companyId]);
    const { rows: comp } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
    res.json({
      companyName: comp.length ? comp[0].name : '',
      label: pl.label,
      from: pl.from, to: pl.to,
      openSlots,
      members: members.filter((m: any) => m.name),
    });
  } catch (err) {
    console.error('[schedule] public pickup failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/pickup/:token/request — public: request one or more open
// shifts. Verifies the requester's password (anti-impersonation for group-shared
// links), holds each slot as an unpublished shift, and creates an 'open_pickup'
// shift request for scheduler/owner approval. Body: { userId, password, items: [{date, shiftTypeId}] }
router.post('/pickup/:token/request', async (req: Request, res: Response) => {
  try {
    const { rows: links } = await query(
      `SELECT company_id, from_date::text AS "from", to_date::text AS "to"
       FROM pickup_links WHERE token_hash = $1`,
      [hashShareToken(req.params.token)]
    );
    if (!links.length) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    const companyId = links[0].company_id;
    const { userId, password, items } = req.body ?? {};
    if (typeof userId !== 'string' || typeof password !== 'string' ||
        !Array.isArray(items) || !items.length || items.length > 10) {
      res.status(400).json({ error: 'Select at least one shift, pick your name, and enter your password.' });
      return;
    }
    const { rows: urows } = await query(
      `SELECT id, password_hash AS "passwordHash"
       FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [userId, companyId]);
    if (!urows.length) { res.status(403).json({ error: 'Name not recognized.' }); return; }
    const user = urows[0];
    let pwOk = false;
    try { pwOk = !!user.passwordHash && await bcrypt.compare(String(password), user.passwordHash); }
    catch { pwOk = false; }
    if (!pwOk) {
      res.status(403).json({ error: 'Password does not match. If you never set a password, accept your invite email first.' });
      return;
    }
    const requested: any[] = [];
    const failed: any[] = [];
    for (const item of items) {
      const date = item && item.date;
      const shiftTypeId = item && item.shiftTypeId;
      if (!isValidDate(date) || typeof shiftTypeId !== 'string' ||
          date < links[0].from || date > links[0].to) {
        failed.push({ date, shiftTypeId, error: 'Invalid shift.' });
        continue;
      }
      const { rows: trows } = await query(
        'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
        [shiftTypeId, companyId]);
      if (!trows.length) { failed.push({ date, shiftTypeId, error: 'Shift not found.' }); continue; }
      const elig = await checkShiftEligibility(companyId, userId, trows[0].eligible_job_role_ids);
      if (!elig.ok) { failed.push({ date, shiftTypeId, error: elig.error }); continue; }
      const shiftId = crypto.randomUUID();
      let held = false;
      try {
        await withTransaction(async (tx) => {
          const { rows: slotRows } = await tx.query(
            `UPDATE extra_open_slots SET count = count - 1
             WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count > 0
             RETURNING count`,
            [companyId, date, shiftTypeId]);
          if (slotRows.length) {
            if (Number(slotRows[0].count) <= 0) {
              await tx.query('DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
                [companyId, date, shiftTypeId]);
            }
          } else {
            const { rows: crows } = await tx.query(
              'SELECT 1 FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
              [companyId, date, shiftTypeId]);
            if (crows.length) return;
            const { rows: tgrows } = await tx.query(
              `SELECT target_count, weekdays, start_date::text AS start_date, end_date::text AS end_date
               FROM staffing_targets WHERE company_id = $1 AND shift_type_id = $2 FOR UPDATE`,
              [companyId, shiftTypeId]);
            if (!tgrows.length) return;
            const t = tgrows[0];
            const dow = new Date(date + 'T00:00:00').getDay();
            if ((t.weekdays || [0,1,2,3,4,5,6]).indexOf(dow) === -1) return;
            if ((t.start_date && date < t.start_date) || (t.end_date && date > t.end_date)) return;
            const { rows: frows } = await tx.query(
              'SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
              [companyId, date, shiftTypeId]);
            if (frows[0].n >= (t.target_count || 0)) return;
          }
          // Hold the slot as an unpublished shift assigned to the requester.
          await tx.query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
             VALUES ($1, $2, $3, $4, $5, false, $6)`,
            [shiftId, companyId, userId, shiftTypeId, date, userId]);
          await tx.query(
            `INSERT INTO shift_requests (id, company_id, request_type, shift_id, requester_id, target_user_id, status)
             VALUES ($1, $2, 'open_pickup', $3, $4, NULL, 'pending')`,
            [crypto.randomUUID(), companyId, shiftId, userId]);
          held = true;
        });
      } catch (txErr) {
        console.error('[schedule] pickup request tx failed:', txErr);
      }
      if (held) requested.push({ date, shiftTypeId });
      else failed.push({ date, shiftTypeId, error: 'That shift was just filled.' });
    }
    try {
      const { rows: nm } = await query(
        `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM users WHERE id = $1`, [userId]);
      await auditLog({
        companyId, date: todayStr(), action: 'created',
        source: 'manual', category: 'schedule', changedBy: userId,
        description: `Pickup request via share link (${requested.length} shift${requested.length === 1 ? '' : 's'}) by ${(nm[0] && nm[0].name) || 'staff'}`,
      });
    } catch {}
    // Notify approvers that pickup request(s) are waiting.
    if (requested.length) {
      const { rows: nm2 } = await query(
        `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM users WHERE id = $1`, [userId]);
      const requesterName = (nm2[0] && nm2[0].name) || 'A team member';
      notifyShiftRequestApprovers(companyId, { userId, shiftTypeId: requested[0].shiftTypeId }, userId,
        'A pickup request is waiting for approval',
        `${requesterName} asked to pick up ${requested.length} open shift(s) via a share link.`);
    }
    res.json({ ok: true, requested, failed });
  } catch (err) {
    console.error('[schedule] pickup request failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// In-app messaging — company channel, department channels, direct messages.
// Anyone can message anyone. Unread badges via per-user read cursors.
// Channel keys: 'company', 'dept:<uuid>', 'dm:<userId>'.
// ---------------------------------------------------------------------------

function dmKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function multiDmKey(me: string, others: string[]): string {
  return [me, ...others].sort().join('|');
}

async function multiDmDisplayName(companyId: string, me: string, dmkey: string): Promise<string> {
  const ids = dmkey.split('|').filter((id) => id !== me);
  if (!ids.length) return 'Group message';
  const { rows } = await query(
    `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
     FROM users WHERE id = ANY($1::uuid[]) AND company_id = $2`,
    [ids, companyId]);
  const names = rows.map((r: any) => r.name).filter(Boolean);
  if (names.length <= 2) return names.join(', ');
  return names.slice(0, 2).join(', ') + ' +' + (names.length - 2);
}

async function visibleDepartmentIds(companyId: string, userId: string, role: string): Promise<string[]> {
  if (role === 'owner') {
    const { rows } = await query('SELECT id FROM departments WHERE company_id = $1 ORDER BY name', [companyId]);
    return rows.map((r: any) => r.id);
  }
  if (role === 'scheduler') {
    const access = await getDepartmentAccess(userId, companyId);
    return access.view || [];
  }
  const { rows } = await query(
    'SELECT department_id FROM users WHERE id = $1 AND company_id = $2',
    [userId, companyId]);
  return rows[0] && rows[0].department_id ? [rows[0].department_id] : [];
}

// GET /api/schedule/messages/channels — channel list with unread counts.
router.get('/messages/channels', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const { rows: reads } = await query(
      'SELECT channel_key AS "channelKey", last_read_at AS "lastReadAt" FROM message_reads WHERE user_id = $1',
      [me]);
    const readMap = new Map(reads.map((r: any) => [r.channelKey, new Date(r.lastReadAt).getTime()]));
    async function unread(channelKey: string, where: string, params: any[]): Promise<number> {
      const since = readMap.get(channelKey) || 0;
      const { rows } = await query(
        `SELECT COUNT(*)::int AS n FROM messages
         WHERE company_id = $1 AND sender_id <> $2 AND ${where} AND created_at > to_timestamp($3 / 1000.0)`,
        [companyId, me, since, ...params]);
      return rows[0].n;
    }
    async function lastMsg(where: string, params: any[]): Promise<{ body: string; at: string } | null> {
      const { rows } = await query(
        `SELECT LEFT(body, 90) AS body, created_at AS "createdAt" FROM messages
         WHERE company_id = $1 AND ${where} ORDER BY created_at DESC LIMIT 1`,
        [companyId, ...params]);
      return rows.length ? { body: rows[0].body, at: rows[0].createdAt } : null;
    }
    const channels: any[] = [{ key: 'company', name: 'Everyone', kind: 'company',
      unread: await unread('company', "kind = 'company'", []),
      last: await lastMsg("kind = 'company'", []) }];
    // Department channels.
    const deptIds = await visibleDepartmentIds(companyId, me, role);
    if (deptIds.length) {
      const { rows: depts } = await query(
        'SELECT id, name FROM departments WHERE id = ANY($1::uuid[]) ORDER BY name', [deptIds]);
      for (const d of depts) {
        channels.push({ key: 'dept:' + d.id, name: d.name, kind: 'department',
          unread: await unread('dept:' + d.id, "kind = 'department' AND department_id = $4", [d.id]),
          last: await lastMsg("kind = 'department' AND department_id = $2", [d.id]) });
      }
    }
    // Custom groups.
    const { rows: groups } = await query(
      `SELECT g.id, g.name FROM message_groups g
       JOIN message_group_members m ON m.group_id = g.id
       WHERE g.company_id = $1 AND m.user_id = $2 ORDER BY g.name`,
      [companyId, me]);
    for (const g of groups) {
      channels.push({ key: 'group:' + g.id, name: g.name, kind: 'group',
        unread: await unread('group:' + g.id, "kind = 'group' AND group_id = $4", [g.id]),
        last: await lastMsg("kind = 'group' AND group_id = $2", [g.id]) });
    }
    // DM contacts: every other active member.
    const { rows: people } = await query(
      `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, role
       FROM users WHERE company_id = $1 AND is_active = true AND id <> $2
       ORDER BY first_name, last_name`,
      [companyId, me]);
    const dms = [];
    for (const p of people) {
      if (!p.name) continue;
      const key = 'dm:' + p.id;
      dms.push({ key, name: p.name, kind: 'dm', userId: p.id,
        unread: await unread(key, 'kind = \'dm\' AND dm_key = $4', [dmKey(me, p.id)]),
        last: await lastMsg("kind = 'dm' AND dm_key = $2", [dmKey(me, p.id)]) });
    }
    // Multi-person DM threads I'm part of.
    const { rows: mdms } = await query(
      `SELECT DISTINCT dm_key AS "dmKey" FROM messages
       WHERE company_id = $1 AND kind = 'dm'
         AND array_length(string_to_array(dm_key, '|'), 1) > 2
         AND string_to_array(dm_key, '|') @> ARRAY[$2]`,
      [companyId, me]);
    for (const md of mdms) {
      const key = 'dmg:' + md.dmKey.split('|').filter((id: string) => id !== me).sort().join(',');
      dms.push({ key, name: await multiDmDisplayName(companyId, me, md.dmKey), kind: 'dmg',
        unread: await unread(key, 'kind = \'dm\' AND dm_key = $4', [md.dmKey]),
        last: await lastMsg("kind = 'dm' AND dm_key = $2", [md.dmKey]) });
    }
    res.json({ channels, dms });
  } catch (err) {
    console.error('[schedule] message channels failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/messages?channel=<key>&before=<iso> — latest 50, paginated.
router.get('/messages', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const channel = String(req.query.channel || '');
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    let where = '';
    const params: any[] = [companyId];
    if (channel === 'company') {
      where = "kind = 'company'";
    } else if (channel.startsWith('dept:')) {
      const deptId = channel.slice(5);
      const visible = await visibleDepartmentIds(companyId, me, role);
      if (!visible.includes(deptId)) { res.status(403).json({ error: 'Not allowed.' }); return; }
      params.push(deptId);
      where = `kind = 'department' AND department_id = $${params.length}`;
    } else if (channel.startsWith('group:')) {
      const groupId = channel.slice(6);
      const { rows: grows } = await query(
        `SELECT g.id FROM message_groups g JOIN message_group_members m ON m.group_id = g.id
         WHERE g.id = $1 AND g.company_id = $2 AND m.user_id = $3`,
        [groupId, companyId, me]);
      if (!grows.length) { res.status(403).json({ error: 'Not allowed.' }); return; }
      params.push(groupId);
      where = `kind = 'group' AND group_id = $${params.length}`;
    } else if (channel.startsWith('dmg:')) {
      const others = channel.slice(4).split(',').filter(Boolean);
      if (others.length < 2 || others.includes(me)) { res.status(400).json({ error: 'Invalid channel.' }); return; }
      const { rows: orows } = await query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active = true',
        [others, companyId]);
      if (orows.length !== others.length) { res.status(404).json({ error: 'Person not found.' }); return; }
      params.push(multiDmKey(me, others));
      where = `kind = 'dm' AND dm_key = $${params.length}`;
    } else if (channel.startsWith('dm:')) {
      const otherId = channel.slice(3);
      const { rows: orows } = await query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [otherId, companyId]);
      if (!orows.length) { res.status(404).json({ error: 'Person not found.' }); return; }
      params.push(dmKey(me, otherId));
      where = `kind = 'dm' AND dm_key = $${params.length}`;
    } else {
      res.status(400).json({ error: 'Invalid channel.' }); return;
    }
    if (before && !isNaN(before.getTime())) {
      params.push(before.toISOString());
      where += ` AND created_at < $${params.length}`;
    }
    const { rows } = await query(
      `SELECT m.id, m.sender_id AS "senderId", m.body,
              m.created_at AS "createdAt",
              TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS "senderName",
              (m.sender_id = $${params.length + 1}) AS "mine"
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.company_id = $1 AND ${where}
       ORDER BY m.created_at DESC LIMIT 51`,
      [...params, me]);
    const hasMore = rows.length > 50;
    const msgs = rows.slice(0, 50).reverse();
    res.json({ messages: msgs, hasMore });
  } catch (err) {
    console.error('[schedule] get messages failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/messages — send. Body: { channel, body }
router.post('/messages', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const channel = String((req.body ?? {}).channel || '');
    const body = String((req.body ?? {}).body || '').trim().slice(0, 2000);
    if (!body) { res.status(400).json({ error: 'Message is empty.' }); return; }
    let kind = '', departmentId: string | null = null, dmkey: string | null = null, groupId: string | null = null;
    if (channel === 'company') {
      kind = 'company';
    } else if (channel.startsWith('dept:')) {
      const deptId = channel.slice(5);
      const visible = await visibleDepartmentIds(companyId, me, role);
      if (!visible.includes(deptId)) { res.status(403).json({ error: 'Not allowed.' }); return; }
      kind = 'department'; departmentId = deptId;
    } else if (channel.startsWith('group:')) {
      groupId = channel.slice(6);
      const { rows: grows } = await query(
        `SELECT g.id FROM message_groups g JOIN message_group_members m ON m.group_id = g.id
         WHERE g.id = $1 AND g.company_id = $2 AND m.user_id = $3`,
        [groupId, companyId, me]);
      if (!grows.length) { res.status(403).json({ error: 'Not allowed.' }); return; }
      kind = 'group';
    } else if (channel.startsWith('dmg:')) {
      const others = channel.slice(4).split(',').filter(Boolean);
      if (others.length < 2 || others.includes(me)) { res.status(400).json({ error: 'Invalid recipients.' }); return; }
      const { rows: orows } = await query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active = true',
        [others, companyId]);
      if (orows.length !== others.length) { res.status(404).json({ error: 'Person not found.' }); return; }
      kind = 'dm'; dmkey = multiDmKey(me, others);
    } else if (channel.startsWith('dm:')) {
      const otherId = channel.slice(3);
      if (otherId === me) { res.status(400).json({ error: 'Invalid recipient.' }); return; }
      const { rows: orows } = await query(
        'SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [otherId, companyId]);
      if (!orows.length) { res.status(404).json({ error: 'Person not found.' }); return; }
      kind = 'dm'; dmkey = dmKey(me, otherId);
    } else {
      res.status(400).json({ error: 'Invalid channel.' }); return;
    }
    const { rows } = await query(
      `INSERT INTO messages (company_id, kind, department_id, dm_key, group_id, sender_id, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at AS "createdAt"`,
      [companyId, kind, departmentId, dmkey, groupId, me, body]);
    // Sending marks the channel read for the sender.
    await query(
      `INSERT INTO message_reads (user_id, company_id, channel_key, last_read_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, channel_key) DO UPDATE SET last_read_at = now()`,
      [me, companyId, channel]);
    res.status(201).json({ id: rows[0].id, createdAt: rows[0].createdAt });
  } catch (err) {
    console.error('[schedule] send message failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/messages/dm — start a multi-person direct message.
// Body: { userIds: string[] } (2+ other people). Returns the channel key + name.
router.post('/messages/dm', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const userIds = Array.isArray((req.body ?? {}).userIds)
      ? (req.body.userIds as any[]).filter((x) => typeof x === 'string' && x !== me)
      : [];
    const unique = [...new Set(userIds)].slice(0, 20);
    if (!unique.length) { res.status(400).json({ error: 'Pick at least one person.' }); return; }
    const { rows } = await query(
      'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active = true',
      [unique, companyId]);
    if (rows.length !== unique.length) { res.status(404).json({ error: 'Person not found.' }); return; }
    if (unique.length === 1) {
      const { rows: nm } = await query(
        `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name FROM users WHERE id = $1`,
        [unique[0]]);
      res.json({ key: 'dm:' + unique[0], name: nm[0]?.name || 'Direct message' });
      return;
    }
    const dmkey = multiDmKey(me, unique);
    const name = await multiDmDisplayName(companyId, me, dmkey);
    res.json({ key: 'dmg:' + unique.sort().join(','), name });
  } catch (err) {
    console.error('[schedule] start dm failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/messages/read — mark channel read. Body: { channel }
router.post('/messages/read', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const channel = String((req.body ?? {}).channel || '');
    if (!channel) { res.status(400).json({ error: 'Invalid channel.' }); return; }
    await query(
      `INSERT INTO message_reads (user_id, company_id, channel_key, last_read_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, channel_key) DO UPDATE SET last_read_at = now()`,
      [me, companyId, channel]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] mark read failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/messages/groups — create a group.
// Body: { name, memberIds?: string[], departmentIds?: string[] }
// Department ids expand to all active members of those departments.
router.post('/messages/groups', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const { name, memberIds, departmentIds } = req.body ?? {};
    const gname = String(name || '').trim().slice(0, 80);
    if (!gname) { res.status(400).json({ error: 'Give the group a name.' }); return; }
    const memberSet = new Set<string>([me]);
    if (Array.isArray(memberIds)) {
      const { rows } = await query(
        'SELECT id FROM users WHERE id = ANY($1::uuid[]) AND company_id = $2 AND is_active = true',
        [memberIds.filter((x: any) => typeof x === 'string'), companyId]);
      rows.forEach((r: any) => memberSet.add(r.id));
    }
    if (Array.isArray(departmentIds) && departmentIds.length) {
      const { rows } = await query(
        `SELECT u.id FROM users u JOIN departments d ON d.id = u.department_id
         WHERE d.id = ANY($1::uuid[]) AND d.company_id = $2 AND u.company_id = $2 AND u.is_active = true`,
        [departmentIds.filter((x: any) => typeof x === 'string'), companyId]);
      rows.forEach((r: any) => memberSet.add(r.id));
    }
    if (memberSet.size < 2) {
      res.status(400).json({ error: 'Add at least one other person or department.' }); return;
    }
    const groupId = crypto.randomUUID();
    await withTransaction(async (tx) => {
      await tx.query(
        'INSERT INTO message_groups (id, company_id, name, created_by) VALUES ($1, $2, $3, $4)',
        [groupId, companyId, gname, me]);
      for (const uid of memberSet) {
        await tx.query(
          'INSERT INTO message_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [groupId, uid]);
      }
    });
    res.status(201).json({ id: groupId, name: gname });
  } catch (err) {
    console.error('[schedule] create group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/messages/groups/:id — creator, scheduler, or owner.
router.delete('/messages/groups/:id', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const { rows } = await query(
      'SELECT id, created_by AS "createdBy" FROM message_groups WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Group not found.' }); return; }
    const privileged = role === 'owner' || role === 'scheduler';
    if (!privileged && rows[0].createdBy !== me) {
      res.status(403).json({ error: 'Only the creator or a scheduler can delete this group.' }); return;
    }
    await query('DELETE FROM message_groups WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

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

// ---------------------------------------------------------------------------
// Onboarding: industry templates + Q-Scheduler setup interview (owner only).
// ---------------------------------------------------------------------------

interface OnboardingTemplate {
  label: string;
  departments: { name: string; jobRoles: string[] }[];
  shiftTypes: { name: string }[];
}

const ONBOARDING_TEMPLATES: Record<string, OnboardingTemplate> = {
  hospital: {
    label: 'Hospital',
    departments: [
      { name: 'Emergency', jobRoles: ['Physician', 'Nurse', 'Technician'] },
      { name: 'Intensive Care', jobRoles: ['Physician', 'Nurse'] },
      { name: 'Internal Medicine', jobRoles: ['Physician', 'Nurse Practitioner', 'Secretary'] },
      { name: 'Surgery', jobRoles: ['Surgeon', 'Nurse', 'Technician'] },
      { name: 'Pediatrics', jobRoles: ['Physician', 'Nurse'] },
    ],
    shiftTypes: [{ name: 'Day Shift' }, { name: 'Night Shift' }],
  },
  clinic: {
    label: 'Clinic',
    departments: [
      { name: 'Front Office', jobRoles: ['Receptionist', 'Biller'] },
      { name: 'Clinical', jobRoles: ['Provider', 'Medical Assistant', 'Nurse'] },
    ],
    shiftTypes: [{ name: 'Morning' }, { name: 'Afternoon' }, { name: 'Full Day' }],
  },
  dental: {
    label: 'Dental Office',
    departments: [
      { name: 'Hygiene', jobRoles: ['Hygienist', 'Dental Assistant'] },
      { name: 'Restorative', jobRoles: ['Dentist', 'Dental Assistant'] },
      { name: 'Front Office', jobRoles: ['Receptionist'] },
    ],
    shiftTypes: [{ name: 'Morning' }, { name: 'Afternoon' }, { name: 'Full Day' }],
  },
  salon: {
    label: 'Salon & Spa',
    departments: [
      { name: 'Hair', jobRoles: ['Stylist', 'Colorist'] },
      { name: 'Nails', jobRoles: ['Nail Technician'] },
      { name: 'Spa', jobRoles: ['Esthetician', 'Massage Therapist'] },
      { name: 'Front Desk', jobRoles: ['Receptionist'] },
    ],
    shiftTypes: [{ name: 'Morning' }, { name: 'Evening' }],
  },
  restaurant: {
    label: 'Restaurant',
    departments: [
      { name: 'Kitchen', jobRoles: ['Chef', 'Cook'] },
      { name: 'Front of House', jobRoles: ['Server', 'Host', 'Bartender'] },
    ],
    shiftTypes: [{ name: 'Lunch' }, { name: 'Dinner' }],
  },
  retail: {
    label: 'Retail Store',
    departments: [
      { name: 'Sales Floor', jobRoles: ['Sales Associate', 'Cashier'] },
      { name: 'Stockroom', jobRoles: ['Stocker'] },
    ],
    shiftTypes: [{ name: 'Morning' }, { name: 'Evening' }],
  },
};

// Create departments, job roles, and shift types for a new company.
// Skips departments/shift types whose names already exist (case-insensitive).
async function applyOnboardingSetup(
  companyId: string,
  setup: { departments: { name: string; jobRoles: string[] }[]; shiftTypes: { name: string; departmentNames?: string[] }[] }
): Promise<{ departments: number; jobRoles: number; shiftTypes: number }> {
  const { rows: existingDepts } = await query(
    'SELECT id, lower(name) AS lname FROM departments WHERE company_id = $1', [companyId]);
  const deptByName = new Map(existingDepts.map((d: any) => [d.lname, d.id]));
  const { rows: existingTypes } = await query(
    'SELECT lower(name) AS lname FROM shift_types WHERE company_id = $1', [companyId]);
  const typeNames = new Set(existingTypes.map((t: any) => t.lname));

  let deptCount = 0, roleCount = 0, typeCount = 0;
  const deptIds: string[] = [];
  for (const d of setup.departments || []) {
    const name = String(d.name || '').trim();
    if (!name) continue;
    let deptId = deptByName.get(name.toLowerCase());
    if (!deptId) {
      deptId = crypto.randomUUID();
      await query('INSERT INTO departments (id, company_id, name) VALUES ($1, $2, $3)',
        [deptId, companyId, name]);
      deptByName.set(name.toLowerCase(), deptId);
      deptCount++;
    }
    deptIds.push(deptId);
    const { rows: existingRoles } = await query(
      'SELECT lower(name) AS lname FROM job_roles WHERE company_id = $1 AND department_id = $2',
      [companyId, deptId]);
    const roleNames = new Set(existingRoles.map((r: any) => r.lname));
    for (const rn of d.jobRoles || []) {
      const roleName = String(rn || '').trim();
      if (!roleName || roleNames.has(roleName.toLowerCase())) continue;
      await query('INSERT INTO job_roles (id, company_id, department_id, name) VALUES ($1, $2, $3, $4)',
        [crypto.randomUUID(), companyId, deptId, roleName]);
      roleNames.add(roleName.toLowerCase());
      roleCount++;
    }
  }
  let sortOrder = 0;
  const { rows: maxSort } = await query(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM shift_types WHERE company_id = $1', [companyId]);
  sortOrder = Number(maxSort[0]?.m || 0);
  for (const st of setup.shiftTypes || []) {
    const name = String(st.name || '').trim();
    if (!name || typeNames.has(name.toLowerCase())) continue;
    const wanted = (st.departmentNames || []).map((n) => deptByName.get(String(n).toLowerCase())).filter(Boolean);
    const linkDeptIds = wanted.length ? wanted : deptIds;
    sortOrder++;
    const stId = crypto.randomUUID();
    await query(
      `INSERT INTO shift_types (id, company_id, name, sort_order, department_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [stId, companyId, name, sortOrder, linkDeptIds[0] || null]);
    for (const dd of linkDeptIds) {
      await query(
        'INSERT INTO shift_type_departments (shift_type_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [stId, dd]);
    }
    typeNames.add(name.toLowerCase());
    typeCount++;
  }
  await auditLog({
    companyId, date: todayStr(), action: 'created', category: 'settings',
    description: `Onboarding setup wizard: ${deptCount} departments, ${typeCount} shift types, ${roleCount} job roles`,
    source: 'manual',
  });
  return { departments: deptCount, jobRoles: roleCount, shiftTypes: typeCount };
}

// Apply job roles + shift types to ONE existing department (scheduler-scoped
// onboarding). Names are deduped against what already exists; shift types are
// company-global by name but linked to this department when newly created or
// not yet linked.
async function applyDepartmentSetup(
  companyId: string,
  departmentId: string,
  setup: { jobRoles: string[]; shiftTypes: { name: string }[] }
): Promise<{ departments: number; jobRoles: number; shiftTypes: number }> {
  let roleCount = 0, typeCount = 0;
  const { rows: existingRoles } = await query(
    'SELECT lower(name) AS lname FROM job_roles WHERE company_id = $1 AND department_id = $2',
    [companyId, departmentId]);
  const roleNames = new Set(existingRoles.map((r: any) => r.lname));
  for (const rn of setup.jobRoles || []) {
    const roleName = String(rn || '').trim();
    if (!roleName || roleNames.has(roleName.toLowerCase())) continue;
    await query('INSERT INTO job_roles (id, company_id, department_id, name) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), companyId, departmentId, roleName]);
    roleNames.add(roleName.toLowerCase());
    roleCount++;
  }
  let sortOrder = 0;
  const { rows: maxSort } = await query(
    'SELECT COALESCE(MAX(sort_order), 0) AS m FROM shift_types WHERE company_id = $1', [companyId]);
  sortOrder = Number(maxSort[0]?.m || 0);
  for (const st of setup.shiftTypes || []) {
    const name = String(st?.name || '').trim();
    if (!name) continue;
    const { rows: existing } = await query(
      'SELECT id FROM shift_types WHERE company_id = $1 AND lower(name) = $2',
      [companyId, name.toLowerCase()]);
    let stId = existing[0]?.id as string | undefined;
    if (!stId) {
      sortOrder++;
      stId = crypto.randomUUID();
      await query(
        `INSERT INTO shift_types (id, company_id, name, sort_order, department_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [stId, companyId, name, sortOrder, departmentId]);
      await query(
        'INSERT INTO shift_type_departments (shift_type_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [stId, departmentId]);
      typeCount++;
    } else {
      await query(
        'INSERT INTO shift_type_departments (shift_type_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [stId, departmentId]);
      typeCount++;
    }
  }
  await auditLog({
    companyId, date: todayStr(), action: 'created', category: 'settings',
    description: `Onboarding setup wizard (department): ${typeCount} shift types, ${roleCount} job roles`,
    source: 'manual',
  });
  return { departments: 1, jobRoles: roleCount, shiftTypes: typeCount };
}

// Resolve the department a scheduler may set up in the onboarding wizard:
// must be one of their Edit departments. Returns the id or sends a 403.
async function wizardDepartmentId(req: Request, res: Response): Promise<string | null> {
  const companyId = req.session.companyId!;
  const deptId = String((req.query.departmentId ?? (req.body ?? {}).departmentId) || '').trim();
  if (req.session.role === 'owner') {
    if (!deptId) return null;
    const { rows } = await query('SELECT id FROM departments WHERE id = $1 AND company_id = $2',
      [deptId, companyId]);
    if (!rows.length) { res.status(400).json({ error: 'Unknown department.' }); return null; }
    return deptId;
  }
  const access = await getDepartmentAccess(req.session.userId!, companyId);
  if (!access.edit.length) { res.status(403).json({ error: 'Ask your owner for Edit access to a department first.' }); return null; }
  if (!deptId) { res.status(400).json({ error: 'Choose a department to set up.' }); return null; }
  if (!access.edit.includes(deptId)) {
    res.status(403).json({ error: 'You do not have Edit access to that department.' });
    return null;
  }
  return deptId;
}

// GET /api/schedule/onboarding/status — which setup steps are complete (owner or scheduler).
// Owners: company-wide. Schedulers: scoped to ?departmentId= (one of their Edit departments).
// Detects real state so the wizard resumes correctly on any device.
router.get('/onboarding/status', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const role = req.session.role!;
    if (role === 'scheduler') {
      const deptParam = String(req.query.departmentId || '').trim();
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      const { rows: deptRows } = await query(
        'SELECT id, name FROM departments WHERE company_id = $1 AND id = ANY($2) ORDER BY name',
        [companyId, access.edit]);
      const editableDepartments = deptRows.map((d: any) => ({ id: d.id, name: d.name }));
      const deptId = deptParam || (editableDepartments.length === 1 ? editableDepartments[0].id : '');
      if (!deptId || !access.edit.includes(deptId)) {
        res.json({ steps: { structure: false, team: false, staffing: false, invites: false }, editableDepartments, scopedDepartmentId: null });
        return;
      }
      const { rows: roleRows } = await query(
        'SELECT COUNT(*) AS c FROM job_roles WHERE company_id = $1 AND department_id = $2',
        [companyId, deptId]);
      const { rows: typeRows } = await query(
        `SELECT COUNT(*) AS c FROM shift_type_departments std
         JOIN shift_types st ON st.id = std.shift_type_id
         WHERE st.company_id = $1 AND std.department_id = $2`,
        [companyId, deptId]);
      const { rows: userRows } = await query(
        `SELECT COUNT(*) AS c FROM users WHERE company_id = $1 AND department_id = $2
         AND role <> 'owner' AND is_active = true`,
        [companyId, deptId]);
      const { rows: targetRows } = await query(
        `SELECT COUNT(*) AS c FROM staffing_targets t
         JOIN shift_type_departments std ON std.shift_type_id = t.shift_type_id
         WHERE t.company_id = $1 AND std.department_id = $2`,
        [companyId, deptId]);
      const { rows: inviteRows } = await query(
        `SELECT COUNT(*) AS c FROM invites i JOIN users u ON u.id = i.user_id
         WHERE i.company_id = $1 AND u.department_id = $2 AND i.sent_at IS NOT NULL`,
        [companyId, deptId]);
      res.json({
        steps: {
          structure: Number(roleRows[0].c) > 0 || Number(typeRows[0].c) > 0,
          team: Number(userRows[0].c) > 0,
          staffing: Number(targetRows[0].c) > 0,
          invites: Number(inviteRows[0].c) > 0,
        },
        editableDepartments,
        scopedDepartmentId: deptId,
      });
      return;
    }
    const { rows: deptRows } = await query(
      'SELECT COUNT(*) AS c FROM departments WHERE company_id = $1', [companyId]);
    const { rows: userRows } = await query(
      `SELECT COUNT(*) AS c FROM users WHERE company_id = $1 AND role <> 'owner' AND is_active = true`,
      [companyId]);
    const { rows: targetRows } = await query(
      'SELECT COUNT(*) AS c FROM staffing_targets WHERE company_id = $1', [companyId]);
    const { rows: inviteRows } = await query(
      `SELECT COUNT(*) AS c FROM invites WHERE company_id = $1 AND sent_at IS NOT NULL`,
      [companyId]);
    res.json({
      steps: {
        structure: Number(deptRows[0].c) > 0,
        team: Number(userRows[0].c) > 0,
        staffing: Number(targetRows[0].c) > 0,
        invites: Number(inviteRows[0].c) > 0,
      },
    });
  } catch (err) {
    console.error('[schedule] onboarding status failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/onboarding/templates — list available industry templates.
router.get('/onboarding/templates', requireRole('owner', 'scheduler'), async (_req: Request, res: Response) => {
  res.json({
    templates: Object.entries(ONBOARDING_TEMPLATES).map(([key, t]) => ({
      key, label: t.label,
      departments: t.departments.map((d) => d.name),
      shiftTypes: t.shiftTypes.map((s) => s.name),
    })),
  });
});

// POST /api/schedule/onboarding/template — apply an industry template.
// Owner: whole-company setup. Scheduler (or body.departmentId): applies the
// template's shift types + job roles to that one department only — roles come
// from the template department with the matching name (else the first one).
router.post('/onboarding/template', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const key = String((req.body ?? {}).template || '');
    const tpl = ONBOARDING_TEMPLATES[key];
    if (!tpl) { res.status(400).json({ error: 'Unknown template.' }); return; }
    const bodyDept = String((req.body ?? {}).departmentId || '').trim();
    if (bodyDept || req.session.role === 'scheduler') {
      const deptId = await wizardDepartmentId(req, res);
      if (!deptId) return;
      const { rows: deptRows } = await query('SELECT name FROM departments WHERE id = $1 AND company_id = $2',
        [deptId, companyId]);
      const deptName = String(deptRows[0]?.name || '');
      const match = tpl.departments.find((d) => d.name.toLowerCase() === deptName.toLowerCase()) || tpl.departments[0];
      const counts = await applyDepartmentSetup(companyId, deptId, {
        jobRoles: match ? match.jobRoles : [],
        shiftTypes: tpl.shiftTypes,
      });
      res.json({ ok: true, label: tpl.label, ...counts });
      return;
    }
    const counts = await applyOnboardingSetup(companyId, tpl);
    res.json({ ok: true, label: tpl.label, ...counts });
  } catch (err) {
    console.error('[schedule] onboarding template failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/onboarding/interview — one Q-Scheduler interview turn (owner or scheduler).
// Body: { message: string, history: [{ role: 'user'|'assistant', text: string }] }
// Returns { question } or { proposal, summary }.
router.post('/onboarding/interview', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { message, history } = req.body ?? {};
    const hist = Array.isArray(history) ? history.slice(-10) : [];
    const msg = String(message || '').trim();
    if (msg) hist.push({ role: 'user', text: msg });
    if (!hist.length) { res.status(400).json({ error: 'Say something to get started.' }); return; }
    const { onboardingInterview } = await import('../util/gemini.js');
    const result = await onboardingInterview(hist);
    res.json(result);
  } catch (err: any) {
    console.error('[schedule] onboarding interview failed:', err);
    const friendly = /GEMINI_API_KEY|not configured/i.test(err?.message || '')
      ? 'AI setup is not available right now — try an industry template instead.'
      : 'Something went wrong. Please try again.';
    res.status(500).json({ error: friendly });
  }
});

// POST /api/schedule/onboarding/apply — apply an interview proposal.
// Owner: whole-company setup. Scheduler (or body.departmentId): roles + shift
// types land on that one department only.
router.post('/onboarding/apply', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const proposal = (req.body ?? {}).proposal;
    if (!proposal || !Array.isArray(proposal.departments) || !proposal.departments.length) {
      res.status(400).json({ error: 'A proposal with departments is required.' }); return;
    }
    const bodyDept = String((req.body ?? {}).departmentId || '').trim();
    if (bodyDept || req.session.role === 'scheduler') {
      const deptId = await wizardDepartmentId(req, res);
      if (!deptId) return;
      const { rows: deptRows } = await query('SELECT name FROM departments WHERE id = $1 AND company_id = $2',
        [deptId, companyId]);
      const deptName = String(deptRows[0]?.name || '').toLowerCase();
      const named = (proposal.departments as any[]).find(
        (d) => String(d?.name || '').toLowerCase() === deptName);
      let roles: string[] = [];
      if (named) roles = Array.isArray(named.jobRoles) ? named.jobRoles : [];
      else {
        const seen = new Set<string>();
        for (const d of proposal.departments as any[]) {
          for (const r of (Array.isArray(d?.jobRoles) ? d.jobRoles : [])) {
            const rn = String(r || '').trim();
            if (rn && !seen.has(rn.toLowerCase())) { seen.add(rn.toLowerCase()); roles.push(rn); }
          }
        }
      }
      const counts = await applyDepartmentSetup(companyId, deptId, {
        jobRoles: roles,
        shiftTypes: Array.isArray(proposal.shiftTypes) ? proposal.shiftTypes : [],
      });
      res.json({ ok: true, ...counts });
      return;
    }
    const counts = await applyOnboardingSetup(companyId, {
      departments: proposal.departments,
      shiftTypes: Array.isArray(proposal.shiftTypes) ? proposal.shiftTypes : [],
    });
    res.json({ ok: true, ...counts });
  } catch (err) {
    console.error('[schedule] onboarding apply failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

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

// POST /api/schedule/payroll-report.csv — download CSV (owner/scheduler).
// One row per shift worked: Employee, Date, Shift type, Hours. Imports into Gusto/QuickBooks.
router.post('/payroll-report.csv', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { from, to, personId } = req.body ?? {};
    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    const data = await getPayrollData(companyId, from, to, personId || null);
    const esc = (v: any): string => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = ['Employee,Date,Shift type,Hours'];
    for (const d of data.dates) {
      for (const e of d.entries) {
        lines.push([esc(e.name), esc(d.date), esc(e.shift), e.hours].join(','));
      }
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="payroll-${from}-to-${to}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) {
    console.error('[schedule] payroll-report.csv failed:', err);
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

// GET /api/schedule/audit — change report for a date or date range (owner/scheduler).
// Query: ?date=YYYY-MM-DD (single date) or ?from=YYYY-MM-DD&to=YYYY-MM-DD (range)
router.get('/audit', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    let where = '';
    const params: any[] = [companyId];
    if (isValidDate(date)) {
      params.push(date);
      where = ` AND a.date = $${params.length}`;
    } else if (isValidDate(from) && isValidDate(to) && from <= to) {
      params.push(from, to);
      where = ` AND a.date >= $${params.length - 1} AND a.date <= $${params.length}`;
    } else {
      res.status(400).json({ error: 'Provide a date or a from/to range.' });
      return;
    }
    const { rows } = await query(
      `SELECT a.date::text AS date, a.action, a.category, a.person_name AS "personName",
              a.shift_type_name AS "shiftTypeName", a.source,
              a.rotation_name AS "rotationName",
              a.changed_by_name AS "changedBy",
              a.details AS "details",
              a.details->>'description' AS "description",
              a.created_at AS "changedAt"
       FROM schedule_audit_log a
       WHERE a.company_id = $1${where}
       ORDER BY a.date, a.created_at DESC
       LIMIT 2000`,
      params
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error('[schedule] audit report failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/ai-scheduler-email — the inbox address the AI scheduler
// (email-to-plan pipeline) reads. Employees address "Email scheduler" requests here;
// the pipeline reads it and sends a plan to the human schedulers for approval.
router.get('/ai-scheduler-email', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const email = (process.env.GMAIL_USER || '').trim();
    if (!email) {
      res.status(503).json({ error: 'The AI scheduler inbox is not set up yet.' });
      return;
    }
    res.json({ email });
  } catch (err) {
    console.error('[schedule] ai-scheduler-email failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/ask — rule-based natural language Q&A (owner/scheduler/employee).
// Employees get questions only; the answers come from schedule data they can already see.
// Body: { question: string }
router.post('/ask', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const question = String(req.body?.question || '').slice(0, 500);
    if (!question.trim()) {
      res.status(400).json({ error: 'Ask a question.' });
      return;
    }
    const { answerQuestion } = await import('../util/askEngine.js');
    const { rows: stRows } = await query(
      'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
      [companyId]
    );
    const { rows: uRows } = await query(
      `SELECT id, first_name AS "firstName", last_name AS "lastName", nickname
       FROM users WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    // Department visibility for calendar answers — same rules as the
    // Calendars tab: owner sees all, scheduler sees view-access departments,
    // employees see only their own department. Answers never cross companies:
    // companyId comes from the signed-in session.
    const askerRole = req.session.role!;
    let visibleDeptIds: string[] | null = null;
    if (askerRole !== 'owner') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      if (askerRole === 'scheduler') visibleDeptIds = access.view || [];
      else {
        const { rows: meRows } = await query(
          'SELECT department_id FROM users WHERE id = $1 AND company_id = $2',
          [req.session.userId!, companyId]);
        visibleDeptIds = meRows[0] && meRows[0].department_id ? [meRows[0].department_id] : [];
      }
    }
    const answer = await answerQuestion(question, {
      companyId,
      shiftTypes: stRows,
      members: uRows,
      userId: req.session.userId!,
      role: askerRole,
      visibleDeptIds,
    });
    res.json({ answer });
  } catch (err) {
    console.error('[schedule] ask failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


// POST /api/schedule/help-ask — help assistant: how-to questions about using the app.
router.post('/help-ask', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const question = String(req.body?.question || '').slice(0, 500);
    if (!question.trim()) { res.status(400).json({ error: 'Ask a question.' }); return; }
    const role = req.session.role === 'employee' ? 'employee' : 'admin/scheduler';
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6).map((h: any) => ({
      q: String(h.q || '').slice(0, 500),
      a: String(h.a || '').slice(0, 2000),
    })) : [];
    const { answerHelpQuestion } = await import('../util/gemini.js');
    const { answer, visuals } = await answerHelpQuestion(question, role, history);
    res.json({ answer, visuals });
  } catch (err) {
    console.error('[schedule] help-ask failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});



// POST /api/schedule/agent-suggest — suggest logical next tasks after a completed agent task.
router.post('/agent-suggest', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const task = String(req.body?.task || '').slice(0, 1000);
    const planSummary = String(req.body?.planSummary || '').slice(0, 1000);
    const action = String(req.body?.action || '').slice(0, 50);
    if (!task.trim()) { res.json({ suggestions: [] }); return; }
    const { suggestFollowUps } = await import('../util/gemini.js');
    const suggestions = await suggestFollowUps(task, planSummary, action);
    res.json({ suggestions });
  } catch (err) {
    console.error('[schedule] agent-suggest failed:', err);
    res.json({ suggestions: [] });
  }
});

// POST /api/schedule/agent-plan — in-app agent: turn a plain-language task into an approvable plan.
/**
 * Build a friendly clarification question and tappable options for a missing field.
 * Returns { question, options } where options are candidate values from the DB.
 */
async function buildClarification(
  change: any,
  problem: string,
  companyId: string,
  query: (text: string, params?: any[]) => Promise<{ rows: any[] }>
): Promise<{ question: string; options: string[] }> {
  const p = problem.toLowerCase();
  const ch = change || {};
  // Map problem -> what to ask for and which table to pull options from.
  let question = '';
  let options: string[] = [];
  const memberNames = async () => (await query(
    `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
     FROM users WHERE company_id = $1 AND is_active = true AND role = 'employee' ORDER BY first_name LIMIT 20`,
    [companyId])).rows.map((r: any) => r.name).filter(Boolean);
  const roleNames = async () => (await query(
    `SELECT DISTINCT jr.name FROM job_roles jr
     JOIN departments d ON d.id = jr.department_id
     WHERE d.company_id = $1 ORDER BY jr.name LIMIT 20`,
    [companyId])).rows.map((r: any) => r.name).filter(Boolean);
  const deptNames = async () => (await query(
    'SELECT name FROM departments WHERE company_id = $1 ORDER BY name LIMIT 20',
    [companyId])).rows.map((r: any) => r.name).filter(Boolean);
  const shiftNames = async () => (await query(
    'SELECT name FROM shift_types WHERE company_id = $1 AND is_active = true ORDER BY name LIMIT 20',
    [companyId])).rows.map((r: any) => r.name).filter(Boolean);
  const dashNames = async () => (await query(
    'SELECT name FROM dashboards WHERE company_id = $1 ORDER BY name LIMIT 20',
    [companyId])).rows.map((r: any) => r.name).filter(Boolean);
  const sessionTitles = async () => (await query(
    'SELECT DISTINCT title FROM academic_sessions WHERE company_id = $1 ORDER BY title LIMIT 20',
    [companyId])).rows.map((r: any) => r.title).filter(Boolean);

  if (p.includes('dashboard')) {
    question = 'Which dashboard (calendar) is this session on?';
    options = await dashNames();
  } else if (p.includes('session')) {
    question = 'Which session do you mean?';
    options = await sessionTitles();
  } else if (p.includes('person') || p.includes('member')) {
    const role = ch.jobRoleName ? ` the ${ch.jobRoleName} role` : '';
    question = ch.action === 'update_team_member' && ch.jobRoleName
      ? `Which team member should get the ${ch.jobRoleName} role?`
      : `Which team member${role}?`;
    options = await memberNames();
  } else if (p.includes('job role')) {
    question = 'Which job role?';
    options = await roleNames();
  } else if (p.includes('department')) {
    question = 'Which department?';
    options = await deptNames();
  } else if (p.includes('shift')) {
    question = 'Which shift type?';
    options = await shiftNames();
  } else if (p.includes('date')) {
    question = 'Which date? (e.g. "Oct 25" or "next Monday")';
  } else if (p.includes('target count') || p.includes('count')) {
    question = 'How many people are needed? (just type a number)';
  } else if (p.includes('name')) {
    question = 'What should it be called?';
  } else {
    question = `I need a bit more detail: ${problem}.`;
  }
  return { question, options };
}

router.post('/agent-plan', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const task = String(req.body?.task || '').slice(0, 1000);
    if (!task.trim()) { res.status(400).json({ error: 'Describe the task.' }); return; }
    const { planFromEmail } = await import('../util/gemini.js');
    let plan: any;
    try {
      const { rows: stRows } = await query(
        'SELECT name FROM shift_types WHERE company_id = $1 AND is_active = true', [companyId]);
      const { rows: uRows } = await query(
        `SELECT TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
         FROM users WHERE company_id = $1 AND is_active = true`, [companyId]);
      const { rows: dRows } = await query(
        'SELECT name FROM departments WHERE company_id = $1', [companyId]);
      const today = new Date().toISOString().slice(0, 10);
      const { buildSessionContext } = await import('../util/emailPoller.js');
      const sessionCtx = await buildSessionContext(query, companyId, today);
      plan = await planFromEmail(task, 'In-app agent task', {
        shiftTypes: stRows.map((r: any) => r.name),
        members: uRows.map((r: any) => r.name),
        today,
        ...sessionCtx,
      });
      // Attach department names for settings actions.
      (plan as any).departments = dRows.map((r: any) => r.name);
    } catch (planErr: any) {
      console.error('[schedule] agent-plan parse failed:', planErr?.message);
      res.json({ ok: false, needsClarification: 'I had trouble understanding that task. Try rephrasing it, e.g. "delete the secretary job role from internal medicine".' });
      return;
    }
    // Validate completeness.
    const { changeProblems } = await import('../util/emailPoller.js');
    const incomplete = (plan.changes || [])
      .map((c: any, i: number) => ({ i, problems: changeProblems(c) }))
      .filter((x: any) => x.problems.length > 0);
    if (!plan.changes?.length || incomplete.length || (plan as any).needsClarification) {
      // Build a friendly question + tappable options for the first missing detail.
      let question = (plan as any).needsClarification || 'I could not understand the task well enough to build a plan.';
      let options: string[] = [];
      if (incomplete.length) {
        const ch = plan.changes[incomplete[0].i];
        const prob = incomplete[0].problems[0];
        const built = await buildClarification(ch, prob, companyId, query);
        question = built.question;
        options = built.options;
      }
      res.json({ ok: false, needsClarification: question, clarificationOptions: options, originalTask: task });
      return;
    }
    const { rows } = await query(
      `INSERT INTO schedule_plans
       (company_id, source_subject, source_body, plan_summary, plan, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', NOW()) RETURNING id`,
      [companyId, 'In-app agent task', task, plan.summary, JSON.stringify(plan)]
    );
    res.json({ ok: true, planId: rows[0].id, summary: plan.summary, changes: plan.changes });
  } catch (err) {
    console.error('[schedule] agent-plan failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Schedule change plans — AI-proposed changes awaiting approval
// ---------------------------------------------------------------------------

// GET /api/schedule/plans — list plans (owner/scheduler).
router.get('/plans', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const status = String(req.query.status || 'pending');
    const { rows } = await query(
      `SELECT id, source_from AS "from", source_from_name AS "fromName", source_cc AS "cc",
              source_subject AS "subject",
              plan_summary AS "summary", plan, status,
              created_at AS "createdAt", decided_at AS "decidedAt"
       FROM schedule_plans
       WHERE company_id = $1 AND ($2 = 'all' OR status = $2)
       ORDER BY created_at DESC LIMIT 50`,
      [companyId, status]
    );
    res.json({ plans: rows });
  } catch (err) {
    console.error('[schedule] list plans failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/plans/:id/approve — approve and execute a plan (owner/scheduler).
router.post('/plans/:id/approve', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT * FROM schedule_plans WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Plan not found.' }); return; }
    const plan = rows[0];
    if (plan.status !== 'pending') {
      res.status(400).json({ error: `Plan is already ${plan.status}.` });
      return;
    }
    // Execute the changes.
    const { executePlan } = await import('../util/planExecutor.js');
    try {
      const results = await executePlan(companyId, plan.plan, req.session.userId!);
      await query(
        `UPDATE schedule_plans SET status = 'executed', decided_at = now(),
         decided_by = $2, executed_at = now() WHERE id = $1`,
        [plan.id, req.session.userId!]
      );
      // Audit: record each applied change (agent + email plans).
      try {
        const planSrc = plan.source_subject === 'In-app agent task' ? 'agent' : 'email';
        const changes = (plan.plan && (plan.plan as any).changes) || [];
        const settingsActions = new Set(['add_job_role', 'rename_job_role', 'delete_job_role',
          'add_department', 'rename_department', 'add_team_member', 'update_team_member',
          'add_shift_type', 'rename_shift_type', 'set_staffing_target']);
        for (let i = 0; i < changes.length; i++) {
          const c = changes[i];
          const r = (results as any[])[i];
          if (!r || r.success === false) continue;
          const isSettings = settingsActions.has(c.action);
          await auditLog({
            companyId,
            date: c.date || c.fromDate || todayStr(),
            action: (c.action === 'unassign' || c.action.startsWith('delete')) ? 'deleted'
              : (c.action === 'bulk_publish') ? 'published'
              : (c.action === 'bulk_unpublish') ? 'unpublished'
              : (c.action.startsWith('add')) ? 'created' : 'updated',
            category: isSettings ? 'settings' : 'schedule',
            personName: c.person || c.toPerson || c.firstName || null,
            shiftTypeName: c.shiftType || null,
            source: planSrc as any,
            changedBy: req.session.userId!,
            description: r.message || plan.plan_summary || null,
            details: { planId: plan.id, action: c.action, summary: plan.plan_summary },
          });
        }
      } catch (auditErr) {
        console.error('[schedule] plan audit log failed:', (auditErr as any)?.message);
      }
      res.json({ ok: true, results });
    } catch (execErr: any) {
      await query(
        'UPDATE schedule_plans SET status = $2, error = $3 WHERE id = $1',
        [plan.id, 'failed', execErr?.message || 'Execution failed']
      );
      throw execErr;
    }
  } catch (err) {
    console.error('[schedule] approve plan failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/plans/:id/reject — reject a plan (owner/scheduler).
router.post('/plans/:id/reject', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    await query(
      `UPDATE schedule_plans SET status = 'rejected', decided_at = now(), decided_by = $3
       WHERE id = $1 AND company_id = $2 AND status = 'pending'`,
      [req.params.id, companyId, req.session.userId!]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] reject plan failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/poll-inbox — check Gmail for new schedule emails (owner/scheduler).
// Creates pending plans from unread emails. Never modifies the schedule.
router.post('/poll-inbox', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { pollInbox } = await import('../util/emailPoller.js');
    const result = await pollInbox(query, companyId);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[schedule] poll inbox failed:', err);
    res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/plans/approve/:token — approve via email link (no login, token is auth).
// One-tap: executes immediately.
router.get('/plans/approve/:token', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT id, company_id, plan, plan_summary, status, source_from, source_cc, decided_at FROM schedule_plans WHERE approve_token = $1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send('<h1>Link expired or invalid</h1>');
    const plan = rows[0];
    if (plan.status !== 'pending') {
      const when = plan.decided_at ? ` on ${new Date(plan.decided_at).toLocaleString()}` : '';
      return res.send(`<h1>Already ${escHtml(plan.status)}</h1><p>This plan was already ${escHtml(plan.status)}${escHtml(when)}. No further action needed.</p>`);
    }
    // Department access check: the approver must be logged in and have edit
    // access to all departments affected by the plan. Owners bypass.
    const sessionUserId = (req.session as any)?.userId;
    const sessionRole = (req.session as any)?.role;
    const sessionCompanyId = (req.session as any)?.companyId;
    if (!sessionUserId || sessionCompanyId !== plan.company_id) {
      const loginUrl = `/login.html?redirect=${encodeURIComponent(req.originalUrl)}`;
      return res.send(`<h1>Login required</h1><p>Please <a href="${loginUrl}">log in</a> to approve this plan. This ensures you have access to the affected departments.</p>`);
    }
    if (sessionRole !== 'owner') {
      const { getDepartmentAccess } = await import('../util/departmentAccess.js');
      const access = await getDepartmentAccess(sessionUserId, plan.company_id);
      const planDepts = await getPlanDepartmentIds(plan.company_id, plan.plan);
      const missing = planDepts.filter((d: string) => !access.edit.includes(d));
      if (missing.length) {
        const { rows: drows } = await query('SELECT name FROM departments WHERE id = ANY($1)', [missing]);
        const names = drows.map((r: any) => r.name).join(', ');
        return res.status(403).send(`<h1>Access denied</h1><p>You don't have edit access to: ${escHtml(names)}. Please ask the owner to approve this plan.</p>`);
      }
    }
    // Execute the plan
    const { executePlan } = await import('../util/planExecutor.js');
    const results = await executePlan(plan.company_id, plan.plan, 'email-approval');
    const succeeded = results.filter((r: any) => r.success).length;
    const failed = results.length - succeeded;
    const allOk = failed === 0;
    // Only mark fully approved when every change succeeded; otherwise mark
    // 'partial' so the failure stays visible for the scheduler to fix.
    await query(
      `UPDATE schedule_plans SET status = $2, decided_at = now(), executed_at = now() WHERE id = $1`,
      [plan.id, allOk ? 'approved' : 'partial']
    );
    const itemHtml = results.map((r: any, i: number) => {
      const badge = r.success
        ? '<span style="display:inline-block;font-size:0.75rem;font-weight:700;color:#166534;background:#dcfce7;border-radius:6px;padding:2px 8px;margin-right:6px">Applied</span>'
        : '<span style="display:inline-block;font-size:0.75rem;font-weight:700;color:#991b1b;background:#fee2e2;border-radius:6px;padding:2px 8px;margin-right:6px">Failed</span>';
      return `<li style="margin:0.5rem 0">${badge}<strong>Change ${i + 1} (${escHtml(String(r.action))})</strong> — ${escHtml(String(r.message))}</li>`;
    }).join('');
    const head = allOk
      ? `<h1>Approved &amp; applied</h1><p>${succeeded} of ${results.length} change(s) applied to the schedule.</p>`
      : `<h1>Partially applied</h1><p>${succeeded} of ${results.length} change(s) applied. ${failed} change(s) failed and were <strong>not</strong> applied.</p>` +
        `<p>Please contact your scheduler — they can fix the failed change(s) in the app and apply them manually.</p>`;
    res.send(
      `<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem">` +
      head + `<ul style="list-style:none;padding:0">${itemHtml}</ul></body></html>`
    );
    // Notify the requester of the outcome.
    try {
      const { sendMail } = await import('../util/mailer.js');
      const reqEmail = (plan.source_from || '').trim();
      if (reqEmail && reqEmail.includes('@')) {
        const outcome = allOk ? 'approved and applied' : 'partially applied';
        const ccList = String(plan.source_cc || '').split(',').map((s) => s.trim()).filter((s) => s.includes('@') && s.toLowerCase() !== reqEmail.toLowerCase());
        const detailText = results.map((r: any, i: number) =>
          `${i + 1}. [${r.success ? 'Applied' : 'FAILED'}] ${r.action}: ${r.message}`
        ).join('\n');
        const detailHtml = results.map((r: any, i: number) =>
          `<li><strong>${r.success ? 'Applied' : 'Failed'}:</strong> ${escHtml(String(r.message))}</li>`
        ).join('');
        await sendMail({
          to: reqEmail,
          cc: ccList.length ? ccList : undefined,
          subject: `Request ${allOk ? 'approved' : 'partially applied'}: ${(plan.plan_summary || '').substring(0, 60)}`,
          text: `Hi,\n\nYour request was ${outcome}.\n\nSummary: ${plan.plan_summary}\n\n${succeeded} of ${results.length} change(s) applied.${failed ? ` ${failed} failed.` : ''}\n\nDetails:\n${detailText}\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>Your request was <strong>${outcome}</strong>.</p><p><strong>Summary:</strong> ${plan.plan_summary}</p><p>${succeeded} of ${results.length} change(s) applied.${failed ? ` ${failed} failed.` : ''}</p><ul>${detailHtml}</ul><p>— Quick Scheduling</p>`,
        });
      }
    } catch { /* non-fatal */ }
  } catch (err: any) {
    console.error('[schedule] email approve failed:', err);
    res.status(500).send(`<h1>Error</h1><p>${escHtml(err.message)}</p>`);
  }
});

// GET /api/schedule/plans/reject/:token — reject via email link.
router.get('/plans/reject/:token', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT id, status, plan_summary, source_from, source_cc FROM schedule_plans WHERE reject_token = $1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send('<h1>Link expired or invalid</h1>');
    if (rows[0].status !== 'pending') return res.send(`<h1>Already ${rows[0].status}</h1>`);
    await query(`UPDATE schedule_plans SET status = 'rejected', decided_at = now() WHERE id = $1`, [rows[0].id]);
    // Notify the requester.
    try {
      const { sendMail } = await import('../util/mailer.js');
      const reqEmail = (rows[0].source_from || '').trim();
      if (reqEmail && reqEmail.includes('@')) {
        const ccList = String(rows[0].source_cc || '').split(',').map((s) => s.trim()).filter((s) => s.includes('@') && s.toLowerCase() !== reqEmail.toLowerCase());
        await sendMail({
          to: reqEmail,
          cc: ccList.length ? ccList : undefined,
          subject: `Request rejected: ${(rows[0].plan_summary || '').substring(0, 60)}`,
          text: `Hi,\n\nYour request was rejected and will not be applied.\n\nSummary: ${rows[0].plan_summary}\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>Your request was <strong>rejected</strong> and will not be applied.</p><p><strong>Summary:</strong> ${rows[0].plan_summary}</p><p>— Quick Scheduling</p>`,
        });
      }
    } catch { /* non-fatal */ }
    res.send('<h1>Rejected</h1><p>The plan was rejected and will not be applied.</p>');
  } catch (err) {
    res.status(500).send('<h1>Error</h1>');
  }
});

// ---------------------------------------------------------------------------
// Quick session links (migration 062, Deepika 2026-10-21): plan-approval
// emails carry a "Quick session" button next to Approve / Reject. The
// link opens a small standalone session form — no app, no login (the
// token is the auth, like the approve/reject tokens) — to add a session
// or change/cancel one right from the email. Tokens are company-scoped,
// optionally prefilled to one dashboard / session / date, 7-day expiry.
// ---------------------------------------------------------------------------

async function loadQuickLink(token: string): Promise<any | null> {
  const { rows } = await query(
    'SELECT *, occ_date::text AS occ_date FROM quick_session_links WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
  return rows[0] || null;
}

router.get('/quick-session/:token', async (req: Request, res: Response) => {
  try {
    const link = await loadQuickLink(String(req.params.token));
    const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
    if (!link) {
      res.status(404).send(`<h1 style="font-family:sans-serif">Link expired or invalid</h1><p style="font-family:sans-serif">Quick session links work for 7 days. <a href="${baseUrl}">Open the app</a> to make the change instead.</p>`);
      return;
    }
    const companyId = link.company_id;
    const { rows: dashes } = await query('SELECT id, name FROM dashboards WHERE company_id = $1 ORDER BY name', [companyId]);
    const { rows: kinds } = await query('SELECT dashboard_id, key, label FROM session_kinds WHERE company_id = $1 ORDER BY position, label', [companyId]);
    const { rows: dds } = await query(
      `SELECT dd.dashboard_id, d.id, d.name FROM dashboard_departments dd
       JOIN departments d ON d.id = dd.department_id
       JOIN dashboards db ON db.id = dd.dashboard_id WHERE db.company_id = $1`, [companyId]);
    const { rows: members } = await query(
      `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
       FROM users WHERE company_id = $1 AND is_active = true ORDER BY first_name`, [companyId]);
    const { rows: rooms } = await query('SELECT name FROM rooms WHERE company_id = $1 ORDER BY name', [companyId]);
    const { rows: sess } = await query(
      `SELECT id, dashboard_id, title, session_date::text AS sdate, start_time::text AS stime, end_time::text AS etime,
              recur_rule, recur_interval, location, kind, lecturer_user_id, supervisor_user_id
       FROM academic_sessions WHERE company_id = $1 ORDER BY session_date`, [companyId]);
    const data = {
      dashboards: dashes,
      kindsByDash: {} as Record<string, any[]>,
      deptsByDash: {} as Record<string, any[]>,
      members,
      rooms: rooms.map((r: any) => r.name),
      sessionsByDash: {} as Record<string, any[]>,
      prefill: {
        dashboardId: link.dashboard_id || null,
        sessionId: link.session_id || null,
        date: link.occ_date ? String(link.occ_date).slice(0, 10) : null,
      },
    };
    for (const k of kinds) { if (!k.dashboard_id) continue; (data.kindsByDash[k.dashboard_id] ||= []).push({ key: k.key, label: k.label }); }
    for (const d of dds) { (data.deptsByDash[d.dashboard_id] ||= []).push({ id: d.id, name: d.name }); }
    const memberName = new Map(members.map((m: any) => [m.id, m.name]));
    for (const s of sess) {
      if (!s.dashboard_id) continue;
      (data.sessionsByDash[s.dashboard_id] ||= []).push({
        id: s.id, title: s.title, sdate: s.sdate,
        stime: s.stime ? String(s.stime).slice(0, 5) : '', etime: s.etime ? String(s.etime).slice(0, 5) : '',
        recur: s.recur_rule && s.recur_rule !== 'none' ? s.recur_rule : '',
        interval: s.recur_interval || 1, location: s.location || '', kind: s.kind || 'session',
        presenterName: s.lecturer_user_id ? (memberName.get(s.lecturer_user_id) || '') : '',
        supervisorName: s.supervisor_user_id ? (memberName.get(s.supervisor_user_id) || '') : '',
      });
    }
    const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
    res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quick session</title>
<style>
  body{font-family:-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;background:#f6f7f9;color:#111827}
  .wrap{max-width:560px;margin:0 auto;padding:16px}
  h1{font-size:20px;margin:8px 0 2px} .sub{color:#6b7280;font-size:13px;margin-bottom:14px}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 4px}
  input,select,textarea{width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #d1d5db;border-radius:8px;background:#fff}
  .row{display:flex;gap:10px}.row>div{flex:1}
  .tabs{display:flex;gap:8px;margin:14px 0 4px}
  .tabs button{flex:1;padding:11px;border-radius:8px;border:1px solid #d1d5db;background:#fff;font-size:15px;font-weight:600;cursor:pointer}
  .tabs button.on{background:#2563eb;color:#fff;border-color:#2563eb}
  .go{width:100%;margin-top:18px;padding:13px;font-size:16px;font-weight:700;color:#fff;background:#2563eb;border:0;border-radius:8px;cursor:pointer}
  .go:disabled{opacity:.5}
  .danger{width:100%;margin-top:10px;padding:12px;font-size:15px;font-weight:600;color:#fff;background:#ef4444;border:0;border-radius:8px;cursor:pointer}
  .danger.ghost{background:#fff;color:#ef4444;border:1px solid #ef4444}
  #msg{display:none;padding:12px;border-radius:8px;margin:12px 0;font-size:15px}
  #msg.ok{display:block;background:#dcfce7;color:#166534}#msg.err{display:block;background:#fee2e2;color:#991b1b}
  .hint{font-size:13px;color:#374151;background:#eef2ff;border-radius:8px;padding:9px 11px;margin-top:8px}
  .radios{display:flex;gap:8px;margin-top:6px}.radios label{flex:1;margin:0;font-weight:500;font-size:14px;border:1px solid #d1d5db;border-radius:8px;padding:9px;text-align:center;background:#fff;cursor:pointer}
  .radios input{width:auto;margin-right:6px}
  .small{font-size:12px;color:#6b7280;font-weight:400}
</style></head>
<body><div class="wrap">
  <h1>📅 Quick session</h1>
  <div class="sub">Add a session, or change / cancel one — right here, no app needed.</div>
  <div id="msg"></div>
  <label>Dashboard (calendar)</label>
  <select id="dash"></select>
  <div class="tabs"><button id="tabAdd" class="on" type="button">➕ Add a session</button><button id="tabChange" type="button">✏️ Change a session</button></div>

  <section id="addForm">
    <label>Session title</label><input id="a-title" placeholder="e.g. Morning Report">
    <div class="row"><div><label>Date</label><input id="a-date" type="date"></div>
    <div><label>Session type</label><select id="a-kind"></select></div></div>
    <div class="row"><div><label>Starts</label><input id="a-start" type="time"></div>
    <div><label>Ends</label><input id="a-end" type="time"></div></div>
    <label>Presenter</label><select id="a-presenter"></select>
    <label>Supervisor</label><select id="a-supervisor"></select>
    <label>Room / location</label><input id="a-location" list="rooms" placeholder="Type or pick a room"><datalist id="rooms"></datalist>
    <div id="a-deptwrap"><label>Department</label><select id="a-dept"></select></div>
    <label>Repeats</label><select id="a-recur"><option value="none">Does not repeat</option><option value="weekly1">Weekly</option><option value="weekly2">Every 2 weeks</option></select>
    <div id="a-untilwrap" style="display:none"><label>Repeat until <span class="small">(optional)</span></label><input id="a-until" type="date"></div>
    <label>Notes <span class="small">(optional)</span></label><input id="a-notes">
    <button class="go" id="a-save" type="button">Add session</button>
  </section>

  <section id="changeForm" style="display:none">
    <label>Session</label><select id="c-session"></select>
    <div class="hint" id="c-hint" style="display:none"></div>
    <label>Date this change is about</label><input id="c-date" type="date">
    <div id="c-scopewrap"><label>Apply to</label><div class="radios">
      <label><input type="radio" name="scope" value="date" checked>Just this date</label>
      <label><input type="radio" name="scope" value="series">Whole series</label>
    </div></div>
    <div class="small" style="margin-top:10px">Leave a field blank to keep it as it is.</div>
    <label>New title</label><input id="c-title" placeholder="No change">
    <label>Presenter</label><select id="c-presenter"></select>
    <label>Supervisor</label><select id="c-supervisor"></select>
    <label>Room / location</label><input id="c-location" list="rooms" placeholder="No change">
    <div class="row"><div><label>Starts</label><input id="c-start" type="time"></div>
    <div><label>Ends</label><input id="c-end" type="time"></div></div>
    <label>Move to a different date <span class="small">(optional)</span></label><input id="c-newdate" type="date">
    <button class="go" id="c-save" type="button">Save changes</button>
    <button class="danger ghost" id="c-cancel-date" type="button">🚫 Cancel just this date</button>
    <button class="danger" id="c-cancel-all" type="button">🗑 Cancel the whole session</button>
  </section>
</div>
<script>
const DATA = ${dataJson};
const $ = (id) => document.getElementById(id);
const msg = (ok, text) => { const m = $('msg'); m.className = ok ? 'ok' : 'err'; m.textContent = text; m.scrollIntoView({behavior:'smooth', block:'center'}); };
const memberOpts = (el, blankLabel, withNobody) => {
  el.innerHTML = '';
  const o0 = document.createElement('option'); o0.value = ''; o0.textContent = blankLabel; el.appendChild(o0);
  if (withNobody) { const on = document.createElement('option'); on.value = 'none'; on.textContent = '— Nobody —'; el.appendChild(on); }
  for (const m of DATA.members) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.name; el.appendChild(o); }
};
function dashChanged() {
  const d = $('dash').value;
  const kinds = DATA.kindsByDash[d] || [{key:'session',label:'Lecture'},{key:'event',label:'Event'}];
  $('a-kind').innerHTML = '';
  for (const k of kinds) { const o = document.createElement('option'); o.value = k.key; o.textContent = k.label; $('a-kind').appendChild(o); }
  const depts = DATA.deptsByDash[d] || [];
  $('a-deptwrap').style.display = depts.length ? '' : 'none';
  $('a-dept').innerHTML = '';
  for (const dep of depts) { const o = document.createElement('option'); o.value = dep.id; o.textContent = dep.name; $('a-dept').appendChild(o); }
  const list = DATA.sessionsByDash[d] || [];
  $('c-session').innerHTML = '';
  for (const s of list) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.title + (s.recur ? ' (repeats)' : ' — ' + s.sdate); $('c-session').appendChild(o); }
  sessionChanged();
  const pre = DATA.prefill;
  if (pre.sessionId && list.some((s) => s.id === pre.sessionId)) { $('c-session').value = pre.sessionId; sessionChanged(); showChange(); }
}
function curSession() {
  const list = DATA.sessionsByDash[$('dash').value] || [];
  return list.find((s) => s.id === $('c-session').value) || null;
}
function sessionChanged() {
  const s = curSession();
  const hint = $('c-hint');
  if (!s) { hint.style.display = 'none'; $('c-scopewrap').style.display = 'none'; return; }
  const parts = [];
  if (s.recur) parts.push('Repeats ' + s.recur + (s.interval > 1 ? ' every ' + s.interval : ''));
  else parts.push('One-time on ' + s.sdate);
  if (s.stime) parts.push(s.stime + (s.etime ? '–' + s.etime : ''));
  if (s.presenterName) parts.push('Presenter: ' + s.presenterName);
  if (s.supervisorName) parts.push('Supervisor: ' + s.supervisorName);
  if (s.location) parts.push('In ' + s.location);
  hint.textContent = parts.join(' · ');
  hint.style.display = '';
  $('c-scopewrap').style.display = s.recur ? '' : 'none';
  $('c-cancel-date').style.display = s.recur ? '' : 'none';
}
function showAdd() { $('addForm').style.display = ''; $('changeForm').style.display = 'none'; $('tabAdd').classList.add('on'); $('tabChange').classList.remove('on'); }
function showChange() { $('addForm').style.display = 'none'; $('changeForm').style.display = ''; $('tabAdd').classList.remove('on'); $('tabChange').classList.add('on'); }
async function post(body, btn) {
  btn.disabled = true;
  try {
    const r = await fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (j.ok) { msg(true, '✅ ' + j.message); }
    else msg(false, j.error || 'Something went wrong. Please try again.');
  } catch (e) { msg(false, 'Network error — please try again.'); }
  btn.disabled = false;
}
// init
for (const d of DATA.dashboards) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; $('dash').appendChild(o); }
for (const name of DATA.rooms) { const o = document.createElement('option'); o.value = name; $('rooms').appendChild(o); }
memberOpts($('a-presenter'), '— Nobody —', false);
memberOpts($('a-supervisor'), '— Nobody —', false);
memberOpts($('c-presenter'), '— No change —', true);
memberOpts($('c-supervisor'), '— No change —', true);
if (DATA.prefill.dashboardId) $('dash').value = DATA.prefill.dashboardId;
if (DATA.prefill.date) { $('a-date').value = DATA.prefill.date; $('c-date').value = DATA.prefill.date; }
$('a-date').value = $('a-date').value || new Date().toISOString().slice(0, 10);
$('c-date').value = $('c-date').value || new Date().toISOString().slice(0, 10);
$('dash').addEventListener('change', dashChanged);
$('c-session').addEventListener('change', sessionChanged);
$('tabAdd').addEventListener('click', showAdd);
$('tabChange').addEventListener('click', showChange);
$('a-recur').addEventListener('change', () => { $('a-untilwrap').style.display = $('a-recur').value === 'none' ? 'none' : ''; });
dashChanged();
if (DATA.prefill.sessionId) showChange();
$('a-save').addEventListener('click', () => {
  const title = $('a-title').value.trim();
  if (!title) { msg(false, 'Give the session a title first.'); return; }
  if (!$('a-date').value) { msg(false, 'Pick a date first.'); return; }
  post({ mode: 'add', dashboardId: $('dash').value, title, date: $('a-date').value,
    startTime: $('a-start').value || null, endTime: $('a-end').value || null,
    kindKey: $('a-kind').value, presenterId: $('a-presenter').value || null,
    supervisorId: $('a-supervisor').value || null, location: $('a-location').value.trim() || null,
    departmentId: $('a-dept').value || null, recur: $('a-recur').value,
    recurUntil: $('a-until').value || null, notes: $('a-notes').value.trim() || null }, $('a-save'));
});
$('c-save').addEventListener('click', () => {
  const s = curSession();
  if (!s) { msg(false, 'Pick a session first.'); return; }
  const fields = {};
  if ($('c-title').value.trim()) fields.title = $('c-title').value.trim();
  if ($('c-presenter').value) fields.presenterId = $('c-presenter').value === 'none' ? null : $('c-presenter').value;
  if ($('c-supervisor').value) fields.supervisorId = $('c-supervisor').value === 'none' ? null : $('c-supervisor').value;
  if ($('c-location').value.trim()) fields.location = $('c-location').value.trim();
  if ($('c-start').value) fields.startTime = $('c-start').value;
  if ($('c-end').value) fields.endTime = $('c-end').value;
  const scope = s.recur ? (document.querySelector('input[name=scope]:checked') || {}).value || 'date' : 'series';
  post({ mode: 'update', sessionId: s.id, scope, date: $('c-date').value || null,
    newDate: $('c-newdate').value || null, fields }, $('c-save'));
});
$('c-cancel-date').addEventListener('click', () => {
  const s = curSession(); if (!s) return;
  if (!$('c-date').value) { msg(false, 'Pick the date to cancel first.'); return; }
  if (!confirm('Cancel "' + s.title + '" on ' + $('c-date').value + ' (just this date)?')) return;
  post({ mode: 'cancel', sessionId: s.id, scope: 'date', date: $('c-date').value }, $('c-cancel-date'));
});
$('c-cancel-all').addEventListener('click', () => {
  const s = curSession(); if (!s) return;
  if (!confirm('Cancel "' + s.title + '"' + (s.recur ? ' — the WHOLE series?' : '?'))) return;
  post({ mode: 'cancel', sessionId: s.id, scope: 'series', date: null }, $('c-cancel-all'));
});
</script>
</div></body></html>`);
  } catch (err) {
    console.error('[schedule] quick-session page failed:', err);
    res.status(500).send('<h1 style="font-family:sans-serif">Error</h1><p style="font-family:sans-serif">Something went wrong. Please try again.</p>');
  }
});

router.post('/quick-session/:token', async (req: Request, res: Response) => {
  try {
    const link = await loadQuickLink(String(req.params.token));
    if (!link) { res.status(404).json({ error: 'This quick link has expired. Open the app to make the change.' }); return; }
    const companyId = link.company_id;
    const b = req.body ?? {};
    const { insertSession, updateSessionSeries, updateSessionDate, cancelSessionDate, deleteSessionRow, moveSessionDate } =
      await import('../util/planExecutor.js');
    const { rows: ow } = await query("SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true LIMIT 1", [companyId]);
    const ownerId = ow[0]?.id ?? null;
    const validUser = async (id: any): Promise<boolean> => {
      if (!id) return true;
      const { rows } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [String(id), companyId]);
      return rows.length > 0;
    };

    if (b.mode === 'add') {
      const dashboardId = String(b.dashboardId || '');
      const { rows: dRows } = await query('SELECT id, name FROM dashboards WHERE id = $1 AND company_id = $2', [dashboardId, companyId]);
      if (!dRows.length) { res.status(400).json({ error: 'Unknown dashboard.' }); return; }
      const title = String(b.title || '').trim();
      const date = String(b.date || '');
      if (!title) { res.status(400).json({ error: 'A title is required.' }); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'Pick a date.' }); return; }
      if (!(await validUser(b.presenterId)) || !(await validUser(b.supervisorId))) {
        res.status(400).json({ error: 'That person is not an active team member.' }); return;
      }
      let kindKey = 'session';
      if (b.kindKey) {
        const { rows: kRows } = await query('SELECT key FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 AND key = $3', [companyId, dashboardId, String(b.kindKey)]);
        if (kRows.length) kindKey = String(b.kindKey);
      }
      let departmentId: string | null = null;
      const { rows: ddRows } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [dashboardId]);
      const dashDepts = ddRows.map((r: any) => r.department_id);
      if (b.departmentId && dashDepts.includes(String(b.departmentId))) departmentId = String(b.departmentId);
      else if (dashDepts.length === 1) departmentId = dashDepts[0];
      const recurRule = b.recur === 'weekly1' || b.recur === 'weekly2' ? 'weekly' : 'none';
      await insertSession(companyId, ownerId, dashboardId, {
        title, date,
        startTime: b.startTime || null, endTime: b.endTime || null,
        presenterId: b.presenterId || null, supervisorId: b.supervisorId || null,
        location: b.location ? String(b.location).trim() : null,
        kindKey, departmentId, notes: b.notes ? String(b.notes).trim() : null,
        recurRule, recurInterval: b.recur === 'weekly2' ? 2 : 1,
        recurUntil: recurRule !== 'none' && b.recurUntil ? String(b.recurUntil) : null,
      });
      res.json({ ok: true, message: `Added "${title}" to ${dRows[0].name} on ${date}${recurRule !== 'none' ? ' (repeating weekly)' : ''}.` });
      {
        const people = [b.presenterId, b.supervisorId].filter(Boolean).map(String);
        if (people.length) {
          notify({
            companyId, userIds: people, category: 'calendar', type: 'session_assigned',
            title: `New session: "${title}" on ${fmtDateLong(date)}`,
            body: `You are on the session "${title}" (${dRows[0].name}) on ${fmtDateLong(date)}${b.startTime ? ` at ${String(b.startTime).slice(0, 5)}` : ''}.`,
            link: 'calendars', bundleKey: 'session_assigned',
          });
        }
      }
      return;
    }

    if (b.mode === 'update' || b.mode === 'cancel') {
      const sessionId = String(b.sessionId || '');
      const { rows: sRows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [sessionId, companyId]);
      if (!sRows.length) { res.status(404).json({ error: 'Session not found.' }); return; }
      const sess = sRows[0];
      const recurring = !!(sess.recur_rule && sess.recur_rule !== 'none');
      const scope = recurring && b.scope === 'date' ? 'date' : 'series';
      const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : null;

      if (b.mode === 'cancel') {
        if (scope === 'date') {
          if (!date) { res.status(400).json({ error: 'Pick the date to cancel.' }); return; }
          await cancelSessionDate(companyId, sess.id, date);
          res.json({ ok: true, message: `Cancelled "${sess.title}" on ${date} (just this date).` });
        } else {
          await deleteSessionRow(companyId, sess.id);
          res.json({ ok: true, message: `Cancelled "${sess.title}"${recurring ? ' (whole series)' : ''}.` });
        }
        {
          const people = [sess.lecturer_user_id, sess.supervisor_user_id].filter(Boolean) as string[];
          if (people.length) {
            notify({
              companyId, userIds: people, category: 'calendar', type: 'session_cancelled',
              title: `Session cancelled: "${sess.title}"`,
              body: `The session "${sess.title}" was cancelled${scope === 'date' && date ? ` for ${fmtDateLong(date)} (just this date)` : ''}.`,
              link: 'calendars', bundleKey: 'session_cancelled',
            });
          }
        }
        return;
      }

      // update
      const fIn = (b.fields && typeof b.fields === 'object') ? b.fields : {};
      const f: any = {};
      if (typeof fIn.title === 'string' && fIn.title.trim()) f.title = fIn.title.trim();
      if ('presenterId' in fIn) { if (!(await validUser(fIn.presenterId))) { res.status(400).json({ error: 'That presenter is not an active team member.' }); return; } f.presenterId = fIn.presenterId || null; }
      if ('supervisorId' in fIn) { if (!(await validUser(fIn.supervisorId))) { res.status(400).json({ error: 'That supervisor is not an active team member.' }); return; } f.supervisorId = fIn.supervisorId || null; }
      if (typeof fIn.location === 'string' && fIn.location.trim()) f.location = fIn.location.trim();
      if (fIn.startTime) f.startTime = String(fIn.startTime);
      if (fIn.endTime) f.endTime = String(fIn.endTime);
      const newDate = b.newDate && /^\d{4}-\d{2}-\d{2}$/.test(String(b.newDate)) ? String(b.newDate) : null;
      if (!newDate && !Object.keys(f).length) { res.status(400).json({ error: 'Fill in at least one field to change.' }); return; }
      if (newDate) {
        if (!recurring || scope === 'series') {
          await updateSessionSeries(companyId, sess, { ...f, date: newDate });
          res.json({ ok: true, message: `Moved "${sess.title}" to ${newDate}.` });
        } else {
          if (!date) { res.status(400).json({ error: 'Pick the date to move from.' }); return; }
          await moveSessionDate(companyId, ownerId, sess, date, newDate, f);
          res.json({ ok: true, message: `Moved "${sess.title}" from ${date} to ${newDate} (just that date).` });
        }
        {
          const people = [sess.lecturer_user_id, sess.supervisor_user_id, f.presenterId || null, f.supervisorId || null].filter(Boolean) as string[];
          if (people.length) {
            notify({
              companyId, userIds: [...new Set(people)], category: 'calendar', type: 'session_changed',
              title: `Session moved: "${sess.title}" to ${fmtDateLong(newDate)}`,
              body: `The session "${sess.title}" was moved to ${fmtDateLong(newDate)}.`,
              link: 'calendars', bundleKey: 'session_changed',
            });
          }
        }
        return;
      }
      if (scope === 'date') {
        if (!date) { res.status(400).json({ error: 'Pick the date this change is about.' }); return; }
        const skipped = await updateSessionDate(companyId, sess, date, f);
        res.json({ ok: true, message: `Updated "${sess.title}" for ${date} (just this date).` + (skipped.length ? ` Note: ${skipped.join(' and ')} can only change for the whole series.` : '') });
      } else {
        await updateSessionSeries(companyId, sess, f);
        res.json({ ok: true, message: `Updated "${sess.title}"${recurring ? ' (whole series)' : ''}.` });
      }
      {
        const people = [sess.lecturer_user_id, sess.supervisor_user_id, f.presenterId || null, f.supervisorId || null].filter(Boolean) as string[];
        if (people.length) {
          notify({
            companyId, userIds: [...new Set(people)], category: 'calendar', type: 'session_changed',
            title: `Session changed: "${f.title || sess.title}"`,
            body: `The session "${sess.title}" was updated from an email quick link.`,
            link: 'calendars', bundleKey: 'session_changed',
          });
        }
      }
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('[schedule] quick-session apply failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Employee self-service — open-slot claims, pickup/swap requests (migration 034).
// Allowed roles: owner, scheduler, employee.
// Employees see all departments' schedules read-only (see GET /shifts below —
// no department filtering on reads), and may only act on their own shifts.
// Only REAL (manual) shift rows participate here: rotation-generated entries
// have no shift row (their ids look like "rot-...") and are schedulers'
// territory.
// ---------------------------------------------------------------------------

/** Error that carries an HTTP status through withTransaction's catch. */
class RequestError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Active team member of this company, or null. */
async function activeMember(companyId: string, userId: string): Promise<any | null> {
  const { rows } = await query(
    'SELECT id, role FROM users WHERE id = $1 AND company_id = $2 AND is_active = true',
    [userId, companyId]
  );
  return rows[0] || null;
}

/** A real (manual) shift row in this company, or null. */
async function manualShift(companyId: string, shiftId: string): Promise<any | null> {
  const { rows } = await query(
    `SELECT s.id, s.user_id AS "userId", s.shift_type_id AS "shiftTypeId",
            s.date::text AS date, st.name AS "shiftTypeName"
     FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [shiftId, companyId]
  );
  return rows[0] || null;
}

// POST /api/schedule/open-slots/claim — claim one extra open slot as your shift.
// Atomic: the UPDATE ... WHERE count > 0 serializes concurrent claims on the
// row lock, so two people can never claim the same slot.
router.post('/open-slots/claim', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const { date, shiftTypeId } = req.body ?? {};
    if (!isValidDate(date) || typeof shiftTypeId !== 'string' || !shiftTypeId) {
      res.status(400).json({ error: 'A valid date and shift type are required.' });
      return;
    }
    if (!(await activeMember(companyId, me))) {
      res.status(403).json({ error: 'Your account is not active.' });
      return;
    }
    const { rows: trows } = await query(
      'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) {
      res.status(404).json({ error: 'Shift type not found.' });
      return;
    }
    // Job-role eligibility: symmetric gate — the member's linked job role
    // must be in the shift type's eligible list (empty list = everyone).
    const elig = await checkShiftEligibility(companyId, me, trows[0].eligible_job_role_ids);
    if (!elig.ok) {
      res.status(403).json({ error: elig.error });
      return;
    }
    const shiftId = crypto.randomUUID();
    let claimed = false;
    try {
      await withTransaction(async (tx) => {
        // Path 1: manually-added extra open slots (atomic row-locked decrement).
        const { rows: slotRows } = await tx.query(
          `UPDATE extra_open_slots SET count = count - 1
           WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count > 0
           RETURNING count`,
          [companyId, date, shiftTypeId]
        );
        if (slotRows.length) {
          if (Number(slotRows[0].count) <= 0) {
            await tx.query(
              'DELETE FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
              [companyId, date, shiftTypeId]
            );
          }
          await tx.query(
            `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
             VALUES ($1, $2, $3, $4, $5, true, $6)`,
            [shiftId, companyId, me, shiftTypeId, date, me]
          );
          claimed = true;
          return;
        }
        // Path 2: staffing-target gap (no extra_open_slots row). Lock the target
        // row so concurrent claims for the same shift type serialize.
        const { rows: crows } = await tx.query(
          'SELECT 1 FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
          [companyId, date, shiftTypeId]
        );
        if (crows.length) return; // closed — nothing to claim
        const { rows: trows } = await tx.query(
          `SELECT target_count, weekdays, start_date::text AS start_date, end_date::text AS end_date
           FROM staffing_targets
           WHERE company_id = $1 AND shift_type_id = $2 FOR UPDATE`,
          [companyId, shiftTypeId]
        );
        if (!trows.length) return; // no target and no extra slots — nothing to claim
        const t = trows[0];
        const dow = new Date(date + 'T00:00:00').getDay();
        const wdays: number[] = t.weekdays || [0, 1, 2, 3, 4, 5, 6];
        if (wdays.indexOf(dow) === -1) return;
        const sd: string | null = t.start_date || null;
        const ed: string | null = t.end_date || null;
        if ((sd && date < sd) || (ed && date > ed)) return;
        const { rows: frows } = await tx.query(
          'SELECT COUNT(*)::int AS n FROM shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
          [companyId, date, shiftTypeId]
        );
        if (frows[0].n >= (t.target_count || 0)) return; // gap already filled
        await tx.query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)`,
          [shiftId, companyId, me, shiftTypeId, date, me]
        );
        claimed = true;
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'You already have that shift on that date.' });
        return;
      }
      throw err;
    }
    if (!claimed) {
      res.status(409).json({ error: 'That open slot was just taken by someone else.' });
      return;
    }
    res.status(201).json({ id: shiftId, date, shiftTypeId, userId: me });
    // Audit: shift created.
    const names = await shiftDisplayNames(companyId, me, shiftTypeId);
    auditLog({
      companyId, date, action: 'created',
      personName: names.personName, shiftTypeName: names.shiftTypeName,
      source: 'manual', changedBy: me,
      details: { via: 'open-slot-claim' },
    });
  } catch (err) {
    console.error('[schedule] claim open slot failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Notify the people who can decide shift requests for a shift (owners +
// schedulers with Edit on the shift's departments) that one is waiting.
async function notifyShiftRequestApprovers(
  companyId: string,
  shift: { userId: string; shiftTypeId: string },
  actorId: string,
  title: string,
  body: string
): Promise<void> {
  try {
    const depts = await assignmentRelevantDepartments([{ userId: shift.userId, shiftTypeId: shift.shiftTypeId }], companyId);
    const ids = new Set<string>();
    for (const d of depts) {
      for (const id of await deptApproverIds(companyId, d)) ids.add(id);
    }
    if (!depts.length) {
      for (const id of await deptApproverIds(companyId, null)) ids.add(id);
    }
    if (ids.size) {
      await notify({
        companyId, userIds: [...ids], category: 'approvals', type: 'shift_request_waiting',
        title, body, link: 'requests', bundleKey: 'shift_request_waiting',
        bundleTitle: '{count} shift requests are waiting for a decision',
        excludeUserId: actorId,
      });
    }
  } catch { /* best-effort */ }
}

// POST /api/schedule/shifts/:id/request-pickup — ask someone (or anyone) to
// take over one of your shifts. Requester must own the shift (or be
// scheduler/owner). targetUserId null = open to the whole company.
router.post('/shifts/:id/request-pickup', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const shiftId = req.params.id;
    const targetUserId = req.body?.targetUserId ? String(req.body.targetUserId) : null;

    const shift = await manualShift(companyId, shiftId);
    if (!shift) {
      res.status(404).json({ error: 'Shift not found.' });
      return;
    }
    const isPrivileged = role === 'owner' || role === 'scheduler';
    if (shift.userId !== me && !isPrivileged) {
      res.status(403).json({ error: 'You can only request pickup for your own shifts.' });
      return;
    }
    if (targetUserId) {
      const target = await activeMember(companyId, targetUserId);
      if (!target) {
        res.status(404).json({ error: 'That team member was not found or is not active.' });
        return;
      }
      if (targetUserId === shift.userId) {
        res.status(400).json({ error: 'That shift is already assigned to them.' });
        return;
      }
    }
    const { rows: existing } = await query(
      "SELECT id FROM shift_requests WHERE company_id = $1 AND shift_id = $2 AND status = 'pending' LIMIT 1",
      [companyId, shiftId]
    );
    if (existing.length) {
      res.status(409).json({ error: 'There is already a pending request for that shift.' });
      return;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO shift_requests (id, company_id, request_type, shift_id, requester_id, target_user_id, status)
       VALUES ($1, $2, 'pickup', $3, $4, $5, 'pending')`,
      [id, companyId, shiftId, me, targetUserId]
    );
    res.status(201).json({
      id, requestType: 'pickup', shiftId, targetUserId, requesterId: me, status: 'pending',
      shift: { date: shift.date, shiftTypeName: shift.shiftTypeName },
    });
    // Notify the target (if any) and the approvers.
    {
      const names = await shiftDisplayNames(companyId, me, shift.shiftTypeId);
      if (targetUserId) {
        notify({
          companyId, userIds: [targetUserId], category: 'schedule', type: 'request_to_you',
          title: `${names.personName} asked you to pick up a shift`,
          body: `${names.personName} asked you to pick up ${shift.shiftTypeName} on ${fmtDateLong(shift.date)}.`,
          link: 'requests', bundleKey: 'request_to_you',
          bundleTitle: '{count} requests are waiting for you',
          excludeUserId: me,
        });
      }
      notifyShiftRequestApprovers(companyId, { userId: shift.userId, shiftTypeId: shift.shiftTypeId }, me,
        'A shift request is waiting for a decision',
        `${names.personName} requested pickup for ${shift.shiftTypeName} on ${fmtDateLong(shift.date)}.`);
    }
  } catch (err) {
    console.error('[schedule] request pickup failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/swap-request — propose exchanging two shifts:
// myShiftId (mine) with theirShiftId (theirs).
router.post('/shifts/swap-request', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const { myShiftId, theirShiftId } = req.body ?? {};
    if (!myShiftId || !theirShiftId) {
      res.status(400).json({ error: 'Both shifts are required.' });
      return;
    }
    if (myShiftId === theirShiftId) {
      res.status(400).json({ error: 'You cannot swap a shift with itself.' });
      return;
    }
    const mine = await manualShift(companyId, String(myShiftId));
    const theirs = await manualShift(companyId, String(theirShiftId));
    if (!mine || !theirs) {
      res.status(404).json({ error: 'One of the shifts was not found.' });
      return;
    }
    if (mine.userId !== me) {
      res.status(403).json({ error: 'You can only swap your own shifts.' });
      return;
    }
    if (theirs.userId === me) {
      res.status(400).json({ error: 'You cannot swap a shift with yourself.' });
      return;
    }
    const { rows: existing } = await query(
      `SELECT id FROM shift_requests
       WHERE company_id = $1 AND status = 'pending'
         AND (shift_id = $2 OR shift_id = $3 OR their_shift_id = $2 OR their_shift_id = $3)
       LIMIT 1`,
      [companyId, myShiftId, theirShiftId]
    );
    if (existing.length) {
      res.status(409).json({ error: 'There is already a pending request on one of those shifts.' });
      return;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO shift_requests (id, company_id, request_type, shift_id, their_shift_id, requester_id, target_user_id, status)
       VALUES ($1, $2, 'swap', $3, $4, $5, $6, 'pending')`,
      [id, companyId, myShiftId, theirShiftId, me, theirs.userId]
    );
    res.status(201).json({
      id, requestType: 'swap', myShiftId, theirShiftId,
      targetUserId: theirs.userId, requesterId: me, status: 'pending',
      myShift: { date: mine.date, shiftTypeName: mine.shiftTypeName },
      theirShift: { date: theirs.date, shiftTypeName: theirs.shiftTypeName },
    });
    // Notify the swap target and the approvers.
    {
      const names = await shiftDisplayNames(companyId, me, mine.shiftTypeId);
      notify({
        companyId, userIds: [theirs.userId], category: 'schedule', type: 'request_to_you',
        title: `${names.personName} wants to swap shifts with you`,
        body: `${names.personName} offers ${mine.shiftTypeName} on ${fmtDateLong(mine.date)} for your ${theirs.shiftTypeName} on ${fmtDateLong(theirs.date)}.`,
        link: 'requests', bundleKey: 'request_to_you',
        bundleTitle: '{count} requests are waiting for you',
        excludeUserId: me,
      });
      notifyShiftRequestApprovers(companyId, { userId: mine.userId, shiftTypeId: mine.shiftTypeId }, me,
        'A shift request is waiting for a decision',
        `${names.personName} proposed a swap: ${mine.shiftTypeName} on ${fmtDateLong(mine.date)} ↔ ${theirs.shiftTypeName} on ${fmtDateLong(theirs.date)}.`);
    }
  } catch (err) {
    console.error('[schedule] swap request failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/shift-requests — pending requests relevant to me (I
// requested, I'm the target, or it's open to anyone), plus my decided
// requests from the last 30 days for history.
router.get('/shift-requests', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    // Owners/schedulers see every request in the company (they approve everything);
    // employees see requests involving them (their own, targeted at them, or open to anyone).
    const privileged = req.session.role === 'owner' || req.session.role === 'scheduler';
    const { rows } = await query(
      `SELECT r.id, r.request_type AS "requestType",
              r.shift_id AS "shiftId", r.their_shift_id AS "theirShiftId",
              r.requester_id AS "requesterId", r.target_user_id AS "targetUserId",
              r.status, r.created_at AS "createdAt", r.decided_at AS "decidedAt",
              s.date::text AS "shiftDate", st.name AS "shiftTypeName",
              ru.nickname AS "requesterNickname",
              ru.first_name AS "requesterFirstName", ru.last_name AS "requesterLastName",
              tu.nickname AS "targetNickname",
              tu.first_name AS "targetFirstName", tu.last_name AS "targetLastName",
              ts.date::text AS "theirShiftDate", tst.name AS "theirShiftTypeName"
       FROM shift_requests r
       JOIN shifts s ON s.id = r.shift_id
       JOIN shift_types st ON st.id = s.shift_type_id
       JOIN users ru ON ru.id = r.requester_id
       LEFT JOIN users tu ON tu.id = r.target_user_id
       LEFT JOIN shifts ts ON ts.id = r.their_shift_id
       LEFT JOIN shift_types tst ON tst.id = ts.shift_type_id
       WHERE r.company_id = $1
         AND ($2 OR r.requester_id = $3 OR r.target_user_id = $3 OR r.target_user_id IS NULL)
         AND (r.status = 'pending'
              OR (r.status <> 'pending' AND r.decided_at >= now() - interval '30 days'))
       ORDER BY r.created_at DESC`,
      [companyId, privileged, me]
    );
    const label = (r: any, prefix: string): string | null => {
      const nick = r[`${prefix}Nickname`];
      const name = `${r[`${prefix}FirstName`] || ''} ${r[`${prefix}LastName`] || ''}`.trim();
      return nick || name || null;
    };
    res.json({
      requests: rows.map((r: any) => ({
        id: r.id,
        requestType: r.requestType,
        shiftId: r.shiftId,
        theirShiftId: r.theirShiftId,
        requesterId: r.requesterId,
        requesterName: label(r, 'requester'),
        targetUserId: r.targetUserId,
        targetName: r.targetUserId ? label(r, 'target') : null,
        openToAnyone: r.targetUserId === null,
        status: r.status,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
        shift: { date: r.shiftDate, shiftTypeName: r.shiftTypeName },
        theirShift: r.theirShiftId
          ? { date: r.theirShiftDate, shiftTypeName: r.theirShiftTypeName }
          : null,
      })),
    });
  } catch (err) {
    console.error('[schedule] list shift requests failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shift-requests/:id/approve — accept a request.
// Allowed: the target, any active team member for open (target-less)
// requests, or scheduler/owner. Runs in one transaction: re-checks
// pending (SELECT ... FOR UPDATE), verifies the shifts still have the
// expected owners, applies the change, then cancels other pending requests
// touching the same shifts.
router.post('/shift-requests/:id/approve', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const id = req.params.id;

    const { rows } = await query(
      `SELECT id, request_type AS "requestType", shift_id AS "shiftId",
              their_shift_id AS "theirShiftId", requester_id AS "requesterId",
              target_user_id AS "targetUserId", status
       FROM shift_requests WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Request not found.' });
      return;
    }
    const r = rows[0];
    if (r.status !== 'pending') {
      res.status(409).json({ error: 'This request has already been decided.' });
      return;
    }
    const isPrivileged = role === 'owner' || role === 'scheduler';
    if (!isPrivileged && r.targetUserId !== me && r.targetUserId !== null) {
      res.status(403).json({ error: 'You are not allowed to approve this request.' });
      return;
    }
    if (r.targetUserId === null && !(await activeMember(companyId, me))) {
      res.status(403).json({ error: 'Your account is not active.' });
      return;
    }
    if (r.requestType === 'open_pickup' && !isPrivileged) {
      res.status(403).json({ error: 'Only a scheduler or owner can approve open-shift pickups.' });
      return;
    }
    if ((r.requestType === 'pickup' || r.requestType === 'open_pickup') && r.requesterId === me) {
      res.status(400).json({ error: 'You cannot approve your own request — ask a scheduler instead.' });
      return;
    }

    try {
      await withTransaction(async (tx) => {
        const { rows: locked } = await tx.query(
          `SELECT request_type AS "requestType", shift_id AS "shiftId",
                  their_shift_id AS "theirShiftId", requester_id AS "requesterId",
                  target_user_id AS "targetUserId", status
           FROM shift_requests WHERE id = $1 FOR UPDATE`,
          [id]
        );
        if (!locked.length || locked[0].status !== 'pending') {
          throw new RequestError(409, 'This request was just decided by someone else.');
        }
        const lr = locked[0];
        if (lr.requestType === 'open_pickup') {
          const { rows: srows } = await tx.query(
            'SELECT id, user_id AS "userId", published FROM shifts WHERE id = $1 FOR UPDATE',
            [lr.shiftId]
          );
          if (!srows.length) throw new RequestError(409, 'The shift no longer exists.');
          if (srows[0].userId !== lr.requesterId) {
            throw new RequestError(409, 'The shift changed hands since the request was made.');
          }
          await tx.query('UPDATE shifts SET published = true WHERE id = $1', [lr.shiftId]);
        } else if (lr.requestType === 'pickup') {
          const { rows: srows } = await tx.query(
            'SELECT id, user_id AS "userId" FROM shifts WHERE id = $1 FOR UPDATE',
            [lr.shiftId]
          );
          if (!srows.length) throw new RequestError(409, 'The shift no longer exists.');
          if (srows[0].userId !== lr.requesterId) {
            throw new RequestError(409, 'The shift changed hands since the request was made.');
          }
          if (srows[0].userId === me) {
            throw new RequestError(400, 'That shift is already yours.');
          }
          await tx.query('UPDATE shifts SET user_id = $1 WHERE id = $2', [me, lr.shiftId]);
        } else {
          // Swap: lock both rows in a stable order to avoid deadlocks.
          const ids = [lr.shiftId, lr.theirShiftId].sort();
          const found = new Map<string, any>();
          for (const sid of ids) {
            const { rows: srows } = await tx.query(
              'SELECT id, user_id AS "userId" FROM shifts WHERE id = $1 FOR UPDATE',
              [sid]
            );
            if (srows.length) found.set(sid, srows[0]);
          }
          const a = found.get(lr.shiftId);
          const b = found.get(lr.theirShiftId);
          if (!a || !b) throw new RequestError(409, 'One of the shifts no longer exists.');
          if (a.userId !== lr.requesterId || b.userId !== lr.targetUserId) {
            throw new RequestError(409, 'One of the shifts changed hands since the request was made.');
          }
          await tx.query('UPDATE shifts SET user_id = $1 WHERE id = $2', [b.userId, lr.shiftId]);
          await tx.query('UPDATE shifts SET user_id = $1 WHERE id = $2', [a.userId, lr.theirShiftId]);
        }
        await tx.query(
          "UPDATE shift_requests SET status = 'approved', decided_at = now() WHERE id = $1",
          [id]
        );
        // Stale out any other pending requests touching the same shift(s).
        const shiftIds = lr.requestType === 'swap' ? [lr.shiftId, lr.theirShiftId] : [lr.shiftId];
        await tx.query(
          `UPDATE shift_requests SET status = 'cancelled', decided_at = now()
           WHERE id <> $1 AND status = 'pending'
             AND (shift_id = ANY($2) OR their_shift_id = ANY($2))`,
          [id, shiftIds]
        );
      });
    } catch (err: any) {
      if (err instanceof RequestError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      if (err?.code === '23505') {
        res.status(409).json({ error: 'That would give you a duplicate shift — you already have that shift type on that date.' });
        return;
      }
      throw err;
    }
    res.json({ ok: true, status: 'approved' });

    // Audit: who took over whose shift.
    try {
      const { rows: arows } = await query(
        'SELECT date::text AS date, shift_type_id AS "shiftTypeId" FROM shifts WHERE id = $1',
        [r.shiftId]
      );
      if (arows.length) {
        const names = await shiftDisplayNames(companyId, me, arows[0].shiftTypeId);
        await auditLog({
          companyId, date: arows[0].date, action: 'updated',
          personName: names.personName, shiftTypeName: names.shiftTypeName,
          source: 'manual', changedBy: me,
          details: { via: 'shift-request-approved', requestId: id, requestType: r.requestType },
        });
      }
    } catch { /* audit must never break the response */ }
    // Notify the requester that their request was approved.
    {
      const shift = await manualShift(companyId, r.shiftId);
      const typeWord = r.requestType === 'swap' ? 'swap' : 'pickup';
      notify({
        companyId, userIds: [r.requesterId], category: 'schedule', type: 'request_decided',
        title: `Your ${typeWord} request was approved`,
        body: shift
          ? `Your ${typeWord} request for ${shift.shiftTypeName} on ${fmtDateLong(shift.date)} was approved.`
          : `Your ${typeWord} request was approved.`,
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });
    }
  } catch (err) {
    console.error('[schedule] approve shift request failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shift-requests/:id/decline — requester, target, scheduler, or owner.
router.post('/shift-requests/:id/decline', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const id = req.params.id;

    const { rows } = await query(
      `SELECT id, requester_id AS "requesterId", target_user_id AS "targetUserId", status
       FROM shift_requests WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Request not found.' });
      return;
    }
    const r = rows[0];
    const isPrivileged = role === 'owner' || role === 'scheduler';
    if (!isPrivileged && r.requesterId !== me && r.targetUserId !== me) {
      res.status(403).json({ error: 'You are not allowed to decline this request.' });
      return;
    }
    const { rows: dr } = await query(
      `SELECT request_type AS "requestType", shift_id AS "shiftId"
       FROM shift_requests WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    const { rowCount } = await query(
      "UPDATE shift_requests SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'",
      [id]
    );
    if (!rowCount) {
      res.status(409).json({ error: 'This request has already been decided.' });
      return;
    }
    if (dr.length && dr[0].requestType === 'open_pickup') {
      // Release the held slot: delete the unpublished shift.
      await query('DELETE FROM shifts WHERE id = $1 AND published = false', [dr[0].shiftId]);
    }
    res.json({ ok: true, status: 'declined' });
    // Notify the requester that their request was declined.
    if (dr.length) {
      const shift = await manualShift(companyId, dr[0].shiftId);
      const typeWord = dr[0].requestType === 'swap' ? 'swap' : 'pickup';
      notify({
        companyId, userIds: [r.requesterId], category: 'schedule', type: 'request_decided',
        title: `Your ${typeWord} request was declined`,
        body: shift
          ? `Your ${typeWord} request for ${shift.shiftTypeName} on ${fmtDateLong(shift.date)} was declined.`
          : `Your ${typeWord} request was declined.`,
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });
    }
  } catch (err) {
    console.error('[schedule] decline shift request failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shift-requests/:id/cancel — requester or scheduler/owner.
router.post('/shift-requests/:id/cancel', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const id = req.params.id;

    const { rows } = await query(
      `SELECT id, requester_id AS "requesterId", status
       FROM shift_requests WHERE id = $1 AND company_id = $2`,
      [id, companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Request not found.' });
      return;
    }
    const r = rows[0];
    const isPrivileged = role === 'owner' || role === 'scheduler';
    if (!isPrivileged && r.requesterId !== me) {
      res.status(403).json({ error: 'You can only cancel your own requests.' });
      return;
    }
    const { rowCount } = await query(
      "UPDATE shift_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND status = 'pending'",
      [id]
    );
    if (!rowCount) {
      res.status(409).json({ error: 'This request has already been decided.' });
      return;
    }
    res.json({ ok: true, status: 'cancelled' });
  } catch (err) {
    console.error('[schedule] cancel shift request failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Rooms / locations ----------
// Rooms are company locations for dashboard sessions. A room can link an
// external calendar feed (ICS — Outlook/Google room calendars can publish
// one) so the session form can warn when the room is already booked.
function roomRow(r: any) {
  return { id: r.id, name: r.name, hasFeed: !!r.ics_url, icsUrl: r.ics_url || null, createdAt: r.created_at };
}

router.get('/rooms', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const { rows } = await query('SELECT * FROM rooms WHERE company_id = $1 ORDER BY name', [req.session.companyId!]);
    res.json({ rooms: rows.map(roomRow) });
  } catch (err) {
    console.error('[schedule] list rooms failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/rooms', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const name = b.name ? String(b.name).trim() : '';
    if (!name) { res.status(400).json({ error: 'A room name is required.' }); return; }
    const icsUrl = b.icsUrl ? String(b.icsUrl).trim() : null;
    if (icsUrl && !/^https?:\/\//i.test(icsUrl)) { res.status(400).json({ error: 'The calendar link must start with http:// or https://' }); return; }
    const companyId = req.session.companyId!;
    const { rows: dupe } = await query('SELECT id FROM rooms WHERE company_id = $1 AND lower(name) = lower($2)', [companyId, name]);
    if (dupe.length) { res.status(400).json({ error: 'A room with that name already exists.' }); return; }
    const id = crypto.randomUUID();
    await query('INSERT INTO rooms (id, company_id, name, ics_url, created_by) VALUES ($1,$2,$3,$4,$5)',
      [id, companyId, name, icsUrl, req.session.userId!]);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[schedule] create room failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.put('/rooms/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const companyId = req.session.companyId!;
    const { rows } = await query('SELECT * FROM rooms WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Room not found.' }); return; }
    const name = b.name !== undefined ? String(b.name).trim() : rows[0].name;
    if (!name) { res.status(400).json({ error: 'A room name is required.' }); return; }
    const icsUrl = b.icsUrl !== undefined ? (b.icsUrl ? String(b.icsUrl).trim() : null) : rows[0].ics_url;
    if (icsUrl && !/^https?:\/\//i.test(icsUrl)) { res.status(400).json({ error: 'The calendar link must start with http:// or https://' }); return; }
    await query('UPDATE rooms SET name = $1, ics_url = $2 WHERE id = $3', [name, icsUrl, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update room failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/rooms/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    await query('DELETE FROM rooms WHERE id = $1 AND company_id = $2', [req.params.id, req.session.companyId!]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete room failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// --- ICS feed parsing (small, purpose-built) ---
type IcsEvent = { start: Date; end: Date; summary: string; rrule: string | null; allDay: boolean };
const icsCache = new Map<string, { at: number; events: IcsEvent[] }>();

function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parts = dtf.formatToParts(new Date(guess));
    const get = (t: string) => +(parts.find((p) => p.type === t)!.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return new Date(guess - (asUtc - guess));
  } catch { return new Date(guess); }
}

function parseIcsDate(val: string, tzid: string | null): Date | null {
  const m = val.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (m[4] === undefined) return new Date(Date.UTC(y, mo - 1, d));
  const h = +m[4], mi = +m[5], s = +(m[6] || 0);
  if (m[7]) return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (tzid) return zonedToUtc(y, mo, d, h, mi, s, tzid);
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

function parseIcs(text: string): IcsEvent[] {
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const events: IcsEvent[] = [];
  let cur: any = null;
  for (const line of unfolded.split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') {
      if (cur && cur.start && cur.end) events.push({ start: cur.start, end: cur.end, summary: cur.summary || 'Busy', rrule: cur.rrule || null, allDay: !!cur.allDay });
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const head = line.slice(0, idx);
      const key = head.split(';')[0];
      const val = line.slice(idx + 1);
      const tzM = /TZID=([^;:]+)/.exec(head);
      if (key === 'DTSTART') { cur.start = parseIcsDate(val, tzM ? tzM[1] : null); cur.allDay = !val.includes('T'); }
      else if (key === 'DTEND') cur.end = parseIcsDate(val, tzM ? tzM[1] : null);
      else if (key === 'SUMMARY') cur.summary = val.replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
      else if (key === 'RRULE') cur.rrule = val.trim();
    }
  }
  return events;
}

async function fetchIcsEvents(url: string): Promise<IcsEvent[]> {
  const hit = icsCache.get(url);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.events;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'QuickScheduling/1.0' } });
    if (!resp.ok) throw new Error('feed returned ' + resp.status);
    const events = parseIcs(await resp.text());
    icsCache.set(url, { at: Date.now(), events });
    return events;
  } finally { clearTimeout(timer); }
}

// Busy blocks of one ICS event on one UTC day (recurrence expanded simply).
function icsBlocksOn(ev: IcsEvent, dayStart: Date, dayEnd: Date): Array<{ start: Date; end: Date }> {
  const dur = ev.end.getTime() - ev.start.getTime();
  if (!ev.rrule) {
    return ev.start < dayEnd && ev.end > dayStart ? [{ start: ev.start, end: ev.end }] : [];
  }
  const parts: Record<string, string> = {};
  for (const kv of ev.rrule.split(';')) { const [k, v] = kv.split('='); if (k && v) parts[k] = v; }
  const freq = parts.FREQ || '';
  const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1);
  const countMax = parts.COUNT ? parseInt(parts.COUNT, 10) : Infinity;
  const until = parts.UNTIL ? parseIcsDate(parts.UNTIL, null) : null;
  const byday = parts.BYDAY ? parts.BYDAY.split(',').map((x) => x.replace(/[^A-Z]/g, '')) : null;
  const dayNames = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const out: Array<{ start: Date; end: Date }> = [];
  let count = 0;
  const cur = new Date(ev.start);
  for (let step = 0; step < 4000; step++) {
    if (cur >= dayEnd) break;
    if (until && cur > until) break;
    let isOcc = false;
    const daysDiff = Math.round((Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate()) - Date.UTC(ev.start.getUTCFullYear(), ev.start.getUTCMonth(), ev.start.getUTCDate())) / 86400000);
    if (freq === 'DAILY') isOcc = daysDiff % interval === 0;
    else if (freq === 'WEEKLY') isOcc = Math.floor(daysDiff / 7) % interval === 0 && (byday ? byday.includes(dayNames[cur.getUTCDay()]) : cur.getUTCDay() === ev.start.getUTCDay());
    else if (freq === 'MONTHLY') {
      const monthsDiff = (cur.getUTCFullYear() - ev.start.getUTCFullYear()) * 12 + (cur.getUTCMonth() - ev.start.getUTCMonth());
      const dim = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
      isOcc = monthsDiff % interval === 0 && cur.getUTCDate() === Math.min(ev.start.getUTCDate(), dim);
    } else if (freq === 'YEARLY') {
      const yearsDiff = cur.getUTCFullYear() - ev.start.getUTCFullYear();
      const dim = new Date(Date.UTC(cur.getUTCFullYear(), ev.start.getUTCMonth() + 1, 0)).getUTCDate();
      isOcc = yearsDiff % interval === 0 && cur.getUTCMonth() === ev.start.getUTCMonth() && cur.getUTCDate() === Math.min(ev.start.getUTCDate(), dim);
    }
    if (isOcc) {
      count++;
      if (count > countMax) break;
      const occEnd = new Date(cur.getTime() + dur);
      if (cur < dayEnd && occEnd > dayStart) out.push({ start: new Date(cur), end: occEnd });
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// Does one of our sessions (possibly a rotation) land on dateStr?
function sessionOccursOn(base: any, dateStr: string): boolean {
  if (base.date === dateStr) return true;
  const rule = base.recurRule;
  if (!rule || rule === 'none' || dateStr < base.date) return false;
  if (base.recurUntil && dateStr > base.recurUntil) return false;
  const interval = Math.max(1, base.recurInterval || 1);
  const maxCount = base.recurCount || Infinity;
  const start = new Date(base.date + 'T00:00:00Z');
  const target = new Date(dateStr + 'T00:00:00Z');
  const days: number[] = base.recurDays && base.recurDays.length ? base.recurDays : [start.getUTCDay()];
  const week0 = new Date(start); week0.setUTCDate(week0.getUTCDate() - week0.getUTCDay());
  let count = 0;
  const cur = new Date(start);
  for (let step = 0; step < 4000 && cur <= target; step++) {
    const daysDiff = Math.round((cur.getTime() - start.getTime()) / 86400000);
    let isOcc = false;
    if (rule === 'daily') isOcc = daysDiff % interval === 0;
    else if (rule === 'weekly') isOcc = days.includes(cur.getUTCDay()) && Math.floor((cur.getTime() - week0.getTime()) / (7 * 86400000)) % interval === 0;
    else if (rule === 'monthly') {
      const monthsDiff = (cur.getUTCFullYear() - start.getUTCFullYear()) * 12 + (cur.getUTCMonth() - start.getUTCMonth());
      const dim = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
      isOcc = daysDiff === 0 || (monthsDiff % interval === 0 && monthsDiff > 0 && cur.getUTCDate() === Math.min(start.getUTCDate(), dim));
    } else if (rule === 'monthly-weekday') {
      const monthsDiff = (cur.getUTCFullYear() - start.getUTCFullYear()) * 12 + (cur.getUTCMonth() - start.getUTCMonth());
      const wd = start.getUTCDay();
      const nth = Math.floor((start.getUTCDate() - 1) / 7) + 1;
      const dimStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
      const isLast = start.getUTCDate() + 7 > dimStart;
      let want = 0;
      if (cur.getUTCDay() === wd) {
        const dim = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
        if (isLast) want = dim - ((new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), dim)).getUTCDay() - wd + 7) % 7);
        else { const firstOcc = 1 + ((wd - new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), 1)).getUTCDay() + 7) % 7); want = firstOcc + (nth - 1) * 7; }
      }
      isOcc = daysDiff === 0 || (monthsDiff % interval === 0 && monthsDiff > 0 && want !== 0 && cur.getUTCDate() === want);
    } else if (rule === 'yearly') {
      const yearsDiff = cur.getUTCFullYear() - start.getUTCFullYear();
      const dim = new Date(Date.UTC(cur.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
      isOcc = daysDiff === 0 || (yearsDiff % interval === 0 && yearsDiff > 0 && cur.getUTCMonth() === start.getUTCMonth() && cur.getUTCDate() === Math.min(start.getUTCDate(), dim));
    }
    if (isOcc) {
      count++;
      if (count > maxCount) return false;
      if (cur.getTime() === target.getTime()) return true;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return false;
}

router.get('/room-availability', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const roomId = String(req.query.roomId || '');
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' }); return; }
    const { rows } = await query('SELECT * FROM rooms WHERE id = $1 AND company_id = $2', [roomId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Room not found.' }); return; }
    const room = rows[0];
    const busy: any[] = [];
    let feedError: string | null = null;
    if (room.ics_url) {
      try {
        const events = await fetchIcsEvents(room.ics_url);
        const dayStart = new Date(date + 'T00:00:00Z');
        const dayEnd = new Date(dayStart.getTime() + 86400000);
        for (const ev of events) {
          for (const b of icsBlocksOn(ev, dayStart, dayEnd)) {
            busy.push({ start: b.start.toISOString(), end: b.end.toISOString(), title: ev.summary, source: 'calendar', allDay: ev.allDay });
          }
        }
      } catch (e) {
        feedError = 'Could not read the room calendar link.';
      }
    }
    // Our own sessions booked into this room that day.
    const { rows: sessRows } = await query(
      `SELECT * FROM academic_sessions WHERE company_id = $1 AND lower(location) = lower($2) AND session_date <= $3`,
      [companyId, room.name, date]);
    for (const r of sessRows) {
      const base = academicRow(r);
      if (sessionOccursOn(base, date)) {
        busy.push({ start: null, end: null, startTime: base.startTime, endTime: base.endTime, title: base.title, source: 'session', allDay: false, sessionId: base.id });
      }
    }
    busy.sort((a: any, b: any) => String(a.start || a.startTime || '').localeCompare(String(b.start || b.startTime || '')));
    res.json({ room: { id: room.id, name: room.name, hasFeed: !!room.ics_url }, feedError, busy });
  } catch (err) {
    console.error('[schedule] room-availability failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Custom dashboards ----------
// Option 1: named calendar dashboards created in Settings. Each dashboard gets
// a nav tab with a Day/Week/Month calendar of sessions.

async function dashboardDeptIds(dashboardId: string): Promise<string[]> {
  const { rows } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [dashboardId]);
  return rows.map((r: any) => r.department_id);
}

async function dashboardEditorIds(dashboardId: string): Promise<string[]> {
  const { rows } = await query('SELECT user_id FROM dashboard_editors WHERE dashboard_id = $1', [dashboardId]);
  return rows.map((r: any) => r.user_id);
}

// Can this user adjust a dashboard's sessions/kinds at all? Owner:
// always. Scheduler: when the dashboard has an editors list, only its
// members; otherwise, Edit access touching the dashboard (any Edit
// department when the dashboard is unrestricted). Employees: never.
async function dashboardEditAllowed(req: Request, dashboardId: string): Promise<boolean> {
  if (req.session.role === 'owner') return true;
  if (req.session.role !== 'scheduler') return false;
  const editors = await dashboardEditorIds(dashboardId);
  if (editors.length) return editors.includes(req.session.userId!);
  const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
  const editDepts = access.edit || [];
  if (!editDepts.length) return false;
  const dIds = await dashboardDeptIds(dashboardId);
  if (!dIds.length) return true;
  return dIds.some((d) => editDepts.includes(d));
}

// Gate for saving a session: an editors list (when set) replaces the
// department-edit check for that dashboard's sessions.
async function sessionEditCheck(req: Request, res: Response, dashboardId: string | null, departmentId: string | null): Promise<boolean> {
  if (req.session.role === 'owner') return true;
  if (dashboardId) {
    const editors = await dashboardEditorIds(dashboardId);
    if (editors.length) {
      if (editors.includes(req.session.userId!)) return true;
      res.status(403).json({ error: 'Only the editors chosen for this dashboard can change its sessions.' });
      return false;
    }
  }
  return academicDeptCheck(req, res, departmentId);
}

// Quiet version of sessionEditCheck for loops (no response writes):
// owner yes; editors list (when set) decides; otherwise the
// scheduler needs Edit access to the session's department.
async function canEditSessionQuiet(req: Request, dashboardId: string | null, departmentId: string | null): Promise<boolean> {
  const role = req.session.role!;
  if (role === 'owner') return true;
  if (role !== 'scheduler') return false;
  if (dashboardId) {
    const editors = await dashboardEditorIds(dashboardId);
    if (editors.length) return editors.includes(req.session.userId!);
  }
  if (!departmentId) return false;
  const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
  return (access.edit || []).includes(departmentId);
}

async function validateDashboardEditors(companyId: string, ids: any): Promise<string[] | null> {
  if (!ids || !Array.isArray(ids) || ids.length === 0) return [];
  const want = ids.map((x: any) => String(x));
  const { rows } = await query('SELECT id FROM users WHERE company_id = $1 AND id = ANY($2) AND is_active = true', [companyId, want]);
  if (rows.length !== want.length) return null;
  return rows.map((r: any) => r.id);
}

async function visibleDashboardIds(req: Request): Promise<string[] | null> {
  const companyId = req.session.companyId!;
  const deptIds = await academicVisibleDeptIds(req);
  if (deptIds === null) return null; // owner sees everything
  // No early return for an empty deptIds: a dashboard with NO department
  // restriction is visible to everyone (the loop's first condition) —
  // a team member without a department (or a scheduler with no view
  // access yet) still gets those dashboards. (Bug found 2026-10-20:
  // returning [] here hid every dashboard from dept-less employees.)
  const { rows } = await query('SELECT id FROM dashboards WHERE company_id = $1', [companyId]);
  const out: string[] = [];
  for (const r of rows) {
    const dIds = await dashboardDeptIds(r.id);
    if (dIds.length === 0 || dIds.some((d) => deptIds.includes(d))) out.push(r.id);
  }
  return out;
}

// GET /api/schedule/dashboards — all roles, scoped like sessions.
router.get('/dashboards', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const visible = await visibleDashboardIds(req);
    const params: any[] = [companyId];
    let clause = 'WHERE d.company_id = $1';
    if (visible) {
      params.push(visible);
      clause += ' AND d.id = ANY($2)';
    }
    const { rows } = await query(
      `SELECT d.id, d.name, d.created_at,
              (SELECT array_agg(dd.department_id) FROM dashboard_departments dd WHERE dd.dashboard_id = d.id) AS department_ids
       FROM dashboards d ${clause} ORDER BY d.created_at`, params);
    const out: any[] = [];
    for (const r of rows) {
      out.push({
        id: r.id, name: r.name, createdAt: r.created_at,
        departmentIds: r.department_ids || [],
        editorIds: await dashboardEditorIds(r.id),
        canEdit: await dashboardEditAllowed(req, r.id),
      });
    }
    res.json({ dashboards: out });
  } catch (err) {
    console.error('[schedule] dashboards list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function validateDashboardDepts(companyId: string, ids: any): Promise<string[] | null> {
  if (!ids || ids.length === 0) return [];
  const { rows } = await query('SELECT id FROM departments WHERE company_id = $1 AND id = ANY($2)', [companyId, ids]);
  if (rows.length !== ids.length) return null;
  return rows.map((r: any) => r.id);
}

// POST /api/schedule/dashboards — owner only.
router.post('/dashboards', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const name = String(req.body?.name || '').trim();
    if (!name) { res.status(400).json({ error: 'Give the dashboard a name.' }); return; }
    const deptIds = await validateDashboardDepts(companyId, req.body?.departmentIds);
    if (!deptIds) { res.status(400).json({ error: 'One or more departments are invalid.' }); return; }
    const editorIds = await validateDashboardEditors(companyId, req.body?.editorIds);
    if (!editorIds) { res.status(400).json({ error: 'One or more editors are invalid.' }); return; }
    const { rows } = await query(
      'INSERT INTO dashboards (company_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, created_at',
      [companyId, name, req.session.userId]);
    for (const d of deptIds) {
      await query('INSERT INTO dashboard_departments (dashboard_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0].id, d]);
    }
    for (const u of editorIds) {
      await query('INSERT INTO dashboard_editors (dashboard_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0].id, u]);
    }
    res.status(201).json({ dashboard: { id: rows[0].id, name: rows[0].name, departmentIds: deptIds, editorIds } });
  } catch (err) {
    console.error('[schedule] dashboard create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/dashboards/:id — owner only (rename / re-scope departments).
router.put('/dashboards/:id', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
    if (name !== undefined && !name) { res.status(400).json({ error: 'Give the dashboard a name.' }); return; }
    let deptIds: string[] | null = null;
    if (req.body?.departmentIds !== undefined) {
      deptIds = await validateDashboardDepts(companyId, req.body.departmentIds);
      if (!deptIds) { res.status(400).json({ error: 'One or more departments are invalid.' }); return; }
    }
    let editorIds: string[] | null = null;
    if (req.body?.editorIds !== undefined) {
      editorIds = await validateDashboardEditors(companyId, req.body.editorIds);
      if (!editorIds) { res.status(400).json({ error: 'One or more editors are invalid.' }); return; }
    }
    const { rows } = await query('SELECT id FROM dashboards WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Dashboard not found.' }); return; }
    if (name !== undefined) await query('UPDATE dashboards SET name = $1 WHERE id = $2', [name, req.params.id]);
    if (deptIds !== null) {
      await query('DELETE FROM dashboard_departments WHERE dashboard_id = $1', [req.params.id]);
      for (const d of deptIds) {
        await query('INSERT INTO dashboard_departments (dashboard_id, department_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, d]);
      }
    }
    if (editorIds !== null) {
      await query('DELETE FROM dashboard_editors WHERE dashboard_id = $1', [req.params.id]);
      for (const u of editorIds) {
        await query('INSERT INTO dashboard_editors (dashboard_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, u]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] dashboard update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/dashboards/:id — owner only. Sessions keep their rows (dashboard_id set null).
router.delete('/dashboards/:id', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query('DELETE FROM dashboards WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!rowCount) { res.status(404).json({ error: 'Dashboard not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] dashboard delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/working-on?date=YYYY-MM-DD&departmentId=&shiftTypeId=
// Team members actually working that day — mirrors GET /shifts: stored shifts
// PLUS rotation-generated shifts (minus pauses, exclusions, ended members),
// because most staff appear on the schedule through rotations, not stored
// rows. Owner/scheduler only. departmentId only ranks (inDepartment flag).
router.get('/working-on', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' }); return; }
    const wantDept = req.query.departmentId ? String(req.query.departmentId) : null;
    const wantShift = req.query.shiftTypeId ? String(req.query.shiftTypeId) : null;
    let viewDepts: string[] | null = null;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      viewDepts = access.view || [];
    }

    const byUser = new Map<string, any>();
    const addShift = function (u: any, shiftTypeId: string, shiftName: string, departmentId: string | null, departmentName: string | null) {
      if (!byUser.has(u.user_id)) {
        byUser.set(u.user_id, {
          userId: u.user_id,
          name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name,
          jobRole: u.job_role || null,
          inDepartment: false,
          shifts: [],
        });
      }
      const cand = byUser.get(u.user_id);
      if (!cand.shifts.some((x: any) => x.shiftTypeId === shiftTypeId)) {
        cand.shifts.push({ shiftTypeId, shiftName, departmentId, departmentName });
      }
    };

    // 1) Stored shifts for the day.
    const { rows: manualRows } = await query(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.name, jr.name AS job_role,
              st.id AS shift_type_id, st.name AS shift_name, st.department_id, d.name AS department_name
       FROM shifts sh
       JOIN users u ON u.id = sh.user_id
       JOIN shift_types st ON st.id = sh.shift_type_id
       LEFT JOIN departments d ON d.id = st.department_id
       LEFT JOIN job_roles jr ON jr.id = u.job_role_id
       WHERE sh.company_id = $1 AND sh.date = $2 AND u.is_active IS NOT FALSE
       ORDER BY st.name, u.last_name, u.first_name`, [companyId, date]);
    const manualKeys = new Set(manualRows.map((r: any) => r.user_id + '|' + r.shift_type_id));

    // 2) Rotation-generated shifts for the day (same rules as GET /shifts).
    const { rows: pauseRows } = await query(
      `SELECT rotation_id, start_date::text AS start_date, end_date::text AS end_date
       FROM rotation_pauses WHERE company_id = $1 AND end_date >= $2 AND start_date <= $2`, [companyId, date]);
    const pausedRotIds = new Set(pauseRows.filter((p: any) => date >= p.start_date && date <= p.end_date).map((p: any) => p.rotation_id));
    const { rows: exclRows } = await query(
      `SELECT rotation_id, user_id, shift_type_id FROM rotation_shift_exclusions
       WHERE company_id = $1 AND date = $2`, [companyId, date]);
    const exclSet = new Set(exclRows.map((e: any) => e.rotation_id + '|' + e.user_id + '|' + e.shift_type_id));
    const { rows: rotations } = await query(
      `SELECT id, cycle_days, start_date::text AS start_date FROM rotations
       WHERE company_id = $1 AND is_active = true`, [companyId]);
    const userPaused = new Set<string>();
    const target = new Date(date + 'T00:00:00');
    for (const rot of rotations) {
      const { rows: assigns } = await query(
        `SELECT ra.user_id, ra.cycle_day, ra.shift_type_id, u.first_name, u.last_name, u.name,
                u.end_date, jr.name AS job_role, st.name AS shift_name, st.department_id, d.name AS department_name
         FROM rotation_assignments ra
         JOIN users u ON u.id = ra.user_id AND u.is_active = true
         JOIN shift_types st ON st.id = ra.shift_type_id
         LEFT JOIN departments d ON d.id = st.department_id
         LEFT JOIN job_roles jr ON jr.id = u.job_role_id
         WHERE ra.rotation_id = $1`, [rot.id]);
      if (!assigns.length) continue;
      const paused = pausedRotIds.has(rot.id);
      if (paused) { for (const a of assigns) userPaused.add(a.user_id); continue; }
      const startDate = new Date(rot.start_date + 'T00:00:00');
      if (target < startDate) continue;
      const daysSince = Math.floor((target.getTime() - startDate.getTime()) / 86400000);
      const cycleDay = (daysSince % rot.cycle_days) + 1;
      for (const a of assigns) {
        if (a.cycle_day !== cycleDay) continue;
        if (a.end_date && date > String(a.end_date).slice(0, 10)) continue;
        if (exclSet.has(rot.id + '|' + a.user_id + '|' + a.shift_type_id)) continue;
        if (manualKeys.has(a.user_id + '|' + a.shift_type_id)) continue; // manual takes precedence
        addShift(a, a.shift_type_id, a.shift_name, a.department_id, a.department_name);
      }
    }
    // Manual shifts last, skipping members paused that day (mirrors main view).
    for (const r of manualRows) {
      if (userPaused.has(r.user_id)) continue;
      addShift(r, r.shift_type_id, r.shift_name, r.department_id, r.department_name);
    }

    // 3) Filters + department ranking.
    let candidates = Array.from(byUser.values());
    if (wantShift) {
      candidates = candidates.map((c: any) => ({ ...c, shifts: c.shifts.filter((x: any) => x.shiftTypeId === wantShift) })).filter((c: any) => c.shifts.length);
    }
    if (viewDepts) {
      candidates = candidates.map((c: any) => ({ ...c, shifts: c.shifts.filter((x: any) => x.departmentId && viewDepts!.includes(x.departmentId)) })).filter((c: any) => c.shifts.length);
    }
    for (const c of candidates) c.inDepartment = !wantDept || c.shifts.some((x: any) => x.departmentId === wantDept);
    if (wantDept) candidates.sort(function (a: any, b: any) { return (b.inDepartment ? 1 : 0) - (a.inDepartment ? 1 : 0) || String(a.name).localeCompare(String(b.name)); });
    res.json({ candidates });
  } catch (err) {
    console.error('[schedule] working-on failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Academic dashboard ----------
// Lecturers are team members from the same roster database (users table) — no
// duplicate people entry; the Academic tab reads lecturers straight from Team.
function cleanRecur(v: any): { rule: string; interval: number; count: number | null } {
  let rule = ['daily', 'weekly', 'monthly', 'monthly-weekday', 'yearly'].includes(v && v.recurRule) ? v.recurRule
    : (v && v.recurRule === 'biweekly' ? 'weekly' : 'none');
  let interval = parseInt(String(v && v.recurInterval), 10);
  if (isNaN(interval) || interval < 1) interval = v && v.recurRule === 'biweekly' ? 2 : 1;
  if (interval > 52) interval = 52;
  let count = parseInt(String(v && v.recurCount), 10);
  if (isNaN(count) || count < 1) count = 0;
  if (count > 500) count = 500;
  if (rule === 'none') { interval = 1; count = 0; }
  return { rule, interval, count: count > 0 ? count : null };
}

function cleanRecurDays(v: any): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = parseInt(String(x), 10);
    if (!isNaN(n) && n >= 0 && n <= 6 && !out.includes(n)) out.push(n);
  }
  return out.sort();
}

function academicRow(r: any) {
  return {
    id: r.id,
    title: r.title,
    lecturerUserId: r.lecturer_user_id,
    lecturerName: [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.lecturer_user_id ? '—' : null),
    lecturerActive: r.lecturer_active !== false,
    supervisorUserId: r.supervisor_user_id || null,
    supervisorName: [r.sup_first_name, r.sup_last_name].filter(Boolean).join(' ') || null,
    departmentId: r.department_id,
    departmentName: r.department_name || null,
    date: r.session_date instanceof Date ? r.session_date.toISOString().slice(0, 10) : r.session_date,
    startTime: r.start_time,
    endTime: r.end_time,
    location: r.location,
    kind: r.kind,
    meetingUrl: r.meeting_url || null,
    notes: r.notes,
    dashboardId: r.dashboard_id || null,
    recurRule: r.recur_rule === 'biweekly' ? 'weekly' : (r.recur_rule || 'none'),
    recurInterval: r.recur_rule === 'biweekly' ? 2 : (r.recur_interval || 1),
    recurCount: r.recur_count || null,
    recurDays: r.recur_days ? String(r.recur_days).split(',').map(function (x: string) { return parseInt(x, 10); }).filter(function (n: number) { return !isNaN(n); }) : [],
    recurUntil: r.recur_until instanceof Date ? r.recur_until.toISOString().slice(0, 10) : (r.recur_until || null),
    seriesId: r.series_id || null,
    isOccurrence: !!r.is_occurrence,
    createdAt: r.created_at,
  };
}

async function academicVisibleDeptIds(req: Request): Promise<string[] | null> {
  const companyId = req.session.companyId!;
  const role = req.session.role!;
  if (role === 'owner') return null; // null = all
  const access = await getDepartmentAccess(req.session.userId!, companyId);
  const ids = access.view || [];
  if (role === 'scheduler') return ids;
  const { rows } = await query('SELECT department_id FROM users WHERE id = $1 AND company_id = $2',
    [req.session.userId!, companyId]);
  return rows[0] && rows[0].department_id ? [rows[0].department_id] : [];
}

// --- Session kinds (Deepika, 2026-10-20): each company keeps its own
// list — Lecture and Event built in, owners add more (e.g. Interviews).
const DEFAULT_KINDS = [
  { key: 'session', label: 'Lecture', color: '#00796b', position: 0 },
  { key: 'event', label: 'Event', color: '#7c3aed', position: 1 },
];

// ---------- Per-date overrides for recurring sessions ----------
// A series keeps the defaults; an override row individualizes one
// date (own presenter / supervisor / room / link / times, or a
// cancelled date). has_* flags separate "set (maybe to null)" from
// "not overridden".
function ovDateStr(d: any): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

async function loadOverrides(companyId: string, sessionIds: string[], from: string, to: string): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (!sessionIds.length) return map;
  const { rows } = await query(
    'SELECT * FROM academic_session_overrides WHERE company_id = $1 AND session_id = ANY($2) AND date >= $3 AND date <= $4',
    [companyId, sessionIds, from, to]);
  for (const o of rows) map.set(o.session_id + '|' + ovDateStr(o.date), o);
  return map;
}

function applyOverride(base: any, ov: any, userName: Map<string, string>): any {
  const out = { ...base, hasOverride: true };
  if (ov.has_lecturer) {
    out.lecturerUserId = ov.lecturer_user_id;
    out.lecturerName = ov.lecturer_user_id ? (userName.get(ov.lecturer_user_id) || '—') : null;
  }
  if (ov.has_supervisor) {
    out.supervisorUserId = ov.supervisor_user_id;
    out.supervisorName = ov.supervisor_user_id ? (userName.get(ov.supervisor_user_id) || null) : null;
  }
  if (ov.has_location) out.location = ov.location;
  if (ov.has_meeting_url) out.meetingUrl = ov.meeting_url;
  if (ov.has_times) { out.startTime = ov.start_time; out.endTime = ov.end_time; }
  return out;
}

// Upsert the override row for one date, touching only the given
// columns (keys of `fields` are column names; values may be null).
async function upsertOverride(companyId: string, sessionId: string, date: string, fields: Record<string, any>): Promise<void> {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const insertCols = ['company_id', 'session_id', 'date', ...cols];
  const values = [companyId, sessionId, date, ...cols.map((c) => fields[c])];
  const placeholders = insertCols.map((_, i) => '$' + (i + 1)).join(', ');
  const updates = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  await query(
    `INSERT INTO academic_session_overrides (${insertCols.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (session_id, date) DO UPDATE SET ${updates}, updated_at = now()`,
    values);
}

async function getOverride(sessionId: string, date: string): Promise<any | null> {
  const { rows } = await query('SELECT * FROM academic_session_overrides WHERE session_id = $1 AND date = $2', [sessionId, date]);
  return rows[0] || null;
}

// Effective presenter/supervisor of one date of a series.
function effectivePeople(cur: any, ov: any | null): { lecturer: string | null; supervisor: string | null } {
  return {
    lecturer: ov && ov.has_lecturer ? ov.lecturer_user_id : cur.lecturer_user_id,
    supervisor: ov && ov.has_supervisor ? ov.supervisor_user_id : cur.supervisor_user_id,
  };
}

async function ensureKinds(companyId: string, dashboardId: string) {
  const { rows } = await query('SELECT id FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 LIMIT 1', [companyId, dashboardId]);
  if (!rows.length) {
    for (const k of DEFAULT_KINDS) {
      await query(
        'INSERT INTO session_kinds (id, company_id, dashboard_id, key, label, color, position) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dashboard_id, key) DO NOTHING',
        [crypto.randomUUID(), companyId, dashboardId, k.key, k.label, k.color, k.position]);
    }
  }
}

function kindRow(r: any) {
  return { id: r.id, key: r.key, label: r.label, color: r.color || '#00796b', dashboardId: r.dashboard_id || null };
}

// A posted kind key is valid when the session's dashboard has it.
async function cleanKind(companyId: string, dashboardId: string | null, raw: any): Promise<string> {
  const key = String(raw || '').trim().toLowerCase();
  if (!key) return 'session';
  if (!dashboardId) return key === 'event' ? 'event' : 'session';
  const { rows } = await query('SELECT key FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 AND key = $3', [companyId, dashboardId, key]);
  return rows.length ? key : 'session';
}

// Zoom / Teams link: empty clears it; anything set must be http(s).
function cleanMeetingUrl(raw: any): { url: string | null } | { error: string } {
  const v = String(raw || '').trim();
  if (!v) return { url: null };
  if (!/^https?:\/\//i.test(v)) return { error: 'The meeting link must start with http:// or https://' };
  if (v.length > 1000) return { error: 'That meeting link is too long.' };
  return { url: v };
}

function slugifyKind(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'kind';
}

// GET /api/schedule/session-kinds — all roles. With ?dashboardId=,
// that dashboard's kinds (seeded with Lecture/Event on first use).
// Without, every kind in the company (each row carries its dashboardId)
// so aggregated views can resolve labels/colors per dashboard.
router.get('/session-kinds', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dashId = req.query.dashboardId ? String(req.query.dashboardId) : null;
    if (dashId) {
      const { rows: d } = await query('SELECT id FROM dashboards WHERE id = $1 AND company_id = $2', [dashId, companyId]);
      if (!d.length) { res.status(404).json({ error: 'Unknown dashboard.' }); return; }
      await ensureKinds(companyId, dashId);
      const { rows } = await query('SELECT * FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 ORDER BY position, label', [companyId, dashId]);
      res.json({ kinds: rows.map(kindRow) });
      return;
    }
    const { rows } = await query('SELECT * FROM session_kinds WHERE company_id = $1 ORDER BY position, label', [companyId]);
    res.json({ kinds: rows.map(kindRow) });
  } catch (err) {
    console.error('[schedule] session kinds list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/session-kinds — owner or scheduler adds a kind to
// one dashboard.
router.post('/session-kinds', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    const dashboardId = b.dashboardId ? String(b.dashboardId) : null;
    if (!dashboardId) { res.status(400).json({ error: 'Session types live on a dashboard — open the dashboard and add the type there.' }); return; }
    const { rows: d } = await query('SELECT id FROM dashboards WHERE id = $1 AND company_id = $2', [dashboardId, companyId]);
    if (!d.length) { res.status(400).json({ error: 'Unknown dashboard.' }); return; }
    if (!(await dashboardEditAllowed(req, dashboardId))) { res.status(403).json({ error: 'Only this dashboard\'s editors can change its session types.' }); return; }
    await ensureKinds(companyId, dashboardId);
    const label = String(b.label || '').trim();
    if (!label) { res.status(400).json({ error: 'A name is required.' }); return; }
    if (label.length > 40) { res.status(400).json({ error: 'That name is too long (40 characters max).' }); return; }
    const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || '')) ? String(b.color) : '#00796b';
    const { rows: dup } = await query('SELECT id FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 AND lower(label) = lower($3)', [companyId, dashboardId, label]);
    if (dup.length) { res.status(400).json({ error: 'This dashboard already has a session type with that name.' }); return; }
    let key = slugifyKind(label);
    const { rows: existing } = await query('SELECT key FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2', [companyId, dashboardId]);
    const keys = new Set(existing.map((r: any) => r.key));
    if (keys.has(key)) { let n = 2; while (keys.has(key + '-' + n)) n++; key = key + '-' + n; }
    const { rows: mx } = await query('SELECT COALESCE(MAX(position), 0) AS m FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2', [companyId, dashboardId]);
    const id = crypto.randomUUID();
    await query('INSERT INTO session_kinds (id, company_id, dashboard_id, key, label, color, position) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, companyId, dashboardId, key, label, color, (mx[0].m || 0) + 1]);
    res.json({ ok: true, kind: { id, key, label, color, dashboardId } });
  } catch (err) {
    console.error('[schedule] session kind create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/session-kinds/:id — owner or scheduler. Sessions
// that used the kind keep its key; the app falls back to the raw name.
router.delete('/session-kinds/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query('SELECT dashboard_id FROM session_kinds WHERE id = $1 AND company_id = $2', [String(req.params.id), companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    if (rows[0].dashboard_id && !(await dashboardEditAllowed(req, rows[0].dashboard_id))) {
      res.status(403).json({ error: 'Only this dashboard\'s editors can change its session types.' }); return;
    }
    await query('DELETE FROM session_kinds WHERE id = $1 AND company_id = $2', [String(req.params.id), companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] session kind delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/academic-sessions?from=YYYY-MM-DD&to=YYYY-MM-DD&dashboardId= —
// all roles, department-scoped. Recurring series are expanded into the window
// as occurrence rows (id = "<base>@@<date>", seriesId = base id).
router.get('/academic-sessions', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const ids = await academicVisibleDeptIds(req);
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const clauses = ['s.company_id = $1'];
    const params: any[] = [companyId];
    if (ids) {
      params.push(ids);
      clauses.push(`(s.department_id = ANY($${params.length}) )`);
    }
    if (from && to) {
      params.push(from, to);
      clauses.push(`(s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $${params.length - 1})`);
      clauses.push(`s.session_date <= $${params.length}`);
    } else {
      if (from) { params.push(from); clauses.push(`s.session_date >= $${params.length}`); }
      if (to) { params.push(to); clauses.push(`s.session_date <= $${params.length}`); }
    }
    if (req.query.dashboardId) { params.push(String(req.query.dashboardId)); clauses.push(`s.dashboard_id = $${params.length}`); }
    const { rows } = await query(
      `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
              sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
       FROM academic_sessions s
       LEFT JOIN users u ON u.id = s.lecturer_user_id
       LEFT JOIN users sup ON sup.id = s.supervisor_user_id
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY s.session_date, s.start_time NULLS LAST, s.title`,
      params);
    let ovMap = new Map<string, any>();
    const userName = new Map<string, string>();
    if (from && to && rows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
      ovMap = await loadOverrides(companyId, rows.map((r: any) => r.id), from, to);
      const { rows: us } = await query('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [companyId]);
      for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
    }
    const out: any[] = [];
    for (const r of rows) {
      const base = academicRow(r);
      const rule = base.recurRule;
      if (!from || !to || !rule || rule === 'none') {
        if (!from || (base.date >= from && base.date <= (to || '9999-99-99'))) out.push(base);
        continue;
      }
      const end = base.recurUntil && base.recurUntil < to ? base.recurUntil : to;
      const startD = new Date(base.date + 'T00:00:00Z');
      const endD = new Date(end + 'T00:00:00Z');
      const interval = Math.max(1, base.recurInterval || 1);
      const maxCount = base.recurCount && base.recurCount > 0 ? base.recurCount : Infinity;
      let occCount = 0;
      const pushOcc = function (d: Date): boolean {
        if (occCount >= maxCount) return false;
        occCount++;
        const ds = d.toISOString().slice(0, 10);
        if (ds >= from && ds <= to) {
          const ov = ovMap.get(base.id + '|' + ds);
          if (ov && ov.cancelled) return occCount < maxCount; // this date is cancelled on its own
          const occ0 = ds === base.date
            ? { ...base, seriesId: base.id }
            : { ...base, id: base.id + '@@' + ds, seriesId: base.id, date: ds, isOccurrence: true };
          out.push(ov ? applyOverride(occ0, ov, userName) : occ0);
        }
        return occCount < maxCount;
      };
      if (rule === 'daily') {
        const cur = new Date(startD);
        while (cur <= endD) {
          if (!pushOcc(cur)) break;
          cur.setUTCDate(cur.getUTCDate() + interval);
        }
      } else if (rule === 'weekly') {
        const days: number[] = base.recurDays && base.recurDays.length ? base.recurDays : [startD.getUTCDay()];
        const week0 = new Date(startD);
        week0.setUTCDate(week0.getUTCDate() - week0.getUTCDay());
        const cur = new Date(startD);
        let go = true;
        while (cur <= endD && go) {
          const weekIdx = Math.floor((cur.getTime() - week0.getTime()) / (7 * 86400000));
          if (days.includes(cur.getUTCDay()) && weekIdx % interval === 0) go = pushOcc(cur);
          cur.setUTCDate(cur.getUTCDate() + 1);
        }
      } else if (rule === 'monthly-weekday') {
        const wd = startD.getUTCDay();
        const nth = Math.floor((startD.getUTCDate() - 1) / 7) + 1;
        const dimStart = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth() + 1, 0)).getUTCDate();
        const isLast = startD.getUTCDate() + 7 > dimStart;
        let y = startD.getUTCFullYear(), mo = startD.getUTCMonth();
        let go = true;
        while (Date.UTC(y, mo, 1) <= endD.getTime() && go) {
          const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
          let day = 0;
          if (isLast) {
            const lastD = new Date(Date.UTC(y, mo, dim));
            day = dim - ((lastD.getUTCDay() - wd + 7) % 7);
          } else {
            const firstD = new Date(Date.UTC(y, mo, 1));
            const firstOcc = 1 + ((wd - firstD.getUTCDay() + 7) % 7);
            const cand = firstOcc + (nth - 1) * 7;
            if (cand <= dim) day = cand;
          }
          if (day) {
            const d = new Date(Date.UTC(y, mo, day));
            if (d >= startD && d <= endD) go = pushOcc(d);
          }
          mo += interval; while (mo > 11) { mo -= 12; y++; }
        }
      } else if (rule === 'yearly') {
        const cur = new Date(startD);
        const baseDayY = cur.getUTCDate();
        const baseMonth = cur.getUTCMonth();
        while (cur <= endD) {
          if (!pushOcc(cur)) break;
          const ny = cur.getUTCFullYear() + interval;
          const dimY = new Date(Date.UTC(ny, baseMonth + 1, 0)).getUTCDate();
          cur.setUTCFullYear(ny);
          cur.setUTCMonth(baseMonth);
          cur.setUTCDate(Math.min(baseDayY, dimY));
        }
      } else {
        // monthly (same date) — step interval months, clamp the day.
        const cur = new Date(startD);
        const baseDay = cur.getUTCDate();
        while (cur <= endD) {
          if (!pushOcc(cur)) break;
          cur.setUTCDate(1);
          cur.setUTCMonth(cur.getUTCMonth() + interval);
          var lastDay2 = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0)).getUTCDate();
          cur.setUTCDate(Math.min(baseDay, lastDay2));
        }
      }
    }
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startTime || '99') < (b.startTime || '99') ? -1 : 1;
    });
    res.json({ sessions: out });
  } catch (err) {
    console.error('[schedule] academic sessions list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function academicDeptCheck(req: Request, res: Response, departmentId: string | null): Promise<boolean> {
  const role = req.session.role!;
  if (role === 'owner') return true;
  if (role !== 'scheduler') { res.status(403).json({ error: 'You do not have permission to do that.' }); return false; }
  if (!departmentId) { res.status(403).json({ error: 'Only the owner can add sessions without a department.' }); return false; }
  const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
  if (!access.edit.includes(departmentId)) {
    res.status(403).json({ error: 'You do not have Edit access to that department.' });
    return false;
  }
  return true;
}

// POST /api/schedule/academic-sessions — owner or scheduler (edit-scoped).
router.post('/academic-sessions', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    const title = String(b.title || '').trim();
    if (!title) { res.status(400).json({ error: 'A title is required.' }); return; }
    const departmentId = b.departmentId ? String(b.departmentId) : null;
    let dashboardId: string | null = null;
    if (b.dashboardId) {
      const { rows: dRows } = await query('SELECT id FROM dashboards WHERE id = $1 AND company_id = $2', [String(b.dashboardId), companyId]);
      if (!dRows.length) { res.status(400).json({ error: 'Unknown dashboard.' }); return; }
      dashboardId = String(b.dashboardId);
    }
    if (!(await sessionEditCheck(req, res, dashboardId, departmentId))) return;
    if (b.lecturerUserId) {
      const { rows } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [b.lecturerUserId, companyId]);
      if (!rows.length) { res.status(400).json({ error: 'That lecturer is not an active team member.' }); return; }
    }
    if (b.supervisorUserId) {
      const { rows } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [b.supervisorUserId, companyId]);
      if (!rows.length) { res.status(400).json({ error: 'That supervisor is not an active team member.' }); return; }
    }
    const mu = cleanMeetingUrl(b.meetingUrl);
    if ('error' in mu) { res.status(400).json({ error: mu.error }); return; }
    const rec = cleanRecur(b);
    const recurRule = rec.rule;
    const recurDays = cleanRecurDays(b.recurDays);
    const recurUntil = recurRule !== 'none' && b.recurUntil ? String(b.recurUntil) : (recurRule !== 'none' ? null : null);
    const kind = await cleanKind(companyId, dashboardId, b.kind);
    const { rows } = await query(
      `INSERT INTO academic_sessions (id, company_id, title, lecturer_user_id, department_id, session_date, start_time, end_time, location, kind, notes, created_by, dashboard_id, recur_rule, recur_until, supervisor_user_id, recur_days, recur_interval, recur_count, meeting_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [crypto.randomUUID(), companyId, title, b.lecturerUserId || null, departmentId,
       b.date, b.startTime || null, b.endTime || null, b.location ? String(b.location).trim() : null,
       kind, b.notes ? String(b.notes).trim() : null, req.session.userId!, dashboardId, recurRule, recurUntil, b.supervisorUserId || null,
       recurRule === 'weekly' ? (recurDays.length ? recurDays.join(',') : null) : null, rec.interval, rec.count, mu.url]);
    res.json({ ok: true, id: rows[0].id });
    // Notify the presenter/supervisor; if there is no presenter, tell
    // the dashboard's department members a presenter is needed.
    {
      const people = [b.lecturerUserId, b.supervisorUserId].filter(Boolean).map(String);
      const dateStr = b.date ? String(b.date).slice(0, 10) : '';
      if (people.length) {
        notify({
          companyId, userIds: people, category: 'calendar', type: 'session_assigned',
          title: `New session: "${title}"${dateStr ? ` on ${fmtDateLong(dateStr)}` : ''}`,
          body: `You are on the session "${title}"${dateStr ? ` on ${fmtDateLong(dateStr)}` : ''}${b.startTime ? ` at ${String(b.startTime).slice(0, 5)}` : ''}.`,
          link: 'calendars', bundleKey: 'session_assigned',
          excludeUserId: req.session.userId!,
        });
      } else {
        let memberIds: string[] = [];
        if (dashboardId) {
          const { rows: dd } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [dashboardId]);
          for (const d of dd) memberIds.push(...await deptMemberIds(companyId, d.department_id));
        } else if (departmentId) {
          memberIds = await deptMemberIds(companyId, departmentId);
        }
        if (memberIds.length) {
          notify({
            companyId, userIds: memberIds, category: 'calendar', type: 'session_needs_presenter',
            title: `A session needs a presenter: "${title}"${dateStr ? ` on ${fmtDateLong(dateStr)}` : ''}`,
            body: `"${title}" has no presenter yet.`,
            link: 'calendars', bundleKey: 'session_needs_presenter',
            excludeUserId: req.session.userId!,
          });
        }
      }
    }
  } catch (err) {
    console.error('[schedule] academic session create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/academic-sessions/bulk-assign — owner or
// scheduler. Assign a presenter, supervisor or location to many
// sessions at once (Deepika, 2026-10-21). Items are the occurrences
// as shown on the calendar ({id, date}): a recurring session touched
// with a date writes that date's override only; a one-off session
// (or an item without a date) updates the session itself.
router.post('/academic-sessions/bulk-assign', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    const field = ['lecturer', 'supervisor', 'location'].includes(String(b.field)) ? String(b.field) : null;
    if (!field) { res.status(400).json({ error: 'Say what to assign: presenter, supervisor or location.' }); return; }
    const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
    if (!items.length) { res.status(400).json({ error: 'Select at least one session.' }); return; }
    let userId: string | null = null;
    if (field !== 'location' && b.userId) {
      const { rows: lu } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [String(b.userId), companyId]);
      if (!lu.length) { res.status(400).json({ error: 'That person is not an active team member.' }); return; }
      userId = String(b.userId);
    }
    const locVal = field === 'location' ? (b.location ? String(b.location).trim().slice(0, 200) : null) : null;
    let updated = 0;
    const skipped: any[] = [];
    let assignedChanges = 0;
    const removedCounts = new Map<string, number>();
    for (const it of items) {
      const seriesId = String((it && it.id) || '').split('@@')[0];
      const date = it && it.date && /^\d{4}-\d{2}-\d{2}$/.test(String(it.date)) ? String(it.date) : null;
      if (!seriesId) { skipped.push({ id: it && it.id, error: 'Not found.' }); continue; }
      const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
      if (!rows.length) { skipped.push({ id: it.id, error: 'Not found.' }); continue; }
      const cur = rows[0];
      if (!(await canEditSessionQuiet(req, cur.dashboard_id, cur.department_id))) { skipped.push({ id: it.id, error: 'Not editable.' }); continue; }
      const recurring = cur.recur_rule && cur.recur_rule !== 'none';
      // Who holds this slot now (for notifications below)?
      let prevHolder: string | null = null;
      if (field !== 'location') {
        if (recurring && date) {
          const ov = await getOverride(seriesId, date);
          const eff = effectivePeople(cur, ov);
          prevHolder = field === 'lecturer' ? eff.lecturer : eff.supervisor;
        } else {
          prevHolder = cur[field === 'lecturer' ? 'lecturer_user_id' : 'supervisor_user_id'];
        }
      }
      if (recurring && date) {
        if (field === 'lecturer') await upsertOverride(companyId, seriesId, date, { has_lecturer: true, lecturer_user_id: userId });
        else if (field === 'supervisor') await upsertOverride(companyId, seriesId, date, { has_supervisor: true, supervisor_user_id: userId });
        else await upsertOverride(companyId, seriesId, date, { has_location: true, location: locVal });
      } else {
        const col = field === 'lecturer' ? 'lecturer_user_id' : field === 'supervisor' ? 'supervisor_user_id' : 'location';
        const val = field === 'location' ? locVal : userId;
        await query(`UPDATE academic_sessions SET ${col} = $1 WHERE id = $2 AND company_id = $3`, [val, seriesId, companyId]);
      }
      updated++;
      if (field !== 'location') {
        if (userId && prevHolder !== userId) assignedChanges++;
        if (prevHolder && prevHolder !== userId) removedCounts.set(prevHolder, (removedCounts.get(prevHolder) || 0) + 1);
      }
    }
    res.json({ ok: true, updated, skipped });
    // Notify the newly assigned person and anyone who lost sessions.
    if (field !== 'location') {
      const roleWord = field === 'lecturer' ? 'presenter' : 'supervisor';
      if (userId && assignedChanges > 0) {
        notify({
          companyId, userIds: [userId], category: 'calendar', type: 'session_assigned',
          title: assignedChanges === 1 ? `You were assigned a session as ${roleWord}` : `You were assigned ${assignedChanges} sessions as ${roleWord}`,
          body: `${assignedChanges} session(s) now list you as ${roleWord}.`,
          link: 'calendars', bundleKey: 'session_assigned',
          payload: { count: assignedChanges },
          excludeUserId: req.session.userId!,
        });
      }
      for (const [uid, n] of removedCounts) {
        notify({
          companyId, userIds: [uid], category: 'calendar', type: 'session_changed',
          title: n === 1 ? `You were removed as ${roleWord} from a session` : `You were removed as ${roleWord} from ${n} sessions`,
          body: `${n} session(s) no longer list you as ${roleWord}.`,
          link: 'calendars', bundleKey: 'session_changed',
          payload: { count: n },
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] bulk assign failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/academic-sessions/:id/claim — presenter pickup
// (Deepika, 2026-10-20): any signed-in user who can see a session with no
// presenter ("Needs presenter") picks it up. Body { role: 'supervisor' }
// picks up the supervisor slot instead. Claiming an occurrence claims
// the whole series. Atomic: the UPDATE lands only while the slot is open.
router.post('/academic-sessions/:id/claim', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    const ids = await academicVisibleDeptIds(req);
    if (ids && (!cur.department_id || !ids.includes(cur.department_id))) {
      res.status(403).json({ error: 'You do not have access to this session.' }); return;
    }
    const col = String(req.body?.role || '') === 'supervisor' ? 'supervisor_user_id' : 'lecturer_user_id';
    const isSup = col === 'supervisor_user_id';
    // Per-date pickup: a recurring session claimed WITH a date
    // claims only that date (override row), never the whole series.
    const occDate = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date)) ? String(req.body.date) : null;
    if (occDate && cur.recur_rule && cur.recur_rule !== 'none') {
      const ov = await getOverride(seriesId, occDate);
      if (ov && ov.cancelled) { res.status(409).json({ error: 'This date is cancelled.' }); return; }
      const eff = effectivePeople(cur, ov);
      const holder = isSup ? eff.supervisor : eff.lecturer;
      if (holder) {
        if (holder === req.session.userId) { res.json({ ok: true, already: true }); return; }
        res.status(409).json({ error: 'Someone already picked this up.' }); return;
      }
      const flag = isSup ? 'has_supervisor' : 'has_lecturer';
      await query('INSERT INTO academic_session_overrides (company_id, session_id, date) VALUES ($1, $2, $3) ON CONFLICT (session_id, date) DO NOTHING', [companyId, seriesId, occDate]);
      const upd2 = await query(
        `UPDATE academic_session_overrides SET ${col} = $1, ${flag} = true, updated_at = now()
         WHERE session_id = $2 AND date = $3 AND ${col} IS NULL`,
        [req.session.userId!, seriesId, occDate]);
      if (!upd2.rowCount) {
        const ov2 = await getOverride(seriesId, occDate);
        const nowHolder = ov2 ? (isSup ? ov2.supervisor_user_id : ov2.lecturer_user_id) : null;
        if (nowHolder === req.session.userId) { res.json({ ok: true, already: true }); return; }
        res.status(409).json({ error: 'Someone already picked this up.' }); return;
      }
      res.json({ ok: true });
      return;
    }
    if (cur[col]) {
      if (cur[col] === req.session.userId) { res.json({ ok: true, already: true }); return; }
      res.status(409).json({ error: 'Someone already picked this up.' }); return;
    }
    const upd = await query(
      `UPDATE academic_sessions SET ${col} = $1 WHERE id = $2 AND company_id = $3 AND ${col} IS NULL`,
      [req.session.userId!, seriesId, companyId]);
    if (!upd.rowCount) { res.status(409).json({ error: 'Someone already picked this up.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] academic session claim failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/academic-sessions/:id/unclaim — the presenter gives the
// slot back; an owner/scheduler with edit rights on the department can also
// clear someone else's.
router.post('/academic-sessions/:id/unclaim', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    const occDateU = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date)) ? String(req.body.date) : null;
    if (occDateU && cur.recur_rule && cur.recur_rule !== 'none') {
      const ov = await getOverride(seriesId, occDateU);
      const eff = effectivePeople(cur, ov);
      if (!eff.lecturer) { res.json({ ok: true }); return; }
      if (eff.lecturer !== req.session.userId) {
        if (req.session.role === 'employee') { res.status(403).json({ error: 'Only the presenter can give this up.' }); return; }
        if (!(await academicDeptCheck(req, res, cur.department_id))) return;
      }
      await upsertOverride(companyId, seriesId, occDateU, { has_lecturer: true, lecturer_user_id: null });
      res.json({ ok: true });
      return;
    }
    if (!cur.lecturer_user_id) { res.json({ ok: true }); return; }
    if (cur.lecturer_user_id !== req.session.userId) {
      if (req.session.role === 'employee') { res.status(403).json({ error: 'Only the presenter can give this up.' }); return; }
      if (!(await academicDeptCheck(req, res, cur.department_id))) return;
    }
    await query('UPDATE academic_sessions SET lecturer_user_id = NULL WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] academic session unclaim failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/academic-sessions/:id/overrides/:date —
// reset one date back to the series defaults (owner or scheduler).
router.delete('/academic-sessions/:id/overrides/:date', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A valid date is required.' }); return; }
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    if (!(await sessionEditCheck(req, res, cur.dashboard_id, cur.department_id))) return;
    const ovBefore = await getOverride(seriesId, date);
    await query('DELETE FROM academic_session_overrides WHERE session_id = $1 AND date = $2', [seriesId, date]);
    res.json({ ok: true });
    {
      const eff = effectivePeople(cur, ovBefore);
      const people = [eff.lecturer, eff.supervisor].filter(Boolean) as string[];
      if (people.length) {
        notify({
          companyId, userIds: people, category: 'calendar', type: 'session_changed',
          title: `Session changed: "${cur.title}" on ${fmtDateLong(date)}`,
          body: `The session "${cur.title}" on ${fmtDateLong(date)} was reset to the series settings.`,
          link: 'calendars', bundleKey: 'session_changed',
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] session override delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/academic-sessions/:id — owner or scheduler (edit-scoped).
router.put('/academic-sessions/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    const b = req.body ?? {};
    const departmentId = b.departmentId !== undefined ? (b.departmentId ? String(b.departmentId) : null) : cur.department_id;
    const targetDashboardId = b.dashboardId !== undefined ? (b.dashboardId ? String(b.dashboardId) : null) : cur.dashboard_id;
    if (!(await sessionEditCheck(req, res, targetDashboardId, departmentId))) return;
    // One-date change: write an override for a single date of a
    // recurring series instead of touching the series itself.
    if (String(b.scope || '') === 'date') {
      const occDate = b.date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : null;
      if (!occDate) { res.status(400).json({ error: 'A date is required for a one-date change.' }); return; }
      if (!cur.recur_rule || cur.recur_rule === 'none') { res.status(400).json({ error: 'This session does not repeat.' }); return; }
      if (b.cancelled === true) {
        const ovBefore = await getOverride(seriesId, occDate);
        const eff = effectivePeople(cur, ovBefore);
        await upsertOverride(companyId, seriesId, occDate, { cancelled: true });
        res.json({ ok: true, scope: 'date', cancelled: true });
        {
          const people = [eff.lecturer, eff.supervisor].filter(Boolean) as string[];
          if (people.length) {
            notify({
              companyId, userIds: people, category: 'calendar', type: 'session_cancelled',
              title: `Session cancelled: "${cur.title}" on ${fmtDateLong(occDate)}`,
              body: `The session "${cur.title}" was cancelled for ${fmtDateLong(occDate)} (just this date).`,
              link: 'calendars', bundleKey: 'session_cancelled',
              excludeUserId: req.session.userId!,
            });
          }
        }
        return;
      }
      for (const key of ['lecturerUserId', 'supervisorUserId']) {
        if (b[key]) {
          const { rows: lu } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [b[key], companyId]);
          if (!lu.length) { res.status(400).json({ error: 'That person is not an active team member.' }); return; }
        }
      }
      const fields: Record<string, any> = { cancelled: false };
      if (b.lecturerUserId !== undefined) { fields.has_lecturer = true; fields.lecturer_user_id = b.lecturerUserId ? String(b.lecturerUserId) : null; }
      if (b.supervisorUserId !== undefined) { fields.has_supervisor = true; fields.supervisor_user_id = b.supervisorUserId ? String(b.supervisorUserId) : null; }
      if (b.location !== undefined) { fields.has_location = true; fields.location = b.location ? String(b.location).trim() : null; }
      if (b.meetingUrl !== undefined) {
        const cm = cleanMeetingUrl(b.meetingUrl);
        if ('error' in cm) { res.status(400).json({ error: cm.error }); return; }
        fields.has_meeting_url = true; fields.meeting_url = cm.url;
      }
      if (b.startTime !== undefined || b.endTime !== undefined) {
        fields.has_times = true;
        fields.start_time = b.startTime ? String(b.startTime) : null;
        fields.end_time = b.endTime ? String(b.endTime) : null;
      }
      await upsertOverride(companyId, seriesId, occDate, fields);
      res.json({ ok: true, scope: 'date' });
      {
        const people = [cur.lecturer_user_id, cur.supervisor_user_id, b.lecturerUserId || null, b.supervisorUserId || null].filter(Boolean) as string[];
        if (people.length) {
          notify({
            companyId, userIds: [...new Set(people)], category: 'calendar', type: 'session_changed',
            title: `Session changed: "${cur.title}" on ${fmtDateLong(occDate)}`,
            body: `The session "${cur.title}" was changed for ${fmtDateLong(occDate)} (just this date).`,
            link: 'calendars', bundleKey: 'session_changed',
            excludeUserId: req.session.userId!,
          });
        }
      }
      return;
    }
    if (b.lecturerUserId) {
      const { rows: lu } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [b.lecturerUserId, companyId]);
      if (!lu.length) { res.status(400).json({ error: 'That lecturer is not an active team member.' }); return; }
    }
    const title = b.title !== undefined ? String(b.title).trim() : cur.title;
    if (!title) { res.status(400).json({ error: 'A title is required.' }); return; }
    let meetingUrl = cur.meeting_url || null;
    if (b.meetingUrl !== undefined) {
      const mu = cleanMeetingUrl(b.meetingUrl);
      if ('error' in mu) { res.status(400).json({ error: mu.error }); return; }
      meetingUrl = mu.url;
    }
    const rec = b.recurRule !== undefined ? cleanRecur(b) : { rule: cur.recur_rule === 'biweekly' ? 'weekly' : (cur.recur_rule || 'none'), interval: cur.recur_rule === 'biweekly' ? 2 : (cur.recur_interval || 1), count: cur.recur_count || null };
    const recurRule = rec.rule;
    const recurDays = b.recurDays !== undefined ? cleanRecurDays(b.recurDays) : (cur.recur_days ? String(cur.recur_days).split(',').map(function (x: string) { return parseInt(x, 10); }) : []);
    const recurUntil = b.recurUntil !== undefined ? (recurRule !== 'none' && b.recurUntil ? String(b.recurUntil) : null) : cur.recur_until;
    const supervisorUserId = b.supervisorUserId !== undefined ? (b.supervisorUserId || null) : cur.supervisor_user_id;
    if (supervisorUserId) {
      const { rows: su } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [supervisorUserId, companyId]);
      if (!su.length) { res.status(400).json({ error: 'That supervisor is not an active team member.' }); return; }
    }
    let dashboardId = cur.dashboard_id;
    if (b.dashboardId !== undefined) {
      if (b.dashboardId) {
        const { rows: dRows } = await query('SELECT id FROM dashboards WHERE id = $1 AND company_id = $2', [String(b.dashboardId), companyId]);
        if (!dRows.length) { res.status(400).json({ error: 'Unknown dashboard.' }); return; }
        dashboardId = String(b.dashboardId);
      } else dashboardId = null;
    }
    const kind = b.kind !== undefined ? await cleanKind(companyId, dashboardId, b.kind) : cur.kind;
    await query(
      `UPDATE academic_sessions SET title=$1, lecturer_user_id=$2, department_id=$3, session_date=$4,
        start_time=$5, end_time=$6, location=$7, kind=$8, notes=$9, dashboard_id=$10, recur_rule=$11, recur_until=$12, supervisor_user_id=$13, recur_days=$14, recur_interval=$15, recur_count=$16, meeting_url=$17 WHERE id=$18`,
      [title, b.lecturerUserId !== undefined ? (b.lecturerUserId || null) : cur.lecturer_user_id,
       departmentId, b.date || cur.session_date,
       b.startTime !== undefined ? (b.startTime || null) : cur.start_time,
       b.endTime !== undefined ? (b.endTime || null) : cur.end_time,
       b.location !== undefined ? (b.location ? String(b.location).trim() : null) : cur.location,
       kind, b.notes !== undefined ? (b.notes ? String(b.notes).trim() : null) : cur.notes,
       dashboardId, recurRule, recurUntil, supervisorUserId,
       recurRule === 'weekly' ? (recurDays.length ? recurDays.join(',') : null) : null, rec.interval, rec.count, meetingUrl, seriesId]);
    res.json({ ok: true });
    // Notify old + new presenter/supervisor about meaningful changes.
    {
      const newLecturer = b.lecturerUserId !== undefined ? (b.lecturerUserId || null) : cur.lecturer_user_id;
      const newSupervisor = supervisorUserId;
      const newDate = b.date || cur.session_date;
      const dstr = (v: any) => !v ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
      const changed =
        String(newLecturer || '') !== String(cur.lecturer_user_id || '') ||
        String(newSupervisor || '') !== String(cur.supervisor_user_id || '') ||
        title !== cur.title ||
        dstr(newDate) !== dstr(cur.session_date) ||
        (b.startTime !== undefined && (b.startTime || null) !== cur.start_time) ||
        (b.endTime !== undefined && (b.endTime || null) !== cur.end_time) ||
        (b.location !== undefined && (b.location ? String(b.location).trim() : null) !== cur.location);
      const people = [cur.lecturer_user_id, cur.supervisor_user_id, newLecturer, newSupervisor].filter(Boolean) as string[];
      if (changed && people.length) {
        notify({
          companyId, userIds: [...new Set(people)], category: 'calendar', type: 'session_changed',
          title: `Session changed: "${title}"`,
          body: `The session "${cur.title}" was updated.`,
          link: 'calendars', bundleKey: 'session_changed',
          excludeUserId: req.session.userId!,
        });
      }
      if (!newLecturer && cur.lecturer_user_id) {
        let memberIds: string[] = [];
        if (dashboardId) {
          const { rows: dd } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [dashboardId]);
          for (const d of dd) memberIds.push(...await deptMemberIds(companyId, d.department_id));
        } else if (departmentId) {
          memberIds = await deptMemberIds(companyId, departmentId);
        }
        if (memberIds.length) {
          notify({
            companyId, userIds: memberIds, category: 'calendar', type: 'session_needs_presenter',
            title: `A session needs a presenter: "${title}"`,
            body: `"${title}" no longer has a presenter.`,
            link: 'calendars', bundleKey: 'session_needs_presenter',
            excludeUserId: req.session.userId!,
          });
        }
      }
    }
  } catch (err) {
    console.error('[schedule] academic session update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/academic-sessions/:id — owner or scheduler (edit-scoped).
router.delete('/academic-sessions/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT title, lecturer_user_id, supervisor_user_id, session_date::text AS sdate, department_id, dashboard_id FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    if (!(await sessionEditCheck(req, res, rows[0].dashboard_id, rows[0].department_id))) return;
    await query('DELETE FROM academic_sessions WHERE id = $1', [seriesId]);
    res.json({ ok: true });
    {
      const people = [rows[0].lecturer_user_id, rows[0].supervisor_user_id].filter(Boolean) as string[];
      if (people.length) {
        notify({
          companyId, userIds: people, category: 'calendar', type: 'session_cancelled',
          title: `Session cancelled: "${rows[0].title}"`,
          body: `The session "${rows[0].title}" (${fmtDateLong(rows[0].sdate)}) was cancelled.`,
          link: 'calendars', bundleKey: 'session_cancelled',
          excludeUserId: req.session.userId!,
        });
      }
    }
  } catch (err) {
    console.error('[schedule] academic session delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;

// POST /api/schedule/scheduled-promotions — schedule future role promotions (owner/scheduler).
router.post('/scheduled-promotions', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const userId = (req.session as any)?.userId;
    const { promotions, effectiveDate } = req.body;
    if (!Array.isArray(promotions) || !promotions.length) { res.status(400).json({ error: 'promotions must be a non-empty array.' }); return; }
    if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) { res.status(400).json({ error: 'effectiveDate must be YYYY-MM-DD.' }); return; }
    const today = new Date().toISOString().slice(0, 10);
    if (effectiveDate < today) { res.status(400).json({ error: 'Effective date must be today or in the future.' }); return; }
    let created = 0;
    for (const p of promotions) {
      if (!p.userId || !p.toRoleId) continue;
      // Verify user and role belong to this company.
      const { rows: urows } = await query('SELECT id, job_role_id FROM users WHERE id = $1 AND company_id = $2', [p.userId, companyId]);
      if (!urows.length) continue;
      const { rows: rrows } = await query('SELECT id FROM job_roles WHERE id = $1 AND company_id = $2', [p.toRoleId, companyId]);
      if (!rrows.length) continue;
      await query(
        `INSERT INTO scheduled_promotions (company_id, user_id, from_role_id, to_role_id, effective_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, user_id, effective_date) DO UPDATE SET to_role_id = $4, from_role_id = $3, status = 'pending', applied_at = NULL`,
        [companyId, p.userId, urows[0].job_role_id || null, p.toRoleId, effectiveDate, userId]
      );
      created++;
    }
    res.json({ ok: true, created });
  } catch (err) {
    console.error('[schedule] schedule promotions failed:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// GET /api/schedule/scheduled-promotions — list pending scheduled promotions.
router.get('/scheduled-promotions', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT sp.id, sp.effective_date, sp.status, sp.created_at,
              u.name AS user_name, u.email AS user_email,
              fr.name AS from_role, tr.name AS to_role,
              d.name AS department_name
       FROM scheduled_promotions sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN job_roles fr ON fr.id = sp.from_role_id
       JOIN job_roles tr ON tr.id = sp.to_role_id
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE sp.company_id = $1 AND sp.status = 'pending'
       ORDER BY sp.effective_date, u.name`,
      [companyId]
    );
    res.json({ promotions: rows });
  } catch (err) {
    console.error('[schedule] list promotions failed:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// DELETE /api/schedule/scheduled-promotions/:id — cancel a pending promotion.
router.delete('/scheduled-promotions/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query(
      "UPDATE scheduled_promotions SET status = 'cancelled' WHERE id = $1 AND company_id = $2 AND status = 'pending'",
      [req.params.id, companyId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Promotion not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] cancel promotion failed:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// Apply due promotions — called on server start and daily.
export async function applyDuePromotions() {
  try {
    const { rows } = await query(
      `SELECT sp.id, sp.company_id, sp.user_id, sp.to_role_id
       FROM scheduled_promotions sp
       WHERE sp.status = 'pending' AND sp.effective_date <= CURRENT_DATE`
    );
    for (const p of rows) {
      await query('UPDATE users SET job_role_id = $1 WHERE id = $2 AND company_id = $3', [p.to_role_id, p.user_id, p.company_id]);
      await query("UPDATE scheduled_promotions SET status = 'applied', applied_at = NOW() WHERE id = $1", [p.id]);
    }
    if (rows.length) console.log(`[promotions] Applied ${rows.length} due role promotions.`);
  } catch (err) {
    console.error('[promotions] Failed to apply due promotions:', err);
  }
}

