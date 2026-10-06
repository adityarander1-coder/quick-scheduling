// util/invites.ts — shared invite-token helpers.
// Used by routes/users.ts (issue/reissue/mark-sent) and routes/invites.ts (accept).
// Only SHA-256 hashes of tokens are stored; raw tokens are never persisted.

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from '../db';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Public path of the invite-accept page for a raw token. */
export function inviteLinkPath(token: string): string {
  return `/accept-invite.html?token=${encodeURIComponent(token)}`;
}

export type InviteStatus = 'not_sent' | 'sent' | 'expired' | 'accepted' | null;

/**
 * Derive a member's invite status from the latest invite row.
 * Row shape comes from the LATERAL subquery in users.PROFILE_SELECT
 * (inv_used: boolean|null, inv_sent_at, inv_expires_at).
 */
export function inviteStatusFrom(row: {
  inv_used: boolean | null;
  inv_sent_at: any;
  inv_expires_at: any;
}): InviteStatus {
  if (row.inv_used === null || row.inv_used === undefined) return null; // never invited
  if (row.inv_used) return 'accepted';
  const exp = row.inv_expires_at ? new Date(row.inv_expires_at).getTime() : 0;
  if (!exp || exp <= Date.now()) return 'expired';
  return row.inv_sent_at ? 'sent' : 'not_sent';
}

/**
 * Issue a fresh invite for a user: deletes prior UNUSED invites (so only one
 * live link exists), inserts a new row, and returns the raw token + link path.
 * Status resets to "not sent" (sent_at is NULL until the admin marks it sent).
 */
export async function issueInvite(
  userId: string,
  companyId: string
): Promise<{ token: string; inviteLink: string }> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await query(
    `DELETE FROM invites WHERE user_id = $1 AND company_id = $2 AND used_at IS NULL`,
    [userId, companyId]
  );
  await query(
    `INSERT INTO invites (id, user_id, company_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [crypto.randomUUID(), userId, companyId, tokenHash, expiresAt.toISOString()]
  );
  return { token, inviteLink: inviteLinkPath(token) };
}

/** A bcrypt hash of random bytes — valid format, but no password can ever match it. */
export async function unusablePasswordHash(): Promise<string> {
  return bcrypt.hash(crypto.randomBytes(64).toString('hex'), 12);
}
