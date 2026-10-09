/**
 * Gmail OAuth and API client for server-side inbox polling.
 * Uses OAuth2 refresh token flow - tokens stored as env vars on Render.
 */

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

let cachedAccessToken: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedAccessToken && Date.now() < tokenExpiry - 60000) {
    return cachedAccessToken;
  }

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth not configured: missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`Gmail token refresh failed: ${res.status}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedAccessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);
  return cachedAccessToken;
}

async function gmailFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Gmail API error ${res.status} on ${path}`);
  }
  return res.json();
}

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  body: string;
  snippet: string;
}

/** List unread messages in the inbox */
export async function listUnreadMessages(maxResults = 10): Promise<string[]> {
  const data = await gmailFetch(`/users/me/messages?q=is:unread&maxResults=${maxResults}`);
  return (data.messages || []).map((m: any) => m.id);
}

/** Get full message details including body */
export async function getMessage(messageId: string): Promise<GmailMessage> {
  const data = await gmailFetch(`/users/me/messages/${messageId}?format=full`);
  
  const headers = data.payload?.headers || [];
  const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  
  // Extract body - try plain text first, fall back to snippet
  let body = '';
  const extractBody = (payload: any): string => {
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const text = extractBody(part);
        if (text) return text;
      }
    }
    return '';
  };
  
  body = extractBody(data.payload) || data.snippet || '';

  return {
    id: data.id,
    threadId: data.threadId,
    subject: getHeader('subject'),
    from: getHeader('from'),
    date: getHeader('date'),
    body: body.substring(0, 10000), // Limit body size
    snippet: data.snippet || '',
  };
}

/** Mark a message as read */
export async function markAsRead(messageId: string): Promise<void> {
  const token = await getAccessToken();
  await fetch(`${GMAIL_API}/users/me/messages/${messageId}/modify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });
}

/** Generate OAuth authorization URL for initial setup */
export function getAuthUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** Exchange authorization code for tokens (initial setup only) */
export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}
