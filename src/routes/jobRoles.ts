// routes/jobRoles.ts — /api/job-roles, scoped to the session company.
// Job roles are department-scoped: each department defines its own roles
// (e.g. Physician, Nurse Practitioner, Secretary).
//
// Permission model:
// - GET list: any authenticated user; schedulers only see roles in
//   departments they can view (hidden departments stay invisible).
// - POST/PATCH/DELETE: owner/scheduler only; the scheduler's active
//   department must be the role's department with Edit access.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { getDepartmentAccess, requireActiveDepartment } from '../util/departmentAccess';

const router = Router();

router.use(requireAuth);

function publicRole(r: any) {
  return {
    id: r.id,
    name: r.name,
    departmentId: r.department_id,
    createdAt: r.created_at,
  };
}

/** Load a company-scoped department, or null when missing. */
async function companyDepartment(departmentId: string, companyId: string) {
  const { rows } = await query(
    'SELECT id FROM departments WHERE id = $1 AND company_id = $2',
    [departmentId, companyId]
  );
  return rows[0] ?? null;
}

// GET /api/job-roles?departmentId=<uuid> — list roles for one department.
router.get('/', async (req: Request, res: Response) => {
  try {
    const departmentId = String(req.query.departmentId ?? '').trim();
    if (!departmentId) {
      res.status(400).json({ error: 'A department is required.' });
      return;
    }
    const companyId = req.session.companyId!;
    const dept = await companyDepartment(departmentId, companyId);
    if (!dept) {
      res.status(404).json({ error: 'Department not found.' });
      return;
    }
    // Department scoping: schedulers only see roles in viewable departments.
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, companyId);
      if (!access.view.includes(departmentId)) {
        res.status(404).json({ error: 'Department not found.' });
        return;
      }
    }
    const { rows } = await query(
      `SELECT id, name, department_id, created_at FROM job_roles
       WHERE company_id = $1 AND department_id = $2 ORDER BY lower(name)`,
      [companyId, departmentId]
    );
    res.json({ jobRoles: rows.map(publicRole) });
  } catch (err) {
    console.error('[job-roles] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/job-roles — create a role in a department (owner/scheduler).
router.post('/', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { departmentId, name } = req.body ?? {};
    const deptId = String(departmentId ?? '').trim();
    const clean = String(name ?? '').trim();
    if (!deptId) {
      res.status(400).json({ error: 'A department is required.' });
      return;
    }
    if (!clean) {
      res.status(400).json({ error: 'Job role name is required.' });
      return;
    }
    if (clean.length > 100) {
      res.status(400).json({ error: 'Job role name must be 100 characters or fewer.' });
      return;
    }
    if (!(await companyDepartment(deptId, companyId))) {
      res.status(404).json({ error: 'Department not found.' });
      return;
    }
    // Department scoping: the scheduler's active department must be this
    // department with Edit access (owner bypasses).
    if (!(await requireActiveDepartment(req, res, [deptId]))) return;
    const id = crypto.randomUUID();
    try {
      const { rows } = await query(
        `INSERT INTO job_roles (id, company_id, department_id, name)
         VALUES ($1, $2, $3, $4) RETURNING id, name, department_id, created_at`,
        [id, companyId, deptId, clean]
      );
      res.status(201).json({ jobRole: publicRole(rows[0]) });
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'That job role already exists in this department.' });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error('[job-roles] create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/job-roles/:id — rename (owner/scheduler; department-scoped).
router.patch('/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const clean = String(req.body?.name ?? '').trim();
    if (!clean) {
      res.status(400).json({ error: 'Job role name is required.' });
      return;
    }
    if (clean.length > 100) {
      res.status(400).json({ error: 'Job role name must be 100 characters or fewer.' });
      return;
    }
    const { rows: existing } = await query(
      'SELECT id, department_id FROM job_roles WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!existing.length) {
      res.status(404).json({ error: 'Job role not found.' });
      return;
    }
    // Department scoping: the scheduler's active department must be the
    // role's department (owner bypasses).
    if (!(await requireActiveDepartment(req, res, [existing[0].department_id]))) return;
    try {
      const { rows } = await query(
        `UPDATE job_roles SET name = $1 WHERE id = $2 AND company_id = $3
         RETURNING id, name, department_id, created_at`,
        [clean, req.params.id, companyId]
      );
      // Keep the free-text users.job_role in sync for members holding this role.
      await query(
        `UPDATE users SET job_role = $1 WHERE job_role_id = $2 AND company_id = $3`,
        [clean, req.params.id, companyId]
      );
      res.json({ jobRole: publicRole(rows[0]) });
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'That job role already exists in this department.' });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error('[job-roles] rename failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/job-roles/:id — delete (owner/scheduler; department-scoped).
// Members holding the role keep their accounts (job_role_id cleared via
// FK SET NULL); the role is also removed from shift-type eligibility lists.
router.delete('/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: existing } = await query(
      'SELECT id, department_id FROM job_roles WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!existing.length) {
      res.status(404).json({ error: 'Job role not found.' });
      return;
    }
    if (!(await requireActiveDepartment(req, res, [existing[0].department_id]))) return;
    // uuid[] has no FK — scrub the role out of shift-type eligibility lists.
    await query(
      `UPDATE shift_types
       SET eligible_job_role_ids = array_remove(eligible_job_role_ids, $1::uuid)
       WHERE company_id = $2 AND eligible_job_role_ids IS NOT NULL`,
      [req.params.id, companyId]
    );
    const { rowCount } = await query(
      'DELETE FROM job_roles WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Job role not found.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[job-roles] delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
