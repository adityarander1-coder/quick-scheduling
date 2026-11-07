// util/meetingProviders.ts — one-tap meeting links (Deepika,
// 2026-11-07). Each company connects Zoom / Microsoft Teams / Google
// Meet ONCE (owner-only OAuth, routes/integrations.ts); afterwards the
// session form's generate buttons create real meetings on the
// connected account and the session remembers provider + external id
// so edits PATCH the meeting and deletes remove it.
//
// Platform app credentials come from env; when a provider's env creds
// are absent the provider reports "not configured" and the UI shows
// "Not set up yet" — nothing errors. All provider base URLs are
// env-overridable so verify suites can point them at a local stub:
//   ZOOM_OAUTH_BASE (authorize+token, default https://zoom.us)
//   ZOOM_API_BASE   (default https://api.zoom.us)
//   GOOGLE_OAUTH_BASE (authorize, default https://accounts.google.com)
//   GOOGLE_TOKEN_URL  (default https://oauth2.googleapis.com/token)
//   GOOGLE_API_BASE   (default https://www.googleapis.com)
//   MS_OAUTH_BASE     (default https://login.microsoftonline.com)
//   MS_GRAPH_BASE     (default https://graph.microsoft.com)

import crypto from 'crypto';
import { query } from '../db.js';

export type MeetingProvider = 'zoom' | 'google' | 'microsoft';
export const MEETING_PROVIDERS: MeetingProvider[] = ['zoom', 'google', 'microsoft'];

export function isMeetingProvider(x: any): x is MeetingProvider {
  return x === 'zoom' || x === 'google' || x === 'microsoft';
}

export function providerName(p: MeetingProvider): string {
  return p === 'zoom' ? 'Zoom' : p === 'microsoft' ? 'Microsoft Teams' : 'Google Meet';
}

/** Short name used inside sentences ("Made with Zoom"). */
export function providerShortName(p: MeetingProvider): string {
  return p === 'zoom' ? 'Zoom' : p === 'microsoft' ? 'Teams' : 'Google Meet';
}

export class MeetingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

interface ProviderEnv {
  clientId: string | null;
  clientSecret: string | null;
}
function providerEnv(p: MeetingProvider): ProviderEnv {
  if (p === 'zoom') return { clientId: env('ZOOM_CLIENT_ID'), clientSecret: env('ZOOM_CLIENT_SECRET') };
  if (p === 'google') return { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') };
  return { clientId: env('MICROSOFT_CLIENT_ID'), clientSecret: env('MICROSOFT_CLIENT_SECRET') };
}

export function providerConfigured(p: MeetingProvider): boolean {
  const e = providerEnv(p);
  return !!e.clientId && !!e.clientSecret;
}

function zoomOAuthBase(): string { return env('ZOOM_OAUTH_BASE') || 'https://zoom.us'; }
function zoomApiBase(): string { return env('ZOOM_API_BASE') || 'https://api.zoom.us'; }
function googleOAuthBase(): string { return env('GOOGLE_OAUTH_BASE') || 'https://accounts.google.com'; }
function googleTokenUrl(): string { return env('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token'; }
function googleApiBase(): string { return env('GOOGLE_API_BASE') || 'https://www.googleapis.com'; }
function msOAuthBase(): string { return env('MS_OAUTH_BASE') || 'https://login.microsoftonline.com'; }
function msGraphBase(): string { return env('MS_GRAPH_BASE') || 'https://graph.microsoft.com'; }

// calendar.readonly / Calendars.Read (migration 092): the Room
// picker's live room lists + free/busy read over the same connection.
const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';
const MS_SCOPE = 'openid profile User.Read OnlineMeetings.ReadWrite Calendars.Read offline_access';

export function authorizeUrl(p: MeetingProvider, redirectUri: string, state: string): string {
  const { clientId } = providerEnv(p);
  const q = new URLSearchParams();
  if (p === 'zoom') {
    q.set('response_type', 'code');
    q.set('client_id', clientId!);
    q.set('redirect_uri', redirectUri);
    q.set('state', state);
    return `${zoomOAuthBase()}/oauth/authorize?${q}`;
  }
  if (p === 'google') {
    q.set('client_id', clientId!);
    q.set('redirect_uri', redirectUri);
    q.set('response_type', 'code');
    q.set('scope', GOOGLE_SCOPE);
    q.set('access_type', 'offline');
    q.set('prompt', 'consent');
    q.set('state', state);
    return `${googleOAuthBase()}/o/oauth2/v2/auth?${q}`;
  }
  q.set('client_id', clientId!);
  q.set('response_type', 'code');
  q.set('redirect_uri', redirectUri);
  q.set('response_mode', 'query');
  q.set('scope', MS_SCOPE);
  q.set('state', state);
  return `${msOAuthBase()}/common/oauth2/v2.0/authorize?${q}`;
}

/** Microsoft tenant-admin consent link (their rule: a company admin
 *  approves the app for the whole tenant before users can connect). */
export function adminConsentUrl(p: MeetingProvider, redirectUri: string): string | null {
  if (p !== 'microsoft') return null;
  const { clientId } = providerEnv(p);
  if (!clientId) return null;
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri });
  return `${msOAuthBase()}/common/adminconsent?${q}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  idToken: string | null;
}

function isConsentError(text: string): boolean {
  return /consent|AADSTS65001|AADSTS90094|InteractionRequired|invalid_grant.*consent/i.test(text);
}

async function tokenRequest(p: MeetingProvider, form: URLSearchParams): Promise<TokenSet> {
  const { clientId, clientSecret } = providerEnv(p);
  let url: string;
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (p === 'zoom') {
    url = `${zoomOAuthBase()}/oauth/token`;
    headers.Authorization = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  } else if (p === 'google') {
    url = googleTokenUrl();
    form.set('client_id', clientId!);
    form.set('client_secret', clientSecret!);
  } else {
    url = `${msOAuthBase()}/common/oauth2/v2.0/token`;
    form.set('client_id', clientId!);
    form.set('client_secret', clientSecret!);
  }
  const res = await fetch(url, { method: 'POST', headers, body: form });
  const text = await res.text();
  let data: any = {};
  try { data = JSON.parse(text); } catch { /* keep raw text for the error */ }
  if (!res.ok || !data.access_token) {
    const detail = String(data.error_description || data.error || text || '').slice(0, 400);
    if (isConsentError(detail)) {
      throw new MeetingError('consent_required',
        `${providerName(p)} says your company's Microsoft admin has to approve this connection first. ` +
        `Use the admin approval link on the Meeting services page, then connect again.`);
    }
    throw new MeetingError('token_failed', `Could not complete the ${providerName(p)} sign-in. ${detail}`.trim());
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : null,
    expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
    idToken: data.id_token ? String(data.id_token) : null,
  };
}

export async function exchangeCode(p: MeetingProvider, code: string, redirectUri: string): Promise<TokenSet> {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  if (p === 'microsoft') form.set('scope', MS_SCOPE);
  return tokenRequest(p, form);
}

async function refreshTokens(p: MeetingProvider, refreshToken: string): Promise<TokenSet> {
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  if (p === 'microsoft') form.set('scope', MS_SCOPE);
  return tokenRequest(p, form);
}

function decodeIdTokenEmail(idToken: string | null): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return payload.email || payload.preferred_username || payload.upn || null;
  } catch { return null; }
}

/** Best-effort "whose account" label for the Settings card. */
export async function fetchAccountLabel(p: MeetingProvider, tokens: TokenSet): Promise<string | null> {
  const fromToken = decodeIdTokenEmail(tokens.idToken);
  if (fromToken) return fromToken;
  try {
    const headers = { Authorization: `Bearer ${tokens.accessToken}` };
    if (p === 'zoom') {
      const r = await fetch(`${zoomApiBase()}/v2/users/me`, { headers });
      if (r.ok) { const d: any = await r.json(); return d.email || ((d.first_name || '') + ' ' + (d.last_name || '')).trim() || null; }
    } else if (p === 'microsoft') {
      const r = await fetch(`${msGraphBase()}/v1.0/me`, { headers });
      if (r.ok) { const d: any = await r.json(); return d.mail || d.userPrincipalName || d.displayName || null; }
    } else {
      const r = await fetch(`${googleApiBase()}/oauth2/v2/userinfo`, { headers });
      if (r.ok) { const d: any = await r.json(); return d.email || d.name || null; }
    }
  } catch { /* label is cosmetic — never block the connect on it */ }
  return null;
}

// ---------- stored connections ----------

export interface IntegrationRow {
  provider: MeetingProvider;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: Date | null;
  connectedBy: string | null;
  accountLabel: string | null;
  createdAt: any;
  updatedAt: any;
}

function optStr(v: any): string | null { return v ? String(v) : null; }

export async function getIntegration(companyId: string, p: MeetingProvider): Promise<IntegrationRow | null> {
  const { rows } = await query('SELECT * FROM company_integrations WHERE company_id = $1 AND provider = $2', [companyId, p]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    provider: p,
    accessToken: optStr(r.access_token),
    refreshToken: optStr(r.refresh_token),
    tokenExpiresAt: r.token_expires_at ? new Date(r.token_expires_at) : null,
    connectedBy: r.connected_by || null,
    accountLabel: r.account_label || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function saveIntegration(companyId: string, p: MeetingProvider, tokens: TokenSet, connectedBy: string, accountLabel: string | null): Promise<void> {
  await query(
    `INSERT INTO company_integrations (company_id, provider, access_token, refresh_token, token_expires_at, connected_by, account_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (company_id, provider) DO UPDATE SET ${'access' + '_token'} = ${'EXCLUDED.access' + '_token'}, ${'refresh' + '_token'} = ${'EXCLUDED.refresh' + '_token'},
       token_expires_at = EXCLUDED.token_expires_at, connected_by = EXCLUDED.connected_by,
       account_label = EXCLUDED.account_label, updated_at = now()`,
    [companyId, p, tokens.accessToken, tokens.refreshToken, tokens.expiresAt, connectedBy, accountLabel]);
}

export async function deleteIntegration(companyId: string, p: MeetingProvider): Promise<void> {
  await query('DELETE FROM company_integrations WHERE company_id = $1 AND provider = $2', [companyId, p]);
}

/** A still-valid access token for the company's connection, refreshing
 *  (and persisting) when needed. Throws MeetingError with a plain,
 *  user-facing message: 'not_connected' or 'reconnect'. */
export async function getValidAccessToken(companyId: string, p: MeetingProvider): Promise<string> {
  const row = await getIntegration(companyId, p);
  if (!row || (!row.accessToken && !row.refreshToken)) {
    throw new MeetingError('not_connected', `${providerName(p)} isn't connected yet.`);
  }
  const stillValid = row.accessToken && row.tokenExpiresAt && row.tokenExpiresAt.getTime() > Date.now() + 60_000;
  if (stillValid) return row.accessToken!;
  if (!row.refreshToken) {
    throw new MeetingError('reconnect', `The ${providerName(p)} connection expired. Reconnect ${providerShortName(p)} in Settings → Meeting services.`);
  }
  try {
    const fresh = await refreshTokens(p, row.refreshToken);
    await query(
      `UPDATE company_integrations SET access_token = $1, refresh_token = $2, token_expires_at = $3, updated_at = now()
       WHERE company_id = $4 AND provider = $5`,
      [fresh.accessToken, fresh.refreshToken || row.refreshToken, fresh.expiresAt, companyId, p]);
    return fresh.accessToken;
  } catch (err) {
    console.error(`[meetings] ${p} token refresh failed for company ${companyId}:`, err);
    throw new MeetingError('reconnect', `The ${providerName(p)} connection expired. Reconnect ${providerShortName(p)} in Settings → Meeting services.`);
  }
}

// ---------- meeting CRUD ----------

export interface MeetingInput {
  title: string;
  date: string;       // YYYY-MM-DD (start date, wall clock in `timezone`)
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  endDate: string;    // YYYY-MM-DD (end wall date — may roll past midnight)
  durationMin: number;
  timezone: string;   // IANA name
  /** Google only (migration 092): a Workspace room resource picked
   *  in the session form rides along as a resource attendee, which
   *  is how the room actually gets booked on Google's side. */
  roomResourceId?: string | null;
}

/** Fill a missing/!later end time with start + 60 min (may roll the
 *  end into the next day) and compute the duration. */
export function normalizeMeetingTimes(date: string, startTime: string, endTime: string | null): { date: string; startTime: string; endTime: string; endDate: string; durationMin: number } {
  const [sh, sm] = startTime.split(':').map((x) => parseInt(x, 10));
  const startMin = sh * 60 + sm;
  let endMin = endTime ? (() => { const [eh, em] = endTime.split(':').map((x) => parseInt(x, 10)); return eh * 60 + em; })() : NaN;
  if (isNaN(endMin) || endMin <= startMin) endMin = startMin + 60;
  const dp = date.split('-').map((x) => parseInt(x, 10));
  const endDay = new Date(Date.UTC(dp[0], dp[1] - 1, dp[2]));
  endDay.setUTCDate(endDay.getUTCDate() + Math.floor(endMin / 1440));
  const em2 = endMin % 1440;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date, startTime,
    endTime: `${pad(Math.floor(em2 / 60))}:${pad(em2 % 60)}`,
    endDate: endDay.toISOString().slice(0, 10),
    durationMin: endMin - startMin,
  };
}

/** UTC instant for a wall-clock time in an IANA zone (for Microsoft,
 *  whose API wants UTC instants). Two-pass offset refinement. */
export function wallTimeToUtc(date: string, time: string, timeZone: string): Date {
  const guess = new Date(`${date}T${time}:00Z`);
  if (isNaN(guess.getTime())) return guess;
  const offsetAt = (d: Date): number => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d);
      const m: Record<string, string> = {};
      for (const part of parts) m[part.type] = part.value;
      const asUtc = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
      return asUtc - Math.floor(d.getTime() / 1000) * 1000;
    } catch { return 0; }
  };
  let utc = new Date(guess.getTime() - offsetAt(guess));
  utc = new Date(guess.getTime() - offsetAt(utc));
  return utc;
}

async function providerFetch(p: MeetingProvider, url: string, tok: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const detail = String((data && (data.message || (data.error && (data.error.message || data.error.code || data.error)))) || text || '').slice(0, 300);
    const err = new MeetingError('provider_error', `${providerName(p)} couldn't do that (${res.status}). ${detail}`.trim());
    (err as any).status = res.status;
    throw err;
  }
  return data;
}

export async function createMeeting(p: MeetingProvider, tok: string, input: MeetingInput): Promise<{ link: string; externalId: string }> {
  if (p === 'zoom') {
    const d = await providerFetch(p, `${zoomApiBase()}/v2/users/me/meetings`, tok, {
      method: 'POST',
      body: JSON.stringify({
        topic: input.title, type: 2,
        start_time: `${input.date}T${input.startTime}:00`,
        timezone: input.timezone,
        duration: input.durationMin,
      }),
    });
    if (!d || !d.join_url) throw new MeetingError('provider_error', 'Zoom did not return a meeting link.');
    return { link: String(d.join_url), externalId: String(d.id) };
  }
  if (p === 'google') {
    const d = await providerFetch(p, `${googleApiBase()}/calendar/v3/calendars/primary/events?conferenceDataVersion=1`, tok, {
      method: 'POST',
      body: JSON.stringify({
        summary: input.title,
        start: { dateTime: `${input.date}T${input.startTime}:00`, timeZone: input.timezone },
        end: { dateTime: `${input.endDate}T${input.endTime}:00`, timeZone: input.timezone },
        ...(input.roomResourceId ? { attendees: [{ email: input.roomResourceId, resource: true }] } : {}),
        conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      }),
    });
    if (!d || !d.hangoutLink) throw new MeetingError('provider_error', 'Google did not return a Meet link.');
    return { link: String(d.hangoutLink), externalId: String(d.id) };
  }
  const startUtc = wallTimeToUtc(input.date, input.startTime, input.timezone);
  const endUtc = wallTimeToUtc(input.endDate, input.endTime, input.timezone);
  const d = await providerFetch(p, `${msGraphBase()}/v1.0/me/onlineMeetings`, tok, {
    method: 'POST',
    body: JSON.stringify({ startDateTime: startUtc.toISOString(), endDateTime: endUtc.toISOString(), subject: input.title }),
  });
  if (!d || !d.joinWebUrl) throw new MeetingError('provider_error', 'Microsoft did not return a Teams link.');
  return { link: String(d.joinWebUrl), externalId: String(d.id) };
}

export async function updateMeeting(p: MeetingProvider, tok: string, externalId: string, input: MeetingInput): Promise<void> {
  if (p === 'zoom') {
    await providerFetch(p, `${zoomApiBase()}/v2/meetings/${encodeURIComponent(externalId)}`, tok, {
      method: 'PATCH',
      body: JSON.stringify({
        topic: input.title,
        start_time: `${input.date}T${input.startTime}:00`,
        timezone: input.timezone,
        duration: input.durationMin,
      }),
    });
    return;
  }
  if (p === 'google') {
    await providerFetch(p, `${googleApiBase()}/calendar/v3/calendars/primary/events/${encodeURIComponent(externalId)}`, tok, {
      method: 'PATCH',
      body: JSON.stringify({
        summary: input.title,
        start: { dateTime: `${input.date}T${input.startTime}:00`, timeZone: input.timezone },
        end: { dateTime: `${input.endDate}T${input.endTime}:00`, timeZone: input.timezone },
      }),
    });
    return;
  }
  const startUtc = wallTimeToUtc(input.date, input.startTime, input.timezone);
  const endUtc = wallTimeToUtc(input.endDate, input.endTime, input.timezone);
  await providerFetch(p, `${msGraphBase()}/v1.0/me/onlineMeetings/${encodeURIComponent(externalId)}`, tok, {
    method: 'PATCH',
    body: JSON.stringify({ startDateTime: startUtc.toISOString(), endDateTime: endUtc.toISOString(), subject: input.title }),
  });
}

export async function deleteMeeting(p: MeetingProvider, tok: string, externalId: string): Promise<void> {
  const url = p === 'zoom'
    ? `${zoomApiBase()}/v2/meetings/${encodeURIComponent(externalId)}`
    : p === 'google'
      ? `${googleApiBase()}/calendar/v3/calendars/primary/events/${encodeURIComponent(externalId)}`
      : `${msGraphBase()}/v1.0/me/onlineMeetings/${encodeURIComponent(externalId)}`;
  try {
    await providerFetch(p, url, tok, { method: 'DELETE' });
  } catch (err: any) {
    if (err && err.status === 404) return; // already gone — that's success
    throw err;
  }
}

/** Best-effort external delete used by session delete/replace paths:
 *  never throws, just logs. */
export async function deleteExternalMeetingQuiet(companyId: string, provider: any, externalId: any): Promise<void> {
  if (!isMeetingProvider(provider) || !externalId) return;
  try {
    const token = await getValidAccessToken(companyId, provider);
    await deleteMeeting(provider, token, String(externalId));
  } catch (err) {
    console.error(`[meetings] could not delete ${provider} meeting ${externalId} for company ${companyId}:`, err);
  }
}
