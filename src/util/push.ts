/**
 * Web push notifications (Phase 3, Deepika 2026-10-31).
 *
 * Delivery uses the standard Web Push protocol with VAPID keys from
 * the environment (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
 * VAPID_SUBJECT). The protocol itself is free — no per-message
 * provider, no background polling; a push is sent only when the
 * notification dispatcher in util/notify.ts settles an "instant"
 * notification for a user who has subscribed a device.
 *
 * When the keys are absent the whole channel is a no-op, so local
 * runs and a not-yet-configured deploy stay silent. Sending is
 * best-effort: failures are logged, subscriptions the push service
 * reports gone (404/410) are pruned, and nothing here ever throws
 * into the notification path.
 */
import webpush from 'web-push';
import { query } from '../db.js';

export interface PushPayload {
  title: string;
  body?: string;
  /** In-app path to open on click, e.g. /app.html#requests. */
  url?: string;
  tag?: string;
}

export interface PushResult { sent: number; pruned: number; failed: number; skipped: boolean }

let configured: boolean | null = null;

export function pushPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT
    || (process.env.PLATFORM_ALERT_EMAIL ? `mailto:${process.env.PLATFORM_ALERT_EMAIL}` : null);
  if (!pub || !priv || !subject) {
    configured = false;
    return configured;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    configured = true;
  } catch (e: any) {
    console.log(`[push] VAPID setup failed: ${e?.message || e}`);
    configured = false;
  }
  return configured;
}

type PushSub = { endpoint: string; p256dh: string; auth: string };
type Sender = (sub: PushSub, payloadJson: string) => Promise<void>;

async function defaultSender(sub: PushSub, payloadJson: string): Promise<void> {
  await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payloadJson
  );
}

let senderOverride: Sender | null = null;
/** Test seam: suites inject a fake push sender (no real push service). */
export function __setPushSenderForTests(fn: Sender | null): void {
  senderOverride = fn;
}

/** Send one push to every device the user has subscribed. Never throws. */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<PushResult> {
  const out: PushResult = { sent: 0, pruned: 0, failed: 0, skipped: false };
  try {
    if (!senderOverride && !pushConfigured()) { out.skipped = true; return out; }
    const { rows } = await query(
      'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
    if (!rows.length) { out.skipped = true; return out; }
    const send = senderOverride || defaultSender;
    const json = JSON.stringify({
      title: payload.title,
      body: payload.body || '',
      url: payload.url || '/app.html',
      tag: payload.tag || undefined,
    });
    for (const r of rows) {
      try {
        await send({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }, json);
        out.sent++;
        await query('UPDATE push_subscriptions SET last_seen_at = now() WHERE id = $1', [r.id]).catch(() => {});
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await query('DELETE FROM push_subscriptions WHERE id = $1', [r.id]).catch(() => {});
          out.pruned++;
          console.log(`[push] pruned dead subscription for user ${userId} (${code})`);
        } else {
          out.failed++;
          console.log(`[push] send failed for user ${userId}: ${e?.message || e}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`[push] sendPushToUser failed for ${userId}: ${e?.message || e}`);
    out.failed++;
  }
  return out;
}
