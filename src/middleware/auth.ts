// middleware/auth.ts — session-based auth guards.
// company_id ALWAYS comes from req.session — never from client input.

import { Request, Response, NextFunction } from 'express';

export type Role = 'owner' | 'scheduler' | 'employee';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    companyId?: string;
    role?: Role;
  }
}

/** 401 JSON when there is no authenticated session user. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId || !req.session?.companyId) {
    res.status(401).json({ error: 'You are not signed in.' });
    return;
  }
  next();
}

/** 403 JSON when the session role is not one of the allowed roles (requires auth first). */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.session?.userId || !req.session?.companyId) {
      res.status(401).json({ error: 'You are not signed in.' });
      return;
    }
    if (!req.session.role || !roles.includes(req.session.role)) {
      res.status(403).json({ error: 'You do not have permission to do that.' });
      return;
    }
    next();
  };
}
