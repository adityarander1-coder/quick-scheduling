// util/institutions.ts — Institutions & branches (Deepika, 2026-11-08).
// An institution links 2+ companies; a company is standalone (no link
// row), the institution's main branch, or a branch. INSTITUTION ADMIN =
// an owner of the institution's MAIN branch company — the single
// server-side predicate lives here (isInstitutionAdmin).
import { query } from '../db';
import { notify } from './notify';
import { sendMail, escHtml } from './mailer';

export interface BranchLink {
  institutionId: string;
  legalName: string;
  billTo: string;
  apEmail: string | null;
  kind: 'main' | 'branch';
  declaredDepartments: number | null;
  declaredEmployees: number | null;
}

/** The institution link for a company, or null when it is standalone. */
export async function getBranchLink(companyId: string): Promise<BranchLink | null> {
  const { rows } = await query(
    `SELECT ib.institution_id AS "institutionId", i.legal_name AS "legalName",
            i.bill_to AS "billTo", i.ap_email AS "apEmail", ib.kind,
            ib.declared_departments AS "declaredDepartments",
            ib.declared_employees AS "declaredEmployees"
     FROM institution_branches ib
     JOIN institutions i ON i.id = ib.institution_id
     WHERE ib.company_id = $1`,
    [companyId]
  );
  return rows.length ? (rows[0] as BranchLink) : null;
}

/** The company id of the institution's main branch, or null. */
export async function mainCompanyId(institutionId: string): Promise<string | null> {
  const { rows } = await query(
    `SELECT company_id AS "companyId" FROM institution_branches
     WHERE institution_id = $1 AND kind = 'main'`,
    [institutionId]
  );
  return rows.length ? rows[0].companyId : null;
}

/**
 * Institution-admin predicate: the user is an OWNER of the institution's
 * main branch company. (Session role alone is not trusted — the users
 * row is the source of truth, so a switched view can't fake it.)
 */
export async function isInstitutionAdmin(userId: string, institutionId: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM institution_branches ib
     JOIN users u ON u.company_id = ib.company_id
     WHERE ib.institution_id = $1 AND ib.kind = 'main'
       AND u.id = $2 AND u.role = 'owner' AND u.is_active = true`,
    [institutionId, userId]
  );
  return rows.length > 0;
}

/** Owner user ids of the institution's main branch. */
export async function institutionAdminIds(institutionId: string): Promise<string[]> {
  const main = await mainCompanyId(institutionId);
  if (!main) return [];
  const { rows } = await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' AND is_active = true`,
    [main]
  );
  return rows.map((r: any) => r.id);
}

/** All branches of an institution with company facts, main first. */
export async function listBranches(institutionId: string) {
  const { rows } = await query(
    `SELECT ib.company_id AS "companyId", c.name AS name, ib.kind,
            ib.declared_departments AS "declaredDepartments",
            ib.declared_employees AS "declaredEmployees",
            c.address, c.timezone
     FROM institution_branches ib
     JOIN companies c ON c.id = ib.company_id
     WHERE ib.institution_id = $1
     ORDER BY (ib.kind = 'main') DESC, lower(c.name)`,
    [institutionId]
  );
  return rows;
}

/** Find an institution by legal name (case-insensitive exact match). */
export async function findInstitutionByName(name: string) {
  const { rows } = await query(
    `SELECT id, legal_name AS "legalName" FROM institutions WHERE lower(legal_name) = lower($1) LIMIT 1`,
    [String(name || '').trim()]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Bell + email the institution admins (owners of the main branch).
 * Best-effort, like every notification in this app.
 */
export async function notifyInstitutionAdmins(
  institutionId: string,
  input: { title: string; body: string; link?: string }
): Promise<void> {
  try {
    const main = await mainCompanyId(institutionId);
    if (!main) return;
    const ids = await institutionAdminIds(institutionId);
    if (!ids.length) return;
    await notify({
      companyId: main,
      userIds: ids,
      category: 'approvals',
      type: 'branch_join_request',
      title: input.title,
      body: input.body,
      link: input.link,
    });
    const { rows } = await query(
      'SELECT email FROM users WHERE id = ANY($1::uuid[])',
      [ids]
    );
    const link = input.link || '/app.html';
    for (const r of rows) {
      try {
        await sendMail({
          to: r.email,
          subject: `[Quick Scheduling] ${input.title}`,
          text: `${input.body}\n\nOpen Quick Scheduling: ${link}\n`,
          html: `<p>${escHtml(input.body)}</p><p><a href="${escHtml(link)}">Open Quick Scheduling</a></p>`,
        });
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort — never break the request that triggered it */ }
}
