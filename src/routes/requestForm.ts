// routes/requestForm.ts — the Email Q-Scheduler request form page.
//
// GET  /api/schedule/request-form-link   (signed in) -> { url } for the
//      in-app ✉️ Email Q-Scheduler button; the app shows the same page
//      in a modal, so phone and web are identical.
// GET  /api/schedule/request-form/:token -> the form page itself. The
//      token is the auth (standing per-member links and one-off
//      clarification links; see util/formLinks.ts). No login needed,
//      so the "New request" button in our emails works for everyone.
// POST /api/schedule/request-form/:token/preview -> the exact email
//      the app will send (composed server-side — one source of truth).
// POST /api/schedule/request-form/:token/submit  -> store + run the
//      shared email engine under the picked From address.

import { Router, Request, Response } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { loadFormLink, getOrCreateStandingFormLink } from '../util/formLinks.js';
import {
  buildFormPack, validateAndCompose, processFormRequest, coverBroadcastRecipients, OUTCOME_MESSAGES, FormUser,
} from '../util/requestForm.js';
import { formPageHtml } from '../util/formPage.js';

const router = Router();

async function userForLink(link: any): Promise<FormUser | null> {
  if (!link.user_id) return null;
  const { rows } = await query(
    `SELECT id, first_name, last_name, email, alt_email, role, department_id
     FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [link.user_id, link.company_id]
  );
  if (!rows.length) return null;
  const u = rows[0];
  return {
    id: u.id,
    name: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
    email: u.email,
    altEmail: u.alt_email || null,
    role: u.role,
    departmentId: u.department_id || null,
  };
}

router.get('/request-form-link', requireAuth, async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      'SELECT email FROM users WHERE id = $1 AND company_id = $2',
      [req.session.userId!, req.session.companyId!]
    );
    if (!rows.length) return res.status(404).json({ error: 'Account not found.' });
    const link = await getOrCreateStandingFormLink(query, req.session.companyId!, req.session.userId!, rows[0].email);
    const { formLinkUrl } = await import('../util/formLinks.js');
    res.json({ url: formLinkUrl(link.token) });
  } catch (err: any) {
    console.error('[form] link failed:', err);
    res.status(500).json({ error: 'Could not open the form.' });
  }
});

function errorPage(res: Response, message: string) {
  res.status(410).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Scheduling — Request form</title>
<body style="font-family:system-ui,sans-serif;background:#f4f7f8;margin:0;padding:40px 18px;color:#17242e">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:26px;box-shadow:0 2px 14px rgba(20,50,60,.08)">
<h2 style="margin:0 0 8px">This form link has expired</h2>
<p style="color:#5b6b76;line-height:1.5">${message}</p>
<p style="color:#5b6b76;line-height:1.5">You can still make your request the other way — just reply to any Q-Scheduler email in your own words, or open the ✉️ Email Q-Scheduler form inside the app.</p>
</div></body>`);
}

router.get('/request-form/:token', async (req: Request, res: Response) => {
  try {
    const link = await loadFormLink(query, req.params.token);
    if (!link) return errorPage(res, 'It may have been replaced by a newer one.');
    const user = await userForLink(link);
    if (!user) return errorPage(res, 'The account behind this link is no longer active.');
    const isClar = link.kind === 'clarification';
    const pack = await buildFormPack(query, link.company_id, user, {
      fromLocked: isClar ? link.sender_email : null,
      prefill: isClar ? link.prefill : null,
    });
    if (isClar && link.prefill) {
      pack.banner = 'We could not fully understand your email, so this form is the quick way to finish it — it is already filled with what we did understand. Or just reply to that email in your own words; both work.';
    }
    const packJson = JSON.stringify(pack).replace(/</g, '\\u003c');
    res.type('html').send(formPageHtml(req.params.token, packJson, user.name));
  } catch (err: any) {
    console.error('[form] page failed:', err);
    errorPage(res, 'Something went wrong opening the form.');
  }
});

async function resolveSubmit(req: Request) {
  const link = await loadFormLink(query, req.params.token);
  if (!link) return { error: 'This form link has expired. Open the form again from the app or a newer email.' };
  const user = await userForLink(link);
  if (!user) return { error: 'The account behind this link is no longer active.' };
  const body = req.body || {};
  const action = String(body.action || '');
  const fields = (body.fields && typeof body.fields === 'object') ? body.fields : {};
  let fromEmail = String(body.fromEmail || '').trim().toLowerCase();
  if (link.kind === 'clarification') fromEmail = link.sender_email.toLowerCase();
  const allowedFrom = [user.email.toLowerCase(), ...(user.altEmail ? [user.altEmail.toLowerCase()] : [])];
  if (!allowedFrom.includes(fromEmail)) {
    return { error: 'That From address is not one of your send-from emails. Add it in the app under My Settings first.' };
  }
  const pack = await buildFormPack(query, link.company_id, user);
  const composed = await validateAndCompose(query, link.company_id, user, fromEmail, action, fields, pack.canAssign);
  return { link, user, action, fields, fromEmail, composed };
}

router.post('/request-form/:token/preview', async (req: Request, res: Response) => {
  try {
    const r = await resolveSubmit(req);
    if ((r as any).error) return res.status(400).json({ ok: false, error: (r as any).error });
    if (!r.composed!.ok) return res.json({ ok: false, error: (r.composed as any).error });
    const out: any = { ok: true, subject: (r.composed as any).composed.subject, body: (r.composed as any).composed.body };
    // Broadcast cover ⓘ (Deepika 2026-11-01): the exact names the
    // bell will go to for the picked shift, from the same helper the
    // submit path uses — never a guess.
    const oc = (r.composed as any).openCover;
    if (r.action === 'cover' && oc && !oc.targetUserId) {
      try {
        const recips = await coverBroadcastRecipients(query, r.link!.company_id, r.user!.id, oc);
        out.recipients = recips.map((p) => p.name);
      } catch { /* the ⓘ list is a nicety; the preview itself must not fail */ }
    }
    res.json(out);
  } catch (err: any) {
    console.error('[form] preview failed:', err);
    res.status(500).json({ ok: false, error: 'Could not build the preview.' });
  }
});

router.post('/request-form/:token/submit', async (req: Request, res: Response) => {
  try {
    const r = await resolveSubmit(req);
    if ((r as any).error) return res.status(400).json({ ok: false, error: (r as any).error });
    if (!r.composed!.ok) return res.json({ ok: false, error: (r.composed as any).error });
    const c = (r.composed as any).composed;
    const isClar = r.link!.kind === 'clarification';
    const { rows } = await query(
      `INSERT INTO form_requests (company_id, user_id, from_email, action, fields, subject, body, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing') RETURNING *`,
      [r.link!.company_id, r.user!.id, r.fromEmail, r.action, JSON.stringify(r.fields), c.subject, c.body,
       isClar ? 'clarification' : 'form']
    );
    const row = rows[0];
    if (isClar) row.prefill = r.link!.prefill;
    const outcome = await processFormRequest(query, row);
    if (outcome.status === 'done') {
      return res.json({ ok: true, message: OUTCOME_MESSAGES[outcome.outcome || 'skipped'] || OUTCOME_MESSAGES.skipped });
    }
    if (outcome.status === 'queued') {
      return res.json({ ok: true, message: OUTCOME_MESSAGES.queued });
    }
    if (outcome.message) {
      return res.json({ ok: false, error: outcome.message });
    }
    return res.json({ ok: false, error: 'Your request could not be sent from that address. Check My Settings → "Emails I send from" in the app.' });
  } catch (err: any) {
    console.error('[form] submit failed:', err);
    res.status(500).json({ ok: false, error: 'Something went wrong sending your request. Please try again.' });
  }
});

export default router;
