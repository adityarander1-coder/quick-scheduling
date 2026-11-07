// routes/integrations.ts — /api/integrations: per-company meeting
// services (Zoom / Microsoft Teams / Google Meet), connected ONCE by
// the owner via OAuth (Deepika, 2026-11-07). Tokens live in
// company_integrations (migration 091); the provider calls themselves
// live in util/meetingProviders.ts.
//
// A provider whose platform app credentials are missing from env is
// reported as configured:false and the UI shows "Not set up yet" —
// the connect endpoint refuses politely instead of erroring, so this
// is safe to ship before the platform apps are registered.

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  MEETING_PROVIDERS, MeetingProvider, isMeetingProvider, providerName,
  providerConfigured, authorizeUrl, adminConsentUrl, exchangeCode,
  fetchAccountLabel, getIntegration, saveIntegration, deleteIntegration,
  MeetingError,
} from '../util/meetingProviders.js';

const router = Router();
router.use(requireAuth);

function appBase(): string {
  return process.env.APP_URL || 'https://quick-scheduling.onrender.com';
}
function callbackUri(p: MeetingProvider): string {
  return `${appBase()}/api/integrations/${p}/callback`;
}
function settingsUrl(): string {
  return '/app.html#settings/meetings';
}

function paramProvider(req: Request, res: Response): MeetingProvider | null {
  const p = String(req.params.provider || '');
  if (!isMeetingProvider(p)) { res.status(404).json({ error: 'Unknown meeting service.' }); return null; }
  return p;
}

// GET /api/integrations — status for every provider (any role; the
// session form uses `connected`, Settings renders the full card).
router.get('/', async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const isOwner = req.session.role === 'owner';
    const { rows } = await query(
      `SELECT i.provider, i.account_label, i.created_at, i.updated_at,
              (u.first_name || ' ' || u.last_name) AS connected_by_name
       FROM company_integrations i LEFT JOIN users u ON u.id = i.connected_by
       WHERE i.company_id = $1`, [companyId]);
    const byProvider = new Map(rows.map((r: any) => [r.provider, r]));
    const providers = MEETING_PROVIDERS.map((p) => {
      const row: any = byProvider.get(p);
      return {
        provider: p,
        name: providerName(p),
        configured: providerConfigured(p),
        connected: !!row,
        accountLabel: row ? row.account_label || null : null,
        connectedByName: isOwner && row ? row.connected_by_name || null : null,
        connectedAt: row ? row.created_at : null,
        canManage: isOwner,
        adminConsentUrl: isOwner ? adminConsentUrl(p, callbackUri(p)) : null,
      };
    });
    const flash = (req.session as any).meetFlash || null;
    if (flash) delete (req.session as any).meetFlash;
    res.json({ ok: true, providers, flash });
  } catch (err) {
    console.error('[integrations] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/integrations/:provider/connect — owner only. Starts the
// provider's OAuth flow; the callback lands back here.
router.get('/:provider/connect', requireRole('owner'), (req: Request, res: Response) => {
  const p = paramProvider(req, res);
  if (!p) return;
  if (!providerConfigured(p)) {
    (req.session as any).meetFlash = `${providerName(p)} is not set up yet — the platform app still has to be registered.`;
    res.redirect(settingsUrl());
    return;
  }
  const state = crypto.randomBytes(24).toString('hex');
  (req.session as any).oauthState = state;
  (req.session as any).oauthProvider = p;
  res.redirect(authorizeUrl(p, callbackUri(p), state));
});

// GET /api/integrations/:provider/callback — exchanges the code and
// stores the tokens, then returns to Settings → Meeting services.
router.get('/:provider/callback', async (req: Request, res: Response) => {
  const p = paramProvider(req, res);
  if (!p) return;
  const sess: any = req.session;
  try {
    const state = String(req.query.state || '');
    if (!state || !sess.oauthState || state !== sess.oauthState || sess.oauthProvider !== p) {
      sess.meetFlash = `That ${providerName(p)} sign-in didn't check out. Please try connecting again.`;
      res.redirect(settingsUrl());
      return;
    }
    delete sess.oauthState;
    delete sess.oauthProvider;
    if (req.query.error) {
      const desc = String(req.query.error_description || req.query.error || '').slice(0, 300);
      sess.meetFlash = /consent/i.test(desc)
        ? `${providerName(p)} needs your company's Microsoft admin to approve the connection first. Use the admin approval link on this page, then connect again.`
        : `${providerName(p)} sign-in was cancelled or failed. ${desc}`.trim();
      res.redirect(settingsUrl());
      return;
    }
    const code = String(req.query.code || '');
    if (!code) {
      sess.meetFlash = `${providerName(p)} didn't send back a sign-in code. Please try again.`;
      res.redirect(settingsUrl());
      return;
    }
    const tokens = await exchangeCode(p, code, callbackUri(p));
    const label = await fetchAccountLabel(p, tokens);
    await saveIntegration(req.session.companyId!, p, tokens, req.session.userId!, label);
    sess.meetFlash = `${providerName(p)} is connected${label ? ` as ${label}` : ''}. The meeting buttons in the event form now work for your whole team.`;
    res.redirect(settingsUrl());
  } catch (err) {
    console.error(`[integrations] ${p} callback failed:`, err);
    sess.meetFlash = err instanceof MeetingError
      ? err.message
      : `Something went wrong connecting ${providerName(p)}. Please try again.`;
    res.redirect(settingsUrl());
  }
});

// DELETE /api/integrations/:provider — owner only; forgets the tokens.
// Sessions keep their links as plain (pasted-style) links; meetings
// already created at the provider are left as they are there.
router.delete('/:provider', requireRole('owner'), async (req: Request, res: Response) => {
  const p = paramProvider(req, res);
  if (!p) return;
  try {
    await deleteIntegration(req.session.companyId!, p);
    res.json({ ok: true });
  } catch (err) {
    console.error('[integrations] disconnect failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
