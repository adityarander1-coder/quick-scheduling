// routes/calendarFeed.ts — personal calendar feed (.ics), 2026-11-06.
//
// Each signed-in user gets a private, unguessable feed URL holding
// ONLY their own published shifts (rotation occurrences included) and
// the calendar sessions they present or supervise. Google / Outlook /
// Apple Calendar subscribe to the URL and poll it — read-only, one
// way. The token in the URL is the credential (same pattern as the
// form links and offer links); resetting it kills the old URL.
//
//   GET  /api/users/me/calendar-feed         (session) → { url }
//   POST /api/users/me/calendar-feed/reset   (session) → { url }
//   GET  /api/calendar-feed/:token.ics       (public)  → text/calendar

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { getShiftsForRange } from '../util/shiftRange.js';
import { getShiftTypeTimes } from '../util/shiftConflicts.js';
import { companyTodayStr } from '../util/notifyJobs.js';
import { expandAcademicSessions, loadOverrides } from './schedule.js';

function newFeedToken(): string {
  return crypto.randomBytes(32).toString('base64url'); // 43 url-safe chars
}

function feedBase(req: Request): string {
  // Same absolute-URL pattern as the schedule share links.
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function feedUrl(req: Request, token: string): string {
  return `${feedBase(req)}/api/calendar-feed/${token}.ics`;
}

async function getOrCreateToken(userId: string, companyId: string): Promise<string> {
  const { rows } = await query(
    'SELECT calendar_feed_token FROM users WHERE id = $1 AND company_id = $2',
    [userId, companyId]
  );
  if (rows.length && rows[0].calendar_feed_token) return String(rows[0].calendar_feed_token);
  const token = newFeedToken();
  await query(
    'UPDATE users SET calendar_feed_token = $1 WHERE id = $2 AND company_id = $3',
    [token, userId, companyId]
  );
  return token;
}

// ---------------------------------------------------------------------
// Authenticated endpoints (mounted at /api/users, before usersRouter)
// ---------------------------------------------------------------------
export const calendarFeedMeRouter = Router();
calendarFeedMeRouter.use(requireAuth);

calendarFeedMeRouter.get('/me/calendar-feed', async (req: Request, res: Response) => {
  try {
    const token = await getOrCreateToken(req.session.userId!, req.session.companyId!);
    res.json({ url: feedUrl(req, token) });
  } catch (err) {
    console.error('[calendar-feed] get failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

calendarFeedMeRouter.post('/me/calendar-feed/reset', async (req: Request, res: Response) => {
  try {
    const token = newFeedToken();
    await query(
      'UPDATE users SET calendar_feed_token = $1 WHERE id = $2 AND company_id = $3',
      [token, req.session.userId!, req.session.companyId!]
    );
    res.json({ url: feedUrl(req, token) });
  } catch (err) {
    console.error('[calendar-feed] reset failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ---------------------------------------------------------------------
// Public feed
// ---------------------------------------------------------------------
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** The company's timezone (company_settings 'timezone', default
 * 'America/Chicago') — stored wall-clock times in the feed are read in
 * this zone. Same read + Intl-validation pattern as the email poller. */
async function companyTimezone(companyId: string): Promise<string> {
  let tz = 'America/Chicago';
  try {
    const { rows } = await query(
      `SELECT value FROM company_settings WHERE company_id = $1 AND key = 'timezone'`,
      [companyId]
    );
    if (rows.length && rows[0].value) {
      const v = String(rows[0].value);
      try { new Intl.DateTimeFormat('en-US', { timeZone: v }); tz = v; }
      catch { /* bad stored value — keep the fallback */ }
    }
  } catch { /* settings unavailable — default */ }
  return tz;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of timezone `tz` from UTC at instant `utcMs`, i.e.
 * local-wall-reading minus UTC. Derived by formatting the instant in
 * `tz` and reading the parts back as if they were UTC. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const parts = dtfFor(tz).formatToParts(new Date(utcMs));
  let y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
  for (const p of parts) {
    if (p.type === 'year') y = +p.value;
    else if (p.type === 'month') mo = +p.value;
    else if (p.type === 'day') d = +p.value;
    else if (p.type === 'hour') h = +p.value % 24;
    else if (p.type === 'minute') mi = +p.value;
    else if (p.type === 'second') s = +p.value;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) - Math.floor(utcMs / 1000) * 1000;
}

/** UTC datetime (YYYYMMDDTHHMMSSZ) for `totalMin` minutes after local
 * midnight on `dateStr` in timezone `tz`.
 *
 * Why UTC: the feed used to emit floating local times (no zone), and
 * Google Calendar's URL-feed importer reads floating times as UTC, so
 * a 7 AM CST shift showed up at 1 AM. A Z-suffixed UTC instant is the
 * one form every consumer places correctly (2026-11-08 fix).
 *
 * `totalMin` may exceed 1440 (overnight shifts): the whole local
 * datetime — date plus total minutes — is resolved to an instant in
 * one step, so next-day ends land right. The offset is computed at
 * the event's own date (a January shift is CST, a July shift is CDT),
 * evaluated twice so a local time near a DST transition still pins
 * the offset actually in force for it. */
function utcDt(dateStr: string, totalMin: number, tz: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const wallMs = Date.UTC(y, mo - 1, d) + totalMin * 60000;
  let utcMs = wallMs - tzOffsetMs(tz, wallMs);
  const offAtInstant = tzOffsetMs(tz, utcMs);
  if (offAtInstant !== tzOffsetMs(tz, wallMs)) utcMs = wallMs - offAtInstant;
  const dt = new Date(utcMs);
  return (
    `${dt.getUTCFullYear()}${pad2(dt.getUTCMonth() + 1)}${pad2(dt.getUTCDate())}` +
    `T${pad2(dt.getUTCHours())}${pad2(dt.getUTCMinutes())}${pad2(dt.getUTCSeconds())}Z`
  );
}

function dateOnly(dateStr: string): string {
  return dateStr.replace(/-/g, '');
}

function dtStampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 5545 text escaping. */
function escIcs(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets (continuation lines start with a
 * single space), without splitting a multi-byte character. */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  let out = '';
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > limit) {
      out += cur + '\r\n ';
      cur = '';
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += b;
  }
  return out + cur;
}

function parseHM(t: any): number | null {
  if (t === null || t === undefined) return null;
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

interface FeedEvent {
  uid: string;
  summary: string;
  location?: string | null;
  /** Timed event. */
  start?: string; // UTC datetime (YYYYMMDDTHHMMSSZ)
  end?: string;
  /** All-day event (date-only). */
  startDate?: string; // YYYYMMDD
  endDate?: string;
}

function renderEvent(ev: FeedEvent, stamp: string): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${stamp}`, `SUMMARY:${escIcs(ev.summary)}`];
  if (ev.startDate) {
    lines.push(`DTSTART;VALUE=DATE:${ev.startDate}`);
    lines.push(`DTEND;VALUE=DATE:${ev.endDate}`);
  } else {
    lines.push(`DTSTART:${ev.start}`);
    lines.push(`DTEND:${ev.end}`);
  }
  if (ev.location) lines.push(`LOCATION:${escIcs(ev.location)}`);
  lines.push('END:VEVENT');
  return lines;
}

export const calendarFeedPublicRouter = Router();

calendarFeedPublicRouter.get('/:token.ics', async (req: Request, res: Response) => {
  try {
    const token = String(req.params.token || '');
    const { rows: urows } = await query(
      'SELECT id, company_id FROM users WHERE calendar_feed_token = $1',
      [token]
    );
    if (!urows.length) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    const userId = urows[0].id as string;
    const companyId = urows[0].company_id as string;
    const tz = await companyTimezone(companyId);

    const today = await companyTodayStr(companyId);
    const from = addDays(today, -7);
    const to = addDays(today, 180);
    const stamp = dtStampNow();
    const events: FeedEvent[] = [];

    // --- Shifts: same generation + published flags My Schedule uses
    // (getShiftsForRange is the shared read path); staff see published
    // only, so the feed carries published shifts only.
    const allShifts = await getShiftsForRange(query, companyId, from, to);
    const typeTimes = await getShiftTypeTimes(query, companyId);
    for (const s of allShifts) {
      if (s.userId !== userId || !s.published) continue;
      const tt = s.shiftTypeId ? typeTimes.get(s.shiftTypeId) : undefined;
      const uid = `qs-shift-${userId}-${s.shiftTypeId || 'none'}-${s.date}@quick-scheduling`;
      if (tt && tt.timed && tt.startMin !== null && tt.endMin !== null) {
        let endMin = tt.endMin;
        if (endMin <= tt.startMin) endMin += 1440; // overnight, same convention as the app
        events.push({
          uid,
          summary: s.shiftTypeName,
          start: utcDt(s.date, tt.startMin, tz),
          end: utcDt(s.date, endMin, tz),
        });
      } else {
        events.push({
          uid,
          summary: s.shiftTypeName,
          startDate: dateOnly(s.date),
          endDate: dateOnly(addDays(s.date, 1)),
        });
      }
    }

    // --- Sessions: expand the company's sessions exactly like
    // GET /academic-sessions (recurrence + per-date overrides +
    // cancellations), then keep the occurrences this user presents
    // or attends.
    const { rows: srows } = await query(
      `SELECT s.*, u.first_name, u.last_name, (u.is_active IS NOT FALSE) AS lecturer_active, d.name AS department_name,
              sup.first_name AS sup_first_name, sup.last_name AS sup_last_name
       FROM academic_sessions s
       LEFT JOIN users u ON u.id = s.lecturer_user_id
       LEFT JOIN users sup ON sup.id = s.supervisor_user_id
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE s.company_id = $1
         AND NOT EXISTS (SELECT 1 FROM dashboards dx WHERE dx.id = s.dashboard_id AND dx.archived_at IS NOT NULL)
         AND (s.recur_rule IS NULL OR s.recur_rule = 'none' OR s.recur_until IS NULL OR s.recur_until >= $2)
         AND s.session_date <= $3`,
      [companyId, from, to]
    );
    let ovMap = new Map<string, any>();
    const userName = new Map<string, string>();
    if (srows.some((r: any) => r.recur_rule && r.recur_rule !== 'none')) {
      ovMap = await loadOverrides(companyId, srows.map((r: any) => r.id), from, to);
      const { rows: us } = await query('SELECT id, first_name, last_name FROM users WHERE company_id = $1', [companyId]);
      for (const u of us) userName.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(' '));
    }
    // EVENT model (2026-11-07): the feed also carries events where
    // the user is ANY team speaker (not just Speaker 1) and events
    // they ATTEND as a beneficiary (named personally, or through a
    // beneficiary department they belong to).
    const speakerOf = new Set<string>();
    const attends = new Set<string>();
    if (srows.length) {
      const sids = srows.map((r: any) => r.id);
      const { rows: sp } = await query('SELECT session_id FROM session_speakers WHERE user_id = $1 AND session_id = ANY($2::uuid[])', [userId, sids]);
      for (const r of sp) speakerOf.add(r.session_id);
      const { rows: bu } = await query('SELECT session_id FROM session_beneficiary_users WHERE user_id = $1 AND session_id = ANY($2::uuid[])', [userId, sids]);
      for (const r of bu) attends.add(r.session_id);
      const { rows: me } = await query('SELECT department_id FROM users WHERE id = $1', [userId]);
      if (me[0]?.department_id) {
        const { rows: bd } = await query('SELECT session_id FROM session_beneficiary_departments WHERE department_id = $1 AND session_id = ANY($2::uuid[])', [me[0].department_id, sids]);
        for (const r of bd) attends.add(r.session_id);
      }
    }
    const occurrences = expandAcademicSessions(srows, from, to, ovMap, userName);
    for (const o of occurrences) {
      const roles: string[] = [];
      if (o.lecturerUserId === userId || speakerOf.has(o.seriesId || o.id)) roles.push('presenter');
      // A stored supervisor assignment no longer puts the session in
      // the feed or labels it — supervisors were retired (2026-11-07).
      if (!roles.length && attends.has(o.seriesId || o.id)) roles.push('attendee');
      if (!roles.length) continue;
      const uid = `qs-session-${o.id}@quick-scheduling`;
      const summary = `${o.title} (${roles.join(' & ')})`;
      const startMin = parseHM(o.startTime);
      if (startMin !== null) {
        let endMin = parseHM(o.endTime);
        if (endMin === null) endMin = startMin + 60; // app's own convention for a missing end
        if (endMin <= startMin) endMin += 1440;
        events.push({
          uid,
          summary,
          location: o.location || null,
          start: utcDt(o.date, startMin, tz),
          end: utcDt(o.date, endMin, tz),
        });
      } else {
        events.push({
          uid,
          summary,
          location: o.location || null,
          startDate: dateOnly(o.date),
          endDate: dateOnly(addDays(o.date, 1)),
        });
      }
    }

    events.sort((a, b) => {
      const ka = a.start || a.startDate || '';
      const kb = b.start || b.startDate || '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Quick Scheduling//Personal Calendar Feed//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Quick Scheduling — my shifts & sessions',
      // Informational only: timed events are UTC instants (Z), which
      // every consumer renders in the viewer's own zone.
      `X-WR-TIMEZONE:${tz}`,
    ];
    for (const ev of events) lines.push(...renderEvent(ev, stamp));
    lines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="quick-scheduling.ics"');
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.send(lines.map(foldLine).join('\r\n') + '\r\n');
  } catch (err) {
    console.error('[calendar-feed] feed failed:', err);
    res.status(500).type('text/plain').send('Something went wrong.');
  }
});
