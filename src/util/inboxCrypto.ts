// util/inboxCrypto.ts — encrypt per-company Gmail app passwords at rest.
// AES-256-GCM with a server-side key. The key comes from COMPANY_INBOX_KEY
// (64 hex chars = 32 bytes); if it is unset, fall back to a SHA-256 of
// SESSION_SECRET so pilots still work — but log a loud warning, because
// rotating SESSION_SECRET would then orphan every stored inbox password.
// Format: base64(iv 12 bytes) + ':' + base64(auth tag 16 bytes) + ':' + base64(ciphertext).
import crypto from 'crypto';

function getKey(): Buffer {
  const hex = process.env.COMPANY_INBOX_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  const fallback = process.env.SESSION_SECRET;
  if (!fallback) throw new Error('No inbox encryption key: set COMPANY_INBOX_KEY or SESSION_SECRET');
  console.warn('[inbox-crypto] WARNING: COMPANY_INBOX_KEY not set — deriving inbox key from SESSION_SECRET. Set COMPANY_INBOX_KEY in Render before real customers connect inboxes.');
  return crypto.createHash('sha256').update(fallback).digest();
}

export function encryptInboxPassword(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptInboxPassword(enc: string): string {
  const key = getKey();
  const parts = String(enc).split(':');
  if (parts.length !== 3) throw new Error('Stored inbox password is not in the expected encrypted format');
  const iv = Buffer.from(parts[0], 'base64');
  const tag = Buffer.from(parts[1], 'base64');
  const ct = Buffer.from(parts[2], 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** True when a dedicated inbox key is configured (production-ready state). */
export function hasDedicatedInboxKey(): boolean {
  return !!process.env.COMPANY_INBOX_KEY && /^[0-9a-fA-F]{64}$/.test(process.env.COMPANY_INBOX_KEY);
}
