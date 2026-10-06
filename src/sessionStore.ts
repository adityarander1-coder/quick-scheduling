// sessionStore.ts — express-session Store backed by PGlite.
// Table `sessions(sid text PK, sess jsonb NOT NULL, expire timestamptz NOT NULL)`
// is created by migrations/002_sessions.sql.

import { Store, SessionData } from 'express-session';
import { query } from './db';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h when the cookie has no maxAge

function expiryFor(session: SessionData): Date {
  const maxAge =
    session?.cookie?.maxAge != null ? session.cookie.maxAge : DEFAULT_TTL_MS;
  return new Date(Date.now() + maxAge);
}

export class PGliteSessionStore extends Store {
  constructor() {
    super();
  }

  /** Lazily drop expired sessions each read so the table doesn't grow unboundedly. */
  private async prune(): Promise<void> {
    try {
      await query('DELETE FROM sessions WHERE expire < now()');
    } catch {
      // Best-effort; a failed prune must not break session reads/writes.
    }
  }

  get(sid: string, cb: (err: any, session?: SessionData | null) => void): void {
    this.prune()
      .then(() =>
        query<{ sess: any }>('SELECT sess FROM sessions WHERE sid = $1 AND expire > now()', [sid])
      )
      .then(({ rows }) => cb(null, rows.length ? rows[0].sess : null))
      .catch((err) => cb(err));
  }

  set(
    sid: string,
    session: SessionData,
    cb?: (err?: any) => void
  ): void {
    const expire = expiryFor(session);
    query(
      `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify(session), expire.toISOString()]
    )
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  destroy(sid: string, cb?: (err?: any) => void): void {
    query('DELETE FROM sessions WHERE sid = $1', [sid])
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }

  touch(sid: string, session: SessionData, cb?: (err?: any) => void): void {
    const expire = expiryFor(session);
    query('UPDATE sessions SET expire = $2 WHERE sid = $1', [sid, expire.toISOString()])
      .then(() => cb?.())
      .catch((err) => cb?.(err));
  }
}
