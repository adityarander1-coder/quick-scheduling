// Session-offer notifications (Deepika 2026-11-04): when a scheduler
// offers a calendar session to people who volunteered on the session
// availability link (or everyone on the calendar), each recipient gets
// a bell in the app AND an email with a personal login-free link (one
// token per person, migration 081). The link lands on a confirmation
// page in routes/schedule.ts (GET/POST /session-offers/act/:token) —
// the button on the page accepts, never the link itself, so
// mail-scanner prefetching can't claim it. Best-effort throughout.

import { query } from '../db.js';
import { sendMail, escHtml } from './mailer.js';
import { notify, fmtDateLong } from './notify.js';

export async function sendSessionOfferNotifications(
  companyId: string,
  offer: { id: string; title: string; occDate: string; roleLabel: string; startTime: string | null },
  recipients: Array<{ userId: string; token: string }>
): Promise<void> {
  try {
    if (!recipients.length) return;
    const dateLong = fmtDateLong(offer.occDate);
    const timeBit = offer.startTime ? ` at ${offer.startTime.slice(0, 5)}` : '';
    const art = /^[aeiou]/i.test(offer.roleLabel) ? 'an' : 'a';
    const needsPhrase = `${art} ${offer.roleLabel}`;
    await notify({
      companyId,
      userIds: recipients.map((r) => r.userId),
      category: 'calendar',
      type: 'session_offer',
      title: `A session needs ${needsPhrase}: "${offer.title}" on ${dateLong}`,
      body: 'First to accept gets the session — use the link in your email, or open the app.',
      link: 'calendars',
      payload: { offerId: offer.id },
    });
    const { rows: users } = await query(
      `SELECT id, email, first_name AS "firstName" FROM users
       WHERE id = ANY($1) AND is_active = true`,
      [recipients.map((r) => r.userId)]
    );
    const byId = new Map(users.map((u: any) => [u.id, u]));
    const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
    for (const r of recipients) {
      const u: any = byId.get(r.userId);
      if (!u || !u.email) continue;
      const url = `${baseUrl}/api/schedule/session-offers/act/${r.token}`;
      const first = (u.firstName || 'there').split(' ')[0];
      const intro = `"${offer.title}" on ${dateLong}${timeBit} needs ${needsPhrase}. If you accept, the session is yours — first to accept gets it.`;
      try {
        await sendMail({
          to: u.email,
          subject: `A session needs ${needsPhrase}: "${offer.title}" on ${dateLong}`,
          text: `Hi ${first},\n\n${intro}\n\nAccept this session: ${url}\n\n— Quick Scheduling`,
          html: `<p>Hi ${escHtml(first)},</p><p>${escHtml(intro)}</p><p><a href="${url}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Accept this session</a></p><p>— Quick Scheduling</p>`,
        });
      } catch (err) {
        console.error('[sessionOfferEmails] send failed for a recipient:', err);
      }
    }
  } catch (err) {
    console.error('[sessionOfferEmails] failed:', err);
  }
}
