// routes/candidates.ts — candidate intake queue.
// Public (no login): POST /api/candidates (intake form), GET /api/candidates/company
// and GET /api/candidates/departments (apply-page lookups). The public form is
// scoped by company_id carried in the apply link — the one place client input
// legitimately supplies a company id; it is validated against the companies table.
// Admin (owner/scheduler, session company scope): queue list, edit, approve, decline.

import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { findNameWarnings, NameWarning } from '../util/names';
import { splitName, joinName } from '../util/names';

const router = Router();

const BCRYPT_COST = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Validate avatar data URL: must be a small JPEG/PNG/WebP data URL (max ~200KB).
function validateAvatar(v: any): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (s.length > 300000) return null;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(s)) return null;
  return s;
}
const VALID_STATUS = ['pending', 'approved', 'declined'];

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

function publicCandidate(c: any) {
  return {
    id: c.id,
    name: c.name,
    nickname: c.nickname ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    departmentId: c.department_id ?? null,
    department: c.department_name ?? null,
    jobRole: c.job_role ?? null,
    notes: c.notes ?? null,
    specialInstructions: c.special_instructions ?? null,
    avatarData: c.avatar_data ?? null,
    status: c.status,
    submittedAt: c.submitted_at,
  };
}

const CANDIDATE_SELECT = `
  SELECT c.id, c.name, c.nickname, c.email, c.phone, c.department_id,
         d.name AS department_name, c.job_role, c.notes, c.status, c.submitted_at,
         c.special_instructions, c.avatar_data
  FROM candidates c LEFT JOIN departments d ON d.id = c.department_id
`;

/** Name warnings for a candidate name against users + other candidates in the company. */
async function nameWarningsFor(
  companyId: string,
  name: string,
  excludeCandidateId?: string
): Promise<NameWarning[]> {
  const users = await query<{ name: string }>(`SELECT name FROM users WHERE company_id = $1`, [
    companyId,
  ]);
  const params: any[] = [companyId];
  let candSql = `SELECT id, name FROM candidates WHERE company_id = $1`;
  if (excludeCandidateId) {
    candSql += ` AND id <> $2`;
    params.push(excludeCandidateId);
  }
  const cands = await query<{ id: string; name: string }>(candSql, params);
  return findNameWarnings(name, [
    ...users.rows.map((u) => ({ name: u.name, kind: 'user' as const })),
    ...cands.rows.map((c) => ({ name: c.name, kind: 'candidate' as const })),
  ]);
}

// ---------------------------------------------------------------------------
// Public endpoints (no login) — rate-limited.
// ---------------------------------------------------------------------------

// GET /api/candidates/company?id=<uuid> — resolve an apply link to a company name.
router.get('/company', publicLimit(30), async (req: Request, res: Response) => {
  try {
    const id = String(req.query.id ?? '');
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: 'This application link is not valid.' });
      return;
    }
    const { rows } = await query(`SELECT id, name FROM companies WHERE id = $1`, [id]);
    if (!rows.length) {
      res.status(404).json({ error: 'This application link is not valid.' });
      return;
    }
    res.json({ company: { id: rows[0].id, name: rows[0].name } });
  } catch (err) {
    console.error('[candidates] company lookup failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/candidates/departments?companyId=<uuid> — department options for the form.
router.get('/departments', publicLimit(30), async (req: Request, res: Response) => {
  try {
    const companyId = String(req.query.companyId ?? '');
    if (!UUID_RE.test(companyId)) {
      res.status(400).json({ error: 'This application link is not valid.' });
      return;
    }
    const { rows: co } = await query(`SELECT id FROM companies WHERE id = $1`, [companyId]);
    if (!co.length) {
      res.status(404).json({ error: 'This application link is not valid.' });
      return;
    }
    const { rows } = await query(
      `SELECT id, name FROM departments WHERE company_id = $1 ORDER BY lower(name)`,
      [companyId]
    );
    res.json({ departments: rows.map((d: any) => ({ id: d.id, name: d.name })) });
  } catch (err) {
    console.error('[candidates] departments lookup failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/candidates — public intake submission. Never blocked by name warnings;
// warnings are returned so the admin queue (and submitter notice) can show them.
router.post('/', publicLimit(10), async (req: Request, res: Response) => {
  try {
    const { companyId, name, nickname, email, phone, departmentId, jobRole, notes, specialInstructions, avatarData } = req.body ?? {};
    if (!companyId || !UUID_RE.test(String(companyId))) {
      res.status(400).json({ error: 'This application link is not valid.' });
      return;
    }
    const { rows: co } = await query(`SELECT id, name FROM companies WHERE id = $1`, [companyId]);
    if (!co.length) {
      res.status(404).json({ error: 'This application link is not valid.' });
      return;
    }
    const cleanName = String(name ?? '').trim();
    if (!cleanName) {
      res.status(400).json({ error: 'Please enter your name.' });
      return;
    }
    const cleanEmail = String(email ?? '').trim();
    if (!EMAIL_RE.test(cleanEmail)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
      return;
    }
    let deptId: string | null = null;
    const rawDept = String(departmentId ?? '').trim();
    if (rawDept) {
      const { rows: dept } = await query(
        `SELECT id FROM departments WHERE id = $1 AND company_id = $2`,
        [rawDept, companyId]
      );
      if (!dept.length) {
        res.status(400).json({ error: 'Please choose a valid department.' });
        return;
      }
      deptId = dept[0].id;
    }

    const id = crypto.randomUUID();
    await query(
      `INSERT INTO candidates
         (id, company_id, name, nickname, email, phone, department_id, job_role, notes, special_instructions, avatar_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        companyId,
        cleanName,
        String(nickname ?? '').trim() || null,
        cleanEmail,
        String(phone ?? '').trim() || null,
        deptId,
        String(jobRole ?? '').trim() || null,
        String(notes ?? '').trim() || null,
        String(specialInstructions ?? '').trim().slice(0, 500) || null,
        validateAvatar(avatarData),
      ]
    );
    const { rows } = await query(CANDIDATE_SELECT + ` WHERE c.id = $1`, [id]);
    const warnings = await nameWarningsFor(companyId, cleanName, id);
    res.status(201).json({
      candidate: publicCandidate(rows[0]),
      company: { id: co[0].id, name: co[0].name },
      warnings,
    });
  } catch (err) {
    console.error('[candidates] submit failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Admin endpoints — owner/scheduler, scoped to the session company.
// ---------------------------------------------------------------------------

router.use(requireAuth, requireRole('owner', 'scheduler'));

// GET /api/candidates?status=pending|approved|declined|all — the intake queue.
// Each row carries name warnings computed against the company's users + candidates.
router.get('/', async (req: Request, res: Response) => {
  try {
    const status = String(req.query.status ?? 'pending');
    if (![...VALID_STATUS, 'all'].includes(status)) {
      res.status(400).json({ error: 'Status must be pending, approved, declined, or all.' });
      return;
    }
    const params: any[] = [req.session.companyId];
    let sql = CANDIDATE_SELECT + ` WHERE c.company_id = $1`;
    if (status !== 'all') {
      sql += ` AND c.status = $2`;
      params.push(status);
    }
    sql += ` ORDER BY c.submitted_at DESC`;
    const { rows } = await query(sql, params);
    const out = [];
    for (const c of rows) {
      out.push({
        ...publicCandidate(c),
        warnings: await nameWarningsFor(req.session.companyId!, c.name, c.id),
      });
    }
    res.json({ candidates: out });
  } catch (err) {
    console.error('[candidates] queue failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PATCH /api/candidates/:id — edit a pending candidate.
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: existing } = await query(
      CANDIDATE_SELECT + ` WHERE c.id = $1 AND c.company_id = $2`,
      [req.params.id, companyId]
    );
    if (!existing.length) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }
    if (existing[0].status !== 'pending') {
      res.status(400).json({ error: 'Only pending candidates can be edited.' });
      return;
    }
    const body = req.body ?? {};
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
    if (body.email !== undefined) {
      const v = String(body.email).trim();
      if (!EMAIL_RE.test(v)) {
        res.status(400).json({ error: 'Please enter a valid email address.' });
        return;
      }
      push('email', v);
    }
    if (body.phone !== undefined) push('phone', String(body.phone).trim() || null);
    if (body.departmentId !== undefined) {
      const raw = String(body.departmentId ?? '').trim();
      let deptId: string | null = null;
      if (raw) {
        const { rows: dept } = await query(
          `SELECT id FROM departments WHERE id = $1 AND company_id = $2`,
          [raw, companyId]
        );
        if (!dept.length) {
          res.status(400).json({ error: 'Department not found.' });
          return;
        }
        deptId = dept[0].id;
      }
      push('department_id', deptId);
    }
    if (body.jobRole !== undefined) push('job_role', String(body.jobRole).trim() || null);
    if (body.notes !== undefined) push('notes', String(body.notes).trim() || null);
    if (!sets.length) {
      res.status(400).json({ error: 'Nothing to update.' });
      return;
    }
    params.push(req.params.id);
    await query(`UPDATE candidates SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    const { rows } = await query(CANDIDATE_SELECT + ` WHERE c.id = $1`, [req.params.id]);
    res.json({
      candidate: {
        ...publicCandidate(rows[0]),
        warnings: await nameWarningsFor(companyId, rows[0].name, rows[0].id),
      },
    });
  } catch (err) {
    console.error('[candidates] update failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/candidates/:id/approve — create an employee user from the candidate.
// Returns a one-time temporary password the admin must pass to the new hire.
router.post('/:id/approve', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: existing } = await query(
      CANDIDATE_SELECT + ` WHERE c.id = $1 AND c.company_id = $2`,
      [req.params.id, companyId]
    );
    if (!existing.length) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }
    const cand = existing[0];
    if (cand.status !== 'pending') {
      res.status(400).json({ error: 'Only pending candidates can be approved.' });
      return;
    }
    const email = String(cand.email ?? '').trim();
    if (!email) {
      res.status(400).json({ error: 'Add an email address to the candidate before approving.' });
      return;
    }
    const taken = await query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
    if (taken.rowCount > 0) {
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, BCRYPT_COST);
    const userId = crypto.randomUUID();
    const nameSplit = splitName(cand.name);
    await query(
      `INSERT INTO users
         (id, company_id, first_name, last_name, name, nickname, email, phone, department_id, job_role, password_hash, role, special_instructions, avatar_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'employee', $12, $13)`,
      [
        userId,
        companyId,
        nameSplit.first,
        nameSplit.last,
        joinName(nameSplit.first, nameSplit.last),
        cand.nickname,
        email,
        cand.phone,
        cand.department_id,
        cand.job_role,
        passwordHash,
        cand.special_instructions,
        cand.avatar_data,
      ]
    );
    await query(`UPDATE candidates SET status = 'approved' WHERE id = $1`, [cand.id]);

    res.status(201).json({
      user: {
        id: userId,
        firstName: nameSplit.first,
        lastName: nameSplit.last,
        name: joinName(nameSplit.first, nameSplit.last),
        nickname: cand.nickname,
        email,
        phone: cand.phone,
        departmentId: cand.department_id,
        jobRole: cand.job_role,
        role: 'employee',
      },
      // Shown once — the admin must hand it to the new hire; it is never stored in plain text.
      tempPassword,
    });
  } catch (err) {
    console.error('[candidates] approve failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/candidates/:id/decline — move out of the pending queue (kept in history).
router.post('/:id/decline', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: existing } = await query(
      `SELECT id, status FROM candidates WHERE id = $1 AND company_id = $2`,
      [req.params.id, companyId]
    );
    if (!existing.length) {
      res.status(404).json({ error: 'Candidate not found.' });
      return;
    }
    if (existing[0].status !== 'pending') {
      res.status(400).json({ error: 'Only pending candidates can be declined.' });
      return;
    }
    await query(`UPDATE candidates SET status = 'declined' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[candidates] decline failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** 16-char temp password that always satisfies the strict password policy. */
function generateTempPassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$%^&*';
  const all = upper + lower + digits + special;
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = 0; i < 12; i++) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export default router;
