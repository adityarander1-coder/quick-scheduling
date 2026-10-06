// routes/invites.ts — public invite acceptance.
// No login required: the token itself is the credential (32 random bytes,
// only its SHA-256 hash is stored). Rate-limited.

import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { query } from '../db';
import { passwordPolicyError, setSession } from './auth';
import { publicProfile } from './users';
import { hashToken } from '../util/invites';

const router = Router();

const BCRYPT_COST = 12;

const publicLimit = (max: number) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    },
  });

const INVALID_MSG = 'This invite link is invalid or has expired.';

// GET /api/invites/info?token= — public. Returns the company + invitee name so
// the accept page can greet the person before they set a password.
router.get('/info', publicLimit(30), async (req: Request, res: Response) => {
  try {
    const token = String(req.query.token ?? '');
    if (!token) {
      res.status(400).json({ error: INVALID_MSG });
      return;
    }
    const { rows } = await query(
      `SELECT i.used_at, i.expires_at, u.first_name, u.last_name, u.name, u.is_active,
              c.id AS company_id, c.name AS company_name
       FROM invites i
       JOIN users u ON u.id = i.user_id
       JOIN companies c ON c.id = i.company_id
       WHERE i.token_hash = $1`,
      [hashToken(token)]
    );
    const inv = rows[0];
    if (
      !inv ||
      inv.used_at ||
      new Date(inv.expires_at).getTime() <= Date.now() ||
      !inv.is_active
    ) {
      res.status(400).json({ error: INVALID_MSG });
      return;
    }
    const first = inv.first_name ?? '';
    const last = inv.last_name ?? '';
    res.json({
      companyName: inv.company_name,
      firstName: first,
      lastName: last,
      name: [first, last].filter(Boolean).join(' ') || inv.name,
    });
  } catch (err) {
    console.error('[invites] info failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/invites/accept {token, password} — public. Sets the member's
// password (strict policy enforced), marks the invite used, and signs them in.
router.post('/accept', publicLimit(10), async (req: Request, res: Response) => {
  try {
    const { token, password } = req.body ?? {};
    if (!token || !password) {
      res.status(400).json({ error: 'An invite link and a new password are required.' });
      return;
    }
    const pwErr = passwordPolicyError(password);
    if (pwErr) {
      res.status(400).json({ error: pwErr });
      return;
    }
    const { rows } = await query(
      `SELECT i.id AS invite_id, i.used_at, i.expires_at,
              u.id AS user_id, u.company_id, u.role, u.is_active,
              u.first_name, u.last_name, u.name, u.nickname, u.email, u.phone,
              u.department_id, u.job_role, u.end_date,
              c.name AS company_name
       FROM invites i
       JOIN users u ON u.id = i.user_id
       JOIN companies c ON c.id = i.company_id
       WHERE i.token_hash = $1`,
      [hashToken(String(token))]
    );
    const inv = rows[0];
    if (
      !inv ||
      inv.used_at ||
      new Date(inv.expires_at).getTime() <= Date.now() ||
      !inv.is_active
    ) {
      res.status(400).json({ error: INVALID_MSG });
      return;
    }
    const passwordHash = await bcrypt.hash(String(password), BCRYPT_COST);
    await query('UPDATE invites SET used_at = now() WHERE id = $1', [inv.invite_id]);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, inv.user_id]);

    await setSession(req, inv.user_id, inv.company_id, inv.role);
    res.json({
      user: publicProfile({
        id: inv.user_id,
        first_name: inv.first_name,
        last_name: inv.last_name,
        name: inv.name,
        nickname: inv.nickname,
        email: inv.email,
        phone: inv.phone,
        department_id: inv.department_id,
        job_role: inv.job_role,
        end_date: inv.end_date,
        is_active: inv.is_active,
        role: inv.role,
        inv_used: true,
        inv_sent_at: null,
        inv_expires_at: null,
      }),
      company: { id: inv.company_id, name: inv.company_name },
    });
  } catch (err) {
    console.error('[invites] accept failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
