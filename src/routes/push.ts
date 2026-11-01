// routes/push.ts — /api/push (Phase 3 web push, 2026-10-31).
// The signed-in user's own device subscriptions. Company + user always
// come from the session; a subscription can only ever belong to the
// user who created it, and unsubscribing only ever touches their own.

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { pushConfigured, pushPublicKey } from '../util/push.js';

const router = Router();
router.use(requireAuth);

// GET /api/push/status — is push enabled on this server, and how many
// devices has this user subscribed?
router.get('/status', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId]);
    res.json({ enabled: pushConfigured(), publicKey: pushPublicKey(), devices: rows[0].n });
  } catch (err) {
    console.error('[push] status failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/push/subscribe { endpoint, keys: { p256dh, auth } }
router.post('/subscribe', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const companyId = req.session.companyId!;
    const { endpoint, keys } = (req.body || {}) as any;
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;
    if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024
      || typeof p256dh !== 'string' || !p256dh || p256dh.length > 256
      || typeof auth !== 'string' || !auth || auth.length > 256) {
      return res.status(400).json({ error: 'Invalid subscription.' });
    }
    // An endpoint belongs to whoever subscribes it most recently —
    // browsers hand the same endpoint to a different signed-in user on
    // a shared device, so ownership follows the latest subscribe.
    await query(
      `INSERT INTO push_subscriptions (company_id, user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE SET
         company_id = EXCLUDED.company_id, user_id = EXCLUDED.user_id,
         p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
         user_agent = EXCLUDED.user_agent, last_seen_at = now()`,
      [companyId, userId, endpoint, p256dh, auth, String(req.headers['user-agent'] || '').slice(0, 300) || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] subscribe failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/push/unsubscribe { endpoint }
router.post('/unsubscribe', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const { endpoint } = (req.body || {}) as any;
    if (typeof endpoint !== 'string' || !endpoint) {
      return res.status(400).json({ error: 'Invalid subscription.' });
    }
    await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[push] unsubscribe failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
