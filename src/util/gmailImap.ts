/**
 * Gmail IMAP client for server-side inbox polling.
 * Uses App Password auth - no OAuth/Google Cloud needed.
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';

export interface ImapAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** File bytes, or null when the file is too large to process (> 8 MB). */
  content: Buffer | null;
}

export interface ImapMessage {
  uid: string;
  subject: string;
  from: string;
  fromName: string;
  cc: string;
  date: string;
  body: string;
  attachments: ImapAttachment[];
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;

/** Credentials for one company's mailbox. When omitted, the legacy single
 *  inbox from env vars (GMAIL_USER / GMAIL_APP_PASSWORD) is used. */
export interface ImapCreds { user: string; password: string; }

function getConfig(creds?: ImapCreds) {
  if (creds && creds.user && creds.password) return creds;
  const user = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!user || !password) {
    throw new Error('Gmail IMAP not configured: missing GMAIL_USER or GMAIL_APP_PASSWORD');
  }
  return { user, password };
}

function connect(creds?: ImapCreds): Promise<Imap> {
  const { user, password } = getConfig(creds);
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

/** List UIDs of unread messages in INBOX */
export async function listUnreadUids(maxResults = 10, creds?: ImapCreds): Promise<number[]> {
  const imap = await connect(creds);
  try {
    await new Promise<void>((resolve, reject) => {
      imap.openBox('INBOX', false, (err) => err ? reject(err) : resolve());
    });
    const uids: number[] = await new Promise((resolve, reject) => {
      imap.search(['UNSEEN'], (err, results) => err ? reject(err) : resolve(results || []));
    });
    return uids.slice(-maxResults);
  } finally {
    imap.end();
  }
}

/** Fetch a single message by UID */
export async function getImapMessage(uid: number, creds?: ImapCreds): Promise<ImapMessage> {
  const imap = await connect(creds);
  try {
    await new Promise<void>((resolve, reject) => {
      imap.openBox('INBOX', false, (err) => err ? reject(err) : resolve());
    });

    const msg: ImapMessage = await new Promise((resolve, reject) => {
      let resolved = false;
      const f = imap.fetch(uid, { bodies: '' });
      f.on('message', (imapMsg) => {
        imapMsg.on('body', (stream: any) => {
          simpleParser(stream as any).then((parsed: any) => {
            if (resolved) return;
            resolved = true;
            const rawAtts: any[] = Array.isArray(parsed.attachments) ? parsed.attachments : [];
            const attachments: ImapAttachment[] = rawAtts.slice(0, MAX_ATTACHMENTS).map((a: any) => {
              const content: Buffer | null = a?.content && Buffer.isBuffer(a.content) ? a.content : null;
              return {
                filename: String(a?.filename || 'attachment'),
                contentType: String(a?.contentType || ''),
                size: typeof a?.size === 'number' ? a.size : (content ? content.length : 0),
                content: content && content.length <= MAX_ATTACHMENT_BYTES ? content : null,
              };
            });
            resolve({
              uid: String(uid),
              subject: parsed.subject || '',
              from: parsed.from?.text || '',
              fromName: parsed.from?.value?.[0]?.name || '',
              cc: parsed.cc?.text || '',
              date: parsed.date?.toISOString() || '',
              body: (parsed.text || '').substring(0, 10000),
              attachments,
            });
          }).catch((e: any) => {
            if (!resolved) {
              resolved = true;
              reject(e);
            }
          });
        });
      });
      f.once('error', (err: any) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
      f.once('end', () => {
        // Give body parsing a moment; if still not resolved, reject
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error('No message body received'));
          }
        }, 5000);
      });
    });
    return msg;
  } finally {
    imap.end();
  }
}

/** Mark a message as seen */
export async function markImapAsRead(uid: number, creds?: ImapCreds): Promise<void> {
  const imap = await connect(creds);
  try {
    await new Promise<void>((resolve, reject) => {
      imap.openBox('INBOX', false, (err) => err ? reject(err) : resolve());
    });
    await new Promise<void>((resolve, reject) => {
      imap.addFlags(uid, ['\\Seen'], (err) => err ? reject(err) : resolve());
    });
  } finally {
    imap.end();
  }
}
