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
import { getShiftsForRange } from '../util/shiftRange';
import { loadTimedShifts, getShiftTypeTimes } from '../util/shiftConflicts';

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
// Branch switcher (institution admins). The session's companyId moves to
// the branch being viewed; homeCompanyId remembers the main branch.
// Everything downstream stays company-scoped exactly as before — the
// admin simply operates inside the branch's company. CALENDAR PRIVACY
// STANDS: involvement filters key on the session USER, who belongs to
// the main branch, so the admin does not see branch events they are not
// part of.
// ---------------------------------------------------------------------------
async function homeCompany(req: Request): Promise<string> {
  return req.session.homeCompanyId || req.session.companyId!;
}

/** Caller must be an owner (users row) of the home company, and the home
 * company must be an institution's main branch. Returns institutionId. */
async function adminInstitution(req: Request): Promise<string | null> {
  const home = await homeCompany(req);
  const { rows } = await query(
    `SELECT ib.institution_id AS "institutionId"
     FROM institution_branches ib
     JOIN users u ON u.company_id = ib.company_id
     WHERE ib.company_id = $1 AND ib.kind = 'main'
       AND u.id = $2 AND u.role = 'owner' AND u.is_active = true`,
    [home, req.session.userId!]
  );
  return rows.length ? rows[0].institutionId : null;
}

router.get('/context', requireAuth, async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const link = await getBranchLink(companyId);
    const out: any = { linked: !!link, viewing: null };
    if (link) {
      out.institutionName = link.legalName;
      out.kind = link.kind;
      out.isAdmin = await isInstitutionAdmin(req.session.userId!, link.institutionId);
    }
    if (req.session.homeCompanyId && req.session.homeCompanyId !== companyId) {
      const { rows } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
      const { rows: hrows } = await query('SELECT name FROM companies WHERE id = $1', [req.session.homeCompanyId]);
      out.viewing = {
        companyId,
        companyName: rows[0]?.name || '',
        homeCompanyName: hrows[0]?.name || '',
        institutionName: link?.legalName || '',
      };
    }
    res.json(out);
  } catch (err) {
    console.error('[institutions] context failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/switch', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const target = String(req.body?.companyId || '');
    if (!target) {
      res.status(400).json({ error: 'Say which branch to view.' });
      return;
    }
    const institutionId = await adminInstitution(req);
    if (!institutionId) {
      res.status(403).json({ error: 'Only the institution admin can view other branches.' });
      return;
    }
    const home = await homeCompany(req);
    const { rows } = await query(
      'SELECT company_id AS "companyId" FROM institution_branches WHERE institution_id = $1 AND company_id = $2',
      [institutionId, target]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'That branch is not part of this institution.' });
      return;
    }
    if (target === home) {
      req.session.companyId = home;
      delete req.session.homeCompanyId;
    } else {
      req.session.companyId = target;
      req.session.homeCompanyId = home;
    }
    req.session.role = 'owner';
    res.json({ ok: true, companyId: req.session.companyId });
  } catch (err) {
    console.error('[institutions] switch failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/switch-home', requireAuth, async (req: Request, res: Response) => {
  try {
    if (req.session.homeCompanyId) {
      req.session.companyId = req.session.homeCompanyId;
      delete req.session.homeCompanyId;
      req.session.role = 'owner';
    }
    res.json({ ok: true, companyId: req.session.companyId });
  } catch (err) {
    console.error('[institutions] switch-home failed:', err);
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

// ---------------------------------------------------------------------------
// Shared departments (phase 3): Branch A OFFERS one of its departments to
// a named sibling branch; Branch B PULLS. View-only shares feed B's
// on-call strip; cover-enabled shares additionally let B's managers ask
// A's people in that department to cover or take B shifts of it. The
// cross-branch identity key is the person's EMAIL: a human with accounts
// in both branches is the same human, matched by email for conflict
// checks.
// ---------------------------------------------------------------------------

interface ShareRow {
  id: string; institutionId: string; fromCompanyId: string; departmentId: string;
  toCompanyId: string; mode: string; departmentName: string;
  fromCompanyName: string; toCompanyName: string;
}

async function loadShare(id: string): Promise<ShareRow | null> {
  const { rows } = await query<ShareRow>(
    `SELECT ds.id, ds.institution_id AS "institutionId", ds.from_company_id AS "fromCompanyId",
            ds.department_id AS "departmentId", ds.to_company_id AS "toCompanyId", ds.mode,
            d.name AS "departmentName", cf.name AS "fromCompanyName", ct.name AS "toCompanyName"
     FROM department_shares ds
     JOIN departments d ON d.id = ds.department_id
     JOIN companies cf ON cf.id = ds.from_company_id
     JOIN companies ct ON ct.id = ds.to_company_id
     WHERE ds.id = $1 AND ds.revoked_at IS NULL`,
    [id]
  );
  return rows[0] || null;
}

router.get('/shares', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: outgoing } = await query(
      `SELECT ds.id, ds.department_id AS "departmentId", d.name AS "departmentName",
              ds.to_company_id AS "toCompanyId", c.name AS "toCompanyName", ds.mode
       FROM department_shares ds
       JOIN departments d ON d.id = ds.department_id
       JOIN companies c ON c.id = ds.to_company_id
       WHERE ds.from_company_id = $1 AND ds.revoked_at IS NULL ORDER BY d.name`,
      [companyId]
    );
    const { rows: incoming } = await query(
      `SELECT ds.id, ds.department_id AS "departmentId", d.name AS "departmentName",
              ds.from_company_id AS "fromCompanyId", c.name AS "fromCompanyName", ds.mode
       FROM department_shares ds
       JOIN departments d ON d.id = ds.department_id
       JOIN companies c ON c.id = ds.from_company_id
       WHERE ds.to_company_id = $1 AND ds.revoked_at IS NULL ORDER BY d.name`,
      [companyId]
    );
    res.json({ outgoing, incoming });
  } catch (err) {
    console.error('[institutions] shares list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/shares', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const departmentId = String(req.body?.departmentId || '');
    const toCompanyId = String(req.body?.toCompanyId || '');
    const mode = req.body?.mode === 'cover' ? 'cover' : 'view';
    const link = await getBranchLink(companyId);
    if (!link) {
      res.status(400).json({ error: 'Only branches of an institution can share departments.' });
      return;
    }
    const { rows: dept } = await query(
      'SELECT id, name FROM departments WHERE id = $1 AND company_id = $2',
      [departmentId, companyId]
    );
    if (!dept.length) {
      res.status(400).json({ error: 'That department is not in this branch.' });
      return;
    }
    if (toCompanyId === companyId) {
      res.status(400).json({ error: 'Pick a different branch to share with.' });
      return;
    }
    const { rows: sib } = await query(
      'SELECT company_id AS "companyId" FROM institution_branches WHERE institution_id = $1 AND company_id = $2',
      [link.institutionId, toCompanyId]
    );
    if (!sib.length) {
      res.status(400).json({ error: 'That branch is not part of this institution.' });
      return;
    }
    const { rows: existing } = await query(
      `SELECT id FROM department_shares WHERE department_id = $1 AND to_company_id = $2 AND revoked_at IS NULL`,
      [departmentId, toCompanyId]
    );
    if (existing.length) {
      await query('UPDATE department_shares SET mode = $1 WHERE id = $2', [mode, existing[0].id]);
      res.json({ ok: true, id: existing[0].id, updated: true });
      return;
    }
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO department_shares (id, institution_id, from_company_id, department_id, to_company_id, mode, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, link.institutionId, companyId, departmentId, toCompanyId, mode, req.session.userId!]
    );
    res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('[institutions] share create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.delete('/shares/:id', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const share = await loadShare(req.params.id);
    if (!share) {
      res.status(404).json({ error: 'Share not found.' });
      return;
    }
    // Only the owning branch revokes (an institution admin acting inside
    // the branch via the switcher has this session company too).
    if (share.fromCompanyId !== req.session.companyId) {
      res.status(403).json({ error: 'Only the branch that shared the department can revoke the share.' });
      return;
    }
    await query('UPDATE department_shares SET revoked_at = now() WHERE id = $1', [share.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[institutions] share revoke failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** All ACTIVE shares INTO the caller's company, with the source rows. */
async function incomingShares(companyId: string): Promise<ShareRow[]> {
  const { rows } = await query<ShareRow>(
    `SELECT ds.id, ds.institution_id AS "institutionId", ds.from_company_id AS "fromCompanyId",
            ds.department_id AS "departmentId", ds.to_company_id AS "toCompanyId", ds.mode,
            d.name AS "departmentName", cf.name AS "fromCompanyName", ct.name AS "toCompanyName"
     FROM department_shares ds
     JOIN departments d ON d.id = ds.department_id
     JOIN companies cf ON cf.id = ds.from_company_id
     JOIN companies ct ON ct.id = ds.to_company_id
     WHERE ds.to_company_id = $1 AND ds.revoked_at IS NULL`,
    [companyId]
  );
  return rows;
}

// GET /oncall?from&to — the receiving branch's cross-branch on-call
// source: for every incoming share, the source branch's actual shifts
// for the shared department in range, plus CONFIRMED cross-branch
// assignments into this branch. Visible to any signed-in member of the
// receiving branch (the on-call strip is a staff surface).
router.get('/oncall', requireAuth, async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ error: 'from and to dates are required.' });
      return;
    }
    const shares = await incomingShares(companyId);
    const entries: any[] = [];
    for (const share of shares) {
      // People of the shared department in the source branch.
      const { rows: people } = await query(
        'SELECT id FROM users WHERE company_id = $1 AND department_id = $2 AND is_active = true',
        [share.fromCompanyId, share.departmentId]
      );
      const personIds = new Set(people.map((p: any) => p.id));
      if (!personIds.size) continue;
      const shifts = await getShiftsForRange(query, share.fromCompanyId, from, to);
      const types = await getShiftTypeTimes(query, share.fromCompanyId);
      for (const s of shifts) {
        if (!s.userId || !personIds.has(s.userId)) continue;
        const tt = s.shiftTypeId ? types.get(s.shiftTypeId) : undefined;
        entries.push({
          kind: 'oncall', shareId: share.id, date: s.date,
          personName: s.personName, shiftTypeName: s.shiftTypeName,
          startMin: tt?.startMin ?? null, endMin: tt?.endMin ?? null,
          departmentName: share.departmentName, fromBranch: share.fromCompanyName,
          mode: share.mode,
        });
      }
    }
    if (shares.length) {
      const { rows: cross } = await query(
        `SELECT ca.id, ca.date::text AS date, ca.kind, ca.share_id AS "shareId",
                COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS "personName",
                st.name AS "shiftTypeName", st.start_time AS "startTime", st.end_time AS "endTime",
                d.name AS "departmentName", cf.name AS "fromCompanyName"
         FROM cross_branch_assignments ca
         JOIN users u ON u.id = ca.home_user_id
         JOIN shift_types st ON st.id = ca.host_shift_type_id
         JOIN department_shares ds ON ds.id = ca.share_id
         JOIN departments d ON d.id = ds.department_id
         JOIN companies cf ON cf.id = ca.home_company_id
         WHERE ca.host_company_id = $1 AND ca.status = 'confirmed'
           AND ca.date >= $2 AND ca.date <= $3 AND ds.revoked_at IS NULL
         ORDER BY ca.date`,
        [companyId, from, to]
      );
      for (const c of cross) {
        entries.push({
          kind: 'cross', assignmentKind: c.kind, shareId: c.shareId, date: c.date,
          personName: c.personName, shiftTypeName: c.shiftTypeName,
          startTime: c.startTime, endTime: c.endTime,
          departmentName: c.departmentName, fromBranch: c.fromCompanyName,
        });
      }
    }
    entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    res.json({ entries });
  } catch (err) {
    console.error('[institutions] oncall failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /shared-people?shareId= — the shared department's people, for the
// receiving branch's managers to pick from (cover-enabled shares only).
router.get('/shared-people', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const share = await loadShare(String(req.query.shareId || ''));
    if (!share || share.toCompanyId !== req.session.companyId) {
      res.status(404).json({ error: 'Share not found.' });
      return;
    }
    if (share.mode !== 'cover') {
      res.status(403).json({ error: 'This share is view-only — its people cannot be asked to cover.' });
      return;
    }
    const { rows } = await query(
      `SELECT id, COALESCE(nickname, first_name || ' ' || last_name) AS name, email
       FROM users WHERE company_id = $1 AND department_id = $2 AND is_active = true
       ORDER BY name`,
      [share.fromCompanyId, share.departmentId]
    );
    res.json({ people: rows, departmentName: share.departmentName, fromBranch: share.fromCompanyName });
  } catch (err) {
    console.error('[institutions] shared-people failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /assignments — cross-branch requests THIS branch sent (as host).
router.get('/assignments', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT ca.id, ca.date::text AS date, ca.kind, ca.status,
              COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS "personName",
              st.name AS "shiftTypeName", cf.name AS "fromCompanyName"
       FROM cross_branch_assignments ca
       JOIN users u ON u.id = ca.home_user_id
       JOIN shift_types st ON st.id = ca.host_shift_type_id
       JOIN companies cf ON cf.id = ca.home_company_id
       WHERE ca.host_company_id = $1 ORDER BY ca.created_at DESC LIMIT 50`,
      [req.session.companyId!]
    );
    res.json({ assignments: rows });
  } catch (err) {
    console.error('[institutions] assignments list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /assignments — Branch B asks one of Branch A's people (in the
// shared department) to cover or take one of B's shifts. Creates a
// PENDING cross-branch assignment; the person confirms on the act page
// (bell + email), where the dual conflict check runs.
router.post('/assignments', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const hostCompany = req.session.companyId!;
    const shareId = String(req.body?.shareId || '');
    const homeUserId = String(req.body?.homeUserId || '');
    const hostShiftTypeId = String(req.body?.hostShiftTypeId || '');
    const date = String(req.body?.date || '');
    const kind = req.body?.kind === 'cover' ? 'cover' : 'assign';
    const hostDepartmentId = req.body?.hostDepartmentId ? String(req.body.hostDepartmentId) : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Pick a date.' });
      return;
    }
    const share = await loadShare(shareId);
    if (!share || share.toCompanyId !== hostCompany) {
      res.status(404).json({ error: 'Share not found.' });
      return;
    }
    if (share.mode !== 'cover') {
      res.status(403).json({ error: 'This department is shared view-only — cover requests are not allowed.' });
      return;
    }
    const { rows: person } = await query(
      `SELECT id, email, COALESCE(nickname, first_name || ' ' || last_name) AS name
       FROM users WHERE id = $1 AND company_id = $2 AND department_id = $3 AND is_active = true`,
      [homeUserId, share.fromCompanyId, share.departmentId]
    );
    if (!person.length) {
      res.status(400).json({ error: 'That person is not in the shared department.' });
      return;
    }
    const { rows: st } = await query(
      'SELECT id, name FROM shift_types WHERE id = $1 AND company_id = $2',
      [hostShiftTypeId, hostCompany]
    );
    if (!st.length) {
      res.status(400).json({ error: 'That shift type is not in this branch.' });
      return;
    }
    const { rows: dup } = await query(
      `SELECT id FROM cross_branch_assignments
       WHERE share_id = $1 AND home_user_id = $2 AND host_shift_type_id = $3 AND date = $4
         AND status IN ('pending', 'confirmed')`,
      [shareId, homeUserId, hostShiftTypeId, date]
    );
    if (dup.length) {
      res.status(409).json({ error: 'That person already has a request for this shift.' });
      return;
    }
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("hex");
    await query(
      `INSERT INTO cross_branch_assignments
         (id, share_id, host_company_id, home_company_id, home_user_id, host_shift_type_id, host_department_id, date, kind, status, token, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
      [id, shareId, hostCompany, share.fromCompanyId, homeUserId, hostShiftTypeId, hostDepartmentId, date, kind, token, req.session.userId!]
    );
    const { rows: hostCo } = await query('SELECT name FROM companies WHERE id = $1', [hostCompany]);
    const actPath = '/xbranch.html?' + new URLSearchParams({ token }).toString();
    const title = kind === 'cover' ? 'Cover request from another branch' : 'Shift offer from another branch';
    const body =
      `${hostCo[0]?.name || 'Another branch'} is asking you to ${kind === 'cover' ? 'cover' : 'take'} the ${st[0].name} shift on ${date} ` +
      `(${share.departmentName}, shared with your branch). Open the link to accept or decline — accepting checks your shifts in both branches first.`;
    await notify({
      companyId: share.fromCompanyId, userIds: [person[0].id],
      category: 'schedule', type: 'xbranch_request', title, body, link: actPath,
    }).catch(() => { /* bell is best-effort */ });
    const appUrl = process.env.APP_URL || 'http://localhost:4100';
    sendMail({
      to: person[0].email,
      subject: title,
      text: `${body}\n\nReview it here: ${appUrl}${actPath}\n`,
      html: `<p>${body}</p><p><a href="${appUrl}${actPath}">Review the request</a></p>`,
    }).catch(() => { /* DEV outbox / best-effort */ });
    res.status(201).json({ ok: true, id, status: 'pending' });
  } catch (err) {
    console.error('[institutions] assignment create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Public act page for cross-branch assignments (token = the credential,
// same pattern as the gap offers).
// ---------------------------------------------------------------------------
async function assignmentByToken(token: string) {
  if (!token || token.length < 32) return null;
  const { rows } = await query(
    `SELECT ca.id, ca.share_id AS "shareId", ca.host_company_id AS "hostCompanyId",
            ca.home_company_id AS "homeCompanyId", ca.home_user_id AS "homeUserId",
            ca.host_shift_type_id AS "hostShiftTypeId", ca.host_department_id AS "hostDepartmentId",
            ca.date::text AS date, ca.kind, ca.status, ca.created_by AS "createdBy",
            COALESCE(u.nickname, u.first_name || ' ' || u.last_name) AS "personName",
            u.email AS "personEmail",
            st.name AS "shiftTypeName", st.start_time AS "startTime", st.end_time AS "endTime",
            hc.name AS "hostCompanyName", d.name AS "departmentName"
     FROM cross_branch_assignments ca
     JOIN users u ON u.id = ca.home_user_id
     JOIN shift_types st ON st.id = ca.host_shift_type_id
     JOIN companies hc ON hc.id = ca.host_company_id
     JOIN department_shares ds ON ds.id = ca.share_id
     JOIN departments d ON d.id = ds.department_id
     WHERE ca.token = $1`,
    [token]
  );
  return rows[0] || null;
}

router.get('/assignments/act-info', publicLimit(60), async (req: Request, res: Response) => {
  try {
    const a = await assignmentByToken(String(req.query.token || ''));
    if (!a) {
      res.status(404).json({ error: 'This link is not valid.' });
      return;
    }
    res.json({
      personName: a.personName, hostBranch: a.hostCompanyName, departmentName: a.departmentName,
      date: a.date, shiftTypeName: a.shiftTypeName, startTime: a.startTime, endTime: a.endTime,
      kind: a.kind, status: a.status,
    });
  } catch (err) {
    console.error('[institutions] act-info failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

function dayNumOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}

router.post('/assignments/act', publicLimit(30), async (req: Request, res: Response) => {
  try {
    const a = await assignmentByToken(String(req.body?.token || ''));
    if (!a) {
      res.status(404).json({ error: 'This link is not valid.' });
      return;
    }
    if (a.status !== 'pending') {
      res.status(409).json({ error: `This request was already ${a.status}.` });
      return;
    }
    const decision = String(req.body?.decision || '');
    if (decision === 'decline') {
      await query(
        `UPDATE cross_branch_assignments SET status = 'declined', decided_at = now() WHERE id = $1`,
        [a.id]
      );
      res.json({ ok: true, status: 'declined' });
      return;
    }
    if (decision !== 'accept') {
      res.status(400).json({ error: 'Say accept or decline.' });
      return;
    }
    // --- DUAL conflict check (the heart of the feature) ---
    // Candidate window: the host shift on its date, in absolute minutes.
    const hostTypes = await getShiftTypeTimes(query, a.hostCompanyId);
    const hostType = hostTypes.get(a.hostShiftTypeId);
    const candStart = hostType?.startMin != null ? dayNumOf(a.date) * 1440 + hostType.startMin : null;
    const candEnd = hostType?.endMin != null ? dayNumOf(a.date) * 1440 + hostType.endMin : null;
    const overlaps = (s: { date: string; startMin: number | null; endMin: number | null }) => {
      if (candStart == null || candEnd == null || s.startMin == null || s.endMin == null) return false;
      const ss = dayNumOf(s.date) * 1440 + s.startMin;
      const ee = dayNumOf(s.date) * 1440 + s.endMin;
      return ss < candEnd && candStart < ee;
    };
    if (candStart != null) {
      // 1) The person's HOME-branch shifts (manual + rotation) that day
      //    and the day before (overnight spill).
      const prev = new Date((dayNumOf(a.date) - 1) * 86400000).toISOString().slice(0, 10);
      const homeShifts = await loadTimedShifts(query, a.homeCompanyId, prev, a.date);
      const clashHome = homeShifts.find((s) => s.userId === a.homeUserId && overlaps(s));
      if (clashHome) {
        res.status(409).json({
          error: `You already work ${clashHome.shiftTypeName} at your home branch then — accepting would double-book you.`,
        });
        return;
      }
      // 2) The same human in the HOST branch (matched by EMAIL): their
      //    own host-branch shifts, plus their other confirmed
      //    cross-branch assignments into the host branch.
      const { rows: hostUsers } = await query(
        'SELECT id FROM users WHERE company_id = $1 AND lower(email) = lower($2) AND is_active = true',
        [a.hostCompanyId, a.personEmail]
      );
      if (hostUsers.length) {
        const hostShifts = await loadTimedShifts(query, a.hostCompanyId, prev, a.date);
        const ids = new Set(hostUsers.map((u: any) => u.id));
        const clashHost = hostShifts.find((s) => ids.has(s.userId) && overlaps(s));
        if (clashHost) {
          res.status(409).json({
            error: `You already work ${clashHost.shiftTypeName} at ${a.hostCompanyName} then — accepting would double-book you.`,
          });
          return;
        }
      }
      const { rows: otherCross } = await query(
        `SELECT ca.date::text AS date, st.start_time AS "startTime", st.end_time AS "endTime"
         FROM cross_branch_assignments ca
         JOIN shift_types st ON st.id = ca.host_shift_type_id
         JOIN users u ON u.id = ca.home_user_id
         WHERE ca.host_company_id = $1 AND ca.status = 'confirmed' AND ca.id <> $2
           AND lower(u.email) = lower($3) AND ca.date IN ($4, $5)`,
        [a.hostCompanyId, a.id, a.personEmail, a.date, prev]
      );
      // start/end are "HH:MM" — compare in minutes-of-day on same date only.
      const toMin = (t: string | null) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
      const clashCross = otherCross.find((c: any) => {
        if (c.date !== a.date) return false;
        const s = { date: c.date, startMin: toMin(c.startTime), endMin: toMin(c.endTime) };
        if (s.startMin != null && s.endMin != null && s.endMin <= s.startMin) s.endMin += 1440;
        return overlaps(s);
      });
      if (clashCross) {
        res.status(409).json({ error: 'You already confirmed another cross-branch shift that overlaps this one.' });
        return;
      }
      // 3) Cover only: the host shift must still NEED someone (staffing
      //    target vs people already on it — host staff + confirmed
      //    cross-branch assignees).
      if (a.kind === 'cover') {
        const { rows: targets } = await query(
          `SELECT target_count AS "targetCount", weekdays, start_date::text AS "startDate", end_date::text AS "endDate"
           FROM staffing_targets WHERE company_id = $1 AND shift_type_id = $2`,
          [a.hostCompanyId, a.hostShiftTypeId]
        );
        const tgt = targets[0];
        if (tgt && tgt.targetCount > 0) {
          const dow = new Date(a.date + 'T00:00:00Z').getUTCDay();
          const weekdays: number[] = tgt.weekdays || [0, 1, 2, 3, 4, 5, 6];
          const inWindow = (!tgt.startDate || a.date >= tgt.startDate) && (!tgt.endDate || a.date <= tgt.endDate);
          if (inWindow && weekdays.includes(dow)) {
            const hostShifts = await getShiftsForRange(query, a.hostCompanyId, a.date, a.date);
            const own = hostShifts.filter((s) => s.shiftTypeId === a.hostShiftTypeId).length;
            const { rows: conf } = await query(
              `SELECT COUNT(*)::int AS n FROM cross_branch_assignments
               WHERE host_company_id = $1 AND host_shift_type_id = $2 AND date = $3 AND status = 'confirmed'`,
              [a.hostCompanyId, a.hostShiftTypeId, a.date]
            );
            if (own + conf[0].n >= tgt.targetCount) {
              res.status(409).json({ error: 'Good news — that shift is fully staffed now, so cover is no longer needed.' });
              return;
            }
          }
        }
      }
    }
    await query(
      `UPDATE cross_branch_assignments SET status = 'confirmed', decided_at = now() WHERE id = $1`,
      [a.id]
    );
    if (a.createdBy) {
      await notify({
        companyId: a.hostCompanyId, userIds: [a.createdBy],
        category: 'schedule', type: 'xbranch_decision',
        title: 'Cross-branch request accepted',
        body: `${a.personName} accepted the ${a.shiftTypeName} shift on ${a.date} (${a.departmentName}, from another branch).`,
      }).catch(() => { /* best-effort */ });
    }
    res.json({ ok: true, status: 'confirmed' });
  } catch (err) {
    console.error('[institutions] act failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
