// routes/auth.ts — /api/auth/* endpoints per API_CONTRACT.md.
// Session regenerate is used on login/signup (session-fixation protection).
// Password-reset tokens are crypto.randomBytes(32) hex; only SHA-256 hashes are stored.

import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, Role } from '../middleware/auth';
import { splitName, joinName } from '../util/names';

const router = Router();

const BCRYPT_COST = 12;
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isDev = () => process.env.DEV_MODE === 'true';

const jsonLimit = (max: number) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({ error: 'Too many requests. Please try again in a minute.' });
    },
  });

export const signupLimiter = jsonLimit(5);
export const loginLimiter = jsonLimit(10);
export const resetRequestLimiter = jsonLimit(5);

interface DbUser {
  id: string;
  company_id: string;
  first_name: string;
  last_name: string;
  name: string;
  nickname: string | null;
  email: string;
  phone: string | null;
  department_id: string | null;
  job_role: string | null;
  end_date: string | null;
  is_active: boolean;
  password_hash: string;
  role: Role;
}

interface DbCompany {
  id: string;
  name: string;
}

function publicUser(u: {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  name: string;
  nickname?: string | null;
  email: string;
  phone?: string | null;
  department_id?: string | null;
  job_role?: string | null;
  end_date?: string | null;
  is_active?: boolean;
  role: string;
}) {
  const first = u.first_name ?? '';
  const last = u.last_name ?? '';
  const display = [first, last].filter(Boolean).join(' ') || u.name;
  return {
    id: u.id,
    firstName: first,
    lastName: last,
    name: display,
    nickname: u.nickname ?? null,
    email: u.email,
    phone: u.phone ?? null,
    departmentId: u.department_id ?? null,
    jobRole: u.job_role ?? null,
    endDate: toDateStr(u.end_date),
    isActive: u.is_active ?? true,
    role: u.role,
  };
}

/** PGlite returns `date` columns as Date objects (UTC midnight); pg returns strings. */
function toDateStr(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

// Strict password policy: >=8 chars, 1 uppercase, 1 digit, 1 special char.
const PASSWORD_RULE_MSG =
  'Password must be at least 8 characters and include one capital letter, one number, and one special character.';
export function passwordPolicyError(pw: unknown): string | null {
  const s = String(pw ?? '');
  if (s.length < 8) return PASSWORD_RULE_MSG;
  if (!/[A-Z]/.test(s)) return PASSWORD_RULE_MSG;
  if (!/[0-9]/.test(s)) return PASSWORD_RULE_MSG;
  if (!/[^A-Za-z0-9]/.test(s)) return PASSWORD_RULE_MSG;
  return null;
}

export function setSession(req: Request, userId: string, companyId: string, role: Role): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.companyId = companyId;
      req.session.role = role;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

async function loadUserAndCompany(userId: string) {
  const { rows } = await query<DbUser & { company_name: string }>(
    `SELECT u.id, u.company_id, u.first_name, u.last_name, u.name, u.nickname, u.email, u.phone, u.department_id,
            u.job_role, u.end_date, u.is_active, u.role, c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [userId]
  );
  if (!rows.length) return null;
  const u = rows[0];
  return {
    user: publicUser(u),
    company: { id: u.company_id, name: u.company_name },
  };
}

// POST /api/auth/signup — creates company + first owner user, starts a session.
router.post('/signup', signupLimiter, async (req: Request, res: Response) => {
  try {
    const { companyName, contactName, email, password } = req.body ?? {};
    if (!companyName || !contactName || !email || !password) {
      res.status(400).json({ error: 'Company name, contact name, email, and password are required.' });
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

    const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [cleanEmail]);
    if (existing.rowCount > 0) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_COST);
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nameSplit = splitName(contactName);

    await query(
      `INSERT INTO companies (id, name) VALUES ($1, $2)`,
      [companyId, String(companyName).trim()]
    );
    await query(
      `INSERT INTO users (id, company_id, first_name, last_name, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner')`,
      [
        userId,
        companyId,
        nameSplit.first,
        nameSplit.last,
        joinName(nameSplit.first, nameSplit.last),
        cleanEmail,
        passwordHash,
      ]
    );

    await setSession(req, userId, companyId, 'owner');

    res.status(201).json({
      user: publicUser({
        id: userId,
        first_name: nameSplit.first,
        last_name: nameSplit.last,
        name: joinName(nameSplit.first, nameSplit.last),
        email: cleanEmail,
        role: 'owner',
      }),
      company: { id: companyId, name: String(companyName).trim() },
    });
  } catch (err) {
    console.error('[auth] signup failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/login — same 401 message for unknown email or wrong password.
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }
    const cleanEmail = String(email).trim();
    const { rows } = await query<DbUser & { company_name: string }>(
      `SELECT u.*, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE lower(u.email) = lower($1)`,
      [cleanEmail]
    );
    const bad = () => res.status(401).json({ error: 'Email or password is incorrect.' });
    if (!rows.length) {
      bad();
      return;
    }
    const user = rows[0];
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      bad();
      return;
    }
    if (!user.is_active) {
      res.status(401).json({ error: 'This account has been deactivated. Contact your administrator.' });
      return;
    }
    await setSession(req, user.id, user.company_id, user.role);
    res.json({
      user: publicUser(user),
      company: { id: user.company_id, name: user.company_name },
    });
  } catch (err) {
    console.error('[auth] login failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/logout — destroys the session.
router.post('/logout', (req: Request, res: Response) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] logout failed:', err);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
      return;
    }
    res.clearCookie('qs.sid');
    res.json({ ok: true });
  });
});

// GET /api/auth/me — current session user, or 401.
router.get('/me', requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await loadUserAndCompany(req.session.userId!);
    if (!data) {
      res.status(401).json({ error: 'You are not signed in.' });
      return;
    }
    res.json(data);
  } catch (err) {
    console.error('[auth] me failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// DEV ONLY: in-memory map of token hash -> raw token so the dev-token endpoint
// can hand the test token back without an email round-trip. Never persisted.
const devTokens = new Map<string, { token: string; expiresAt: number }>();

function devStoreToken(tokenHash: string, token: string, expiresAtMs: number): void {
  if (!isDev()) return;
  devTokens.set(tokenHash, { token, expiresAt: expiresAtMs });
  for (const [k, v] of devTokens) {
    if (v.expiresAt < Date.now()) devTokens.delete(k);
  }
}

// POST /api/auth/password-reset/request — always 200 {ok:true} (no enumeration).
router.post('/password-reset/request', resetRequestLimiter, async (req: Request, res: Response) => {
  try {
    const { email } = req.body ?? {};
    const cleanEmail = typeof email === 'string' ? email.trim() : '';
    if (EMAIL_RE.test(cleanEmail)) {
      const { rows } = await query<DbUser>('SELECT id, email FROM users WHERE lower(email) = lower($1)', [
        cleanEmail,
      ]);
      if (rows.length) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + RESET_TTL_MS);
        const tokenHash = hashToken(token);
        await query(
          `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [crypto.randomUUID(), rows[0].id, tokenHash, expiresAt.toISOString()]
        );
        devStoreToken(tokenHash, token, expiresAt.getTime());
        // TODO(Phase 6): send the password-reset email via src/util/mailer.ts
        // (sendMail) once SMTP is configured — subject like
        // "[Quick Scheduling] Reset your password", body with the reset link
        // /reset.html?token=<token> and the 1-hour expiry note.
        if (isDev()) {
          console.log(`[auth][dev] password reset token for ${rows[0].email}: ${token}`);
        }
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] password-reset request failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/auth/password-reset/dev-token?email= — DEV ONLY, for testing without email.
router.get('/password-reset/dev-token', async (req: Request, res: Response) => {
  if (!isDev()) {
    res.status(404).json({ error: 'Not found.' });
    return;
  }
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim() : '';
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'A valid email is required.' });
      return;
    }
    const { rows } = await query<{ id: string; token_hash: string }>(
      `SELECT prt.id, prt.token_hash
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE lower(u.email) = lower($1) AND prt.used_at IS NULL AND prt.expires_at > now()
       ORDER BY prt.created_at DESC LIMIT 1`,
      [email]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'No active reset token for that email.' });
      return;
    }
    const entry = devTokens.get(rows[0].token_hash);
    if (!entry) {
      res.status(404).json({ error: 'No active reset token for that email.' });
      return;
    }
    res.json({ token: entry.token });
  } catch (err) {
    console.error('[auth] dev-token failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/password-reset/confirm — validates token, sets new password,
// marks token used, destroys ALL sessions for the user.
router.post('/password-reset/confirm', async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body ?? {};
    if (!token || !newPassword) {
      res.status(400).json({ error: 'Token and a new password are required.' });
      return;
    }
    const newPwErr = passwordPolicyError(newPassword);
    if (newPwErr) {
      res.status(400).json({ error: newPwErr });
      return;
    }

    const tokenHash = hashToken(String(token));
    const { rows } = await query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    if (!rows.length) {
      res.status(400).json({ error: 'That reset link is invalid or has expired.' });
      return;
    }
    const { id: tokenId, user_id: userId } = rows[0];
    const passwordHash = await bcrypt.hash(String(newPassword), BCRYPT_COST);

    await query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [tokenId]);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    // Invalidate every session for this user so a stolen session can't linger.
    await query(`DELETE FROM sessions WHERE sess ->> 'userId' = $1`, [userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[auth] password-reset confirm failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
