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
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, requireRole, Role } from '../middleware/auth';
import { splitName, joinName } from '../util/names';
import { issueInvite, unusablePasswordHash, inviteStatusFrom, InviteStatus } from '../util/invites';
import { isMailConfigured, sendMail, escHtml } from '../util/mailer';

const router = Router();

router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES: Role[] = ['owner', 'scheduler', 'employee'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PROFILE_SELECT = `
  SELECT u.id, u.first_name, u.last_name, u.name, u.nickname, u.email, u.phone, u.department_id,
         d.name AS department_name, u.job_role, u.role,
         u.end_date, u.is_active, u.created_at,
         inv.used AS inv_used, inv.sent_at AS inv_sent_at, inv.expires_at AS inv_expires_at
  FROM users u LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN LATERAL (
    SELECT i.used_at IS NOT NULL AS used, i.sent_at, i.expires_at
    FROM invites i WHERE i.user_id = u.id
    ORDER BY i.created_at DESC LIMIT 1
  ) inv ON true
`;

export function publicProfile(u: any) {
  const first = u.first_name ?? '';
  const last = u.last_name ?? '';
  // Computed display name; falls back to the legacy stored `name` for rows
  // the 004 migration hasn't backfilled (shouldn't happen, but be safe).
  const display = joinName(first, last) || u.name || '';
  const inviteStatus: InviteStatus = inviteStatusFrom({
    inv_used: u.inv_used ?? null,
    inv_sent_at: u.inv_sent_at,
    inv_expires_at: u.inv_expires_at,
  });
  return {
    id: u.id,
    firstName: first,
    lastName: last,
    name: display,
    nickname: u.nickname ?? null,
    email: u.email,
    phone: u.phone ?? null,
    departmentId: u.department_id ?? null,
    department: u.department_name ?? null,
    jobRole: u.job_role ?? null,
    role: u.role,
    endDate: toDateStr(u.end_date),
    isActive: !!u.is_active,
    inviteStatus,
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
// Invite flow: no password is set by the admin. The new member gets an unusable
// password hash and an invite link (/accept-invite.html?token=...) which the
// admin copies/shares manually. Response: 201 {user, inviteLink}.
router.post('/', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { firstName, lastName, name, email, role, nickname, phone, departmentId, jobRole } =
      req.body ?? {};
    // Prefer explicit firstName/lastName; fall back to splitting a legacy `name`.
    let first = String(firstName ?? '').trim();
    let last = String(lastName ?? '').trim();
    if (!first && name) {
      const split = splitName(name);
      first = split.first;
      last = split.last;
    }
    if (!first || !email || !role) {
      res.status(400).json({ error: 'First name, email, and role are required.' });
      return;
    }
    const cleanEmail = String(email).trim();
    if (!EMAIL_RE.test(cleanEmail)) {
      res.status(400).json({ error: 'Please enter a valid email address.' });
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

    // Unusable hash: no password can ever match, so the account can't be used
    // until the invite is accepted and a real password is set.
    const passwordHash = await unusablePasswordHash();
    const userId = crypto.randomUUID();
    await query(
      `INSERT INTO users (id, company_id, first_name, last_name, name, nickname, email, phone, department_id, job_role, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        userId,
        req.session.companyId,
        first,
        last,
        joinName(first, last),
        String(nickname ?? '').trim() || null,
        cleanEmail,
        String(phone ?? '').trim() || null,
        dept.id,
        String(jobRole ?? '').trim() || null,
        passwordHash,
        role,
      ]
    );

    // Fresh invite link for the admin to copy/share (status starts "not sent").
    const { inviteLink } = await issueInvite(userId, req.session.companyId!);

    const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [userId]);
    res.status(201).json({ user: publicProfile(rows[0]), inviteLink });
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

    if (body.firstName !== undefined || body.lastName !== undefined || body.name !== undefined) {
      // Explicit firstName/lastName win; a legacy `name` is split the same way
      // as the 004 migration. Partial updates keep the other half.
      let first = String(target.first_name ?? '');
      let last = String(target.last_name ?? '');
      if (body.name !== undefined && body.firstName === undefined && body.lastName === undefined) {
        const split = splitName(body.name);
        first = split.first;
        last = split.last;
      } else {
        if (body.firstName !== undefined) first = String(body.firstName).trim();
        if (body.lastName !== undefined) last = String(body.lastName).trim();
      }
      if (!first) {
        res.status(400).json({ error: 'First name cannot be empty.' });
        return;
      }
      push('first_name', first);
      push('last_name', last);
      push('name', joinName(first, last));
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

/** Load a company-scoped user row, or null. */
async function companyUser(userId: string, companyId: string) {
  const { rows } = await query(
    `SELECT u.id, u.is_active,
            EXISTS (SELECT 1 FROM invites i WHERE i.user_id = u.id AND i.used_at IS NOT NULL) AS accepted
     FROM users u WHERE u.id = $1 AND u.company_id = $2`,
    [userId, companyId]
  );
  return rows[0] ?? null;
}

/** Guard shared by the invite endpoints: member must exist in the caller's
 *  company and must not have accepted an invite already. */
async function inviteTargetCheck(
  res: Response,
  userId: string,
  companyId: string
): Promise<{ id: string } | null> {
  const target = await companyUser(userId, companyId);
  if (!target) {
    res.status(404).json({ error: 'Team member not found.' });
    return null;
  }
  if (target.accepted) {
    res.status(400).json({ error: 'This team member has already accepted their invite.' });
    return null;
  }
  return { id: target.id };
}

// POST /api/users/:id/reinvite — owner/scheduler only.
// Issues a FRESH invite link (invalidates prior unused links) and resets the
// status to "not sent". For members who never accepted.
router.post('/:id/reinvite', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const target = await inviteTargetCheck(res, req.params.id, companyId);
    if (!target) return;
    const { inviteLink } = await issueInvite(target.id, companyId);
    res.json({ inviteLink });
  } catch (err) {
    console.error('[users] reinvite failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/users/:id/invite-link — owner/scheduler only.
// Returns a valid invite link to copy/share later. Raw tokens are never stored,
// so this mints a fresh link (invalidating prior unused ones) when the current
// one is missing or expired — identical in effect to reinvite.
router.post('/:id/invite-link', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const target = await inviteTargetCheck(res, req.params.id, companyId);
    if (!target) return;
    const { inviteLink } = await issueInvite(target.id, companyId);
    res.json({ inviteLink });
  } catch (err) {
    console.error('[users] invite-link failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/users/:id/invite-sent — owner/scheduler only.
// Marks the member's current invite as sent (status: "not sent" -> "sent").
router.post('/:id/invite-sent', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const target = await inviteTargetCheck(res, req.params.id, companyId);
    if (!target) return;
    const { rows } = await query(
      `UPDATE invites SET sent_at = now()
       WHERE user_id = $1 AND company_id = $2
         AND used_at IS NULL AND expires_at > now() AND sent_at IS NULL
       RETURNING id`,
      [target.id, companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'No unsent invite found for this team member.' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] invite-sent failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/users/:id/send-invite — owner/scheduler only.
// Emails the member their invite link (fresh token, like reinvite) and marks
// the invite "sent". Requires SMTP config; without it returns 503 and the UI
// falls back to the manual copy-link flow.
router.post('/:id/send-invite', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const target = await inviteTargetCheck(res, req.params.id, companyId);
    if (!target) return;
    if (!isMailConfigured()) {
      res.status(503).json({ error: 'Email sending is not set up yet.' });
      return;
    }
    const { rows: urows } = await query(
      `SELECT u.id, u.first_name, u.last_name, u.name, u.email, c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = $1 AND u.company_id = $2`,
      [target.id, companyId]
    );
    if (!urows.length) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    const member = urows[0];
    // Fresh token (raw tokens are never stored, so a lost link can't be recovered).
    const { inviteLink } = await issueInvite(target.id, companyId);
    const base = `${req.protocol}://${req.get('host')}`;
    const fullLink = base + inviteLink;
    const displayName = joinName(member.first_name, member.last_name) || member.name || 'there';
    const subject = `[${member.company_name}] invited you to join Quick Scheduling`;
    const text =
      `Hi ${displayName},\n\n` +
      `You've been invited to join ${member.company_name} on Quick Scheduling.\n\n` +
      `Set up your account here:\n${fullLink}\n\n` +
      `This link expires in 7 days. If you didn't expect this invitation, you can ignore this email.\n\n` +
      `— Quick Scheduling`;
    const html =
      `<p>Hi ${escHtml(displayName)},</p>` +
      `<p>You've been invited to join <strong>${escHtml(member.company_name)}</strong> on Quick Scheduling.</p>` +
      `<p><a href="${escHtml(fullLink)}">Set up your account</a></p>` +
      `<p style="color:#666;font-size:0.9em">This link expires in 7 days. If you didn't expect this invitation, you can ignore this email.</p>` +
      `<p>— Quick Scheduling</p>`;
    try {
      await sendMail({ to: member.email, subject, text, html });
    } catch (err) {
      console.error('[users] send-invite mail failed:', err);
      res.status(502).json({ error: 'Could not send the email. Please try again or copy the link manually.' });
      return;
    }
    await query(
      `UPDATE invites SET sent_at = now()
       WHERE user_id = $1 AND company_id = $2 AND used_at IS NULL AND expires_at > now()`,
      [target.id, companyId]
    );
    res.json({ ok: true, inviteLink });
  } catch (err) {
    console.error('[users] send-invite failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
