// util/departmentAccess.ts — scheduler department scoping for the permission model.
//
// Permission model (decided 2026-10-12, refined same day):
// - Owner: everything, bypasses all department checks (no header needed).
// - Scheduler: department-scoped. Rows in scheduler_department_access grant
//   'view' or 'edit' per department; 'edit' implies 'view'. A scheduler with
//   no rows sees nothing. When doing admin/editing work the scheduler operates
//   in ONE active department context at a time, sent as the
//   `X-Active-Department` request header (department UUID). See
//   requireActiveDepartment below.
// - Employee: not department-scoped on schedule reads; 403 on all write
//   endpoints (enforced by requireRole gates, not here).

import { Request, Response } from 'express';
import { query } from '../db';

export interface DepartmentAccess {
  /** Department ids with edit access. */
  edit: string[];
  /** Department ids visible at all — edit ids are included (edit implies view). */
  view: string[];
}

/** The caller's department access (scheduler rows only; owner bypasses everywhere). */
export async function getDepartmentAccess(
  userId: string,
  companyId: string
): Promise<DepartmentAccess> {
  const { rows } = await query<{ department_id: string; access_level: string }>(
    `SELECT department_id, access_level FROM scheduler_department_access
     WHERE user_id = $1 AND company_id = $2`,
    [userId, companyId]
  );
  const edit = rows.filter((r) => r.access_level === 'edit').map((r) => r.department_id);
  return { edit, view: rows.map((r) => r.department_id) }; // edit implies view
}

/**
 * Department ids attached to shift types: the shift_type_departments join
 * table, plus the legacy department_id column as a fallback.
 */
export async function shiftTypesDepartmentIds(
  shiftTypeIds: string[],
  companyId: string
): Promise<string[]> {
  const ids = [...new Set((shiftTypeIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const { rows } = await query<{ department_id: string }>(
    `SELECT DISTINCT std.department_id
     FROM shift_type_departments std
     JOIN shift_types st ON st.id = std.shift_type_id
     WHERE std.shift_type_id = ANY($1::uuid[]) AND st.company_id = $2`,
    [ids, companyId]
  );
  const out = new Set<string>(rows.map((r) => r.department_id));
  const { rows: legacy } = await query<{ department_id: string }>(
    `SELECT DISTINCT department_id FROM shift_types
     WHERE id = ANY($1::uuid[]) AND company_id = $2 AND department_id IS NOT NULL`,
    [ids, companyId]
  );
  for (const r of legacy) out.add(r.department_id);
  return [...out];
}

/** Home department ids for team members (null department members contribute nothing). */
export async function usersDepartmentIds(
  userIds: string[],
  companyId: string
): Promise<string[]> {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const { rows } = await query<{ department_id: string }>(
    `SELECT DISTINCT department_id FROM users
     WHERE id = ANY($1::uuid[]) AND company_id = $2 AND department_id IS NOT NULL`,
    [ids, companyId]
  );
  return rows.map((r) => r.department_id);
}

/**
 * Relevant departments for a set of (user, shift-type) pairs: the shift
 * types' departments plus the members' home departments.
 */
export async function assignmentRelevantDepartments(
  assignments: Array<{ userId?: string | null; shiftTypeId?: string | null }>,
  companyId: string
): Promise<string[]> {
  const [stDepts, uDepts] = await Promise.all([
    shiftTypesDepartmentIds(assignments.map((a) => a.shiftTypeId ?? ''), companyId),
    usersDepartmentIds(assignments.map((a) => a.userId ?? ''), companyId),
  ]);
  return [...new Set([...stDepts, ...uDepts])];
}

/**
 * Relevant departments for a rotation: the union of its assignments' shift
 * type departments and members' home departments (single query).
 */
export async function rotationRelevantDepartments(rotationId: string): Promise<string[]> {
  const { rows } = await query<{ department_id: string }>(
    `SELECT DISTINCT d.department_id
     FROM rotation_assignments ra
     LEFT JOIN shift_type_departments std ON std.shift_type_id = ra.shift_type_id
     LEFT JOIN shift_types st ON st.id = ra.shift_type_id
     LEFT JOIN users u ON u.id = ra.user_id
     CROSS JOIN LATERAL (VALUES (std.department_id), (st.department_id), (u.department_id)) AS d(department_id)
     WHERE ra.rotation_id = $1 AND d.department_id IS NOT NULL`,
    [rotationId]
  );
  return rows.map((r) => r.department_id);
}

/**
 * Write guard for department-scoped endpoints: the scheduler operates in ONE
 * active department context per request.
 *
 * - Owner: always allowed, no header needed. Returns
 *   `{ departmentId: null }` (null = no scoping).
 * - Scheduler: the active department comes from the `X-Active-Department`
 *   request header (department UUID). It must be one of the scheduler's Edit
 *   departments, else 403. If the header is absent and the scheduler has
 *   exactly one edit department, that department is used. If absent with zero
 *   or 2+ edit departments, 403 with 'Select an active department to make
 *   changes.'
 * - The write is then allowed only if the target belongs to the active
 *   department: `relevantDepartmentIds` (the shift type's departments, or the
 *   team member's home department) includes the active department. Targets
 *   with no department associations are company-global and any active
 *   department may act.
 *
 * Sends the 403 JSON itself. Returns null when the write must not proceed.
 */
export async function requireActiveDepartment(
  req: Request,
  res: Response,
  relevantDepartmentIds: string[] = []
): Promise<{ departmentId: string | null } | null> {
  if (req.session.role === 'owner') return { departmentId: null };
  if (req.session.role !== 'scheduler' || !req.session.userId || !req.session.companyId) {
    res.status(403).json({ error: 'You do not have permission to do that.' });
    return null;
  }
  const access = await getDepartmentAccess(req.session.userId, req.session.companyId);
  const rawHeader = req.headers['x-active-department'];
  const header = String(Array.isArray(rawHeader) ? rawHeader[0] : (rawHeader ?? '')).trim();
  let active: string;
  if (header) {
    if (!access.edit.includes(header)) {
      res.status(403).json({ error: 'You do not have edit access to the active department.' });
      return null;
    }
    active = header;
  } else if (access.edit.length === 1) {
    active = access.edit[0];
  } else {
    res.status(403).json({ error: 'Select an active department to make changes.' });
    return null;
  }
  const relevant = [...new Set((relevantDepartmentIds || []).filter(Boolean))];
  if (relevant.length && !relevant.includes(active)) {
    res.status(403).json({ error: 'That change belongs to a different department.' });
    return null;
  }
  return { departmentId: active };
}
