// routes/inbound.ts — in-app mailbox webhook (Option E).
// The mail-receiving service POSTs each message here. This is NOT a user
// session route: authentication is the shared webhook secret
// (INBOUND_WEBHOOK_SECRET env, header x-inbound-secret). Fail closed:
// with no secret configured, every call is rejected, so the endpoint can
// never be an open relay into the schedule engine.
// Mounted BEFORE the billing write gate: inbound mail must not be blocked
// by a company's billing state (a suspended company simply gets no plans
// from its own pipeline — but the webhook itself must stay reachable so
// rejects are recorded, not retried forever).

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { handleInboundEmail } from '../util/inboundMail.js';

const router = Router();

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// POST /api/inbound/email — one message from the mail receiver.
// Body: { to, from, subject?, body?, message_id? }.
// Rejects and duplicates still return 200: the provider must not retry
// mail that will never process. Only auth failures are 401.
router.post('/email', async (req: Request, res: Response) => {
  try {
    const secret = process.env.INBOUND_WEBHOOK_SECRET || '';
    const given = String(req.headers['x-inbound-secret'] || '');
    if (!secret || !given || !secretsEqual(given, secret)) {
      res.status(401).json({ error: 'Unauthorized.' });
      return;
    }
    const { to, from, subject, body, message_id } = req.body ?? {};
    if (!to || !from) {
      res.status(400).json({ error: 'to and from are required.' });
      return;
    }
    const result = await handleInboundEmail({
      to: String(to), from: String(from),
      subject: subject !== undefined ? String(subject) : '',
      body: body !== undefined ? String(body) : '',
      messageId: message_id !== undefined ? String(message_id) : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[inbound] webhook failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

export default router;
