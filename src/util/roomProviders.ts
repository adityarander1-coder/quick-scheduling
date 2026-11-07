// util/roomProviders.ts — connected conference rooms (Deepika,
// 2026-11-07, migration 092). Companies on Microsoft 365 / Google
// Workspace keep their bookable rooms THERE as resources; over the
// same one-time connection as the meeting links (migration 091) the
// session form's Room picker also lists those rooms with live
// Available/Booked for the picked time. BEST-EFFORT by design: every
// failure (no Workspace room setup, missing admin consent, dead
// token, provider hiccup) degrades SILENTLY to our own rooms — this
// module never throws. No provider-side reservation in v1: picking a
// connected room stores its id + name on the session; the booking
// itself still lives in Quick Scheduling (except that a Google room
// rides along as a resource attendee when a Meet link is generated
// for the session — see meetingProviders.createMeeting).
//
// Base URLs are env-overridable like meetingProviders (GOOGLE_API_BASE,
// MS_GRAPH_BASE) so verify suites can point them at a local stub.

import { getIntegration, getValidAccessToken, providerConfigured, MeetingError } from './meetingProviders.js';

export type RoomProvider = 'google' | 'microsoft';

export interface ConnectedRoom {
  externalId: string;
  name: string;
  status: 'available' | 'booked';
}

export interface ConnectedRoomsResult {
  /** True when the company has a stored connection for the provider
   *  (the picker shows the section, possibly with just a note). */
  connected: boolean;
  rooms: ConnectedRoom[];
  /** Muted, user-facing note (e.g. no rooms set up over there). */
  note: string | null;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}
function googleApiBase(): string { return env('GOOGLE_API_BASE') || 'https://www.googleapis.com'; }
function msGraphBase(): string { return env('MS_GRAPH_BASE') || 'https://graph.microsoft.com'; }

async function pfetch(url: string, tok: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...((init && init.headers) || {}) },
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new Error('provider ' + res.status);
    return data;
  } finally { clearTimeout(timer); }
}

function overlaps(aS: number, aE: number, bS: number, bE: number): boolean { return aS < bE && aE > bS; }

async function googleRooms(companyId: string, tok: string, startUtc: Date, endUtc: Date): Promise<ConnectedRoomsResult> {
  const base = googleApiBase();
  const list = await pfetch(`${base}/calendar/v3/users/me/calendarList?maxResults=250`, tok);
  const items: any[] = (list && list.items) || [];
  // Room resources carry ids on the resource.calendar.google.com
  // domain — that's the marker Workspace gives bookable rooms.
  const rooms = items.filter((c) => typeof c.id === 'string' && c.id.includes('@resource.calendar.google.com'))
    .map((c) => ({ externalId: String(c.id), name: String(c.summary || c.id) }));
  if (!rooms.length) {
    return { connected: true, rooms: [], note: 'No rooms found in Google — rooms there need Workspace setup.' };
  }
  let busyById = new Map<string, Array<{ start: string; end: string }>>();
  try {
    const fb = await pfetch(`${base}/calendar/v3/freeBusy`, tok, {
      method: 'POST',
      body: JSON.stringify({
        timeMin: startUtc.toISOString(), timeMax: endUtc.toISOString(),
        items: rooms.map((r) => ({ id: r.externalId })),
      }),
    });
    const cals = (fb && fb.calendars) || {};
    for (const id of Object.keys(cals)) busyById.set(id, cals[id].busy || []);
  } catch { /* availability unknown — list the rooms as available */ }
  const wS = startUtc.getTime(), wE = endUtc.getTime();
  return {
    connected: true, note: null,
    rooms: rooms.map((r) => ({
      ...r,
      status: (busyById.get(r.externalId) || []).some((b) => overlaps(wS, wE, Date.parse(b.start), Date.parse(b.end))) ? 'booked' as const : 'available' as const,
    })),
  };
}

async function microsoftRooms(companyId: string, tok: string, startUtc: Date, endUtc: Date): Promise<ConnectedRoomsResult> {
  const base = msGraphBase();
  let rooms: { externalId: string; name: string }[] = [];
  try {
    const fr = await pfetch(`${base}/v1.0/me/findRooms`, tok);
    rooms = ((fr && fr.value) || []).map((r: any) => ({ externalId: String(r.address || r.emailAddress || ''), name: String(r.name || r.address || '') })).filter((r: any) => r.externalId);
  } catch { /* fall through to /places */ }
  if (!rooms.length) {
    const pl = await pfetch(`${base}/v1.0/places?$top=100`, tok);
    rooms = ((pl && pl.value) || []).map((r: any) => ({ externalId: String(r.emailAddress || ''), name: String(r.displayName || r.emailAddress || '') })).filter((r: any) => r.externalId);
  }
  if (!rooms.length) {
    return { connected: true, rooms: [], note: 'No rooms found in Microsoft 365 — rooms there need tenant setup.' };
  }
  let itemsById = new Map<string, any[]>();
  try {
    const gs = await pfetch(`${base}/v1.0/me/calendar/getSchedule`, tok, {
      method: 'POST',
      body: JSON.stringify({
        schedules: rooms.map((r) => r.externalId),
        startTime: { dateTime: startUtc.toISOString(), timeZone: 'UTC' },
        endTime: { dateTime: endUtc.toISOString(), timeZone: 'UTC' },
        availabilityViewInterval: 30,
      }),
    });
    for (const v of (gs && gs.value) || []) itemsById.set(String(v.scheduleId || '').toLowerCase(), v.scheduleItems || []);
  } catch { /* availability unknown — list the rooms as available */ }
  const wS = startUtc.getTime(), wE = endUtc.getTime();
  return {
    connected: true, note: null,
    rooms: rooms.map((r) => {
      const items = itemsById.get(r.externalId.toLowerCase()) || [];
      const booked = items.some((it: any) => {
        if (!it || !it.start || !it.end) return false;
        const st = String(it.status || 'busy');
        if (st === 'free') return false;
        return overlaps(wS, wE, Date.parse(it.start.dateTime), Date.parse(it.end.dateTime));
      });
      return { ...r, status: booked ? 'booked' as const : 'available' as const };
    }),
  };
}

/** Live rooms for one connected provider. NEVER throws. */
export async function fetchConnectedRooms(
  companyId: string, provider: RoomProvider, startUtc: Date, endUtc: Date,
): Promise<ConnectedRoomsResult> {
  try {
    if (!providerConfigured(provider)) return { connected: false, rooms: [], note: null };
    const row = await getIntegration(companyId, provider);
    if (!row) return { connected: false, rooms: [], note: null };
    let tok: string;
    try {
      tok = await getValidAccessToken(companyId, provider);
    } catch (err) {
      if (err instanceof MeetingError) {
        return { connected: true, rooms: [], note: `Could not read rooms — reconnect ${provider === 'google' ? 'Google' : 'Microsoft'} in Settings → Meeting services.` };
      }
      throw err;
    }
    return provider === 'google'
      ? await googleRooms(companyId, tok, startUtc, endUtc)
      : await microsoftRooms(companyId, tok, startUtc, endUtc);
  } catch {
    return { connected: true, rooms: [], note: `Could not read rooms from ${provider === 'google' ? 'Google' : 'Microsoft 365'} just now.` };
  }
}
