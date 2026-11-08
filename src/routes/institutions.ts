// routes/institutions.ts — /api/institutions/* (Deepika, 2026-11-08).
// Institutions link companies (branches). Companies stay the operational
// unit; everything here is additive and company scoping elsewhere is
// untouched. Institution admin = owner of the institution's main branch.
import { Router, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { passwordPolicyError, setSession } from './auth';
import { splitName, joinName } from '../util/names';
import { hashToken } from '../util/invites';
import { notify } from '../util/notify';
import { sendMail, escHtml } from '../util/mailer';
import {
  getBranchLink, isInstitutionAdmin, listBranches,
  findInstitutionByName, notifyInstitutionAdmins,
} from '../util/institutions';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BRANCH_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Absolute URL for a path, from the request (APP_URL wins when set). */
function absUrl(req: Request, path: string): string {
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  return base.replace(/\/$/, '') + path;
}

async function companyOwners(companyId: string): Promise<string[]> {
  const { rows } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true`,
    [companyId]
  );
  return rows.map((r: any) => r.id);
}

// ---------------------------------------------------------------------------
// GET /api/institutions/branches — everything Settings → Branches needs.
// ---------------------------------------------------------------------------
router.get('/branches', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: crows } = await query('SELECT id, name FROM companies WHERE id = $1', [companyId]);
    const myCompany = crows[0] || { id: companyId, name: '' };
    const link = await getBranchLink(companyId);
    if (!link) {
      const { rows: reqs } = await query(
        `SELECT id, institution_name AS "institutionName", status, created_at AS "createdAt"
         FROM institution_join_requests
         WHERE requesting_company_id = $1 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [companyId]
      );
      res.json({
        linked: false,
        myCompany: { id: myCompany.id, name: myCompany.name },
        pendingRequest: reqs.length ? reqs[0] : null,
      });
      return;
    }
    const admin = await isInstitutionAdmin(req.session.userId!, link.institutionId);
    const branches = await listBranches(link.institutionId);
    const out: any = {
      linked: true,
      myCompany: { id: myCompany.id, name: myCompany.name },
      institution: {
        id: link.institutionId, legalName: link.legalName,
        billTo: link.billTo, apEmail: link.apEmail,
      },
      myKind: link.kind,
      isAdmin: admin,
      branches,
    };
    if (admin) {
      const { rows: reqs } = await query(
        `SELECT r.id, r.institution_name AS "institutionName", r.requester_email AS "requesterEmail",
                r.created_at AS "createdAt", c.name AS "companyName"
         FROM institution_join_requests r
         LEFT JOIN companies c ON c.id = r.requesting_company_id
         WHERE r.institution_id = $1 AND r.status = 'pending'
         ORDER BY r.created_at`,
        [link.institutionId]
      );
      out.requests = reqs;
      const { rows: invs } = await query(
        `SELECT id, branch_name AS "branchName", email, expires_at AS "expiresAt", created_at AS "createdAt"
         FROM branch_invites
         WHERE institution_id = $1 AND used_at IS NULL AND expires_at > now()
         ORDER BY created_at DESC`,
        [link.institutionId]
      );
      out.invites = invs;
    }
    res.json(out);
  } catch (err) {
    console.error('[institutions] branches failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/institutions/request-join { institutionName } — the owner of a
// standalone company asks to join an institution by name.
// ---------------------------------------------------------------------------
router.post('/request-join', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const name = String(req.body?.institutionName || '').trim();
    if (!name) {
      res.status(400).json({ error: 'Tell us the institution\u2019s name.' });
      return;
    }
    const link = await getBranchLink(companyId);
    if (link) {
      res.status(409).json({ error: 'This company is already part of an institution.' });
      return;
    }
    const { rows: dup } = await query(
      `SELECT id FROM institution_join_requests
       WHERE requesting_company_id = $1 AND status = 'pending' AND lower(institution_name) = lower($2)`,
      [companyId, name]
    );
    if (dup.length) {
      res.status(409).json({ error: 'You already have a request waiting for that institution.' });
      return;
    }
    const inst = await findInstitutionByName(name);
    const { rows: me } = await query('SELECT email FROM users WHERE id = $1', [req.session.userId!]);
    const { rows } = await query(
      `INSERT INTO institution_join_requests
         (id, institution_id, institution_name, requesting_company_id, requester_user_id, requester_email)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [crypto.randomUUID(), inst ? inst.id : null, name, companyId, req.session.userId!, me[0]?.email || null]
    );
    if (inst) {
      const { rows: crows } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
      await notifyInstitutionAdmins(inst.id, {
        title: 'Branch join request',
        body: `${crows[0]?.name || 'A company'} asked to join ${inst.legalName} as a branch. Review it in Settings → Branches.`,
        link: absUrl(req, '/app.html'),
      });
    }
    res.status(201).json({ ok: true, requestId: rows[0].id, matched: !!inst });
  } catch (err) {
    console.error('[institutions] request-join failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/institutions/branches/invite { branchName, email } — institution
// admin names a branch and invites its first admin.
// ---------------------------------------------------------------------------
router.post('/branches/invite', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const link = await getBranchLink(companyId);
    if (!link || !(await isInstitutionAdmin(req.session.userId!, link.institutionId))) {
      res.status(403).json({ error: 'Only the institution admin can add branches.' });
      return;
    }
    const branchName = String(req.body?.branchName || '').trim();
    const email = String(req.body?.email || '').trim();
    if (!branchName) {
      res.status(400).json({ error: 'Give the branch a name.' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'Enter a valid email for the branch admin.' });
      return;
    }
    // No duplicate live invite for the same branch name + email.
    await query(
      `DELETE FROM branch_invites
       WHERE institution_id = $1 AND lower(email) = lower($2) AND used_at IS NULL`,
      [link.institutionId, email]
    );
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + BRANCH_INVITE_TTL_MS);
    await query(
      `INSERT INTO branch_invites (id, institution_id, branch_name, email, token_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), link.institutionId, branchName, email, hashToken(token), req.session.userId!, expiresAt.toISOString()]
    );
    const acceptLink = absUrl(req, '/branch-invite.html?' + new URLSearchParams({ token }).toString());
    try {
      await sendMail({
        to: email,
        subject: `[Quick Scheduling] You're invited to set up ${branchName}`,
        text:
          `Hi,\n\n${link.legalName} is adding ${branchName} as a branch on Quick Scheduling, ` +
          `and you've been invited as its first admin.\n\nSet it up here:\n${acceptLink}\n\n` +
          `This link expires in 7 days.\n\n— Quick Scheduling`,
        html:
          `<p>Hi,</p><p><strong>${escHtml(link.legalName)}</strong> is adding <strong>${escHtml(branchName)}</strong> ` +
          `as a branch on Quick Scheduling, and you've been invited as its first admin.</p>` +
          `<p><a href="${escHtml(acceptLink)}">Set up ${escHtml(branchName)}</a></p>` +
          `<p style="color:#666;font-size:0.9em">This link expires in 7 days.</p><p>— Quick Scheduling</p>`,
      });
    } catch (err) {
      console.error('[institutions] branch invite email failed:', err);
    }
    res.status(201).json({ ok: true, inviteLink: acceptLink });
  } catch (err) {
    console.error('[institutions] branch invite failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/institutions/join-requests/:id/approve | /reject — institution
// admin decides. Approve links the requesting company as a branch.
// ---------------------------------------------------------------------------
async function decideJoinRequest(req: Request, res: Response, approve: boolean) {
  const companyId = req.session.companyId!;
  const link = await getBranchLink(companyId);
  if (!link || !(await isInstitutionAdmin(req.session.userId!, link.institutionId))) {
    res.status(403).json({ error: 'Only the institution admin can decide join requests.' });
    return;
  }
  const { rows } = await query(
    `SELECT id, institution_id AS "institutionId", requesting_company_id AS "requestingCompanyId",
            requester_email AS "requesterEmail", status
     FROM institution_join_requests WHERE id = $1`,
    [req.params.id]
  );
  const jr = rows[0];
  if (!jr || jr.institutionId !== link.institutionId) {
    res.status(404).json({ error: 'Join request not found.' });
    return;
  }
  if (jr.status !== 'pending') {
    res.status(409).json({ error: 'That request was already decided.' });
    return;
  }
  await query(
    `UPDATE institution_join_requests SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3`,
    [approve ? 'approved' : 'rejected', req.session.userId!, jr.id]
  );
  let branchName = '';
  if (jr.requestingCompanyId) {
    const { rows: crows } = await query('SELECT name FROM companies WHERE id = $1', [jr.requestingCompanyId]);
    branchName = crows[0]?.name || '';
  }
  if (approve && jr.requestingCompanyId) {
    const existing = await getBranchLink(jr.requestingCompanyId);
    if (!existing) {
      await query(
        `INSERT INTO institution_branches (id, institution_id, company_id, kind)
         VALUES ($1, $2, $3, 'branch')`,
        [crypto.randomUUID(), link.institutionId, jr.requestingCompanyId]
      );
    }
  }
  // Tell the requester's owners, in their own company (bell) + by email.
  if (jr.requestingCompanyId) {
    try {
      const owners = await companyOwners(jr.requestingCompanyId);
      await notify({
        companyId: jr.requestingCompanyId,
        userIds: owners,
        category: 'approvals',
        type: 'branch_join_decision',
        title: approve ? 'Your branch request was approved' : 'Your branch request was declined',
        body: approve
          ? `${branchName} is now a branch of ${link.legalName}.`
          : `${link.legalName} did not approve the request — ${branchName} stays a standalone account.`,
      });
    } catch { /* best-effort */ }
  }
  if (jr.requesterEmail) {
    try {
      await sendMail({
        to: jr.requesterEmail,
        subject: approve
          ? `[Quick Scheduling] ${branchName} is now a branch of ${link.legalName}`
          : `[Quick Scheduling] Branch request for ${branchName}`,
        text: approve
          ? `Good news — ${link.legalName} approved the request. ${branchName} is now linked as a branch of the institution.\n`
          : `${link.legalName} did not approve the branch request. ${branchName} stays a standalone Quick Scheduling account — nothing else changes.\n`,
        html: approve
          ? `<p>Good news — <strong>${escHtml(link.legalName)}</strong> approved the request. <strong>${escHtml(branchName)}</strong> is now linked as a branch of the institution.</p>`
          : `<p><strong>${escHtml(link.legalName)}</strong> did not approve the branch request. <strong>${escHtml(branchName)}</strong> stays a standalone Quick Scheduling account — nothing else changes.</p>`,
      });
    } catch { /* best-effort */ }
  }
  res.json({ ok: true, status: approve ? 'approved' : 'rejected' });
}

router.post('/join-requests/:id/approve', requireRole('owner'), async (req: Request, res: Response) => {
  try { await decideJoinRequest(req, res, true); }
  catch (err) {
    console.error('[institutions] approve failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/join-requests/:id/reject', requireRole('owner'), async (req: Request, res: Response) => {
  try { await decideJoinRequest(req, res, false); }
  catch (err) {
    console.error('[institutions] reject failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Public branch-invite acceptance.
// ---------------------------------------------------------------------------
const INVALID_INVITE = 'This invite link is invalid or has expired.';

async function loadBranchInvite(token: string) {
  const { rows } = await query(
    `SELECT bi.id, bi.branch_name AS "branchName", bi.email, bi.used_at AS "usedAt",
            bi.expires_at AS "expiresAt", i.legal_name AS "legalName"
     FROM branch_invites bi JOIN institutions i ON i.id = bi.institution_id
     WHERE bi.token_hash = $1`,
    [hashToken(token)]
  );
  const inv = rows[0];
  if (!inv || inv.usedAt || new Date(inv.expiresAt).getTime() <= Date.now()) return null;
  return inv;
}

router.get('/branch-invite/info', publicLimit(30), async (req: Request, res: Response) => {
  try {
    const inv = await loadBranchInvite(String(req.query.token ?? ''));
    if (!inv) {
      res.status(400).json({ error: INVALID_INVITE });
      return;
    }
    res.json({ branchName: inv.branchName, legalName: inv.legalName, email: inv.email });
  } catch (err) {
    console.error('[institutions] branch invite info failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// Accepting creates the branch company — already linked — with the
// invitee as its owner. Branch name is fixed by the invite; address and
// timezone come from the accept form.
router.post('/branch-invite/accept', publicLimit(10), async (req: Request, res: Response) => {
  try {
    const { token, name, password, address, timezone } = req.body ?? {};
    if (!token || !name || !password) {
      res.status(400).json({ error: 'Your name, a password, and the invite link are required.' });
      return;
    }
    const pwErr = passwordPolicyError(password);
    if (pwErr) {
      res.status(400).json({ error: pwErr });
      return;
    }
    const inv = await loadBranchInvite(String(token));
    if (!inv) {
      res.status(400).json({ error: INVALID_INVITE });
      return;
    }
    const existing = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [inv.email]);
    if (existing.rowCount > 0) {
      res.status(409).json({ error: 'An account with that email already exists — sign in instead, then ask the institution admin to re-send the invite.' });
      return;
    }
    const { rows: irows } = await query(
      'SELECT id FROM branch_invites WHERE token_hash = $1',
      [hashToken(String(token))]
    );
    const inviteId = irows[0].id;
    const { rows: mainRows } = await query(
      `SELECT c.industry FROM institution_branches ib JOIN companies c ON c.id = ib.company_id
       WHERE ib.institution_id = (SELECT institution_id FROM branch_invites WHERE id = $1) AND ib.kind = 'main'`,
      [inviteId]
    );
    const institutionIdRow = await query('SELECT institution_id AS "institutionId" FROM branch_invites WHERE id = $1', [inviteId]);
    const institutionId = institutionIdRow.rows[0].institutionId;

    const passwordHash = await bcrypt.hash(String(password), 12);
    const companyId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const nameSplit = splitName(String(name));
    await query(
      `INSERT INTO companies (id, name, billing_status, trial_ends_at, industry, address, timezone)
       VALUES ($1, $2, 'trial', now() + interval '30 days', $3, $4, $5)`,
      [companyId, inv.branchName, mainRows[0]?.industry || 'other',
       String(address || '').trim() || null, String(timezone || '').trim() || null]
    );
    await query(
      `INSERT INTO users (id, company_id, first_name, last_name, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner')`,
      [userId, companyId, nameSplit.first, nameSplit.last,
       joinName(nameSplit.first, nameSplit.last), inv.email, passwordHash]
    );
    await query(
      'INSERT INTO dashboards (company_id, name, created_by) VALUES ($1, $2, $3)',
      [companyId, 'Calendars', userId]
    );
    await query(
      `INSERT INTO institution_branches (id, institution_id, company_id, kind)
       VALUES ($1, $2, $3, 'branch')`,
      [crypto.randomUUID(), institutionId, companyId]
    );
    await query(
      'UPDATE branch_invites SET used_at = now(), created_company_id = $1 WHERE id = $2',
      [companyId, inviteId]
    );
    await setSession(req, userId, companyId, 'owner');
    res.status(201).json({
      ok: true,
      company: { id: companyId, name: inv.branchName },
      institution: { id: institutionId, legalName: inv.legalName },
    });
  } catch (err) {
    console.error('[institutions] branch invite accept failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
