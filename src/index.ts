// index.ts — Quick Scheduling Phase 1 backend.
// Auth: session cookie (httpOnly, sameSite=lax; secure=true only in production).
// Pages in public/ are static; / and /home.html get server-side auth routing.

import dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import { ensureReady } from './db';
import { PGliteSessionStore } from './sessionStore';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import departmentsRouter from './routes/departments';
import candidatesRouter from './routes/candidates';

import invitesRouter from './routes/invites';
import scheduleRouter from './routes/schedule';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // Trust Render's reverse proxy so req.secure is true on HTTPS (required for the Secure session cookie).
app.disable('x-powered-by');
app.use(express.json());

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret =
    'dev-insecure-secret-change-me-' +
    (process.env.PORT || '3000');
  console.warn(
    '[session] SESSION_SECRET is not set — using an insecure dev default. Set SESSION_SECRET in .env (required in production).'
  );
}

app.use(
  session({
    name: 'qs.sid',
    store: new PGliteSessionStore(),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProd, // MUST be true in production (contract + PHASE1_NOTES.md)
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);

if (!isProd) {
  console.warn(
    '[session] secure=false on the session cookie (local dev). In production set NODE_ENV=production so secure=true.'
  );
}

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/departments', departmentsRouter);
app.use('/api/candidates', candidatesRouter);
app.use('/api/invites', invitesRouter);
app.use('/api/schedule', scheduleRouter);

// GET / → /home.html when signed in, else /login.html.
app.get('/', (req: Request, res: Response) => {
  if (req.session?.userId) res.redirect('/home.html');
  else res.redirect('/login.html');
});

// Guard logged-in pages server-side: anonymous visitors are bounced to /login.html.
// /apply.html is public (candidate intake); /team.html needs any login;
// /candidates.html needs owner/scheduler (checked again in the API).
app.get('/home.html', (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.userId) {
    res.redirect('/login.html');
    return;
  }
  next();
});
app.get('/team.html', (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.userId) {
    res.redirect('/login.html');
    return;
  }
  next();
});
app.get('/schedule.html', (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.userId) {
    res.redirect('/login.html');
    return;
  }
  next();
});
app.get('/rotations.html', (req: Request, res: Response, next: NextFunction) => {
  const role = req.session?.role;
  if (!req.session?.userId || (role !== 'owner' && role !== 'scheduler')) {
    res.redirect('/login.html');
    return;
  }
  next();
});
app.get('/settings.html', (req: Request, res: Response, next: NextFunction) => {
  const role = req.session?.role;
  if (!req.session?.userId || (role !== 'owner' && role !== 'scheduler')) {
    res.redirect('/login.html');
    return;
  }
  next();
});
app.get('/candidates.html', (req: Request, res: Response, next: NextFunction) => {
  const role = req.session?.role;
  if (!req.session?.userId || (role !== 'owner' && role !== 'scheduler')) {
    res.redirect('/login.html');
    return;
  }
  next();
});

app.use(express.static(path.resolve(__dirname, '..', 'public')));

// JSON 404 for anything under /api not matched above.
app.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found.' });
});

// Generic error handler — never leaks stack traces to clients.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[app] unhandled error:', err);
  res.status(err?.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

async function main(): Promise<void> {
  await ensureReady(); // auto-runs pending migrations at boot
  app.listen(PORT, () => {
    console.log(`[app] Quick Scheduling listening on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[app] failed to start:', err);
    process.exit(1);
  });
}

export default app;
