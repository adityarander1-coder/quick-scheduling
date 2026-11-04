// Gap-offer notifications (Deepika 2026-11-04): when a scheduler offers
// a Short cover gap to staff who marked themselves available, each
// recipient gets a bell in the app AND an email with a personal
// login-free link (one token per person, migration 079). The link
// lands on a confirmation page in routes/schedule.ts
// (GET/POST /gap-offers/act/:token) — the button on the page claims
// the shift, never the link itself, so mail-scanner prefetching can't
// claim it. Best-effort throughout: a mail failure must never break
// the offer.

import { query } from '../db.js';
import { sendMail, escHtml } from './mailer.js';
import { notify, fmtDateLong } from './notify.js';

export async function sendGapOfferNotifications(
  companyId: string,
  offer: { id: string; date: string; shiftTypeName: string },
  recipients: Array<{ userId: string; token: string }>
): Promise<void> {
  try {
    if (!recipients.length) return;
    const dateLong = fmtDateLong(offer.date);
    // Bell for everyone offered (news for them — they haven't acted).
    await notify({
      companyId,
      userIds: recipients.map((r) => r.userId),
      category: 'schedule',
      type: 'gap_offer',
      title: `Short cover needed: ${offer.shiftTypeName} on ${dateLong}`,
      body: 'You marked yourself available for this day. First to pick it up gets the shift — use the link in your email, or open the app.',
      link: 'myschedule',
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
      const url = `${baseUrl}/api/schedule/gap-offers/act/${r.token}`;
      const first = (u.firstName || 'there').split(' ')[0];
      const intro = `A ${offer.shiftTypeName} shift on ${dateLong} is short of cover, and you marked yourself available for that day. If you pick it up, the shift is yours — first to pick it up gets it.`;
      try {
        await sendMail({
          to: u.email,
          subject: `Short cover needed: ${offer.shiftTypeName} on ${dateLong}`,
          text: `Hi ${first},\n\n${intro}\n\nPick up this shift: ${url}\n\n— Quick Scheduling`,
          html: `<p>Hi ${escHtml(first)},</p><p>${escHtml(intro)}</p><p><a href="${url}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Pick up this shift</a></p><p>— Quick Scheduling</p>`,
        });
      } catch (err) {
        console.error('[gapOfferEmails] send failed for a recipient:', err);
      }
    }
  } catch (err) {
    console.error('[gapOfferEmails] failed:', err);
  }
}
