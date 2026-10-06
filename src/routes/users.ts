// routes/users.ts — /api/users, scoped to the caller's session company.
// company_id ALWAYS comes from req.session — never from client input.
//
// Auth model (Phase 2):
// - GET /api/users: any authenticated user (employees get a read-only directory).
// - POST /api/users: owner/scheduler only (scheduler cannot create owners).
// - PATCH /api/users/:id: owner/scheduler may edit any profile in their company;
//   employees may edit only their OWN phone and nickname.
// `role` is the SYSTEM role (owner/scheduler/employee); `job_role` is the free-text
// clinical role (e.g. "Day Hospitalist"). The two are never interchanged.

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, requireRole, Role } from '../middleware/auth';
import { passwordPolicyError } from './auth';

const router = Router();

router.use(requireAuth);

const BCRYPT_COST = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES: Role[] = ['owner', 'scheduler', 'employee'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PROFILE_SELECT = `
  SELECT u.id, u.name, u.nickname, u.email, u.phone, u.department_id,
         d.name AS department_name, u.job_role, u.role,
         u.end_date, u.is_active, u.created_at
  FROM users u LEFT JOIN departments d ON d.id = u.department_id
`;

function publicProfile(u: any) {
  return {
    id: u.id,
    name: u.name,
    nickname: u.nickname ?? null,
    email: u.email,
    phone: u.phone ?? null,
    departmentId: u.department_id ?? null,
    department: u.department_name ?? null,
    jobRole: u.job_role ?? null,
    role: u.role,
    endDate: toDateStr(u.end_date),
    isActive: !!u.is_active,
    createdAt: u.created_at,
  };
}

/** PGlite returns `date` columns as Date objects (UTC midnight); pg returns strings. */
function toDateStr(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

/** Resolve a department id to a company-scoped department, or null when blank. */
async function resolveDepartment(
  departmentId: unknown,
  companyId: string
): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const raw = String(departmentId ?? '').trim();
  if (!raw) return { ok: true, id: null };
  const { rows } = await query(`SELECT id FROM departments WHERE id = $1 AND company_id = $2`, [
    raw,
    companyId,
  ]);
  if (!rows.length) return { ok: false, error: 'Department not found.' };
  return { ok: true, id: rows[0].id };
}

// GET /api/users — team directory for the caller's company (employees read-only).
router.get('/', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(PROFILE_SELECT + ` WHERE u.company_id = $1 ORDER BY u.created_at`, [
      req.session.companyId,
    ]);
    res.json({ users: rows.map(publicProfile) });
  } catch (err) {
    console.error('[users] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/users — owner/scheduler only; scheduler cannot create owners.
router.post('/', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, nickname, phone, departmentId, jobRole } = req.body ?? {};
    if (!name || !email || !password || !role) {
      res.status(400).json({ error: 'Name, email, password, and role are required.' });
      return;
    }
    const cleanEmail = String(email).trim();
    if (!EMAIL_RE.test(cleanEmail)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    const pwErr = passwordPolicyError(password);
    if (pwErr) {
      res.status(400).json({ error: pwErr });
      return;
    }
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ error: 'Role must be owner, scheduler, or employee.' });
      return;
    }
    if (req.session.role === 'scheduler' && role === 'owner') {
      res.status(403).json({ error: 'You do not have permission to create an owner account.' });
      return;
    }

    const dept = await resolveDepartment(departmentId, req.session.companyId!);
    if (!dept.ok) {
      res.status(400).json({ error: dept.error });
      return;
    }

    const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [cleanEmail]);
    if (existing.rowCount > 0) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_COST);
    const userId = crypto.randomUUID();
    await query(
      `INSERT INTO users (id, company_id, name, nickname, email, phone, department_id, job_role, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        req.session.companyId,
        String(name).trim(),
        String(nickname ?? '').trim() || null,
        cleanEmail,
        String(phone ?? '').trim() || null,
        dept.id,
        String(jobRole ?? '').trim() || null,
        passwordHash,
        role,
      ]
    );

    const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [userId]);
    res.status(201).json({ user: publicProfile(rows[0]) });
  } catch (err) {
    console.error('[users] create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/users/:id — profile updates.
// - owner/scheduler: any profile field of anyone in their company.
// - employee: only their OWN phone and nickname.
// System-role changes: owner only, never on self. Deactivation: never on self,
// and never the company's last active owner.
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const callerRole = req.session.role!;
    const callerId = req.session.userId!;
    const targetId = req.params.id;

    const { rows: existing } = await query(PROFILE_SELECT + ` WHERE u.id = $1 AND u.company_id = $2`, [
      targetId,
      companyId,
    ]);
    if (!existing.length) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    const target = existing[0];

    const body = req.body ?? {};
    const isSelf = targetId === callerId;

    if (callerRole === 'employee') {
      if (!isSelf) {
        res.status(403).json({ error: 'You can only update your own profile.' });
        return;
      }
      const allowed = new Set(['phone', 'nickname']);
      for (const key of Object.keys(body)) {
        if (!allowed.has(key)) {
          res.status(403).json({ error: 'You can only update your own phone number and nickname.' });
          return;
        }
      }
      const phone = body.phone !== undefined ? String(body.phone).trim() || null : target.phone;
      const nickname = body.nickname !== undefined ? String(body.nickname).trim() || null : target.nickname;
      await query(`UPDATE users SET phone = $1, nickname = $2 WHERE id = $3`, [phone, nickname, targetId]);
      const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [targetId]);
      res.json({ user: publicProfile(rows[0]) });
      return;
    }

    // owner / scheduler
    const sets: string[] = [];
    const params: any[] = [];
    const push = (col: string, val: any) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (body.name !== undefined) {
      const v = String(body.name).trim();
      if (!v) {
        res.status(400).json({ error: 'Name cannot be empty.' });
        return;
      }
      push('name', v);
    }
    if (body.nickname !== undefined) push('nickname', String(body.nickname).trim() || null);
    if (body.phone !== undefined) push('phone', String(body.phone).trim() || null);
    if (body.departmentId !== undefined) {
      const dept = await resolveDepartment(body.departmentId, companyId);
      if (!dept.ok) {
        res.status(400).json({ error: dept.error });
        return;
      }
      push('department_id', dept.id);
    }
    if (body.jobRole !== undefined) push('job_role', String(body.jobRole).trim() || null);
    if (body.endDate !== undefined) {
      const raw = String(body.endDate).trim();
      if (raw && !DATE_RE.test(raw)) {
        res.status(400).json({ error: 'End date must be YYYY-MM-DD.' });
        return;
      }
      push('end_date', raw || null);
    }
    if (body.role !== undefined) {
      if (callerRole !== 'owner') {
        res.status(403).json({ error: 'Only an owner can change system roles.' });
        return;
      }
      if (isSelf) {
        res.status(403).json({ error: 'You cannot change your own system role.' });
        return;
      }
      if (!VALID_ROLES.includes(body.role)) {
        res.status(400).json({ error: 'Role must be owner, scheduler, or employee.' });
        return;
      }
      push('role', body.role);
    }
    if (body.isActive !== undefined) {
      const next = !!body.isActive;
      if (!next && isSelf) {
        res.status(403).json({ error: 'You cannot deactivate your own account.' });
        return;
      }
      if (!next && target.role === 'owner' && target.is_active) {
        const { rows: owners } = await query(
          `SELECT COUNT(*)::int AS n FROM users
           WHERE company_id = $1 AND role = 'owner' AND is_active = true AND id <> $2`,
          [companyId, targetId]
        );
        if (owners[0].n === 0) {
          res.status(403).json({ error: 'A company must keep at least one active owner.' });
          return;
        }
      }
      push('is_active', next);
      if (!next) {
        // Kick the deactivated user out everywhere immediately.
        await query(`DELETE FROM sessions WHERE sess ->> 'userId' = $1`, [targetId]);
      }
    }

    if (!sets.length) {
      res.status(400).json({ error: 'Nothing to update.' });
      return;
    }
    params.push(targetId);
    await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [targetId]);
    res.json({ user: publicProfile(rows[0]) });
  } catch (err) {
    console.error('[users] update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
