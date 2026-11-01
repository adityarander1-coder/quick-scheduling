// util/formLinks.ts — tokens that open the Email Q-Scheduler request
// form without a login (the pattern the plan approval links and the
// quick-session page already use: the token IS the auth).
//
// standing: one per staff member, long-lived; used by the in-app form
// button and the "New request" button in our emails.
// clarification: issued inside a clarification email; carries the
// original request as prefill and expires after 7 days, matching the
// pending-clarification window.

import crypto from 'crypto';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface FormLink {
  id: string;
  token: string;
  company_id: string;
  user_id: string | null;
  sender_email: string;
  kind: 'standing' | 'clarification';
  prefill: any;
  expires_at: any;
}

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function formLinkUrl(token: string): string {
  const base = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
  return `${base}/api/schedule/request-form/${token}`;
}

/** The member's standing form link, created on first use. */
export async function getOrCreateStandingFormLink(
  query: QueryFn, companyId: string, userId: string, senderEmail: string
): Promise<FormLink> {
  const { rows } = await query(
    "SELECT * FROM form_links WHERE company_id = $1 AND user_id = $2 AND kind = 'standing' ORDER BY created_at LIMIT 1",
    [companyId, userId]
  );
  if (rows.length) return rows[0] as FormLink;
  const { rows: ins } = await query(
    `INSERT INTO form_links (token, company_id, user_id, sender_email, kind)
     VALUES ($1, $2, $3, $4, 'standing') RETURNING *`,
    [newToken(), companyId, userId, senderEmail]
  );
  return ins[0] as FormLink;
}

/** A one-off link for a clarification email: prefilled with what the
 * engine could not understand, bound to the address it was sent to. */
export async function createClarificationFormLink(
  query: QueryFn,
  companyId: string,
  userId: string | null,
  senderEmail: string,
  prefill: { originalSubject: string; originalBody: string; missing: string; messageId: string | null }
): Promise<FormLink> {
  const { rows } = await query(
    `INSERT INTO form_links (token, company_id, user_id, sender_email, kind, prefill, expires_at)
     VALUES ($1, $2, $3, $4, 'clarification', $5, now() + interval '7 days') RETURNING *`,
    [newToken(), companyId, userId, senderEmail, JSON.stringify(prefill)]
  );
  return rows[0] as FormLink;
}

export async function loadFormLink(query: QueryFn, token: string): Promise<FormLink | null> {
  if (!token || token.length < 16) return null;
  const { rows } = await query('SELECT * FROM form_links WHERE token = $1', [token]);
  if (!rows.length) return null;
  const link = rows[0] as FormLink;
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return null;
  return link;
}

/** The "New request" footer for our outgoing mail: a button to the
 * member's own form (recommended) plus the plain-words alternative.
 * Returns null when the address belongs to no staff account. */
export async function standingFormFooter(
  query: QueryFn, companyId: string, senderEmail: string
): Promise<{ text: string; html: string } | null> {
  const user = await findUserByAnyEmail(query, companyId, senderEmail);
  if (!user) return null;
  const link = await getOrCreateStandingFormLink(query, companyId, user.id, user.email);
  const url = formLinkUrl(link.token);
  return {
    text: `Make another request — the form is recommended (it is read exactly, first time):\n${url}\nOr just email Q-Scheduler in your own words, as always.`,
    html: `<p style="margin-top:14px"><a href="${url}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">New request</a></p><p style="color:#5b6b76;font-size:13px">The form is recommended — it is read exactly, first time. Or just email Q-Scheduler in your own words, as always.</p>`,
  };
}

/** Find the staff user behind an email address (account or alternate). */
export async function findUserByAnyEmail(
  query: QueryFn, companyId: string, email: string
): Promise<{ id: string; first_name: string; last_name: string; email: string; alt_email: string | null; role: string } | null> {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  const { rows } = await query(
    `SELECT id, first_name, last_name, email, alt_email, role FROM users
     WHERE company_id = $1 AND is_active = true AND (lower(email) = $2 OR lower(alt_email) = $2) LIMIT 1`,
    [companyId, clean]
  );
  return rows.length ? rows[0] : null;
}
