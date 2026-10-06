# Quick Scheduling — Phase 1 Notes (Foundation: accounts & logins)
*Built 2026-10-05 · Status: testable locally*

## What Phase 1 delivers
Company signup, login with ID/password, password reset, company workspaces with strict
data isolation, and three roles (owner / scheduler / employee). Minimal UI: signup,
login, forgot-password, reset-password, and a logged-in home page (company + role,
user list + add-user for owner/scheduler).

## Stack choices
- **Runtime:** Node 24, TypeScript (strict), Express 4.
- **Database:** Postgres via `@electric-sql/pglite` — the real Postgres engine embedded
  in-process, persisted to `./data/pgdata`. Chosen because the build VM has no Postgres
  server and `apt install` needed interactive approval. All SQL is plain portable
  Postgres (no exotic extensions; email uniqueness via `unique index on lower(email)`).
  **Production path:** swap `src/db.ts` for a `pg` Pool pointed at managed Postgres
  (RDS/Cloud SQL/etc.) — schema and queries carry over unchanged.
- **Passwords:** `bcryptjs`, cost factor 12.
- **Sessions:** `express-session` with a custom PGlite-backed store (`src/sessionStore.ts`).
  Cookie: httpOnly, `SameSite=Lax`, `secure` = true only when `NODE_ENV=production`.
- **Rate limiting:** `express-rate-limit` — signup 5/min/IP, login 10/min/IP,
  password-reset request 5/min/IP.
- **Frontend:** plain HTML + vanilla JS in `public/` (no framework, no build step).
  All API data inserted via `textContent`/`createElement` — no `innerHTML` with
  untrusted strings. Every fetch uses `credentials: 'same-origin'`.
- **Password reset:** token = 32 random bytes (hex); only the SHA-256 hash is stored;
  1-hour expiry; single use; confirming destroys all of the user's sessions.
  No email service in Phase 1: `DEV_MODE=true` enables
  `GET /api/auth/password-reset/dev-token?email=` for testing. **Never enable in production**
  — production must email the reset link instead.

## How to run
```bash
cd ~/workspace/goals/launch-scheduling-app-as-a-multi-company-product/app
npm install            # once
cp .env.example .env   # then set SESSION_SECRET to a long random string
npm run dev            # http://localhost:3000  (set PORT in .env to change)
```
Migrations run automatically at boot. `npm run build && npm start` for a production-style run.

## Schema
- `companies(id uuid PK, name text, created_at)`
- `users(id uuid PK, company_id uuid FK→companies ON DELETE CASCADE, name, email text,
  password_hash, role CHECK IN ('owner','scheduler','employee'), created_at)`
  + `UNIQUE INDEX users_email_unique ON users (lower(email))`, index on `company_id`
- `password_reset_tokens(id uuid PK, user_id FK, token_hash, expires_at, used_at, created_at)`
- `sessions(sid text PK, sess jsonb, expire timestamptz)` + index on `expire`

## API (see API_CONTRACT.md for the binding spec)
- `POST /api/auth/signup` → 201, creates company + owner, starts session
- `POST /api/auth/login` → 200 / 401 (identical message for unknown email vs wrong password)
- `POST /api/auth/logout`, `GET /api/auth/me`
- `POST /api/auth/password-reset/request` (always 200 — no user enumeration)
- `POST /api/auth/password-reset/confirm`
- `GET /api/users`, `POST /api/users` (owner/scheduler only; scheduler cannot create owners)

## Tenant isolation
`company_id` is taken **only** from the server session — it never appears in client
input. Every user query is scoped `WHERE company_id = $sessionCompanyId`.

## Verified 2026-10-05 (live server, curl + browser-less UI checks)
- Two test companies created; company A owner saw exactly A's 3 users, company B
  owner saw only B's 1 user — no cross-company leakage.
- Employee `GET /api/users` → 403; scheduler creating an `owner` → 403;
  anonymous `GET /api/users` → 401.
- Wrong password and unknown email → identical 401 message.
- Password reset: request → dev-token → confirm → new password logs in; old session
  invalidated (401); token reuse → 400.
- Login rate limit trips at 10/min/IP. Cookie flags verified (httpOnly, SameSite=Lax,
  secure=false in dev).
- Pages: login/signup/forgot/reset → 200; `/home.html` redirects anonymous → login,
  serves 200 when authed.
- All test data wiped afterward (`data/` and `.env` removed) — the app ships with
  zero data; migrations re-run cleanly at next boot.

## What's left / untested
- No real email sending (reset link delivery is DEV_MODE-only) — needs an email
  provider before any real user touches it.
- `secure` cookie flag and HTTPS termination untested (local dev is HTTP).
- No CSRF tokens yet (SameSite=Lax only) — add before production.
- No audit logging, no account lockout after repeated failures (rate limiting only).
- `SESSION_SECRET` dev default warns but still boots — production must set it.
- Accessibility and broader browser testing of the pages not done.
- Contract deviation: `express-session@^4.2.0` doesn't exist — pinned `^1.18.0`.
