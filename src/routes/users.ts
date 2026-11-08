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
import { auditLog, todayStr } from '../util/audit.js';
import { requireAuth, requireRole, Role } from '../middleware/auth';
import { getDepartmentAccess, requireActiveDepartment } from '../util/departmentAccess';
import { splitName, joinName } from '../util/names';
import { issueInvite, unusablePasswordHash, inviteStatusFrom, InviteStatus } from '../util/invites';
import { isMailConfigured, sendMail, escHtml } from '../util/mailer';
import { companyTodayStr } from '../util/notifyJobs.js';
import * as XLSX from 'xlsx';

const router = Router();

router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES: Role[] = ['owner', 'scheduler', 'employee'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate avatar data URL: must be a small JPEG/PNG/WebP data URL (max ~200KB).
function validateAvatar(v: any): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  if (s.length > 300000) return null;
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(s)) return null;
  return s;
}

const PROFILE_SELECT = `
  SELECT u.id, u.first_name, u.last_name, u.name, u.nickname, u.email, u.alt_email, u.phone, u.department_id,
         d.name AS department_name, u.job_role, u.job_role_id,
         jr.name AS job_role_name, u.role,
         u.end_date, u.is_active, u.end_date_deactivated, u.created_at, u.special_instructions, u.profile_color, u.avatar_data,
         inv.used AS inv_used, inv.sent_at AS inv_sent_at, inv.expires_at AS inv_expires_at
  FROM users u LEFT JOIN departments d ON d.id = u.department_id
  LEFT JOIN job_roles jr ON jr.id = u.job_role_id
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
    altEmail: u.alt_email ?? null,
    phone: u.phone ?? null,
    departmentId: u.department_id ?? null,
    department: u.department_name ?? null,
    jobRole: u.job_role ?? null,
    jobRoleId: u.job_role_id ?? null,
    jobRoleName: u.job_role_name ?? null,
    role: u.role,
    endDate: toDateStr(u.end_date),
    isActive: !!u.is_active,
    specialInstructions: u.special_instructions ?? null,
    profileColor: u.profile_color ?? null,
    avatarData: u.avatar_data ?? null,
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

/** Resolve a job role id to a company+department-scoped role, or null when blank. */
async function resolveJobRole(
  jobRoleId: unknown,
  departmentId: string | null,
  companyId: string
): Promise<{ ok: true; id: string | null; name: string | null } | { ok: false; error: string }> {
  const raw = String(jobRoleId ?? '').trim();
  if (!raw) return { ok: true, id: null, name: null };
  if (!departmentId) {
    return { ok: false, error: 'Choose a department before assigning a job role.' };
  }
  const { rows } = await query(
    `SELECT id, name FROM job_roles WHERE id = $1 AND company_id = $2 AND department_id = $3`,
    [raw, companyId, departmentId]
  );
  if (!rows.length) return { ok: false, error: 'Job role not found in that department.' };
  return { ok: true, id: rows[0].id, name: rows[0].name };
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
// Department-scoped for schedulers (view scope); owner and employees see all.
router.get('/', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(PROFILE_SELECT + ` WHERE u.company_id = $1 ORDER BY u.created_at`, [
      req.session.companyId,
    ]);
    let users = rows;
    if (req.session.role === 'scheduler') {
      const access = await getDepartmentAccess(req.session.userId!, req.session.companyId!);
      // Members with no home department are company-global and visible to any scheduler.
      users = rows.filter((u) => !u.department_id || access.view.includes(u.department_id));
    }
    res.json({ users: users.map(publicProfile) });
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
    const { firstName, lastName, name, email, role, nickname, phone, departmentId, jobRole, jobRoleId, specialInstructions, profileColor, avatarData } =
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
    // Job role: a linked department role wins and syncs the legacy free-text
    // column; otherwise the legacy free-text jobRole still works as before.
    let jobRoleIdVal: string | null = null;
    let jobRoleText: string | null = String(jobRole ?? '').trim() || null;
    if (jobRoleId !== undefined) {
      const jr = await resolveJobRole(jobRoleId, dept.id, req.session.companyId!);
      if (!jr.ok) {
        res.status(400).json({ error: jr.error });
        return;
      }
      jobRoleIdVal = jr.id;
      jobRoleText = jr.name;
    }
    // Department scoping: the scheduler's active department must be the
    // member's department (owner bypasses).
    if (!(await requireActiveDepartment(req, res, dept.id ? [dept.id] : []))) return;

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
      `INSERT INTO users (id, company_id, first_name, last_name, name, nickname, email, phone, department_id, job_role, job_role_id, password_hash, role, special_instructions, profile_color, avatar_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
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
        jobRoleText,
        jobRoleIdVal,
        passwordHash,
        role,
        String(specialInstructions ?? '').trim().slice(0, 500) || null,
        String(profileColor ?? '').trim() || null,
        validateAvatar(avatarData),
      ]
    );

    // Fresh invite link for the admin to copy/share (status starts "not sent").
    const { inviteLink } = await issueInvite(userId, req.session.companyId!);

    const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [userId]);
    const newName = `${first} ${last}`.trim();
    await auditLog({
      companyId: req.session.companyId!, date: todayStr(), action: 'created',
      category: 'settings', source: 'manual', changedBy: req.session.userId!,
      personName: newName,
      description: `Added team member "${newName}"${role ? ` as ${role}` : ''}`,
    });
    res.status(201).json({ user: publicProfile(rows[0]), inviteLink });
  } catch (err) {
    console.error('[users] create failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Bulk member import (Deepika, 2026-11-05): upload ONE file listing new
// team members (CSV or Excel) -> a preview checks every row -> one tap
// creates a profile for each clean row. Invites are NOT sent by the
// import; they start "not sent", exactly like a manual add.
// ---------------------------------------------------------------------------

const IMPORT_MAX_ROWS = 200;
const IMPORT_MAX_BYTES = 8 * 1024 * 1024;

function parseCsvGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function excelSerialToYmd(n: number): string {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return d.toISOString().slice(0, 10);
}

function importCellText(c: any): string {
  if (c instanceof Date && !isNaN(c.getTime())) return c.toISOString().slice(0, 10);
  if (typeof c === 'number' && isFinite(c) && c >= 20000 && c <= 80000) return excelSerialToYmd(c);
  return String(c ?? '').trim();
}

/** '2026-11-05' or '11/5/2026' -> 'YYYY-MM-DD', else null. */
function normalizeMemberDate(raw: string): string | null {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (DATE_RE.test(t)) {
    const d = new Date(t + 'T00:00:00Z');
    return isNaN(d.getTime()) ? null : t;
  }
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) {
    const mo = +m[1], da = +m[2];
    let y = +m[3];
    if (y < 100) y += 2000;
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d.getTime()) || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return null;
    return iso;
  }
  return null;
}

type ImportCol = 'firstName' | 'lastName' | 'name' | 'email' | 'phone' | 'department' | 'jobRole' | 'role' | 'endDate';
function importColKind(header: string): ImportCol | null {
  const t = header.toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'firstname' || t === 'first') return 'firstName';
  if (t === 'lastname' || t === 'last' || t === 'surname') return 'lastName';
  if (t === 'name' || t === 'fullname' || t === 'teammember' || t === 'member' || t === 'employee' || t === 'employeename') return 'name';
  if (t === 'email' || t === 'emailaddress' || t === 'mail') return 'email';
  if (t === 'phone' || t === 'phonenumber' || t === 'mobile' || t === 'cell' || t === 'telephone') return 'phone';
  if (t === 'department' || t === 'dept') return 'department';
  if (t === 'jobrole' || t === 'position' || t === 'title' || t === 'jobtitle') return 'jobRole';
  if (t === 'role' || t === 'systemrole' || t === 'access' || t === 'accesslevel') return 'role';
  if (t === 'enddate' || t === 'lastday' || t === 'end') return 'endDate';
  return null;
}

/** Matching key for department / job-role names coming from a file:
 * trimmed, internal whitespace collapsed, lowercased — so " cardiology ",
 * "Cardiology" and "CARDIOLOGY" are the same name. */
function importNameKey(name: unknown): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Display form of a name from a file: trimmed + whitespace collapsed,
 * original case kept. */
function importNameDisplay(name: unknown): string {
  return String(name ?? '').trim().replace(/\s+/g, ' ');
}

// POST /api/users/import/preview — parse the uploaded file and check
// every row. Writes NOTHING; the client shows the result and sends the
// clean rows back to POST /api/users/import.
router.post('/import/preview', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { filename, dataBase64 } = req.body ?? {};
    if (!dataBase64) { res.status(400).json({ error: 'No file was uploaded.' }); return; }
    const buf = Buffer.from(String(dataBase64), 'base64');
    if (!buf.length) { res.status(400).json({ error: 'That file appears to be empty.' }); return; }
    if (buf.length > IMPORT_MAX_BYTES) { res.status(413).json({ error: 'That file is too large (max 8 MB).' }); return; }
    const fname = String(filename || '').toLowerCase();
    let grid: string[][];
    const isZip = buf.subarray(0, 2).toString('latin1') === 'PK';
    if (!isZip && (fname.endsWith('.csv') || fname.endsWith('.txt') || !fname)) {
      grid = parseCsvGrid(buf.toString('utf8')).map((r) => r.map((c) => c.trim()));
    } else {
      let wb: XLSX.WorkBook;
      try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); }
      catch { res.status(400).json({ error: 'That file could not be read as a spreadsheet or CSV.' }); return; }
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }) as any[][];
      grid = raw.map((r) => (r || []).map(importCellText));
    }
    grid = grid.filter((r) => r.some((c) => c !== ''));
    if (!grid.length) { res.status(400).json({ error: 'That file appears to be empty.' }); return; }
    // Header row: first of the first 5 rows naming an email column and a
    // name column.
    let headerIdx = -1;
    let cols: Partial<Record<ImportCol, number>> = {};
    for (let i = 0; i < Math.min(5, grid.length); i++) {
      const found: Partial<Record<ImportCol, number>> = {};
      grid[i].forEach((cell, ci) => {
        const k = importColKind(cell);
        if (k && found[k] === undefined) found[k] = ci;
      });
      if (found.email !== undefined && (found.name !== undefined || found.firstName !== undefined)) {
        headerIdx = i; cols = found; break;
      }
    }
    if (headerIdx < 0) {
      res.status(400).json({ error: 'The file needs a header row with at least a Name (or First name) column and an Email column.' });
      return;
    }
    const { rows: deptRows } = await query('SELECT id, name FROM departments WHERE company_id = $1', [companyId]);
    const deptByKey = new Map<string, any>(deptRows.map((d: any) => [importNameKey(d.name), d]));
    const deptNameById = new Map<string, string>(deptRows.map((d: any) => [String(d.id), String(d.name)]));
    const { rows: roleRows } = await query('SELECT id, name, department_id AS "departmentId" FROM job_roles WHERE company_id = $1', [companyId]);
    const { rows: ex } = await query('SELECT lower(email) AS e, company_id AS c FROM users');
    const existingAll = new Set<string>(ex.map((r: any) => r.e));
    // This company's members by email key, WITH name + active flag, so a
    // duplicate row can be flagged by name ("…belongs to Pat Memorial")
    // and a deactivated member is called out as deactivated — the old
    // bare "Already on your team" was too easy to miss (Deepika,
    // 2026-11-08: "i have added same email id as one more it did not
    // catch it").
    const { rows: myUsers } = await query(
      'SELECT email, lower(email) AS e, name, is_active AS "isActive" FROM users WHERE company_id = $1', [companyId]);
    const existingMemberByKey = new Map<string, { name: string; isActive: boolean }>(
      myUsers.map((u: any) => [u.e, { name: String(u.name || ''), isActive: !!u.isActive }]));
    const myAccess = req.session.role === 'scheduler' ? await getDepartmentAccess(req.session.userId!, companyId) : null;
    // Unknown department / job-role names from the file are grouped (by
    // normalized name) for the preview's resolution panel; rows with a
    // blank department or job role join the blank groups (key '').
    const unknownDeptGroups = new Map<string, { key: string; name: string; rowCount: number }>();
    const unknownRoleGroups = new Map<string, { key: string; name: string; rowCount: number }>();
    let blankDeptRows = 0;
    let blankRoleRows = 0;
    const seen = new Set<string>();
    // First row number (as displayed) using each email, so a duplicate
    // can be flagged "Same email as row N in this file".
    const seenRowByKey = new Map<string, number>();
    const out: any[] = [];
    let truncated = false;
    for (let i = headerIdx + 1; i < grid.length; i++) {
      const r = grid[i];
      if (!r.some((c) => c !== '')) continue;
      if (out.length >= IMPORT_MAX_ROWS) { truncated = true; break; }
      const get = (k: ImportCol) => (cols[k] !== undefined ? String(r[cols[k]!] || '').trim() : '');
      const problems: string[] = [];
      let first = get('firstName');
      let last = get('lastName');
      if (!first && get('name')) {
        const sp = splitName(get('name'));
        first = sp.first;
        if (!last) last = sp.last;
      }
      if (!first) problems.push('Missing name');
      const email = get('email');
      const emailKey = email.toLowerCase();
      if (!email) problems.push('Missing email');
      else if (!EMAIL_RE.test(email)) problems.push('Email looks invalid');
      else if (seen.has(emailKey)) problems.push(`Same email as row ${seenRowByKey.get(emailKey)} in this file`);
      else if (existingMemberByKey.has(emailKey)) {
        const mem = existingMemberByKey.get(emailKey)!;
        problems.push(`Already on the team — ${email} belongs to ${mem.name}${mem.isActive ? '' : ' (deactivated)'}`);
      }
      else if (existingAll.has(emailKey)) problems.push('This email already has an account');
      if (email) {
        seen.add(emailKey);
        if (!seenRowByKey.has(emailKey)) seenRowByKey.set(emailKey, out.length + 1);
      }
      const deptName = get('department');
      let departmentId: string | null = null;
      let departmentName: string | null = null;
      let deptGroupKey: string | null = null;
      let deptIssue: { key: string; name: string; problem: string } | null = null;
      if (deptName) {
        const d = deptByKey.get(importNameKey(deptName));
        if (!d) {
          // Unknown department: the row is blocked until the preview's
          // resolution panel places this group (create or map).
          const key = importNameKey(deptName);
          const problem = `Department "${deptName}" not found`;
          problems.push(problem);
          deptGroupKey = key;
          const g = unknownDeptGroups.get(key);
          if (g) g.rowCount++;
          else unknownDeptGroups.set(key, { key, name: importNameDisplay(deptName), rowCount: 1 });
          deptIssue = { key, name: unknownDeptGroups.get(key)!.name, problem };
        } else {
          departmentId = d.id; departmentName = d.name;
          if (myAccess && !myAccess.edit.includes(d.id)) problems.push('Outside the departments you can edit');
        }
      } else {
        // No department in the file: the row joins the blank group; the
        // panel may assign one, but the row imports without one either
        // way (today's behaviour).
        deptGroupKey = '';
        blankDeptRows++;
      }
      // A "role" column value that names a system role (owner / scheduler
      // / employee) IS the system role; anything else is the job role.
      // Both are shown in the preview, so a misread is visible first.
      let systemRole = 'employee';
      let jobRoleText = get('jobRole');
      const roleVal = get('role');
      if (roleVal) {
        const lv = roleVal.toLowerCase();
        if ((VALID_ROLES as string[]).includes(lv)) systemRole = lv;
        else if (!jobRoleText) jobRoleText = roleVal;
      }
      if (systemRole === 'owner' && req.session.role !== 'owner') problems.push('Only an owner can add an owner account');
      let jobRoleId: string | null = null;
      if (jobRoleText && departmentId) {
        const jr = roleRows.find((x: any) => x.departmentId === departmentId && importNameKey(x.name) === importNameKey(jobRoleText));
        if (jr) { jobRoleId = jr.id; jobRoleText = jr.name; }
      }
      // A job-role name that didn't link to a role in the row's department
      // joins the unknown-role group for the resolution panel (keyed by
      // normalized name); no role text at all joins the blank group.
      // Neither blocks the row — unresolved, the name imports as free
      // text (or no role), exactly as today.
      let roleGroupKey: string | null = null;
      if (jobRoleText) {
        if (!jobRoleId) {
          roleGroupKey = importNameKey(jobRoleText);
          const g = unknownRoleGroups.get(roleGroupKey);
          if (g) g.rowCount++;
          else unknownRoleGroups.set(roleGroupKey, { key: roleGroupKey, name: importNameDisplay(jobRoleText), rowCount: 1 });
        }
      } else {
        roleGroupKey = '';
        blankRoleRows++;
      }
      let endDate: string | null = null;
      const endRaw = get('endDate');
      if (endRaw) {
        endDate = normalizeMemberDate(endRaw);
        if (!endDate) problems.push(`End date "${endRaw}" not understood (use YYYY-MM-DD)`);
      }
      out.push({
        row: out.length + 1, firstName: first, lastName: last, name: joinName(first, last),
        email, phone: get('phone') || null, departmentId, departmentName,
        jobRoleId, jobRole: jobRoleText || null, systemRole, endDate,
        deptGroupKey, deptIssue, roleGroupKey,
        ok: problems.length === 0, problems,
      });
    }
    res.json({
      rows: out, total: out.length, ready: out.filter((r) => r.ok).length, truncated,
      unknownDepartments: [...unknownDeptGroups.values()],
      blankDepartmentRows: blankDeptRows,
      unknownJobRoles: [...unknownRoleGroups.values()],
      blankJobRoleRows: blankRoleRows,
      departments: deptRows.map((d: any) => ({ id: d.id, name: d.name })),
      jobRoles: roleRows.map((r: any) => ({
        id: r.id, name: r.name, departmentId: r.departmentId,
        departmentName: deptNameById.get(String(r.departmentId)) || '',
      })),
      // Department creation in the import panel is owners-only (the
      // product rule the panel mirrors); job-role creation mirrors
      // POST /api/job-roles: owner/scheduler (department-scoped for
      // schedulers, enforced again at import).
      canCreateDepartments: req.session.role === 'owner',
      canCreateJobRoles: req.session.role === 'owner' || req.session.role === 'scheduler',
      myEditDepartmentIds: myAccess ? myAccess.edit : null,
      // The company's current members, so the preview can re-run the
      // duplicate-email check immediately when a flagged row's email is
      // edited in place (the import endpoint re-checks regardless).
      existingMembers: myUsers.map((u: any) => ({ email: u.email, name: u.name, isActive: !!u.isActive })),
    });
  } catch (err) {
    console.error('[users] import preview failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/users/import — create the members. Every row is re-validated
// here (the preview is advice, never proof); bad rows come back in
// `skipped` with the reason instead of failing the whole batch.
router.post('/import', requireRole('owner', 'scheduler'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const members = Array.isArray(req.body?.members) ? req.body.members : null;
    if (!members || !members.length) { res.status(400).json({ error: 'No members to import.' }); return; }
    if (members.length > IMPORT_MAX_ROWS) { res.status(400).json({ error: `An import is limited to ${IMPORT_MAX_ROWS} people at a time.` }); return; }
    const today = await companyTodayStr(companyId);
    const myAccess = req.session.role === 'scheduler' ? await getDepartmentAccess(req.session.userId!, companyId) : null;

    // ---- Resolution decisions from the preview panel -----------------
    // The preview writes nothing; the decisions it collected arrive here
    // and are re-validated before anything is created.
    type ImportDecision = { key: string; action: string; name: string; targetId: string };
    const parseDecisions = (raw: unknown, targetField: 'departmentId' | 'jobRoleId'): Map<string, ImportDecision> => {
      const map = new Map<string, ImportDecision>();
      for (const d of Array.isArray(raw) ? raw : []) {
        if (!d || typeof d !== 'object') continue;
        const action = String((d as any).action || '');
        if (action !== 'create' && action !== 'map') continue;
        const key = String((d as any).key ?? '');
        map.set(key, {
          key, action,
          name: importNameDisplay((d as any).name ?? (d as any).newName ?? ''),
          targetId: String((d as any)[targetField] || ''),
        });
      }
      return map;
    };
    const deptDecisionByKey = parseDecisions(req.body?.departmentDecisions, 'departmentId');
    const roleDecisionByKey = parseDecisions(req.body?.jobRoleDecisions, 'jobRoleId');
    // Department creation during an import is owners-only; a forged
    // create decision is refused up front, before any writes.
    if ([...deptDecisionByKey.values()].some((d) => d.action === 'create') && req.session.role !== 'owner') {
      res.status(403).json({ error: 'Only an owner can create departments during an import. Choose an existing department instead, or ask an owner to add the department first.' });
      return;
    }
    const { rows: companyDepts } = await query('SELECT id, name FROM departments WHERE company_id = $1', [companyId]);
    const companyDeptByKey = new Map<string, any>(companyDepts.map((d: any) => [importNameKey(d.name), d]));
    const { rows: companyRoles } = await query(
      'SELECT id, name, department_id AS "departmentId" FROM job_roles WHERE company_id = $1', [companyId]);
    const companyRoleById = new Map<string, any>(companyRoles.map((r: any) => [String(r.id), r]));
    for (const d of deptDecisionByKey.values()) {
      if (d.action === 'map' && !companyDepts.some((x: any) => String(x.id) === d.targetId)) {
        res.status(400).json({ error: 'One of the chosen departments is not available in your company.' });
        return;
      }
    }
    for (const d of roleDecisionByKey.values()) {
      if (d.action === 'map' && !companyRoleById.has(d.targetId)) {
        res.status(400).json({ error: 'One of the chosen job roles is not available in your company.' });
        return;
      }
    }
    // Create approved departments once each, BEFORE members import
    // against them. A name that exists by now (re-checked by normalized
    // name) resolves to the existing department — never a duplicate.
    const deptResolution = new Map<string, string>();
    const createdDepartments: string[] = [];
    const failedDeptCreateKeys = new Set<string>();
    for (const d of deptDecisionByKey.values()) {
      if (d.action === 'map') { deptResolution.set(d.key, d.targetId); continue; }
      const name = d.name;
      if (!name || name.length > 100) { failedDeptCreateKeys.add(d.key); continue; }
      const existing = companyDeptByKey.get(importNameKey(name));
      if (existing) { deptResolution.set(d.key, String(existing.id)); continue; }
      const newId = crypto.randomUUID();
      try {
        await query('INSERT INTO departments (id, company_id, name) VALUES ($1, $2, $3)', [newId, companyId, name]);
      } catch (err: any) {
        if (err?.code === '23505') {
          const { rows: again } = await query('SELECT id, name FROM departments WHERE company_id = $1', [companyId]);
          const found = again.find((x: any) => importNameKey(x.name) === importNameKey(name));
          if (found) { deptResolution.set(d.key, String(found.id)); companyDeptByKey.set(importNameKey(name), found); }
          else failedDeptCreateKeys.add(d.key);
          continue;
        }
        throw err;
      }
      companyDeptByKey.set(importNameKey(name), { id: newId, name });
      deptResolution.set(d.key, newId);
      createdDepartments.push(name);
      await auditLog({
        companyId, date: todayStr(), action: 'created', category: 'settings', source: 'manual',
        changedBy: req.session.userId!, description: `Added department "${name}"`,
      });
    }
    // Job-role creation mirrors POST /api/job-roles' department scoping:
    // a scheduler may only create roles in departments they can edit.
    // (No departments were created above for a scheduler — their create
    // decisions were refused — so this check runs before any role write.)
    if (req.session.role === 'scheduler' && [...roleDecisionByKey.values()].some((d) => d.action === 'create')) {
      const edit = myAccess ? myAccess.edit : [];
      for (const m of members) {
        if (m?.roleGroupKey === undefined || m?.roleGroupKey === null) continue;
        const dec = roleDecisionByKey.get(String(m.roleGroupKey));
        if (!dec || dec.action !== 'create') continue;
        let dId: string | null = null;
        if (m.departmentId) dId = String(m.departmentId);
        else if (m.deptGroupKey !== undefined && m.deptGroupKey !== null && deptResolution.has(String(m.deptGroupKey))) {
          dId = deptResolution.get(String(m.deptGroupKey))!;
        }
        if (!dId || !edit.includes(dId)) {
          res.status(403).json({ error: 'You can only create job roles in departments you can edit. Choose an existing job role instead.' });
          return;
        }
      }
    }
    const createdJobRoles: string[] = [];
    const createdRoleNames = new Set<string>();
    const roleCreateCache = new Map<string, { id: string; name: string }>();

    const created: any[] = [];
    const skipped: any[] = [];
    const seen = new Set<string>();
    // Position (1-based) of each email's first occurrence in THIS
    // request, for the "Same email as row N in this file" skip reason —
    // same wording as the preview so the result summary reads the same.
    const seenRowByKey = new Map<string, number>();
    let memberIdx = 0;
    for (const m of members) {
      memberIdx++;
      const first = String(m?.firstName || '').trim();
      const last = String(m?.lastName || '').trim();
      const email = String(m?.email || '').trim();
      const skip = (reason: string) => skipped.push({ email: email || null, name: joinName(first, last) || null, reason });
      if (!first || !email) { skip('First name and email are required.'); continue; }
      if (!EMAIL_RE.test(email)) { skip('Email looks invalid.'); continue; }
      const key = email.toLowerCase();
      if (seen.has(key)) { skip(`Same email as row ${seenRowByKey.get(key)} in this file.`); continue; }
      seen.add(key);
      seenRowByKey.set(key, memberIdx);
      const { rows: ex } = await query(
        'SELECT id, company_id AS c, name, is_active AS "isActive" FROM users WHERE lower(email) = lower($1)', [email]);
      if (ex.length) {
        skip(ex[0].c === companyId
          ? `Already on the team — ${email} belongs to ${ex[0].name}${ex[0].isActive ? '' : ' (deactivated)'}.`
          : 'This email already has an account.');
        continue;
      }
      const systemRole = (VALID_ROLES as string[]).includes(String(m.systemRole)) ? String(m.systemRole) : 'employee';
      if (systemRole === 'owner' && req.session.role !== 'owner') { skip('Only an owner can add an owner account.'); continue; }
      let deptId: string | null = null;
      if (m.departmentId) {
        const dept = await resolveDepartment(String(m.departmentId), companyId);
        if (!dept.ok) { skip(dept.error); continue; }
        deptId = dept.id;
      } else if (m.deptGroupKey !== undefined && m.deptGroupKey !== null) {
        // The row's department came from the preview's resolution panel.
        const gk = String(m.deptGroupKey);
        if (deptResolution.has(gk)) deptId = deptResolution.get(gk)!;
        else if (gk === '') deptId = null; // blank group left unassigned — no department, as before
        else if (failedDeptCreateKeys.has(gk)) { skip(`Department name "${String(m.departmentName || '')}" is too long to create.`); continue; }
        else { skip(`Department "${String(m.departmentName || '')}" not found.`); continue; }
      }
      if (myAccess && deptId && !myAccess.edit.includes(deptId)) { skip('Outside the departments you can edit.'); continue; }
      let endDate: string | null = null;
      if (m.endDate) {
        const nd = normalizeMemberDate(String(m.endDate));
        if (!nd) { skip('End date not understood (use YYYY-MM-DD).'); continue; }
        endDate = nd;
      }
      let jobRoleIdVal: string | null = null;
      let jobRoleText: string | null = String(m.jobRole || '').trim() || null;
      if (m.jobRoleId) {
        const jr = await resolveJobRole(String(m.jobRoleId), deptId, companyId);
        if (jr.ok) { jobRoleIdVal = jr.id; jobRoleText = jr.name; }
      }
      // Panel decision for the row's job-role group (create / map),
      // applied before the plain namesake lookup below.
      const roleDec = (m.roleGroupKey !== undefined && m.roleGroupKey !== null)
        ? roleDecisionByKey.get(String(m.roleGroupKey)) : undefined;
      if (!jobRoleIdVal && roleDec) {
        if (roleDec.action === 'create' && roleDec.name && roleDec.name.length <= 100) {
          jobRoleText = roleDec.name;
          if (deptId) {
            // Roles are department-scoped: get-or-create the role as a
            // real entity in THIS member's department, then link it.
            const ck = deptId + '|' + importNameKey(roleDec.name);
            const cached = roleCreateCache.get(ck);
            if (cached) { jobRoleIdVal = cached.id; jobRoleText = cached.name; }
            else {
              const { rows: found } = await query(
                'SELECT id, name FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
                [companyId, deptId, roleDec.name]);
              let roleRow: any = found[0];
              if (!roleRow) {
                const newRoleId = crypto.randomUUID();
                try {
                  await query(
                    'INSERT INTO job_roles (id, company_id, department_id, name) VALUES ($1, $2, $3, $4)',
                    [newRoleId, companyId, deptId, roleDec.name]);
                  roleRow = { id: newRoleId, name: roleDec.name };
                  if (!createdRoleNames.has(roleDec.name)) {
                    createdRoleNames.add(roleDec.name);
                    createdJobRoles.push(roleDec.name);
                  }
                  const deptNameForAudit = (companyDepts.find((x: any) => String(x.id) === deptId) || {}).name || '';
                  await auditLog({
                    companyId, date: todayStr(), action: 'created', category: 'settings', source: 'manual',
                    changedBy: req.session.userId!,
                    description: `Added job role "${roleDec.name}"${deptNameForAudit ? ` to ${deptNameForAudit}` : ''}`,
                  });
                } catch (err: any) {
                  if (err?.code === '23505') {
                    const { rows: again } = await query(
                      'SELECT id, name FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
                      [companyId, deptId, roleDec.name]);
                    roleRow = again[0];
                  } else throw err;
                }
              }
              if (roleRow) {
                roleCreateCache.set(ck, { id: String(roleRow.id), name: roleRow.name });
                jobRoleIdVal = String(roleRow.id); jobRoleText = roleRow.name;
              }
            }
          }
        } else if (roleDec.action === 'map') {
          const target = companyRoleById.get(roleDec.targetId);
          if (target) {
            jobRoleText = target.name;
            if (deptId) {
              // Link when the member's department holds that role (the
              // target itself, or a same-named role in their department).
              const { rows: found } = await query(
                'SELECT id, name FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
                [companyId, deptId, target.name]);
              if (found.length) { jobRoleIdVal = String(found[0].id); jobRoleText = found[0].name; }
            }
          }
        }
      }
      if (!jobRoleIdVal && jobRoleText && deptId) {
        const { rows: jrRows } = await query(
          'SELECT id, name FROM job_roles WHERE company_id = $1 AND department_id = $2 AND lower(name) = lower($3)',
          [companyId, deptId, jobRoleText]);
        if (jrRows.length) { jobRoleIdVal = jrRows[0].id; jobRoleText = jrRows[0].name; }
      }
      // A past end date means the account starts inactive, marked as an
      // end-date deactivation (same rule as the sweep, 2026-11-05).
      const ended = !!endDate && endDate < today;
      const passwordHash = await unusablePasswordHash();
      const userId = crypto.randomUUID();
      await query(
        `INSERT INTO users (id, company_id, first_name, last_name, name, email, phone, department_id, job_role, job_role_id, password_hash, role, end_date, is_active, end_date_deactivated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [userId, companyId, first, last, joinName(first, last), email,
         String(m.phone || '').trim() || null, deptId, jobRoleText, jobRoleIdVal,
         passwordHash, systemRole, endDate, !ended, ended]
      );
      await issueInvite(userId, companyId);
      created.push({ id: userId, name: joinName(first, last), email, inactive: ended });
      await auditLog({
        companyId, date: todayStr(), action: 'created', category: 'settings', source: 'manual',
        changedBy: req.session.userId!, personName: joinName(first, last),
        description: `Imported team member "${joinName(first, last)}" from a file${ended ? ' (end date already passed — account starts inactive)' : ''}`,
      });
    }
    res.json({ created, skipped, createdDepartments, createdJobRoles });
  } catch (err) {
    console.error('[users] import failed:', err);
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

    // Self-service (any role): your own phone, nickname, profile color
    // and alternate "send from" email can always be updated from My
    // Settings — no department scoping.
    if (isSelf) {
      const selfAllowed = new Set(['phone', 'nickname', 'profileColor', 'altEmail']);
      const keys = Object.keys(body);
      if (keys.length && keys.every((k) => selfAllowed.has(k))) {
        const phone = body.phone !== undefined ? String(body.phone).trim() || null : target.phone;
        const nickname = body.nickname !== undefined ? String(body.nickname).trim() || null : target.nickname;
        const color = body.profileColor !== undefined ? String(body.profileColor).trim() || null : target.profile_color;
        if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) {
          res.status(400).json({ error: 'Profile color must be a hex color like #2563eb.' });
          return;
        }
        let altEmail: string | null = target.alt_email ?? null;
        if (body.altEmail !== undefined) {
          const clean = String(body.altEmail).trim().toLowerCase();
          if (!clean) {
            altEmail = null;
          } else {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
              res.status(400).json({ error: 'That does not look like an email address.' });
              return;
            }
            if (clean === String(target.email).toLowerCase()) {
              res.status(400).json({ error: 'That is already your account email — Q-Scheduler accepts it. The extra address is for a different mailbox you send from.' });
              return;
            }
            const { rows: clash } = await query(
              `SELECT 1 FROM users WHERE company_id = $1 AND id <> $2 AND (lower(email) = $3 OR lower(alt_email) = $3) LIMIT 1`,
              [companyId, targetId, clean]
            );
            if (clash.length) {
              res.status(409).json({ error: 'That email already belongs to someone else on your team.' });
              return;
            }
            altEmail = clean;
          }
        }
        await query(`UPDATE users SET phone = $1, nickname = $2, profile_color = $3, alt_email = $4 WHERE id = $5`, [phone, nickname, color, altEmail, targetId]);
        const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [targetId]);
        res.json({ user: publicProfile(rows[0]) });
        return;
      }
    }

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
    // Department scoping: the scheduler's active department must be the
    // member's new (or current) home department. Deactivation counts as an
    // edit of that member, so it goes through the same check.
    let resolvedDept: { ok: true; id: string | null } | null = null;
    {
      let relevant: string[] = [];
      if (body.departmentId !== undefined) {
        const dept = await resolveDepartment(body.departmentId, companyId);
        if (!dept.ok) {
          res.status(400).json({ error: dept.error });
          return;
        }
        resolvedDept = dept;
        relevant = dept.id ? [dept.id] : [];
      } else if (target.department_id) {
        relevant = [target.department_id];
      }
      if (!(await requireActiveDepartment(req, res, relevant))) return;
    }
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
      // Already resolved + validated in the department-scoping block above.
      push('department_id', resolvedDept!.id);
    }
    // Job role: a linked department role wins and syncs the legacy free-text
    // column; otherwise the legacy free-text jobRole still works as before.
    const targetDeptId = body.departmentId !== undefined ? resolvedDept!.id : (target.department_id ?? null);
    if (body.jobRoleId !== undefined) {
      const jr = await resolveJobRole(body.jobRoleId, targetDeptId, companyId);
      if (!jr.ok) {
        res.status(400).json({ error: jr.error });
        return;
      }
      push('job_role_id', jr.id);
      push('job_role', jr.name);
    } else if (body.departmentId !== undefined && targetDeptId !== (target.department_id ?? null)) {
      // Moved departments without a new role: the old department's role no
      // longer applies — unlink it (free-text job_role stays as history).
      push('job_role_id', null);
    } else if (body.jobRole !== undefined) {
      push('job_role', String(body.jobRole).trim() || null);
      push('job_role_id', null);
    }
    if (body.specialInstructions !== undefined) push('special_instructions', String(body.specialInstructions).trim().slice(0, 500) || null);
    if (body.profileColor !== undefined) push('profile_color', String(body.profileColor).trim() || null);
    if (body.avatarData !== undefined) push('avatar_data', validateAvatar(body.avatarData));
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
      // An explicit active/inactive choice is manual control — it clears
      // the end-date flag so the date logic never overrides it later.
      push('end_date_deactivated', false);
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

    // End date drives the account status (Deepika, 2026-11-05): when this
    // save CHANGES the end date (and doesn't itself set isActive), a past
    // date deactivates the account right away, and extending/clearing the
    // date reactivates an account the end-date logic deactivated. Manual
    // deactivations (end_date_deactivated = false) are never undone here.
    let endDateFlip: 'deactivated' | 'reactivated' | null = null;
    if (body.endDate !== undefined && body.isActive === undefined) {
      const oldEnd = target.end_date ? String(target.end_date).slice(0, 10) : null;
      const newEnd = String(body.endDate).trim() || null;
      if (newEnd !== oldEnd) {
        const today = await companyTodayStr(companyId);
        if (newEnd && newEnd < today && target.is_active) {
          await query('UPDATE users SET is_active = false, end_date_deactivated = true WHERE id = $1', [targetId]);
          await query(`DELETE FROM sessions WHERE sess ->> 'userId' = $1`, [targetId]);
          endDateFlip = 'deactivated';
        } else if ((!newEnd || newEnd >= today) && !target.is_active && target.end_date_deactivated) {
          await query('UPDATE users SET is_active = true, end_date_deactivated = false WHERE id = $1', [targetId]);
          endDateFlip = 'reactivated';
        }
      }
    }

    const { rows } = await query(PROFILE_SELECT + ` WHERE u.id = $1`, [targetId]);
    const targetName = `${target.first_name || ''} ${target.last_name || ''}`.trim() || 'Team member';
    const fieldNames = sets.map((s: string) => s.split('=')[0].trim());
    const deactivated = (fieldNames.includes('is_active') && body.is_active === false) || endDateFlip === 'deactivated';
    await auditLog({
      companyId, date: todayStr(),
      action: deactivated ? 'deleted' : 'updated',
      category: 'settings', source: 'manual', changedBy: callerId,
      personName: targetName,
      description: endDateFlip === 'deactivated'
        ? `Deactivated team member "${targetName}" (end date passed)`
        : endDateFlip === 'reactivated'
          ? `Reactivated team member "${targetName}" (end date extended)`
          : deactivated
            ? `Deactivated team member "${targetName}"`
            : `Updated team member "${targetName}" (${fieldNames.join(', ')})`,
    });
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
// the invite "sent". Requires Resend API key; without it returns 503 and the UI
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

// ---------------------------------------------------------------------------
// Scheduler department access — owner only.
// ---------------------------------------------------------------------------

// GET /api/users/:id/department-access — all company departments with the
// member's current access level ('none' | 'view' | 'edit').
router.get('/:id/department-access', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: urows } = await query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!urows.length) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    const { rows: depts } = await query(
      `SELECT id, name FROM departments WHERE company_id = $1 ORDER BY lower(name)`,
      [companyId]
    );
    const access = await getDepartmentAccess(req.params.id, companyId);
    res.json({
      departments: depts.map((d) => ({
        id: d.id,
        name: d.name,
        access: access.edit.includes(d.id) ? 'edit' : access.view.includes(d.id) ? 'view' : 'none',
      })),
    });
  } catch (err) {
    console.error('[users] department-access failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/users/:id/department-access — replace the member's department
// access rows. Body: { access: [{ departmentId, accessLevel: 'view'|'edit' }] }.
// Departments absent from the list get no access.
router.put('/:id/department-access', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const { rows: urows } = await query(
      'SELECT id FROM users WHERE id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    if (!urows.length) {
      res.status(404).json({ error: 'Team member not found.' });
      return;
    }
    const access = req.body?.access;
    if (!Array.isArray(access)) {
      res.status(400).json({ error: 'access must be an array.' });
      return;
    }
    // Validate every department belongs to this company, levels are valid,
    // and no department appears twice.
    const { rows: depts } = await query(
      'SELECT id FROM departments WHERE company_id = $1',
      [companyId]
    );
    const validIds = new Set(depts.map((d: { id: string }) => d.id));
    const seen = new Set<string>();
    for (const a of access) {
      const departmentId = String(a?.departmentId ?? '').trim();
      const accessLevel = a?.accessLevel;
      if (!validIds.has(departmentId)) {
        res.status(400).json({ error: 'Department not found.' });
        return;
      }
      if (accessLevel !== 'view' && accessLevel !== 'edit') {
        res.status(400).json({ error: "accessLevel must be 'view' or 'edit'." });
        return;
      }
      if (seen.has(departmentId)) {
        res.status(400).json({ error: 'Duplicate department in access list.' });
        return;
      }
      seen.add(departmentId);
    }
    await query(
      'DELETE FROM scheduler_department_access WHERE user_id = $1 AND company_id = $2',
      [req.params.id, companyId]
    );
    for (const a of access) {
      await query(
        `INSERT INTO scheduler_department_access (company_id, user_id, department_id, access_level)
         VALUES ($1, $2, $3, $4)`,
        [companyId, req.params.id, String(a.departmentId).trim(), a.accessLevel]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[users] set department-access failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
