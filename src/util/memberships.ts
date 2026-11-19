// util/memberships.ts — cross-department memberships (Deepika,
// 2026-11-19: pull a person into another department like adding a new
// team member, on the SAME account — no duplicate user row).
//
// Model: the users row keeps the HOME department + job role
// (department_id / job_role_id). A pull adds a secondary membership in
// user_department_memberships with its own per-department job role.
// A person's departments are home ∪ memberships; the role that applies
// in a department is the membership's role there, else the home role
// when that department is home.

import { query } from '../db';

export interface UserDepartment {
  departmentId: string;
  jobRoleId: string | null;
  isHome: boolean;
}

export interface UserMembership {
  departmentId: string;
  departmentName: string | null;
  jobRoleId: string | null;
  jobRoleName: string | null;
}

/** All departments a member belongs to (home first), with the role in each. */
export async function userDepartments(
  companyId: string,
  userId: string
): Promise<UserDepartment[]> {
  const { rows: urows } = await query(
    'SELECT department_id, job_role_id FROM users WHERE id = $1 AND company_id = $2',
    [userId, companyId]
  );
  const out: UserDepartment[] = [];
  if (urows.length && urows[0].department_id) {
    out.push({
      departmentId: String(urows[0].department_id),
      jobRoleId: urows[0].job_role_id ? String(urows[0].job_role_id) : null,
      isHome: true,
    });
  }
  const { rows: mrows } = await query(
    `SELECT department_id, job_role_id FROM user_department_memberships
     WHERE user_id = $1 AND company_id = $2 ORDER BY created_at`,
    [userId, companyId]
  );
  for (const m of mrows) {
    // A membership in the home department is redundant (PATCH clears it
    // when the home moves) — never report it twice.
    if (out.some((d) => d.departmentId === String(m.department_id))) continue;
    out.push({
      departmentId: String(m.department_id),
      jobRoleId: m.job_role_id ? String(m.job_role_id) : null,
      isHome: false,
    });
  }
  return out;
}

/** Department ids a member belongs to (home ∪ memberships). */
export async function userDepartmentIds(companyId: string, userId: string): Promise<string[]> {
  return (await userDepartments(companyId, userId)).map((d) => d.departmentId);
}

/**
 * The member's job role in one of the given departments — the role that
 * decides eligibility for a shift type belonging to those departments.
 * Home first, then memberships, in the order the departments are given.
 * Null when the member has no role in any of them.
 */
export async function roleInDepartments(
  companyId: string,
  userId: string,
  deptIds: string[]
): Promise<{ roleId: string; departmentId: string } | null> {
  const ids = [...new Set((deptIds || []).filter(Boolean).map(String))];
  if (!ids.length) return null;
  const depts = await userDepartments(companyId, userId);
  for (const deptId of ids) {
    const found = depts.find((d) => d.departmentId === deptId);
    if (found && found.jobRoleId) return { roleId: found.jobRoleId, departmentId: deptId };
  }
  return null;
}

/** Every job role a member holds (home + each membership), with its department. */
export async function userRoles(
  companyId: string,
  userId: string
): Promise<Array<{ roleId: string; departmentId: string }>> {
  const depts = await userDepartments(companyId, userId);
  return depts.filter((d) => d.jobRoleId).map((d) => ({ roleId: d.jobRoleId!, departmentId: d.departmentId }));
}

/** Secondary memberships for a batch of users (for list endpoints). */
export async function membershipsForUsers(
  companyId: string,
  userIds: string[]
): Promise<Map<string, UserMembership[]>> {
  const out = new Map<string, UserMembership[]>();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return out;
  const { rows } = await query(
    `SELECT m.user_id, m.department_id, d.name AS department_name,
            m.job_role_id, jr.name AS job_role_name
     FROM user_department_memberships m
     LEFT JOIN departments d ON d.id = m.department_id
     LEFT JOIN job_roles jr ON jr.id = m.job_role_id
     WHERE m.company_id = $1 AND m.user_id = ANY($2::uuid[])
     ORDER BY m.created_at`,
    [companyId, ids]
  );
  for (const r of rows) {
    const uid = String(r.user_id);
    if (!out.has(uid)) out.set(uid, []);
    out.get(uid)!.push({
      departmentId: String(r.department_id),
      departmentName: r.department_name ?? null,
      jobRoleId: r.job_role_id ? String(r.job_role_id) : null,
      jobRoleName: r.job_role_name ?? null,
    });
  }
  return out;
}
