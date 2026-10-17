// routes/departments.ts — /api/departments, scoped to the session company.
// Any authenticated user may list (employees read-only); owner/scheduler manage.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { auditLog, todayStr } from '../util/audit.js';
import { requireAuth, requireRole } from '../middleware/auth';
import { getDepartmentAccess } from '../util/departmentAccess';

const router = Router();

router.use(requireAuth);

function publicDept(d: any) {
  return { id: d.id, name: d.name, createdAt: d.created_at };
}

// GET /api/departments — list departments in the caller's company.
// Department-scoped for schedulers (view scope); owner and employees see all.
router.get('/', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT id, name, created_at FROM departments
       WHERE company_id = $1 ORDER BY lower(name)`,
      [req.session.companyId]
    );
    let depts = rows;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
      depts = rows.filter((d) => access.view.includes(d.id));
    }
    res.json({ departments: depts.map(publicDept) });
  } catch (err) {
    console.error('[departments] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/departments — owner/scheduler only.
router.post('/', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { name } = req.body ?? {};
    const clean = String(name ?? '').trim();
    if (!clean) {
      res.status(400).json({ error: 'Department name is required.' });
      return;
    }
    if (clean.length > 100) {
      res.status(400).json({ error: 'Department name must be 100 characters or fewer.' });
      return;
    }
    const id = crypto.randomUUID();
    try {
      await query(
        `INSERT INTO departments (id, company_id, name) VALUES ($1, $2, $3)`,
        [id, req.session.companyId, clean]
      );
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'A department with that name already exists.' });
        return;
      }
      throw err;
    }
    await auditLog({
      companyId: req.session.companyId!, date: todayStr(), action: 'created',
      category: 'settings', source: 'manual', changedBy: req.session.userId!,
      description: `Added department "${clean}"`,
    });
    res.status(201).json({ department: { id, name: clean } });
  } catch (err) {
    console.error('[departments] create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/departments/:id — rename; owner/scheduler only.
router.patch('/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { name } = req.body ?? {};
    const clean = String(name ?? '').trim();
    if (!clean) {
      res.status(400).json({ error: 'Department name is required.' });
      return;
    }
    if (clean.length > 100) {
      res.status(400).json({ error: 'Department name must be 100 characters or fewer.' });
      return;
    }
    try {
      const { rows: oldRows } = await query(
        `SELECT name FROM departments WHERE id = $1 AND company_id = $2`,
        [req.params.id, req.session.companyId]
      );
      const oldName = oldRows.length ? oldRows[0].name : null;
      const { rows } = await query(
        `UPDATE departments SET name = $1 WHERE id = $2 AND company_id = $3 RETURNING id, name`,
        [clean, req.params.id, req.session.companyId]
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Department not found.' });
        return;
      }
      await auditLog({
        companyId: req.session.companyId!, date: todayStr(), action: 'updated',
        category: 'settings', source: 'manual', changedBy: req.session.userId!,
        description: oldName && oldName !== clean
          ? `Renamed department "${oldName}" to "${clean}"`
          : `Updated department "${clean}"`,
      });
      res.json({ department: { id: rows[0].id, name: rows[0].name } });
    } catch (err: any) {
      if (err?.code === '23505') {
        res.status(409).json({ error: 'A department with that name already exists.' });
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error('[departments] update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// DELETE /api/departments/:id — owner/scheduler only.
// Team members in the department keep their accounts; their department is cleared.
router.delete('/:id', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { rows: delRows } = await query(
      `DELETE FROM departments WHERE id = $1 AND company_id = $2 RETURNING name`,
      [req.params.id, req.session.companyId]
    );
    if (!delRows.length) {
      res.status(404).json({ error: 'Department not found.' });
      return;
    }
    await auditLog({
      companyId: req.session.companyId!, date: todayStr(), action: 'deleted',
      category: 'settings', source: 'manual', changedBy: req.session.userId!,
      description: `Deleted department "${delRows[0].name}"`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[departments] delete failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
