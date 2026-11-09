// routes/schedule.ts — Phase 3: scheduling core.
// Shift types, shifts, per-date publish state, day comments, rotations.
// All endpoints are company-scoped via the server session.

import { Router, Request, Response, urlencoded } from 'express';
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
import { auditLog, auditPlanChanges, todayStr } from '../util/audit.js';
import { ensureInboundAddress, fullInboundAddress, inboundDomain } from '../util/inboundAddresses.js';
import * as XLSX from 'xlsx';
import { parseScheduleDocument, isGeminiConfigured } from '../util/gemini';
import { notify, fmtDateLong, eligibleMemberIds, deptApproverIds, planApproverIds, deptMemberIds } from '../util/notify.js';
import { checkShiftConflict, checkSwapConflicts, getShiftTypeTimes, makeTimedShift, findShiftConflict } from '../util/shiftConflicts.js';
import { sendShiftRequestActionEmails, sendShiftRequestApproverEmails } from '../util/requestActionEmails.js';
import { sendGapOfferNotifications } from '../util/gapOfferEmails.js';
import { sendSessionOfferNotifications } from '../util/sessionOfferEmails.js';
import { getShiftsForRange } from '../util/shiftRange.js';
import {
  cleanSpeakers, saveSpeakers, loadSpeakers, sessionsWithSpeakers, speakerMirror,
  cleanBeneficiaries, saveBeneficiaries, loadBeneficiaries, loadInvitedUserIds,
  emailGuests, newlyAddedGuests, describeRecur,
} from '../util/sessionPeople.js';
import {
  isMeetingProvider, providerName, providerConfigured, getValidAccessToken,
  createMeeting, updateMeeting, normalizeMeetingTimes, deleteExternalMeetingQuiet,
  MeetingError, MeetingInput, wallTimeToUtc,
} from '../util/meetingProviders.js';
import {
  fetchConnectedRooms, syncRoomsForCompany, importRoomsForCompany,
  getRoomSyncState, hasSyncedRooms, maybeLazySyncRooms, RoomProvider,
} from '../util/roomProviders.js';
import { getIntegration } from '../util/meetingProviders.js';

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
       String(color || '#7fc8bc'), String(textColor || '#ffffff'), Number(sortOrder) || 0,
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
    // Employee view (Deepika, 2026-11-09 — Step 1 of pattern ≠
    // schedule): an employee sees a shift ONLY when it is published.
    // Rotation occurrences are an admin preview until a publish
    // stamps them into real shifts, and draft stored shifts are not
    // shown either. Owner/scheduler responses are unchanged.
    const employeeView = req.session.role === 'employee';
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
      `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate",
              end_date::text AS "endDate",
              group_id AS "groupId", group_ids AS "groupIds", group_shift_type_id AS "groupShiftTypeId",
              group_days AS "groupDays", turn_unit AS "turnUnit",
              turn_days AS "turnDays", week_start AS "weekStart"
       FROM rotations WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );

    // Vacation ranges per person (pauses attach to the rotations a
    // person is assigned to) — group turns skip a member who is on
    // vacation that date, the same way their own rotation does.
    // 'Bulk delete' pauses are NOT vacations: they are admin
    // removals, so they must never trigger the vacation pass/cover
    // in group rotations.
    const { rows: vacRows } = await query(
      `SELECT ra.user_id AS "userId", p.start_date::text AS "startDate", p.end_date::text AS "endDate"
       FROM rotation_pauses p
       JOIN rotation_assignments ra ON ra.rotation_id = p.rotation_id
       WHERE p.company_id = $1 AND (p.reason IS NULL OR p.reason <> 'Bulk delete')`,
      [companyId]
    );
    const vacMap = new Map<string, Array<{ start: string; end: string }>>();
    for (const v of vacRows) {
      if (!vacMap.has(v.userId)) vacMap.set(v.userId, []);
      vacMap.get(v.userId)!.push({ start: v.startDate, end: v.endDate });
    }
    const onVacation = (userId: string, dateStr: string): boolean => {
      const periods = vacMap.get(userId);
      if (!periods) return false;
      return periods.some((pd) => dateStr >= pd.start && dateStr <= pd.end);
    };

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
                u.is_active AS "userActive", u.end_date::text AS "userEndDate",
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

      // Group rotation ("special shift", Deepika 2026-11-04): the
      // group's members take turns in their fixed order for the
      // rotation's shift type, on the rotation's chosen cycle days.
      // Turns are a pure function of the date — counted from the
      // rotation's start — so a skipped turn (vacation, manual shift)
      // never reshuffles the order.
      if ((rot as any).groupId && (rot as any).groupShiftTypeId) {
        // The rotation rotates through its groups in order; each
        // group rotates its own members. Turn BLOCKS are counted by
        // dealing (a week with no run-dates is never a block), so a
        // one-week-on / one-week-off pattern advances people only on
        // the weeks actually worked.
        const groupIds = String((rot as any).groupIds || (rot as any).groupId)
          .split(',').map((x: string) => x.trim()).filter(Boolean);
        const groupsMembers: any[][] = [];
        for (const gid of groupIds) {
          const { rows: members } = await query(
            `SELECT gm.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
                    u.nickname, u.end_date::text AS "userEndDate",
                    st.name AS "shiftTypeName", st.short_name AS "shiftTypeShort",
                    st.color AS "shiftTypeColor", st.text_color AS "shiftTypeTextColor",
                    st.sort_order AS "sortOrder"
             FROM rotation_group_members gm
             JOIN users u ON u.id = gm.user_id
             JOIN shift_types st ON st.id = $2
             WHERE gm.group_id = $1 AND u.is_active = true
             ORDER BY gm.position`,
            [gid, (rot as any).groupShiftTypeId]
          );
          groupsMembers.push(members);
        }
        const daySet = new Set(
          String((rot as any).groupDays || '').split(',').map((x: string) => Number(x)).filter((n: number) => n >= 1)
        );
        if (groupsMembers.length && groupsMembers.some((g) => g.length) && daySet.size) {
          const stId = (rot as any).groupShiftTypeId as string;
          const unit = (rot as any).turnUnit || 'shift';
          const tDays = Math.max(1, Number((rot as any).turnDays) || 1);
          const wStart = Number.isInteger((rot as any).weekStart) ? (rot as any).weekStart : 1;
          const dayMs = 86400000;
          const startMs = Date.parse(rot.startDate + 'T00:00:00Z');
          const fromMs = Date.parse(from + 'T00:00:00Z');
          const toMs = Date.parse(to + 'T00:00:00Z');
          const anchorMs = startMs - ((new Date(startMs).getUTCDay() - wStart + 7) % 7) * dayMs;
          let occ = 0;
          let blockIdx = -1;
          let lastKey: string | null = null;
          // Each group is a LINE (Deepika 2026-11-04 evening): the
          // member at the front takes the group's next turn and goes
          // to the back of the line. If the person whose turn is
          // starting is on vacation, the next person IN THE SAME
          // GROUP takes the whole turn; the vacationing member keeps
          // their place at the front and takes the next turn. Nobody
          // is pulled from another group, and no one works two turns
          // in a row because of a swap — the line just keeps moving.
          // A turn is empty only if the whole group is on vacation.
          const queues: any[][] = groupsMembers.map((g) => g.slice());
          let currentMember: any = null;
          for (let ms = startMs; ms <= toMs; ms += dayMs) {
            const dayIndex = Math.floor((ms - startMs) / dayMs);
            const cycleDay = (dayIndex % rot.cycleDays) + 1;
            if (!daySet.has(cycleDay)) continue;
            const dateStr = new Date(ms).toISOString().slice(0, 10);
            let key: string;
            if (unit === 'week') key = 'w' + Math.floor((ms - anchorMs) / (7 * dayMs));
            else if (unit === 'days') key = 'd' + Math.floor(occ / tDays);
            else key = 's' + occ;
            occ++;
            if (key !== lastKey) {
              lastKey = key;
              blockIdx++;
              const gIdx = blockIdx % groupsMembers.length;
              const q = queues[gIdx];
              currentMember = null;
              for (let qi = 0; qi < q.length; qi++) {
                if (!onVacation(q[qi].userId, dateStr)) {
                  currentMember = q[qi];
                  q.splice(qi, 1);
                  q.push(currentMember);
                  break;
                }
              }
            }
            if (ms < fromMs) continue;
            if (isPaused(rot.id, dateStr)) continue;
            if ((rot as any).endDate && dateStr > (rot as any).endDate) continue;
            const m = currentMember;
            if (!m) continue;
            // A few days off in the middle of a turn changes
            // nothing (Deepika 2026-11-04 evening - keep it
            // simple): those days are simply blank for an admin
            // to fill manually. Only a vacation at the turn's
            // start moves the turn, settled when dealt above.
            if (onVacation(m.userId, dateStr)) continue;
            if (m.userEndDate && dateStr > String(m.userEndDate).slice(0, 10)) continue;
            const hasManual = rows.some((s: any) =>
              s.userId === m.userId && s.date === dateStr && s.shiftTypeId === stId
            );
            if (hasManual) continue;
            const exclKey = `${rot.id}|${m.userId}|${dateStr}|${stId}`;
            if (exclSet.has(exclKey)) continue;
            rotationShifts.push({
              id: `rot-${rot.id}-${m.userId}-${dateStr}`,
              date: dateStr,
              notes: null,
              published: pubMap.has(exclKey) ? pubMap.get(exclKey) : true,
              userId: m.userId,
              firstName: m.firstName,
              lastName: m.lastName,
              nickname: m.nickname,
              shiftTypeId: stId,
              shiftTypeName: m.shiftTypeName,
              shiftTypeShort: m.shiftTypeShort,
              shiftTypeColor: m.shiftTypeColor,
              shiftTypeTextColor: m.shiftTypeTextColor,
              isRotation: true,
              rotationId: rot.id,
              rotationName: rot.name,
              _sortOrder: m.sortOrder,
              _special: true,
            });
          }
        }
        continue;
      }

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
        // Rotation end date (migration 100): end_date is the last
        // drawn day; dates ascend, so the loop can stop here.
        if ((rot as any).endDate && dateStr > (rot as any).endDate) break;

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

    // Special-shift precedence (Deepika 2026-11-04): a group-rotation
    // shift takes preference over the same person's OTHER rotation
    // shifts. A normal rotation occurrence that clashes with one of
    // their special shifts (time overlap, or under 8 hours of rest;
    // untimed types clash on a shared day) is not generated — the
    // shortfall shows in Short cover like any other gap. Manual
    // shifts are never touched.
    if (rotationShifts.some((s: any) => s._special)) {
      const typeTimes = await getShiftTypeTimes(query, companyId);
      const specialsByUser = new Map<string, any[]>();
      for (const s of rotationShifts) {
        if (!s._special) continue;
        if (!specialsByUser.has(s.userId)) specialsByUser.set(s.userId, []);
        specialsByUser.get(s.userId)!.push(makeTimedShift(typeTimes, s.userId, s));
      }
      for (let i = rotationShifts.length - 1; i >= 0; i--) {
        const s = rotationShifts[i];
        if (s._special) { delete s._special; continue; }
        const specials = specialsByUser.get(s.userId);
        if (!specials || !specials.length) continue;
        const timed = makeTimedShift(typeTimes, s.userId, s);
        if (specials.some((sp: any) => !!findShiftConflict('This person', [sp], timed))) {
          rotationShifts.splice(i, 1);
        }
      }
    }

    // Merge and sort.
    // Manual shifts are NEVER hidden — a vacation pause suppresses only
    // the rotation occurrences it belongs to. (An earlier rule also hid
    // a paused user's manual shifts from every view while they still
    // existed in the data: the person looked unscheduled, yet pickups
    // on those dates collided with the invisible shifts. Deepika hit
    // exactly that on her vacation dates, 2026-11-03.)
    const visibleManual = employeeView ? rows.filter((s: any) => s.published) : rows;

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

    const all = employeeView ? [...visibleManual] : [...visibleManual, ...rotationShifts];
    all.sort((a: any, b: any) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const soA = a._sortOrder ?? 999;
      const soB = b._sortOrder ?? 999;
      if (soA !== soB) return soA - soB;
      const nA = `${a.firstName} ${a.lastName}`;
      const nB = `${b.firstName} ${b.lastName}`;
      return nA.localeCompare(nB);
    });

    // Open cover requests (Deepika 2026-11-02): a shift whose owner asked
    // for cover shows on the schedule as available for pick up — to the
    // people who were asked (broadcast = the same same-role, clash-free
    // list the bell went to; one-person = that person). The requester and
    // owner/schedulers see a plain "cover asked" marker instead. The
    // owner's name stays on the shift until someone picks it up; first
    // pickup wins (claim re-checks conflicts at /shift-requests/:id/approve).
    try {
      const manualIds = visibleManual.map((s: any) => s.id);
      if (manualIds.length) {
        const { rows: coverReqs } = await query(
          `SELECT id, shift_id AS "shiftId", requester_id AS "requesterId", target_user_id AS "targetUserId"
           FROM shift_requests
           WHERE company_id = $1 AND request_type = 'pickup' AND status = 'pending' AND shift_id = ANY($2)`,
          [companyId, manualIds]
        );
        if (coverReqs.length) {
          const { coverBroadcastRecipients } = await import('../util/requestForm.js');
          const viewerId = req.session.userId!;
          const viewerPrivileged = req.session.role === 'owner' || req.session.role === 'scheduler';
          const byShift = new Map<string, any>();
          for (const r of coverReqs) byShift.set(r.shiftId, r);
          for (const s of visibleManual) {
            const r = byShift.get(s.id);
            if (!r) continue;
            let mode: string | null = null;
            if (r.targetUserId) {
              mode = r.targetUserId === viewerId ? 'pickup' : (viewerPrivileged || r.requesterId === viewerId ? 'open' : null);
            } else if (r.requesterId === viewerId || viewerPrivileged) {
              mode = 'open';
            } else {
              const recips = await coverBroadcastRecipients(query, companyId, r.requesterId, { date: s.date, shiftTypeId: s.shiftTypeId, shiftTypeName: s.shiftTypeName });
              mode = recips.some((p: any) => p.id === viewerId) ? 'pickup' : null;
            }
            if (mode) { s.coverForViewer = mode; s.coverRequestId = r.id; }
          }
        }
      }
    } catch { /* cover markers are decoration — never fail the schedule */ }

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
    // Group rotations have no assignment rows, so the pause pass
    // below can't hold them back — exclude their generated
    // occurrences date by date instead (Deepika 2026-11-04 evening:
    // bulk delete must work for group rotations too). This runs
    // BEFORE the pause pass so the occurrences are generated from
    // the pre-delete state.
    try {
      const { rows: gRots } = await query(
        'SELECT id FROM rotations WHERE company_id = $1 AND group_id IS NOT NULL AND is_active = true',
        [companyId]
      );
      if (gRots.length) {
        const gSet = new Set(gRots.map((r: any) => r.id));
        const dateSet = new Set(valid);
        const gen = await getShiftsForRange(query, companyId, from, to);
        for (const s of gen as any[]) {
          if (!s.isRotation || !s.rotationId || !gSet.has(s.rotationId)) continue;
          if (!dateSet.has(s.date)) continue;
          if (Array.isArray(userIds) && userIds.length && !userIds.includes(s.userId)) continue;
          if (shiftTypeId && s.shiftTypeId !== shiftTypeId) continue;
          await query(
            `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
            [companyId, s.rotationId, s.userId, s.date, s.shiftTypeId]
          );
          paused++;
        }
      }
    } catch (err) {
      console.error('[schedule] bulk delete group exclusions failed:', err);
    }
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

// --- Drag-and-drop move / swap / undo (Deepika, 2026-11-01) ----------------
// Works for manual shifts AND rotation-generated instances. A rotation
// instance has no row: moving it excludes that one occurrence from the
// rotation and creates a real shift at the destination; swapping into a
// rotation slot does the same for the incoming person. Responses carry an
// `undo` payload (inverse ops) whenever a rotation was involved; the client
// replays it through /shifts/drag-undo on Ctrl+Z.

interface DragRef {
  kind: 'manual' | 'rotation';
  id: string;
  userId: string;
  date: string;
  shiftTypeId: string;
  published: boolean;
  rotationId?: string;
}

async function resolveDragRef(companyId: string, refId: string): Promise<DragRef | null> {
  if (typeof refId !== 'string' || !refId) return null;
  if (refId.startsWith('rot-')) {
    const date = refId.slice(-10);
    if (!isValidDate(date)) return null;
    const all = await getShiftsForRange(query, companyId, date, date);
    const e = all.find((x) => x.id === refId && x.isRotation);
    if (!e || !e.userId || !e.shiftTypeId) return null;
    return {
      kind: 'rotation', id: refId, userId: e.userId, date: e.date,
      shiftTypeId: e.shiftTypeId, published: e.published !== false,
      rotationId: refId.slice(4, 40),
    };
  }
  const { rows } = await query(
    'SELECT user_id AS "userId", shift_type_id AS "shiftTypeId", date::text AS date, published FROM shifts WHERE id = $1 AND company_id = $2',
    [refId, companyId]
  );
  if (!rows.length) return null;
  return {
    kind: 'manual', id: refId, userId: rows[0].userId, date: rows[0].date,
    shiftTypeId: rows[0].shiftTypeId, published: rows[0].published !== false,
  };
}

type DragQueryFn = (text: string, params?: any[]) => Promise<any>;
async function insertRotationExclusion(q: DragQueryFn, companyId: string, ref: DragRef): Promise<void> {
  await q(
    `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
    [companyId, ref.rotationId, ref.userId, ref.date, ref.shiftTypeId]
  );
}

// POST /api/schedule/shifts/:id/drag-move — drag-and-drop move of one shift
// (manual row or rotation instance) to a new date and/or shift type. Same
// person, same published state; eligibility + duplicate + overlap/rest
// guards all apply, exactly like a fresh manual assign.
router.post('/shifts/:id/drag-move', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { date, shiftTypeId } = req.body ?? {};
    if (!isValidDate(date) || !shiftTypeId) {
      res.status(400).json({ error: 'A valid date and shift type are required.' });
      return;
    }
    const src = await resolveDragRef(companyId, req.params.id);
    if (!src) { res.status(404).json({ error: 'Shift not found.' }); return; }
    if (src.date === date && src.shiftTypeId === shiftTypeId) { res.json({ ok: true, noop: true }); return; }
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments(
        [{ userId: src.userId, shiftTypeId }, { userId: src.userId, shiftTypeId: src.shiftTypeId }],
        companyId)
    ))) return;
    const { rows: trows } = await query(
      'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2',
      [shiftTypeId, companyId]
    );
    if (!trows.length) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    const eligibility = await checkShiftEligibility(companyId, src.userId, trows[0].eligible_job_role_ids);
    if (!eligibility.ok) { res.status(403).json({ error: eligibility.error }); return; }
    const { rows: dup } = await query(
      `SELECT id FROM shifts WHERE company_id = $1 AND date = $2 AND user_id = $3 AND shift_type_id = $4 AND id <> $5 LIMIT 1`,
      [companyId, date, src.userId, shiftTypeId, src.kind === 'manual' ? src.id : '00000000-0000-0000-0000-000000000000']
    );
    if (dup.length) {
      res.status(409).json({ error: 'This person already has this shift on that date.' });
      return;
    }
    const names = await shiftDisplayNames(companyId, src.userId, shiftTypeId);
    const conflict = await checkShiftConflict(query, companyId, {
      userId: src.userId, personName: names.personName,
      proposed: { date, shiftTypeId },
      exclude: [{ date: src.date, shiftTypeId: src.shiftTypeId }],
    });
    if (conflict) { res.status(409).json({ error: conflict }); return; }
    let undo: any = null;
    if (src.kind === 'manual') {
      await query(
        `UPDATE shifts SET shift_type_id = $1, date = $2, updated_at = now() WHERE id = $3 AND company_id = $4`,
        [shiftTypeId, date, src.id, companyId]
      );
    } else {
      const newId = crypto.randomUUID();
      await withTransaction(async (tx) => {
        await insertRotationExclusion(tx.query, companyId, src);
        await tx.query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
          [newId, companyId, src.userId, shiftTypeId, date, src.published, req.session.userId!]
        );
      });
      undo = {
        ops: [
          { deleteShiftId: newId },
          { deleteExclusion: { rotationId: src.rotationId, userId: src.userId, date: src.date, shiftTypeId: src.shiftTypeId } },
        ],
      };
    }
    res.json(undo ? { ok: true, undo } : { ok: true });
    auditLog({
      companyId, date, action: 'updated',
      personName: names.personName, shiftTypeName: names.shiftTypeName,
      source: 'manual', changedBy: req.session.userId!,
      details: { shiftId: src.id, via: 'drag' },
    });
    if (src.published) {
      const oldNames = await shiftDisplayNames(companyId, src.userId, src.shiftTypeId);
      notify({
        companyId, userIds: [src.userId], category: 'schedule', type: 'shift_changed',
        title: `Shift changed: ${names.shiftTypeName} on ${fmtDateLong(date)}`,
        body: `Your shift changed from ${oldNames.shiftTypeName} on ${fmtDateLong(src.date)} to ${names.shiftTypeName} on ${fmtDateLong(date)}.`,
        link: 'my-schedule', bundleKey: `shift_changed:${src.userId}`,
        bundleTitle: '{count} of your shifts changed',
        excludeUserId: req.session.userId!,
      });
    }
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'This person already has this shift on that date.' });
      return;
    }
    console.error('[schedule] drag-move failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/drag-swap — drag-and-drop swap: the people on two
// shifts (manual rows and/or rotation instances) trade places; dates/types
// stay with the slots. Eligibility and overlap/rest are simulated for BOTH
// people before anything moves.
router.post('/shifts/drag-swap', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { aId, bId } = req.body ?? {};
    if (!aId || !bId || aId === bId) {
      res.status(400).json({ error: 'Two different shifts are required.' });
      return;
    }
    const a = await resolveDragRef(companyId, aId);
    const b = await resolveDragRef(companyId, bId);
    if (!a || !b) { res.status(404).json({ error: 'Shift not found.' }); return; }
    if (a.userId === b.userId) { res.status(400).json({ error: 'That is the same person.' }); return; }
    if (a.date === b.date && a.shiftTypeId === b.shiftTypeId) {
      res.status(400).json({ error: 'Those shifts are identical — nothing to swap.' });
      return;
    }
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments(
        [
          { userId: a.userId, shiftTypeId: a.shiftTypeId }, { userId: b.userId, shiftTypeId: b.shiftTypeId },
          { userId: a.userId, shiftTypeId: b.shiftTypeId }, { userId: b.userId, shiftTypeId: a.shiftTypeId },
        ],
        companyId)
    ))) return;
    const { rows: trows } = await query(
      'SELECT id, eligible_job_role_ids FROM shift_types WHERE id = ANY($1) AND company_id = $2',
      [[a.shiftTypeId, b.shiftTypeId], companyId]
    );
    const eligFor = (tid: string) => (trows.find((t: any) => t.id === tid) || {}).eligible_job_role_ids;
    const namesA = await shiftDisplayNames(companyId, a.userId, a.shiftTypeId);
    const namesB = await shiftDisplayNames(companyId, b.userId, b.shiftTypeId);
    const eligA = await checkShiftEligibility(companyId, a.userId, eligFor(b.shiftTypeId));
    if (!eligA.ok) { res.status(403).json({ error: eligA.error }); return; }
    const eligB = await checkShiftEligibility(companyId, b.userId, eligFor(a.shiftTypeId));
    if (!eligB.ok) { res.status(403).json({ error: eligB.error }); return; }
    const conflict = await checkSwapConflicts(query, companyId, [
      {
        userId: a.userId, personName: namesA.personName,
        gives: [{ date: a.date, shiftTypeId: a.shiftTypeId }],
        receives: [{ date: b.date, shiftTypeId: b.shiftTypeId }],
      },
      {
        userId: b.userId, personName: namesB.personName,
        gives: [{ date: b.date, shiftTypeId: b.shiftTypeId }],
        receives: [{ date: a.date, shiftTypeId: a.shiftTypeId }],
      },
    ]);
    if (conflict) { res.status(409).json({ error: conflict }); return; }
    let undo: any = null;
    await withTransaction(async (tx) => {
      const ops: any[] = [];
      if (a.kind === 'manual') {
        await tx.query('UPDATE shifts SET user_id = $1, updated_at = now() WHERE id = $2 AND company_id = $3', [b.userId, a.id, companyId]);
        ops.push({ updateShiftUser: { shiftId: a.id, userId: a.userId } });
      } else {
        await insertRotationExclusion(tx.query, companyId, a);
        ops.push({ deleteExclusion: { rotationId: a.rotationId, userId: a.userId, date: a.date, shiftTypeId: a.shiftTypeId } });
        const newId = crypto.randomUUID();
        await tx.query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
          [newId, companyId, b.userId, a.shiftTypeId, a.date, a.published, req.session.userId!]
        );
        ops.push({ deleteShiftId: newId });
      }
      if (b.kind === 'manual') {
        await tx.query('UPDATE shifts SET user_id = $1, updated_at = now() WHERE id = $2 AND company_id = $3', [a.userId, b.id, companyId]);
        ops.push({ updateShiftUser: { shiftId: b.id, userId: b.userId } });
      } else {
        await insertRotationExclusion(tx.query, companyId, b);
        ops.push({ deleteExclusion: { rotationId: b.rotationId, userId: b.userId, date: b.date, shiftTypeId: b.shiftTypeId } });
        const newId = crypto.randomUUID();
        await tx.query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
           VALUES ($1, $2, $3, $4, $5, NULL, $6, $7)`,
          [newId, companyId, a.userId, b.shiftTypeId, b.date, b.published, req.session.userId!]
        );
        ops.push({ deleteShiftId: newId });
      }
      if (a.kind === 'rotation' || b.kind === 'rotation') undo = { ops };
    });
    res.json(undo ? { ok: true, undo } : { ok: true });
    auditLog({
      companyId, date: a.date, action: 'updated',
      personName: namesB.personName, shiftTypeName: namesA.shiftTypeName,
      source: 'manual', changedBy: req.session.userId!,
      details: { shiftId: a.id, via: 'drag-swap' },
    });
    auditLog({
      companyId, date: b.date, action: 'updated',
      personName: namesA.personName, shiftTypeName: namesB.shiftTypeName,
      source: 'manual', changedBy: req.session.userId!,
      details: { shiftId: b.id, via: 'drag-swap' },
    });
    const actor = req.session.userId!;
    if (b.published) {
      notify({
        companyId, userIds: [a.userId], category: 'schedule', type: 'shift_changed',
        title: `Shift changed: ${namesB.shiftTypeName} on ${fmtDateLong(b.date)}`,
        body: `Your shift changed from ${namesA.shiftTypeName} on ${fmtDateLong(a.date)} to ${namesB.shiftTypeName} on ${fmtDateLong(b.date)}.`,
        link: 'my-schedule', bundleKey: `shift_changed:${a.userId}`,
        bundleTitle: '{count} of your shifts changed',
        excludeUserId: actor,
      });
    }
    if (a.published) {
      notify({
        companyId, userIds: [b.userId], category: 'schedule', type: 'shift_changed',
        title: `Shift changed: ${namesA.shiftTypeName} on ${fmtDateLong(a.date)}`,
        body: `Your shift changed from ${namesB.shiftTypeName} on ${fmtDateLong(b.date)} to ${namesA.shiftTypeName} on ${fmtDateLong(a.date)}.`,
        link: 'my-schedule', bundleKey: `shift_changed:${b.userId}`,
        bundleTitle: '{count} of your shifts changed',
        excludeUserId: actor,
      });
    }
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'One of them already has that shift on that date.' });
      return;
    }
    console.error('[schedule] drag-swap failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/shifts/drag-undo — replay the inverse ops a drag-move /
// drag-swap returned (rotation cases only; manual cases undo by re-calling
// those endpoints). Restores exclusions and rows exactly as they were.
router.post('/shifts/drag-undo', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const ops = (req.body?.undo?.ops || []) as any[];
    if (!Array.isArray(ops) || !ops.length || ops.length > 8) {
      res.status(400).json({ error: 'Nothing to undo.' });
      return;
    }
    for (const op of ops) {
      const kinds = ['deleteShiftId', 'deleteExclusion', 'updateShiftUser'].filter((k) => op && op[k]);
      if (kinds.length !== 1) { res.status(400).json({ error: 'Nothing to undo.' }); return; }
    }
    await withTransaction(async (tx) => {
      for (const op of ops) {
        if (op.deleteShiftId) {
          await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [op.deleteShiftId, companyId]);
        } else if (op.deleteExclusion) {
          const e = op.deleteExclusion;
          await tx.query(
            `DELETE FROM rotation_shift_exclusions
             WHERE company_id = $1 AND rotation_id = $2 AND user_id = $3 AND date = $4 AND shift_type_id = $5`,
            [companyId, e.rotationId, e.userId, e.date, e.shiftTypeId]
          );
        } else if (op.updateShiftUser) {
          const u = op.updateShiftUser;
          const { rows: urows } = await tx.query('SELECT id FROM users WHERE id = $1 AND company_id = $2', [u.userId, companyId]);
          if (!urows.length) throw new Error('undo user not in company');
          await tx.query('UPDATE shifts SET user_id = $1, updated_at = now() WHERE id = $2 AND company_id = $3', [u.userId, u.shiftId, companyId]);
        }
      }
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] drag-undo failed:', err);
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
// ---------------------------------------------------------------------------
// Rotation groups (Deepika 2026-11-04): named, ordered member lists.
// Admins/schedulers build them; a rotation in group mode deals its
// shift to the members in turn ("special shift" — see generation).
// ---------------------------------------------------------------------------

router.get('/rotation-groups', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: groups } = await query(
      `SELECT id, name FROM rotation_groups WHERE company_id = $1 ORDER BY lower(name)`,
      [companyId]
    );
    for (const g of groups) {
      const { rows: ms } = await query(
        `SELECT gm.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName",
                u.is_active AS "isActive"
         FROM rotation_group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1 ORDER BY gm.position`,
        [g.id]
      );
      g.members = ms;
    }
    const { rows: used } = await query(
      `SELECT group_ids AS "groupIds", name FROM rotations WHERE company_id = $1 AND group_ids IS NOT NULL`,
      [companyId]
    );
    const usedBy = new Map<string, string[]>();
    for (const u of used) {
      for (const gid of String(u.groupIds).split(',').map((x: string) => x.trim()).filter(Boolean)) {
        if (!usedBy.has(gid)) usedBy.set(gid, []);
        usedBy.get(gid)!.push(u.name);
      }
    }
    for (const g of groups) g.usedBy = usedBy.get(g.id) || [];
    res.json({ groups });
  } catch (err) {
    console.error('[schedule] list rotation groups failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/rotation-groups', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const name = String(req.body?.name || '').trim();
    if (!name) { res.status(400).json({ error: 'A group name is required.' }); return; }
    const id = crypto.randomUUID();
    await query(
      'INSERT INTO rotation_groups (id, company_id, name) VALUES ($1, $2, $3)',
      [id, companyId, name.slice(0, 120)]
    );
    res.status(201).json({ id });
  } catch (err) {
    console.error('[schedule] create rotation group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /rotation-groups/:id — rename and/or replace the ordered member list.
router.put('/rotation-groups/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: grows } = await query(
      'SELECT id FROM rotation_groups WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!grows.length) { res.status(404).json({ error: 'Group not found.' }); return; }
    const name = req.body?.name != null ? String(req.body.name).trim() : null;
    if (name) {
      await query('UPDATE rotation_groups SET name = $1 WHERE id = $2', [name.slice(0, 120), req.params.id]);
    }
    if (Array.isArray(req.body?.memberIds)) {
      const ids = [...new Set(req.body.memberIds.map((x: any) => String(x)))].slice(0, 100);
      if (ids.length) {
        const { rows: valid } = await query(
          'SELECT id FROM users WHERE company_id = $1 AND id = ANY($2::uuid[])',
          [companyId, ids]
        );
        const validSet = new Set(valid.map((r: any) => r.id));
        if ((ids as string[]).some((x) => !validSet.has(x))) {
          res.status(400).json({ error: 'Every member must be on your team.' });
          return;
        }
      }
      await query('DELETE FROM rotation_group_members WHERE group_id = $1', [req.params.id]);
      for (let i = 0; i < ids.length; i++) {
        await query(
          'INSERT INTO rotation_group_members (group_id, user_id, position) VALUES ($1, $2, $3)',
          [req.params.id, ids[i], i + 1]
        );
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update rotation group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/rotation-groups/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rowCount } = await query(
      'DELETE FROM rotation_groups WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) { res.status(404).json({ error: 'Group not found.' }); return; }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete rotation group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/rotations', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: rots } = await query(
      `SELECT r.id, r.name, r.cycle_days AS "cycleDays", r.start_date::text AS "startDate",
              r.end_date::text AS "endDate",
              r.is_active AS "isActive",
              r.start_time::text AS "startTime", r.end_time::text AS "endTime", r.notes,
              r.group_id AS "groupId", r.group_ids AS "groupIds", rg.name AS "groupName",
              r.group_shift_type_id AS "groupShiftTypeId", gst.name AS "groupShiftTypeName",
              r.group_days AS "groupDays", r.turn_unit AS "turnUnit",
              r.turn_days AS "turnDays", r.week_start AS "weekStart"
       FROM rotations r
       LEFT JOIN rotation_groups rg ON rg.id = r.group_id
       LEFT JOIN shift_types gst ON gst.id = r.group_shift_type_id
       WHERE r.company_id = $1 ORDER BY r.name`,
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
    // Optional end date (migration 100): the rotation's last drawn
    // day. The edit form re-creates rotations, so it passes the old
    // rotation's end date through — an ended rotation must not
    // silently become endless because someone edited its name.
    const endDate = isValidDate(req.body?.endDate) ? String(req.body.endDate) : null;
    if (endDate && endDate < startDate) {
      res.status(400).json({ error: 'The end date must be on or after the start date.' });
      return;
    }
    // Group mode (Deepika 2026-11-04): the rotation rotates through
    // an ordered list of groups; each group rotates its own members.
    const rawGroupIds: any[] = Array.isArray(req.body?.groupIds) ? req.body.groupIds
      : (req.body?.groupId ? [req.body.groupId] : []);
    const groupIds: string[] = [...new Set(rawGroupIds.map((x: any) => String(x)))].slice(0, 12) as string[];
    let groupPayload: any = null;
    if (groupIds.length) {
      const gShiftTypeId = req.body?.groupShiftTypeId ? String(req.body.groupShiftTypeId) : null;
      const gDays = (Array.isArray(req.body?.groupDays) ? req.body.groupDays : [])
        .map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= cd);
      const unit = ['shift', 'days', 'week'].includes(req.body?.turnUnit) ? req.body.turnUnit : 'shift';
      const tDays = Math.min(7, Math.max(1, Number(req.body?.turnDays) || 2));
      const wStart = Number.isInteger(req.body?.weekStart) && req.body.weekStart >= 0 && req.body.weekStart <= 6
        ? req.body.weekStart : 1;
      if (!gShiftTypeId || !gDays.length) {
        res.status(400).json({ error: 'A group rotation needs a shift type and at least one day of the cycle.' });
        return;
      }
      const { rows: trows } = await query(
        'SELECT eligible_job_role_ids AS "eligibleIds" FROM shift_types WHERE id = $1 AND company_id = $2',
        [gShiftTypeId, companyId]
      );
      if (!trows.length) { res.status(400).json({ error: 'That shift type no longer exists.' }); return; }
      const allMembers: any[] = [];
      for (const gid of groupIds) {
        const { rows: grows } = await query(
          'SELECT name FROM rotation_groups WHERE id = $1 AND company_id = $2', [gid, companyId]);
        if (!grows.length) { res.status(400).json({ error: 'One of those groups no longer exists.' }); return; }
        const { rows: members } = await query(
          `SELECT gm.user_id AS "userId", u.first_name AS "firstName", u.last_name AS "lastName"
           FROM rotation_group_members gm JOIN users u ON u.id = gm.user_id
           WHERE gm.group_id = $1 AND u.is_active = true ORDER BY gm.position`,
          [gid]
        );
        if (!members.length) {
          res.status(400).json({ error: `The group "${grows[0].name}" has no active members yet — add people to it first.` });
          return;
        }
        for (const m of members) {
          const elig = await checkShiftEligibility(companyId, m.userId, trows[0].eligibleIds);
          if (!elig.ok) {
            res.status(400).json({
              error: `${m.firstName} ${m.lastName} can't take this shift — ${elig.error.replace(/^This shift can only be picked up by:/, 'it is limited to:')}`,
            });
            return;
          }
          allMembers.push(m);
        }
      }
      groupPayload = {
        groupIds, groupShiftTypeId: gShiftTypeId, groupDays: [...new Set(gDays as number[])].sort((a, b) => a - b),
        turnUnit: unit, turnDays: tDays, weekStart: wStart, members: allMembers,
      };
    }
    // Department scoping: the scheduler's active department must be one of
    // the departments touched by the assignments.
    const scopePairs = groupPayload
      ? groupPayload.members.map((m: any) => ({ userId: m.userId, shiftTypeId: groupPayload.groupShiftTypeId }))
      : (Array.isArray(assignments) ? assignments : []);
    if (!(await requireActiveDepartment(
      req, res,
      await assignmentRelevantDepartments(scopePairs, companyId)
    ))) return;
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const st = startTime && timeRe.test(startTime) ? startTime : null;
    const et = endTime && timeRe.test(endTime) ? endTime : null;
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO rotations (id, company_id, name, cycle_days, start_date, created_by, start_time, end_time, notes,
                              group_id, group_ids, group_shift_type_id, group_days, turn_unit, turn_days, week_start, end_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [id, companyId, String(name).trim(), cd, startDate, req.session.userId!, st, et,
       notes ? String(notes).trim().slice(0, 500) : null,
       groupPayload ? groupPayload.groupIds[0] : null,
       groupPayload ? groupPayload.groupIds.join(',') : null,
       groupPayload ? groupPayload.groupShiftTypeId : null,
       groupPayload ? groupPayload.groupDays.join(',') : null,
       groupPayload ? groupPayload.turnUnit : null,
       groupPayload ? groupPayload.turnDays : null,
       groupPayload ? groupPayload.weekStart : null, endDate]
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

// POST /api/schedule/rotations/copy — copy ONE person's per-person
// rotation pattern to other people (Deepika, 2026-11-08: copy-from-
// standard ONLY). Body: { sourceRotationId, standardUserId,
// targetUserIds: [...], startDate }. Each copy is a NEW, independent
// rotation row for that person (same name, cycle, times, notes and
// the standard's cycle-day/shift-type pattern; start date = the
// admin's pick, pre-filled client-side with the standard's so cycles
// stay in sync). Pauses, exclusions and publish overrides belong to
// the source rotation id and are NOT copied. A target who already
// runs the same pattern is SKIPPED and NAMED in the result — pattern
// identity is cycle length + start/end times + the set of
// (cycle day, shift type) pairs; the start date is NOT part of the
// identity (it is a phase choice, and this flow exists to align it).
router.post('/rotations/copy', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { sourceRotationId, standardUserId } = req.body ?? {};
    const startDate = String(req.body?.startDate || '');
    const rawTargets: any[] = Array.isArray(req.body?.targetUserIds) ? req.body.targetUserIds : [];
    const targetUserIds: string[] = [...new Set(rawTargets.map((x: any) => String(x)))];
    if (!sourceRotationId || !standardUserId || !targetUserIds.length || !isValidDate(startDate)) {
      res.status(400).json({ error: 'Pick a rotation to copy, at least one person to copy to, and a valid start date.' });
      return;
    }
    const { rows: srcRows } = await query(
      `SELECT id, name, cycle_days AS "cycleDays", start_time::text AS "startTime",
              end_time::text AS "endTime", notes, group_id AS "groupId", is_active AS "isActive"
       FROM rotations WHERE id = $1 AND company_id = $2`,
      [String(sourceRotationId), companyId]
    );
    if (!srcRows.length) {
      res.status(404).json({ error: 'That rotation no longer exists.' });
      return;
    }
    const src = srcRows[0];
    if (src.groupId) {
      res.status(400).json({ error: 'That is a group rotation — copying works on one person\'s rotation. Pick a person as the standard.' });
      return;
    }
    if (!src.isActive) {
      res.status(400).json({ error: 'That rotation is paused. Unpause it first, or copy a different one.' });
      return;
    }
    const { rows: stdRows } = await query(
      `SELECT user_id AS "userId", cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId"
       FROM rotation_assignments WHERE rotation_id = $1 AND user_id = $2 ORDER BY cycle_day`,
      [src.id, String(standardUserId)]
    );
    if (!stdRows.length) {
      res.status(400).json({ error: 'That person is not on this rotation — pick them as the standard from their own rotation.' });
      return;
    }
    const { rows: stdUserRows } = await query(
      'SELECT first_name AS "firstName", last_name AS "lastName" FROM users WHERE id = $1 AND company_id = $2',
      [String(standardUserId), companyId]
    );
    const stdName = stdUserRows.length ? `${stdUserRows[0].firstName} ${stdUserRows[0].lastName}`.trim() : 'the standard';
    const normTime = (t: any) => (t ? String(t).slice(0, 5) : '');
    const patternKey = (cycleDays: number, st: any, et: any, pairs: Array<{ cycleDay: number; shiftTypeId: string }>) =>
      `${cycleDays}|${normTime(st)}|${normTime(et)}|` +
      pairs.map((p) => `${p.cycleDay}|${p.shiftTypeId}`).sort().join(',');
    const srcKey = patternKey(src.cycleDays, src.startTime, src.endTime, stdRows);

    // Decide per target first (skip decisions need reads only), so
    // the department-scope check covers exactly what will be created.
    type Decision = { userId: string; name: string; skip: string | null };
    const decisions: Decision[] = [];
    for (const uid of targetUserIds) {
      const { rows: urows } = await query(
        'SELECT first_name AS "firstName", last_name AS "lastName", is_active AS "isActive" FROM users WHERE id = $1 AND company_id = $2',
        [uid, companyId]
      );
      if (!urows.length || !urows[0].isActive) {
        decisions.push({ userId: uid, name: urows.length ? `${urows[0].firstName} ${urows[0].lastName}`.trim() : 'Unknown person', skip: 'not an active team member' });
        continue;
      }
      const name = `${urows[0].firstName} ${urows[0].lastName}`.trim();
      const { rows: theirRots } = await query(
        `SELECT r.id, r.cycle_days AS "cycleDays", r.start_time::text AS "startTime", r.end_time::text AS "endTime"
         FROM rotations r
         WHERE r.company_id = $1 AND r.group_id IS NULL AND r.is_active = true
           AND EXISTS (SELECT 1 FROM rotation_assignments ra WHERE ra.rotation_id = r.id AND ra.user_id = $2)`,
        [companyId, uid]
      );
      let already = false;
      for (const tr of theirRots) {
        const { rows: theirPairs } = await query(
          'SELECT cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId" FROM rotation_assignments WHERE rotation_id = $1 AND user_id = $2',
          [tr.id, uid]
        );
        if (patternKey(tr.cycleDays, tr.startTime, tr.endTime, theirPairs) === srcKey) { already = true; break; }
      }
      decisions.push({ userId: uid, name, skip: already ? 'already has this rotation' : null });
    }

    const toCreate = decisions.filter((d) => !d.skip);
    if (toCreate.length) {
      const scopePairs: Array<{ userId: string; shiftTypeId: string }> = [];
      for (const d of toCreate) for (const p of stdRows) scopePairs.push({ userId: d.userId, shiftTypeId: p.shiftTypeId });
      if (!(await requireActiveDepartment(req, res, await assignmentRelevantDepartments(scopePairs, companyId)))) return;
    }

    const copied: Array<{ userId: string; name: string; rotationId: string }> = [];
    const skipped: Array<{ userId: string; name: string; reason: string }> = [];
    for (const d of decisions) {
      if (d.skip) { skipped.push({ userId: d.userId, name: d.name, reason: d.skip }); continue; }
      const id = crypto.randomUUID();
      await query(
        `INSERT INTO rotations (id, company_id, name, cycle_days, start_date, created_by, start_time, end_time, notes,
                                group_id, group_ids, group_shift_type_id, group_days, turn_unit, turn_days, week_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        [id, companyId, src.name, src.cycleDays, startDate, req.session.userId!, src.startTime, src.endTime, src.notes]
      );
      for (const p of stdRows) {
        await query(
          `INSERT INTO rotation_assignments (id, rotation_id, user_id, cycle_day, shift_type_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [crypto.randomUUID(), id, d.userId, p.cycleDay, p.shiftTypeId]
        );
      }
      await auditLog({
        companyId, date: todayStr(), action: 'created', category: 'settings',
        source: 'manual', rotationName: src.name,
        changedBy: req.session.userId!,
        description: `Copied rotation "${src.name}" from ${stdName} to ${d.name}`,
        details: { rotationId: id, kind: 'rotation', copiedFromRotationId: src.id, copiedFromUserId: String(standardUserId) },
      });
      copied.push({ userId: d.userId, name: d.name, rotationId: id });
    }
    res.json({ copied, skipped });
  } catch (err) {
    console.error('[schedule] copy rotation failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---- End-old / start-new primitive (Deepika, 2026-11-09) ----
// "Change rotation from a date" and "Swap rotations from a date"
// share one move: the OLD rotation gets end_date = the day before
// the chosen date (migration 100 — it stops drawing there, its past
// untouched, its definition never mutated), and a NEW rotation with
// the incoming pattern starts ON the chosen date. Stored/published
// shifts are never involved — this is the pattern layer only.
interface RotationPattern {
  name: string;
  cycleDays: number;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  pairs: Array<{ cycleDay: number; shiftTypeId: string }>;
}
function dayBefore(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
async function readPersonPattern(q: any, rotation: any, userId: string): Promise<RotationPattern> {
  const { rows } = await q(
    'SELECT cycle_day AS "cycleDay", shift_type_id AS "shiftTypeId" FROM rotation_assignments WHERE rotation_id = $1 AND user_id = $2 ORDER BY cycle_day',
    [rotation.id, userId]
  );
  return {
    name: rotation.name,
    cycleDays: rotation.cycleDays,
    startTime: rotation.startTime ? String(rotation.startTime) : null,
    endTime: rotation.endTime ? String(rotation.endTime) : null,
    notes: rotation.notes ?? null,
    pairs: rows,
  };
}
async function insertPatternRotation(tx: any, companyId: string, createdBy: string, userId: string, pattern: RotationPattern, startDate: string): Promise<string> {
  const id = crypto.randomUUID();
  await tx.query(
    `INSERT INTO rotations (id, company_id, name, cycle_days, start_date, created_by, start_time, end_time, notes,
                            group_id, group_ids, group_shift_type_id, group_days, turn_unit, turn_days, week_start, end_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [id, companyId, pattern.name, pattern.cycleDays, startDate, createdBy, pattern.startTime, pattern.endTime, pattern.notes]
  );
  for (const p of pattern.pairs) {
    await tx.query(
      `INSERT INTO rotation_assignments (id, rotation_id, user_id, cycle_day, shift_type_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), id, userId, p.cycleDay, p.shiftTypeId]
    );
  }
  return id;
}

// POST /api/schedule/rotations/:id/change-from — switch ONE person
// to a different rotation from a chosen date (Deepika, 2026-11-09).
// Body: { userId, fromDate, name, cycleDays, startTime, endTime,
// notes, assignments: [{cycleDay, shiftTypeId}] } — the client
// builds the incoming pattern either from the usual form fields or
// by mirroring another person's rotation (the copy-assign data).
// The old rotation stops the day before fromDate; the new one starts
// on fromDate with its cycle anchored there.
router.post('/rotations/:id/change-from', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const rotId = String(req.params.id);
    const userId = String(req.body?.userId || '');
    const fromDate = String(req.body?.fromDate || '');
    const { rows: rotRows } = await query(
      `SELECT id, name, cycle_days AS "cycleDays", start_date::text AS "startDate",
              start_time::text AS "startTime", end_time::text AS "endTime", notes,
              group_id AS "groupId", is_active AS "isActive"
       FROM rotations WHERE id = $1 AND company_id = $2`,
      [rotId, companyId]
    );
    if (!rotRows.length) { res.status(404).json({ error: 'That rotation no longer exists.' }); return; }
    const rot = rotRows[0];
    if (rot.groupId) { res.status(400).json({ error: 'That is a group rotation — changing from a date works on one person\'s rotation.' }); return; }
    if (!rot.isActive) { res.status(400).json({ error: 'That rotation is paused. Unpause it first, or change a different one.' }); return; }
    if (!isValidDate(fromDate)) { res.status(400).json({ error: 'Pick the date the new rotation starts.' }); return; }
    if (fromDate < rot.startDate) {
      res.status(400).json({ error: 'That date is before this rotation starts — edit the rotation itself instead.' });
      return;
    }
    const { rows: peopleRows } = await query(
      'SELECT DISTINCT user_id AS "userId" FROM rotation_assignments WHERE rotation_id = $1',
      [rotId]
    );
    const peopleOnIt = peopleRows.map((r: any) => r.userId);
    if (!peopleOnIt.includes(userId)) { res.status(400).json({ error: 'That person is not on this rotation.' }); return; }
    if (peopleOnIt.length > 1) {
      res.status(400).json({ error: 'This rotation is shared by more than one person — changing from a date works on one person\'s rotation.' });
      return;
    }
    const cd = Number(req.body?.cycleDays);
    if (!Number.isInteger(cd) || cd < 1 || cd > 84) {
      res.status(400).json({ error: 'The new rotation needs a cycle length of 1–84 days.' });
      return;
    }
    const rawPairs: any[] = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
    const pairs: Array<{ cycleDay: number; shiftTypeId: string }> = [];
    for (const a of rawPairs) {
      const day = Number(a?.cycleDay);
      if (!a?.shiftTypeId || !Number.isInteger(day) || day < 1 || day > cd) continue;
      pairs.push({ cycleDay: day, shiftTypeId: String(a.shiftTypeId) });
    }
    if (!pairs.length) { res.status(400).json({ error: 'The new rotation needs at least one working day.' }); return; }
    const typeIds = [...new Set(pairs.map((p) => p.shiftTypeId))];
    const { rows: typeRows } = await query(
      'SELECT id FROM shift_types WHERE company_id = $1 AND id = ANY($2::uuid[])',
      [companyId, typeIds]
    );
    if (typeRows.length !== typeIds.length) { res.status(400).json({ error: 'One of those shift types no longer exists.' }); return; }
    const timeRe = /^([01]\d|2[0-3]):([0-5]\d)$/;
    const pattern: RotationPattern = {
      name: String(req.body?.name || '').trim() || rot.name,
      cycleDays: cd,
      startTime: req.body?.startTime && timeRe.test(req.body.startTime) ? req.body.startTime : null,
      endTime: req.body?.endTime && timeRe.test(req.body.endTime) ? req.body.endTime : null,
      notes: req.body?.notes ? String(req.body.notes).trim().slice(0, 500) : null,
      pairs,
    };
    const { rows: urows } = await query(
      'SELECT first_name AS "firstName", last_name AS "lastName", is_active AS "isActive" FROM users WHERE id = $1 AND company_id = $2',
      [userId, companyId]
    );
    if (!urows.length || !urows[0].isActive) { res.status(400).json({ error: 'That person is not an active team member.' }); return; }
    const personName = `${urows[0].firstName} ${urows[0].lastName}`.trim();
    // Department scope: ending the old rotation and starting the new
    // one must both sit inside the scheduler's active department.
    const scopeDepts = new Set<string>([
      ...(await rotationRelevantDepartments(rotId)),
      ...(await assignmentRelevantDepartments(pairs.map((p) => ({ userId, shiftTypeId: p.shiftTypeId })), companyId)),
    ]);
    if (!(await requireActiveDepartment(req, res, [...scopeDepts]))) return;

    const endDate = dayBefore(fromDate);
    const newRotationId = await withTransaction(async (tx) => {
      await tx.query('UPDATE rotations SET end_date = $1 WHERE id = $2 AND company_id = $3', [endDate, rotId, companyId]);
      return insertPatternRotation(tx, companyId, req.session.userId!, userId, pattern, fromDate);
    });
    await auditLog({
      companyId, date: todayStr(), action: 'updated', category: 'settings',
      source: 'manual', rotationName: rot.name,
      changedBy: req.session.userId!,
      description: `Changed ${personName}'s rotation from ${fromDate}: "${rot.name}" stops ${endDate}; "${pattern.name}" starts ${fromDate}`,
      details: { rotationId: rotId, newRotationId, kind: 'rotation', changeFromDate: fromDate },
    });
    res.json({ ok: true, endedRotationId: rotId, newRotationId, endDate, startDate: fromDate });
  } catch (err) {
    console.error('[schedule] change rotation from date failed:', err);
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

/** The vacation (rotation pause) covering this person on this date, or null. */
export async function vacationOn(companyId: string, userId: string, date: string): Promise<any | null> {
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
  return rows[0] || null;
}

// GET /api/schedule/vacation-check?userId=xxx&date=YYYY-MM-DD — is this person on vacation that date?
// Owners/schedulers may check anyone; anyone may check THEMSELVES (the
// pickup flows warn the claimer about their own vacation dates).
router.get('/vacation-check', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const userId = String(req.query.userId || '');
    const date = String(req.query.date || '');
    if (!userId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'userId and date are required.' });
      return;
    }
    const role = req.session.role!;
    if (role !== 'owner' && role !== 'scheduler' && userId !== req.session.userId) {
      res.status(403).json({ error: 'You can only check your own vacation dates.' });
      return;
    }
    const vacation = await vacationOn(companyId, userId, date);
    res.json({ onVacation: !!vacation, vacation });
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
  schedule_size: '100',    // 100 | 80 | 70 — schedule grid scale (Deepika 2026-11-02)
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
    if (body.schedule_size && !['100', '80', '70'].includes(String(body.schedule_size)))
      { res.status(400).json({ error: 'Invalid schedule size.' }); return; }
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
// Employee Link — schedule sharing (sign-in required since 2026-11-04)
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
      const { rows: srows } = await query('SELECT id, name FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true', [shiftTypeId, companyId]);
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

// The published-schedule payload behind a share link: only published shifts
// (per-shift state; the date itself does not need to be published —
// departments publish on their own cadence), optionally scoped to the link's
// department and/or shift type.
async function shareSchedulePayload(companyId: string, deptId: string | null, shiftTypeId: string | null, from: string, to: string) {
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
    return {
      companyName: comp.length ? comp[0].name : '',
      shifts,
      shiftTypes: types,
    };
}

// GET /api/schedule/public — RETIRED as an unauthenticated endpoint
// (2026-11-04, Deepika: every link should be signed in, so the app knows who
// is clicking). Share links now resolve through /share/mine below; this
// route stays only so stale pages get a clear answer instead of data.
router.get('/public', async (_req: Request, res: Response) => {
  res.status(401).json({ error: 'This schedule is for team members only — please sign in to view it.' });
});

// GET /api/schedule/share/mine?token&from&to — the share-link schedule for a
// SIGNED-IN viewer. The token identifies the link (and its company + scope);
// the session identifies the person. Only members of the link's own company
// can open it.
router.get('/share/mine', async (req: Request, res: Response) => {
  try {
    if (!req.session.userId || !req.session.companyId) {
      res.status(401).json({ error: 'Please sign in to view this schedule.' });
      return;
    }
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
    if (shares[0].company_id !== req.session.companyId) {
      res.status(403).json({ error: 'This link belongs to a different company than your account.' });
      return;
    }
    const payload = await shareSchedulePayload(shares[0].company_id, shares[0].department_id, shares[0].shift_type_id, from, to);
    const { rows: me } = await query('SELECT first_name, last_name FROM users WHERE id = $1', [req.session.userId]);
    const viewerName = me.length ? `${me[0].first_name} ${me[0].last_name}`.trim() : '';
    res.json({ ...payload, viewer: { name: viewerName } });
  } catch (err) {
    console.error('[schedule] share mine failed:', err);
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
      let heldRequestId: string | null = null;
      try {
        await withTransaction(async (tx) => {
          const tookSlot = await consumeExtraOpenSlot(tx.query, companyId, date, shiftTypeId);
          if (!tookSlot) {
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
          heldRequestId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO shift_requests (id, company_id, request_type, shift_id, requester_id, target_user_id, status)
             VALUES ($1, $2, 'open_pickup', $3, $4, NULL, 'pending')`,
            [heldRequestId, companyId, shiftId, userId]);
          held = true;
        });
      } catch (txErr) {
        console.error('[schedule] pickup request tx failed:', txErr);
      }
      if (held) requested.push({ date, shiftTypeId, requestId: heldRequestId });
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
      // Approver Approve/Reject emails, one per held request (2026-11-03).
      for (const rq of requested) {
        if (rq.requestId) sendShiftRequestApproverEmails(companyId, rq.requestId).catch(() => {});
      }
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
    // Groups (unified store, migration 096): the member's chat
    // groups + the member's system groups. groupKind tells the UI
    // which is which — system groups are labelled "System" and are
    // managed from the Groups panel, not from here.
    const { rows: groups } = await query(
      `SELECT g.id, g.name, g.kind FROM message_groups g
       JOIN message_group_members m ON m.group_id = g.id
       WHERE g.company_id = $1 AND m.user_id = $2 ORDER BY g.name`,
      [companyId, me]);
    for (const g of groups) {
      channels.push({ key: 'group:' + g.id, name: g.name, kind: 'group', groupKind: g.kind,
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
// GET /api/schedule/messages/members — everyone in the company
// channel (Deepika 2026-11-01): the thread header's ⓘ shows exactly
// who an "Everyone" message goes to.
router.get('/messages/members', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const { rows } = await query(
      `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
       FROM users WHERE company_id = $1 AND is_active = true ORDER BY first_name, last_name`,
      [companyId]);
    res.json({ members: rows.filter((r: any) => r.name).map((r: any) => ({ id: r.id, name: r.name, me: r.id === me })) });
  } catch (err: any) {
    console.error('[messages] members list failed:', err);
    res.status(500).json({ error: 'Could not load the member list.' });
  }
});

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

// POST /api/schedule/messages/groups — create a group from Messages.
// WHO creates it decides the kind (Deepika, 2026-11-07, closing the
// gap she hit live: "I created new group in messages but it did not
// get added to communication groups"):
//   owner/scheduler -> kind='system': it IS a Communication group —
//     it appears in the Tools-bar panel + the event Attendees picker
//     as well as here, under the system rules (name unique within
//     the system kind; membership managed from the panel side).
//   employee -> kind='chat': a Messages-only group, exactly as
//     Messages groups always were; it appears nowhere else.
// Body: { name, memberIds?: string[], departmentIds?: string[] }
// Department ids expand to all active members of those departments.
router.post('/messages/groups', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const kind = (role === 'owner' || role === 'scheduler') ? 'system' : 'chat';
    const { name, memberIds, departmentIds } = req.body ?? {};
    let gname = String(name || '').trim().slice(0, 80);
    if (!gname) { res.status(400).json({ error: 'Give the group a name.' }); return; }
    if (kind === 'system') {
      // Same normalisation + duplicate rule as the panel door
      // (POST /comm-groups): system names are unique per company.
      gname = gname.replace(/\s+/g, ' ');
      const { rows: dupe } = await query(
        "SELECT id FROM message_groups WHERE company_id = $1 AND kind = 'system' AND lower(name) = lower($2)",
        [companyId, gname]);
      if (dupe.length) { res.status(400).json({ error: 'A group with that name already exists.' }); return; }
    }
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
        'INSERT INTO message_groups (id, company_id, name, created_by, kind) VALUES ($1, $2, $3, $4, $5)',
        [groupId, companyId, gname, me, kind]);
      for (const uid of memberSet) {
        await tx.query(
          'INSERT INTO message_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [groupId, uid]);
      }
    });
    res.status(201).json({ id: groupId, name: gname, kind });
  } catch (err: any) {
    // The partial unique index on system names is the only unique
    // constraint this insert can hit (fresh UUID pk; members use
    // ON CONFLICT) — a lost race gets the panel door's clean refusal.
    if (err?.code === '23505') {
      res.status(400).json({ error: 'A group with that name already exists.' }); return;
    }
    console.error('[schedule] create group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/messages/groups/:id — CHAT groups only:
// creator, scheduler, or owner. System groups are managed (and
// deleted) from the Groups panel instead — refused here for every
// role so the two doors can't disagree about a system group.
router.delete('/messages/groups/:id', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const role = req.session.role!;
    const { rows } = await query(
      'SELECT id, created_by AS "createdBy", kind FROM message_groups WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Group not found.' }); return; }
    if (rows[0].kind === 'system') {
      res.status(403).json({ error: 'System groups are managed from the Groups panel.' }); return;
    }
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
    res.status(201).json({ id: rows[0].id, link: `${base}/my-availability.html?kind=shift&t=${token}` });
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

// ---------------------------------------------------------------------
// Gap offers (Deepika 2026-11-04, migration 079): from a Short cover
// gap, a scheduler offers the shift to staff who marked themselves
// available on the availability link. Candidates are computed from the
// DECLARED responses (never from silence), minus people already
// working that day and people whose job role doesn't fit. Each
// recipient gets a bell + an email with a personal login-free link;
// the link's page button claims the shift (first pickup wins), under
// the same eligibility + conflict guards as an open-slot claim.
// Consume one manually-added extra open slot without ever writing count = 0:
// migration 020's CHECK (count <> 0) kills a plain decrement 1 → 0 before any
// delete-at-zero cleanup can run (found 2026-11-06 — last-slot claims 500'd on
// every claim path). One atomic statement instead: decrement when count > 1,
// delete the row when count = 1. Returns true when a slot was consumed.
async function consumeExtraOpenSlot(q: any, companyId: string, date: string, shiftTypeId: string): Promise<boolean> {
  const { rows } = await q(
    `WITH dec AS (
       UPDATE extra_open_slots SET count = count - 1
        WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count > 1
        RETURNING 1 AS taken
     ), del AS (
       DELETE FROM extra_open_slots
        WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND count = 1
          AND NOT EXISTS (SELECT 1 FROM dec)
        RETURNING 1 AS taken
     )
     SELECT taken FROM dec UNION ALL SELECT taken FROM del`,
    [companyId, date, shiftTypeId]
  );
  return rows.length > 0;
}

async function gapCounts(q: any, companyId: string, date: string, shiftTypeId: string) {
  const shifts = await getShiftsForRange(q, companyId, date, date);
  const have = shifts.filter((s: any) => s.shiftTypeId === shiftTypeId).length;
  const { rows: trows } = await q(
    `SELECT target_count AS "targetCount", weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
     FROM staffing_targets WHERE company_id = $1 AND shift_type_id = $2`,
    [companyId, shiftTypeId]
  );
  let target = 0;
  if (trows.length) {
    const t = trows[0];
    const dow = new Date(date + 'T12:00:00').getDay();
    const wds: number[] = Array.isArray(t.weekdays) ? t.weekdays : [0, 1, 2, 3, 4, 5, 6];
    if (wds.includes(dow) && (!t.startDate || date >= t.startDate) && (!t.endDate || date <= t.endDate)) {
      target = Number(t.targetCount) || 0;
    }
  }
  const { rows: erows } = await q(
    'SELECT COALESCE(SUM(count), 0) AS n FROM extra_open_slots WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const { rows: crows } = await q(
    'SELECT 1 FROM closed_shifts WHERE company_id = $1 AND date = $2 AND shift_type_id = $3',
    [companyId, date, shiftTypeId]
  );
  const need = target + Number(erows[0]?.n || 0);
  return { have, need, short: Math.max(0, need - have), closed: crows.length > 0 };
}

async function openOfferFor(q: any, companyId: string, date: string, shiftTypeId: string) {
  const { rows } = await q(
    `SELECT id, needed, created_by AS "createdBy" FROM gap_offers
     WHERE company_id = $1 AND date = $2 AND shift_type_id = $3 AND status = 'open'
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, date, shiftTypeId]
  );
  return rows.length ? rows[0] : null;
}

async function offerRecipients(q: any, offerId: string) {
  const { rows } = await q(
    `SELECT r.user_id AS "userId", r.claimed_shift_id AS "claimedShiftId",
            (u.first_name || ' ' || u.last_name) AS name, u.nickname
     FROM gap_offer_recipients r JOIN users u ON u.id = r.user_id
     WHERE r.offer_id = $1 ORDER BY r.created_at`,
    [offerId]
  );
  return rows.map((r: any) => ({ userId: r.userId, name: r.nickname || r.name, claimed: !!r.claimedShiftId }));
}

function gapNormName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function gapNameKeys(u: any): string[] {
  const keys = new Set<string>();
  const add = (s: string) => {
    const k = gapNormName(s);
    if (k) { keys.add(k); keys.add(k.split(' ').sort().join(' ')); }
  };
  add(`${u.firstName || ''} ${u.lastName || ''}`);
  if (u.nickname) { add(u.nickname); if (u.lastName) add(`${u.nickname} ${u.lastName}`); }
  return [...keys];
}
function gapPrevDate(date: string): string {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Who can be offered this gap, in two audiences (Deepika 2026-11-04):
// (1) AVAILABLE — said available on the link (latest answer per name);
// (2) ROLE — everyone else with the same job role (they fit the shift
// type's eligible roles but didn't mark themselves available: no
// answer, or said unavailable — flagged, never pre-ticked). Both
// audiences exclude people already working that day and people whose
// role doesn't fit. Conflicted people stay listed with the reason so
// the scheduler sees the whole picture.
async function gapAudiences(companyId: string, date: string, shiftTypeId: string, type: any) {
  const { rows: resp } = await query(
    `SELECT r.name, r.available, r.user_id AS "userId" FROM availability_responses r
     JOIN availability_requests ar ON ar.id = r.request_id
     WHERE ar.company_id = $1 AND r.date = $2 ORDER BY ar.created_at DESC`,
    [companyId, date]
  );
  const said = new Map<string, boolean>();
  const saidById = new Map<string, boolean>();
  for (const r of resp) {
    const k = gapNormName(r.name);
    if (!said.has(k)) said.set(k, !!r.available);
    if (r.userId && !saidById.has(r.userId)) saidById.set(r.userId, !!r.available);
  }
  const { rows: users } = await query(
    `SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName", u.nickname, jr.name AS "jobRoleName"
     FROM users u LEFT JOIN job_roles jr ON jr.id = u.job_role_id
     WHERE u.company_id = $1 AND u.is_active = true ORDER BY u.first_name, u.last_name`,
    [companyId]
  );
  const shifts = await getShiftsForRange(query as any, companyId, gapPrevDate(date), date);
  const working = new Set(shifts.filter((s: any) => s.date === date).map((s: any) => s.userId));
  const prevNight = new Map<string, string>();
  shifts.filter((s: any) => s.date === gapPrevDate(date)).forEach((s: any) => {
    if (/night/i.test(s.shiftTypeName)) prevNight.set(s.userId, s.shiftTypeName);
  });
  const available: any[] = [];
  const role: any[] = [];
  for (const u of users) {
    if (working.has(u.id)) continue;
    // Account-keyed answers (login page) win over typed-name ones.
    const ans = saidById.has(u.id) ? saidById.get(u.id)
      : gapNameKeys(u).map((k) => said.get(k)).find((v) => v !== undefined);
    const elig = await checkShiftEligibility(companyId, u.id, type.eligible_job_role_ids);
    if (!elig.ok) continue;
    const conflict = await checkShiftConflict(query as any, companyId, {
      userId: u.id, personName: 'You',
      proposed: { date, shiftTypeId, shiftTypeName: type.name },
      exclude: [{ date, shiftTypeId }],
    });
    const entry = {
      userId: u.id,
      name: u.nickname || `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      jobRoleName: u.jobRoleName || '',
      workedLastNight: prevNight.get(u.id) || null,
      conflict: conflict || null,
      saidUnavailable: ans === false,
    };
    if (ans === true) available.push(entry);
    else role.push(entry);
  }
  return { available, role };
}

// GET /api/schedule/gap-offers/candidates?date=&shiftTypeId=
router.get('/gap-offers/candidates', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    const shiftTypeId = String(req.query.shiftTypeId || '');
    if (!isValidDate(date) || !shiftTypeId) {
      res.status(400).json({ error: 'A valid date and shift type are required.' });
      return;
    }
    const { rows: trows } = await query(
      'SELECT id, name, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    const counts = await gapCounts(query as any, companyId, date, shiftTypeId);
    const offer = await openOfferFor(query as any, companyId, date, shiftTypeId);
    const offered = offer ? await offerRecipients(query as any, offer.id) : [];
    const offeredIds = new Set(offered.map((o: any) => o.userId));
    const audiences = await gapAudiences(companyId, date, shiftTypeId, trows[0]);
    res.json({
      date, shiftTypeId, shiftTypeName: trows[0].name,
      have: counts.have, need: counts.need, short: counts.short, closed: counts.closed,
      offer: offer ? { id: offer.id, needed: offer.needed, recipients: offered } : null,
      candidates: audiences.available.filter((p: any) => !offeredIds.has(p.userId)),
      roleCandidates: audiences.role.filter((p: any) => !offeredIds.has(p.userId)),
    });
  } catch (err) {
    console.error('[schedule] gap candidates failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/gap-offers?from=&to= — offers in a range, for the
// Short cover page annotations.
router.get('/gap-offers', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!isValidDate(from) || !isValidDate(to)) {
      res.status(400).json({ error: 'A valid from/to range is required.' });
      return;
    }
    const { rows } = await query(
      `SELECT o.id, o.date::text AS date, o.shift_type_id AS "shiftTypeId", o.needed,
              o.status, st.name AS "shiftTypeName"
       FROM gap_offers o JOIN shift_types st ON st.id = o.shift_type_id
       WHERE o.company_id = $1 AND o.date >= $2 AND o.date <= $3 ORDER BY o.date, o.created_at`,
      [companyId, from, to]
    );
    const offers: any[] = [];
    for (const o of rows) {
      offers.push({ ...o, recipients: await offerRecipients(query as any, o.id) });
    }
    res.json({ offers });
  } catch (err) {
    console.error('[schedule] gap offers list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/gap-offers — create (or extend) the open offer
// for a gap and notify the chosen people.
router.post('/gap-offers', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const { date, shiftTypeId, userIds } = req.body ?? {};
    if (!isValidDate(date) || typeof shiftTypeId !== 'string' || !shiftTypeId || !Array.isArray(userIds) || !userIds.length) {
      res.status(400).json({ error: 'A date, a shift type and at least one person are required.' });
      return;
    }
    const { rows: trows } = await query(
      'SELECT id, name, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [shiftTypeId, companyId]
    );
    if (!trows.length) { res.status(404).json({ error: 'Shift type not found.' }); return; }
    const counts = await gapCounts(query as any, companyId, date, shiftTypeId);
    if (counts.closed) { res.status(400).json({ error: 'That day is closed for this shift type.' }); return; }
    if (counts.short <= 0) { res.status(400).json({ error: 'That gap is already filled.' }); return; }
    let offer = await openOfferFor(query as any, companyId, date, shiftTypeId);
    if (!offer) {
      const { rows: orows } = await query(
        `INSERT INTO gap_offers (company_id, date, shift_type_id, needed, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, needed`,
        [companyId, date, shiftTypeId, counts.short, me]
      );
      offer = orows[0];
    }
    // Only real audience members can be offered — recompute and
    // intersect (either audience: marked-available or same job role).
    const audiences = await gapAudiences(companyId, date, shiftTypeId, trows[0]);
    const candById = new Map([...audiences.available, ...audiences.role].map((c: any) => [c.userId, c]));
    const sent: Array<{ userId: string; token: string }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const uid of [...new Set(userIds.map(String))]) {
      const cand = candById.get(uid);
      if (!cand) { skipped.push({ name: uid, reason: 'No longer available for this gap' }); continue; }
      if (cand.conflict) { skipped.push({ name: cand.name, reason: cand.conflict }); continue; }
      const token = crypto.randomBytes(24).toString('hex');
      const { rows: ins } = await query(
        `INSERT INTO gap_offer_recipients (offer_id, company_id, user_id, token)
         VALUES ($1, $2, $3, $4) ON CONFLICT (offer_id, user_id) DO NOTHING RETURNING id`,
        [offer.id, companyId, uid, token]
      );
      if (ins.length) sent.push({ userId: uid, token });
      else skipped.push({ name: cand.name, reason: 'Already offered' });
    }
    if (sent.length) {
      sendGapOfferNotifications(companyId, { id: offer.id, date, shiftTypeName: trows[0].name }, sent).catch(() => {});
    }
    res.json({ ok: true, offerId: offer.id, sent: sent.length, skipped });
  } catch (err) {
    console.error('[schedule] gap offer create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function loadGapOfferContext(token: string) {
  const { rows } = await query(
    `SELECT r.id AS "recipientId", r.user_id AS "userId", r.claimed_shift_id AS "claimedShiftId",
            o.id AS "offerId", o.company_id AS "companyId", o.date::text AS date,
            o.shift_type_id AS "shiftTypeId", o.status AS "offerStatus", o.created_by AS "createdBy",
            st.name AS "shiftTypeName",
            (u.first_name || ' ' || u.last_name) AS "userName", u.nickname AS "userNickname"
     FROM gap_offer_recipients r
     JOIN gap_offers o ON o.id = r.offer_id
     JOIN shift_types st ON st.id = o.shift_type_id
     JOIN users u ON u.id = r.user_id
     WHERE r.token = $1`,
    [token]
  );
  return rows.length ? rows[0] : null;
}

// GET /api/schedule/gap-offers/act/:token — login-free confirmation page.
router.get('/gap-offers/act/:token', async (req: Request, res: Response) => {
  try {
    const ctx = await loadGapOfferContext(String(req.params.token));
    if (!ctx) {
      res.status(404).send(actPage('Link not valid', '<p>This link is not valid. If you got it in an email, the offer may have been withdrawn.</p>'));
      return;
    }
    const dateLong = fmtDateLong(ctx.date);
    if (ctx.claimedShiftId) {
      res.send(actPage('You picked up this shift', '<p>You picked up the <strong>' + escHtml(ctx.shiftTypeName) + '</strong> shift on <strong>' + escHtml(dateLong) + '</strong>. It\u2019s on your schedule.</p>'));
      return;
    }
    if (ctx.date < todayStr()) {
      res.send(actPage('This offer has passed', '<p>The shift date has passed, so this offer is closed.</p>'));
      return;
    }
    const counts = await gapCounts(query as any, ctx.companyId, ctx.date, ctx.shiftTypeId);
    if (ctx.offerStatus !== 'open' || counts.have >= counts.need) {
      res.send(actPage('Filled — thank you', '<p>This gap has been covered. Thanks for checking.</p>'));
      return;
    }
    const vac = await vacationOn(ctx.companyId, ctx.userId, ctx.date);
    const body = (vac ? '<p style="background:#fdf3e3;border:1px solid #ecc97e;border-radius:8px;padding:10px 12px"><strong>⚠️ You are on vacation</strong> on ' + escHtml(dateLong) + (vac.reason ? ' (' + escHtml(vac.reason) + ')' : '') + '. You can still pick it up if you want to work that day.</p>' : '') +
      '<p>A <strong>' + escHtml(ctx.shiftTypeName) + '</strong> shift on <strong>' + escHtml(dateLong) + '</strong> is short of cover.</p>' +
      '<p>If you pick it up, the shift is yours. First to pick it up gets it.</p>';
    res.send(actPage('Short cover needed', body + '<form method="POST" action="">' + actButton('claim', '✋ Pick up this shift', '#0e7c86') + '</form><p style="color:#666;font-size:13px">You can also answer in the app.</p>'));
  } catch (err) {
    console.error('[schedule] gap offer page failed:', err);
    res.status(500).send(actPage('Something went wrong', '<p>Please try again, or answer in the app.</p>'));
  }
});

// POST /api/schedule/gap-offers/act/:token — the button claims.
router.post('/gap-offers/act/:token', urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const ctx = await loadGapOfferContext(String(req.params.token));
    if (!ctx) {
      res.status(404).send(actPage('Link not valid', '<p>This link is not valid.</p>'));
      return;
    }
    const dateLong = fmtDateLong(ctx.date);
    if (String((req.body && req.body.action) || '') !== 'claim') {
      res.redirect(req.originalUrl);
      return;
    }
    if (ctx.claimedShiftId) {
      res.send(actPage('You picked up this shift', '<p>You already picked up the <strong>' + escHtml(ctx.shiftTypeName) + '</strong> shift on <strong>' + escHtml(dateLong) + '</strong>.</p>'));
      return;
    }
    if (ctx.date < todayStr()) {
      res.send(actPage('This offer has passed', '<p>The shift date has passed, so this offer is closed.</p>'));
      return;
    }
    const { rows: trows } = await query(
      'SELECT eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
      [ctx.shiftTypeId, ctx.companyId]
    );
    if (!trows.length) {
      res.send(actPage('No longer available', '<p>This shift type is no longer active.</p>'));
      return;
    }
    const elig = await checkShiftEligibility(ctx.companyId, ctx.userId, trows[0].eligible_job_role_ids);
    if (!elig.ok) {
      res.send(actPage('Not eligible', '<p>' + escHtml(elig.error || 'Your role doesn\u2019t fit this shift.') + '</p>'));
      return;
    }
    let outcome = 'error';
    let conflictMsg: string | null = null;
    await withTransaction(async (tx) => {
      const { rows: orows } = await tx.query('SELECT id, status FROM gap_offers WHERE id = $1 FOR UPDATE', [ctx.offerId]);
      if (!orows.length || orows[0].status !== 'open') { outcome = 'filled'; return; }
      const counts = await gapCounts(tx.query, ctx.companyId, ctx.date, ctx.shiftTypeId);
      if (counts.closed || counts.have >= counts.need) {
        await tx.query("UPDATE gap_offers SET status = 'filled' WHERE id = $1", [ctx.offerId]);
        outcome = 'filled';
        return;
      }
      const conflict = await checkShiftConflict(tx.query, ctx.companyId, {
        userId: ctx.userId, personName: 'You',
        proposed: { date: ctx.date, shiftTypeId: ctx.shiftTypeId, shiftTypeName: ctx.shiftTypeName },
        exclude: [{ date: ctx.date, shiftTypeId: ctx.shiftTypeId }],
      });
      if (conflict) { conflictMsg = conflict; outcome = 'conflict'; return; }
      // Consume a manually-added extra slot first (mirrors open-slot claim).
      await consumeExtraOpenSlot(tx.query, ctx.companyId, ctx.date, ctx.shiftTypeId);
      const shiftId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
         VALUES ($1, $2, $3, $4, $5, true, $3)`,
        [shiftId, ctx.companyId, ctx.userId, ctx.shiftTypeId, ctx.date]
      );
      await tx.query('UPDATE gap_offer_recipients SET claimed_shift_id = $1 WHERE id = $2', [shiftId, ctx.recipientId]);
      const after = await gapCounts(tx.query, ctx.companyId, ctx.date, ctx.shiftTypeId);
      if (after.have >= after.need) {
        await tx.query("UPDATE gap_offers SET status = 'filled' WHERE id = $1", [ctx.offerId]);
      }
      outcome = 'claimed';
    });
    if (outcome === 'claimed') {
      // Tell the schedulers the gap moved (news for them, not the claimer).
      try {
        const depts = await assignmentRelevantDepartments([{ userId: ctx.userId, shiftTypeId: ctx.shiftTypeId }], ctx.companyId);
        const ids = new Set<string>();
        if (depts.length) {
          for (const d of depts) for (const id of await deptApproverIds(ctx.companyId, d)) ids.add(id);
        } else {
          for (const id of await deptApproverIds(ctx.companyId, null)) ids.add(id);
        }
        if (ctx.createdBy) ids.add(ctx.createdBy);
        ids.delete(ctx.userId);
        const still = await gapCounts(query as any, ctx.companyId, ctx.date, ctx.shiftTypeId);
        const claimer = ctx.userNickname || ctx.userName || 'A team member';
        await notify({
          companyId: ctx.companyId, userIds: [...ids], category: 'schedule', type: 'gap_offer_filled',
          title: `${claimer} picked up ${ctx.shiftTypeName} on ${dateLong}`,
          body: still.short > 0 ? `That gap is still ${still.short} short.` : 'That gap is now fully covered.',
          link: 'shortcover', payload: { offerId: ctx.offerId },
        });
      } catch (e) { console.error('[schedule] gap filled notify failed:', e); }
      res.send(actPage('It\u2019s yours', '<p>You picked up the <strong>' + escHtml(ctx.shiftTypeName) + '</strong> shift on <strong>' + escHtml(dateLong) + '</strong>. It\u2019s on your schedule now.</p>'));
      return;
    }
    if (outcome === 'filled') {
      res.send(actPage('Filled — thank you', '<p>A teammate picked this up first, so the gap is covered. Thanks for checking.</p>'));
      return;
    }
    if (outcome === 'conflict') {
      res.send(actPage('That no longer works', '<p>' + escHtml(conflictMsg || 'This shift now clashes with your schedule.') + '</p>'));
      return;
    }
    res.status(500).send(actPage('Something went wrong', '<p>Please try again, or answer in the app.</p>'));
  } catch (err) {
    console.error('[schedule] gap offer claim failed:', err);
    res.status(500).send(actPage('Something went wrong', '<p>Please try again, or answer in the app.</p>'));
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
// Query: ?date=YYYY-MM-DD (single date) or ?from=YYYY-MM-DD&to=YYYY-MM-DD (range).
// Calendar separation (Deepika, 2026-11-07): ?category=calendar returns
// ONLY calendar-event entries (the Calendar report); without it, the
// original Run report returns schedule + settings and never calendar.
router.get('/audit', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    const wantCalendar = String(req.query.category || '') === 'calendar';
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
    where += wantCalendar ? ` AND a.category = 'calendar'` : ` AND COALESCE(a.category, 'schedule') <> 'calendar'`;
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
      `SELECT id, first_name AS "firstName", last_name AS "lastName", nickname,
              email, phone, department_id AS "departmentId"
       FROM users WHERE company_id = $1 AND is_active = true`,
      [companyId]
    );
    const { rows: tzRows } = await query(
      `SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`,
      [companyId]);
    const companyTimezone = tzRows[0]?.value || 'America/Chicago';
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
      timezone: companyTimezone,
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
    'SELECT name FROM dashboards WHERE company_id = $1 AND archived_at IS NULL ORDER BY name LIMIT 20',
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
  } else if (p.includes('end date')) {
    question = 'Until when should this repeat?';
    options = ['6 months', '1 year'];
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

// ---------------------------------------------------------------------------
// Shared Task-planner helpers — used by /agent-plan and the unified /ask-task
// endpoint, so both surfaces classify, validate and insert plans identically.
// ---------------------------------------------------------------------------

// Task thread: earlier user messages + agent clarification questions, so
// follow-up answers refine the original task instead of replacing it.
function parseTaskHistory(body: any): Array<{ q: string; a: string }> {
  return Array.isArray(body?.history) ? body.history.slice(-10).map((h: any) => ({
    q: String(h.q || '').slice(0, 500),
    a: String(h.a || '').slice(0, 2000),
  })).filter((h: any) => h.q) : [];
}

// Build a plan from a plain-language task: roster context + Gemini, with one
// retry when Gemini's answer is unparseable (a fresh attempt usually parses).
async function runTaskPlan(companyId: string, task: string, history: Array<{ q: string; a: string }>) {
  const { planFromEmail } = await import('../util/gemini.js');
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
  const { getShiftTypeRules } = await import('../util/planExecutor.js');
  const ctx: any = {
    shiftTypes: stRows.map((r: any) => r.name),
    shiftTypeRules: await getShiftTypeRules(companyId),
    members: uRows.map((r: any) => r.name),
    today,
    history,
    ...sessionCtx,
  };
  let plan: any;
  try {
    plan = await planFromEmail(task, 'In-app agent task', ctx);
  } catch (e: any) {
    if (/valid JSON/i.test(e?.message || '')) {
      plan = await planFromEmail(task, 'In-app agent task', ctx); // one retry
    } else throw e;
  }
  // Attach department names for settings actions.
  (plan as any).departments = dRows.map((r: any) => r.name);
  return { plan, memberNames: uRows.map((r: any) => r.name), shiftNames: stRows.map((r: any) => r.name) };
}

// Validate a parsed plan (names, then completeness) and insert it as pending,
// or return the clarification that unblocks it. Every blocking problem is
// gathered first: one problem keeps today's targeted question + tappable
// options, several become ONE question listing everything needed, so the
// user answers once instead of one question per detail.
async function finalizeTaskPlan(companyId: string, plan: any, task: string, memberNames: string[], shiftNames: string[]) {
  const { collectNameProblems, decideClarification } = await import('../util/askRouting.js');
  const nameProblems = collectNameProblems(plan, memberNames, shiftNames);
  const { changeProblems } = await import('../util/emailPoller.js');
  const incomplete = (plan.changes || [])
    .map((c: any, i: number) => ({ i, problems: changeProblems(c) }))
    .filter((x: any) => x.problems.length > 0);
  const problems: Array<{ text: string; options: string[] }> = [...nameProblems];
  for (const entry of incomplete) {
    for (const prob of entry.problems) {
      const built = await buildClarification(plan.changes[entry.i], prob, companyId, query);
      problems.push({ text: built.question, options: built.options });
    }
  }
  if ((plan as any).needsClarification) {
    problems.push({ text: (plan as any).needsClarification, options: [] });
  }
  if (!plan.changes?.length || problems.length) {
    if (!problems.length) {
      return { type: 'clarification' as const, question: 'I could not understand the task well enough to build a plan.', options: [] };
    }
    const d = decideClarification(problems);
    return { type: 'clarification' as const, question: d.question, options: d.options };
  }
  // Warn-and-override: flag every change that puts someone on a shift type
  // their job role is not eligible for. The warning rides on the change into
  // every preview; approving the plan overrides it (execution never blocks).
  const { validatePlanEligibility } = await import('../util/planExecutor.js');
  const warned = await validatePlanEligibility(companyId, plan.changes || []);
  if (warned > 0) {
    plan.summary = `⚠️ Job-role warning: ${warned} change${warned === 1 ? '' : 's'} ${warned === 1 ? 'assigns' : 'assign'} someone outside the allowed roles — approving overrides the rule. ` + (plan.summary || '');
  }
  // Schedule-conflict flags (Deepika 2026-11-01): swaps that would
  // double-book someone or leave them under 8 hours of rest are
  // flagged here and skipped at execution with the reason reported.
  const { validatePlanConflicts } = await import('../util/planExecutor.js');
  const conflicted = await validatePlanConflicts(companyId, plan.changes || []);
  if (conflicted > 0) {
    plan.summary = `⛔ Schedule conflict: ${conflicted} swap${conflicted === 1 ? '' : 's'} can't happen as written (overlap or too little rest) — if approved, the conflicting swap${conflicted === 1 ? '' : 's'} will be skipped and reported with the reason. ` + (plan.summary || '');
  }
  const { rows } = await query(
    `INSERT INTO schedule_plans
     (company_id, source_subject, source_body, plan_summary, plan, status, created_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', NOW()) RETURNING id`,
    [companyId, 'In-app agent task', task, plan.summary, JSON.stringify(plan)]
  );
  return { type: 'plan' as const, planId: rows[0].id, summary: plan.summary, changes: plan.changes };
}

// Ask context for /ask-task (same roster + department-visibility rules as
// /ask: owner all, scheduler view-access, employee own department only).
async function buildAskContext(req: Request) {
  const companyId = req.session.companyId!;
  const { rows: stRows } = await query(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  const { rows: uRows } = await query(
    `SELECT id, first_name AS "firstName", last_name AS "lastName", nickname,
            email, phone, department_id AS "departmentId"
     FROM users WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  const { rows: tzRows } = await query(
    `SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`,
    [companyId]);
  const companyTimezone = tzRows[0]?.value || 'America/Chicago';
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
  return {
    companyId,
    shiftTypes: stRows,
    members: uRows,
    userId: req.session.userId!,
    role: askerRole,
    visibleDeptIds,
    timezone: companyTimezone,
  };
}

router.post('/agent-plan', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const task = String(req.body?.task || '').slice(0, 1000);
    if (!task.trim()) { res.status(400).json({ error: 'Describe the task.' }); return; }
    const history = parseTaskHistory(req.body);
    let plan: any, memberNames: string[], shiftNames: string[];
    try {
      ({ plan, memberNames, shiftNames } = await runTaskPlan(companyId, task, history));
    } catch (planErr: any) {
      const { classifyPlanError } = await import('../util/planHelpers.js');
      console.error('[schedule] agent-plan failed:', planErr?.message, 'task:', task.slice(0, 200));
      res.json({ ok: false, error: classifyPlanError(planErr?.message || '') });
      return;
    }
    const fin = await finalizeTaskPlan(companyId, plan, task, memberNames, shiftNames);
    if (fin.type === 'clarification') {
      res.json({ ok: false, needsClarification: fin.question, clarificationOptions: fin.options, originalTask: task });
      return;
    }
    res.json({ ok: true, planId: fin.planId, summary: fin.summary, changes: fin.changes });
  } catch (err) {
    console.error('[schedule] agent-plan failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/ask-task — the Q-Scheduler bar. With an explicit
// mode ("ask" | "task", sent by the bar's Ask | Task toggle) the sides
// are fully separate: Ask answers via the rule engine + AI data pack and
// never plans; Task plans via the planner and never answers. Without a
// mode, the original unified routing applies: questions are answered,
// anything else becomes a plan (admins) or a pointer to Requests
// (employees).
router.post('/ask-task', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const message = String(req.body?.message || req.body?.task || req.body?.question || '').slice(0, 1000);
    if (!message.trim()) { res.status(400).json({ kind: 'error', error: 'Say something.' }); return; }
    const history = parseTaskHistory(req.body);
    // Ask | Task toggle (Deepika, 2026-11-08): when the bar sends an
    // explicit mode, the two sides are FULLY separate — no routing. Ask
    // runs the question engine ONLY (it never creates a plan); Task runs
    // the planner ONLY (it never answers a question). The one crossover
    // is a signpost line when text lands on the wrong side. Requests
    // with no mode (older clients) keep the unified routing below,
    // unchanged.
    const mode = req.body?.mode === 'ask' || req.body?.mode === 'task' ? req.body.mode : null;
    if (mode === 'ask') {
      const { routeAskTask, looksLikeBareInstruction, ASK_MODE_SIGNPOST } = await import('../util/askRouting.js');
      if (req.session.role === 'employee') {
        // Employees keep the standing guard: task-like text gets the
        // Requests pointer before any answering happens.
        if (routeAskTask(message, [], 'employee') === 'employee-pointer') {
          res.json({ kind: 'answer', answer: 'Only owners and schedulers can change the schedule. For a change, send a request from the Requests tab and an admin will approve it.' });
          return;
        }
      } else if (looksLikeBareInstruction(message)) {
        res.json({ kind: 'answer', answer: ASK_MODE_SIGNPOST });
        return;
      }
      const ctx = await buildAskContext(req);
      const { answerQuestionDetailed } = await import('../util/askEngine.js');
      const { answer } = await answerQuestionDetailed(message, ctx);
      res.json({ kind: 'answer', answer });
      return;
    }
    if (mode === 'task') {
      if (req.session.role === 'employee') {
        res.json({ kind: 'answer', answer: 'Only owners and schedulers can change the schedule. For a change, send a request from the Requests tab and an admin will approve it.' });
        return;
      }
      let plan: any, memberNames: string[], shiftNames: string[];
      try {
        ({ plan, memberNames, shiftNames } = await runTaskPlan(companyId, message, history));
      } catch (planErr: any) {
        const { classifyPlanError } = await import('../util/planHelpers.js');
        console.error('[schedule] ask-task (task mode) plan failed:', planErr?.message, 'task:', message.slice(0, 200));
        res.json({ kind: 'error', error: classifyPlanError(planErr?.message || '') });
        return;
      }
      if ((plan as any).emailType === 'schedule_question') {
        // The planner's "not an instruction" outcome: on the Task side a
        // pure question gets the flip-to-Ask signpost, not an answer.
        const { TASK_MODE_SIGNPOST } = await import('../util/askRouting.js');
        res.json({ kind: 'answer', answer: TASK_MODE_SIGNPOST });
        return;
      }
      const fin = await finalizeTaskPlan(companyId, plan, message, memberNames, shiftNames);
      if (fin.type === 'clarification') {
        res.json({ kind: 'clarification', question: fin.question, options: fin.options, originalTask: message });
        return;
      }
      res.json({ kind: 'plan', planId: fin.planId, summary: fin.summary, changes: fin.changes });
      return;
    }
    // Routing is decided from state + wording (see util/askRouting): a
    // follow-up inside an open clarification round goes straight to the
    // planner, plain sentences stating a staffing change count as tasks,
    // and employees get the Requests pointer before the question engine
    // runs. Questions go through the rule engine; anything the engine
    // can't answer falls through to the plan path below.
    const { routeAskTask } = await import('../util/askRouting.js');
    const route = routeAskTask(message, history, req.session.role!);
    if (route === 'employee-pointer') {
      res.json({ kind: 'answer', answer: 'Only owners and schedulers can change the schedule. For a change, send a request from the Requests tab and an admin will approve it.' });
      return;
    }
    let fallbackAnswer = '';
    if (route === 'question') {
      const ctx = await buildAskContext(req);
      const { answerQuestionDetailed } = await import('../util/askEngine.js');
      const { answer, fallback } = await answerQuestionDetailed(message, ctx);
      if (!fallback) { res.json({ kind: 'answer', answer }); return; }
      fallbackAnswer = answer;
    }
    // Not answerable as a question — treat it as a task (admins only).
    if (req.session.role === 'employee') {
      res.json({ kind: 'answer', answer: 'Only owners and schedulers can change the schedule. For a change, send a request from the Requests tab and an admin will approve it.' });
      return;
    }
    let plan: any, memberNames: string[], shiftNames: string[];
    try {
      ({ plan, memberNames, shiftNames } = await runTaskPlan(companyId, message, history));
    } catch (planErr: any) {
      const { classifyPlanError } = await import('../util/planHelpers.js');
      console.error('[schedule] ask-task plan failed:', planErr?.message, 'task:', message.slice(0, 200));
      res.json({ kind: 'error', error: classifyPlanError(planErr?.message || '') });
      return;
    }
    if ((plan as any).emailType === 'schedule_question') {
      res.json({ kind: 'answer', answer: fallbackAnswer || (plan as any).summary || 'I could not answer that question.' });
      return;
    }
    const fin = await finalizeTaskPlan(companyId, plan, message, memberNames, shiftNames);
    if (fin.type === 'clarification') {
      res.json({ kind: 'clarification', question: fin.question, options: fin.options, originalTask: message });
      return;
    }
    res.json({ kind: 'plan', planId: fin.planId, summary: fin.summary, changes: fin.changes });
  } catch (err) {
    console.error('[schedule] ask-task failed:', err);
    res.status(500).json({ kind: 'error', error: 'Something went wrong. Please try again.' });
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
              partner_name AS "partnerName", partner_status AS "partnerStatus",
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
    // Execute the changes (with the before/after snapshot that makes
    // the task undoable with Ctrl+Z — migration 073).
    const { executePlanWithUndo } = await import('../util/planUndo.js');
    try {
      const { results, undo } = await executePlanWithUndo(companyId, plan.plan, req.session.userId!);
      await query(
        `UPDATE schedule_plans SET status = 'executed', decided_at = now(),
         decided_by = $2, executed_at = now(), undo_payload = $3 WHERE id = $1`,
        [plan.id, req.session.userId!, undo ? JSON.stringify(undo) : null]
      );
      // Audit: record each applied change — shared with the email approve
      // path so no approved change is missing from the Change report.
      try {
        await auditPlanChanges(companyId, plan, results, req.session.userId!);
      } catch (auditErr) {
        console.error('[schedule] plan audit log failed:', (auditErr as any)?.message);
      }
      res.json({ ok: true, results, undoable: !!undo });
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

// --- Ctrl+Z for tasks (Deepika 2026-11-01) ---------------------------------
// Undoing a task replays the plan's stored before/after snapshot
// (util/planUndo.ts). Only the person who approved the task may undo
// it — the owner may undo anyone's. The undo refuses, changing
// nothing, when anything the task touched has changed since.
async function performPlanUndo(req: Request, res: Response, plan: any): Promise<boolean> {
  const companyId = req.session.companyId!;
  const userId = req.session.userId!;
  if (!plan.undo_payload || plan.undone_at || !['executed', 'approved', 'partial'].includes(plan.status)) {
    res.status(400).json({ error: 'This task can no longer be undone.' });
    return false;
  }
  if (req.session.role !== 'owner' && plan.decided_by !== userId) {
    res.status(403).json({ error: 'Only the person who approved this task can undo it — or the owner.' });
    return false;
  }
  const { undoPlanChanges } = await import('../util/planUndo.js');
  try {
    await undoPlanChanges(companyId, plan.undo_payload);
  } catch (e: any) {
    res.status(409).json({ error: e?.message || 'This task can’t be undone cleanly. Nothing was undone.' });
    return false;
  }
  // Remember the status the plan had, so a later redo restores it.
  plan.undo_payload = { ...plan.undo_payload, undoneFromStatus: plan.status };
  await query(
    `UPDATE schedule_plans SET status = 'undone', undone_at = now(), undone_by = $2, undo_payload = $3 WHERE id = $1`,
    [plan.id, userId, JSON.stringify(plan.undo_payload)]
  );
  // Change report + a heads-up for everyone whose shifts moved back.
  try {
    const entries: any[] = plan.undo_payload.entries || [];
    const shiftEntries = entries.filter((e: any) => e.table === 'shifts');
    const affected = new Set<string>();
    for (const e of entries) {
      for (const row of [e.before, e.after]) {
        if (!row) continue;
        if (e.table === 'shifts' && row.user_id) affected.add(row.user_id);
        if (e.table === 'academic_sessions') {
          if (row.lecturer_user_id) affected.add(row.lecturer_user_id);
          if (row.supervisor_user_id) affected.add(row.supervisor_user_id);
        }
      }
    }
    for (const e of shiftEntries) {
      const row = e.after || e.before;
      if (!row) continue;
      const names = await shiftDisplayNames(companyId, row.user_id, row.shift_type_id);
      await auditLog({
        companyId, date: String(row.date).slice(0, 10),
        action: !e.before ? 'deleted' : !e.after ? 'created' : 'updated',
        personName: names.personName, shiftTypeName: names.shiftTypeName,
        source: 'agent', changedBy: userId,
        details: { via: 'task-undo', planId: plan.id },
      });
    }
    if (!shiftEntries.length) {
      await auditLog({
        companyId, date: todayStr(), action: 'updated', category: 'settings',
        source: 'agent', changedBy: userId,
        description: `Undid task: ${plan.plan_summary || 'schedule task'}`,
        details: { via: 'task-undo', planId: plan.id },
      });
    }
    affected.delete(userId);
    if (affected.size) {
      notify({
        companyId, userIds: [...affected], category: 'schedule', type: 'shift_changed',
        title: 'A schedule task was undone',
        body: `The task "${plan.plan_summary || 'schedule change'}" was undone — your schedule is back to how it was before it.`,
        link: 'my-schedule', bundleKey: 'task_undone',
        bundleTitle: 'A schedule task was undone',
        excludeUserId: userId,
      });
    }
  } catch { /* audit/notify must never break the undo */ }
  return true;
}

// POST /api/schedule/plans/undo-latest — Ctrl+Z: undo the newest task
// this person approved (owner: the newest task anyone approved).
router.post('/plans/undo-latest', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const isOwner = req.session.role === 'owner';
    const { rows } = await query(
      `SELECT * FROM schedule_plans
       WHERE company_id = $1 AND undo_payload IS NOT NULL AND undone_at IS NULL
         AND status IN ('executed', 'approved', 'partial')
         AND ($2 OR decided_by = $3)
       ORDER BY COALESCE(executed_at, decided_at, created_at) DESC LIMIT 1`,
      [companyId, isOwner, req.session.userId!]
    );
    if (!rows.length) { res.status(404).json({ error: 'Nothing to undo.' }); return; }
    if (await performPlanUndo(req, res, rows[0])) {
      res.json({ ok: true, summary: rows[0].plan_summary });
    }
  } catch (err) {
    console.error('[schedule] undo-latest failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/plans/:id/undo — undo one specific executed task.
router.post('/plans/:id/undo', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT * FROM schedule_plans WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Plan not found.' }); return; }
    if (await performPlanUndo(req, res, rows[0])) {
      res.json({ ok: true, summary: rows[0].plan_summary });
    }
  } catch (err) {
    console.error('[schedule] undo plan failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// --- Redo: the opposite of undo (Deepika 2026-11-01) ------------------------
// Re-applies an undone task's AFTER state with the same changed-since
// protection. Only the person who undid it may redo it — the owner may
// redo anyone's. Ctrl+Shift+Z / Ctrl+Y uses redo-latest, which refuses
// when a newer task was approved after the undo (new work clears redo).
async function performPlanRedo(req: Request, res: Response, plan: any): Promise<boolean> {
  const companyId = req.session.companyId!;
  const userId = req.session.userId!;
  if (!plan.undo_payload || !plan.undone_at || plan.status !== 'undone') {
    res.status(400).json({ error: 'This task can no longer be redone.' });
    return false;
  }
  if (req.session.role !== 'owner' && plan.undone_by !== userId) {
    res.status(403).json({ error: 'Only the person who undid this task can redo it — or the owner.' });
    return false;
  }
  const { redoPlanChanges } = await import('../util/planUndo.js');
  try {
    await redoPlanChanges(companyId, plan.undo_payload);
  } catch (e: any) {
    res.status(409).json({ error: e?.message || 'This task can’t be redone cleanly. Nothing was changed.' });
    return false;
  }
  await query(
    `UPDATE schedule_plans SET status = $2, undone_at = NULL, undone_by = NULL WHERE id = $1`,
    [plan.id, plan.undo_payload.undoneFromStatus || 'executed']
  );
  try {
    const entries: any[] = plan.undo_payload.entries || [];
    const shiftEntries = entries.filter((e: any) => e.table === 'shifts');
    const affected = new Set<string>();
    for (const e of entries) {
      for (const row of [e.before, e.after]) {
        if (!row) continue;
        if (e.table === 'shifts' && row.user_id) affected.add(row.user_id);
        if (e.table === 'academic_sessions') {
          if (row.lecturer_user_id) affected.add(row.lecturer_user_id);
          if (row.supervisor_user_id) affected.add(row.supervisor_user_id);
        }
      }
    }
    for (const e of shiftEntries) {
      const row = e.after || e.before;
      if (!row) continue;
      const names = await shiftDisplayNames(companyId, row.user_id, row.shift_type_id);
      await auditLog({
        companyId, date: String(row.date).slice(0, 10),
        action: !e.after ? 'deleted' : !e.before ? 'created' : 'updated',
        personName: names.personName, shiftTypeName: names.shiftTypeName,
        source: 'agent', changedBy: userId,
        details: { via: 'task-redo', planId: plan.id },
      });
    }
    if (!shiftEntries.length) {
      await auditLog({
        companyId, date: todayStr(), action: 'updated', category: 'settings',
        source: 'agent', changedBy: userId,
        description: `Redid task: ${plan.plan_summary || 'schedule task'}`,
        details: { via: 'task-redo', planId: plan.id },
      });
    }
    affected.delete(userId);
    if (affected.size) {
      notify({
        companyId, userIds: [...affected], category: 'schedule', type: 'shift_changed',
        title: 'A schedule task was redone',
        body: `The task "${plan.plan_summary || 'schedule change'}" was applied again after being undone.`,
        link: 'my-schedule', bundleKey: 'task_redone',
        bundleTitle: 'A schedule task was redone',
        excludeUserId: userId,
      });
    }
  } catch { /* audit/notify must never break the redo */ }
  return true;
}

// POST /api/schedule/plans/redo-latest — Ctrl+Shift+Z / Ctrl+Y: redo the
// most recently undone task, unless a newer task was approved since.
router.post('/plans/redo-latest', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const isOwner = req.session.role === 'owner';
    const { rows } = await query(
      `SELECT * FROM schedule_plans
       WHERE company_id = $1 AND status = 'undone' AND undone_at IS NOT NULL
         AND ($2 OR undone_by = $3)
       ORDER BY undone_at DESC LIMIT 1`,
      [companyId, isOwner, req.session.userId!]
    );
    if (!rows.length) { res.status(404).json({ error: 'Nothing to redo.' }); return; }
    const { rows: newer } = await query(
      `SELECT 1 FROM schedule_plans
       WHERE company_id = $1 AND status IN ('executed', 'approved', 'partial')
         AND executed_at IS NOT NULL AND executed_at > $2 LIMIT 1`,
      [companyId, rows[0].undone_at]
    );
    if (newer.length) { res.status(404).json({ error: 'Nothing to redo.' }); return; }
    if (await performPlanRedo(req, res, rows[0])) {
      res.json({ ok: true, summary: rows[0].plan_summary });
    }
  } catch (err) {
    console.error('[schedule] redo-latest failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/plans/:id/redo — redo one specific undone task.
router.post('/plans/:id/redo', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT * FROM schedule_plans WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Plan not found.' }); return; }
    if (await performPlanRedo(req, res, rows[0])) {
      res.json({ ok: true, summary: rows[0].plan_summary });
    }
  } catch (err) {
    console.error('[schedule] redo plan failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/poll-inbox — check Gmail for new schedule emails (owner/scheduler).
// Creates pending plans from unread emails. Never modifies the schedule.
router.post('/poll-inbox', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { pollInbox, getEmailPollStatus } = await import('../util/emailPoller.js');
    const result = await pollInbox(query, companyId);
    // Batch 2: the poll just stamped the last-checked time — hand it
    // back so the dialog can refresh its "Email last checked" line
    // without a second request.
    const status = await getEmailPollStatus(query, companyId);
    res.json({ ok: true, ...result, lastPollAt: status.lastPollAt, timezone: status.timezone });
  } catch (err: any) {
    console.error('[schedule] poll inbox failed:', err);
    res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/email-poll-status — when email was last checked
// for this company (batch 2: makes the normal 5-minute wait visible
// instead of looking like a failure) + the company timezone to show it in.
router.get('/email-poll-status', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { getEmailPollStatus } = await import('../util/emailPoller.js');
    const status = await getEmailPollStatus(query, companyId);
    res.json({ ok: true, ...status });
  } catch (err: any) {
    console.error('[schedule] email poll status failed:', err);
    res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/plans/approve/:token — approve via email link.
// One-tap: executes immediately. Two token kinds share this URL:
//  - Per-approver tokens (plan_approver_tokens, migration 068): the
//    link was emailed to ONE approver, so the token IS the auth
//    (login-free, like the reject link) and it names the approver —
//    the click is recorded under their id, session or no session.
//  - The plan-level token (schedule_plans.approve_token; every link
//    sent before per-approver tokens, plus the shared copies still
//    sent to non-approver recipients): unchanged behavior — the
//    clicker must be logged in with edit access to the plan's
//    departments, and the session identity is recorded.
router.get('/plans/approve/:token', async (req: Request, res: Response) => {
  try {
    // Per-approver token first: it identifies the approver by itself.
    const { rows: trows } = await query(
      `SELECT p.id, p.company_id, p.plan, p.plan_summary, p.status, p.source_from, p.source_cc, p.source_subject, p.decided_at,
              pat.user_id AS approver_id
       FROM plan_approver_tokens pat
       JOIN schedule_plans p ON p.id = pat.plan_id
       WHERE pat.approve_token = $1`,
      [req.params.token]
    );
    let plan: any = null;
    let decidedBy: string | null = null;
    if (trows.length) {
      plan = trows[0];
      decidedBy = trows[0].approver_id;
    } else {
      const { rows } = await query(
        `SELECT id, company_id, plan, plan_summary, status, source_from, source_cc, source_subject, decided_at FROM schedule_plans WHERE approve_token = $1`,
        [req.params.token]
      );
      if (!rows.length) return res.status(404).send('<h1>Link expired or invalid</h1>');
      plan = rows[0];
    }
    if (plan.status !== 'pending') {
      const when = plan.decided_at ? ` on ${new Date(plan.decided_at).toLocaleString()}` : '';
      return res.send(`<h1>Already ${escHtml(plan.status)}</h1><p>This plan was already ${escHtml(plan.status)}${escHtml(when)}. No further action needed.</p>`);
    }
    if (decidedBy === null) {
      // Plan-level (shared) link: department access check — the approver
      // must be logged in and have edit access to all departments
      // affected by the plan. Owners bypass. Unchanged behavior.
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
      decidedBy = sessionUserId;
    }
    // Execute the plan (with the Ctrl+Z undo snapshot, migration 073).
    const { executePlanWithUndo } = await import('../util/planUndo.js');
    const { results, undo } = await executePlanWithUndo(plan.company_id, plan.plan, 'email-approval');
    const succeeded = results.filter((r: any) => r.success).length;
    const failed = results.length - succeeded;
    const allOk = failed === 0;
    // Only mark fully approved when every change succeeded; otherwise mark
    // 'partial' so the failure stays visible for the scheduler to fix.
    // A per-approver click also stamps decided_by with the token's
    // approver (the plan-level path never recorded it — unchanged).
    if (trows.length) {
      await query(
        `UPDATE schedule_plans SET status = $2, decided_at = now(), executed_at = now(), decided_by = $3, undo_payload = $4 WHERE id = $1`,
        [plan.id, allOk ? 'approved' : 'partial', decidedBy, undo ? JSON.stringify(undo) : null]
      );
    } else {
      await query(
        `UPDATE schedule_plans SET status = $2, decided_at = now(), executed_at = now(), undo_payload = $3 WHERE id = $1`,
        [plan.id, allOk ? 'approved' : 'partial', undo ? JSON.stringify(undo) : null]
      );
    }
    // Audit: same Change-report rows as in-app approvals — email-approved
    // changes used to be invisible in the report. decidedBy is the
    // per-approver token's user for those links, else the session user.
    try {
      await auditPlanChanges(plan.company_id, plan, results, decidedBy);
    } catch { /* audit must never break approval */ }
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
// Reject was always login-free (the token is the auth). Per-approver
// tokens (migration 068) additionally name the rejecter: their id is
// stamped on decided_by. The plan-level token behaves exactly as
// before — no identity recorded.
router.get('/plans/reject/:token', async (req: Request, res: Response) => {
  try {
    const { rows: trows } = await query(
      `SELECT p.id, p.status, p.plan_summary, p.source_from, p.source_cc, pat.user_id AS rejecter_id
       FROM plan_approver_tokens pat
       JOIN schedule_plans p ON p.id = pat.plan_id
       WHERE pat.reject_token = $1`,
      [req.params.token]
    );
    let plan: any = null;
    let rejecterId: string | null = null;
    if (trows.length) {
      plan = trows[0];
      rejecterId = trows[0].rejecter_id;
    } else {
      const { rows } = await query(
        `SELECT id, status, plan_summary, source_from, source_cc FROM schedule_plans WHERE reject_token = $1`,
        [req.params.token]
      );
      if (!rows.length) return res.status(404).send('<h1>Link expired or invalid</h1>');
      plan = rows[0];
    }
    if (plan.status !== 'pending') return res.send(`<h1>Already ${plan.status}</h1>`);
    if (rejecterId) {
      await query(`UPDATE schedule_plans SET status = 'rejected', decided_at = now(), decided_by = $2 WHERE id = $1`, [plan.id, rejecterId]);
    } else {
      await query(`UPDATE schedule_plans SET status = 'rejected', decided_at = now() WHERE id = $1`, [plan.id]);
    }
    // Notify the requester.
    try {
      const { sendMail } = await import('../util/mailer.js');
      const reqEmail = (plan.source_from || '').trim();
      if (reqEmail && reqEmail.includes('@')) {
        const ccList = String(plan.source_cc || '').split(',').map((s) => s.trim()).filter((s) => s.includes('@') && s.toLowerCase() !== reqEmail.toLowerCase());
        await sendMail({
          to: reqEmail,
          cc: ccList.length ? ccList : undefined,
          subject: `Request rejected: ${(plan.plan_summary || '').substring(0, 60)}`,
          text: `Hi,\n\nYour request was rejected and will not be applied.\n\nSummary: ${plan.plan_summary}\n\n— Quick Scheduling`,
          html: `<p>Hi,</p><p>Your request was <strong>rejected</strong> and will not be applied.</p><p><strong>Summary:</strong> ${plan.plan_summary}</p><p>— Quick Scheduling</p>`,
        });
      }
    } catch { /* non-fatal */ }
    res.send('<h1>Rejected</h1><p>The plan was rejected and will not be applied.</p>');
  } catch (err) {
    res.status(500).send('<h1>Error</h1>');
  }
});

// ---------------------------------------------------------------------------
// Swap partner stage (migration 072, Deepika 2026-11-01): a swap plan
// is born 'awaiting_partner'. The partner decides FIRST — via these
// login-free token links (the token is the auth, like the reject
// link), or in the app while logged in. Agreeing releases the plan
// to the approvers (status 'pending' + the normal approver
// notifications); declining closes it as 'rejected'. No approver
// path can touch an 'awaiting_partner' plan — they all gate on
// status = 'pending'.
// ---------------------------------------------------------------------------

const partnerPage = (title: string, body: string) =>
  `<!doctype html><html><body style="font-family:sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body></html>`;

router.get('/plans/partner-approve/:token', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT id, status, plan_summary FROM schedule_plans WHERE partner_approve_token = $1',
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send(partnerPage('Link expired or invalid', 'This swap link is no longer valid.'));
    const plan = rows[0];
    if (plan.status !== 'awaiting_partner') {
      return res.send(partnerPage('Already decided', 'This swap request has already been answered. No further action needed.'));
    }
    const { releasePlanToApprovers } = await import('../util/emailPoller.js');
    const released = await releasePlanToApprovers(query, plan.id);
    if (!released) return res.send(partnerPage('Already decided', 'This swap request has already been answered. No further action needed.'));
    res.send(partnerPage('You agreed to the swap', 'Thanks — the request is now with the schedulers for final approval. The swap only happens once they approve it too.'));
  } catch (err) {
    console.error('[schedule] partner approve failed:', err);
    res.status(500).send(partnerPage('Error', 'Something went wrong. Please try again.'));
  }
});

router.get('/plans/partner-reject/:token', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT id, status FROM schedule_plans WHERE partner_reject_token = $1',
      [req.params.token]
    );
    if (!rows.length) return res.status(404).send(partnerPage('Link expired or invalid', 'This swap link is no longer valid.'));
    const plan = rows[0];
    if (plan.status !== 'awaiting_partner') {
      return res.send(partnerPage('Already decided', 'This swap request has already been answered. No further action needed.'));
    }
    const { rejectPlanByPartner } = await import('../util/emailPoller.js');
    const closed = await rejectPlanByPartner(query, plan.id);
    if (!closed) return res.send(partnerPage('Already decided', 'This swap request has already been answered. No further action needed.'));
    res.send(partnerPage('Swap declined', 'The request is closed — it did not go to the schedulers.'));
  } catch (err) {
    console.error('[schedule] partner reject failed:', err);
    res.status(500).send(partnerPage('Error', 'Something went wrong. Please try again.'));
  }
});

// GET /api/schedule/plans/awaiting-my-agreement — swap plans staged
// at ME as the partner (any role). The Requests tab shows these so
// the partner can decide in the app, not only by email.
router.get('/plans/awaiting-my-agreement', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT id, source_from_name AS "fromName", plan_summary AS "summary", plan,
              created_at AS "createdAt"
       FROM schedule_plans
       WHERE company_id = $1 AND partner_user_id = $2 AND status = 'awaiting_partner'
       ORDER BY created_at DESC LIMIT 20`,
      [req.session.companyId!, req.session.userId!]
    );
    res.json({ plans: rows });
  } catch (err) {
    console.error('[schedule] awaiting-my-agreement failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/plans/:id/partner-decision — the logged-in
// partner agrees or declines. Only the plan's named partner, only
// while the plan is still staged at them.
router.post('/plans/:id/partner-decision', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const decision = String((req.body ?? {}).decision || '');
    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: 'Decision must be approve or reject.' });
      return;
    }
    const { rows } = await query(
      'SELECT id, status, partner_user_id FROM schedule_plans WHERE id = $1 AND company_id = $2',
      [req.params.id, req.session.companyId!]
    );
    if (!rows.length) { res.status(404).json({ error: 'Plan not found.' }); return; }
    const plan = rows[0];
    if (plan.partner_user_id !== req.session.userId) {
      res.status(403).json({ error: 'This swap is waiting on someone else.' });
      return;
    }
    if (plan.status !== 'awaiting_partner') {
      res.status(409).json({ error: 'This swap has already been decided.' });
      return;
    }
    const { releasePlanToApprovers, rejectPlanByPartner } = await import('../util/emailPoller.js');
    const done = decision === 'approve'
      ? await releasePlanToApprovers(query, plan.id)
      : await rejectPlanByPartner(query, plan.id);
    if (!done) { res.status(409).json({ error: 'This swap was just decided by someone else.' }); return; }
    res.json({ ok: true, decision });
  } catch (err) {
    console.error('[schedule] partner decision failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
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
    const { rows: dashes } = await query('SELECT id, name FROM dashboards WHERE company_id = $1 AND archived_at IS NULL ORDER BY name', [companyId]);
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
    <label>Speaker</label><select id="a-presenter"></select>
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
    <label>Speaker</label><select id="c-presenter"></select>
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
  if (s.presenterName) parts.push('Speaker: ' + s.presenterName);
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
memberOpts($('c-presenter'), '— No change —', true);
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
    location: $('a-location').value.trim() || null,
    departmentId: $('a-dept').value || null, recur: $('a-recur').value,
    recurUntil: $('a-until').value || null, notes: $('a-notes').value.trim() || null }, $('a-save'));
});
$('c-save').addEventListener('click', () => {
  const s = curSession();
  if (!s) { msg(false, 'Pick a session first.'); return; }
  const fields = {};
  if ($('c-title').value.trim()) fields.title = $('c-title').value.trim();
  if ($('c-presenter').value) fields.presenterId = $('c-presenter').value === 'none' ? null : $('c-presenter').value;
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
      if (!(await validUser(b.presenterId))) {
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
        presenterId: b.presenterId || null,
        location: b.location ? String(b.location).trim() : null,
        kindKey, departmentId, notes: b.notes ? String(b.notes).trim() : null,
        recurRule, recurInterval: b.recur === 'weekly2' ? 2 : 1,
        recurUntil: recurRule !== 'none' && b.recurUntil ? String(b.recurUntil) : null,
      });
      res.json({ ok: true, message: `Added "${title}" to ${dRows[0].name} on ${date}${recurRule !== 'none' ? ' (repeating weekly)' : ''}.` });
      {
        const people = [b.presenterId].filter(Boolean).map(String);
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
      if ('presenterId' in fIn) { if (!(await validUser(fIn.presenterId))) { res.status(400).json({ error: 'That speaker is not an active team member.' }); return; } f.presenterId = fIn.presenterId || null; }
      // A supervisorId from a stale cached page is ignored on purpose:
      // supervisors were retired (Deepika, 2026-11-07) — sessions have
      // speakers only now.
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

/**
 * For duplicate-pickup refusals: name the shift the person already has
 * (type + date + draft state), so the refusal explains itself instead of
 * sounding wrong when the shift is hard to spot (Deepika 2026-11-03).
 */
async function existingShiftNote(companyId: string, userId: string, date: string, shiftTypeId: string): Promise<string> {
  const { rows } = await query(
    `SELECT st.name AS "typeName", s.published FROM shifts s
     JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.company_id = $1 AND s.user_id = $2 AND s.date = $3 AND s.shift_type_id = $4 LIMIT 1`,
    [companyId, userId, date, shiftTypeId]
  );
  if (!rows.length) return '';
  const nice = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return `You already have ${rows[0].typeName} on ${nice}${rows[0].published === false ? ' — it is saved as a draft' : ''}. Look for your name on that day in My Schedule.`;
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
  // Rotation occurrence ids ("rot-…") have no row; asking Postgres to
  // compare one against the uuid id column throws instead of missing.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(shiftId)) return null;
  const { rows } = await query(
    `SELECT s.id, s.user_id AS "userId", s.shift_type_id AS "shiftTypeId",
            s.date::text AS date, st.name AS "shiftTypeName"
     FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [shiftId, companyId]
  );
  return rows[0] || null;
}

/**
 * Turn one rotation-generated occurrence ("rot-…" id, no row of its own)
 * into a real shift row — the same exclude-and-create the drag system
 * uses — so employee requests (swap) can reference it. Returns the real
 * shift (manualShift shape), an existing manual row when the occurrence
 * was already materialized, or null when the occurrence doesn't exist.
 */
async function materializeRotationOccurrence(companyId: string, rotId: string): Promise<any | null> {
  const date = rotId.slice(-10);
  if (!isValidDate(date)) return null;
  const all = await getShiftsForRange(query, companyId, date, date);
  const e = all.find((x) => x.id === rotId && x.isRotation);
  if (!e || !e.userId || !e.shiftTypeId) return null;
  const { rows: existingRows } = await query(
    `SELECT id FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 LIMIT 1`,
    [companyId, e.userId, date, e.shiftTypeId]
  );
  if (existingRows.length) return manualShift(companyId, existingRows[0].id);
  const rotationId = rotId.slice(4, 40);
  await query(
    `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
    [companyId, rotationId, e.userId, date, e.shiftTypeId]
  );
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, companyId, e.userId, e.shiftTypeId, date, null, e.published !== false, e.userId]
  );
  return manualShift(companyId, id);
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
      'SELECT id, name, eligible_job_role_ids FROM shift_types WHERE id = $1 AND company_id = $2 AND is_active = true',
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
    const typeName = trows[0].name;
    let claimed = false;
    let conflictMsg: string | null = null;
    try {
      await withTransaction(async (tx) => {
        // Conflict guard (Deepika 2026-11-03): an open-slot claim must
        // obey the same overlap / 8-hour-rest rules as covers and swaps.
        // This endpoint never checked, so she claimed two overlapping
        // shift types on one day with no warning. Same-type duplicates
        // are excluded here — they keep their own named message via the
        // 23505 path below.
        const conflict = await checkShiftConflict(tx.query, companyId, {
          userId: me,
          personName: 'You',
          proposed: { date, shiftTypeId, shiftTypeName: typeName },
          exclude: [{ date, shiftTypeId }],
        });
        if (conflict) { conflictMsg = conflict; return; }
        // Path 1: manually-added extra open slots (atomic consume).
        if (await consumeExtraOpenSlot(tx.query, companyId, date, shiftTypeId)) {
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
        const note = await existingShiftNote(companyId, me, date, shiftTypeId);
        res.status(409).json({ error: note || 'You already have that shift on that date.' });
        return;
      }
      throw err;
    }
    if (conflictMsg) {
      res.status(409).json({ error: `You can't pick up this shift — ${conflictMsg}` });
      return;
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
      // Conflict guard (Deepika 2026-11-01): never ask someone to
      // cover a shift they're already working, or one that would
      // leave them under 8 hours of rest — refuse up front, plainly.
      const tNames = await shiftDisplayNames(companyId, targetUserId, shift.shiftTypeId);
      const conflict = await checkShiftConflict(query, companyId, {
        userId: targetUserId,
        personName: tNames.personName || 'That team member',
        proposed: { date: shift.date, shiftTypeId: shift.shiftTypeId, shiftTypeName: shift.shiftTypeName },
      });
      if (conflict) {
        res.status(400).json({ error: `Can't ask them to cover this shift — ${conflict}` });
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
    // Action-link email to the people being asked (Deepika 2026-11-02).
    sendShiftRequestActionEmails(companyId, id).catch(() => {});
    // Approver decision emails (Deepika 2026-11-03): owners/schedulers
    // get their own Approve/Reject link for the same request.
    sendShiftRequestApproverEmails(companyId, id).catch(() => {});
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
    // Rotation-generated occurrences are swappable too (Deepika
    // 2026-11-02): materialize either side into a real row first, then
    // run every check below on the real ids.
    let mine = await manualShift(companyId, String(myShiftId));
    if (!mine && String(myShiftId).startsWith('rot-')) mine = await materializeRotationOccurrence(companyId, String(myShiftId));
    let theirs = await manualShift(companyId, String(theirShiftId));
    if (!theirs && String(theirShiftId).startsWith('rot-')) theirs = await materializeRotationOccurrence(companyId, String(theirShiftId));
    if (!mine || !theirs) {
      res.status(404).json({ error: 'One of the shifts was not found.' });
      return;
    }
    const myRealId = mine.id as string;
    const theirRealId = theirs.id as string;
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
      [companyId, myRealId, theirRealId]
    );
    if (existing.length) {
      res.status(409).json({ error: 'There is already a pending request on one of those shifts.' });
      return;
    }
    // Conflict guard (Deepika 2026-11-01): simulate BOTH people's
    // post-swap schedules now — a swap that double-books either
    // person or leaves them under 8 hours of rest is refused here,
    // with the reason, instead of reaching the schedulers impossible.
    {
      const myNames = await shiftDisplayNames(companyId, me, mine.shiftTypeId);
      const theirNames = await shiftDisplayNames(companyId, theirs.userId, theirs.shiftTypeId);
      const conflict = await checkSwapConflicts(query, companyId, [
        {
          userId: me, personName: myNames.personName || 'You',
          gives: [{ date: mine.date, shiftTypeId: mine.shiftTypeId, shiftTypeName: mine.shiftTypeName }],
          receives: [{ date: theirs.date, shiftTypeId: theirs.shiftTypeId, shiftTypeName: theirs.shiftTypeName }],
        },
        {
          userId: theirs.userId, personName: theirNames.personName || 'Your swap partner',
          gives: [{ date: theirs.date, shiftTypeId: theirs.shiftTypeId, shiftTypeName: theirs.shiftTypeName }],
          receives: [{ date: mine.date, shiftTypeId: mine.shiftTypeId, shiftTypeName: mine.shiftTypeName }],
        },
      ]);
      if (conflict) {
        res.status(400).json({ error: `This swap can't be requested — ${conflict}` });
        return;
      }
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO shift_requests (id, company_id, request_type, shift_id, their_shift_id, requester_id, target_user_id, status, stage)
       VALUES ($1, $2, 'swap', $3, $4, $5, $6, 'pending', 'partner')`,
      [id, companyId, myRealId, theirRealId, me, theirs.userId]
    );
    res.status(201).json({
      id, requestType: 'swap', myShiftId: myRealId, theirShiftId: theirRealId,
      targetUserId: theirs.userId, requesterId: me, status: 'pending', stage: 'partner',
      myShift: { date: mine.date, shiftTypeName: mine.shiftTypeName },
      theirShift: { date: theirs.date, shiftTypeName: theirs.shiftTypeName },
    });
    // Two-stage swap (Deepika 2026-11-01): the request goes to the
    // swap partner FIRST. The approvers are notified only when the
    // partner agrees (see the approve handler's partner stage).
    {
      const names = await shiftDisplayNames(companyId, me, mine.shiftTypeId);
      notify({
        companyId, userIds: [theirs.userId], category: 'schedule', type: 'request_to_you',
        title: `${names.personName} wants to swap shifts with you`,
        body: `${names.personName} offers ${mine.shiftTypeName} on ${fmtDateLong(mine.date)} for your ${theirs.shiftTypeName} on ${fmtDateLong(theirs.date)}. If you agree, it goes to the schedulers for final approval.`,
        link: 'requests', bundleKey: 'request_to_you',
        bundleTitle: '{count} requests are waiting for you',
        excludeUserId: me,
      });
    }
    // Action-link email to the swap partner (Deepika 2026-11-02).
    sendShiftRequestActionEmails(companyId, id).catch(() => {});
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
              r.status, r.stage, r.created_at AS "createdAt", r.decided_at AS "decidedAt",
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
        stage: r.stage,
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
              target_user_id AS "targetUserId", status, stage
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
    // Expiry backstop (Deepika 2026-11-03): a request whose shift day
    // has passed can't be decided — the 15-minute sweep closes these
    // as 'expired', but refuse here too if it hasn't run yet.
    {
      const mainShift = await manualShift(companyId, r.shiftId);
      const otherShift = r.theirShiftId ? await manualShift(companyId, r.theirShiftId) : null;
      const firstDate = otherShift && mainShift && otherShift.date < mainShift.date
        ? otherShift.date : (mainShift ? mainShift.date : null);
      if (firstDate && firstDate < todayStr()) {
        res.status(409).json({ error: 'This request has expired — the shift date has passed.' });
        return;
      }
    }
    const isPrivileged = role === 'owner' || role === 'scheduler';
    // Two-stage swaps (Deepika 2026-11-01): at the partner stage ONLY
    // the swap partner can agree — and agreeing does not execute the
    // swap, it hands the request to the schedulers (stage 'admin'),
    // whose approval executes it, exactly like other requests.
    if (r.requestType === 'swap' && r.stage === 'partner') {
      if (r.targetUserId !== me) {
        res.status(403).json({ error: 'The swap partner has to agree first — it comes to the schedulers after that.' });
        return;
      }
      const { rowCount } = await query(
        "UPDATE shift_requests SET stage = 'admin' WHERE id = $1 AND status = 'pending' AND stage = 'partner'",
        [id]
      );
      if (!rowCount) {
        res.status(409).json({ error: 'This request was just decided by someone else.' });
        return;
      }
      res.json({ ok: true, status: 'pending', stage: 'admin' });
      const myShift = await manualShift(companyId, r.shiftId);
      const theirShift = r.theirShiftId ? await manualShift(companyId, r.theirShiftId) : null;
      if (myShift) {
        const reqNames = await shiftDisplayNames(companyId, r.requesterId, myShift.shiftTypeId);
        const partNames = r.targetUserId && theirShift
          ? await shiftDisplayNames(companyId, r.targetUserId, theirShift.shiftTypeId) : null;
        notifyShiftRequestApprovers(companyId, { userId: r.requesterId, shiftTypeId: myShift.shiftTypeId }, me,
          'A shift request is waiting for a decision',
          `${reqNames.personName} proposed a swap (${myShift.shiftTypeName} on ${fmtDateLong(myShift.date)}${theirShift ? ` ↔ ${theirShift.shiftTypeName} on ${fmtDateLong(theirShift.date)}` : ''}) and ${partNames ? partNames.personName : 'the swap partner'} agreed. Final approval is yours.`);
        // Approver Approve/Reject email links for the admin stage (2026-11-03).
        sendShiftRequestApproverEmails(companyId, id, me).catch(() => {});
      }
      notify({
        companyId, userIds: [r.requesterId], category: 'schedule', type: 'request_decided',
        title: 'Your swap partner agreed',
        body: myShift
          ? `Your swap for ${myShift.shiftTypeName} on ${fmtDateLong(myShift.date)} is now with the schedulers for final approval.`
          : 'Your swap is now with the schedulers for final approval.',
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });
      return;
    }
    if (r.requestType === 'swap' && r.stage === 'admin' && !isPrivileged) {
      res.status(403).json({ error: 'This swap is with the schedulers now — they give the final approval.' });
      return;
    }
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

    // For a pickup claim, the claimant's display name + the shift's
    // identity are fetched now so the in-transaction conflict guard
    // below never needs a second connection for names.
    const claimShift = r.requestType === 'pickup' ? await manualShift(companyId, r.shiftId) : null;
    const claimNames = claimShift ? await shiftDisplayNames(companyId, me, claimShift.shiftTypeId) : null;

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
          // Claim-time conflict guard (Deepika 2026-11-01): checked
          // again here, against the live schedule, so someone who
          // has since been put on a clashing shift (or would be left
          // under 8 hours of rest) cannot pick this shift up.
          if (claimShift) {
            const conflict = await checkShiftConflict(tx.query, companyId, {
              userId: me,
              personName: claimNames?.personName || 'You',
              proposed: { date: claimShift.date, shiftTypeId: claimShift.shiftTypeId, shiftTypeName: claimShift.shiftTypeName },
            });
            if (conflict) {
              throw new RequestError(409, `You can't pick up this shift — ${conflict}`);
            }
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
        const target = await manualShift(companyId, r.shiftId);
        const note = target ? await existingShiftNote(companyId, me, target.date, target.shiftTypeId) : '';
        res.status(409).json({ error: note || 'That would give you a duplicate shift — you already have that shift type on that date.' });
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


// ---------- Login-free request action links (Deepika 2026-11-02) ----------
// The people a cover/swap request asks get an email with a personal
// link (tokens in migration 074, sent by util/requestActionEmails).
// GET only SHOWS a confirmation page — links alone never act, so mail
// scanners that prefetch links can't claim a shift. The POST performs
// the decision as the token's person, under the same guards as the
// in-app approve/decline handlers above.
function actPage(title: string, inner: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + escHtml(title) + '</title></head>' +
    '<body style="font-family:sans-serif;background:#f4f7f8;margin:0;padding:24px"><div style="max-width:480px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,0.08)">' +
    '<h2 style="margin:0 0 12px;font-size:20px;color:#21414c">' + escHtml(title) + '</h2>' + inner + '</div></body></html>';
}
function actButton(value: string, label: string, bg: string): string {
  return '<button type="submit" name="action" value="' + value + '" style="background:' + bg + ';color:#fff;border:none;border-radius:8px;padding:12px 20px;font-size:16px;font-weight:700;cursor:pointer;margin:0 8px 8px 0">' + escHtml(label) + '</button>';
}
async function loadActContext(token: string): Promise<any | null> {
  const { rows } = await query(
    `SELECT t.user_id AS "userId", t.company_id AS "companyId", t.kind AS kind,
            sr.id, sr.request_type AS "requestType", sr.status, sr.stage,
            sr.shift_id AS "shiftId", sr.their_shift_id AS "theirShiftId",
            sr.requester_id AS "requesterId", sr.target_user_id AS "targetUserId"
     FROM shift_request_action_tokens t
     JOIN shift_requests sr ON sr.id = t.request_id
     WHERE t.token = $1`,
    [token]
  );
  return rows.length ? rows[0] : null;
}

router.get('/requests/act/:token', async (req: Request, res: Response) => {
  try {
    const ctx = await loadActContext(String(req.params.token));
    if (!ctx) {
      res.status(404).send(actPage('Link not valid', '<p>This link is not valid. If you got it in an email, the request may have been withdrawn.</p>'));
      return;
    }
    if (ctx.status !== 'pending') {
      res.send(actPage('Already decided', '<p>This request has already been decided — there is nothing left to do.</p>'));
      return;
    }
    const shift = await manualShift(ctx.companyId, ctx.shiftId);
    const reqNames = await shiftDisplayNames(ctx.companyId, ctx.requesterId, shift ? shift.shiftTypeId : '');
    const who = reqNames.personName || 'A team member';
    // Expiry backstop (Deepika 2026-11-03): never render a decision
    // page for a past-date shift — the sweep closes these as expired.
    {
      const theirs = ctx.theirShiftId ? await manualShift(ctx.companyId, ctx.theirShiftId) : null;
      const firstDate = theirs && shift && theirs.date < shift.date ? theirs.date : (shift ? shift.date : null);
      if (firstDate && firstDate < todayStr()) {
        res.send(actPage('This request has expired', '<p>The shift date has passed, so this request is closed.</p>'));
        return;
      }
    }
    // Approver links (Deepika 2026-11-03): an owner/scheduler deciding
    // from email — pickup (approve = they take the shift, like the
    // in-app Approve), open_pickup (approve publishes the held shift),
    // or a swap at the admin stage (approve executes it).
    if (ctx.kind === 'approver') {
      const { rows: urows } = await query(
        'SELECT role FROM users WHERE id = $1 AND company_id = $2 AND is_active = true',
        [ctx.userId, ctx.companyId]);
      const role = urows.length ? urows[0].role : null;
      const applicable = ctx.requesterId !== ctx.userId
        && (ctx.requestType === 'pickup' || ctx.requestType === 'open_pickup'
          || (ctx.requestType === 'swap' && ctx.stage === 'admin'));
      if ((role !== 'owner' && role !== 'scheduler') || !applicable) {
        res.send(actPage('Nothing to decide here', '<p>This request is not waiting on you right now. You can see it in the app under Requests.</p>'));
        return;
      }
      let aTitle = 'Decision needed';
      let aBody = '';
      let aButtons = '';
      if (ctx.requestType === 'pickup') {
        const tgtNames = ctx.targetUserId
          ? await shiftDisplayNames(ctx.companyId, ctx.targetUserId, shift ? shift.shiftTypeId : '') : null;
        const vac = shift ? await vacationOn(ctx.companyId, ctx.userId, shift.date) : null;
        aBody = (vac ? '<p style="background:#fdf3e3;border:1px solid #ecc97e;border-radius:8px;padding:10px 12px"><strong>⚠️ You are on vacation</strong> on ' + escHtml(fmtDateLong(shift!.date)) + (vac.reason ? ' (' + escHtml(vac.reason) + ')' : '') + '. You can still pick it up if you want to work that day.</p>' : '') +
          '<p><strong>' + escHtml(who) + '</strong> asked ' + (tgtNames ? escHtml(tgtNames.personName || 'a team member') : 'the team') +
          ' to pick up their <strong>' + escHtml(shift ? shift.shiftTypeName : 'shift') + '</strong> shift on <strong>' + escHtml(fmtDateLong(shift ? shift.date : '')) + '</strong>.</p>' +
          '<p>Approving means <strong>you</strong> pick up this shift. Rejecting closes the request.</p>';
        aButtons = actButton('approve', '✋ Approve — I pick it up', '#0e7c86') + actButton('reject', 'Reject', '#bd3d4a');
      } else if (ctx.requestType === 'open_pickup') {
        aBody = '<p><strong>' + escHtml(who) + '</strong> asked to pick up the open <strong>' + escHtml(shift ? shift.shiftTypeName : 'shift') + '</strong> shift on <strong>' + escHtml(fmtDateLong(shift ? shift.date : '')) + '</strong> (share link).</p>' +
          '<p>Approving publishes the shift for them. Rejecting closes the request and releases the slot.</p>';
        aButtons = actButton('approve', 'Approve', '#0e7c86') + actButton('reject', 'Reject', '#bd3d4a');
      } else {
        const theirs = ctx.theirShiftId ? await manualShift(ctx.companyId, ctx.theirShiftId) : null;
        const partNames = ctx.targetUserId && theirs
          ? await shiftDisplayNames(ctx.companyId, ctx.targetUserId, theirs.shiftTypeId) : null;
        aBody = '<p><strong>' + escHtml(who) + '</strong> and <strong>' + escHtml(partNames ? (partNames.personName || 'their swap partner') : 'their swap partner') + '</strong> agreed to swap: ' +
          '<strong>' + escHtml(shift ? shift.shiftTypeName : '') + '</strong> on <strong>' + escHtml(fmtDateLong(shift ? shift.date : '')) + '</strong> for ' +
          '<strong>' + escHtml(theirs ? theirs.shiftTypeName : '') + '</strong> on <strong>' + escHtml(fmtDateLong(theirs ? theirs.date : '')) + '</strong>.</p>' +
          '<p>Approving executes the swap. Rejecting closes the request.</p>';
        aButtons = actButton('approve', 'Approve the swap', '#0e7c86') + actButton('reject', 'Reject', '#bd3d4a');
      }
      res.send(actPage(aTitle, aBody + '<form method="POST" action="">' + aButtons + '</form><p style="color:#666;font-size:13px">You can also answer in the app under Requests.</p>'));
      return;
    }
    let title = '';
    let body = '';
    let buttons = '';
    if (ctx.requestType === 'pickup') {
      title = ctx.targetUserId ? 'Cover request' : 'Cover needed';
      // Vacation heads-up (Deepika 2026-11-03): if the person this link
      // belongs to is on vacation that day, say so before they decide.
      const vac = shift ? await vacationOn(ctx.companyId, ctx.userId, shift.date) : null;
      body = (vac ? '<p style="background:#fdf3e3;border:1px solid #ecc97e;border-radius:8px;padding:10px 12px"><strong>⚠️ You are on vacation</strong> on ' + escHtml(fmtDateLong(shift!.date)) + (vac.reason ? ' (' + escHtml(vac.reason) + ')' : '') + '. You can still pick it up if you want to work that day.</p>' : '') +
        '<p><strong>' + escHtml(who) + '</strong> ' + (ctx.targetUserId ? 'asked you to cover' : 'needs cover for') +
        ' their <strong>' + escHtml(shift ? shift.shiftTypeName : 'shift') + '</strong> shift on <strong>' + escHtml(fmtDateLong(shift ? shift.date : '')) + '</strong>.</p>' +
        (ctx.targetUserId ? '<p>If you pick it up, the shift is yours.</p>' : '<p>First to pick it up gets it — the shift stays theirs until someone does.</p>');
      buttons = actButton('pickup', '✋ Pick up this shift', '#0e7c86') + (ctx.targetUserId ? actButton('decline', 'Decline', '#bd3d4a') : '');
    } else if (ctx.requestType === 'swap' && ctx.stage === 'partner') {
      const theirs = ctx.theirShiftId ? await manualShift(ctx.companyId, ctx.theirShiftId) : null;
      title = 'Swap request';
      body = '<p><strong>' + escHtml(who) + '</strong> wants to swap their <strong>' + escHtml(shift ? shift.shiftTypeName : '') + '</strong> on <strong>' + escHtml(fmtDateLong(shift ? shift.date : '')) + '</strong>' +
        ' for your <strong>' + escHtml(theirs ? theirs.shiftTypeName : '') + '</strong> on <strong>' + escHtml(fmtDateLong(theirs ? theirs.date : '')) + '</strong>.</p>' +
        '<p>If you agree, it goes to the schedulers for final approval.</p>';
      buttons = actButton('agree', 'Agree to the swap', '#0e7c86') + actButton('decline', 'Decline', '#bd3d4a');
    } else {
      res.send(actPage('Nothing to decide here', '<p>This request is not waiting on you right now. You can see it in the app under Requests.</p>'));
      return;
    }
    res.send(actPage(title, body + '<form method="POST" action="">' + buttons + '</form><p style="color:#666;font-size:13px">You can also answer in the app under Requests.</p>'));
  } catch (err) {
    console.error('[schedule] act page failed:', err);
    res.status(500).send(actPage('Something went wrong', '<p>Please try again, or answer in the app under Requests.</p>'));
  }
});

router.post('/requests/act/:token', urlencoded({ extended: false }), async (req: Request, res: Response) => {
  try {
    const ctx = await loadActContext(String(req.params.token));
    if (!ctx) {
      res.status(404).send(actPage('Link not valid', '<p>This link is not valid.</p>'));
      return;
    }
    if (ctx.status !== 'pending') {
      res.send(actPage('Already decided', '<p>This request has already been decided — there is nothing left to do.</p>'));
      return;
    }
    const companyId: string = ctx.companyId;
    const me: string = ctx.userId;
    const id: string = ctx.id;
    const action = String((req.body && req.body.action) || '');
    const decidedPage = () => res.send(actPage('Already decided', '<p>This request has already been decided — there is nothing left to do.</p>'));

    // Expiry backstop (Deepika 2026-11-03): a past-date request can't
    // be acted on, even if the sweep hasn't closed it yet.
    {
      const mainShift = await manualShift(companyId, ctx.shiftId);
      const otherShift = ctx.theirShiftId ? await manualShift(companyId, ctx.theirShiftId) : null;
      const firstDate = otherShift && mainShift && otherShift.date < mainShift.date
        ? otherShift.date : (mainShift ? mainShift.date : null);
      if (firstDate && firstDate < todayStr()) {
        res.send(actPage('This request has expired', '<p>The shift date has passed, so this request is closed.</p>'));
        return;
      }
    }

    // Approver decisions from email (Deepika 2026-11-03): kind='approver'
    // tokens act with the same semantics as the in-app Requests buttons —
    // pickup Approve = the approver takes the shift, open_pickup Approve
    // publishes the held shift for the requester, swap (admin stage)
    // Approve executes the swap; Reject closes the request.
    if (ctx.kind === 'approver') {
      const { rows: urows } = await query(
        'SELECT role FROM users WHERE id = $1 AND company_id = $2 AND is_active = true',
        [me, companyId]);
      const aRole = urows.length ? urows[0].role : null;
      if (aRole !== 'owner' && aRole !== 'scheduler') {
        res.status(403).send(actPage('Not your decision', '<p>Only an owner or scheduler can decide this request.</p>'));
        return;
      }
      if (ctx.requesterId === me) {
        res.send(actPage('Nothing to decide here', '<p>You cannot decide your own request.</p>'));
        return;
      }
      const applicable = ctx.requestType === 'pickup' || ctx.requestType === 'open_pickup'
        || (ctx.requestType === 'swap' && ctx.stage === 'admin');
      if (!applicable) {
        res.send(actPage('Nothing to decide here', '<p>This request is not waiting on you right now. You can see it in the app under Requests.</p>'));
        return;
      }
      const shift0 = await manualShift(companyId, ctx.shiftId);
      const typeWord = ctx.requestType === 'swap' ? 'swap' : 'pickup';
      const notifyDecided = (approved: boolean) => notify({
        companyId, userIds: [ctx.requesterId], category: 'schedule', type: 'request_decided',
        title: `Your ${typeWord} request was ${approved ? 'approved' : 'declined'}`,
        body: shift0
          ? `Your ${typeWord} request for ${shift0.shiftTypeName} on ${fmtDateLong(shift0.date)} was ${approved ? 'approved' : 'declined'}.`
          : `Your ${typeWord} request was ${approved ? 'approved' : 'declined'}.`,
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });

      if (action === 'reject') {
        const { rowCount } = await query(
          "UPDATE shift_requests SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'",
          [id]
        );
        if (!rowCount) { decidedPage(); return; }
        if (ctx.requestType === 'open_pickup') {
          // Release the held slot (mirrors the in-app decline).
          await query('DELETE FROM shifts WHERE id = $1 AND published = false', [ctx.shiftId]);
        }
        notifyDecided(false);
        res.send(actPage('Rejected', '<p>The request has been closed and the requester has been told.</p>'));
        return;
      }

      if (action === 'approve' && ctx.requestType === 'pickup') {
        try {
          await withTransaction(async (tx) => {
            const { rows: locked } = await tx.query(
              `SELECT request_type AS "requestType", shift_id AS "shiftId",
                      requester_id AS "requesterId", status
               FROM shift_requests WHERE id = $1 FOR UPDATE`,
              [id]
            );
            if (!locked.length || locked[0].status !== 'pending') {
              throw new RequestError(409, 'This request was just decided by someone else.');
            }
            const lr = locked[0];
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
            if (shift0) {
              const conflict = await checkShiftConflict(tx.query, companyId, {
                userId: me,
                personName: 'You',
                proposed: { date: shift0.date, shiftTypeId: shift0.shiftTypeId, shiftTypeName: shift0.shiftTypeName },
              });
              if (conflict) {
                throw new RequestError(409, `You can't pick up this shift — ${conflict}`);
              }
            }
            await tx.query('UPDATE shifts SET user_id = $1 WHERE id = $2', [me, lr.shiftId]);
            await tx.query(
              "UPDATE shift_requests SET status = 'approved', decided_at = now() WHERE id = $1",
              [id]
            );
            await tx.query(
              `UPDATE shift_requests SET status = 'cancelled', decided_at = now()
               WHERE id <> $1 AND status = 'pending'
                 AND (shift_id = $2 OR their_shift_id = $2)`,
              [id, lr.shiftId]
            );
          });
        } catch (err: any) {
          if (err instanceof RequestError) {
            res.send(actPage('Could not approve', '<p>' + escHtml(err.message) + '</p>'));
            return;
          }
          if (err?.code === '23505') {
            const note = shift0 ? await existingShiftNote(companyId, me, shift0.date, shift0.shiftTypeId) : '';
            res.send(actPage('Could not approve', '<p>' + escHtml(note || 'That would give you a duplicate shift — you already have that shift type on that date.') + '</p>'));
            return;
          }
          throw err;
        }
        notifyDecided(true);
        res.send(actPage("Approved — it's yours", '<p>The shift is on your schedule now. The requester has been told.</p>'));
        return;
      }

      if (action === 'approve' && ctx.requestType === 'open_pickup') {
        try {
          await withTransaction(async (tx) => {
            const { rows: locked } = await tx.query(
              `SELECT shift_id AS "shiftId", requester_id AS "requesterId", status
               FROM shift_requests WHERE id = $1 FOR UPDATE`,
              [id]
            );
            if (!locked.length || locked[0].status !== 'pending') {
              throw new RequestError(409, 'This request was just decided by someone else.');
            }
            const lr = locked[0];
            const { rows: srows } = await tx.query(
              'SELECT id, user_id AS "userId" FROM shifts WHERE id = $1 FOR UPDATE',
              [lr.shiftId]
            );
            if (!srows.length) throw new RequestError(409, 'The shift no longer exists.');
            if (srows[0].userId !== lr.requesterId) {
              throw new RequestError(409, 'The shift changed hands since the request was made.');
            }
            await tx.query('UPDATE shifts SET published = true WHERE id = $1', [lr.shiftId]);
            await tx.query(
              "UPDATE shift_requests SET status = 'approved', decided_at = now() WHERE id = $1",
              [id]
            );
            await tx.query(
              `UPDATE shift_requests SET status = 'cancelled', decided_at = now()
               WHERE id <> $1 AND status = 'pending'
                 AND (shift_id = $2 OR their_shift_id = $2)`,
              [id, lr.shiftId]
            );
          });
        } catch (err: any) {
          if (err instanceof RequestError) {
            res.send(actPage('Could not approve', '<p>' + escHtml(err.message) + '</p>'));
            return;
          }
          throw err;
        }
        notifyDecided(true);
        res.send(actPage('Approved', '<p>The shift is published for the requester now. They have been told.</p>'));
        return;
      }

      if (action === 'approve' && ctx.requestType === 'swap') {
        try {
          await withTransaction(async (tx) => {
            const { rows: locked } = await tx.query(
              `SELECT shift_id AS "shiftId", their_shift_id AS "theirShiftId",
                      requester_id AS "requesterId", target_user_id AS "targetUserId", status, stage
               FROM shift_requests WHERE id = $1 FOR UPDATE`,
              [id]
            );
            if (!locked.length || locked[0].status !== 'pending') {
              throw new RequestError(409, 'This request was just decided by someone else.');
            }
            const lr = locked[0];
            if (lr.stage !== 'admin') {
              throw new RequestError(409, 'This swap is still waiting on the swap partner.');
            }
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
            await tx.query(
              "UPDATE shift_requests SET status = 'approved', decided_at = now() WHERE id = $1",
              [id]
            );
            await tx.query(
              `UPDATE shift_requests SET status = 'cancelled', decided_at = now()
               WHERE id <> $1 AND status = 'pending'
                 AND (shift_id = ANY($2) OR their_shift_id = ANY($2))`,
              [id, [lr.shiftId, lr.theirShiftId]]
            );
          });
        } catch (err: any) {
          if (err instanceof RequestError) {
            res.send(actPage('Could not approve', '<p>' + escHtml(err.message) + '</p>'));
            return;
          }
          if (err?.code === '23505') {
            res.send(actPage('Could not approve', '<p>Approving this swap would give someone a duplicate shift — it was not applied.</p>'));
            return;
          }
          throw err;
        }
        notifyDecided(true);
        res.send(actPage('Swap approved', '<p>The shifts have been swapped. The requester has been told.</p>'));
        return;
      }

      res.status(400).send(actPage('Unknown action', '<p>That action is not available for this request.</p>'));
      return;
    }

    // Decline: swap partner, or the one person a cover request asked.
    if (action === 'decline' && (ctx.requestType === 'swap' || (ctx.requestType === 'pickup' && ctx.targetUserId))) {
      if (ctx.targetUserId !== me) {
        res.status(403).send(actPage('Not your request', '<p>This request was sent to someone else.</p>'));
        return;
      }
      const { rowCount } = await query(
        "UPDATE shift_requests SET status = 'declined', decided_at = now() WHERE id = $1 AND status = 'pending'",
        [id]
      );
      if (!rowCount) { decidedPage(); return; }
      const shift = await manualShift(companyId, ctx.shiftId);
      const typeWord = ctx.requestType === 'swap' ? 'swap' : 'pickup';
      notify({
        companyId, userIds: [ctx.requesterId], category: 'schedule', type: 'request_decided',
        title: `Your ${typeWord} request was declined`,
        body: shift
          ? `Your ${typeWord} request for ${shift.shiftTypeName} on ${fmtDateLong(shift.date)} was declined.`
          : `Your ${typeWord} request was declined.`,
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });
      res.send(actPage('Declined', '<p>Thank you — the requester has been told.</p>'));
      return;
    }

    // Swap partner agrees: the request moves to the schedulers.
    if (action === 'agree' && ctx.requestType === 'swap' && ctx.stage === 'partner') {
      if (ctx.targetUserId !== me) {
        res.status(403).send(actPage('Not your request', '<p>This request was sent to someone else.</p>'));
        return;
      }
      const { rowCount } = await query(
        "UPDATE shift_requests SET stage = 'admin' WHERE id = $1 AND status = 'pending' AND stage = 'partner'",
        [id]
      );
      if (!rowCount) { decidedPage(); return; }
      const myShift = await manualShift(companyId, ctx.shiftId);
      const theirShift = ctx.theirShiftId ? await manualShift(companyId, ctx.theirShiftId) : null;
      if (myShift) {
        const reqNames = await shiftDisplayNames(companyId, ctx.requesterId, myShift.shiftTypeId);
        const partNames = theirShift ? await shiftDisplayNames(companyId, me, theirShift.shiftTypeId) : null;
        notifyShiftRequestApprovers(companyId, { userId: ctx.requesterId, shiftTypeId: myShift.shiftTypeId }, me,
          'A shift request is waiting for a decision',
          `${reqNames.personName} proposed a swap (${myShift.shiftTypeName} on ${fmtDateLong(myShift.date)}${theirShift ? ` ↔ ${theirShift.shiftTypeName} on ${fmtDateLong(theirShift.date)}` : ''}) and ${partNames ? partNames.personName : 'the swap partner'} agreed. Final approval is yours.`);
        // Approver Approve/Reject email links for the admin stage (2026-11-03).
        sendShiftRequestApproverEmails(companyId, id, me).catch(() => {});
      }
      notify({
        companyId, userIds: [ctx.requesterId], category: 'schedule', type: 'request_decided',
        title: 'Your swap partner agreed',
        body: myShift
          ? `Your swap for ${myShift.shiftTypeName} on ${fmtDateLong(myShift.date)} is now with the schedulers for final approval.`
          : 'Your swap is now with the schedulers for final approval.',
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });
      res.send(actPage('Agreed', '<p>Thank you — the swap is now with the schedulers for final approval.</p>'));
      return;
    }

    // Cover pickup: the tap claims the shift (same guards as in-app).
    if (action === 'pickup' && ctx.requestType === 'pickup') {
      if (ctx.targetUserId) {
        if (ctx.targetUserId !== me) {
          res.status(403).send(actPage('Not your request', '<p>This request was sent to someone else.</p>'));
          return;
        }
      } else {
        // Broadcast: the token holder must still be on the live
        // recipient list — the same source of truth as the bells.
        const shift0 = await manualShift(companyId, ctx.shiftId);
        const { coverBroadcastRecipients } = await import('../util/requestForm.js');
        const recips = shift0
          ? await coverBroadcastRecipients(query, companyId, ctx.requesterId, { date: shift0.date, shiftTypeId: shift0.shiftTypeId, shiftTypeName: shift0.shiftTypeName })
          : [];
        if (!recips.some((p: any) => p.id === me)) {
          res.send(actPage('No longer available', '<p>This shift is no longer available for you to pick up.</p>'));
          return;
        }
      }
      const claimShift = await manualShift(companyId, ctx.shiftId);
      const claimNames = claimShift ? await shiftDisplayNames(companyId, me, claimShift.shiftTypeId) : null;
      try {
        await withTransaction(async (tx) => {
          const { rows: locked } = await tx.query(
            `SELECT request_type AS "requestType", shift_id AS "shiftId",
                    requester_id AS "requesterId", status
             FROM shift_requests WHERE id = $1 FOR UPDATE`,
            [id]
          );
          if (!locked.length || locked[0].status !== 'pending') {
            throw new RequestError(409, 'This request was just decided by someone else.');
          }
          const lr = locked[0];
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
          if (claimShift) {
            const conflict = await checkShiftConflict(tx.query, companyId, {
              userId: me,
              personName: claimNames?.personName || 'You',
              proposed: { date: claimShift.date, shiftTypeId: claimShift.shiftTypeId, shiftTypeName: claimShift.shiftTypeName },
            });
            if (conflict) {
              throw new RequestError(409, `You can't pick up this shift — ${conflict}`);
            }
          }
          await tx.query('UPDATE shifts SET user_id = $1 WHERE id = $2', [me, lr.shiftId]);
          await tx.query(
            "UPDATE shift_requests SET status = 'approved', decided_at = now() WHERE id = $1",
            [id]
          );
          await tx.query(
            `UPDATE shift_requests SET status = 'cancelled', decided_at = now()
             WHERE id <> $1 AND status = 'pending'
               AND (shift_id = $2 OR their_shift_id = $2)`,
            [id, lr.shiftId]
          );
        });
      } catch (err: any) {
        if (err instanceof RequestError) {
          res.send(actPage('Could not pick it up', '<p>' + escHtml(err.message) + '</p>'));
          return;
        }
        if (err?.code === '23505') {
          const note = claimShift ? await existingShiftNote(companyId, me, claimShift.date, claimShift.shiftTypeId) : '';
          res.send(actPage('Could not pick it up', '<p>' + escHtml(note || 'That would give you a duplicate shift — you already have that shift type on that date.') + '</p>'));
          return;
        }
        throw err;
      }
      notify({
        companyId, userIds: [ctx.requesterId], category: 'schedule', type: 'request_decided',
        title: 'Your pickup request was approved',
        body: claimShift
          ? `Your pickup request for ${claimShift.shiftTypeName} on ${fmtDateLong(claimShift.date)} was approved.`
          : 'Your pickup request was approved.',
        link: 'requests', bundleKey: 'request_decided',
        excludeUserId: me,
      });
      res.send(actPage("It's yours", '<p>The shift is on your schedule now. Thank you!</p>'));
      return;
    }

    res.status(400).send(actPage('Unknown action', '<p>That action is not available for this request.</p>'));
  } catch (err) {
    console.error('[schedule] act decision failed:', err);
    res.status(500).send(actPage('Something went wrong', '<p>Please try again, or answer in the app under Requests.</p>'));
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
  return {
    id: r.id, name: r.name, hasFeed: !!r.ics_url, icsUrl: r.ics_url || null, createdAt: r.created_at,
    // Migration 092: a details note (capacity / floor) and an active
    // flag — rooms are deactivated, not deleted, so old sessions keep
    // pointing at a real room.
    details: r.details || null,
    active: r.active !== false,
    // Migration 093: where the room came from. 'app' = ours;
    // 'google'/'microsoft' = synced (provider owns name/details);
    // 'imported-google'/'imported-microsoft' = detached by an
    // import — ours now, sync never touches it again.
    source: r.source || 'app',
    externalId: r.external_id || null,
    userDisabled: r.user_disabled === true,
    lastSyncedAt: r.last_synced_at || null,
  };
}

// Per-provider room-sync state for Settings (connected? last sync?
// last result?). Only google/microsoft carry rooms.
async function roomSyncSummary(companyId: string) {
  const out: any[] = [];
  for (const p of ['google', 'microsoft'] as const) {
    const integ = await getIntegration(companyId, p).catch(() => null);
    const state = await getRoomSyncState(companyId, p);
    out.push({
      provider: p, connected: !!integ,
      lastSyncAt: state.lastSyncAt, lastAttemptAt: state.lastAttemptAt,
      lastResult: state.lastResult,
    });
  }
  return out;
}

router.get('/rooms', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query('SELECT * FROM rooms WHERE company_id = $1 ORDER BY name', [companyId]);
    res.json({ rooms: rows.map(roomRow), sync: await roomSyncSummary(companyId) });
  } catch (err) {
    console.error('[schedule] list rooms failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rooms/sync {provider} — pull the provider's room
// list into our table now (mode A: keep both systems live).
router.post('/rooms/sync', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const provider = String((req.body ?? {}).provider || '');
    if (provider !== 'google' && provider !== 'microsoft') { res.status(400).json({ error: 'Unknown room service.' }); return; }
    const result = await syncRoomsForCompany(req.session.companyId!, provider);
    if (!result.ok) { res.status(502).json({ error: result.error || 'Sync failed.' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[schedule] rooms sync failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/rooms/import {provider} — one-time import that
// makes the rooms OURS (mode B: they can leave the other app).
router.post('/rooms/import', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const provider = String((req.body ?? {}).provider || '');
    if (provider !== 'google' && provider !== 'microsoft') { res.status(400).json({ error: 'Unknown room service.' }); return; }
    const result = await importRoomsForCompany(req.session.companyId!, provider, req.session.userId!);
    if (!result.ok) { res.status(502).json({ error: result.error || 'Import failed.' }); return; }
    res.json(result);
  } catch (err) {
    console.error('[schedule] rooms import failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function isSyncedRoom(r: any): boolean {
  return (r.source === 'google' || r.source === 'microsoft') && !!r.external_id;
}

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
    const details = b.details ? String(b.details).trim().slice(0, 200) : null;
    await query('INSERT INTO rooms (id, company_id, name, ics_url, created_by, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, companyId, name, icsUrl, req.session.userId!, details]);
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
    // Synced rooms (migration 093) belong to the source system: the
    // name/details are read-only here. The one local choice is
    // switching the room off/on — recorded as user_disabled so a
    // re-sync never turns it back on behind the user's back.
    if (isSyncedRoom(rows[0])) {
      const wantsRename = b.name !== undefined && String(b.name).trim() !== rows[0].name;
      const wantsDetails = b.details !== undefined && (b.details ? String(b.details).trim() : null) !== (rows[0].details || null);
      const wantsIcs = b.icsUrl !== undefined && (b.icsUrl ? String(b.icsUrl).trim() : null) !== (rows[0].ics_url || null);
      if (wantsRename || wantsDetails || wantsIcs) {
        const where = rows[0].source === 'google' ? 'Google' : 'Microsoft 365';
        res.status(400).json({ error: `This room is synced from ${where} — change its name or details there. (Or import it to manage it here.)` });
        return;
      }
      if (b.active !== undefined) {
        await query('UPDATE rooms SET active = $1, user_disabled = $2 WHERE id = $3', [!!b.active, !b.active, req.params.id]);
      }
      res.json({ ok: true });
      return;
    }
    const name = b.name !== undefined ? String(b.name).trim() : rows[0].name;
    if (!name) { res.status(400).json({ error: 'A room name is required.' }); return; }
    const icsUrl = b.icsUrl !== undefined ? (b.icsUrl ? String(b.icsUrl).trim() : null) : rows[0].ics_url;
    if (icsUrl && !/^https?:\/\//i.test(icsUrl)) { res.status(400).json({ error: 'The calendar link must start with http:// or https://' }); return; }
    const details = b.details !== undefined ? (b.details ? String(b.details).trim().slice(0, 200) : null) : rows[0].details;
    const active = b.active !== undefined ? !!b.active : rows[0].active !== false;
    await query('UPDATE rooms SET name = $1, ics_url = $2, details = $3, active = $4 WHERE id = $5', [name, icsUrl, details, active, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update room failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/rooms/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { rows } = await query('SELECT * FROM rooms WHERE id = $1 AND company_id = $2', [req.params.id, req.session.companyId!]);
    if (rows.length && isSyncedRoom(rows[0])) {
      // Deleting a synced room would just resurrect it at the next
      // sync — switching it off (which sync respects) is the way.
      res.status(400).json({ error: 'This room is synced — switch it off instead of deleting it. It stays off across syncs.' });
      return;
    }
    await query('DELETE FROM rooms WHERE id = $1 AND company_id = $2', [req.params.id, req.session.companyId!]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete room failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------- Communication groups (migration 094) ----------
// Named circles of people for COMMUNICATIONS only — no effect on
// shifts, schedules, or permissions. Members can come from ANY
// department mixed together. First use: the calendar event form's
// Beneficiaries area expands a picked group (client-side, snapshot)
// into ordinary beneficiary people — the session stores no group
// link, so editing a group never changes saved events.
//
// UNIFIED STORE (migration 096, Deepika 2026-11-07): comm groups
// live in message_groups with kind = 'system' — ONE group store,
// two kinds. kind='system' groups are managed ONLY through this
// section (owners/schedulers; Tools-bar panel + form creator) and
// are the only ones these endpoints list or touch; kind='chat'
// groups belong to Messages (anyone creates one there) and never
// surface here. A system group can also hold a Messages
// conversation — thread membership reads the same unified
// message_group_members table. CREATION has two doors: this
// section, and POST /messages/groups, where an owner/scheduler
// creating a group makes a system group too (her ruling: system
// groups are Communication groups, whoever's door they came
// through); employees creating there still make chat groups.
function commGroupName(r: any): string {
  return ([r.first_name, r.last_name].filter(Boolean).join(' ') || r.name || '').trim();
}

async function loadCommGroups(companyId: string) {
  const { rows: groups } = await query(
    "SELECT * FROM message_groups WHERE company_id = $1 AND kind = 'system' ORDER BY lower(name)", [companyId]);
  if (!groups.length) return [];
  const ids = groups.map((g: any) => g.id);
  const { rows: mem } = await query(
    `SELECT m.group_id, m.user_id, u.first_name, u.last_name, u.name, u.department_id, u.is_active
     FROM message_group_members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ANY($1::uuid[])
     ORDER BY u.first_name, u.last_name`,
    [ids]);
  const byGroup = new Map<string, any[]>();
  for (const r of mem) {
    if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, []);
    byGroup.get(r.group_id)!.push({
      userId: r.user_id, name: commGroupName(r), departmentId: r.department_id || null,
      isActive: r.is_active === true,
    });
  }
  return groups.map((g: any) => {
    const members = byGroup.get(g.id) || [];
    return {
      id: g.id, name: g.name, kind: g.kind, createdBy: g.created_by || null,
      createdAt: g.created_at, updatedAt: g.updated_at,
      memberCount: members.length,
      activeMemberCount: members.filter((mm: any) => mm.isActive).length,
      members,
    };
  });
}

// Members picked for a group must be ACTIVE members of the company
// (any department). Once stored, a member who is later deactivated
// stays on the row but is skipped when a group is expanded — so on
// edit, ids already stored on the group (keepIds) stay valid even if
// that person has since been deactivated.
async function cleanGroupMemberIds(companyId: string, raw: any, keepIds: string[] = []): Promise<string[] | { error: string }> {
  const ids = [...new Set((Array.isArray(raw) ? raw : []).map((x: any) => String(x)).filter(Boolean))];
  if (ids.length) {
    const { rows } = await query(
      'SELECT id FROM users WHERE company_id = $1 AND id = ANY($2::uuid[]) AND (is_active = true OR id = ANY($3::uuid[]))',
      [companyId, ids, keepIds]);
    if (rows.length !== ids.length) return { error: 'A group member is not an active team member.' };
  }
  return ids;
}

async function saveGroupMembers(groupId: string, memberIds: string[]) {
  await query('DELETE FROM message_group_members WHERE group_id = $1', [groupId]);
  for (const uid of memberIds) {
    await query('INSERT INTO message_group_members (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [groupId, uid]);
  }
}

router.get('/comm-groups', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    res.json({ groups: await loadCommGroups(req.session.companyId!) });
  } catch (err) {
    console.error('[schedule] list comm groups failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// The group creator's roster: every ACTIVE member of the company with
// their department — deliberately NOT department-access scoped, since
// a group may pull people from anywhere in the company. Managers only
// (the creator itself is managers-only).
router.get('/comm-groups/roster', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: depts } = await query(
      'SELECT id, name FROM departments WHERE company_id = $1 ORDER BY name', [companyId]);
    const { rows } = await query(
      `SELECT id, first_name, last_name, name, email, department_id FROM users
       WHERE company_id = $1 AND is_active = true ORDER BY first_name, last_name`,
      [companyId]);
    res.json({
      departments: depts.map((d: any) => ({ id: d.id, name: d.name })),
      members: rows.map((r: any) => ({ userId: r.id, name: commGroupName(r), departmentId: r.department_id || null, email: r.email, firstName: r.first_name })),
    });
  } catch (err) {
    console.error('[schedule] comm group roster failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/comm-groups', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const name = b.name ? String(b.name).trim().replace(/\s+/g, ' ') : '';
    if (!name) { res.status(400).json({ error: 'A group name is required.' }); return; }
    if (name.length > 80) { res.status(400).json({ error: 'Group names can be up to 80 characters.' }); return; }
    const companyId = req.session.companyId!;
    const { rows: dupe } = await query(
      "SELECT id FROM message_groups WHERE company_id = $1 AND kind = 'system' AND lower(name) = lower($2)", [companyId, name]);
    if (dupe.length) { res.status(400).json({ error: 'A group with that name already exists.' }); return; }
    const memberIds = await cleanGroupMemberIds(companyId, b.memberIds);
    if (!Array.isArray(memberIds)) { res.status(400).json(memberIds); return; }
    const id = crypto.randomUUID();
    await query("INSERT INTO message_groups (id, company_id, name, created_by, kind) VALUES ($1,$2,$3,$4,'system')",
      [id, companyId, name, req.session.userId!]);
    await saveGroupMembers(id, memberIds);
    res.json({ ok: true, id });
  } catch (err) {
    console.error('[schedule] create comm group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.put('/comm-groups/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const companyId = req.session.companyId!;
    const { rows } = await query("SELECT * FROM message_groups WHERE id = $1 AND company_id = $2 AND kind = 'system'", [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Group not found.' }); return; }
    const name = b.name !== undefined ? String(b.name).trim().replace(/\s+/g, ' ') : rows[0].name;
    if (!name) { res.status(400).json({ error: 'A group name is required.' }); return; }
    if (name.length > 80) { res.status(400).json({ error: 'Group names can be up to 80 characters.' }); return; }
    if (name !== rows[0].name) {
      const { rows: dupe } = await query(
        "SELECT id FROM message_groups WHERE company_id = $1 AND kind = 'system' AND lower(name) = lower($2) AND id <> $3",
        [companyId, name, req.params.id]);
      if (dupe.length) { res.status(400).json({ error: 'A group with that name already exists.' }); return; }
    }
    let memberIds: string[] | null = null;
    if (b.memberIds !== undefined) {
      const { rows: cur } = await query('SELECT user_id FROM message_group_members WHERE group_id = $1', [req.params.id]);
      const cleaned = await cleanGroupMemberIds(companyId, b.memberIds, cur.map((r: any) => r.user_id));
      if (!Array.isArray(cleaned)) { res.status(400).json(cleaned); return; }
      memberIds = cleaned;
    }
    await query("UPDATE message_groups SET name = $1, updated_at = now() WHERE id = $2 AND kind = 'system'", [name, req.params.id]);
    if (memberIds) await saveGroupMembers(req.params.id, memberIds);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] update comm group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/comm-groups/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    // Deleting a system group deletes the group outright — including
    // any Messages thread on it (messages.group_id cascades), the
    // same end state as deleting a group from Messages.
    await query("DELETE FROM message_groups WHERE id = $1 AND company_id = $2 AND kind = 'system'", [req.params.id, req.session.companyId!]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete comm group failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// --- ICS feed parsing (small, purpose-built) ---
type IcsEvent = { start: Date; end: Date; summary: string; rrule: string | null; allDay: boolean };
const icsCache = new Map<string, { at: number; events: IcsEvent[] }>();

export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): Date {
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

// ---------- Room bookings (migration 092) ----------
// A session HOLDS one of our rooms when it points at it (room_id),
// or — for sessions saved before room_id existed — when its location
// text is the room's name. Availability is computed from our own
// sessions: series are expanded per date and per-date overrides are
// honoured (a cancelled / re-located / re-timed date doesn't hold
// the room). A room with a linked ICS calendar also counts blocks
// from that feed as bookings. Saving a session into a held room is
// REFUSED (the double-book guard below) — no override.

async function companyTimezone(companyId: string): Promise<string> {
  const { rows } = await query(
    `SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`, [companyId]);
  const tz = rows.length ? String(rows[0].value || '') : '';
  return /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/.test(tz) ? tz : 'UTC';
}

// Does `base` (an academicRow-shaped session) hold the room on
// dateStr? Returns the effective time window or null.
function roomHoldOn(base: any, ov: any | null, roomName: string, roomId: string | null, dateStr: string):
  { startMin: number | null; endMin: number | null; allDay: boolean } | null {
  if (!sessionOccursOn(base, dateStr)) return null;
  if (ov && ov.cancelled) return null;
  let loc = base.location || null;
  if (ov && ov.has_location) {
    // This date sits somewhere else (a text location): it holds the
    // room only if that text IS the room's name.
    loc = ov.location;
    if (!loc || String(loc).toLowerCase() !== roomName.toLowerCase()) return null;
    let st2 = ov.has_times ? ov.start_time : base.startTime;
    let et2 = ov.has_times ? ov.end_time : base.endTime;
    const s2 = timeToMin(st2);
    return { startMin: s2, endMin: timeToMin(et2), allDay: s2 === null };
  }
  const byId = !!roomId && base.roomId === roomId;
  const byName = !base.roomId && !!loc && String(loc).toLowerCase() === roomName.toLowerCase();
  if (!byId && !byName) return null;
  let st = base.startTime, et = base.endTime;
  if (ov && ov.has_times) { st = ov.start_time; et = ov.end_time; }
  const sMin = timeToMin(st);
  return { startMin: sMin, endMin: timeToMin(et), allDay: sMin === null };
}

interface RoomHolderData { bases: any[]; ovBy: Map<string, Map<string, any>>; }

async function loadRoomHolderData(companyId: string, room: { id: string; name: string }, throughDate: string, excludeSessionId?: string | null): Promise<RoomHolderData> {
  const { rows } = await query(
    `SELECT * FROM academic_sessions WHERE company_id = $1
       AND (room_id = $2 OR (room_id IS NULL AND lower(location) = lower($3)))
       AND session_date <= $4`,
    [companyId, room.id, room.name, throughDate]);
  const bases = rows.map(academicRow).filter((b: any) => !excludeSessionId || b.id !== excludeSessionId);
  const ovBy = new Map<string, Map<string, any>>();
  if (bases.length) {
    const { rows: ovs } = await query(
      'SELECT * FROM academic_session_overrides WHERE company_id = $1 AND session_id = ANY($2)',
      [companyId, bases.map((b: any) => b.id)]);
    for (const o of ovs) {
      const ds = o.date instanceof Date ? o.date.toISOString().slice(0, 10) : String(o.date).slice(0, 10);
      if (!ovBy.has(o.session_id)) ovBy.set(o.session_id, new Map());
      ovBy.get(o.session_id)!.set(ds, o);
    }
  }
  return { bases, ovBy };
}

function roomHoldersOn(data: RoomHolderData, room: { id: string; name: string }, dateStr: string) {
  const out: { sessionId: string; title: string; startMin: number | null; endMin: number | null; allDay: boolean }[] = [];
  for (const base of data.bases) {
    const ov = (data.ovBy.get(base.id) || new Map()).get(dateStr) || null;
    const hold = roomHoldOn(base, ov, room.name, room.id, dateStr);
    if (hold) out.push({ sessionId: base.id, title: base.title, ...hold });
  }
  return out;
}

function windowOverlapsHold(winS: number | null, winE: number | null, hold: { startMin: number | null; endMin: number | null; allDay: boolean }): boolean {
  if (hold.allDay) return true;
  if (winS === null) return true; // a whole-day query touches any timed hold
  const hs = hold.startMin!;
  const he = hold.endMin !== null ? hold.endMin : hs + 60;
  const we = winE !== null ? winE : winS + 60;
  return winS < he && we > hs;
}

// Busy blocks from the room's linked ICS calendar overlapping the
// [winStartUtc, winEndUtc) window. Best-effort: a dead feed is not a
// booking.
async function roomFeedConflict(room: { ics_url?: string | null }, winStartUtc: Date, winEndUtc: Date): Promise<{ title: string } | null> {
  if (!room.ics_url) return null;
  try {
    const events = await fetchIcsEvents(room.ics_url);
    // Pad a day either side so blocks straddling the window are seen.
    const dayStart = new Date(winStartUtc.getTime() - 86400000);
    const dayEnd = new Date(winEndUtc.getTime() + 86400000);
    for (const ev of events) {
      for (const b of icsBlocksOn(ev, dayStart, dayEnd)) {
        if (b.start.getTime() < winEndUtc.getTime() && b.end.getTime() > winStartUtc.getTime()) {
          return { title: ev.summary || 'Busy' };
        }
      }
    }
  } catch { /* a broken feed never blocks a save */ }
  return null;
}

// The double-book guard: would saving a session with this shape
// into `room` collide with an existing hold (or the room's linked
// calendar)? Returns the holding session's title (+ date for a
// series) or null.
async function findRoomConflict(companyId: string, room: { id: string; name: string; ics_url?: string | null }, cand: {
  date: string; startTime: any; endTime: any;
  recurRule: string; recurInterval: number; recurDays: number[]; recurUntil: string | null; recurCount: number | null;
}, excludeSessionId?: string | null): Promise<{ title: string; date: string } | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cand.date || '')) return null;
  const winS = timeToMin(cand.startTime), winE = timeToMin(cand.endTime);
  // Enumerate the candidate's occurrence dates (bounded scan).
  const candBase: any = {
    date: cand.date, recurRule: cand.recurRule, recurInterval: cand.recurInterval,
    recurDays: cand.recurDays, recurUntil: cand.recurUntil, recurCount: cand.recurCount,
  };
  const occDates: string[] = [];
  const startMs = new Date(cand.date + 'T00:00:00Z').getTime();
  for (let i = 0; i < 1100; i++) {
    const ds = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    if (cand.recurUntil && ds > cand.recurUntil) break;
    if (sessionOccursOn(candBase, ds)) occDates.push(ds);
    if (cand.recurRule === 'none') break;
  }
  if (!occDates.length) return null;
  const lastDate = occDates[occDates.length - 1];
  const data = await loadRoomHolderData(companyId, room, lastDate, excludeSessionId);
  const tz = await companyTimezone(companyId);
  for (const ds of occDates) {
    for (const h of roomHoldersOn(data, room, ds)) {
      if (windowOverlapsHold(winS, winE, h)) return { title: h.title, date: ds };
    }
    if (room.ics_url) {
      const wStart = wallTimeToUtc(ds, winS !== null ? cand.startTime : '00:00', tz);
      const wEnd = winS !== null
        ? wallTimeToUtc(cand.endTime && winE !== null && winE <= winS ? nextDateStr(ds) : ds, cand.endTime || cand.startTime, tz)
        : wallTimeToUtc(nextDateStr(ds), '00:00', tz);
      const feed = await roomFeedConflict(room, wStart, wEnd);
      if (feed) return { title: feed.title, date: ds };
    }
  }
  return null;
}

function nextDateStr(ds: string): string {
  return new Date(new Date(ds + 'T00:00:00Z').getTime() + 86400000).toISOString().slice(0, 10);
}

// Clean the room selection a session save posts (migration 092):
// an in-app room (roomId), a connected room (roomSource +
// roomExternalId), or nothing. For an in-app room the server is
// authoritative for the name — location text becomes the room name.
async function cleanRoomSelection(companyId: string, b: any): Promise<
  { roomId: string | null; roomSource: string | null; roomExternalId: string | null; roomName: string | null } | { error: string }> {
  if (b.roomId) {
    const { rows } = await query('SELECT id, name, ics_url, active, source, external_id FROM rooms WHERE id = $1 AND company_id = $2', [String(b.roomId), companyId]);
    if (!rows.length) return { error: 'That room no longer exists.' };
    if (rows[0].active === false) return { error: 'That room is not in use anymore — pick another.' };
    // A synced room (migration 093) stamps its provider source + id,
    // so the session knows exactly which provider room it holds (a
    // generated Google Meet still adds it as a resource attendee);
    // our own rooms (incl. imported ones) stamp 'app'.
    const src = rows[0].source;
    if ((src === 'google' || src === 'microsoft') && rows[0].external_id) {
      return { roomId: rows[0].id, roomSource: src, roomExternalId: String(rows[0].external_id), roomName: rows[0].name };
    }
    return { roomId: rows[0].id, roomSource: 'app', roomExternalId: null, roomName: rows[0].name };
  }
  if ((b.roomSource === 'google' || b.roomSource === 'microsoft') && b.roomExternalId) {
    return { roomId: null, roomSource: b.roomSource, roomExternalId: String(b.roomExternalId).slice(0, 300), roomName: null };
  }
  return { roomId: null, roomSource: null, roomExternalId: null, roomName: null };
}

async function roomRowById(companyId: string, roomId: string): Promise<any | null> {
  const { rows } = await query('SELECT id, name, ics_url FROM rooms WHERE id = $1 AND company_id = $2', [roomId, companyId]);
  return rows.length ? rows[0] : null;
}

// GET /api/schedule/rooms/availability?date&start&end&excludeSessionId
// — every ACTIVE room with its status for that window, computed from
// our own sessions (plus linked-calendar blocks). Powers the session
// form's Room picker.
router.get('/rooms/availability', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' }); return; }
    const winS = timeToMin(req.query.start ? String(req.query.start).slice(0, 5) : null);
    const winE = timeToMin(req.query.end ? String(req.query.end).slice(0, 5) : null);
    const excludeSessionId = req.query.excludeSessionId ? String(req.query.excludeSessionId).split('@@')[0] : null;
    // Picker data requested — a stale provider sync refreshes in the
    // background (migration 093, lazy >24h), never blocking this.
    maybeLazySyncRooms(companyId);
    const { rows: roomRows } = await query(
      'SELECT * FROM rooms WHERE company_id = $1 AND active = true ORDER BY name', [companyId]);
    const tz = await companyTimezone(companyId);
    // Synced rooms (migration 093): availability MERGES our own
    // sessions' holds with the provider's LIVE free/busy for the same
    // room. Fetch each needed provider once for the whole list.
    const extStatus = new Map<string, 'available' | 'booked'>();
    {
      const syncedProviders = [...new Set(roomRows
        .filter((r: any) => (r.source === 'google' || r.source === 'microsoft') && r.external_id)
        .map((r: any) => r.source))] as RoomProvider[];
      if (syncedProviders.length) {
        const startUtc = wallTimeToUtc(date, winS !== null ? String(req.query.start) : '00:00', tz);
        let endUtc: Date;
        if (winS !== null) {
          const endDate = winE !== null && winE <= winS ? nextDateStr(date) : date;
          endUtc = wallTimeToUtc(endDate, String(req.query.end || req.query.start), tz);
          if (endUtc.getTime() <= startUtc.getTime()) endUtc = new Date(startUtc.getTime() + 3600000);
        } else {
          endUtc = wallTimeToUtc(nextDateStr(date), '00:00', tz);
        }
        for (const p of syncedProviders) {
          const live = await fetchConnectedRooms(companyId, p, startUtc, endUtc);
          for (const lr of live.rooms) extStatus.set(`${p}:${lr.externalId}`, lr.status);
        }
      }
    }
    const out: any[] = [];
    for (const room of roomRows) {
      const data = await loadRoomHolderData(companyId, room, date, excludeSessionId);
      let bookedBy: string | null = null;
      for (const h of roomHoldersOn(data, room, date)) {
        if (windowOverlapsHold(winS, winE, h)) { bookedBy = h.title; break; }
      }
      if (!bookedBy && room.ics_url) {
        const wStart = wallTimeToUtc(date, winS !== null ? String(req.query.start) : '00:00', tz);
        const wEnd = winS !== null
          ? wallTimeToUtc(winE !== null && winE <= winS ? nextDateStr(date) : date, String(req.query.end || req.query.start), tz)
          : wallTimeToUtc(nextDateStr(date), '00:00', tz);
        const feed = await roomFeedConflict(room, wStart, wEnd);
        if (feed) bookedBy = feed.title;
      }
      // Provider says the synced room is busy at this time → Booked
      // too (advisory for saves: the hard guard stays our-side only).
      let externalBooked = false;
      if (!bookedBy && room.external_id && (room.source === 'google' || room.source === 'microsoft')) {
        externalBooked = extStatus.get(`${room.source}:${room.external_id}`) === 'booked';
      }
      out.push({
        id: room.id, name: room.name, details: room.details || null,
        source: room.source || 'app', externalId: room.external_id || null,
        status: bookedBy || externalBooked ? 'booked' : 'available',
        bookedByTitle: bookedBy,
        externalBooked,
      });
    }
    res.json({ date, rooms: out });
  } catch (err) {
    console.error('[schedule] rooms availability failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/rooms/connected?date&start&end&timezone — the
// Room picker's connected sections: rooms from the company's Google
// Workspace / Microsoft 365 with live free/busy. Best-effort: an
// unconnected or failing provider simply doesn't appear (or appears
// with a muted note) — this endpoint never 500s on provider trouble.
router.get('/rooms/connected', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A date (YYYY-MM-DD) is required.' }); return; }
    const tzRaw = String(req.query.timezone || '');
    const tz = /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/.test(tzRaw) ? tzRaw : await companyTimezone(companyId);
    const start = req.query.start ? String(req.query.start).slice(0, 5) : null;
    const end = req.query.end ? String(req.query.end).slice(0, 5) : null;
    const startUtc = wallTimeToUtc(date, start || '00:00', tz);
    let endUtc: Date;
    if (start) {
      const endDate = end && timeToMin(end) !== null && timeToMin(end)! <= timeToMin(start)! ? nextDateStr(date) : date;
      endUtc = wallTimeToUtc(endDate, end || start, tz);
      if (endUtc.getTime() <= startUtc.getTime()) endUtc = new Date(startUtc.getTime() + 3600000);
    } else {
      endUtc = wallTimeToUtc(nextDateStr(date), '00:00', tz);
    }
    maybeLazySyncRooms(companyId);
    const providers: any[] = [];
    for (const p of ['google', 'microsoft'] as const) {
      // Once a provider's rooms are SYNCED into our table (migration
      // 093), the picker serves them from the table (in the OUR ROOMS
      // list, via /rooms/availability) — listing them here too would
      // show every room twice.
      if (await hasSyncedRooms(companyId, p)) continue;
      const r = await fetchConnectedRooms(companyId, p, startUtc, endUtc);
      if (r.connected) providers.push({ provider: p, rooms: r.rooms, note: r.note });
    }
    res.json({ date, providers });
  } catch (err) {
    console.error('[schedule] connected rooms failed:', err);
    res.json({ date: String(req.query.date || ''), providers: [] });
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

// ---------- Dashboard archive + delete requests (migration 090) ----------
// "Delete" a dashboard = ARCHIVE it (Deepika, 2026-11-07): the row and
// every session on it stay saved, hidden from all live surfaces, and
// restorable from Settings. The owner archives immediately; a
// scheduler's delete is a REQUEST that the first OTHER admin of the
// dashboard's departments (or the owner) approves — a rejection or the
// requester's own cancel closes it with nothing archived.

async function dashboardRowById(companyId: string, dashboardId: string): Promise<any | null> {
  const { rows } = await query(
    'SELECT id, name, archived_at, archived_by FROM dashboards WHERE id = $1 AND company_id = $2',
    [dashboardId, companyId]);
  return rows.length ? rows[0] : null;
}

async function isDashboardArchived(dashboardId: string | null | undefined): Promise<boolean> {
  if (!dashboardId) return false;
  const { rows } = await query('SELECT archived_at FROM dashboards WHERE id = $1', [dashboardId]);
  return !!(rows.length && rows[0].archived_at);
}

async function userDisplayName(userId: string | null | undefined): Promise<string> {
  if (!userId) return 'Someone';
  const { rows } = await query('SELECT first_name, last_name, nickname, email FROM users WHERE id = $1', [userId]);
  if (!rows.length) return 'Someone';
  const u = rows[0];
  return u.nickname || [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || 'Someone';
}

// Who may approve a dashboard delete request (besides the requester,
// who never can): every owner of the company, plus schedulers holding
// Edit access on ANY of the dashboard's departments. A dashboard with
// NO departments spans the whole company, so every scheduler counts.
async function dashboardDeleteApproverIds(companyId: string, dashboardId: string): Promise<string[]> {
  const { rows: owners } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true`, [companyId]);
  const ids = owners.map((r: any) => r.id);
  const dIds = await dashboardDeptIds(dashboardId);
  const { rows: scheds } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'scheduler' AND is_active = true`, [companyId]);
  for (const s of scheds) {
    if (!dIds.length) { ids.push(s.id); continue; }
    const access = await getDepartmentAccess(s.id, companyId);
    if ((access.edit || []).some((d) => dIds.includes(d))) ids.push(s.id);
  }
  return [...new Set(ids)];
}

async function pendingDeleteRequest(dashboardId: string): Promise<any | null> {
  const { rows } = await query(
    `SELECT id, requested_by, created_at FROM dashboard_delete_requests
     WHERE dashboard_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
    [dashboardId]);
  return rows.length ? rows[0] : null;
}

async function archiveDashboardRow(dashboardId: string, archivedBy: string): Promise<void> {
  await query('UPDATE dashboards SET archived_at = now(), archived_by = $2 WHERE id = $1', [dashboardId, archivedBy]);
}

// Write gate for the session endpoints: nothing on an archived
// dashboard can be created, edited, claimed, RSVP'd or deleted —
// restore the dashboard from Settings first. Returns true (and has
// already answered 409) when the write is blocked.
async function sessionWriteBlocked(res: Response, dashboardId: string | null | undefined): Promise<boolean> {
  if (await isDashboardArchived(dashboardId)) {
    res.status(409).json({ error: 'That dashboard is archived — restore it from Settings → Dashboards to make changes.' });
    return true;
  }
  return false;
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

// Sessions inherit their calendar's department(s) (Deepika, 2026-11-07):
// a session saved on a dashboard carries department_id NULL and every
// department-scoped rule falls back to the dashboard's departments —
// the same "session's department, else its calendar's" pattern the
// offer audience already used. Sessions saved before this change keep
// their own department_id and follow it.

// Edit gate via the calendar's departments (used when the session has
// no department of its own): Edit access to ANY of the dashboard's
// departments; an unrestricted dashboard needs any Edit department.
async function dashboardDeptEditCheck(req: Request, res: Response, dashboardId: string): Promise<boolean> {
  if (req.session.role !== 'scheduler') { res.status(403).json({ error: 'You do not have permission to do that.' }); return false; }
  const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
  const editDepts = access.edit || [];
  const dIds = await dashboardDeptIds(dashboardId);
  if (!editDepts.length || (dIds.length && !dIds.some((d) => editDepts.includes(d)))) {
    res.status(403).json({ error: 'You do not have Edit access to this calendar\'s departments.' });
    return false;
  }
  return true;
}

async function canEditDashboardDeptsQuiet(req: Request, dashboardId: string): Promise<boolean> {
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
  if (departmentId) return academicDeptCheck(req, res, departmentId);
  if (dashboardId) return dashboardDeptEditCheck(req, res, dashboardId);
  return academicDeptCheck(req, res, departmentId);
}

// Quiet version of sessionEditCheck for loops (no response writes):
// owner yes; editors list (when set) decides; otherwise the
// scheduler needs Edit access to the session's department — or, for
// inherit-model sessions, to any of the calendar's departments.
async function canEditSessionQuiet(req: Request, dashboardId: string | null, departmentId: string | null): Promise<boolean> {
  const role = req.session.role!;
  if (role === 'owner') return true;
  if (role !== 'scheduler') return false;
  if (dashboardId) {
    const editors = await dashboardEditorIds(dashboardId);
    if (editors.length) return editors.includes(req.session.userId!);
  }
  if (departmentId) {
    const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
    return (access.edit || []).includes(departmentId);
  }
  if (dashboardId) return canEditDashboardDeptsQuiet(req, dashboardId);
  return false;
}

// EVENT model (Deepika, 2026-11-07): the departments this user may
// ORGANIZE events for on a calendar = their Edit-access departments ∩
// the calendar's departments (an unrestricted calendar → their Edit
// departments; owner → the calendar's departments, or every company
// department when unrestricted). When the dashboard has an editors
// list and the user is on it, they may organize for any of the
// calendar's departments — the editors list already overrides the
// department-edit check for session saves.
async function manageableOrgDeptIds(req: Request, dashboardId: string): Promise<string[]> {
  const companyId = req.session.companyId!;
  const dIds = await dashboardDeptIds(dashboardId);
  const allDepts = async (): Promise<string[]> => {
    const { rows } = await query('SELECT id FROM departments WHERE company_id = $1', [companyId]);
    return rows.map((r: any) => r.id);
  };
  if (req.session.role === 'owner') return dIds.length ? dIds : allDepts();
  if (req.session.role !== 'scheduler') return [];
  const editors = await dashboardEditorIds(dashboardId);
  if (editors.length) {
    if (!editors.includes(req.session.userId!)) return [];
    return dIds.length ? dIds : allDepts();
  }
  const access = await getDepartmentAccess(req.session.userId!, companyId);
  const editDepts = access.edit || [];
  if (!dIds.length) return editDepts;
  return editDepts.filter((d) => dIds.includes(d));
}

// Context for the guest-speaker details email (names resolved once).
async function guestMailCtx(req: Request, s: {
  dashboardId: string | null; departmentId: string | null; title: string;
  date: string; startTime: string | null; endTime: string | null;
  location: string | null; meetingUrl: string | null; recurText: string | null;
}) {
  const companyId = req.session.companyId!;
  const { rows: cRows } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
  const { rows: meRows } = await query('SELECT first_name, last_name FROM users WHERE id = $1', [req.session.userId]);
  let dashboardName: string | null = null;
  if (s.dashboardId) {
    const { rows } = await query('SELECT name FROM dashboards WHERE id = $1', [s.dashboardId]);
    dashboardName = rows[0]?.name || null;
  }
  let departmentName: string | null = null;
  if (s.departmentId) {
    const { rows } = await query('SELECT name FROM departments WHERE id = $1', [s.departmentId]);
    departmentName = rows[0]?.name || null;
  }
  return {
    companyId,
    companyName: cRows[0]?.name || 'your team',
    saverName: meRows[0] ? [meRows[0].first_name, meRows[0].last_name].filter(Boolean).join(' ') : 'A teammate',
    dashboardName, departmentName,
    title: s.title, date: s.date, startTime: s.startTime, endTime: s.endTime,
    location: s.location, meetingUrl: s.meetingUrl, recurText: s.recurText,
  };
}

async function validateDashboardEditors(companyId: string, ids: any): Promise<string[] | null> {
  if (!ids || !Array.isArray(ids) || ids.length === 0) return [];
  const want = ids.map((x: any) => String(x));
  const { rows } = await query('SELECT id FROM users WHERE company_id = $1 AND id = ANY($2) AND is_active = true', [companyId, want]);
  if (rows.length !== want.length) return null;
  return rows.map((r: any) => r.id);
}

async function visibleDashboardIds(req: Request, includeArchived = false): Promise<string[] | null> {
  const companyId = req.session.companyId!;
  const deptIds = await academicVisibleDeptIds(req);
  if (deptIds === null) return null; // owner sees everything
  // No early return for an empty deptIds: a dashboard with NO department
  // restriction is visible to everyone (the loop's first condition) —
  // a team member without a department (or a scheduler with no view
  // access yet) still gets those dashboards. (Bug found 2026-10-20:
  // returning [] here hid every dashboard from dept-less employees.)
  // Archived dashboards are history, not live calendars: excluded
  // unless the caller is the Settings manager asking for them.
  const { rows } = await query(
    `SELECT id FROM dashboards WHERE company_id = $1 ${includeArchived ? '' : 'AND archived_at IS NULL'}`,
    [companyId]);
  const out: string[] = [];
  for (const r of rows) {
    const dIds = await dashboardDeptIds(r.id);
    if (dIds.length === 0 || dIds.some((d) => deptIds.includes(d))) out.push(r.id);
  }
  return out;
}

// GET /api/schedule/dashboards — all roles, scoped like sessions.
// Archived dashboards are excluded everywhere by default; the
// Settings manager passes ?includeArchived=1 (owner/scheduler only)
// to also get them, flagged, for the Archived section. Rows carry any
// pending delete request so Settings can render its state.
router.get('/dashboards', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const includeArchived = req.query.includeArchived === '1' && req.session.role !== 'employee';
    const visible = await visibleDashboardIds(req, includeArchived);
    const params: any[] = [companyId];
    let clause = 'WHERE d.company_id = $1';
    if (visible) {
      params.push(visible);
      clause += ` AND d.id = ANY($${params.length})`;
    }
    if (!includeArchived) clause += ' AND d.archived_at IS NULL';
    const { rows } = await query(
      `SELECT d.id, d.name, d.created_at, d.archived_at, d.archived_by, d.interview_link_url, d.interview_link_label,
              (SELECT array_agg(dd.department_id) FROM dashboard_departments dd WHERE dd.dashboard_id = d.id) AS department_ids
       FROM dashboards d ${clause} ORDER BY d.created_at`, params);
    // Interview platform link (migration 092): the company switch
    // travels with the list so every client surface can gate on it.
    const { rows: compRows } = await query('SELECT residency_program FROM companies WHERE id = $1', [companyId]);
    const residencyProgram = !!(compRows.length && compRows[0].residency_program);
    const out: any[] = [];
    for (const r of rows) {
      const row: any = {
        id: r.id, name: r.name, createdAt: r.created_at,
        interviewLinkUrl: residencyProgram ? (r.interview_link_url || null) : null,
        interviewLinkLabel: residencyProgram ? (r.interview_link_label || 'Interviews') : null,
        departmentIds: r.department_ids || [],
        editorIds: await dashboardEditorIds(r.id),
        canEdit: await dashboardEditAllowed(req, r.id),
        archivedAt: r.archived_at || null,
        archivedByName: r.archived_at ? await userDisplayName(r.archived_by) : null,
        pendingDeleteRequest: null,
      };
      if (!r.archived_at && req.session.role !== 'employee') {
        const pend = await pendingDeleteRequest(r.id);
        if (pend) {
          const approvers = await dashboardDeleteApproverIds(companyId, r.id);
          row.pendingDeleteRequest = {
            id: pend.id,
            requestedBy: pend.requested_by,
            requestedByName: await userDisplayName(pend.requested_by),
            createdAt: pend.created_at,
            mine: pend.requested_by === req.session.userId,
            canApprove: pend.requested_by !== req.session.userId && approvers.includes(req.session.userId!),
          };
        }
      }
      out.push(row);
    }
    res.json({ dashboards: out, residencyProgram });
  } catch (err) {
    console.error('[schedule] dashboards list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/company-residency — the "We run a residency
// program" switch (owner only, migration 092). Default OFF: other
// businesses never see the interview-link feature at all.
router.put('/company-residency', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const on = !!(req.body && req.body.on);
    await query('UPDATE companies SET residency_program = $1 WHERE id = $2', [on, req.session.companyId!]);
    res.json({ ok: true, residencyProgram: on });
  } catch (err) {
    console.error('[schedule] company residency update failed:', err);
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
    const { rows } = await query('SELECT id, archived_at FROM dashboards WHERE id = $1 AND company_id = $2', [req.params.id, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Dashboard not found.' }); return; }
    if (rows[0].archived_at) { res.status(409).json({ error: 'That dashboard is archived — restore it to make changes.' }); return; }
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
    // Interview platform link (migration 092): saved only while the
    // company's residency switch is on — the fields don't exist for
    // other businesses, so a stale form can't set one behind it.
    if (req.body?.interviewLinkUrl !== undefined || req.body?.interviewLinkLabel !== undefined) {
      const { rows: compRows } = await query('SELECT residency_program FROM companies WHERE id = $1', [companyId]);
      if (compRows.length && compRows[0].residency_program) {
        const url = req.body?.interviewLinkUrl !== undefined
          ? (req.body.interviewLinkUrl ? String(req.body.interviewLinkUrl).trim().slice(0, 500) : null) : undefined;
        if (url && !/^https?:\/\//i.test(url)) { res.status(400).json({ error: 'The interview link must start with http:// or https://' }); return; }
        const label = req.body?.interviewLinkLabel !== undefined
          ? (req.body.interviewLinkLabel ? String(req.body.interviewLinkLabel).trim().slice(0, 60) : null) : undefined;
        if (url !== undefined) await query('UPDATE dashboards SET interview_link_url = $1 WHERE id = $2', [url, req.params.id]);
        if (label !== undefined) await query('UPDATE dashboards SET interview_link_label = $1 WHERE id = $2', [label, req.params.id]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] dashboard update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/dashboards/:id — "delete" = ARCHIVE, never a
// hard delete (Deepika, 2026-11-07; migration 090). The owner archives
// immediately. A scheduler files a delete REQUEST instead: every other
// admin of the dashboard's departments (plus the owners) is belled,
// and the first of them to approve archives it. Sessions keep their
// rows and their dashboard_id — the whole calendar is history in the
// archive, restorable from Settings.
router.delete('/dashboards/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const me = req.session.userId!;
    const dash = await dashboardRowById(companyId, req.params.id);
    if (!dash) { res.status(404).json({ error: 'Dashboard not found.' }); return; }
    if (dash.archived_at) { res.status(409).json({ error: 'That dashboard is already archived.' }); return; }
    if (req.session.role === 'owner') {
      await archiveDashboardRow(dash.id, me);
      // A direct owner archive settles any pending request as approved.
      await query(
        `UPDATE dashboard_delete_requests SET status = 'approved', decided_by = $2, decided_at = now()
         WHERE dashboard_id = $1 AND status = 'pending'`, [dash.id, me]);
      await auditLog({
        companyId, date: todayStr(), action: 'archived', category: 'settings',
        source: 'manual', changedBy: me,
        description: `Archived the dashboard "${dash.name}"`,
      });
      res.json({ ok: true, archived: true });
      return;
    }
    const existing = await pendingDeleteRequest(dash.id);
    if (existing) {
      res.status(409).json({ error: 'A delete request for this dashboard is already waiting for approval.' });
      return;
    }
    const { rows } = await query(
      `INSERT INTO dashboard_delete_requests (company_id, dashboard_id, requested_by)
       VALUES ($1, $2, $3) RETURNING id`,
      [companyId, dash.id, me]);
    const myName = await userDisplayName(me);
    const approvers = await dashboardDeleteApproverIds(companyId, dash.id);
    notify({
      companyId, userIds: approvers, category: 'approvals', type: 'dashboard_delete_request',
      title: `${myName} asked to delete the dashboard "${dash.name}"`,
      body: `${myName} asked to delete the dashboard "${dash.name}". Review it in Settings → Dashboards — the first admin to approve archives it.`,
      link: 'settings/dashboards',
      excludeUserId: me,
    });
    await auditLog({
      companyId, date: todayStr(), action: 'delete_requested', category: 'settings',
      source: 'manual', changedBy: me,
      description: `Asked to delete the dashboard "${dash.name}"`,
    });
    res.json({ ok: true, requested: true, requestId: rows[0].id });
  } catch (err: any) {
    if (err?.code === '23505') { // one-pending-per-dashboard race
      res.status(409).json({ error: 'A delete request for this dashboard is already waiting for approval.' });
      return;
    }
    console.error('[schedule] dashboard delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Shared loader for the delete-request decision endpoints: resolves
// the dashboard + its pending request, and whether THIS caller may
// decide it (an eligible approver who is not the requester).
async function loadDecidableRequest(req: Request, res: Response): Promise<any | null> {
  const companyId = req.session.companyId!;
  const dash = await dashboardRowById(companyId, req.params.id);
  if (!dash) { res.status(404).json({ error: 'Dashboard not found.' }); return null; }
  if (dash.archived_at) { res.status(409).json({ error: 'That dashboard is already archived.' }); return null; }
  const pend = await pendingDeleteRequest(dash.id);
  if (!pend) { res.status(409).json({ error: 'There is no pending delete request for this dashboard.' }); return null; }
  if (pend.requested_by === req.session.userId) {
    res.status(403).json({ error: "You can't decide your own delete request — another admin has to." });
    return null;
  }
  const approvers = await dashboardDeleteApproverIds(companyId, dash.id);
  if (!approvers.includes(req.session.userId!)) {
    res.status(403).json({ error: 'Only an admin of this dashboard\'s departments (or the owner) can decide this request.' });
    return null;
  }
  return { companyId, dash, pend };
}

// POST /api/schedule/dashboards/:id/delete-request/approve — archive
// the dashboard and close the request. archived_by records the
// REQUESTER (the deletion was theirs, countersigned by the approver).
router.post('/dashboards/:id/delete-request/approve', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const ctx = await loadDecidableRequest(req, res);
    if (!ctx) return;
    const { companyId, dash, pend } = ctx;
    const me = req.session.userId!;
    await archiveDashboardRow(dash.id, pend.requested_by);
    await query(
      `UPDATE dashboard_delete_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
      [pend.id, me]);
    const myName = await userDisplayName(me);
    const requesterName = await userDisplayName(pend.requested_by);
    notify({
      companyId, userIds: [pend.requested_by], category: 'approvals', type: 'dashboard_delete_decided',
      title: `Your delete request for "${dash.name}" was approved`,
      body: `Your delete request for "${dash.name}" was approved by ${myName} — the dashboard is archived. Its sessions stay saved in the archive.`,
      link: 'settings/dashboards',
    });
    const others = (await dashboardDeleteApproverIds(companyId, dash.id))
      .filter((id: string) => id !== pend.requested_by && id !== me);
    if (others.length) {
      notify({
        companyId, userIds: others, category: 'approvals', type: 'dashboard_delete_decided',
        title: `The dashboard "${dash.name}" was archived`,
        body: `${requesterName}'s delete request for "${dash.name}" was approved by ${myName} — the dashboard is archived.`,
        link: 'settings/dashboards',
      });
    }
    await auditLog({
      companyId, date: todayStr(), action: 'archived', category: 'settings',
      source: 'manual', changedBy: me,
      description: `Approved ${requesterName}'s request — archived the dashboard "${dash.name}"`,
    });
    res.json({ ok: true, archived: true });
  } catch (err) {
    console.error('[schedule] dashboard delete approve failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/dashboards/:id/delete-request/reject — close the
// request; the dashboard stays live.
router.post('/dashboards/:id/delete-request/reject', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const ctx = await loadDecidableRequest(req, res);
    if (!ctx) return;
    const { companyId, dash, pend } = ctx;
    const me = req.session.userId!;
    await query(
      `UPDATE dashboard_delete_requests SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`,
      [pend.id, me]);
    const myName = await userDisplayName(me);
    notify({
      companyId, userIds: [pend.requested_by], category: 'approvals', type: 'dashboard_delete_decided',
      title: `Your delete request for "${dash.name}" was rejected`,
      body: `Your delete request for "${dash.name}" was rejected by ${myName} — the dashboard stays as it is.`,
      link: 'settings/dashboards',
    });
    await auditLog({
      companyId, date: todayStr(), action: 'delete_rejected', category: 'settings',
      source: 'manual', changedBy: me,
      description: `Rejected the request to delete the dashboard "${dash.name}"`,
    });
    res.json({ ok: true, rejected: true });
  } catch (err) {
    console.error('[schedule] dashboard delete reject failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/dashboards/:id/delete-request/cancel — the
// requester withdraws their own pending request.
router.post('/dashboards/:id/delete-request/cancel', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dash = await dashboardRowById(companyId, req.params.id);
    if (!dash) { res.status(404).json({ error: 'Dashboard not found.' }); return; }
    const pend = await pendingDeleteRequest(dash.id);
    if (!pend) { res.status(409).json({ error: 'There is no pending delete request for this dashboard.' }); return; }
    if (pend.requested_by !== req.session.userId) {
      res.status(403).json({ error: 'Only the person who asked can cancel this request.' });
      return;
    }
    await query(
      `UPDATE dashboard_delete_requests SET status = 'cancelled', decided_by = $2, decided_at = now() WHERE id = $1`,
      [pend.id, req.session.userId!]);
    await auditLog({
      companyId, date: todayStr(), action: 'delete_cancelled', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      description: `Withdrew the request to delete the dashboard "${dash.name}"`,
    });
    res.json({ ok: true, cancelled: true });
  } catch (err) {
    console.error('[schedule] dashboard delete cancel failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/dashboards/:id/restore — bring an archived
// dashboard back, sessions and all. Direct, no approval.
router.post('/dashboards/:id/restore', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const dash = await dashboardRowById(companyId, req.params.id);
    if (!dash) { res.status(404).json({ error: 'Dashboard not found.' }); return; }
    if (!dash.archived_at) { res.status(409).json({ error: 'That dashboard is not archived.' }); return; }
    await query('UPDATE dashboards SET archived_at = NULL, archived_by = NULL WHERE id = $1', [dash.id]);
    await auditLog({
      companyId, date: todayStr(), action: 'restored', category: 'settings',
      source: 'manual', changedBy: req.session.userId!,
      description: `Restored the dashboard "${dash.name}" from the archive`,
    });
    res.json({ ok: true, restored: true });
  } catch (err) {
    console.error('[schedule] dashboard restore failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/day-shifts?date=YYYY-MM-DD — that date's shifts
// (stored + rotation-generated, like GET /shifts) with shift-type
// times, plus unfilled extra open slots as OPEN rows. Feeds the
// event form's "From the schedule" pull (Deepika, 2026-11-07).
// Employees use the pull too, scoped to their OWN shifts.
router.get('/day-shifts', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A date is required.' }); return; }
    const range = await getShiftsForRange(query as any, companyId, date, date);
    const times = await getShiftTypeTimes(query as any, companyId);
    const hm = (min: number | null | undefined) => (min === null || min === undefined) ? null
      : String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
    const typeIds = [...new Set(range.map((s: any) => s.shiftTypeId).filter(Boolean))] as string[];
    const deptOfType = new Map<string, string[]>();
    if (typeIds.length) {
      const { rows: td } = await query(
        'SELECT shift_type_id, department_id FROM shift_type_departments WHERE shift_type_id = ANY($1::uuid[])', [typeIds]);
      for (const r of td) {
        if (!deptOfType.has(r.shift_type_id)) deptOfType.set(r.shift_type_id, []);
        deptOfType.get(r.shift_type_id)!.push(r.department_id);
      }
    }
    // Scheduler scope: their view ∪ edit departments (owners: all).
    let scope: string[] | null = null;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      scope = [...new Set([...(access.view || []), ...(access.edit || [])])];
    }
    const inScope = (typeId: string | null) => {
      if (!scope) return true;
      if (!typeId) return true;
      const ds = deptOfType.get(typeId) || [];
      return !ds.length || ds.some((d) => scope!.includes(d));
    };
    const out: any[] = [];
    for (const s of range as any[]) {
      // Employee view (Deepika, 2026-11-09 — Step 1 of pattern ≠
      // schedule): employees pull only their own PUBLISHED stored
      // shifts into an event — rotation occurrences are an admin
      // preview and drafts are not theirs to act on yet.
      if (req.session.role === 'employee' && (s.isRotation || !s.published)) continue;
      if (req.session.role === 'employee' && s.userId !== req.session.userId) continue;
      if (!inScope(s.shiftTypeId || null)) continue;
      const tt = s.shiftTypeId ? times.get(s.shiftTypeId) : undefined;
      out.push({
        shiftTypeId: s.shiftTypeId || null,
        shiftTypeName: s.shiftTypeName || 'Shift',
        userId: s.userId || null,
        personName: s.personName || null,
        startTime: tt && tt.timed ? hm(tt.startMin) : null,
        endTime: tt && tt.timed ? hm(tt.endMin) : null,
        departmentId: (s.shiftTypeId && (deptOfType.get(s.shiftTypeId) || [])[0]) || null,
      });
    }
    const { rows: open } = await query(
      `SELECT e.shift_type_id AS "shiftTypeId", e.count, st.name AS "shiftTypeName"
       FROM extra_open_slots e JOIN shift_types st ON st.id = e.shift_type_id
       WHERE e.company_id = $1 AND e.date = $2 AND e.count > 0`,
      [companyId, date]);
    for (const o of open) {
      if (req.session.role === 'employee') continue; // open slots aren't the employee's own shifts
      if (!inScope(o.shiftTypeId)) continue;
      const tt = times.get(o.shiftTypeId);
      for (let i = 0; i < (o.count || 0); i++) {
        out.push({
          shiftTypeId: o.shiftTypeId, shiftTypeName: o.shiftTypeName,
          userId: null, personName: null,
          startTime: tt && tt.timed ? hm(tt.startMin) : null,
          endTime: tt && tt.timed ? hm(tt.endMin) : null,
          departmentId: (deptOfType.get(o.shiftTypeId) || [])[0] || null,
        });
      }
    }
    out.sort((a, b) => String(a.startTime || '99') < String(b.startTime || '99') ? -1 : 1);
    res.json({ shifts: out });
  } catch (err) {
    console.error('[schedule] day-shifts failed:', err);
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
      `SELECT id, cycle_days, start_date::text AS start_date, end_date::text AS end_date FROM rotations
       WHERE company_id = $1 AND is_active = true`, [companyId]);
    const userPaused = new Set<string>();
    const target = new Date(date + 'T00:00:00');
    for (const rot of rotations) {
      const { rows: assigns } = await query(
        `SELECT ra.user_id, ra.cycle_day, ra.shift_type_id, u.first_name, u.last_name, u.name,
                u.end_date::text AS end_date, jr.name AS job_role, st.name AS shift_name, st.department_id, d.name AS department_name
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
      if (rot.end_date && date > String(rot.end_date)) continue; // rotation ended (migration 100)
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
    // Per-session person-label override (migration 089): the raw
    // override only — the EFFECTIVE label is override ?? the kind's
    // person_label ?? 'Speaker', resolved where kinds are at hand.
    personLabelOverride: r.person_label || null,
    meetingUrl: r.meeting_url || null,
    // Generated meeting links (migration 091): which service made
    // the link in meetingUrl, and its meeting id there — edits and
    // deletes of this session sync to that meeting. Null for pasted
    // links.
    meetingProvider: r.meeting_provider || null,
    meetingExternalId: r.meeting_external_id || null,
    // Room booking (migration 092): roomId for one of our rooms,
    // roomSource/roomExternalId for a connected Google/Microsoft
    // room; the room's NAME always rides in `location` either way.
    roomId: r.room_id || null,
    roomSource: r.room_source || null,
    roomExternalId: r.room_external_id || null,
    notes: r.notes,
    dashboardId: r.dashboard_id || null,
    recurRule: r.recur_rule === 'biweekly' ? 'weekly' : (r.recur_rule || 'none'),
    recurInterval: r.recur_rule === 'biweekly' ? 2 : (r.recur_interval || 1),
    recurCount: r.recur_count || null,
    recurDays: r.recur_days ? String(r.recur_days).split(',').map(function (x: string) { return parseInt(x, 10); }).filter(function (n: number) { return !isNaN(n); }) : [],
    recurUntil: r.recur_until instanceof Date ? r.recur_until.toISOString().slice(0, 10) : (r.recur_until || null),
    seriesId: r.series_id || null,
    isOccurrence: !!r.is_occurrence,
    createdBy: r.created_by || null,
    createdAt: r.created_at,
  };
}

// SQL fragment (alias `s` = academic_sessions): a session is visible
// to a non-owner when its own department is in the visible set, or its
// calendar carries a visible department, or its calendar has no
// department restriction at all (inherit model, 2026-11-07).
export function sessionVisibleSql(idsParam: number): string {
  return `(s.department_id = ANY($${idsParam})
    OR EXISTS (SELECT 1 FROM dashboard_departments dd WHERE dd.dashboard_id = s.dashboard_id AND dd.department_id = ANY($${idsParam}))
    OR (s.dashboard_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM dashboard_departments dd WHERE dd.dashboard_id = s.dashboard_id)))`;
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
// date (own presenter / room / link / times, or a cancelled date).
// (The has_supervisor override columns remain for stored history;
// nothing writes them since supervisors were retired, 2026-11-07.)
// has_* flags separate "set (maybe to null)" from "not overridden".
function ovDateStr(d: any): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
}

export async function loadOverrides(companyId: string, sessionIds: string[], from: string, to: string): Promise<Map<string, any>> {
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

// EVENT model: the speakers in effect for ONE occurrence. The series
// list is authoritative; a per-date lecturer override adjusts only the
// primary (first) spot: a team Speaker 1 is replaced by the override
// lecturer (or dropped when the override clears it); when Speaker 1
// is a guest, an override lecturer is added in front for that date.
export function effectiveSpeakers(seriesSpeakers: any[], occLecturerUserId: string | null, occLecturerName: string | null): any[] {
  const sp = (seriesSpeakers || []).map((s: any) => ({ ...s }));
  if (!sp.length) {
    return occLecturerUserId ? [{ userId: occLecturerUserId, name: occLecturerName, guest: false, guestEmail: null }] : [];
  }
  const first = sp[0];
  if (first.userId) {
    if (occLecturerUserId === first.userId) return sp;
    if (occLecturerUserId) { sp[0] = { userId: occLecturerUserId, name: occLecturerName, guest: false, guestEmail: null }; return sp; }
    return sp.slice(1);
  }
  if (occLecturerUserId) return [{ userId: occLecturerUserId, name: occLecturerName, guest: false, guestEmail: null }, ...sp];
  return sp;
}

// A loaded speaker row back into saveSpeakers input shape.
export function speakerRowToInput(s: any): { userId?: string | null; guestName?: string | null; guestEmail?: string | null } {
  return s.userId ? { userId: s.userId } : { guestName: s.name, guestEmail: s.guestEmail };
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
  return { id: r.id, key: r.key, label: r.label, color: r.color || '#00796b', dashboardId: r.dashboard_id || null, personLabel: r.person_label || null };
}

function cleanPersonLabel(raw: any): string | null {
  const v = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return null;
  return v.slice(0, 40);
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
    const personLabel = cleanPersonLabel(b.personLabel);
    await query('INSERT INTO session_kinds (id, company_id, dashboard_id, key, label, color, position, person_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, companyId, dashboardId, key, label, color, (mx[0].m || 0) + 1, personLabel]);
    res.json({ ok: true, kind: { id, key, label, color, dashboardId, personLabel } });
  } catch (err) {
    console.error('[schedule] session kind create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/schedule/session-kinds/:id — owner or scheduler sets the
// kind's person label (the "needs a ___" name; empty clears it back to
// the Speaker default).
router.put('/session-kinds/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    const { rows } = await query('SELECT dashboard_id FROM session_kinds WHERE id = $1 AND company_id = $2', [String(req.params.id), companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    if (rows[0].dashboard_id && !(await dashboardEditAllowed(req, rows[0].dashboard_id))) {
      res.status(403).json({ error: 'Only this dashboard\'s editors can change its session types.' });
      return;
    }
    const personLabel = cleanPersonLabel(b.personLabel);
    await query('UPDATE session_kinds SET person_label = $1 WHERE id = $2 AND company_id = $3', [personLabel, String(req.params.id), companyId]);
    res.json({ ok: true, personLabel });
  } catch (err) {
    console.error('[schedule] session kind update failed:', err);
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

// ---------------------------------------------------------------------
// Session availability links + session offers (Deepika 2026-11-04,
// migration 081) — the calendar mirror of availability links (022)
// and gap offers (079). A no-login link lists the sessions that still
// need a speaker (the kind's person name); people
// tap the ones they can cover. From the Needs people tool, a scheduler
// offers a session to those volunteers or everyone on the calendar;
// each recipient gets a bell + an email with a personal login-free
// link, and the first to accept is assigned (base row for the series'
// own date, a per-date override for a recurring occurrence).
function baseSessionId(id: string): string { return String(id || '').split('@@')[0]; }

// loadOverrides reads through the GLOBAL query — inside a transaction
// that deadlocks the single-connection dev database (and is wrong on
// the pool too: the read would miss the lock's snapshot). This twin
// reads through the caller's handle instead.
async function loadOverridesVia(q: any, companyId: string, sessionIds: string[], from: string, to: string): Promise<Map<string, any>> {
  const map = new Map<string, any>();
  if (!sessionIds.length) return map;
  const { rows } = await q(
    'SELECT * FROM academic_session_overrides WHERE company_id = $1 AND session_id = ANY($2) AND date >= $3 AND date <= $4',
    [companyId, sessionIds, from, to]);
  for (const o of rows) map.set(o.session_id + '|' + ovDateStr(o.date), o);
  return map;
}

async function resolveOccurrence(q: any, companyId: string, baseId: string, occDate: string): Promise<any | null> {
  const { rows } = await q(
    `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
            sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
     FROM academic_sessions s
     LEFT JOIN users u ON u.id = s.lecturer_user_id
     LEFT JOIN users sup ON sup.id = s.supervisor_user_id
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE s.id = $1 AND s.company_id = $2`,
    [baseId, companyId]);
  if (!rows.length) return null;
  const base = academicRow(rows[0]);
  let ovMap = new Map<string, any>();
  const userName = new Map<string, string>();
  if (base.recurRule && base.recurRule !== 'none') {
    ovMap = await loadOverridesVia(q, companyId, [baseId], occDate, occDate);
    const { rows: us } = await q('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [companyId]);
    for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
  }
  const out = expandAcademicSessions(rows, occDate, occDate, ovMap, userName);
  return out.length ? { base, occ: out[0] } : null;
}

async function personLabelFor(q: any, companyId: string, dashboardId: string | null, kind: string): Promise<string> {
  if (dashboardId) {
    const { rows } = await q('SELECT person_label FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 AND key = $3', [companyId, dashboardId, kind]);
    if (rows.length && rows[0].person_label) return String(rows[0].person_label);
  }
  const { rows: any } = await q('SELECT person_label FROM session_kinds WHERE company_id = $1 AND key = $2 AND person_label IS NOT NULL LIMIT 1', [companyId, kind]);
  return any.length ? String(any[0].person_label) : 'Speaker';
}

// The EFFECTIVE person label for one session (Deepika, 2026-11-07):
// the session's own Role name override (migration 089) wins, then
// its kind's label, then 'Speaker'. Accepts either an academicRow
// payload (personLabelOverride / dashboardId) or a raw DB row
// (person_label / dashboard_id).
async function sessionPersonLabel(q: any, companyId: string, sess: any): Promise<string> {
  const ov = sess ? (sess.personLabelOverride ?? sess.person_label) : null;
  if (ov) return String(ov);
  const dashId = sess ? (sess.dashboardId ?? sess.dashboard_id ?? null) : null;
  return personLabelFor(q, companyId, dashId, String((sess && sess.kind) || 'session'));
}

// a/an for a person label ("an interviewer", "a speaker").
function labelArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a';
}

function timeToMin(t: string | null): number | null {
  if (!t) return null;
  const p = String(t).slice(0, 5).split(':');
  const h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  return isNaN(h) || isNaN(m) ? null : h * 60 + m;
}
function timesOverlap(aS: string | null, aE: string | null, bS: string | null, bE: string | null): boolean {
  const as = timeToMin(aS), ae = timeToMin(aE), bs = timeToMin(bS), be = timeToMin(bE);
  if (as === null || bs === null) return false; // untimed: can't prove a clash — sessions are meetings, be lenient
  const aEnd = ae === null ? as + 60 : ae;
  const bEnd = be === null ? bs + 60 : be;
  return as < bEnd && bs < aEnd;
}

// Why userId cannot take this occurrence in this role (or null = fine):
// a timed session they already present/supervise at the same time, or
// the other role on this same session. Shifts NEVER block (Deepika
// 2026-11-04): a session is a small part of the day, like a meeting —
// someone working that day can still pick it up.
async function sessionClaimConflict(q: any, companyId: string, userId: string, occ: any, role: string, visibleDeptIds: string[] | null): Promise<string | null> {
  const clauses = ['s.company_id = $1'];
  const params: any[] = [companyId];
  if (visibleDeptIds) { params.push(visibleDeptIds); clauses.push(sessionVisibleSql(params.length)); }
  params.push(occ.date, occ.date);
  clauses.push(`(s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $${params.length - 1})`);
  clauses.push(`s.session_date <= $${params.length}`);
  const { rows } = await q(
    `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
            sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
     FROM academic_sessions s
     LEFT JOIN users u ON u.id = s.lecturer_user_id
     LEFT JOIN users sup ON sup.id = s.supervisor_user_id
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE ${clauses.join(' AND ')}`,
    params);
  let ovMap = new Map<string, any>();
  const userName = new Map<string, string>();
  if (rows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
    ovMap = await loadOverridesVia(q, companyId, rows.map((r: any) => r.id), occ.date, occ.date);
    const { rows: us } = await q('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [companyId]);
    for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
  }
  const day = expandAcademicSessions(rows, occ.date, occ.date, ovMap, userName);
  for (const s of day) {
    const sameOcc = baseSessionId(s.id) === baseSessionId(occ.id) && s.date === occ.date;
    if (sameOcc) {
      // Same session: holding the claimed role is the filled case,
      // handled earlier. (Supervisors were retired on 2026-11-07, so
      // a stored supervisor assignment no longer blocks a claim.)
      continue;
    }
    if (s.lecturerUserId === userId || s.supervisorUserId === userId) {
      if (timesOverlap(occ.startTime, occ.endTime, s.startTime, s.endTime)) {
        return `It overlaps "${s.title}", which you are already on that day.`;
      }
    }
  }
  return null;
}

function normNameKey(s: string): string { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function matchUserByName(users: any[], name: string): any | null {
  const n = normNameKey(name);
  if (!n) return null;
  const sorted = n.split(' ').sort().join(' ');
  return users.find((u) => normNameKey(u.name) === n) ||
    users.find((u) => normNameKey(u.name).split(' ').sort().join(' ') === sorted) || null;
}

// Newest link wins per (name, session, date, role).
async function sessionVolunteers(q: any, companyId: string): Promise<any[]> {
  const { rows } = await q(
    `SELECT r.name, r.user_id AS "userId", r.session_id AS "sessionId", r.occ_date::text AS "occDate", r.role
     FROM session_avail_responses r JOIN session_avail_links l ON l.id = r.link_id
     WHERE l.company_id = $1 ORDER BY l.created_at DESC, r.created_at DESC`,
    [companyId]);
  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of rows) {
    const k = (r.userId || normNameKey(r.name)) + '|' + r.sessionId + '|' + r.occDate + '|' + r.role;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// GET /api/schedule/session-avail — list links (owner/scheduler).
router.get('/session-avail', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT id, title, dashboard_id AS "dashboardId", from_date::text AS "fromDate", to_date::text AS "toDate", created_at AS "createdAt",
              (SELECT COUNT(DISTINCT name) FROM session_avail_responses r WHERE r.link_id = session_avail_links.id) AS "responseCount"
       FROM session_avail_links WHERE company_id = $1 ORDER BY created_at DESC`,
      [companyId]);
    res.json({ links: rows });
  } catch (err) {
    console.error('[schedule] list session-avail failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/session-avail — create a link (owner/scheduler).
router.post('/session-avail', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { fromDate, toDate, title, dashboardId } = req.body ?? {};
    if (!isValidDate(fromDate) || !isValidDate(toDate) || fromDate > toDate) {
      res.status(400).json({ error: 'Valid from/to dates are required.' });
      return;
    }
    let dashId: string | null = null;
    if (dashboardId) {
      const { rows: d } = await query('SELECT id, archived_at FROM dashboards WHERE id = $1 AND company_id = $2', [String(dashboardId), companyId]);
      if (!d.length) { res.status(400).json({ error: 'Unknown dashboard.' }); return; }
      if (d[0].archived_at) { res.status(409).json({ error: 'That dashboard is archived.' }); return; }
      dashId = String(dashboardId);
    }
    const token = crypto.randomBytes(32).toString('hex');
    const { rows } = await query(
      `INSERT INTO session_avail_links (company_id, dashboard_id, token_hash, title, from_date, to_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [companyId, dashId, hashShareToken(token), title ? String(title).slice(0, 120) : null, fromDate, toDate, req.session.userId!]);
    const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    res.status(201).json({ id: rows[0].id, link: `${base}/my-availability.html?kind=session&t=${token}` });
  } catch (err) {
    console.error('[schedule] create session-avail failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/session-avail/:id (owner/scheduler).
router.delete('/session-avail/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    await query('DELETE FROM session_avail_links WHERE id = $1 AND company_id = $2', [req.params.id, req.session.companyId!]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] delete session-avail failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/session-avail/responses — every volunteer's picks
// for the company (owner/scheduler); the tool applies newest-link-wins.
router.get('/session-avail/responses', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const rows = await sessionVolunteers(query, req.session.companyId!);
    res.json({ responses: rows });
  } catch (err) {
    console.error('[schedule] session-avail responses failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/session-avail/public?token=xxx — the public page's
// data: the link, the sessions in range that still need someone, and
// the answers given so far (for pre-filling a returning name).
router.get('/session-avail/public', async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token || '');
    if (!token) { res.status(400).json({ error: 'Invalid link.' }); return; }
    const { rows: links } = await query(
      `SELECT l.id, l.title, l.dashboard_id AS "dashboardId", l.from_date::text AS "fromDate", l.to_date::text AS "toDate",
              c.name AS "companyName", d.name AS "dashboardName", l.company_id AS "companyId"
       FROM session_avail_links l JOIN companies c ON c.id = l.company_id
       LEFT JOIN dashboards d ON d.id = l.dashboard_id
       WHERE l.token_hash = $1`,
      [hashShareToken(token)]);
    if (!links.length) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    const link = links[0];
    const clauses = ['s.company_id = $1'];
    const params: any[] = [link.companyId];
    if (link.dashboardId) { params.push(link.dashboardId); clauses.push(`s.dashboard_id = $${params.length}`); }
    clauses.push('NOT EXISTS (SELECT 1 FROM dashboards dx WHERE dx.id = s.dashboard_id AND dx.archived_at IS NOT NULL)');
    params.push(link.fromDate, link.toDate);
    clauses.push(`(s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $${params.length - 1})`);
    clauses.push(`s.session_date <= $${params.length}`);
    const { rows } = await query(
      `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
              sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
       FROM academic_sessions s
       LEFT JOIN users u ON u.id = s.lecturer_user_id
       LEFT JOIN users sup ON sup.id = s.supervisor_user_id
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE ${clauses.join(' AND ')} ORDER BY s.session_date, s.start_time NULLS LAST, s.title`,
      params);
    let ovMap = new Map<string, any>();
    const userName = new Map<string, string>();
    if (rows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
      ovMap = await loadOverrides(link.companyId, rows.map((r: any) => r.id), link.fromDate, link.toDate);
      const { rows: us } = await query('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [link.companyId]);
      for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
    }
    const expanded = expandAcademicSessions(rows, link.fromDate, link.toDate, ovMap, userName);
    const { rows: kinds } = await query('SELECT key, label, color, dashboard_id AS "dashboardId", person_label AS "personLabel" FROM session_kinds WHERE company_id = $1', [link.companyId]);
    const kindOf = (s: any) => kinds.find((k: any) => k.key === s.kind && k.dashboardId === s.dashboardId) || kinds.find((k: any) => k.key === s.kind) || null;
    const { rows: dashRows } = await query('SELECT id, name FROM dashboards WHERE company_id = $1', [link.companyId]);
    const dashName = new Map(dashRows.map((d: any) => [d.id, d.name]));
    const spMapPub = await loadSpeakers(query as any, rows.map((r: any) => r.id));
    const presenterMissingPub = (s: any) => effectiveSpeakers(spMapPub.get(baseSessionId(s.id)) || [], s.lecturerUserId || null, s.lecturerName || null).length === 0;
    const sessions = expanded
      .filter((s: any) => presenterMissingPub(s))
      .map((s: any) => {
        const k: any = kindOf(s);
        const missing: string[] = [];
        if (presenterMissingPub(s)) missing.push('presenter');
        return {
          sessionId: baseSessionId(s.id), occDate: s.date, title: s.title,
          startTime: s.startTime, endTime: s.endTime, location: s.location,
          kindLabel: k ? k.label : (s.kind === 'event' ? 'Event' : 'Lecture'),
          kindColor: k ? k.color : '#475569',
          personLabel: s.personLabelOverride || (k && k.personLabel) || 'Speaker',
          dashboardName: s.dashboardId ? (dashName.get(s.dashboardId) || null) : null,
          missing,
        };
      });
    const { rows: responses } = await query(
      'SELECT name, session_id AS "sessionId", occ_date::text AS "occDate", role FROM session_avail_responses WHERE link_id = $1',
      [link.id]);
    res.json({
      link: { title: link.title, fromDate: link.fromDate, toDate: link.toDate, companyName: link.companyName, dashboardName: link.dashboardName },
      sessions, responses,
    });
  } catch (err) {
    console.error('[schedule] public session-avail failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/session-avail/public/respond — save a name's picks
// (no auth). Replaces that name's earlier answers on this link; picks
// are validated against the sessions that still need someone.
router.post('/session-avail/public/respond', async (req: Request, res: Response) => {
  try {
    const { token, name, picks } = req.body ?? {};
    if (!token || !name || typeof name !== 'string' || !name.trim() || !Array.isArray(picks)) {
      res.status(400).json({ error: 'Name and picks are required.' });
      return;
    }
    const { rows: links } = await query(
      'SELECT id, company_id AS "companyId", dashboard_id AS "dashboardId", from_date::text AS "fromDate", to_date::text AS "toDate" FROM session_avail_links WHERE token_hash = $1',
      [hashShareToken(String(token))]);
    if (!links.length) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    const link = links[0];
    const cleanName = String(name).trim().slice(0, 80);
    // Live gap set for the link's range.
    const clauses = ['s.company_id = $1'];
    const params: any[] = [link.companyId];
    if (link.dashboardId) { params.push(link.dashboardId); clauses.push(`s.dashboard_id = $${params.length}`); }
    clauses.push('NOT EXISTS (SELECT 1 FROM dashboards dx WHERE dx.id = s.dashboard_id AND dx.archived_at IS NOT NULL)');
    params.push(link.fromDate, link.toDate);
    clauses.push(`(s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $${params.length - 1})`);
    clauses.push(`s.session_date <= $${params.length}`);
    const { rows } = await query(
      `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
              sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
       FROM academic_sessions s
       LEFT JOIN users u ON u.id = s.lecturer_user_id
       LEFT JOIN users sup ON sup.id = s.supervisor_user_id
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE ${clauses.join(' AND ')}`,
      params);
    let ovMap = new Map<string, any>();
    const userName = new Map<string, string>();
    if (rows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
      ovMap = await loadOverrides(link.companyId, rows.map((r: any) => r.id), link.fromDate, link.toDate);
      const { rows: us } = await query('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [link.companyId]);
      for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
    }
    const expanded = expandAcademicSessions(rows, link.fromDate, link.toDate, ovMap, userName);
    const spMapResp = await loadSpeakers(query as any, rows.map((r: any) => r.id));
    const gapSet = new Set<string>();
    for (const s of expanded) {
      if (effectiveSpeakers(spMapResp.get(baseSessionId(s.id)) || [], s.lecturerUserId || null, s.lecturerName || null).length === 0) gapSet.add(baseSessionId(s.id) + '|' + s.date + '|presenter');
    }
    await query('DELETE FROM session_avail_responses WHERE link_id = $1 AND name = $2', [link.id, cleanName]);
    let saved = 0;
    for (const p of picks.slice(0, 200)) {
      const key = String(p.sessionId || '') + '|' + String(p.occDate || '') + '|' + String(p.role || '');
      if (!gapSet.has(key)) continue;
      await query(
        `INSERT INTO session_avail_responses (link_id, name, session_id, occ_date, role)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (link_id, name, session_id, occ_date, role) DO NOTHING`,
        [link.id, cleanName, String(p.sessionId), String(p.occDate), String(p.role)]);
      saved++;
    }
    res.json({ ok: true, saved });
  } catch (err) {
    console.error('[schedule] session-avail respond failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Login-based availability (Deepika, 2026-11-04 evening): availability
// links now open a page where the person signs in with their normal
// login; the app picks up their name from the account, shows the
// sessions for their departments and the shift gaps for their job
// roles, and saves the answers against their account (user_id) — no
// typed names, no name matching. Legacy typed-name answers still load
// when the name matches the account exactly.
// ---------------------------------------------------------------------------

// Resolve either kind of availability link by its raw token.
async function resolveAvailLink(kind: string, token: string): Promise<any | null> {
  if (!token) return null;
  const hash = hashShareToken(token);
  if (kind === 'session') {
    const { rows } = await query(
      `SELECT l.id, l.company_id AS "companyId", l.dashboard_id AS "dashboardId", l.title,
              l.from_date::text AS "fromDate", l.to_date::text AS "toDate", c.name AS "companyName"
       FROM session_avail_links l JOIN companies c ON c.id = l.company_id WHERE l.token_hash = $1`,
      [hash]);
    return rows.length ? { ...rows[0], kind: 'session' } : null;
  }
  const { rows } = await query(
    `SELECT r.id, r.company_id AS "companyId", NULL AS "dashboardId", r.title,
            r.from_date::text AS "fromDate", r.to_date::text AS "toDate", c.name AS "companyName"
     FROM availability_requests r JOIN companies c ON c.id = r.company_id WHERE r.token_hash = $1`,
    [hash]);
  return rows.length ? { ...rows[0], kind: 'shift' } : null;
}

// The row a login-page answer attaches to: the link itself when the
// kinds match; otherwise the company's newest link of that kind (or a
// fresh one) so answers always land where the readers look.
async function availStorageLink(link: any, wantKind: 'session' | 'shift', userId: string): Promise<any> {
  if (link.kind === wantKind) return link;
  if (wantKind === 'session') {
    const { rows } = await query(
      'SELECT id, dashboard_id AS "dashboardId" FROM session_avail_links WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1',
      [link.companyId]);
    if (rows.length) return { id: rows[0].id, dashboardId: rows[0].dashboardId };
    const token = crypto.randomBytes(24).toString('hex');
    const { rows: made } = await query(
      `INSERT INTO session_avail_links (company_id, dashboard_id, token_hash, title, from_date, to_date, created_by)
       VALUES ($1, NULL, $2, 'Availability (login page)', $3, $4, $5) RETURNING id`,
      [link.companyId, hashShareToken(token), link.fromDate, link.toDate, userId]);
    return { id: made[0].id, dashboardId: null };
  }
  const { rows } = await query(
    'SELECT id FROM availability_requests WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1',
    [link.companyId]);
  if (rows.length) return { id: rows[0].id };
  const token = crypto.randomBytes(24).toString('hex');
  const { rows: made } = await query(
    `INSERT INTO availability_requests (company_id, token_hash, title, from_date, to_date, created_by)
     VALUES ($1, $2, 'Availability (login page)', $3, $4, $5) RETURNING id`,
    [link.companyId, hashShareToken(token), link.fromDate, link.toDate, userId]);
  return { id: made[0].id };
}

// Session occurrences in a window that still need someone, optionally
// scoped to one dashboard — same expansion as the public link page.
async function sessionGapsForWindow(companyId: string, dashboardId: string | null, fromDate: string, toDate: string): Promise<any[]> {
  const clauses = ['s.company_id = $1'];
  const params: any[] = [companyId];
  if (dashboardId) { params.push(dashboardId); clauses.push(`s.dashboard_id = $${params.length}`); }
    clauses.push('NOT EXISTS (SELECT 1 FROM dashboards dx WHERE dx.id = s.dashboard_id AND dx.archived_at IS NOT NULL)');
  params.push(fromDate, toDate);
  clauses.push(`(s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $${params.length - 1})`);
  clauses.push(`s.session_date <= $${params.length}`);
  const { rows } = await query(
    `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
            sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
     FROM academic_sessions s
     LEFT JOIN users u ON u.id = s.lecturer_user_id
     LEFT JOIN users sup ON sup.id = s.supervisor_user_id
     LEFT JOIN departments d ON d.id = s.department_id
     WHERE ${clauses.join(' AND ')} ORDER BY s.session_date, s.start_time NULLS LAST, s.title`,
    params);
  let ovMap = new Map<string, any>();
  const userName = new Map<string, string>();
  if (rows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
    ovMap = await loadOverrides(companyId, rows.map((r: any) => r.id), fromDate, toDate);
    const { rows: us } = await query('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [companyId]);
    for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
  }
  const expanded = expandAcademicSessions(rows, fromDate, toDate, ovMap, userName);
  const { rows: kinds } = await query('SELECT key, label, color, dashboard_id AS "dashboardId", person_label AS "personLabel" FROM session_kinds WHERE company_id = $1', [companyId]);
  const kindOf = (s: any) => kinds.find((k: any) => k.key === s.kind && k.dashboardId === s.dashboardId) || kinds.find((k: any) => k.key === s.kind) || null;
  const { rows: dashRows } = await query('SELECT id, name FROM dashboards WHERE company_id = $1', [companyId]);
  const dashName = new Map(dashRows.map((d: any) => [d.id, d.name]));
  // Presenter gap = the occurrence has NO speakers at all (a guest
  // speaker covers the spot; the lecturer mirror alone no longer
  // decides).
  const spMapGaps = await loadSpeakers(query as any, rows.map((r: any) => r.id));
  const presenterMissing = (s: any) => effectiveSpeakers(spMapGaps.get(baseSessionId(s.id)) || [], s.lecturerUserId || null, s.lecturerName || null).length === 0;
  return expanded
    .filter((s: any) => presenterMissing(s))
    .map((s: any) => {
      const k: any = kindOf(s);
      const missing: string[] = [];
      if (presenterMissing(s)) missing.push('presenter');
      return {
        sessionId: baseSessionId(s.id), occDate: s.date, title: s.title,
        startTime: s.startTime, endTime: s.endTime, location: s.location,
        kindLabel: k ? k.label : (s.kind === 'event' ? 'Event' : 'Lecture'),
        kindColor: k ? k.color : '#475569',
        personLabel: s.personLabelOverride || (k && k.personLabel) || 'Speaker',
        dashboardId: s.dashboardId || null, dashboardName: s.dashboardId ? (dashName.get(s.dashboardId) || null) : null,
        departmentId: (s as any).departmentId || null,
        missing,
      };
    });
}

// Is this user in a session's offer audience? (Same rule as session
// offers: the session's department, else its calendar's departments,
// else everyone; owners are always in.)
async function sessionAudienceHas(companyId: string, gap: any, user: any, memberCache: Map<string, Set<string>>): Promise<boolean> {
  if (user.role === 'owner') return true;
  let deptIds: string[] = [];
  if (gap.departmentId) deptIds = [gap.departmentId];
  else if (gap.dashboardId) {
    const { rows: dd } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [gap.dashboardId]);
    deptIds = dd.map((d: any) => d.department_id);
  }
  if (!deptIds.length) return true;
  for (const d of deptIds) {
    if (!memberCache.has(d)) memberCache.set(d, new Set(await deptMemberIds(companyId, d)));
    if (memberCache.get(d)!.has(user.id)) return true;
  }
  return false;
}

// Shift gaps in a window the user could take (staffing target +
// extra slots − assigned, per day and type), filtered to the shift
// types their job role fits (owners see all).
async function shiftGapsForUser(companyId: string, user: any, fromDate: string, toDate: string): Promise<any[]> {
  const { rows: types } = await query(
    `SELECT id, name, short_name AS "shortName", color, eligible_job_role_ids AS "eligibleIds"
     FROM shift_types WHERE company_id = $1 AND is_active = true ORDER BY sort_order, name`,
    [companyId]);
  const { rows: targets } = await query(
    `SELECT shift_type_id AS "shiftTypeId", target_count AS "targetCount", weekdays,
            start_date::text AS "startDate", end_date::text AS "endDate"
     FROM staffing_targets WHERE company_id = $1`,
    [companyId]);
  const targetOf = new Map(targets.map((t: any) => [t.shiftTypeId, t]));
  const { rows: adj } = await query(
    `SELECT date::text AS date, shift_type_id AS "shiftTypeId", count FROM extra_open_slots
     WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, fromDate, toDate]);
  const adjMap = new Map<string, number>();
  for (const a of adj) adjMap.set(a.date + '|' + a.shiftTypeId, (adjMap.get(a.date + '|' + a.shiftTypeId) || 0) + (a.count || 0));
  const { rows: closed } = await query(
    `SELECT date::text AS date, shift_type_id AS "shiftTypeId" FROM closed_shifts
     WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, fromDate, toDate]);
  const closedSet = new Set(closed.map((c: any) => c.date + '|' + c.shiftTypeId));
  const shifts = await getShiftsForRange(query as any, companyId, fromDate, toDate);
  const assigned = new Map<string, number>();
  for (const s of shifts as any[]) assigned.set(s.date + '|' + s.shiftTypeId, (assigned.get(s.date + '|' + s.shiftTypeId) || 0) + 1);
  const mine: any[] = [];
  for (const t of types) {
    if (user.role !== 'owner') {
      const elig = await checkShiftEligibility(companyId, user.id, t.eligibleIds);
      if (!elig.ok) continue;
    }
    mine.push(t);
  }
  const byDate = new Map<string, any[]>();
  const d = new Date(fromDate + 'T12:00:00');
  const end = new Date(toDate + 'T12:00:00');
  while (d <= end) {
    const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const dow = d.getDay();
    for (const t of mine) {
      const tg: any = targetOf.get(t.id);
      if (!tg) continue;
      if (tg.startDate && date < tg.startDate) continue;
      if (tg.endDate && date > tg.endDate) continue;
      const wds: number[] = Array.isArray(tg.weekdays) ? tg.weekdays : [0, 1, 2, 3, 4, 5, 6];
      if (!wds.includes(dow)) continue;
      if (closedSet.has(date + '|' + t.id)) continue;
      const needed = (tg.targetCount || 0) + (adjMap.get(date + '|' + t.id) || 0) - (assigned.get(date + '|' + t.id) || 0);
      if (needed <= 0) continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push({ shiftTypeId: t.id, typeName: t.name, shortName: t.shortName, color: t.color, needed });
    }
    d.setDate(d.getDate() + 1);
  }
  return [...byDate.entries()].map(([date, gaps]) => ({ date, gaps }));
}

// GET /api/schedule/availability/mine?kind=shift|session&token=xxx —
// the login page's data (session required; the link must belong to
// the signed-in company).
router.get('/availability/mine', async (req: Request, res: Response) => {
  try {
    if (!req.session?.userId) { res.status(401).json({ error: 'Please sign in.' }); return; }
    const kind = String(req.query.kind || 'shift');
    const link = await resolveAvailLink(kind, String(req.query.token || ''));
    if (!link) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    if (link.companyId !== req.session.companyId) {
      res.status(403).json({ error: 'You are signed in to a different company. Sign out and sign in with the account for this link.' });
      return;
    }
    const { rows: meRows } = await query(
      `SELECT id, role, first_name AS "firstName", last_name AS "lastName", nickname, job_role_id AS "jobRoleId"
       FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [req.session.userId, link.companyId]);
    if (!meRows.length) { res.status(403).json({ error: 'Your account is not active in this company.' }); return; }
    const me = meRows[0];
    const myName = [me.firstName, me.lastName].filter(Boolean).join(' ');
    // Sessions for my departments (link scope: its calendar, or all
    // calendars for a shift link).
    const allGaps = await sessionGapsForWindow(link.companyId, link.kind === 'session' ? link.dashboardId : null, link.fromDate, link.toDate);
    const memberCache = new Map<string, Set<string>>();
    const sessions: any[] = [];
    for (const g of allGaps) {
      if (await sessionAudienceHas(link.companyId, g, me, memberCache)) sessions.push(g);
    }
    // My saved session picks, across the company's links (account
    // rows; legacy typed rows whose name is exactly mine count too).
    const { rows: myResp } = await query(
      `SELECT r.session_id AS "sessionId", r.occ_date::text AS "occDate", r.role FROM session_avail_responses r
       JOIN session_avail_links l ON l.id = r.link_id
       WHERE l.company_id = $1 AND (r.user_id = $2 OR (r.user_id IS NULL AND r.name = $3))`,
      [link.companyId, me.id, myName]);
    const shiftDays = await shiftGapsForUser(link.companyId, me, link.fromDate, link.toDate);
    // My latest shift answers per date (newest request wins, like the
    // offer panels read them).
    const { rows: dateResp } = await query(
      `SELECT r.date::text AS date, r.available FROM availability_responses r
       JOIN availability_requests ar ON ar.id = r.request_id
       WHERE ar.company_id = $1 AND (r.user_id = $2 OR (r.user_id IS NULL AND r.name = $3))
       ORDER BY ar.created_at DESC, r.created_at DESC`,
      [link.companyId, me.id, myName]);
    const myDates: Record<string, boolean> = {};
    for (const r of dateResp) if (!(r.date in myDates)) myDates[r.date] = !!r.available;
    res.json({
      companyName: link.companyName, title: link.title, fromDate: link.fromDate, toDate: link.toDate,
      me: { name: myName, nickname: me.nickname || null },
      sessions,
      mySessionPicks: myResp.map((r: any) => r.sessionId + '|' + r.occDate + '|' + r.role),
      shiftDays, myDates,
    });
  } catch (err) {
    console.error('[schedule] availability mine failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/availability/mine/respond — save my answers
// against my account. Replaces my earlier answers from the login
// page; session picks are validated against the live gap set.
router.post('/availability/mine/respond', async (req: Request, res: Response) => {
  try {
    if (!req.session?.userId) { res.status(401).json({ error: 'Please sign in.' }); return; }
    const b = req.body ?? {};
    const link = await resolveAvailLink(String(b.kind || 'shift'), String(b.token || ''));
    if (!link) { res.status(404).json({ error: 'This link is not valid.' }); return; }
    if (link.companyId !== req.session.companyId) { res.status(403).json({ error: 'Wrong company.' }); return; }
    const { rows: meRows } = await query(
      `SELECT id, first_name AS "firstName", last_name AS "lastName" FROM users
       WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [req.session.userId, link.companyId]);
    if (!meRows.length) { res.status(403).json({ error: 'Your account is not active in this company.' }); return; }
    const me = meRows[0];
    const myName = [me.firstName, me.lastName].filter(Boolean).join(' ');
    const sessionLink = await availStorageLink(link, 'session', me.id);
    const shiftLink = await availStorageLink(link, 'shift', me.id);
    // Session picks (validated against the page's scope gaps).
    const picks: any[] = Array.isArray(b.sessionPicks) ? b.sessionPicks.slice(0, 200) : [];
    const scopeGaps = await sessionGapsForWindow(link.companyId, link.kind === 'session' ? link.dashboardId : null, link.fromDate, link.toDate);
    const gapSet = new Set<string>();
    for (const s of scopeGaps) for (const role of s.missing) gapSet.add(s.sessionId + '|' + s.occDate + '|' + role);
    // Full replace across ALL the company's links, so an answer
    // given on an older link can never resurface after a change.
    await query(
      `DELETE FROM session_avail_responses
       WHERE (user_id = $1 OR (user_id IS NULL AND name = $2))
         AND link_id IN (SELECT id FROM session_avail_links WHERE company_id = $3)`,
      [me.id, myName, link.companyId]);
    let savedSessions = 0;
    for (const p of picks) {
      const key = String(p.sessionId || '') + '|' + String(p.occDate || '') + '|' + String(p.role || '');
      if (!gapSet.has(key)) continue;
      await query(
        `INSERT INTO session_avail_responses (link_id, name, user_id, session_id, occ_date, role)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (link_id, name, session_id, occ_date, role) DO NOTHING`,
        [sessionLink.id, myName, me.id, String(p.sessionId), String(p.occDate), String(p.role)]);
      savedSessions++;
    }
    // Per-date shift answers: entries {date, available} where
    // available is true/false, or null to clear my answer that day.
    const answers: any[] = Array.isArray(b.dateAnswers) ? b.dateAnswers.slice(0, 40) : [];
    let savedDates = 0;
    for (const a of answers) {
      const date = String(a.date || '');
      if (!isValidDate(date) || date < link.fromDate || date > link.toDate) continue;
      // Clear my earlier answers for that date on every request
      // first (including legacy typed-name rows), then write the
      // new one — a save is the single source of truth.
      await query(
        `DELETE FROM availability_responses
         WHERE date = $1 AND (user_id = $2 OR (user_id IS NULL AND name = $3))
           AND request_id IN (SELECT id FROM availability_requests WHERE company_id = $4)`,
        [date, me.id, myName, link.companyId]);
      if (a.available === null || a.available === undefined) continue;
      await query(
        `INSERT INTO availability_responses (request_id, name, user_id, date, available)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (request_id, name, date) DO UPDATE SET available = EXCLUDED.available, user_id = EXCLUDED.user_id`,
        [shiftLink.id, myName, me.id, date, !!a.available]);
      savedDates++;
    }
    res.json({ ok: true, savedSessions, savedDates });
  } catch (err) {
    console.error('[schedule] availability mine respond failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Shared candidate computation for one occurrence + role.
async function sessionOfferCandidates(q: any, req: Request, baseId: string, occDate: string, role: string): Promise<any> {
  const companyId = req.session.companyId!;
  const resolved = await resolveOccurrence(q, companyId, baseId, occDate);
  if (!resolved) return { error: 'That session no longer exists on that date.', status: 404 };
  const { occ } = resolved;
  // Presenter filled = a lecturer for the date OR any speakers on the
  // series (a guest speaker covers the spot too). Speakers are the
  // only offerable role — supervisors were retired (2026-11-07).
  const filled = !!occ.lecturerUserId || (await sessionsWithSpeakers(q, [baseId])).has(baseId);
  if (filled) return { filled: true, occ };
  const visibleIds = await academicVisibleDeptIds(req);
  const { rows: userRows } = await q(
    `SELECT id, role, first_name AS "firstName", last_name AS "lastName", (first_name || ' ' || last_name) AS name
     FROM users WHERE company_id = $1 AND is_active = true ORDER BY first_name, last_name`,
    [companyId]);
  const { rows: offeredRows } = await q(
    `SELECT r.user_id AS "userId" FROM session_offers o JOIN session_offer_recipients r ON r.offer_id = o.id
     WHERE o.company_id = $1 AND o.session_id = $2 AND o.occ_date = $3 AND o.role = $4 AND o.status = 'open'`,
    [companyId, baseId, occDate, role]);
  const offered = new Set(offeredRows.map((r: any) => r.userId));
  const busyOf = async (userId: string) => sessionClaimConflict(q, companyId, userId, occ, role, visibleIds);
  const volunteers: any[] = [];
  const volIds = new Set<string>();
  const responses = await sessionVolunteers(q, companyId);
  for (const r of responses) {
    if (r.sessionId !== baseId || r.occDate !== occDate || r.role !== role) continue;
    // Account-keyed answers match the account directly; typed-name
    // answers (old no-login page) fall back to name matching.
    const u = (r.userId && userRows.find((x: any) => x.id === r.userId)) || matchUserByName(userRows, r.name);
    if (!u || volIds.has(u.id)) continue;
    volIds.add(u.id);
    volunteers.push({ userId: u.id, name: u.name, busy: await busyOf(u.id), offered: offered.has(u.id) });
  }
  // The offer list shows anyone BY DEPARTMENT (Deepika 2026-11-04):
  // the session's own department first, then its calendar's
  // departments; owners are always includable. No department anywhere
  // means the whole active team.
  let audience = userRows;
  {
    const memberSet = new Set<string>();
    if (occ.departmentId) {
      for (const id of await deptMemberIds(companyId, occ.departmentId)) memberSet.add(id);
    } else if (occ.dashboardId) {
      const { rows: dd } = await q('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [occ.dashboardId]);
      for (const d of dd) for (const id of await deptMemberIds(companyId, d.department_id)) memberSet.add(id);
    }
    if (memberSet.size) {
      for (const u of userRows) if ((u as any).role === 'owner') memberSet.add(u.id);
      audience = userRows.filter((u: any) => memberSet.has(u.id));
    }
  }
  const everyone: any[] = [];
  for (const u of audience) {
    if (volIds.has(u.id)) continue;
    everyone.push({ userId: u.id, name: u.name, busy: await busyOf(u.id), offered: offered.has(u.id) });
  }
  const roleLabel = (await sessionPersonLabel(q, companyId, occ)).toLowerCase();
  return { occ, roleLabel, volunteers, everyone };
}

// GET /api/schedule/session-offers/candidates (owner/scheduler).
router.get('/session-offers/candidates', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const baseId = baseSessionId(String(req.query.sessionId || ''));
    const occDate = String(req.query.occDate || '');
    const role = String(req.query.role || '');
    if (!baseId || !isValidDate(occDate) || role !== 'presenter') {
      res.status(400).json({ error: 'sessionId, occDate and role are required.' });
      return;
    }
    const out = await sessionOfferCandidates(query, req, baseId, occDate, role);
    if (out.error) { res.status(out.status || 400).json({ error: out.error }); return; }
    if (out.filled) { res.json({ filled: true }); return; }
    res.json({
      session: { title: out.occ.title, date: out.occ.date, startTime: out.occ.startTime, endTime: out.occ.endTime },
      roleLabel: out.roleLabel, volunteers: out.volunteers, everyone: out.everyone,
    });
  } catch (err) {
    console.error('[schedule] session-offer candidates failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/schedule/session-offers?from&to (owner/scheduler) — for
// annotating the Needs people page.
router.get('/session-offers', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!isValidDate(from) || !isValidDate(to)) { res.status(400).json({ error: 'from/to required.' }); return; }
    const { rows } = await query(
      `SELECT o.id, o.session_id AS "sessionId", o.occ_date::text AS "occDate", o.role, o.status,
              (SELECT json_agg(json_build_object('userId', r.user_id, 'claimedAt', r.claimed_at)) FROM session_offer_recipients r WHERE r.offer_id = o.id) AS recipients
       FROM session_offers o WHERE o.company_id = $1 AND o.occ_date BETWEEN $2 AND $3`,
      [req.session.companyId!, from, to]);
    res.json({ offers: rows });
  } catch (err) {
    console.error('[schedule] list session-offers failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/session-offers (owner/scheduler) — offer one
// occurrence's open role to the chosen people; merges into an existing
// open offer for the same occurrence + role.
router.post('/session-offers', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    const baseId = baseSessionId(String(b.sessionId || ''));
    const occDate = String(b.occDate || '');
    const role = String(b.role || '');
    const userIds: string[] = Array.isArray(b.userIds) ? [...new Set<string>(b.userIds.map((x: any) => String(x)))] : [];
    if (!baseId || !isValidDate(occDate) || role !== 'presenter' || !userIds.length) {
      res.status(400).json({ error: 'sessionId, occDate, role and at least one person are required.' });
      return;
    }
    const out = await sessionOfferCandidates(query, req, baseId, occDate, role);
    if (out.error) { res.status(out.status || 400).json({ error: out.error }); return; }
    if (out.filled) { res.status(400).json({ error: 'That spot is already filled.' }); return; }
    const valid = new Map<string, any>();
    for (const c of [...out.volunteers, ...out.everyone]) if (!c.busy) valid.set(c.userId, c);
    const chosen = userIds.filter((id) => valid.has(id));
    if (!chosen.length) { res.status(400).json({ error: 'None of the chosen people can take this session.' }); return; }
    const { rows: orows } = await query(
      `INSERT INTO session_offers (company_id, session_id, occ_date, role, dashboard_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, session_id, occ_date, role) DO UPDATE SET status = session_offers.status
       RETURNING id, status`,
      [companyId, baseId, occDate, role, out.occ.dashboardId || null, req.session.userId!]);
    const offer = orows[0];
    if (offer.status === 'filled') { res.status(400).json({ error: 'That spot is already filled.' }); return; }
    const added: Array<{ userId: string; token: string }> = [];
    let skipped = 0;
    for (const uid of chosen) {
      const token = crypto.randomBytes(32).toString('hex');
      const { rows: ins } = await query(
        `INSERT INTO session_offer_recipients (offer_id, user_id, token) VALUES ($1, $2, $3)
         ON CONFLICT (offer_id, user_id) DO NOTHING RETURNING id`,
        [offer.id, uid, token]);
      if (ins.length) added.push({ userId: uid, token });
      else skipped++;
    }
    if (added.length) {
      await sendSessionOfferNotifications(companyId,
        { id: offer.id, title: out.occ.title, occDate, roleLabel: out.roleLabel, startTime: out.occ.startTime },
        added);
    }
    res.json({ ok: true, added: added.length, skipped });
  } catch (err) {
    console.error('[schedule] create session-offer failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET/POST /api/schedule/session-offers/act/:token — the login-free
// accept page (server-rendered, POST button — a mail scanner's GET
// prefetch can never accept).
router.get('/session-offers/act/:token', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT r.id AS "recipientId", r.claimed_at AS "claimedAt", o.id AS "offerId", o.company_id AS "companyId",
              o.session_id AS "sessionId", o.occ_date::text AS "occDate", o.role, o.status,
              (u.first_name || ' ' || u.last_name) AS "userName", c.name AS "companyName"
       FROM session_offer_recipients r
       JOIN session_offers o ON o.id = r.offer_id
       JOIN users u ON u.id = r.user_id
       JOIN companies c ON c.id = o.company_id
       WHERE r.token = $1`,
      [String(req.params.token)]);
    if (!rows.length) { res.status(404).send(actPage('Link not valid', '<p>This link is not valid.</p>')); return; }
    const rec = rows[0];
    // Supervisors were retired (Deepika, 2026-11-07): an old offer for
    // the supervisor spot no longer applies — it can never be claimed.
    if (rec.role === 'supervisor') {
      res.send(actPage('This offer has closed', '<p>This session no longer needs a supervisor — thank you for offering!</p>'));
      return;
    }
    const resolved = await resolveOccurrence(query, rec.companyId, rec.sessionId, rec.occDate);
    if (!resolved) { res.send(actPage('Session not found', '<p>That session no longer exists on that date.</p>')); return; }
    const { occ } = resolved;
    const roleLabel = (await sessionPersonLabel(query, rec.companyId, occ)).toLowerCase();
    const when = `${fmtDateLong(rec.occDate)}${occ.startTime ? ' at ' + String(occ.startTime).slice(0, 5) : ''}`;
    const head = `<p style="font-size:16px">Hi ${escHtml(String(rec.userName).split(' ')[0])} — <b>${escHtml(occ.title)}</b> on ${escHtml(when)} needs ${/^[aeiou]/i.test(roleLabel) ? 'an' : 'a'} ${escHtml(roleLabel)}.</p>`;
    if (rec.claimedAt) { res.send(actPage('You are on this session', head + '<p>You already accepted this session. Thank you!</p>')); return; }
    // A presenter spot is filled when the occurrence has a lecturer
    // OR the series has any speakers at all (guests count).
    const filledNow = !!occ.lecturerUserId || (await sessionsWithSpeakers(query as any, [rec.sessionId])).has(rec.sessionId);
    if (rec.status === 'filled' || filledNow) {
      const who = occ.lecturerName;
      res.send(actPage('This session is filled', head + `<p>Someone has already taken this session${who ? ` — ${escHtml(who)}` : ''}. Thank you for offering!</p>`));
      return;
    }
    res.send(actPage('Accept this session?',
      head + `<p>First to accept gets the session.</p><form method="POST">${actButton('accept', 'Accept this session', '#0e7c86')}</form>`));
  } catch (err) {
    console.error('[schedule] session-offer act page failed:', err);
    res.status(500).send(actPage('Something went wrong', '<p>Please try again later.</p>'));
  }
});

router.post('/session-offers/act/:token', async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token);
    const { rows } = await query(
      `SELECT r.id AS "recipientId", r.user_id AS "userId", r.claimed_at AS "claimedAt", o.id AS "offerId",
              o.company_id AS "companyId", o.session_id AS "sessionId", o.occ_date::text AS "occDate", o.role,
              o.status, o.created_by AS "createdBy", (u.first_name || ' ' || u.last_name) AS "userName"
       FROM session_offer_recipients r
       JOIN session_offers o ON o.id = r.offer_id
       JOIN users u ON u.id = r.user_id
       WHERE r.token = $1`,
      [token]);
    if (!rows.length) { res.status(404).send(actPage('Link not valid', '<p>This link is not valid.</p>')); return; }
    const rec = rows[0];
    // Supervisors were retired (Deepika, 2026-11-07): a legacy
    // supervisor offer can never be claimed.
    if (rec.role === 'supervisor') {
      res.send(actPage('This offer has closed', '<p>This session no longer needs a supervisor — thank you for offering!</p>'));
      return;
    }
    if (rec.claimedAt) { res.send(actPage('Already accepted', '<p>You already accepted this session. Thank you!</p>')); return; }
    const outcome = await withTransaction(async (tx: any) => {
      const q = (text: string, params?: any[]) => tx.query(text, params);
      const { rows: locked } = await q('SELECT id, status FROM session_offers WHERE id = $1 FOR UPDATE', [rec.offerId]);
      if (!locked.length || locked[0].status === 'filled') return { kind: 'filled' } as any;
      const resolved = await resolveOccurrence(q, rec.companyId, rec.sessionId, rec.occDate);
      if (!resolved) return { kind: 'gone' } as any;
      const { base, occ } = resolved;
      const filledNow = !!occ.lecturerUserId || (await sessionsWithSpeakers(q, [rec.sessionId])).has(rec.sessionId);
      if (filledNow) {
        await q("UPDATE session_offers SET status = 'filled' WHERE id = $1", [rec.offerId]);
        return { kind: 'filled', occ } as any;
      }
      const conflict = await sessionClaimConflict(q, rec.companyId, rec.userId, occ, rec.role, null);
      if (conflict) return { kind: 'conflict', conflict, occ } as any;
      if (occ.date === base.date) {
        await q('UPDATE academic_sessions SET lecturer_user_id = $1 WHERE id = $2', [rec.userId, base.id]);
        // Keep the speakers list in step: the accepter is Speaker 1
        // (offers only open on speaker-less gaps, so the list is
        // expected empty — guard anyway).
        if (!(await sessionsWithSpeakers(q, [base.id])).has(base.id)) {
          await saveSpeakers(q, base.id, [{ userId: rec.userId }]);
        }
      } else {
        await q(
          `INSERT INTO academic_session_overrides (company_id, session_id, date, lecturer_user_id, has_lecturer)
           VALUES ($1, $2, $3, $4, true)
           ON CONFLICT (session_id, date) DO UPDATE SET lecturer_user_id = EXCLUDED.lecturer_user_id, has_lecturer = true, updated_at = now()`,
          [rec.companyId, base.id, occ.date, rec.userId]);
      }
      await q('UPDATE session_offer_recipients SET claimed_at = now() WHERE id = $1', [rec.recipientId]);
      await q("UPDATE session_offers SET status = 'filled' WHERE id = $1", [rec.offerId]);
      return { kind: 'claimed', occ, base } as any;
    });
    if (outcome.kind === 'filled' || outcome.kind === 'gone') {
      res.send(actPage('This session is filled', '<p>Someone has already taken this session. Thank you for offering!</p>'));
      return;
    }
    if (outcome.kind === 'conflict') {
      res.send(actPage('That would clash', `<p>You can't take this session: ${escHtml(outcome.conflict)}</p>`));
      return;
    }
    const occ = outcome.occ;
    const roleLabel = (await sessionPersonLabel(query, rec.companyId, occ)).toLowerCase();
    try {
      const approvers = await deptApproverIds(rec.companyId, occ.departmentId || null);
      const bellTo = [...new Set([...approvers, ...(rec.createdBy ? [rec.createdBy] : [])])].filter((id) => id !== rec.userId);
      if (bellTo.length) {
        await notify({
          companyId: rec.companyId, userIds: bellTo, category: 'calendar', type: 'session_offer_filled',
          title: `${rec.userName} took "${occ.title}" on ${fmtDateLong(rec.occDate)}`,
          body: `${rec.userName} accepted the session as ${roleLabel}.`,
          link: 'calendars', payload: { offerId: rec.offerId },
        });
      }
    } catch (e) { console.error('[schedule] session-offer filled bell failed:', e); }
    res.send(actPage('You are on this session',
      `<p>Thank you! You are the ${escHtml(roleLabel)} for <b>${escHtml(occ.title)}</b> on ${escHtml(fmtDateLong(rec.occDate))}${occ.startTime ? ' at ' + escHtml(String(occ.startTime).slice(0, 5)) : ''}.</p>`));
  } catch (err) {
    console.error('[schedule] session-offer act failed:', err);
    res.status(500).send(actPage('Something went wrong', '<p>Please try again later.</p>'));
  }
});

// Expand raw academic_sessions rows into the [from, to] window: recurring
// series become occurrence rows (id = "<base>@@<date>", seriesId = base id)
// with per-date overrides applied and cancelled dates dropped. Extracted
// verbatim from the GET /academic-sessions handler (2026-10-29) so the
// notification reminder engine expands sessions exactly the same way.
export function expandAcademicSessions(rows: any[], from: string | null, to: string | null, ovMap: Map<string, any>, userName: Map<string, string>): any[] {
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
  return out;
}

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
    const { rows: meRows } = await query('SELECT department_id FROM users WHERE id = $1', [req.session.userId!]);
    const myHomeDept: string | null = meRows[0]?.department_id || null;
    // VISIBILITY RULE (Deepika, 2026-11-07, final form): on a
    // CALENDAR, every user — owner included — sees only their OWN
    // events: ones they organized (created_by), speak at (any
    // speaker spot), are invited to (beneficiary, personally or via
    // a beneficiary department), or supervise (legacy). No owner
    // bypass. The dashboard-scoped fetch (calendar pages) always
    // uses this rule. The unscoped fetch (My Schedule, the Schedule
    // page's session boxes, Short cover) keeps department-scoped
    // visibility for owner/scheduler — Short cover's speaker-gap
    // queue for calendar managers is a deliberate exception — while
    // employees get the same own-events rule there too.
    const ownEventsSql = (): string => {
      params.push(req.session.userId!);
      const meP = params.length;
      let sql = `(s.created_by = $${meP} OR s.lecturer_user_id = $${meP} OR s.supervisor_user_id = $${meP}
        OR EXISTS (SELECT 1 FROM session_speakers sp WHERE sp.session_id = s.id AND sp.user_id = $${meP})
        OR EXISTS (SELECT 1 FROM session_beneficiary_users bu WHERE bu.session_id = s.id AND bu.user_id = $${meP})`;
      if (myHomeDept) {
        params.push(myHomeDept);
        sql += ` OR EXISTS (SELECT 1 FROM session_beneficiary_departments bd WHERE bd.session_id = s.id AND bd.department_id = $${params.length})`;
      }
      return sql + ')';
    };
    // ARCHIVED dashboards (migration 090): their sessions vanish from
    // every live fetch. The one exception is the archive history view:
    // an owner/scheduler explicitly opening THAT archived dashboard
    // from Settings sees all of its sessions, read-only (writes are
    // refused by the write endpoints). Employees never get it.
    let archivedDashRow: any = null;
    if (req.query.dashboardId && req.session.role !== 'employee') {
      const dRow = await dashboardRowById(companyId, String(req.query.dashboardId));
      if (dRow && dRow.archived_at) archivedDashRow = dRow;
    }
    if (archivedDashRow) {
      // No visibility clause: the whole archived calendar is history.
    } else if (req.query.dashboardId || req.session.role === 'employee') {
      clauses.push(ownEventsSql());
    } else if (ids) {
      params.push(ids);
      const visSql = sessionVisibleSql(params.length);
      params.push(req.session.userId!);
      let benSql = `EXISTS (SELECT 1 FROM session_beneficiary_users bu WHERE bu.session_id = s.id AND bu.user_id = $${params.length})`;
      if (myHomeDept) {
        params.push(myHomeDept);
        benSql += ` OR EXISTS (SELECT 1 FROM session_beneficiary_departments bd WHERE bd.session_id = s.id AND bd.department_id = $${params.length})`;
      }
      clauses.push(`(${visSql} OR ${benSql})`);
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
    if (!archivedDashRow) {
      clauses.push('NOT EXISTS (SELECT 1 FROM dashboards dx WHERE dx.id = s.dashboard_id AND dx.archived_at IS NOT NULL)');
    }
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
    const out = expandAcademicSessions(rows, from, to, ovMap, userName);
    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startTime || '99') < (b.startTime || '99') ? -1 : 1;
    });
    // EVENT model payload: speakers in effect per occurrence,
    // beneficiaries, and this viewer's relationship to the event.
    {
      const seriesIds = [...new Set(out.map((o: any) => o.seriesId || o.id))];
      const [spMap, benMap] = await Promise.all([
        loadSpeakers(query as any, seriesIds),
        loadBeneficiaries(query as any, seriesIds),
      ]);
      // Effective person label per occurrence (Deepika, 2026-11-07):
      // the session's own override, else its kind's label, else
      // 'Speaker'. The raw override also rides along as
      // personLabelOverride (from academicRow) so the edit form can
      // tell "renamed for this session" from "follows the type".
      const { rows: kindRows } = await query('SELECT key, dashboard_id AS "dashboardId", person_label AS "personLabel" FROM session_kinds WHERE company_id = $1', [companyId]);
      const effPersonLabel = (o: any): string => {
        if (o.personLabelOverride) return o.personLabelOverride;
        const k = kindRows.find((x: any) => x.key === o.kind && x.dashboardId === o.dashboardId)
          || kindRows.find((x: any) => x.key === o.kind && x.personLabel);
        return (k && k.personLabel) || 'Speaker';
      };
      const dashDepts = new Map<string, string[]>();
      if (ids) {
        const dashIds = [...new Set(out.map((o: any) => o.dashboardId).filter(Boolean))] as string[];
        if (dashIds.length) {
          const { rows: dd } = await query('SELECT dashboard_id, department_id FROM dashboard_departments WHERE dashboard_id = ANY($1::uuid[])', [dashIds]);
          for (const r of dd) {
            if (!dashDepts.has(r.dashboard_id)) dashDepts.set(r.dashboard_id, []);
            dashDepts.get(r.dashboard_id)!.push(r.department_id);
          }
        }
      }
      const canSeeEmails = req.session.role === 'owner' || req.session.role === 'scheduler';
      // RSVPs (Deepika, 2026-11-07): per-occurrence replies from
      // invited attendees. myRsvp goes to invited viewers; the tally
      // (yes/maybe/no/not-replied) only to the organizer, speakers,
      // and editors who can see the event.
      const invitedMap = await loadInvitedUserIds(query as any, companyId, seriesIds);
      const rsvpMap = new Map<string, Map<string, { userId: string; status: string }[]>>();
      if (seriesIds.length) {
        const { rows: rr } = await query(
          'SELECT session_id, session_date::text AS d, user_id, status FROM session_rsvps WHERE session_id = ANY($1::uuid[])',
          [seriesIds]);
        for (const r of rr) {
          if (!rsvpMap.has(r.session_id)) rsvpMap.set(r.session_id, new Map());
          const byDate = rsvpMap.get(r.session_id)!;
          if (!byDate.has(r.d)) byDate.set(r.d, []);
          byDate.get(r.d)!.push({ userId: r.user_id, status: r.status });
        }
      }
      const tallyOk = new Map<string, boolean>();
      for (const o of out) {
        const sid = o.seriesId || o.id;
        if (!tallyOk.has(sid)) {
          let ok = o.createdBy === req.session.userId;
          if (!ok) ok = await canEditSessionQuiet(req, o.dashboardId || null, o.departmentId || null);
          tallyOk.set(sid, ok);
        }
      }
      for (const o of out) {
        const sid = o.seriesId || o.id;
        o.personLabel = effPersonLabel(o);
        const eff = effectiveSpeakers(spMap.get(sid) || [], o.lecturerUserId || null, o.lecturerName || null);
        o.speakers = eff.map((s: any) => ({
          userId: s.userId || null, name: s.name || null, guest: !!s.guest,
          ...(canSeeEmails && s.guest ? { guestEmail: s.guestEmail || null } : {}),
        }));
        o.hasSpeakers = eff.length > 0;
        const ben = benMap.get(sid) || { departmentIds: [], userIds: [] };
        o.beneficiaryDepartmentIds = ben.departmentIds;
        o.beneficiaryUserIds = ben.userIds;
        o.viewerIsSpeaker = eff.some((s: any) => s.userId && s.userId === req.session.userId);
        o.viewerIsBeneficiary = ben.userIds.includes(req.session.userId!) || (!!myHomeDept && ben.departmentIds.includes(myHomeDept));
        if (req.query.dashboardId || req.session.role === 'employee' || !ids) {
          // Own-events viewers (and owners, who have no department
          // set): "invited only" = they attend as a beneficiary and
          // do not speak or supervise.
          const involved = o.lecturerUserId === req.session.userId || o.supervisorUserId === req.session.userId || o.viewerIsSpeaker;
          o.viewerInvitedOnly = !!o.viewerIsBeneficiary && !involved;
        } else {
          const dd = o.dashboardId ? (dashDepts.get(o.dashboardId) || []) : null;
          const viaCalendar = (!!o.departmentId && ids.includes(o.departmentId))
            || (dd ? (dd.some((d) => ids.includes(d)) || dd.length === 0) : false);
          o.viewerInvitedOnly = !viaCalendar && o.viewerIsBeneficiary;
        }
        o.dashboardArchived = !!archivedDashRow;
        // RSVP attach: this occurrence's own reply + tally.
        const rsvpsHere = (rsvpMap.get(sid) || new Map()).get(o.date) || [];
        const mine = rsvpsHere.find((r: any) => r.userId === req.session.userId);
        o.myRsvp = mine ? mine.status : null;
        o.rsvpSummary = null;
        const invitedIds = invitedMap.get(sid) || [];
        if (invitedIds.length && (tallyOk.get(sid) || o.viewerIsSpeaker)) {
          const yes = rsvpsHere.filter((r: any) => r.status === 'yes').length;
          const maybe = rsvpsHere.filter((r: any) => r.status === 'maybe').length;
          const no = rsvpsHere.filter((r: any) => r.status === 'no').length;
          o.rsvpSummary = {
            invited: invitedIds.length, yes, maybe, no,
            notReplied: Math.max(0, invitedIds.length - yes - maybe - no),
          };
        }
      }
    }
    res.json({
      sessions: out,
      dashboardArchived: !!archivedDashRow,
      archivedAt: archivedDashRow ? archivedDashRow.archived_at : null,
    });
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

// ---------- Generated meeting links (migration 091) ----------
// Clean the meeting pair a form posts: a provider + external id only
// ride along together, and only for a known provider.
function cleanMeetingPair(b: any): { provider: string | null; externalId: string | null } {
  const provider = isMeetingProvider(b.meetingProvider) ? b.meetingProvider : null;
  const externalId = b.meetingExternalId ? String(b.meetingExternalId).slice(0, 300) : null;
  if (!provider || !externalId) return { provider: null, externalId: null };
  return { provider, externalId };
}

// Build the provider-side meeting input from session-shaped values
// (shared by the generate endpoint and the edit-sync below).
function meetingInputFrom(title: string, dateStr: any, startTime: any, endTime: any, timezone: any): MeetingInput | { error: string } {
  const date = dateStr instanceof Date ? dateStr.toISOString().slice(0, 10) : String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Pick a date first — the meeting needs one.' };
  const start = startTime ? String(startTime).slice(0, 5) : '';
  if (!/^\d{2}:\d{2}$/.test(start)) return { error: 'Add a start time first — online meetings need one.' };
  const end = endTime ? String(endTime).slice(0, 5) : null;
  const tz = timezone && /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/.test(String(timezone)) ? String(timezone) : 'UTC';
  const n = normalizeMeetingTimes(date, start, end && /^\d{2}:\d{2}$/.test(end) ? end : null);
  return { title: title || 'Session', timezone: tz, ...n };
}

// POST /api/schedule/sessions/meeting-link — one tap in the session
// form: create a real Zoom / Teams / Google Meet meeting from the
// form's CURRENT (possibly unsaved) values, on the company's
// once-connected account. The form stashes provider + externalId and
// persists them with the session save.
router.post('/sessions/meeting-link', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    if (!isMeetingProvider(b.provider)) { res.status(400).json({ error: 'Unknown meeting service.' }); return; }
    const provider = b.provider;
    if (!providerConfigured(provider)) {
      res.status(400).json({ code: 'not_configured', error: `${providerName(provider)} is not set up yet.` });
      return;
    }
    const title = String(b.title || '').trim();
    if (!title) { res.status(400).json({ error: 'Give the event a name first — the meeting takes its name from it.' }); return; }
    const input = meetingInputFrom(title, b.date, b.startTime, b.endTime, b.timezone);
    if ('error' in input) { res.status(400).json({ error: input.error }); return; }
    const token = await getValidAccessToken(companyId, provider);
    // A Google room picked in the form (migration 092) rides along
    // as a resource attendee, booking the room on Google's side too.
    const roomResourceId = provider === 'google' && b.roomResourceId ? String(b.roomResourceId).slice(0, 300) : null;
    const made = await createMeeting(provider, token, { ...input, roomResourceId });
    res.json({ ok: true, link: made.link, provider, externalId: made.externalId });
  } catch (err) {
    if (err instanceof MeetingError) {
      const status = err.code === 'not_connected' || err.code === 'reconnect' || err.code === 'consent_required' ? 409 : 502;
      res.status(status).json({ code: err.code, error: err.message });
      return;
    }
    console.error('[schedule] meeting-link generate failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ------------------------------------------------------------------
// Calendar report logging (Deepika, 2026-11-07): event changes are
// written to the audit table under category 'calendar' and shown in
// their OWN Calendar report — never mixed into the schedule Run
// report. Descriptions are one plain sentence saying what happened;
// edits spell out what changed. RSVPs are NOT logged (attendance
// replies are noise, not edits).
// ------------------------------------------------------------------
const CAL_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function calDstr(v: any): string {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function calFmtDate(v: any): string {
  const s = calDstr(v);
  const p = s.split('-');
  if (p.length !== 3) return s;
  return `${CAL_MONTHS[(+p[1] || 1) - 1]} ${+p[2] || 1}, ${p[0]}`;
}
function calFmtTime(v: any): string { return v ? String(v).slice(0, 5) : ''; }
function calFmtRange(start: any, end: any): string {
  const s = calFmtTime(start), e = calFmtTime(end);
  return s && e ? `${s}–${e}` : (s || e || '');
}
async function calNames(companyId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter(Boolean).map(String))];
  if (!want.length) return out;
  const { rows } = await query('SELECT id, first_name, last_name, nickname FROM users WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, want]);
  for (const u of rows) out.set(u.id, u.nickname || `${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Someone');
  return out;
}
async function calDeptNames(companyId: string, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = [...new Set(ids.filter(Boolean).map(String))];
  if (!want.length) return out;
  const { rows } = await query('SELECT id, name FROM departments WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, want]);
  for (const d of rows) out.set(d.id, d.name);
  return out;
}
function calSpeakerLabel(sp: { userId?: string | null; guestName?: string | null; guestEmail?: string | null }, names: Map<string, string>): string {
  if (sp.userId) return names.get(sp.userId) || 'A team member';
  return sp.guestName || sp.guestEmail || 'A guest';
}
function calListNames(list: string[], max = 4): string {
  if (!list.length) return '';
  return list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max} more`;
}
function calRecurText(s: { recurRule?: any; recurInterval?: any; recurDays?: any; recurUntil?: any; recurCount?: any }): string {
  // Stored 'biweekly' reads as weekly with interval 2 (the PUT's own
  // normalisation) so a no-op save on such a series stays silent.
  const rule = s.recurRule === 'biweekly' ? 'weekly' : (s.recurRule || 'none');
  const interval = s.recurRule === 'biweekly' ? 2 : (s.recurInterval || 1);
  const d = describeRecur({ recurRule: rule, recurInterval: interval, recurDays: s.recurDays ?? null, recurUntil: s.recurUntil ?? null, recurCount: s.recurCount ?? null });
  if (!d) return 'does not repeat';
  const tx = d.replace(/\.$/, '');
  return tx.charAt(0).toLowerCase() + tx.slice(1);
}
async function calAudit(req: Request, e: { date: string; action: 'created' | 'updated' | 'deleted'; verb?: string; description: string; details?: any }): Promise<void> {
  await auditLog({
    companyId: req.session.companyId!,
    date: e.date || todayStr(),
    action: e.action,
    category: 'calendar',
    changedBy: req.session.userId!,
    description: e.description,
    details: { ...(e.details || {}), ...(e.verb ? { verb: e.verb } : {}), calendarEvent: true },
  });
}

// POST /api/schedule/academic-sessions — edit-scoped for
// owner/scheduler; employees may create events they organize.
//
// The create itself lives in createSessionFromBody so the bulk
// calendar upload (session-import, below) creates events through the
// EXACT same path — same gates, organizing-department rule, speaker
// mirror, attendee snapshot, Calendar-report audit entry, speaker
// notifications and one-time guest email. It returns a result instead
// of writing a response; the side effects that today run AFTER the
// response (notifications + guest email) ride back as afterResponse
// for the caller to run once it has answered.
type SessionCreateResult =
  | { ok: true; id: string; afterResponse: () => Promise<void> }
  | { ok: false; status: number; error: string };

// A stand-in response that only records what a gate wrote, so the
// res-writing edit gates (sessionEditCheck) can run inside
// createSessionFromBody and hand their status/message back.
function sessionGateProbe(): { res: Response; status: () => number; error: () => string } {
  let status = 200;
  let message = '';
  const res: any = {
    status: (c: number) => { status = c; return res; },
    json: (p: any) => { if (p && p.error) message = String(p.error); return res; },
  };
  return { res: res as Response, status: () => status, error: () => message };
}

async function createSessionFromBody(req: Request, b: any): Promise<SessionCreateResult> {
    const companyId = req.session.companyId!;
    const title = String(b.title || '').trim();
    if (!title) return { ok: false, status: 400, error: 'A title is required.' };
    let dashboardId: string | null = null;
    if (b.dashboardId) {
      const { rows: dRows } = await query('SELECT id, archived_at FROM dashboards WHERE id = $1 AND company_id = $2', [String(b.dashboardId), companyId]);
      if (!dRows.length) return { ok: false, status: 400, error: 'Unknown dashboard.' };
      if (dRows[0].archived_at) return { ok: false, status: 409, error: 'That dashboard is archived — restore it from Settings → Dashboards to add sessions.' };
      dashboardId = String(b.dashboardId);
    }
    // EVENT model (2026-11-07): on a calendar, department_id is the
    // event's ORGANIZING department. It must be one the caller may
    // organize for on this calendar; with exactly one manageable
    // department it fills in by itself; with none the create is
    // refused. Dashboard-less creates (legacy API callers) keep the
    // old department path.
    let departmentId: string | null = null;
    if (dashboardId) {
      // Employee create (Deepika, 2026-11-07): any team member may
      // add an event on a calendar they can open (e.g. a meeting).
      // They organize under their own department (or none) and can
      // later edit/delete only their own events. Dashboard-editor
      // lists don't block a create; edit rights are separate.
      const isEmployeeCreator = req.session.role === 'employee';
      if (!isEmployeeCreator) {
        const gate = sessionGateProbe();
        if (!(await sessionEditCheck(req, gate.res, dashboardId, null))) return { ok: false, status: gate.status() || 403, error: gate.error() || 'You do not have permission to do that.' };
      }
      if (isEmployeeCreator) {
        const { rows: meR } = await query('SELECT department_id FROM users WHERE id = $1', [req.session.userId!]);
        departmentId = meR[0]?.department_id || null;
      } else {
        const manageable = await manageableOrgDeptIds(req, dashboardId);
        if (b.departmentId) {
          departmentId = String(b.departmentId);
          if (!manageable.includes(departmentId)) {
            return { ok: false, status: 403, error: 'You can only organize events for a department you manage on this calendar.' };
          }
        } else if (manageable.length === 1) {
          departmentId = manageable[0];
        } else if (manageable.length === 0) {
          return { ok: false, status: 403, error: "You don't manage a department on this calendar." };
        } else {
          return { ok: false, status: 400, error: 'Choose the organizing department for this event.' };
        }
      }
    } else {
      departmentId = b.departmentId ? String(b.departmentId) : null;
      const gate = sessionGateProbe();
      if (!(await sessionEditCheck(req, gate.res, null, departmentId))) return { ok: false, status: gate.status() || 403, error: gate.error() || 'You do not have permission to do that.' };
    }
    // Speakers: the new form posts the full list; older callers post
    // lecturerUserId, which becomes Speaker 1. The lecturer column
    // mirrors Speaker 1 when Speaker 1 is a team member.
    let speakersIn: { userId?: string | null; guestName?: string | null; guestEmail?: string | null }[] | null = null;
    let lecturerId: string | null = b.lecturerUserId ? String(b.lecturerUserId) : null;
    if (b.speakers !== undefined) {
      const cleaned = await cleanSpeakers(query as any, companyId, b.speakers);
      if ('error' in cleaned) return { ok: false, status: 400, error: cleaned.error };
      speakersIn = cleaned.speakers;
      lecturerId = speakerMirror(speakersIn);
    } else if (lecturerId) {
      const { rows } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [lecturerId, companyId]);
      if (!rows.length) return { ok: false, status: 400, error: 'That lecturer is not an active team member.' };
      speakersIn = [{ userId: lecturerId }];
    }
    // A supervisorUserId in the body is ignored on purpose:
    // supervisors were retired (Deepika, 2026-11-07) — new sessions
    // never get one (the column stays for stored history).
    let beneficiaries: { departmentIds: string[]; userIds: string[] } | null = null;
    if (b.beneficiaryDepartmentIds !== undefined || b.beneficiaryUserIds !== undefined) {
      const cb = await cleanBeneficiaries(query as any, companyId, b.beneficiaryDepartmentIds, b.beneficiaryUserIds);
      if ('error' in cb) return { ok: false, status: 400, error: cb.error };
      beneficiaries = cb;
    }
    const mu = cleanMeetingUrl(b.meetingUrl);
    if ('error' in mu) return { ok: false, status: 400, error: mu.error };
    const rec = cleanRecur(b);
    const recurRule = rec.rule;
    const recurDays = cleanRecurDays(b.recurDays);
    const recurUntil = recurRule !== 'none' && b.recurUntil ? String(b.recurUntil) : (recurRule !== 'none' ? null : null);
    const kind = await cleanKind(companyId, dashboardId, b.kind);
    // Role name for THIS session only (migration 089): the form
    // posts the override when it differs from the type's label, or
    // null to follow the type. Callers that don't post it (the Email
    // Q-Scheduler plan path) leave it NULL — the type label applies.
    const personLabelVal = b.personLabel !== undefined ? cleanPersonLabel(b.personLabel) : null;
    // Generated meeting link (migration 091): the form may have
    // already created the provider meeting and posts its pair; the
    // link itself rides in meeting_url (mu) as usual.
    const pair = cleanMeetingPair(b);
    // Room booking (migration 092): an in-app room is double-book
    // guarded — saving into a held room is refused outright. The
    // server is authoritative for an app room's name (it becomes the
    // location text); a connected room keeps the posted location.
    const roomSel = await cleanRoomSelection(companyId, b);
    if ('error' in roomSel) return { ok: false, status: 400, error: roomSel.error };
    if (roomSel.roomId) {
      const roomFull = await roomRowById(companyId, roomSel.roomId);
      const conflict = await findRoomConflict(companyId, roomFull, {
        date: String(b.date || ''), startTime: b.startTime || null, endTime: b.endTime || null,
        recurRule, recurInterval: rec.interval, recurDays, recurUntil: recurUntil ? String(recurUntil).slice(0, 10) : null, recurCount: rec.count,
      });
      if (conflict) return { ok: false, status: 409, error: `'${roomFull.name}' is already booked by '${conflict.title}' at that time.` };
    }
    const locationVal = roomSel.roomId ? roomSel.roomName : (b.location ? String(b.location).trim() : null);
    const { rows } = await query(
      `INSERT INTO academic_sessions (id, company_id, title, lecturer_user_id, department_id, session_date, start_time, end_time, location, kind, notes, created_by, dashboard_id, recur_rule, recur_until, supervisor_user_id, recur_days, recur_interval, recur_count, meeting_url, person_label, meeting_provider, meeting_external_id, room_id, room_source, room_external_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING id`,
      [crypto.randomUUID(), companyId, title, lecturerId, departmentId,
       b.date, b.startTime || null, b.endTime || null, locationVal,
       kind, b.notes ? String(b.notes).trim() : null, req.session.userId!, dashboardId, recurRule, recurUntil, null,
       recurRule === 'weekly' ? (recurDays.length ? recurDays.join(',') : null) : null, rec.interval, rec.count, mu.url, personLabelVal,
       pair.provider, pair.externalId, roomSel.roomId, roomSel.roomSource, roomSel.roomExternalId]);
    const newSessionId = rows[0].id;
    if (speakersIn) await saveSpeakers(query as any, newSessionId, speakersIn);
    if (beneficiaries) await saveBeneficiaries(query as any, newSessionId, beneficiaries.departmentIds, beneficiaries.userIds);
    // Calendar report: the creation itself.
    {
      const spkNames = await calNames(companyId, (speakersIn || []).filter((s) => s.userId).map((s) => String(s.userId)));
      const spk = (speakersIn || []).map((s) => calSpeakerLabel(s, spkNames));
      const bits: string[] = [];
      const rng = calFmtRange(b.startTime, b.endTime);
      bits.push(`${calFmtDate(b.date)}${rng ? ' ' + rng : ''}`);
      if (spk.length) bits.push(`speaker${spk.length > 1 ? 's' : ''} ${calListNames(spk)}`);
      if (beneficiaries && (beneficiaries.userIds.length || beneficiaries.departmentIds.length)) {
        const aNames = await calNames(companyId, beneficiaries.userIds);
        const dNames = await calDeptNames(companyId, beneficiaries.departmentIds);
        const att = [...beneficiaries.departmentIds.map((d) => dNames.get(d) || 'a department'), ...beneficiaries.userIds.map((u) => aNames.get(u) || 'a team member')];
        bits.push(`for ${calListNames(att)}`);
      }
      if (recurRule !== 'none') bits.push(calRecurText({ recurRule, recurInterval: rec.interval, recurDays, recurUntil, recurCount: rec.count }));
      await calAudit(req, {
        date: calDstr(b.date) || todayStr(), action: 'created',
        description: `Created event "${title}" — ${bits.join(', ')}`,
        details: { sessionId: newSessionId },
      });
    }
    const afterResponse = async (): Promise<void> => {
    // Notify the team speakers; an event with NO speakers
    // at all (guests count as speakers) tells the calendar's
    // department members a presenter is needed.
    {
      const people = [...(speakersIn || []).filter((s) => s.userId).map((s) => String(s.userId))];
      const dateStr = b.date ? String(b.date).slice(0, 10) : '';
      if (people.length) {
        notify({
          companyId, userIds: people, category: 'calendar', type: 'session_assigned',
          title: `New session: "${title}"${dateStr ? ` on ${fmtDateLong(dateStr)}` : ''}`,
          body: `You are on the session "${title}"${dateStr ? ` on ${fmtDateLong(dateStr)}` : ''}${b.startTime ? ` at ${String(b.startTime).slice(0, 5)}` : ''}.`,
          link: 'calendars', bundleKey: 'session_assigned',
          excludeUserId: req.session.userId!,
        });
      } else if (!speakersIn || !speakersIn.length) {
        let memberIds: string[] = [];
        if (dashboardId) {
          const { rows: dd } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [dashboardId]);
          for (const d of dd) memberIds.push(...await deptMemberIds(companyId, d.department_id));
        } else if (departmentId) {
          memberIds = await deptMemberIds(companyId, departmentId);
        }
        if (memberIds.length) {
          const effLabel = personLabelVal || await personLabelFor(query, companyId, dashboardId, kind);
          const effLower = effLabel.toLowerCase();
          notify({
            companyId, userIds: memberIds, category: 'calendar', type: 'session_needs_presenter',
            title: `A session needs ${labelArticle(effLabel)} ${effLower}: "${title}"${dateStr ? ` on ${fmtDateLong(dateStr)}` : ''}`,
            body: `"${title}" has no ${effLower} yet.`,
            link: 'calendars', bundleKey: 'session_needs_presenter',
            excludeUserId: req.session.userId!,
          });
        }
      }
    }
    // Guest speakers with an email get ONE details email (best
    // effort — failures are logged inside emailGuests, never thrown).
    if (speakersIn && speakersIn.some((g) => !g.userId && g.guestEmail)) {
      const ctx = await guestMailCtx(req, {
        dashboardId, departmentId, title,
        date: b.date ? String(b.date).slice(0, 10) : '',
        startTime: b.startTime || null, endTime: b.endTime || null,
        location: b.location ? String(b.location).trim() : null, meetingUrl: mu.url,
        recurText: describeRecur({ recurRule, recurInterval: rec.interval, recurDays, recurUntil, recurCount: rec.count }),
      });
      await emailGuests(speakersIn, ctx);
    }
    };
    return { ok: true, id: newSessionId, afterResponse };
}

router.post('/academic-sessions', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const r = await createSessionFromBody(req, req.body ?? {});
    if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
    res.json({ ok: true, id: r.id });
    await r.afterResponse();
  } catch (err) {
    console.error('[schedule] academic session create failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Bulk calendar-event upload — "⬆ Upload schedule" (Deepika,
// 2026-11-07). Download the sheet format, upload a filled .csv /
// .xlsx, check the preview (NOTHING is saved), answer what's
// missing, then import. Creations go through createSessionFromBody —
// the exact path the Add event form uses — so the organizing-
// department rule, speaker mirror, attendee snapshot, one-time guest
// email and Calendar-report audit entry all match a hand-added
// event. Rows are independent: one bad row never rolls back others.
// ---------------------------------------------------------------------------

const SESSION_IMPORT_MAX_ROWS = 500;
const SESSION_IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_IMPORT_HEADERS = ['Date', 'Start', 'End', 'Event name', 'Session type', 'Speaker', 'Attendees', 'Room', 'Meeting link', 'Notes'];

// GET /api/schedule/session-import/template — the blank sheet: the
// exact column headers plus two example rows and nothing else.
router.get('/session-import/template', requireRole('owner', 'scheduler'), async (_req: Request, res: Response) => {
  const lines = [
    SESSION_IMPORT_HEADERS.join(','),
    '2027-03-08,9:00 AM,10:00 AM,Cardiology Lecture,Lecture,Jane Smith,Cardiology,Room 4,,',
    '2027-03-09,1:00 PM,2:00 PM,Resident Interview,Interview,Guest Name <guest@email>,,,,Bring the candidate list',
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="session-schedule-template.csv"');
  res.send(lines.join('\r\n') + '\r\n');
});

// A sheet time as "HH:MM": accepts "10:00 AM", "10:00", "22:00".
function sessImpTime(raw: string): string | null {
  const t = String(raw || '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (min > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
    if (m[3].toLowerCase() === 'am' && h === 12) h = 0;
  } else if (h > 23) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

// A spreadsheet time CELL (Excel times arrive as a day fraction or a
// Date; CSV cells as text) → display text the time parser accepts.
function sessImpTimeCellText(cell: any): string {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return String(cell.getHours()).padStart(2, '0') + ':' + String(cell.getMinutes()).padStart(2, '0');
  }
  if (typeof cell === 'number' && isFinite(cell)) {
    const frac = cell - Math.floor(cell);
    if (frac > 0) {
      const mins = Math.round(frac * 1440) % 1440;
      return String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');
    }
    return String(cell);
  }
  return String(cell ?? '').trim();
}

// A spreadsheet text cell → trimmed text (Date/serial cells → date).
function sessImpCellText(cell: any): string {
  if (cell instanceof Date && !isNaN(cell.getTime())) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'number' && isFinite(cell) && cell >= 20000 && cell <= 80000) return excelSerialToDate(cell);
  return String(cell ?? '').trim();
}

type SessImpCol = 'date' | 'start' | 'end' | 'title' | 'kind' | 'speaker' | 'attendees' | 'room' | 'meeting' | 'notes';
function sessImpColKind(header: string): SessImpCol | null {
  const t = header.toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'date' || t === 'day') return 'date';
  if (t === 'start' || t === 'starttime' || t === 'from') return 'start';
  if (t === 'end' || t === 'endtime' || t === 'to' || t === 'until') return 'end';
  if (t === 'eventname' || t === 'event' || t === 'title' || t === 'name') return 'title';
  if (t === 'sessiontype' || t === 'type' || t === 'kind') return 'kind';
  if (t === 'speaker' || t === 'presenter' || t === 'lecturer' || t === 'interviewer') return 'speaker';
  if (t === 'attendees' || t === 'attendee' || t === 'audience' || t === 'beneficiaries' || t === 'invited') return 'attendees';
  if (t === 'room' || t === 'location') return 'room';
  if (t === 'meetinglink' || t === 'meetingurl' || t === 'link' || t === 'url' || t === 'meeting') return 'meeting';
  if (t === 'notes' || t === 'note' || t === 'description') return 'notes';
  return null;
}

// Uploaded file → a raw grid of cells (CSV parsed as text; anything
// else read as a workbook, mirroring the team-member import).
function sessImpGrid(filename: string, buf: Buffer): { grid: any[][] } | { error: string } {
  const isZip = buf.subarray(0, 2).toString('latin1') === 'PK';
  const fname = filename.toLowerCase();
  if (!isZip && (fname.endsWith('.csv') || fname.endsWith('.txt') || !fname)) {
    return { grid: parseCsvText(buf.toString('utf8')) as any[][] };
  }
  try {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) return { error: 'That file could not be read as a spreadsheet or CSV.' };
    return { grid: XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as any[][] };
  } catch {
    return { error: 'That file could not be read as a spreadsheet or CSV.' };
  }
}

interface SessImpMember { id: string; name: string; email: string; }
interface SessImpQuestion {
  id: string; kind: 'date' | 'start' | 'end' | 'title' | 'kind' | 'speaker' | 'attendee' | 'duplicate' | 'meeting';
  prompt: string; value?: string; token?: string;
  candidates?: Array<{ id: string; name: string; email: string }>;
  guest?: { name: string; email: string };
}

// Load the reference data a preview/import matches against.
async function sessImpRefs(companyId: string, dashboardId: string) {
  await ensureKinds(companyId, dashboardId);
  const { rows: kindRows } = await query('SELECT * FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2 ORDER BY position, label', [companyId, dashboardId]);
  const kinds = kindRows.map(kindRow);
  const { rows: userRows } = await query(
    `SELECT id, first_name, last_name, nickname, email FROM users WHERE company_id = $1 AND is_active = true ORDER BY first_name, last_name`,
    [companyId]);
  const members: SessImpMember[] = userRows.map((u: any) => ({
    id: String(u.id),
    name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || String(u.email || ''),
    email: String(u.email || ''),
  }));
  const byEmail = new Map<string, SessImpMember>();
  const byName = new Map<string, SessImpMember[]>();
  const pushName = (key: string, m: SessImpMember) => {
    if (!key) return;
    const arr = byName.get(key) || [];
    if (!arr.find((x) => x.id === m.id)) arr.push(m);
    byName.set(key, arr);
  };
  for (const u of userRows as any[]) {
    const m = members.find((x) => x.id === String(u.id))!;
    if (m.email) byEmail.set(m.email.toLowerCase(), m);
    pushName(m.name.toLowerCase(), m);
    if (u.nickname) pushName(String(u.nickname).toLowerCase(), m);
    const parts = m.name.split(/\s+/);
    if (parts.length >= 2) pushName(`${parts[parts.length - 1]}, ${parts.slice(0, -1).join(' ')}`.toLowerCase(), m);
  }
  const { rows: deptRows } = await query('SELECT id, name FROM departments WHERE company_id = $1 ORDER BY name', [companyId]);
  const departments = deptRows.map((d: any) => ({ id: String(d.id), name: String(d.name) }));
  return { kinds, members, byEmail, byName, departments };
}

// Match one sheet name/email against the active members.
function sessImpMatchPerson(text: string, refs: { byEmail: Map<string, SessImpMember>; byName: Map<string, SessImpMember[]> }):
  { one: SessImpMember } | { many: SessImpMember[] } | { none: true } {
  const t = String(text || '').trim();
  if (!t) return { none: true };
  const lt = t.match(/<([^>]+)>/);
  const emailPart = lt ? lt[1].trim() : (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null);
  if (emailPart) {
    const m = refs.byEmail.get(emailPart.toLowerCase());
    if (m) return { one: m };
  }
  const namePart = (lt ? t.slice(0, lt.index).trim() : t).toLowerCase();
  if (namePart) {
    const hits = refs.byName.get(namePart) || [];
    if (hits.length === 1) return { one: hits[0] };
    if (hits.length > 1) return { many: hits };
  }
  return { none: true };
}

// Split a speaker cell into its display name + email parts.
function sessImpSpeakerParts(text: string): { name: string; email: string } {
  const t = String(text || '').trim();
  const lt = t.match(/^(.*?)<([^>]+)>\s*$/);
  if (lt) return { name: lt[1].trim(), email: lt[2].trim() };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { name: '', email: t };
  return { name: t, email: '' };
}

// Existing-event duplicate keys for a calendar: date|start|title.
async function sessImpDuplicateKeys(companyId: string, dashboardId: string, minDate: string, maxDate: string): Promise<Set<string>> {
  const keys = new Set<string>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(minDate) || !/^\d{4}-\d{2}-\d{2}$/.test(maxDate) || maxDate < minDate) return keys;
  const { rows: sessRows } = await query(
    `SELECT * FROM academic_sessions WHERE company_id = $1 AND dashboard_id = $2 AND session_date <= $3 AND (recur_rule IS NULL OR recur_rule = 'none' OR recur_until IS NULL OR recur_until >= $4)`,
    [companyId, dashboardId, maxDate, minDate]);
  if (!sessRows.length) return keys;
  const ovMap = await loadOverrides(companyId, sessRows.map((r: any) => r.id), minDate, maxDate);
  for (const o of expandAcademicSessions(sessRows as any[], minDate, maxDate, ovMap, new Map())) {
    keys.add(`${o.date}|${o.startTime || ''}|${String(o.title || '').toLowerCase()}`);
  }
  return keys;
}

// The calendar gate shared by preview + import: the caller must be
// able to add events with edit rights on this calendar.
async function sessImpGate(req: Request, res: Response, dashboardId: string):
  Promise<{ companyId: string; manageable: string[] } | null> {
  const companyId = req.session.companyId!;
  const { rows: dRows } = await query('SELECT id, archived_at FROM dashboards WHERE id = $1 AND company_id = $2', [dashboardId, companyId]);
  if (!dRows.length) { res.status(400).json({ error: 'Unknown dashboard.' }); return null; }
  if (dRows[0].archived_at) { res.status(409).json({ error: 'That dashboard is archived — restore it from Settings → Dashboards to add sessions.' }); return null; }
  if (!(await canEditSessionQuiet(req, dashboardId, null))) {
    res.status(403).json({ error: 'You do not have permission to add events to this calendar.' });
    return null;
  }
  const manageable = await manageableOrgDeptIds(req, dashboardId);
  if (!manageable.length) {
    res.status(403).json({ error: "You don't manage a department on this calendar." });
    return null;
  }
  return { companyId, manageable };
}

// POST /api/schedule/session-import/preview — parse + validate the
// sheet and report per-row questions. Saves NOTHING.
router.post('/session-import/preview', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const dashboardId = b.dashboardId ? String(b.dashboardId) : '';
    if (!dashboardId) { res.status(400).json({ error: 'No calendar was given.' }); return; }
    const gate = await sessImpGate(req, res, dashboardId);
    if (!gate) return;
    const filename = String(b.filename || 'upload.csv');
    const dataBase64 = String(b.dataBase64 || '');
    if (!dataBase64) { res.status(400).json({ error: 'No file was uploaded.' }); return; }
    const buf = Buffer.from(dataBase64, 'base64');
    if (!buf.length) { res.status(400).json({ error: 'That file is empty.' }); return; }
    if (buf.length > SESSION_IMPORT_MAX_BYTES) { res.status(413).json({ error: 'That file is over 8 MB — please upload a smaller sheet.' }); return; }
    const parsed = sessImpGrid(filename, buf);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const grid = parsed.grid;
    // Find the header row within the first 5 rows.
    let headerIdx = -1;
    let colMap: Partial<Record<SessImpCol, number>> = {};
    for (let i = 0; i < Math.min(grid.length, 5); i++) {
      const map: Partial<Record<SessImpCol, number>> = {};
      (grid[i] || []).forEach((cell: any, j: number) => {
        const k = sessImpColKind(String(cell ?? ''));
        if (k && map[k] === undefined) map[k] = j;
      });
      if (map.date !== undefined && map.title !== undefined) { headerIdx = i; colMap = map; break; }
    }
    if (headerIdx < 0) {
      res.status(400).json({ error: `That sheet's columns don't match the template. Expected columns: ${SESSION_IMPORT_HEADERS.join(', ')}.` });
      return;
    }
    const dataRows = grid.slice(headerIdx + 1).filter((r: any[]) => (r || []).some((c: any) => String(c ?? '').trim() !== ''));
    if (!dataRows.length) { res.status(400).json({ error: 'That sheet has no events in it yet.' }); return; }
    if (dataRows.length > SESSION_IMPORT_MAX_ROWS) {
      res.status(400).json({ error: `That sheet has ${dataRows.length} events — the limit is ${SESSION_IMPORT_MAX_ROWS} per upload. Please split it into smaller sheets.` });
      return;
    }
    const refs = await sessImpRefs(gate.companyId, dashboardId);
    const deptByName = new Map<string, { id: string; name: string }>();
    for (const d of refs.departments) {
      const key = d.name.toLowerCase();
      if (!deptByName.has(key)) deptByName.set(key, d);
    }
    // Duplicate keys over the sheet's own date range.
    const parsedDates: string[] = [];
    for (const r of dataRows) {
      const d = importCellDate((r || [])[colMap.date!]);
      if (d) parsedDates.push(d);
    }
    const dupKeys = parsedDates.length
      ? await sessImpDuplicateKeys(gate.companyId, dashboardId, parsedDates.reduce((a, c) => (c < a ? c : a)), parsedDates.reduce((a, c) => (c > a ? c : a)))
      : new Set<string>();
    const seenKeys = new Set<string>();
    const cellAt = (r: any[], col: SessImpCol): any => (colMap[col] === undefined ? '' : (r || [])[colMap[col]!]);
    const out: any[] = [];
    dataRows.forEach((r: any[], idx: number) => {
      const questions: SessImpQuestion[] = [];
      let qn = 0;
      const ask = (q: Omit<SessImpQuestion, 'id'>) => { questions.push({ id: 'q' + (++qn), ...q }); };
      const dateRaw = sessImpCellText(cellAt(r, 'date'));
      const date = importCellDate(cellAt(r, 'date')) || null;
      if (!date) ask({ kind: 'date', prompt: dateRaw ? `The date "${dateRaw}" isn't readable.` : 'This event has no date.', value: '' });
      const startRaw = sessImpTimeCellText(cellAt(r, 'start'));
      const endRaw = sessImpTimeCellText(cellAt(r, 'end'));
      const startTime = sessImpTime(startRaw);
      const endTime = sessImpTime(endRaw);
      if (!startTime) ask({ kind: 'start', prompt: startRaw ? `The start time "${startRaw}" isn't readable.` : 'This event has no start time.', value: '' });
      if (!endTime) ask({ kind: 'end', prompt: endRaw ? `The end time "${endRaw}" isn't readable.` : 'This event has no end time.', value: '' });
      else if (startTime && endTime && endTime <= startTime) ask({ kind: 'end', prompt: 'This event ends before it starts — what is the end time?', value: endTime });
      const title = sessImpCellText(cellAt(r, 'title'));
      if (!title) ask({ kind: 'title', prompt: 'This event has no name.', value: '' });
      // Session type — the calendar's kinds.
      const kindText = sessImpCellText(cellAt(r, 'kind'));
      let kind: string | null = null;
      let kindLabel: string | null = null;
      if (!kindText) {
        if (refs.kinds.length === 1) { kind = refs.kinds[0].key; kindLabel = refs.kinds[0].label; }
        else ask({ kind: 'kind', prompt: 'Which session type is this event?', value: '' });
      } else {
        const hit = refs.kinds.find((k) => k.label.toLowerCase() === kindText.toLowerCase() || k.key.toLowerCase() === kindText.toLowerCase());
        if (hit) { kind = hit.key; kindLabel = hit.label; }
        else ask({ kind: 'kind', prompt: `"${kindText}" isn't one of this calendar's session types.`, value: kindText });
      }
      // Speaker — blank is fine; otherwise a team member or a guest.
      const speakerText = sessImpCellText(cellAt(r, 'speaker'));
      let speaker: any = null;
      if (speakerText) {
        const hit = sessImpMatchPerson(speakerText, refs);
        if ('one' in hit) speaker = { userId: hit.one.id, name: hit.one.name };
        else if ('many' in hit) {
          ask({ kind: 'speaker', prompt: `More than one team member matches "${speakerText}". Who did you mean?`, value: speakerText, candidates: hit.many });
        } else {
          const parts = sessImpSpeakerParts(speakerText);
          ask({ kind: 'speaker', prompt: `"${parts.name || speakerText}" isn't on your team. Who did you mean?`, value: speakerText, guest: { name: parts.name, email: parts.email } });
        }
      }
      // Attendees — department names and people, token by token.
      const attText = sessImpCellText(cellAt(r, 'attendees'));
      const beneficiaryDepartmentIds: string[] = [];
      const beneficiaryUserIds: string[] = [];
      const attendeeNames: string[] = [];
      if (attText) {
        for (const token of attText.split(/[;,]/).map((t) => t.trim()).filter(Boolean)) {
          const dept = deptByName.get(token.toLowerCase());
          if (dept) {
            if (!beneficiaryDepartmentIds.includes(dept.id)) beneficiaryDepartmentIds.push(dept.id);
            if (!attendeeNames.includes(dept.name)) attendeeNames.push(dept.name);
            continue;
          }
          const hit = sessImpMatchPerson(token, refs);
          if ('one' in hit) {
            if (!beneficiaryUserIds.includes(hit.one.id)) beneficiaryUserIds.push(hit.one.id);
            if (!attendeeNames.includes(hit.one.name)) attendeeNames.push(hit.one.name);
          } else if ('many' in hit) {
            ask({ kind: 'attendee', token, prompt: `More than one team member matches "${token}". Who did you mean?`, candidates: hit.many });
          } else {
            ask({ kind: 'attendee', token, prompt: `"${token}" isn't a department or a team member. Who did you mean?` });
          }
        }
      }
      // Room is free text (the form's location); Notes free text.
      const location = sessImpCellText(cellAt(r, 'room')) || null;
      const notes = sessImpCellText(cellAt(r, 'notes')) || null;
      const meetingText = sessImpCellText(cellAt(r, 'meeting'));
      let meetingUrl: string | null = null;
      if (meetingText) {
        if (/^https?:\/\//i.test(meetingText)) meetingUrl = meetingText;
        else ask({ kind: 'meeting', prompt: `The meeting link "${meetingText}" doesn't look like a link.`, value: meetingText });
      }
      // Duplicate — same calendar + date + start + title.
      let isDup = false;
      if (date && startTime && title) {
        const key = `${date}|${startTime}|${title.toLowerCase()}`;
        if (dupKeys.has(key) || seenKeys.has(key)) {
          isDup = true;
          ask({ kind: 'duplicate', prompt: 'An event with this name is already on this calendar at this time.' });
        }
        seenKeys.add(key);
      }
      const blocking = questions.some((q) => q.kind !== 'duplicate');
      out.push({
        row: idx + 1,
        date, startTime, endTime,
        dateText: dateRaw, startText: startRaw, endText: endRaw,
        title, kind, kindLabel, speakerText, speaker,
        beneficiaryDepartmentIds, beneficiaryUserIds, attendeeNames,
        location, meetingUrl, notes,
        status: blocking ? 'needs_info' : (isDup ? 'duplicate' : 'ready'),
        questions,
      });
    });
    res.json({
      ok: true,
      dashboardId,
      total: out.length,
      kinds: refs.kinds.map((k) => ({ key: k.key, label: k.label })),
      people: refs.members.map((m) => ({ id: m.id, name: m.name, email: m.email })),
      orgDepartments: gate.manageable.map((id) => refs.departments.find((d) => d.id === id)).filter(Boolean),
      orgDepartmentId: gate.manageable.length === 1 ? gate.manageable[0] : null,
      rows: out,
    });
  } catch (err) {
    console.error('[schedule] session import preview failed:', err);
    res.status(500).json({ error: 'Something went wrong reading that sheet. Please try again.' });
  }
});

// POST /api/schedule/session-import — create the resolved rows, one
// by one, through createSessionFromBody. A row that fails (it went
// stale since the preview, or its speaker was deactivated) lands in
// `failed` with a reason; the rest still import.
router.post('/session-import', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const dashboardId = b.dashboardId ? String(b.dashboardId) : '';
    if (!dashboardId) { res.status(400).json({ error: 'No calendar was given.' }); return; }
    const gate = await sessImpGate(req, res, dashboardId);
    if (!gate) return;
    let orgDeptId: string;
    if (b.departmentId) {
      orgDeptId = String(b.departmentId);
      if (!gate.manageable.includes(orgDeptId)) {
        res.status(403).json({ error: 'You can only organize events for a department you manage on this calendar.' });
        return;
      }
    } else if (gate.manageable.length === 1) {
      orgDeptId = gate.manageable[0];
    } else {
      res.status(400).json({ error: 'Choose the organizing department for these events.' });
      return;
    }
    const rowsIn = Array.isArray(b.rows) ? b.rows : [];
    if (!rowsIn.length) { res.status(400).json({ error: 'There are no events to import.' }); return; }
    if (rowsIn.length > SESSION_IMPORT_MAX_ROWS) {
      res.status(400).json({ error: `Too many events in one import — the limit is ${SESSION_IMPORT_MAX_ROWS}.` });
      return;
    }
    // Fresh duplicate keys across the batch's date range; keys of
    // rows created during this import join the set as they land.
    const validDates: string[] = rowsIn.map((r: any) => String(r?.date || '')).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const dupKeys = validDates.length
      ? await sessImpDuplicateKeys(gate.companyId, dashboardId, validDates.reduce((a, c) => (c < a ? c : a)), validDates.reduce((a, c) => (c > a ? c : a)))
      : new Set<string>();
    const timeOk = (t: any) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    const dateOk = (d: any) => {
      if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      const dt = new Date(d + 'T00:00:00Z');
      return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
    };
    const failed: Array<{ row: number; reason: string }> = [];
    let imported = 0;
    for (const r of rowsIn) {
      const rowNo = Number(r?.row) || 0;
      const fail = (reason: string) => { failed.push({ row: rowNo, reason }); };
      const title = String(r?.title || '').trim();
      if (!title) { fail('The event has no name.'); continue; }
      if (!dateOk(r?.date)) { fail('The date is missing or unreadable.'); continue; }
      if (!timeOk(r?.startTime) || !timeOk(r?.endTime)) { fail('The start or end time is missing or unreadable.'); continue; }
      if (String(r.endTime) <= String(r.startTime)) { fail('The event ends before it starts.'); continue; }
      const key = `${r.date}|${r.startTime}|${title.toLowerCase()}`;
      if (!r.importAnyway && dupKeys.has(key)) { fail('An event with this name is already on this calendar at that time.'); continue; }
      try {
        const cr = await createSessionFromBody(req, {
          title,
          dashboardId,
          departmentId: orgDeptId,
          date: r.date,
          startTime: r.startTime,
          endTime: r.endTime,
          kind: r.kind ? String(r.kind) : undefined,
          speakers: r.speaker ? [r.speaker] : [],
          beneficiaryDepartmentIds: Array.isArray(r.beneficiaryDepartmentIds) ? r.beneficiaryDepartmentIds : [],
          beneficiaryUserIds: Array.isArray(r.beneficiaryUserIds) ? r.beneficiaryUserIds : [],
          location: r.location ? String(r.location) : undefined,
          meetingUrl: r.meetingUrl ? String(r.meetingUrl) : undefined,
          notes: r.notes ? String(r.notes) : undefined,
        });
        if (!cr.ok) { fail(cr.error); continue; }
        await cr.afterResponse();
        dupKeys.add(key);
        imported++;
      } catch (err) {
        console.error('[schedule] session import row failed:', err);
        fail('Something went wrong creating this event.');
      }
    }
    res.json({ ok: true, imported, failed });
  } catch (err) {
    console.error('[schedule] session import failed:', err);
    res.status(500).json({ error: 'Something went wrong importing those events. Please try again.' });
  }
});

// POST /api/schedule/academic-sessions/bulk-assign — owner or
// scheduler. Assign a speaker or location to many
// sessions at once (Deepika, 2026-10-21). Items are the occurrences
// as shown on the calendar ({id, date}): a recurring session touched
// with a date writes that date's override only; a one-off session
// (or an item without a date) updates the session itself.
router.post('/academic-sessions/bulk-assign', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const b = req.body ?? {};
    // Supervisors were retired (Deepika, 2026-11-07): the field list
    // no longer accepts 'supervisor' — a stale client gets a clear
    // error instead of silently assigning one.
    const field = ['lecturer', 'location'].includes(String(b.field)) ? String(b.field) : null;
    if (!field) { res.status(400).json({ error: 'Say what to assign: speaker or location.' }); return; }
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
      if (await isDashboardArchived(cur.dashboard_id)) { skipped.push({ id: it.id, error: 'Archived dashboard.' }); continue; }
      if (!(await canEditSessionQuiet(req, cur.dashboard_id, cur.department_id))) { skipped.push({ id: it.id, error: 'Not editable.' }); continue; }
      const recurring = cur.recur_rule && cur.recur_rule !== 'none';
      // Who holds this slot now (for notifications below)?
      let prevHolder: string | null = null;
      if (field !== 'location') {
        if (recurring && date) {
          const ov = await getOverride(seriesId, date);
          prevHolder = effectivePeople(cur, ov).lecturer;
        } else {
          prevHolder = cur.lecturer_user_id;
        }
      }
      if (recurring && date) {
        if (field === 'lecturer') await upsertOverride(companyId, seriesId, date, { has_lecturer: true, lecturer_user_id: userId });
        else await upsertOverride(companyId, seriesId, date, { has_location: true, location: locVal });
      } else {
        const col = field === 'lecturer' ? 'lecturer_user_id' : 'location';
        const val = field === 'location' ? locVal : userId;
        await query(`UPDATE academic_sessions SET ${col} = $1 WHERE id = $2 AND company_id = $3`, [val, seriesId, companyId]);
        if (field === 'lecturer') {
          // Keep the speakers list in step: the assigned person
          // becomes Speaker 1; clearing drops a team Speaker 1.
          // Guest rows keep their spots either way.
          const spMap = await loadSpeakers(query as any, [seriesId]);
          const sp = (spMap.get(seriesId) || []).map((s: any) => s.userId ? { userId: s.userId } : { guestName: s.name, guestEmail: s.guestEmail });
          const rest = sp.length && sp[0].userId ? sp.slice(1) : sp;
          const next = userId ? [{ userId }, ...rest.filter((s: any) => s.userId !== userId)] : rest;
          await saveSpeakers(query as any, seriesId, next as any);
        }
      }
      updated++;
      if (field !== 'location') {
        if (userId && prevHolder !== userId) assignedChanges++;
        if (prevHolder && prevHolder !== userId) removedCounts.set(prevHolder, (removedCounts.get(prevHolder) || 0) + 1);
      }
      // Calendar report: one entry per event that actually changed.
      {
        const itemDate = recurring && date ? date : calDstr(cur.session_date);
        const dateSuffix = recurring && date ? ' (just this date)' : '';
        if (field === 'lecturer' && prevHolder !== userId) {
          const nm = await calNames(companyId, [prevHolder, userId]);
          await calAudit(req, {
            date: itemDate || todayStr(), action: 'updated', verb: !userId && prevHolder ? 'dropped' : undefined,
            description: userId && prevHolder
              ? `Speaker on "${cur.title}" (${calFmtDate(itemDate)}) changed ${nm.get(prevHolder) || '—'} → ${nm.get(userId) || '—'}${dateSuffix}`
              : userId
                ? `Speaker added: ${nm.get(userId) || '—'} on "${cur.title}" (${calFmtDate(itemDate)})${dateSuffix}`
                : `Speaker removed: ${nm.get(prevHolder as string) || '—'} from "${cur.title}" (${calFmtDate(itemDate)})${dateSuffix}`,
            details: { sessionId: seriesId, bulk: true },
          });
        } else if (field === 'location') {
          let prevLoc: any = cur.location;
          if (recurring && date) {
            const ovL = await getOverride(seriesId, date);
            if (ovL && ovL.has_location) prevLoc = ovL.location;
          }
          if ((locVal || null) !== (prevLoc || null)) {
            await calAudit(req, {
              date: itemDate || todayStr(), action: 'updated',
              description: locVal
                ? `Location on "${cur.title}" (${calFmtDate(itemDate)}) set to "${locVal}"${dateSuffix}`
                : `Location cleared on "${cur.title}" (${calFmtDate(itemDate)})${dateSuffix}`,
              details: { sessionId: seriesId, bulk: true },
            });
          }
        }
      }
    }
    res.json({ ok: true, updated, skipped });
    // Notify the newly assigned person and anyone who lost sessions.
    if (field !== 'location') {
      const roleWord = 'presenter';
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

// POST /api/schedule/academic-sessions/:id/rsvp — an invited
// attendee (beneficiary) replies Yes / No / Maybe for ONE date of
// the event (Deepika, 2026-11-07). Speakers host and don't RSVP.
// No notifications — the organizer just gets the count.
router.post('/academic-sessions/:id/rsvp', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const b = req.body ?? {};
    const status = String(b.status || '');
    if (!['yes', 'no', 'maybe'].includes(status)) { res.status(400).json({ error: 'Reply must be Yes, No or Maybe.' }); return; }
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const s = rows[0];
    if (await sessionWriteBlocked(res, s.dashboard_id)) return;
    const date = b.date && /^\d{4}-\d{2}-\d{2}$/.test(String(b.date)) ? String(b.date) : (s.session_date instanceof Date ? s.session_date.toISOString().slice(0, 10) : String(s.session_date));
    const me = req.session.userId!;
    // Speakers (incl. the lecturer mirror) host — no RSVP.
    const spMap = await loadSpeakers(query as any, [seriesId]);
    const isSpeaker = s.lecturer_user_id === me || (spMap.get(seriesId) || []).some((sp: any) => sp.userId === me);
    if (isSpeaker) { res.status(400).json({ error: "You're a speaker on this event — speakers don't RSVP." }); return; }
    const invited = (await loadInvitedUserIds(query as any, companyId, [seriesId])).get(seriesId) || [];
    if (!invited.includes(me)) { res.status(403).json({ error: 'RSVP is for invited attendees.' }); return; }
    await query(
      `INSERT INTO session_rsvps (session_id, session_date, user_id, status, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (session_id, session_date, user_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [seriesId, date, me, status]);
    res.json({ ok: true, status });
  } catch (err) {
    console.error('[schedule] session rsvp failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/schedule/academic-sessions/:id/claim — speaker pickup
// (Deepika, 2026-10-20): any signed-in user who can see a session with no
// speaker ("Needs speaker") picks it up. (A body role of 'supervisor'
// is refused — that slot was retired on 2026-11-07.) Claiming an
// occurrence claims the whole series. Atomic: the UPDATE lands only
// while the slot is open.
router.post('/academic-sessions/:id/claim', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    if (await sessionWriteBlocked(res, cur.dashboard_id)) return;
    const ids = await academicVisibleDeptIds(req);
    if (ids) {
      // Own department first; inherit-model sessions (no department of
      // their own) are visible through their calendar instead.
      let vis = !!(cur.department_id && ids.includes(cur.department_id));
      if (!vis && cur.dashboard_id) {
        const vDash = await visibleDashboardIds(req);
        vis = !!(vDash && vDash.includes(cur.dashboard_id));
      }
      if (!vis) {
        // Beneficiaries (attendees) can see — and so can pick up — the event.
        const benMap = await loadBeneficiaries(query as any, [seriesId]);
        const ben = benMap.get(seriesId);
        if (ben) {
          if (ben.userIds.includes(req.session.userId!)) vis = true;
          else if (ben.departmentIds.length) {
            const { rows: meRows } = await query('SELECT department_id FROM users WHERE id = $1', [req.session.userId!]);
            vis = !!(meRows[0]?.department_id && ben.departmentIds.includes(meRows[0].department_id));
          }
        }
      }
      if (!vis) {
        res.status(403).json({ error: 'You do not have access to this session.' }); return;
      }
    }
    // Supervisors were retired (Deepika, 2026-11-07): the only
    // claimable spot is the speaker spot.
    if (String(req.body?.role || '') === 'supervisor') {
      res.status(400).json({ error: 'Sessions no longer have a supervisor spot — speakers only.' });
      return;
    }
    const col = 'lecturer_user_id';
    // EVENT model claim rule: with NO speakers at all, claiming the
    // presenter spot makes the claimer Speaker 1 (the lecturer UPDATE
    // below + a Speaker 1 row). When speakers already exist (e.g. a
    // guest leads), the claimer joins as an ADDITIONAL speaker and
    // Speaker 1 / the lecturer mirror stay untouched.
    if (!(req.body?.date && cur.recur_rule && cur.recur_rule !== 'none')) {
      const spMap = await loadSpeakers(query as any, [seriesId]);
      const sp = spMap.get(seriesId) || [];
      if (sp.length) {
        if (sp.some((s: any) => s.userId === req.session.userId)) { res.json({ ok: true, already: true }); return; }
        await saveSpeakers(query as any, seriesId, [...sp.map(speakerRowToInput), { userId: req.session.userId! }]);
        // Calendar report: joined as an additional speaker.
        await calAudit(req, {
          date: calDstr(cur.session_date) || todayStr(), action: 'updated', verb: 'picked_up',
          description: `Picked up speaking at "${cur.title}" (${calFmtDate(cur.session_date)})${cur.recur_rule && cur.recur_rule !== 'none' ? ' (whole series)' : ''}`,
          details: { sessionId: seriesId },
        });
        res.json({ ok: true });
        return;
      }
    }
    // Per-date pickup: a recurring session claimed WITH a date
    // claims only that date (override row), never the whole series.
    const occDate = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date)) ? String(req.body.date) : null;
    if (occDate && cur.recur_rule && cur.recur_rule !== 'none') {
      const ov = await getOverride(seriesId, occDate);
      if (ov && ov.cancelled) { res.status(409).json({ error: 'This date is cancelled.' }); return; }
      const eff = effectivePeople(cur, ov);
      const holder = eff.lecturer;
      if (holder) {
        if (holder === req.session.userId) { res.json({ ok: true, already: true }); return; }
        res.status(409).json({ error: 'Someone already picked this up.' }); return;
      }
      const flag = 'has_lecturer';
      await query('INSERT INTO academic_session_overrides (company_id, session_id, date) VALUES ($1, $2, $3) ON CONFLICT (session_id, date) DO NOTHING', [companyId, seriesId, occDate]);
      const upd2 = await query(
        `UPDATE academic_session_overrides SET ${col} = $1, ${flag} = true, updated_at = now()
         WHERE session_id = $2 AND date = $3 AND ${col} IS NULL`,
        [req.session.userId!, seriesId, occDate]);
      if (!upd2.rowCount) {
        const ov2 = await getOverride(seriesId, occDate);
        const nowHolder = ov2 ? ov2.lecturer_user_id : null;
        if (nowHolder === req.session.userId) { res.json({ ok: true, already: true }); return; }
        res.status(409).json({ error: 'Someone already picked this up.' }); return;
      }
      // Calendar report: picked up one date of the series.
      await calAudit(req, {
        date: occDate, action: 'updated', verb: 'picked_up',
        description: `Picked up speaking at "${cur.title}" (${calFmtDate(occDate)}) (just this date)`,
        details: { sessionId: seriesId },
      });
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
    await saveSpeakers(query as any, seriesId, [{ userId: req.session.userId! }]);
    // Calendar report: claimed the (empty) speaker spot.
    await calAudit(req, {
      date: calDstr(cur.session_date) || todayStr(), action: 'updated', verb: 'picked_up',
      description: `Picked up speaking at "${cur.title}" (${calFmtDate(cur.session_date)})${cur.recur_rule && cur.recur_rule !== 'none' ? ' (whole series)' : ''}`,
      details: { sessionId: seriesId },
    });
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
    if (await sessionWriteBlocked(res, cur.dashboard_id)) return;
    const effPerson = (await sessionPersonLabel(query, companyId, cur)).toLowerCase();
    const occDateU = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date)) ? String(req.body.date) : null;
    if (occDateU && cur.recur_rule && cur.recur_rule !== 'none') {
      const ov = await getOverride(seriesId, occDateU);
      const eff = effectivePeople(cur, ov);
      if (!eff.lecturer) { res.json({ ok: true }); return; }
      if (eff.lecturer !== req.session.userId) {
        if (req.session.role === 'employee') { res.status(403).json({ error: `Only the ${effPerson} can give this up.` }); return; }
        if (!(await sessionEditCheck(req, res, cur.dashboard_id, cur.department_id))) return;
      }
      await upsertOverride(companyId, seriesId, occDateU, { has_lecturer: true, lecturer_user_id: null });
      // Calendar report: this date's speaker spot was given up.
      {
        const holder = eff.lecturer as string;
        const selfDrop = holder === req.session.userId;
        const nm = selfDrop ? null : await calNames(companyId, [holder]);
        await calAudit(req, {
          date: occDateU, action: 'updated', verb: 'dropped',
          description: selfDrop
            ? `Dropped speaking at "${cur.title}" (${calFmtDate(occDateU)}) (just this date)`
            : `Removed ${nm!.get(holder) || 'the speaker'} as speaker of "${cur.title}" (${calFmtDate(occDateU)}) (just this date)`,
          details: { sessionId: seriesId },
        });
      }
      res.json({ ok: true });
      return;
    }
    // A team speaker who is NOT the primary (Speaker 1) giving up
    // simply leaves the speakers list.
    if (cur.lecturer_user_id !== req.session.userId) {
      const spMap0 = await loadSpeakers(query as any, [seriesId]);
      const sp0 = spMap0.get(seriesId) || [];
      if (sp0.some((s: any) => s.userId === req.session.userId) && !(sp0.length && sp0[0].userId === req.session.userId)) {
        await saveSpeakers(query as any, seriesId, sp0.filter((s: any) => s.userId !== req.session.userId).map(speakerRowToInput));
        // Calendar report: a non-primary speaker left the list.
        await calAudit(req, {
          date: calDstr(cur.session_date) || todayStr(), action: 'updated', verb: 'dropped',
          description: `Dropped speaking at "${cur.title}" (${calFmtDate(cur.session_date)})`,
          details: { sessionId: seriesId },
        });
        res.json({ ok: true });
        return;
      }
    }
    if (!cur.lecturer_user_id) { res.json({ ok: true }); return; }
    if (cur.lecturer_user_id !== req.session.userId) {
      if (req.session.role === 'employee') { res.status(403).json({ error: `Only the ${effPerson} can give this up.` }); return; }
      if (!(await sessionEditCheck(req, res, cur.dashboard_id, cur.department_id))) return;
    }
    await query('UPDATE academic_sessions SET lecturer_user_id = NULL WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    // Keep the speakers list in step: drop the Speaker 1 row when it
    // was this presenter.
    {
      const spMap = await loadSpeakers(query as any, [seriesId]);
      const sp = spMap.get(seriesId) || [];
      if (sp.length && sp[0].userId === cur.lecturer_user_id) {
        await saveSpeakers(query as any, seriesId, sp.slice(1).map(speakerRowToInput));
      }
    }
    // Calendar report: the speaker spot was given up / cleared.
    {
      const holder = cur.lecturer_user_id as string;
      const selfDrop = holder === req.session.userId;
      const nm = selfDrop ? null : await calNames(companyId, [holder]);
      await calAudit(req, {
        date: calDstr(cur.session_date) || todayStr(), action: 'updated', verb: 'dropped',
        description: selfDrop
          ? `Dropped speaking at "${cur.title}" (${calFmtDate(cur.session_date)})${cur.recur_rule && cur.recur_rule !== 'none' ? ' (whole series)' : ''}`
          : `Removed ${nm!.get(holder) || 'the speaker'} as speaker of "${cur.title}" (${calFmtDate(cur.session_date)})`,
        details: { sessionId: seriesId },
      });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[schedule] academic session unclaim failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/schedule/academic-sessions/:id/overrides/:date —
// reset one date back to the series defaults (edit-scoped; an
// employee organizer may reset dates on their own events).
router.delete('/academic-sessions/:id/overrides/:date', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const date = String(req.params.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: 'A valid date is required.' }); return; }
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    if (await sessionWriteBlocked(res, cur.dashboard_id)) return;
    if (req.session.role === 'employee') {
      if (cur.created_by !== req.session.userId) { res.status(403).json({ error: 'You can only edit events you organized.' }); return; }
    } else if (!(await sessionEditCheck(req, res, cur.dashboard_id, cur.department_id))) return;
    const ovBefore = await getOverride(seriesId, date);
    await query('DELETE FROM academic_session_overrides WHERE session_id = $1 AND date = $2', [seriesId, date]);
    // Calendar report: only when the reset actually changed what
    // the date showed (the override differed from the series).
    if (ovBefore) {
      const effB = effectivePeople(cur, ovBefore);
      const differs = !!ovBefore.cancelled
        || effB.lecturer !== cur.lecturer_user_id
        || (ovBefore.has_location && (ovBefore.location || null) !== (cur.location || null))
        || (ovBefore.has_meeting_url && (ovBefore.meeting_url || null) !== (cur.meeting_url || null))
        || (ovBefore.has_times && (calFmtTime(ovBefore.start_time) !== calFmtTime(cur.start_time) || calFmtTime(ovBefore.end_time) !== calFmtTime(cur.end_time)));
      if (differs) {
        await calAudit(req, {
          date, action: 'updated', verb: 'reset_date',
          description: `Reset "${cur.title}" on ${calFmtDate(date)} back to the series settings`,
          details: { sessionId: seriesId },
        });
      }
    }
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

// PUT /api/schedule/academic-sessions/:id — edit-scoped: owner /
// scheduler by department + dashboard rights; an EMPLOYEE may edit
// only events they organized (created_by), per Deepika 2026-11-07.
router.put('/academic-sessions/:id', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT * FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    const cur = rows[0];
    if (await sessionWriteBlocked(res, cur.dashboard_id)) return;
    const b = req.body ?? {};
    const isEmployeeOrganizer = req.session.role === 'employee' && cur.created_by === req.session.userId;
    if (req.session.role === 'employee' && !isEmployeeOrganizer) {
      res.status(403).json({ error: 'You can only edit events you organized.' });
      return;
    }
    // EVENT model (2026-11-07): department_id is the event's
    // ORGANIZING department. An edit keeps it unless the body names
    // another department the editor manages on this calendar. An
    // employee organizer's department stays as saved.
    let departmentId = cur.department_id;
    const targetDashboardId = b.dashboardId !== undefined ? (b.dashboardId ? String(b.dashboardId) : null) : cur.dashboard_id;
    if (targetDashboardId !== cur.dashboard_id && await sessionWriteBlocked(res, targetDashboardId)) return;
    if (!isEmployeeOrganizer && !(await sessionEditCheck(req, res, targetDashboardId, departmentId))) return;
    if (!isEmployeeOrganizer && b.departmentId !== undefined && (b.departmentId ? String(b.departmentId) : null) !== cur.department_id) {
      const dashForOrg = targetDashboardId || cur.dashboard_id;
      if (dashForOrg) {
        const manageable = await manageableOrgDeptIds(req, dashForOrg);
        if (!b.departmentId || !manageable.includes(String(b.departmentId))) {
          res.status(403).json({ error: 'You can only move this event to a department you manage on this calendar.' });
          return;
        }
        departmentId = String(b.departmentId);
      } else if (b.departmentId) {
        if (!(await sessionEditCheck(req, res, null, String(b.departmentId)))) return;
        departmentId = String(b.departmentId);
      } else {
        departmentId = null;
      }
    }
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
        // Calendar report (only when the date wasn't already cancelled).
        if (!(ovBefore && ovBefore.cancelled)) {
          await calAudit(req, {
            date: occDate, action: 'updated', verb: 'cancelled_date',
            description: `Cancelled "${cur.title}" for ${calFmtDate(occDate)} (just this date)`,
            details: { sessionId: seriesId },
          });
        }
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
      if (b.lecturerUserId) {
        const { rows: lu } = await query('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [b.lecturerUserId, companyId]);
        if (!lu.length) { res.status(400).json({ error: 'That person is not an active team member.' }); return; }
      }
      // A supervisorUserId for one date is ignored on purpose:
      // supervisors were retired (Deepika, 2026-11-07) — a per-date
      // override never sets one now.
      const fields: Record<string, any> = { cancelled: false };
      if (b.lecturerUserId !== undefined) { fields.has_lecturer = true; fields.lecturer_user_id = b.lecturerUserId ? String(b.lecturerUserId) : null; }
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
      // Calendar report: diff what this date effectively showed
      // before vs after the override write.
      const dateParts: string[] = [];
      {
        const ovB = await getOverride(seriesId, occDate);
        if (ovB && ovB.cancelled) dateParts.push('date un-cancelled');
        const effB = effectivePeople(cur, ovB);
        if (fields.has_lecturer && String(effB.lecturer || '') !== String(fields.lecturer_user_id || '')) {
          const nm = await calNames(companyId, [effB.lecturer, fields.lecturer_user_id]);
          dateParts.push(fields.lecturer_user_id
            ? (effB.lecturer ? `speaker ${nm.get(effB.lecturer) || '—'} → ${nm.get(fields.lecturer_user_id) || '—'}` : `speaker set: ${nm.get(fields.lecturer_user_id) || '—'}`)
            : `speaker removed (was ${nm.get(effB.lecturer as string) || '—'})`);
        }
        const locBefore = ovB && ovB.has_location ? ovB.location : cur.location;
        if (fields.has_location && (fields.location || null) !== (locBefore || null)) {
          dateParts.push(!locBefore ? `location added: ${fields.location}` : !fields.location ? `location removed (was ${locBefore})` : `location ${locBefore} → ${fields.location}`);
        }
        const muBefore = ovB && ovB.has_meeting_url ? ovB.meeting_url : cur.meeting_url;
        if (fields.has_meeting_url && (fields.meeting_url || null) !== (muBefore || null)) {
          dateParts.push(!muBefore ? 'meeting link added' : !fields.meeting_url ? 'meeting link removed' : 'meeting link changed');
        }
        const tBefore: [any, any] = ovB && ovB.has_times ? [ovB.start_time, ovB.end_time] : [cur.start_time, cur.end_time];
        if (fields.has_times && calFmtRange(tBefore[0], tBefore[1]) !== calFmtRange(fields.start_time, fields.end_time)) {
          dateParts.push(`time ${calFmtRange(tBefore[0], tBefore[1]) || '—'} → ${calFmtRange(fields.start_time, fields.end_time) || '—'}`);
        }
      }
      await upsertOverride(companyId, seriesId, occDate, fields);
      if (dateParts.length) {
        await calAudit(req, {
          date: occDate, action: 'updated',
          description: `Edited "${cur.title}" for ${calFmtDate(occDate)} (just this date) — ${dateParts.join('; ')}`,
          details: { sessionId: seriesId },
        });
      }
      res.json({ ok: true, scope: 'date' });
      {
        const people = [cur.lecturer_user_id, cur.supervisor_user_id, b.lecturerUserId || null].filter(Boolean) as string[];
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
    // Supervisors were retired (Deepika, 2026-11-07): the stored
    // supervisor_user_id is carried through an edit unchanged (data
    // preserved), but the body's supervisorUserId is never honoured —
    // an edit can no longer set or clear one.
    const supervisorUserId = cur.supervisor_user_id;
    // EVENT model: speakers + beneficiaries (series-level). A save
    // that posts `speakers` replaces the list and re-mirrors the
    // lecturer; a legacy save that posts only lecturerUserId treats
    // it as the Speaker 1 value. A save that posts neither keeps the
    // list exactly as it is.
    let speakersIn: { userId?: string | null; guestName?: string | null; guestEmail?: string | null }[] | null = null;
    let prevSpeakers: { userId?: string | null; guestName?: string | null; guestEmail?: string | null }[] = [];
    let newLecturer: string | null = b.lecturerUserId !== undefined ? (b.lecturerUserId || null) : cur.lecturer_user_id;
    {
      const pm = await loadSpeakers(query as any, [seriesId]);
      prevSpeakers = (pm.get(seriesId) || []).map(speakerRowToInput);
    }
    if (b.speakers !== undefined) {
      const cleaned = await cleanSpeakers(query as any, companyId, b.speakers);
      if ('error' in cleaned) { res.status(400).json({ error: cleaned.error }); return; }
      speakersIn = cleaned.speakers;
      newLecturer = speakerMirror(speakersIn);
    } else if (b.lecturerUserId !== undefined) {
      const rest = prevSpeakers.length && prevSpeakers[0].userId ? prevSpeakers.slice(1) : prevSpeakers;
      speakersIn = newLecturer ? [{ userId: newLecturer }, ...rest.filter((s) => s.userId !== newLecturer)] : rest;
    }
    let beneficiaries: { departmentIds: string[]; userIds: string[] } | null = null;
    if (b.beneficiaryDepartmentIds !== undefined || b.beneficiaryUserIds !== undefined) {
      const cb = await cleanBeneficiaries(query as any, companyId, b.beneficiaryDepartmentIds, b.beneficiaryUserIds);
      if ('error' in cb) { res.status(400).json({ error: cb.error }); return; }
      beneficiaries = cb;
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
    // Role name override (migration 089): a save that posts
    // personLabel sets it (null/empty = follow the type); a save
    // that doesn't mention it keeps the session's saved override.
    // (The one-date scope returned earlier and never reaches here,
    // so per-date overrides can't carry it — series-level only.)
    const personLabelVal = b.personLabel !== undefined ? cleanPersonLabel(b.personLabel) : (cur.person_label || null);
    // Room booking (migration 092): the form posts the room fields
    // on every save; a caller that doesn't mention them keeps the
    // session's saved booking. Picking an in-app room re-runs the
    // double-book guard (excluding this session itself).
    const dstrR = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || '').slice(0, 10));
    let roomId = cur.room_id || null;
    let roomSource = cur.room_source || null;
    let roomExternalId = cur.room_external_id || null;
    let locationForSave = b.location !== undefined ? (b.location ? String(b.location).trim() : null) : cur.location;
    if (b.roomId !== undefined || b.roomSource !== undefined || b.roomExternalId !== undefined) {
      const roomSel = await cleanRoomSelection(companyId, b);
      if ('error' in roomSel) { res.status(400).json({ error: roomSel.error }); return; }
      roomId = roomSel.roomId; roomSource = roomSel.roomSource; roomExternalId = roomSel.roomExternalId;
      if (roomSel.roomId) {
        const roomFull = await roomRowById(companyId, roomSel.roomId);
        const conflict = await findRoomConflict(companyId, roomFull, {
          date: b.date || dstrR(cur.session_date),
          startTime: b.startTime !== undefined ? b.startTime : cur.start_time,
          endTime: b.endTime !== undefined ? b.endTime : cur.end_time,
          recurRule, recurInterval: rec.interval, recurDays,
          recurUntil: recurUntil ? dstrR(recurUntil) : null, recurCount: rec.count,
        }, seriesId);
        if (conflict) { res.status(409).json({ error: `'${roomFull.name}' is already booked by '${conflict.title}' at that time.` }); return; }
        locationForSave = roomSel.roomName;
      }
    }
    // Generated meeting link (migration 091): a save that posts the
    // pair sets it (nulls = the link was replaced by a pasted one or
    // a new generated one was staged); a save that doesn't mention
    // it keeps the session's saved pair.
    const oldPair = (cur.meeting_provider && cur.meeting_external_id)
      ? { provider: String(cur.meeting_provider), externalId: String(cur.meeting_external_id) } : null;
    const pair = (b.meetingProvider !== undefined || b.meetingExternalId !== undefined)
      ? cleanMeetingPair(b)
      : (oldPair ? { provider: oldPair.provider, externalId: oldPair.externalId } : { provider: null, externalId: null });
    // Calendar report: snapshot the current attendees for the diff.
    let prevBeneficiaries: { departmentIds: string[]; userIds: string[] } = { departmentIds: [], userIds: [] };
    {
      const bmPrev = await loadBeneficiaries(query as any, [seriesId]);
      prevBeneficiaries = bmPrev.get(seriesId) || prevBeneficiaries;
    }
    await query(
      `UPDATE academic_sessions SET title=$1, lecturer_user_id=$2, department_id=$3, session_date=$4,
        start_time=$5, end_time=$6, location=$7, kind=$8, notes=$9, dashboard_id=$10, recur_rule=$11, recur_until=$12, supervisor_user_id=$13, recur_days=$14, recur_interval=$15, recur_count=$16, meeting_url=$17, person_label=$18, meeting_provider=$19, meeting_external_id=$20, room_id=$21, room_source=$22, room_external_id=$23 WHERE id=$24`,
      [title, newLecturer,
       departmentId, b.date || cur.session_date,
       b.startTime !== undefined ? (b.startTime || null) : cur.start_time,
       b.endTime !== undefined ? (b.endTime || null) : cur.end_time,
       locationForSave,
       kind, b.notes !== undefined ? (b.notes ? String(b.notes).trim() : null) : cur.notes,
       dashboardId, recurRule, recurUntil, supervisorUserId,
       recurRule === 'weekly' ? (recurDays.length ? recurDays.join(',') : null) : null, rec.interval, rec.count, meetingUrl, personLabelVal,
       pair.provider, pair.externalId, roomId, roomSource, roomExternalId, seriesId]);
    if (speakersIn) await saveSpeakers(query as any, seriesId, speakersIn);
    if (beneficiaries) await saveBeneficiaries(query as any, seriesId, beneficiaries.departmentIds, beneficiaries.userIds);
    // Calendar report: one entry spelling out what changed (a save
    // that changes nothing writes nothing).
    {
      const parts: string[] = [];
      if (title !== cur.title) parts.push(`title "${cur.title}" → "${title}"`);
      const newDateStr = calDstr(b.date || cur.session_date);
      if (newDateStr !== calDstr(cur.session_date)) parts.push(`date ${calFmtDate(cur.session_date)} → ${calFmtDate(newDateStr)}`);
      const oldRange = calFmtRange(cur.start_time, cur.end_time);
      const newRange = calFmtRange(b.startTime !== undefined ? b.startTime : cur.start_time, b.endTime !== undefined ? b.endTime : cur.end_time);
      if (oldRange !== newRange) parts.push(`time ${oldRange || '—'} → ${newRange || '—'}`);
      if (String(kind) !== String(cur.kind || '')) {
        const { rows: kRows } = await query('SELECT key, label FROM session_kinds WHERE company_id = $1 AND dashboard_id = $2', [companyId, dashboardId || cur.dashboard_id]);
        const kMap = new Map((kRows as any[]).map((k) => [k.key, k.label]));
        parts.push(`type ${kMap.get(cur.kind) || cur.kind} → ${kMap.get(kind) || kind}`);
      }
      if (String(departmentId || '') !== String(cur.department_id || '')) {
        const dn = await calDeptNames(companyId, [cur.department_id, departmentId]);
        parts.push(`organizing department ${cur.department_id ? (dn.get(cur.department_id) || '—') : 'none'} → ${departmentId ? (dn.get(departmentId) || '—') : 'none'}`);
      }
      if (speakersIn) {
        const keyOf = (s: any) => s.userId ? 'u:' + s.userId : 'g:' + String(s.guestEmail || s.guestName || '').toLowerCase();
        const prevKeys = new Set(prevSpeakers.map(keyOf));
        const nextKeys = new Set(speakersIn.map(keyOf));
        const added = speakersIn.filter((s) => !prevKeys.has(keyOf(s)));
        const removed = prevSpeakers.filter((s) => !nextKeys.has(keyOf(s)));
        if (added.length || removed.length) {
          const nm = await calNames(companyId, [...added, ...removed].filter((s) => s.userId).map((s) => String(s.userId)));
          const aL = added.map((s) => calSpeakerLabel(s, nm));
          const rL = removed.map((s) => calSpeakerLabel(s, nm));
          if (rL.length === 1 && aL.length === 1) parts.push(`speaker ${rL[0]} → ${aL[0]}`);
          else {
            if (aL.length) parts.push(`speakers added: ${calListNames(aL)}`);
            if (rL.length) parts.push(`speakers removed: ${calListNames(rL)}`);
          }
        } else if (prevSpeakers.map(keyOf).join('|') !== speakersIn.map(keyOf).join('|')) {
          parts.push('speaker order changed');
        }
      }
      if (beneficiaries) {
        const addU = beneficiaries.userIds.filter((u) => !prevBeneficiaries.userIds.includes(u));
        const remU = prevBeneficiaries.userIds.filter((u) => !beneficiaries.userIds.includes(u));
        const addD = beneficiaries.departmentIds.filter((d) => !prevBeneficiaries.departmentIds.includes(d));
        const remD = prevBeneficiaries.departmentIds.filter((d) => !beneficiaries.departmentIds.includes(d));
        if (addU.length || remU.length || addD.length || remD.length) {
          const nm = await calNames(companyId, [...addU, ...remU]);
          const dn = await calDeptNames(companyId, [...addD, ...remD]);
          if (addU.length) parts.push(`attendees added: ${calListNames(addU.map((u) => nm.get(u) || 'a team member'))}`);
          if (remU.length) parts.push(`attendees removed: ${calListNames(remU.map((u) => nm.get(u) || 'a team member'))}`);
          if (addD.length) parts.push(`attendee departments added: ${calListNames(addD.map((d) => dn.get(d) || 'a department'))}`);
          if (remD.length) parts.push(`attendee departments removed: ${calListNames(remD.map((d) => dn.get(d) || 'a department'))}`);
        }
      }
      const oldLoc = cur.location || null;
      if ((locationForSave || null) !== oldLoc) {
        const w = (roomId || cur.room_id) ? 'room' : 'location';
        if (!oldLoc) parts.push(`${w} added: ${locationForSave}`);
        else if (!locationForSave) parts.push(`${w} removed (was ${oldLoc})`);
        else parts.push(`${w} ${oldLoc} → ${locationForSave}`);
      }
      const oldMu = cur.meeting_url || null;
      if ((meetingUrl || null) !== oldMu) {
        if (!oldMu) parts.push('meeting link added');
        else if (!meetingUrl) parts.push('meeting link removed');
        else parts.push('meeting link changed');
      }
      const newNotes = b.notes !== undefined ? (b.notes ? String(b.notes).trim() : null) : cur.notes;
      if ((newNotes || null) !== (cur.notes || null)) parts.push('notes changed');
      const oldRec = calRecurText({ recurRule: cur.recur_rule, recurInterval: cur.recur_interval, recurDays: cur.recur_days, recurUntil: cur.recur_until, recurCount: cur.recur_count });
      const newRec = calRecurText({ recurRule, recurInterval: rec.interval, recurDays, recurUntil, recurCount: rec.count });
      if (oldRec !== newRec) parts.push(`repeats: ${oldRec} → ${newRec}`);
      if (parts.length) {
        await calAudit(req, {
          date: newDateStr || calDstr(cur.session_date) || todayStr(), action: 'updated',
          description: `Edited event "${cur.title}" — ${parts.join('; ')}${recurRule !== 'none' ? ' (whole series)' : ''}`,
          details: { sessionId: seriesId },
        });
      }
    }
    // External meeting sync (best effort — a provider hiccup never
    // blocks the save; a failed update rides back as a warning).
    let meetingWarning: string | null = null;
    if (oldPair && (!pair.provider || pair.provider !== oldPair.provider || pair.externalId !== oldPair.externalId)) {
      // Link replaced or pair cleared: the old meeting goes away.
      void deleteExternalMeetingQuiet(companyId, oldPair.provider, oldPair.externalId);
    } else if (oldPair && pair.provider) {
      const dstr2 = (v: any) => !v ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
      const tstr = (v: any) => v ? String(v).slice(0, 5) : null;
      const newDate = b.date || cur.session_date;
      const newStart = b.startTime !== undefined ? (b.startTime || null) : cur.start_time;
      const newEnd = b.endTime !== undefined ? (b.endTime || null) : cur.end_time;
      const coreChanged = title !== cur.title
        || dstr2(newDate) !== dstr2(cur.session_date)
        || tstr(newStart) !== tstr(cur.start_time)
        || tstr(newEnd) !== tstr(cur.end_time);
      if (coreChanged) {
        const input = meetingInputFrom(title, newDate, newStart, newEnd, b.timezone);
        if (!('error' in input)) {
          try {
            const token = await getValidAccessToken(companyId, pair.provider as any);
            await updateMeeting(pair.provider as any, token, pair.externalId!, input);
          } catch (err) {
            console.error('[schedule] meeting sync on session update failed:', err);
            meetingWarning = `The session saved, but its ${providerName(pair.provider as any)} meeting could not be updated — it may still show the old time or name.`;
          }
        }
      }
    }
    res.json(meetingWarning ? { ok: true, meetingWarning } : { ok: true });
    // Newly added guest speakers get their ONE details email (guests
    // already on the event are not re-emailed on every edit).
    if (speakersIn) {
      const freshGuests = newlyAddedGuests(prevSpeakers as any, speakersIn as any);
      if (freshGuests.length) {
        const dateStrOf = (v: any) => !v ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
        const ctx = await guestMailCtx(req, {
          dashboardId, departmentId, title,
          date: dateStrOf(b.date || cur.session_date),
          startTime: b.startTime !== undefined ? (b.startTime || null) : cur.start_time,
          endTime: b.endTime !== undefined ? (b.endTime || null) : cur.end_time,
          location: b.location !== undefined ? (b.location ? String(b.location).trim() : null) : cur.location,
          meetingUrl,
          recurText: describeRecur({ recurRule, recurInterval: rec.interval, recurDays, recurUntil, recurCount: rec.count }),
        });
        await emailGuests(freshGuests as any, ctx);
      }
    }
    // Notify old + new speakers/supervisor about meaningful changes.
    {
      const newSupervisor = supervisorUserId;
      const newDate = b.date || cur.session_date;
      const dstr = (v: any) => !v ? '' : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
      const speakerKey = (list: { userId?: string | null; guestName?: string | null; guestEmail?: string | null }[]) =>
        list.map((s) => s.userId || ('guest:' + (s.guestEmail || s.guestName || ''))).join('|');
      const changed =
        String(newLecturer || '') !== String(cur.lecturer_user_id || '') ||
        String(newSupervisor || '') !== String(cur.supervisor_user_id || '') ||
        (speakersIn ? speakerKey(speakersIn) !== speakerKey(prevSpeakers) : false) ||
        title !== cur.title ||
        dstr(newDate) !== dstr(cur.session_date) ||
        (b.startTime !== undefined && (b.startTime || null) !== cur.start_time) ||
        (b.endTime !== undefined && (b.endTime || null) !== cur.end_time) ||
        (b.location !== undefined && (b.location ? String(b.location).trim() : null) !== cur.location);
      const people = [cur.lecturer_user_id, cur.supervisor_user_id, newLecturer, newSupervisor,
        ...prevSpeakers.filter((s) => s.userId).map((s) => String(s.userId)),
        ...(speakersIn || []).filter((s) => s.userId).map((s) => String(s.userId))].filter(Boolean) as string[];
      if (changed && people.length) {
        notify({
          companyId, userIds: [...new Set(people)], category: 'calendar', type: 'session_changed',
          title: `Session changed: "${title}"`,
          body: `The session "${cur.title}" was updated.`,
          link: 'calendars', bundleKey: 'session_changed',
          excludeUserId: req.session.userId!,
        });
      }
      // "Needs a presenter" fires only when the event ends up with
      // NO speakers at all (a guest speaker counts as covered).
      const endsSpeakerless = speakersIn ? speakersIn.length === 0 : !newLecturer;
      const hadSpeaker = !!cur.lecturer_user_id || prevSpeakers.length > 0;
      if (endsSpeakerless && hadSpeaker) {
        let memberIds: string[] = [];
        if (dashboardId) {
          const { rows: dd } = await query('SELECT department_id FROM dashboard_departments WHERE dashboard_id = $1', [dashboardId]);
          for (const d of dd) memberIds.push(...await deptMemberIds(companyId, d.department_id));
        } else if (departmentId) {
          memberIds = await deptMemberIds(companyId, departmentId);
        }
        if (memberIds.length) {
          const effLabel = personLabelVal || await personLabelFor(query, companyId, dashboardId, kind);
          const effLower = effLabel.toLowerCase();
          notify({
            companyId, userIds: memberIds, category: 'calendar', type: 'session_needs_presenter',
            title: `A session needs ${labelArticle(effLabel)} ${effLower}: "${title}"`,
            body: `"${title}" no longer has ${labelArticle(effLabel)} ${effLower}.`,
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

// DELETE /api/schedule/academic-sessions/:id — edit-scoped; an
// employee may delete only events they organized.
router.delete('/academic-sessions/:id', requireRole('owner', 'scheduler', 'employee'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const seriesId = String(req.params.id).split('@@')[0];
    const { rows } = await query('SELECT title, lecturer_user_id, supervisor_user_id, session_date::text AS sdate, start_time, end_time, recur_rule, department_id, dashboard_id, created_by, meeting_provider, meeting_external_id FROM academic_sessions WHERE id = $1 AND company_id = $2', [seriesId, companyId]);
    if (!rows.length) { res.status(404).json({ error: 'Not found.' }); return; }
    if (await sessionWriteBlocked(res, rows[0].dashboard_id)) return;
    if (req.session.role === 'employee') {
      if (rows[0].created_by !== req.session.userId) {
        res.status(403).json({ error: 'You can only delete events you organized.' });
        return;
      }
    } else if (!(await sessionEditCheck(req, res, rows[0].dashboard_id, rows[0].department_id))) return;
    await query('DELETE FROM academic_sessions WHERE id = $1', [seriesId]);
    // Calendar report: the deletion itself.
    {
      const delRange = calFmtRange(rows[0].start_time, rows[0].end_time);
      await calAudit(req, {
        date: rows[0].sdate || todayStr(), action: 'deleted',
        description: `Deleted event "${rows[0].title}" — ${calFmtDate(rows[0].sdate)}${delRange ? ' ' + delRange : ''}${rows[0].recur_rule && rows[0].recur_rule !== 'none' ? ' (whole series)' : ''}`,
        details: { sessionId: seriesId },
      });
    }
    res.json({ ok: true });
    // A generated meeting dies with its session (best effort).
    if (rows[0].meeting_provider && rows[0].meeting_external_id) {
      void deleteExternalMeetingQuiet(companyId, rows[0].meeting_provider, rows[0].meeting_external_id);
    }
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

