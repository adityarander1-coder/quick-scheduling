// util/sessionPeople.ts — the calendar EVENT model's people: SPEAKERS
// (any number of team members and/or guests) and BENEFICIARIES
// (departments and/or specific people who attend the event).
// (Deepika, 2026-11-07; migration 087.)
//
// Rules that keep the rest of the app working untouched:
// - academic_sessions.lecturer_user_id mirrors Speaker 1 when Speaker 1
//   is a team member; it is NULL when Speaker 1 is a guest or there are
//   no speakers. My Schedule, the calendar feed, offers and Ask read
//   the mirror; displays that need the full list read session_speakers.
// - A guest speaker is a row with user_id NULL + guest_name (+ optional
//   guest_email). Guests have no account, never appear in team pickers,
//   and get no My Schedule entry — but a guest-led event still counts
//   as HAVING a speaker everywhere gaps are computed.
// - Beneficiaries only ever ADD viewers/attendees; a session with no
//   beneficiary rows keeps the calendar audience rules it always had.

import crypto from 'node:crypto';
import { query } from '../db.js';
import { sendMail, escHtml } from './mailer.js';
import { fmtDateLong } from './notify.js';

export interface SpeakerInput {
  userId?: string | null;
  guestName?: string | null;
  guestEmail?: string | null;
}

export interface SpeakerRow {
  userId: string | null;
  name: string | null;
  guest: boolean;
  guestEmail: string | null;
}

type Q = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

/** Normalize + validate a posted speakers list. Team ids must be
 *  active members of the company; a guest row needs a name (an email
 *  without a name is an error, never silently dropped). Duplicate team
 *  members keep their first position. Returns speakers in order. */
export async function cleanSpeakers(q: Q, companyId: string, raw: any): Promise<{ speakers: SpeakerInput[] } | { error: string }> {
  if (raw === undefined || raw === null) return { speakers: [] };
  if (!Array.isArray(raw)) return { error: 'Speakers must be a list.' };
  const out: SpeakerInput[] = [];
  const seenUsers = new Set<string>();
  for (const item of raw.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const userId = item.userId ? String(item.userId) : null;
    const guestName = item.guestName ? String(item.guestName).trim().slice(0, 120) : '';
    const guestEmail = item.guestEmail ? String(item.guestEmail).trim().slice(0, 200) : '';
    if (userId) {
      if (seenUsers.has(userId)) continue;
      const { rows } = await q('SELECT id FROM users WHERE id = $1 AND company_id = $2 AND is_active = true', [userId, companyId]);
      if (!rows.length) return { error: 'A speaker is not an active team member.' };
      seenUsers.add(userId);
      out.push({ userId });
    } else if (guestName || guestEmail) {
      if (!guestName) return { error: 'A guest speaker needs a name.' };
      if (guestEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) return { error: `That guest email does not look right: ${guestEmail}` };
      out.push({ guestName, guestEmail: guestEmail || null });
    }
    // Fully empty rows are ignored (a blank extra row in the form).
  }
  return { speakers: out };
}

/** The lecturer mirror for a speakers list: Speaker 1's user id when
 *  Speaker 1 is a team member, else NULL. */
export function speakerMirror(speakers: SpeakerInput[]): string | null {
  return speakers.length && speakers[0].userId ? String(speakers[0].userId) : null;
}

/** Replace a session's speaker rows with the given list (in order). */
export async function saveSpeakers(q: Q, sessionId: string, speakers: SpeakerInput[]): Promise<void> {
  await q('DELETE FROM session_speakers WHERE session_id = $1', [sessionId]);
  let pos = 1;
  for (const s of speakers) {
    await q(
      'INSERT INTO session_speakers (id, session_id, user_id, guest_name, guest_email, position) VALUES ($1,$2,$3,$4,$5,$6)',
      [crypto.randomUUID(), sessionId, s.userId || null, s.userId ? null : (s.guestName || null), s.userId ? null : (s.guestEmail || null), pos++]);
  }
}

/** Speakers for many sessions at once: series id -> ordered rows with
 *  display names resolved (team names from users, guests from the row). */
export async function loadSpeakers(q: Q, sessionIds: string[]): Promise<Map<string, SpeakerRow[]>> {
  const map = new Map<string, SpeakerRow[]>();
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return map;
  const { rows } = await q(
    `SELECT sp.session_id, sp.user_id, sp.guest_name, sp.guest_email, sp.position,
            u.first_name, u.last_name
     FROM session_speakers sp
     LEFT JOIN users u ON u.id = sp.user_id
     WHERE sp.session_id = ANY($1::uuid[])
     ORDER BY sp.session_id, sp.position, sp.created_at`,
    [ids]);
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, []);
    map.get(r.session_id)!.push({
      userId: r.user_id || null,
      name: r.user_id ? ([r.first_name, r.last_name].filter(Boolean).join(' ') || null) : (r.guest_name || null),
      guest: !r.user_id,
      guestEmail: r.user_id ? null : (r.guest_email || null),
    });
  }
  return map;
}

/** Series ids (of the given set) that have at least one speaker row. */
export async function sessionsWithSpeakers(q: Q, sessionIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(sessionIds.filter(Boolean))];
  const out = new Set<string>();
  if (!ids.length) return out;
  const { rows } = await q('SELECT DISTINCT session_id FROM session_speakers WHERE session_id = ANY($1::uuid[])', [ids]);
  for (const r of rows) out.add(r.session_id);
  return out;
}

/** Validate beneficiary id lists against the company. */
export async function cleanBeneficiaries(
  q: Q, companyId: string, deptRaw: any, userRaw: any
): Promise<{ departmentIds: string[]; userIds: string[] } | { error: string }> {
  const deptIds = Array.isArray(deptRaw) ? [...new Set(deptRaw.map((x: any) => String(x)).filter(Boolean))] : [];
  const userIds = Array.isArray(userRaw) ? [...new Set(userRaw.map((x: any) => String(x)).filter(Boolean))] : [];
  if (deptIds.length) {
    const { rows } = await q('SELECT id FROM departments WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, deptIds]);
    if (rows.length !== deptIds.length) return { error: 'An attendee department could not be found.' };
  }
  if (userIds.length) {
    const { rows } = await q('SELECT id FROM users WHERE company_id = $1 AND is_active = true AND id = ANY($2::uuid[])', [companyId, userIds]);
    if (rows.length !== userIds.length) return { error: 'An attendee is not an active team member.' };
  }
  return { departmentIds: deptIds, userIds };
}

/** Replace a session's beneficiary rows. */
export async function saveBeneficiaries(q: Q, sessionId: string, departmentIds: string[], userIds: string[]): Promise<void> {
  await q('DELETE FROM session_beneficiary_departments WHERE session_id = $1', [sessionId]);
  await q('DELETE FROM session_beneficiary_users WHERE session_id = $1', [sessionId]);
  for (const d of departmentIds) {
    await q('INSERT INTO session_beneficiary_departments (session_id, department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sessionId, d]);
  }
  for (const u of userIds) {
    await q('INSERT INTO session_beneficiary_users (session_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [sessionId, u]);
  }
}

/** Beneficiaries for many sessions: series id -> {departmentIds, userIds}. */
export async function loadBeneficiaries(q: Q, sessionIds: string[]): Promise<Map<string, { departmentIds: string[]; userIds: string[] }>> {
  const map = new Map<string, { departmentIds: string[]; userIds: string[] }>();
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return map;
  const get = (id: string) => {
    if (!map.has(id)) map.set(id, { departmentIds: [], userIds: [] });
    return map.get(id)!;
  };
  const { rows: drows } = await q('SELECT session_id, department_id FROM session_beneficiary_departments WHERE session_id = ANY($1::uuid[])', [ids]);
  for (const r of drows) get(r.session_id).departmentIds.push(r.department_id);
  const { rows: urows } = await q('SELECT session_id, user_id FROM session_beneficiary_users WHERE session_id = ANY($1::uuid[])', [ids]);
  for (const r of urows) get(r.session_id).userIds.push(r.user_id);
  return map;
}

/**
 * The distinct invited (beneficiary) user ids per session: named
 * individuals plus the current active members of each beneficiary
 * department. A person named AND in a beneficiary department counts
 * once. Guest speakers have no account and are never invited ids.
 */
export async function loadInvitedUserIds(q: Q, companyId: string, sessionIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  const ids = [...new Set(sessionIds.filter(Boolean))];
  if (!ids.length) return map;
  const { rows } = await q(
    `SELECT b.session_id, u.id AS user_id
     FROM (
       SELECT session_id, user_id FROM session_beneficiary_users WHERE session_id = ANY($1::uuid[])
       UNION
       SELECT bd.session_id, u2.id FROM session_beneficiary_departments bd
         JOIN users u2 ON u2.department_id = bd.department_id AND u2.company_id = $2 AND u2.is_active = true
         WHERE bd.session_id = ANY($1::uuid[])
     ) b
     JOIN users u ON u.id = b.user_id AND u.company_id = $2 AND u.is_active = true`,
    [ids, companyId]);
  for (const r of rows) {
    if (!map.has(r.session_id)) map.set(r.session_id, []);
    map.get(r.session_id)!.push(r.user_id);
  }
  return map;
}

/** Human description of a recurrence for the guest email. */
export function describeRecur(s: { recurRule?: string | null; recurInterval?: number | null; recurDays?: number[] | string | null; recurUntil?: any; recurCount?: number | null }): string | null {
  const rule = s.recurRule || 'none';
  if (!rule || rule === 'none') return null;
  const interval = Math.max(1, s.recurInterval || 1);
  let what = '';
  if (rule === 'daily') what = interval > 1 ? `repeats every ${interval} days` : 'repeats daily';
  else if (rule === 'weekly') {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    let days: number[] = [];
    if (Array.isArray(s.recurDays)) days = s.recurDays;
    else if (typeof s.recurDays === 'string' && s.recurDays) days = s.recurDays.split(',').map((x) => parseInt(x, 10)).filter((n) => !isNaN(n));
    const on = days.length ? ` on ${days.map((d) => dayNames[d]).join(', ')}` : '';
    what = (interval > 1 ? `repeats every ${interval} weeks` : 'repeats weekly') + on;
  }
  else if (rule === 'monthly') what = interval > 1 ? `repeats every ${interval} months` : 'repeats monthly';
  else if (rule === 'monthly-weekday') what = (interval > 1 ? `repeats every ${interval} months` : 'repeats monthly') + ' on the same weekday';
  else if (rule === 'yearly') what = interval > 1 ? `repeats every ${interval} years` : 'repeats yearly';
  else what = 'repeats';
  if (s.recurCount) what += `, ${s.recurCount} times`;
  else if (s.recurUntil) {
    const u = s.recurUntil instanceof Date ? s.recurUntil.toISOString().slice(0, 10) : String(s.recurUntil).slice(0, 10);
    what += `, until ${fmtDateLong(u)}`;
  }
  return what.charAt(0).toUpperCase() + what.slice(1) + '.';
}

export interface GuestMailContext {
  companyId: string;
  companyName: string;
  saverName: string;
  dashboardName: string | null;
  departmentName: string | null;
  title: string;
  date: string; // YYYY-MM-DD (first date)
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  meetingUrl: string | null;
  recurText: string | null;
}

/** Email each given guest ONE message with the event details. Best
 *  effort: failures are logged, never thrown — a mail problem must not
 *  fail the save that triggered it. */
export async function emailGuests(guests: SpeakerInput[], ctx: GuestMailContext): Promise<void> {
  for (const g of guests) {
    const to = (g.guestEmail || '').trim();
    if (!to) continue;
    try {
      const when = `${fmtDateLong(ctx.date)}${ctx.startTime ? ` at ${String(ctx.startTime).slice(0, 5)}` : ''}${ctx.endTime ? ` – ${String(ctx.endTime).slice(0, 5)}` : ''}`;
      const lines = [
        `Hello ${g.guestName || 'there'},`,
        '',
        `You have been invited to speak at "${ctx.title}"${ctx.dashboardName ? ` on the ${ctx.dashboardName} calendar` : ''} at ${ctx.companyName}.`,
        '',
        `When: ${when}`,
        ...(ctx.recurText ? [`Repeats: ${ctx.recurText}`] : []),
        ...(ctx.location ? [`Where: ${ctx.location}`] : []),
        ...(ctx.meetingUrl ? [`Meeting link: ${ctx.meetingUrl}`] : []),
        ...(ctx.departmentName ? [`Organized by: ${ctx.departmentName} department`] : []),
        '',
        `${ctx.saverName} at ${ctx.companyName} added you as a guest speaker. If the time does not work, just reply to this email.`,
      ];
      const htmlLines = lines.map((l) => l ? `<p style="margin:0 0 8px">${escHtml(l)}</p>` : '').join('');
      await sendMail({
        to,
        subject: `You're speaking at "${ctx.title}" — ${fmtDateLong(ctx.date)}`,
        text: lines.join('\n'),
        html: `<div style="font-family:Arial,sans-serif;color:#102d47;max-width:560px">${htmlLines}</div>`,
      });
    } catch (e: any) {
      console.error('[sessionPeople] guest email failed:', e?.message || e);
    }
  }
}

/** Guests (with emails) in `next` whose email is not among `prev`'s
 *  guests — the newly-added set an edit should email. */
export function newlyAddedGuests(prev: SpeakerInput[], next: SpeakerInput[]): SpeakerInput[] {
  const prevEmails = new Set(prev.filter((g) => !g.userId && g.guestEmail).map((g) => String(g.guestEmail).toLowerCase()));
  return next.filter((g) => !g.userId && g.guestEmail && !prevEmails.has(String(g.guestEmail).toLowerCase()));
}
