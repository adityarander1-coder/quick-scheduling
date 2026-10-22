// routes/notifications.ts — /api/notifications (Phase 1, 2026-10-22).
// The signed-in user's own notification inbox + preferences, and the
// owner's company-wide default speeds. Company scoping always comes
// from the session; a user can only ever see their own notifications.

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { NOTIF_CATEGORIES, NotifSpeed } from '../util/notify.js';

const router = Router();
router.use(requireAuth);

const SPEEDS: NotifSpeed[] = ['instant', 'digest', 'off'];

function publicNotif(r: any) {
  return {
    id: r.id,
    category: r.category,
    type: r.type,
    title: r.title,
    body: r.body,
    link: r.link,
    payload: r.payload || {},
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

// GET /api/notifications — my latest notifications + unread count.
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT * FROM notifications WHERE user_id = $1 AND company_id = $2
       ORDER BY created_at DESC LIMIT 50`,
      [userId, companyId]
    );
    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND company_id = $2 AND read_at IS NULL`,
      [userId, companyId]
    );
    res.json({ notifications: rows.map(publicNotif), unread: cnt[0].n });
  } catch (err) {
    console.error('[notifications] list failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/notifications/unread-count
router.get('/unread-count', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const companyId = req.session.companyId!;
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND company_id = $2 AND read_at IS NULL`,
      [userId, companyId]
    );
    res.json({ count: rows[0].n });
  } catch (err) {
    console.error('[notifications] count failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const companyId = req.session.companyId!;
    await query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND company_id = $2 AND read_at IS NULL`,
      [userId, companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read-all failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const companyId = req.session.companyId!;
    await query(
      `UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND company_id = $3`,
      [req.params.id, userId, companyId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] read failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

async function loadPrefs(userId: string, companyId: string) {
  const { rows: mine } = await query('SELECT category, speed FROM notification_prefs WHERE user_id = $1', [userId]);
  const { rows: comp } = await query('SELECT category, speed FROM notification_defaults WHERE company_id = $1', [companyId]);
  const mineMap = new Map(mine.map((r: any) => [r.category, r.speed]));
  const compMap = new Map(comp.map((r: any) => [r.category, r.speed]));
  const categories = NOTIF_CATEGORIES.map((category) => ({
    category,
    mine: mineMap.get(category) || null,
    companyDefault: compMap.get(category) || null,
    effective: mineMap.get(category) || compMap.get(category) || 'instant',
  }));
  return { categories, companyDefaults: Object.fromEntries(compMap) };
}

// GET /api/notifications/prefs — my speeds + the company defaults.
router.get('/prefs', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const companyId = req.session.companyId!;
    res.json(await loadPrefs(userId, companyId));
  } catch (err) {
    console.error('[notifications] prefs failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/notifications/prefs — set/clear my per-category speeds.
// Body: { prefs: { schedule: 'instant'|'digest'|'off'|null, ... } }
router.put('/prefs', async (req: Request, res: Response) => {
  try {
    const userId = (req.session as any).userId;
    const prefs = (req.body && req.body.prefs) || {};
    for (const category of NOTIF_CATEGORIES) {
      if (!(category in prefs)) continue;
      const speed = prefs[category];
      if (speed === null) {
        await query('DELETE FROM notification_prefs WHERE user_id = $1 AND category = $2', [userId, category]);
      } else if (SPEEDS.includes(speed)) {
        await query(
          `INSERT INTO notification_prefs (user_id, category, speed) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, category) DO UPDATE SET speed = $3`,
          [userId, category, speed]
        );
      } else {
        res.status(400).json({ error: `Invalid speed for ${category}.` });
        return;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] save prefs failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// PUT /api/notifications/company-defaults — owner only.
// Body: { defaults: { schedule: 'instant'|'digest'|'off'|null, ... } }
router.put('/company-defaults', requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const companyId = req.session.companyId!;
    const defaults = (req.body && req.body.defaults) || {};
    for (const category of NOTIF_CATEGORIES) {
      if (!(category in defaults)) continue;
      const speed = defaults[category];
      if (speed === null) {
        await query('DELETE FROM notification_defaults WHERE company_id = $1 AND category = $2', [companyId, category]);
      } else if (SPEEDS.includes(speed)) {
        await query(
          `INSERT INTO notification_defaults (company_id, category, speed) VALUES ($1, $2, $3)
           ON CONFLICT (company_id, category) DO UPDATE SET speed = $3`,
          [companyId, category, speed]
        );
      } else {
        res.status(400).json({ error: `Invalid speed for ${category}.` });
        return;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[notifications] save defaults failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
