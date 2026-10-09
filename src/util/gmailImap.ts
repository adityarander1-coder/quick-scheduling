/**
 * Gmail IMAP client for server-side inbox polling.
 * Uses App Password auth - no OAuth/Google Cloud needed.
 */

import Imap from 'imap';
import { simpleParser } from 'mailparser';

export interface ImapMessage {
  uid: string;
  subject: string;
  from: string;
  date: string;
  body: string;
}

function getConfig() {
  const user = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!user || !password) {
    throw new Error('Gmail IMAP not configured: missing GMAIL_USER or GMAIL_APP_PASSWORD');
  }
  return { user, password };
}

function connect(): Promise<Imap> {
  const { user, password } = getConfig();
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
export async function listUnreadUids(maxResults = 10): Promise<number[]> {
  const imap = await connect();
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
export async function getImapMessage(uid: number): Promise<ImapMessage> {
  const imap = await connect();
  try {
    await new Promise<void>((resolve, reject) => {
      imap.openBox('INBOX', false, (err) => err ? reject(err) : resolve());
    });

    const msg: ImapMessage = await new Promise((resolve, reject) => {
      const f = imap.fetch(uid, { bodies: '' });
      f.on('message', (imapMsg) => {
        imapMsg.on('body', async (stream: any) => {
          try {
            const parsed: any = await simpleParser(stream as any);
            resolve({
              uid: String(uid),
              subject: parsed.subject || '',
              from: parsed.from?.text || '',
              date: parsed.date?.toISOString() || '',
              body: (parsed.text || '').substring(0, 10000),
            });
          } catch (e) {
            reject(e);
          }
        });
      });
      f.once('error', reject);
      f.once('end', () => reject(new Error('No message body received')));
    });
    return msg;
  } finally {
    imap.end();
  }
}

/** Mark a message as seen */
export async function markImapAsRead(uid: number): Promise<void> {
  const imap = await connect();
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
