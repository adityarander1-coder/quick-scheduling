// util/platformAlert.ts — platform outage alerts for Gemini billing
// failures (Deepika's ruling, 2026-10-31).
//
// The AI is platform-paid (inside the flat per-company price; customer
// companies do not pay for Gemini), so an AI credit outage is the
// PLATFORM's failure and the PLATFORM's job to fix. Customers must
// never get our backlog as homework: their emails and tasks simply
// wait, and the only alert goes to us — exactly ONE per outage
// episode, plus one "restored" note when the episode closes.
//
// An EPISODE opens at the first billing-class Gemini failure
// (isBillingError, planHelpers.ts) and closes at the first Gemini
// call that succeeds again. Calls into noteGeminiBillingFailure /
// noteGeminiSuccess come from the Gemini call layer (util/gemini.ts),
// so every AI surface — email plans, in-app Task/Ask, help,
// onboarding — feeds the same episode.
//
// Episode state lives in the platform_state table (migration 069):
// one row, key 'gemini_outage_episode', present ⇔ an alerted episode
// is open. It is durable across restarts — a deploy mid-outage must
// not re-alert. Claiming/closing is done with single-statement
// INSERT … ON CONFLICT DO NOTHING / DELETE … RETURNING, so concurrent
// calls can never double-send: only the caller whose statement
// actually wrote the row owns the send.
//
// Recipient: the PLATFORM_ALERT_EMAIL env var. When it is unset the
// alert is NOT sent — the full alert is written to the server log as
// a loud [platform-alert] line instead, and the episode bookkeeping
// proceeds exactly the same (one log line per episode, not per
// failure). No address is ever hardcoded here.
//
// Everything in this module is best-effort: alerting must never break
// or block an AI call, so no function here ever throws.

import { query } from '../db.js';
import { sendMail, escHtml } from './mailer.js';

const EPISODE_KEY = 'gemini_outage_episode';

interface OutageEpisode {
  /** When the episode's first billing failure was seen (ISO). */
  firstSeenAt: string;
  /** The first failure's error text, quoted in the alert (truncated). */
  lastError: string;
}

function parseEpisode(value: unknown): OutageEpisode | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const o = JSON.parse(value);
    if (!o || typeof o.firstSeenAt !== 'string') return null;
    return { firstSeenAt: o.firstSeenAt, lastError: String(o.lastError || '') };
  } catch {
    return null;
  }
}

/** "about 2h 5m" / "about 12m" / "under a minute" — operator prose. */
function episodeDuration(fromIso: string, to: Date): string {
  const ms = to.getTime() - new Date(fromIso).getTime();
  if (!isFinite(ms) || ms < 60_000) return 'under a minute';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `about ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `about ${h}h ${m}m` : `about ${h}h`;
}

/**
 * Deliver one platform alert (or its recovery counterpart). Returns
 * nothing; failures are logged. With no PLATFORM_ALERT_EMAIL the
 * alert content goes to the log as a [platform-alert] line — the
 * feature stays observable-but-inert until the env var is set.
 */
async function deliverAlert(subject: string, text: string): Promise<void> {
  const to = (process.env.PLATFORM_ALERT_EMAIL || '').trim();
  if (!to) {
    console.log(`[platform-alert] (PLATFORM_ALERT_EMAIL unset — not sent) ${subject}\n${text}`);
    return;
  }
  try {
    await sendMail({
      to,
      subject,
      text,
      html: `<pre style="font-family:sans-serif;white-space:pre-wrap;">${escHtml(text)}</pre>`,
    });
    console.log(`[platform-alert] sent "${subject}" to ${to}`);
  } catch (e: any) {
    console.log(`[platform-alert] could not send "${subject}" to ${to}: ${e.message}`);
  }
}

/**
 * Note a billing-class Gemini failure. The FIRST failure of an
 * episode claims the episode row and sends the one outage alert;
 * later failures in the same episode do nothing. Never throws.
 */
export async function noteGeminiBillingFailure(errorText: string): Promise<void> {
  try {
    const episode: OutageEpisode = {
      firstSeenAt: new Date().toISOString(),
      lastError: String(errorText || 'Unknown billing error.').slice(0, 500),
    };
    // Claim the episode: only the caller whose INSERT lands owns the
    // alert. Concurrent failures race here and exactly one wins.
    const { rows } = await query(
      `INSERT INTO platform_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [EPISODE_KEY, JSON.stringify(episode)]
    );
    if (!rows.length) return; // episode already open — already alerted
    console.log(`[platform-alert] Gemini billing outage episode opened (first seen ${episode.firstSeenAt}): ${episode.lastError}`);
    await deliverAlert(
      '[Quick Scheduling] AI service outage — Gemini billing',
      [
        `The Gemini AI service is failing with a billing error, first seen ${episode.firstSeenAt}.`,
        ``,
        `Error: ${episode.lastError}`,
        ``,
        `Customer schedule emails and in-app AI tasks are waiting and will process automatically once the service recovers. No customer action is needed, and customers have not been notified or given anything to do.`,
        ``,
        `Action: top up the Gemini prepay balance in AI Studio on the platform billing account. A follow-up email will confirm when the service is restored.`,
      ].join('\n')
    );
  } catch (e: any) {
    console.log(`[platform-alert] outage bookkeeping failed: ${e.message}`);
  }
}

/**
 * Note a successful Gemini call. If an alerted episode is open, this
 * closes it and sends the one "restored" email; with no open episode
 * it is a no-op (one DELETE that matches nothing). Never throws.
 */
export async function noteGeminiSuccess(): Promise<void> {
  try {
    const { rows } = await query(
      `DELETE FROM platform_state WHERE key = $1 RETURNING value`,
      [EPISODE_KEY]
    );
    if (!rows.length) return; // no open episode
    const episode = parseEpisode(rows[0].value);
    const now = new Date();
    const firstSeen = episode?.firstSeenAt || 'an unknown time';
    const duration = episode ? episodeDuration(episode.firstSeenAt, now) : 'an unknown duration';
    console.log(`[platform-alert] Gemini outage episode closed (first seen ${firstSeen}, lasted ${duration}).`);
    await deliverAlert(
      '[Quick Scheduling] AI service restored',
      `Gemini calls are succeeding again. The outage that began ${firstSeen} lasted ${duration}. Waiting customer emails and tasks will process automatically — no action is needed.`
    );
  } catch (e: any) {
    console.log(`[platform-alert] recovery bookkeeping failed: ${e.message}`);
  }
}
