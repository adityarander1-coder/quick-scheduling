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

import crypto from 'crypto';
import { query } from '../db.js';
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

export interface ProviderRoom {
  externalId: string;
  name: string;
  details: string | null;
}

/** The provider's bookable room list, WITHOUT free/busy. Throws on a
 *  provider failure (the sync engine needs failure ≠ empty); an empty
 *  array simply means no rooms over there. */
export async function listProviderRooms(provider: RoomProvider, tok: string): Promise<ProviderRoom[]> {
  return provider === 'google' ? googleRoomList(tok) : microsoftRoomList(tok);
}

async function googleRoomList(tok: string): Promise<ProviderRoom[]> {
  const base = googleApiBase();
  const list = await pfetch(`${base}/calendar/v3/users/me/calendarList?maxResults=250`, tok);
  const items: any[] = (list && list.items) || [];
  // Room resources carry ids on the resource.calendar.google.com
  // domain — that's the marker Workspace gives bookable rooms.
  return items.filter((c) => typeof c.id === 'string' && c.id.includes('@resource.calendar.google.com'))
    .map((c) => ({
      externalId: String(c.id),
      name: String(c.summary || c.id),
      details: c.description ? String(c.description).slice(0, 200) : null,
    }));
}

async function microsoftRoomList(tok: string): Promise<ProviderRoom[]> {
  const base = msGraphBase();
  let rooms: ProviderRoom[] = [];
  try {
    const fr = await pfetch(`${base}/v1.0/me/findRooms`, tok);
    rooms = ((fr && fr.value) || []).map((r: any) => ({
      externalId: String(r.address || r.emailAddress || ''),
      name: String(r.name || r.address || ''),
      details: r.capacity ? `Seats ${r.capacity}` : null,
    })).filter((r: ProviderRoom) => r.externalId);
  } catch { /* fall through to /places */ }
  if (!rooms.length) {
    const pl = await pfetch(`${base}/v1.0/places?$top=100`, tok);
    rooms = ((pl && pl.value) || []).map((r: any) => ({
      externalId: String(r.emailAddress || ''),
      name: String(r.displayName || r.emailAddress || ''),
      details: r.capacity ? `Seats ${r.capacity}` : null,
    })).filter((r: ProviderRoom) => r.externalId);
  }
  return rooms;
}

async function googleRooms(companyId: string, tok: string, startUtc: Date, endUtc: Date): Promise<ConnectedRoomsResult> {
  const base = googleApiBase();
  const rooms = await googleRoomList(tok);
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
  const rooms = await microsoftRoomList(tok);
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

// ---------- Room sync + import (migration 093) ----------
// Mode A — SYNC (both systems stay live): the provider's rooms are
// copied into our rooms table with source = the provider, kept fresh
// by re-syncs (connect time, manual, lazy >24h). Their system owns
// names/details; availability is still checked LIVE (the picker
// merges provider free/busy with our own sessions' holds).
// Mode B — IMPORT (they move over to us): the same pull, but each
// room is DETACHED — source becomes 'imported-<provider>' and
// external_id is cleared, so no upsert can match it again; the room
// is a plain app room, editable in our Settings, forever outside
// sync. Importing over an existing SYNCED row converts that row in
// place (same id — sessions keep their room).

export interface RoomSyncResult {
  ok: boolean;
  added: number;
  updated: number;
  switchedOff: number;
  error?: string;
}

export interface RoomImportResult {
  ok: boolean;
  imported: number;
  converted: number;
  error?: string;
}

export interface RoomSyncState {
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastResult: ({ ok: true } & Omit<RoomSyncResult, 'ok'>) | ({ ok: false; error: string }) | null;
}

function syncStateKey(provider: RoomProvider): string { return `rooms_sync_${provider}`; }

async function writeRoomSyncState(companyId: string, provider: RoomProvider, state: RoomSyncState): Promise<void> {
  await query(
    `INSERT INTO company_settings (company_id, key, value) VALUES ($1, $2, $3)
     ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [companyId, syncStateKey(provider), JSON.stringify(state)]);
}

export async function getRoomSyncState(companyId: string, provider: RoomProvider): Promise<RoomSyncState> {
  try {
    const { rows } = await query(
      'SELECT value FROM company_settings WHERE company_id = $1 AND key = $2', [companyId, syncStateKey(provider)]);
    if (rows.length && rows[0].value) {
      const v = JSON.parse(String(rows[0].value));
      return { lastSyncAt: v.lastSyncAt || null, lastAttemptAt: v.lastAttemptAt || null, lastResult: v.lastResult || null };
    }
  } catch { /* a bad/absent state row reads as "never synced" */ }
  return { lastSyncAt: null, lastAttemptAt: null, lastResult: null };
}

/** True when the company has at least one synced row for the provider
 *  (the picker then serves that provider from the table, not live). */
export async function hasSyncedRooms(companyId: string, provider: RoomProvider): Promise<boolean> {
  const { rows } = await query(
    "SELECT 1 FROM rooms WHERE company_id = $1 AND source = $2 AND external_id IS NOT NULL LIMIT 1", [companyId, provider]);
  return rows.length > 0;
}

async function syncedRows(companyId: string, provider: RoomProvider): Promise<any[]> {
  const { rows } = await query(
    'SELECT * FROM rooms WHERE company_id = $1 AND source = $2 AND external_id IS NOT NULL', [companyId, provider]);
  return rows;
}

/**
 * One sync pass for one provider. The provider list is fetched FULLY
 * before any write, so a provider failure changes NOTHING. Synced
 * rooms missing from the latest list are switched off, never deleted
 * (sessions keep pointing at a real room). A room switched off HERE
 * (user_disabled) stays off; its name/details still refresh.
 * NEVER throws — the outcome is recorded for Settings either way.
 */
export async function syncRoomsForCompany(companyId: string, provider: RoomProvider): Promise<RoomSyncResult> {
  const nowIso = new Date().toISOString();
  let prev = await getRoomSyncState(companyId, provider);
  try {
    if (!providerConfigured(provider)) throw new Error('not configured');
    const row = await getIntegration(companyId, provider);
    if (!row) throw new Error('not connected');
    const tok = await getValidAccessToken(companyId, provider);
    const list = await listProviderRooms(provider, tok); // throws on provider failure
    // Dedup defensively (a provider listing the same room twice
    // would otherwise fight the unique index).
    const byExt = new Map<string, ProviderRoom>();
    for (const r of list) if (!byExt.has(r.externalId)) byExt.set(r.externalId, r);
    const existing = await syncedRows(companyId, provider);
    const existingByExt = new Map(existing.map((r: any) => [String(r.external_id), r]));
    let added = 0, updated = 0, switchedOff = 0;
    for (const r of byExt.values()) {
      const cur = existingByExt.get(r.externalId);
      if (!cur) {
        await query(
          'INSERT INTO rooms (id, company_id, name, details, source, external_id, active, user_disabled, last_synced_at) VALUES ($1,$2,$3,$4,$5,$6,true,false,now())',
          [crypto.randomUUID(), companyId, r.name, r.details, provider, r.externalId]);
        added++;
      } else {
        // Never reactivate a user-disabled room; a room WE switched
        // off because it vanished (and it is back now) comes back on.
        const active = cur.user_disabled ? false : true;
        await query(
          'UPDATE rooms SET name = $1, details = $2, active = $3, last_synced_at = now() WHERE id = $4',
          [r.name, r.details, active, cur.id]);
        updated++;
      }
    }
    for (const cur of existing) {
      if (!byExt.has(String(cur.external_id)) && cur.active !== false) {
        await query('UPDATE rooms SET active = false WHERE id = $1', [cur.id]);
        switchedOff++;
      }
    }
    const result: RoomSyncResult = { ok: true, added, updated, switchedOff };
    await writeRoomSyncState(companyId, provider, {
      lastSyncAt: nowIso, lastAttemptAt: nowIso,
      lastResult: { ok: true, added, updated, switchedOff },
    }).catch(() => {});
    return result;
  } catch (err) {
    const message = err instanceof MeetingError ? err.message
      : 'Could not read the rooms just now.';
    await writeRoomSyncState(companyId, provider, {
      lastSyncAt: prev.lastSyncAt, lastAttemptAt: nowIso,
      lastResult: { ok: false, error: message },
    }).catch(() => {});
    return { ok: false, added: 0, updated: 0, switchedOff: 0, error: message };
  }
}

/**
 * Import-and-make-ours for one provider: pull the list once; rooms
 * already here as SYNCED rows are CONVERTED in place (same id —
 * sessions keep their room), the rest are created. Every resulting
 * row is detached: source 'imported-<provider>', external_id NULL.
 * If the provider call fails, nothing changes.
 */
export async function importRoomsForCompany(companyId: string, provider: RoomProvider, createdBy: string | null): Promise<RoomImportResult> {
  try {
    if (!providerConfigured(provider)) return { ok: false, imported: 0, converted: 0, error: 'That service is not set up yet.' };
    const row = await getIntegration(companyId, provider);
    if (!row) return { ok: false, imported: 0, converted: 0, error: 'Connect the service first.' };
    const tok = await getValidAccessToken(companyId, provider);
    const list = await listProviderRooms(provider, tok);
    if (!list.length) return { ok: false, imported: 0, converted: 0, error: `No rooms found in ${provider === 'google' ? 'Google' : 'Microsoft 365'} to import.` };
    const byExt = new Map<string, ProviderRoom>();
    for (const r of list) if (!byExt.has(r.externalId)) byExt.set(r.externalId, r);
    const existing = await syncedRows(companyId, provider);
    const existingByExt = new Map(existing.map((r: any) => [String(r.external_id), r]));
    const detachedSource = `imported-${provider}`;
    let imported = 0, converted = 0;
    for (const r of byExt.values()) {
      const cur = existingByExt.get(r.externalId);
      if (cur) {
        // Convert: detach, keep the row (and its id, name state and
        // any local off-switch — the room is theirs to run now).
        await query(
          'UPDATE rooms SET source = $1, external_id = NULL WHERE id = $2',
          [detachedSource, cur.id]);
        converted++;
      } else {
        const note = provider === 'google' ? 'Imported from Google' : 'Imported from Microsoft 365';
        const details = r.details ? `${r.details} · ${note}` : note;
        await query(
          'INSERT INTO rooms (id, company_id, name, details, source, active, created_by) VALUES ($1,$2,$3,$4,$5,true,$6)',
          [crypto.randomUUID(), companyId, r.name, details.slice(0, 200), detachedSource, createdBy]);
        imported++;
      }
    }
    return { ok: true, imported, converted };
  } catch (err) {
    return {
      ok: false, imported: 0, converted: 0,
      error: err instanceof MeetingError ? err.message : 'Could not read the rooms just now.',
    };
  }
}

// Lazy refresh (design 3c): picker data requests kick a background
// sync when a provider's last SUCCESS is over 24h old (or never) —
// fire-and-forget, never blocking the response, never twice at once.
const lazySyncRunning = new Set<string>();
export function maybeLazySyncRooms(companyId: string): void {
  for (const provider of ['google', 'microsoft'] as const) {
    const key = `${companyId}:${provider}`;
    if (lazySyncRunning.has(key)) continue;
    lazySyncRunning.add(key);
    (async () => {
      try {
        if (!providerConfigured(provider)) return;
        const row = await getIntegration(companyId, provider);
        if (!row) return;
        const state = await getRoomSyncState(companyId, provider);
        const last = state.lastSyncAt ? Date.parse(state.lastSyncAt) : 0;
        if (Date.now() - last > 24 * 3600 * 1000) await syncRoomsForCompany(companyId, provider);
      } catch { /* lazy sync is best-effort by definition */ }
      finally { lazySyncRunning.delete(key); }
    })();
  }
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
