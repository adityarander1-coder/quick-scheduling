// routes/users.ts — /api/users, scoped to the caller's session company.
// company_id ALWAYS comes from req.session — never from client input.

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import { requireRole, Role } from '../middleware/auth';

const router = Router();

const BCRYPT_COST = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES: Role[] = ['owner', 'scheduler', 'employee'];

// owner | scheduler only; employees get 403.
router.use(requireRole('owner', 'scheduler'));

// GET /api/users — list users in the caller's company.
router.get('/', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT id, name, email, role, created_at
       FROM users WHERE company_id = $1 ORDER BY created_at`,
      [req.session.companyId]
    );
    res.json({
      users: rows.map((u: any) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        createdAt: u.created_at,
      })),
    });
  } catch (err) {
    console.error('[users] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/users — create a user in the caller's company.
// Owner may create any role; scheduler may create scheduler|employee only (not owner).
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body ?? {};
    if (!name || !email || !password || !role) {
      res.status(400).json({ error: 'Name, email, password, and role are required.' });
      return;
    }
    const cleanEmail = String(email).trim();
    if (!EMAIL_RE.test(cleanEmail)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    if (String(password).length < 10) {
      res.status(400).json({ error: 'Password must be at least 10 characters.' });
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

    const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [cleanEmail]);
    if (existing.rowCount > 0) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_COST);
    const userId = crypto.randomUUID();
    await query(
      `INSERT INTO users (id, company_id, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, req.session.companyId, String(name).trim(), cleanEmail, passwordHash, role]
    );

    res.status(201).json({
      user: { id: userId, name: String(name).trim(), email: cleanEmail, role },
    });
  } catch (err) {
    console.error('[users] create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});


export default router;
