// Login-free action-link emails for shift requests (Deepika 2026-11-02).
//
// When a cover or swap request is created, the people being ASKED get
// an email with a personal link (one token per person, migration 074):
// cover recipients open it to pick the shift up, a swap partner opens
// it to agree or decline. The link lands on a confirmation page in
// routes/schedule.ts (GET/POST /requests/act/:token) — the button on
// the page is what acts, never the link itself, so mail-scanner
// prefetching can't claim a shift. This is an EXTRA door beside the
// bell + Requests tab; a failure here must never break the request,
// so everything is best-effort.

import crypto from 'crypto';
import { query } from '../db.js';
import { sendMail, escHtml } from './mailer.js';
import { fmtDateLong, deptApproverIds } from './notify.js';
import { assignmentRelevantDepartments } from './departmentAccess.js';

function displayName(u: any): string {
  const n = `${u.firstName || ''} ${u.lastName || ''}`.trim();
  return u.nickname || n || 'A team member';
}

export async function sendShiftRequestActionEmails(companyId: string, requestId: string): Promise<void> {
  try {
    const { rows } = await query(
      `SELECT sr.request_type AS "requestType", sr.status, sr.stage,
              sr.shift_id AS "shiftId", sr.their_shift_id AS "theirShiftId",
              sr.requester_id AS "requesterId", sr.target_user_id AS "targetUserId",
              s.date::text AS date, s.shift_type_id AS "shiftTypeId", st.name AS "shiftTypeName",
              ts.date::text AS "theirDate", tst.name AS "theirShiftTypeName",
              ru.first_name AS "reqFirst", ru.last_name AS "reqLast", ru.nickname AS "reqNick"
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN shift_types st ON st.id = s.shift_type_id
       JOIN users ru ON ru.id = sr.requester_id
       LEFT JOIN shifts ts ON ts.id = sr.their_shift_id
       LEFT JOIN shift_types tst ON tst.id = ts.shift_type_id
       WHERE sr.id = $1 AND sr.company_id = $2`,
      [requestId, companyId]
    );
    if (!rows.length) return;
    const r = rows[0];
    if (r.status !== 'pending') return;
    const requester = displayName({ firstName: r.reqFirst, lastName: r.reqLast, nickname: r.reqNick });

    // Who is being asked?
    let recipientIds: string[] = [];
    if (r.requestType === 'pickup') {
      if (r.targetUserId) {
        recipientIds = [r.targetUserId];
      } else {
        const { coverBroadcastRecipients } = await import('./requestForm.js');
        const recips = await coverBroadcastRecipients(query, companyId, r.requesterId, {
          date: r.date, shiftTypeId: r.shiftTypeId, shiftTypeName: r.shiftTypeName,
        });
        recipientIds = recips.map((p: any) => p.id);
      }
    } else if (r.requestType === 'swap' && r.stage === 'partner' && r.targetUserId) {
      recipientIds = [r.targetUserId];
    } else {
      return;
    }
    if (!recipientIds.length) return;

    const { rows: users } = await query(
      `SELECT id, email, first_name AS "firstName", last_name AS "lastName", nickname
       FROM users WHERE id = ANY($1) AND is_active = true`,
      [recipientIds]
    );
    const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
    const dateLong = fmtDateLong(r.date);

    for (const u of users) {
      if (!u.email) continue;
      const token = crypto.randomBytes(24).toString('hex');
      await query(
        'INSERT INTO shift_request_action_tokens (id, request_id, company_id, user_id, token) VALUES ($1, $2, $3, $4, $5)',
        [crypto.randomUUID(), requestId, companyId, u.id, token]
      );
      const url = `${baseUrl}/api/schedule/requests/act/${token}`;
      const first = (u.firstName || 'there').split(' ')[0];
      let subject: string, intro: string, button: string;
      if (r.requestType === 'pickup' && r.targetUserId) {
        subject = `${requester} asked you to cover ${r.shiftTypeName} on ${dateLong}`;
        intro = `${requester} asked you to cover their ${r.shiftTypeName} shift on ${dateLong}. If you pick it up, the shift is yours — you can also decline from the same page.`;
        button = 'Review the request';
      } else if (r.requestType === 'pickup') {
        subject = `${requester} needs cover for ${r.shiftTypeName} on ${dateLong}`;
        intro = `${requester} needs cover for their ${r.shiftTypeName} shift on ${dateLong}. First to pick it up gets it — the shift stays theirs until someone does.`;
        button = 'Pick up this shift';
      } else {
        subject = `${requester} proposed a swap — ${r.shiftTypeName} on ${dateLong}`;
        intro = `${requester} wants to swap their ${r.shiftTypeName} on ${dateLong} for your ${r.theirShiftTypeName} on ${fmtDateLong(r.theirDate)}. If you agree, it goes to the schedulers for final approval; if you decline, the request closes.`;
        button = 'Review the swap';
      }
      try {
        await sendMail({
          to: u.email,
          subject,
          text: `Hi ${first},\n\n${intro}\n\n${button}: ${url}\n\nYou can also answer in the app under Requests.\n\n— Quick Scheduling`,
          html: `<p>Hi ${escHtml(first)},</p><p>${escHtml(intro)}</p><p><a href="${url}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">${escHtml(button)}</a></p><p style="color:#666;font-size:13px">You can also answer in the app under Requests.</p><p>— Quick Scheduling</p>`,
        });
      } catch (err) {
        // One bad address (or mail not configured) must not stop the
        // other recipients; the token row above stays valid regardless.
        console.error('[requestActionEmails] send failed for a recipient:', err);
      }
    }
  } catch (err) {
    console.error('[requestActionEmails] failed:', err);
  }
}

// Approver action emails (Deepika 2026-11-03): the plain notification
// email an owner/scheduler gets ("N shift requests are waiting for a
// decision") carried no way to act, while her rule is that approvals
// must work FROM email. So approvers get their own per-request email
// with a "Review and decide" button landing on the same confirmation
// page (kind='approver' token, migration 075): pickup requests (an
// approver's Approve = they pick the shift up, exactly like the
// in-app Approve), share-link open pickups (Approve publishes the
// held shift for the requester), and swaps at the admin stage
// (Approve executes the agreed swap). Reject closes the request.
// Recipients mirror notifyShiftRequestApprovers: owners + schedulers
// with Edit access to the request's relevant departments, minus the
// requester and minus the person being asked (they get the asked
// email above). Best-effort throughout.
export async function sendShiftRequestApproverEmails(companyId: string, requestId: string, excludeUserId?: string): Promise<void> {
  try {
    const { rows } = await query(
      `SELECT sr.request_type AS "requestType", sr.status, sr.stage,
              sr.shift_id AS "shiftId", sr.their_shift_id AS "theirShiftId",
              sr.requester_id AS "requesterId", sr.target_user_id AS "targetUserId",
              s.date::text AS date, s.shift_type_id AS "shiftTypeId", st.name AS "shiftTypeName",
              ts.date::text AS "theirDate", tst.name AS "theirShiftTypeName",
              ru.first_name AS "reqFirst", ru.last_name AS "reqLast", ru.nickname AS "reqNick",
              tu.first_name AS "tgtFirst", tu.last_name AS "tgtLast", tu.nickname AS "tgtNick"
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN shift_types st ON st.id = s.shift_type_id
       JOIN users ru ON ru.id = sr.requester_id
       LEFT JOIN shifts ts ON ts.id = sr.their_shift_id
       LEFT JOIN shift_types tst ON tst.id = ts.shift_type_id
       LEFT JOIN users tu ON tu.id = sr.target_user_id
       WHERE sr.id = $1 AND sr.company_id = $2`,
      [requestId, companyId]
    );
    if (!rows.length) return;
    const r = rows[0];
    if (r.status !== 'pending') return;
    const applicable = r.requestType === 'pickup' || r.requestType === 'open_pickup'
      || (r.requestType === 'swap' && r.stage === 'admin');
    if (!applicable) return;

    const depts = await assignmentRelevantDepartments(
      [{ userId: r.requesterId, shiftTypeId: r.shiftTypeId }], companyId);
    const ids = new Set<string>();
    if (depts.length) {
      for (const d of depts) for (const id of await deptApproverIds(companyId, d)) ids.add(id);
    } else {
      for (const id of await deptApproverIds(companyId, null)) ids.add(id);
    }
    ids.delete(r.requesterId);
    if (r.targetUserId) ids.delete(r.targetUserId);
    if (excludeUserId) ids.delete(excludeUserId);
    if (!ids.size) return;

    const { rows: users } = await query(
      `SELECT id, email, first_name AS "firstName", last_name AS "lastName", nickname
       FROM users WHERE id = ANY($1) AND is_active = true`,
      [[...ids]]
    );
    const baseUrl = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
    const dateLong = fmtDateLong(r.date);
    const requester = displayName({ firstName: r.reqFirst, lastName: r.reqLast, nickname: r.reqNick });
    const target = r.targetUserId
      ? displayName({ firstName: r.tgtFirst, lastName: r.tgtLast, nickname: r.tgtNick }) : null;

    let subject: string, intro: string;
    if (r.requestType === 'pickup') {
      subject = `Decision needed: ${requester} requested pickup for ${r.shiftTypeName} on ${dateLong}`;
      intro = `${requester} asked ${target ? target : 'the team'} to pick up their ${r.shiftTypeName} shift on ${dateLong}. `
        + `As an approver you can decide from this email: approving means YOU pick up the shift; rejecting closes the request.`;
    } else if (r.requestType === 'open_pickup') {
      subject = `Decision needed: ${requester} wants to pick up ${r.shiftTypeName} on ${dateLong}`;
      intro = `${requester} asked to pick up the open ${r.shiftTypeName} shift on ${dateLong} (share link). `
        + `Approving publishes the shift for them; rejecting closes the request.`;
    } else {
      subject = `Decision needed: swap of ${r.shiftTypeName} on ${dateLong}`;
      intro = `${requester} and ${target || 'their swap partner'} agreed to swap ${r.shiftTypeName} on ${dateLong} `
        + `for ${r.theirShiftTypeName} on ${fmtDateLong(r.theirDate)}. Your approval executes the swap; rejecting closes the request.`;
    }

    for (const u of users) {
      if (!u.email) continue;
      const token = crypto.randomBytes(24).toString('hex');
      await query(
        'INSERT INTO shift_request_action_tokens (id, request_id, company_id, user_id, token, kind) VALUES ($1, $2, $3, $4, $5, $6)',
        [crypto.randomUUID(), requestId, companyId, u.id, token, 'approver']
      );
      const url = `${baseUrl}/api/schedule/requests/act/${token}`;
      const first = (u.firstName || 'there').split(' ')[0];
      try {
        await sendMail({
          to: u.email,
          subject,
          text: `Hi ${first},\n\n${intro}\n\nReview and decide: ${url}\n\nYou can also answer in the app under Requests.\n\n— Quick Scheduling`,
          html: `<p>Hi ${escHtml(first)},</p><p>${escHtml(intro)}</p><p><a href="${url}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Review and decide</a></p><p style="color:#666;font-size:13px">You can also answer in the app under Requests.</p><p>— Quick Scheduling</p>`,
        });
      } catch (err) {
        console.error('[requestActionEmails] approver send failed for a recipient:', err);
      }
    }
  } catch (err) {
    console.error('[requestActionEmails] approver emails failed:', err);
  }
}
