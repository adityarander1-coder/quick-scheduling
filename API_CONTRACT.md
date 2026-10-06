# Quick Scheduling — Phase 1 API Contract
Binding contract for backend and frontend builders. Do not deviate without coordinator approval.

## Base
- Backend: Node 24, TypeScript (strict), Express 4, `@electric-sql/pglite` (real Postgres engine, embedded; data persisted to `./data/pgdata`), `bcryptjs`, `express-session` with a custom PGlite-backed session store, `express-rate-limit`, `dotenv`.
  Production path: swap `src/db.ts` to a `pg` Pool against managed Postgres — same SQL, no schema changes (documented in PHASE1_NOTES.md).
- All queries parameterized (`$1`, `$2`, …). Never interpolate values into SQL.
- `company_id` ALWAYS comes from the server session. Never accept it from client input.
- Errors: JSON `{ "error": "human message" }` with correct status. No stack traces to clients.
- Session cookie: httpOnly, sameSite=lax, secure=false for local dev (MUST be true in production — note in PHASE1_NOTES.md).

## Database (Postgres)
Migrations in `migrations/` run in filename order at boot (`001_*.sql`, `002_*.sql`, …).
UUIDs generated in Node (`crypto.randomUUID()`), stored as `uuid`.

- `companies(id uuid PK, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`
- `users(id uuid PK, company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL, email text NOT NULL, password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','scheduler','employee')),
  created_at timestamptz NOT NULL DEFAULT now())`
  - `CREATE UNIQUE INDEX users_email_unique ON users (lower(email));` — login compares `lower(email) = lower($1)`.
  - index on `users(company_id)`.
- `password_reset_tokens(id uuid PK, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now())`
- sessions table: managed by a small custom session store backed by PGlite (table `sessions(sid text PK, sess jsonb NOT NULL, expire timestamptz NOT NULL)`), created by migration `002_sessions.sql`.

## Auth endpoints (`/api/auth/...`)
- `POST /api/auth/signup` `{companyName, contactName, email, password}` → `201 {user:{id,name,email,role}, company:{id,name}}`, sets session.
  Validate: all required, email format, password ≥ 10 chars. `409` if email taken.
  Creates company + first user with role `owner`. Rate limit: 5/min/IP.
- `POST /api/auth/login` `{email, password}` → `200 {user, company}` (same shape). `401` on bad credentials (same message either way). Rate limit: 10/min/IP.
- `POST /api/auth/logout` → `200 {ok:true}`, destroys session.
- `GET /api/auth/me` → `200 {user:{id,name,email,role}, company:{id,name}}` or `401 {error}`.
- `POST /api/auth/password-reset/request` `{email}` → always `200 {ok:true}` (no user enumeration).
  Creates token (32 random bytes, hex), stores SHA-256 hash, expires in 1 hour. Rate limit: 5/min/IP.
  DEV ONLY (only when `DEV_MODE=true`): `GET /api/auth/password-reset/dev-token?email=` → `200 {token}` so the flow is testable without email. Never enable in production.
- `POST /api/auth/password-reset/confirm` `{token, newPassword}` → `200 {ok:true}` or `400` (invalid/expired/used). Marks token used, destroys all sessions for that user.

## User management (`/api/users`) — session company scope
- `GET /api/users` → `200 {users:[{id,firstName,lastName,name,nickname,email,phone,departmentId,department,jobRole,role,endDate,isActive,inviteStatus,createdAt}]}` for the caller's company. Any authenticated user (employees read-only). `inviteStatus`: `not_sent`|`sent`|`expired`|`accepted`|null.
- `POST /api/users` `{firstName, lastName?, email, role, nickname?, phone?, departmentId?, jobRole?}` (also accepts legacy `{name}` which is split on the first space) → `201 {user, inviteLink}`. **Invite flow — no password is set by the admin**: the new member gets an unusable password hash and a 7-day invite link (`/accept-invite.html?token=…`, SHA-256 hash stored). Rules: owner may create any role; scheduler may create `scheduler`|`employee` only (not `owner`). `409` if email taken.
- `PATCH /api/users/:id` — profile updates; accepts `firstName`/`lastName` (or legacy `name`, split). Employees may edit only their own `phone`/`nickname`.
- `POST /api/users/:id/reinvite` → `200 {inviteLink}` — fresh invite link (invalidates prior unused links, status resets to "not sent"). Blocked once the member accepted.
- `POST /api/users/:id/invite-link` → `200 {inviteLink}` — get a valid link to copy/share later (mints a fresh link; raw tokens are never stored). Same effect as reinvite.
- `POST /api/users/:id/invite-sent` → `200 {ok:true}` — mark the current invite as sent (`404` if none unsent).
- `POST /api/users/:id/send-invite` → `200 {ok:true, inviteLink}` — emails the invite link via SMTP (nodemailer; `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_SECURE` env). `503 {error:"Email sending is not set up yet."}` when SMTP is unconfigured (UI falls back to copy-link). Marks invite "sent" on success.

## Invites (`/api/invites`) — public, token is the credential, rate-limited
- `GET /api/invites/info?token=` → `200 {companyName, firstName, lastName, name}` or `400` ("This invite link is invalid or has expired.").
- `POST /api/invites/accept` `{token, password}` → sets the password (strict policy enforced), marks invite used, signs the member in → `200 {user, company}`. `400` for invalid/used/expired token or weak password.

## Pages (static files in `public/`, plain HTML + fetch to the API above)
- `GET /` → backend redirects: logged in → `/home.html`, else `/login.html`.
- `signup.html` — company + owner account form → POST signup → redirect `/home.html`.
- `login.html` — email/password → POST login → redirect `/home.html`; link to forgot.
- `forgot.html` — email → POST reset request → "check your email" message (in DEV_MODE show hint that token is in server log/dev endpoint).
- `reset.html?token=...` — new password → POST confirm → redirect `/login.html`.
- `home.html` — requires login (backend redirects anonymous to `/login.html`): shows company name, logged-in name + role; if owner/scheduler: user list + add-user form; logout button.
- `team.html` — "Team members" directory (all roles read it; owner/scheduler manage): add/edit/deactivate, departments manager, invite-link box with copy/send/mark-sent actions, invite status badges (Invite not sent / Invite sent / Invite expired / Active / Inactive).
- `candidates.html` — owner/scheduler only: candidate intake queue (pending/approved/declined), approve/decline, shareable apply link.
- `apply.html?c=<company_id>` — public candidate application form (email required, phone optional).
- `accept-invite.html?token=…` — public: new team member sets their own password (strict policy + strength meter), then lands on `/home.html`.
- Keep styling minimal but clean. No frameworks.

## Env (`.env`, never committed; `.env.example` committed)
`DATABASE_URL`, `SESSION_SECRET` (dev default allowed with startup warning), `PORT` (default 3000), `DEV_MODE` (true/false).
SMTP (optional; enables invite emails): `SMTP_HOST`, `SMTP_PORT` (default 587), `SMTP_SECURE` ("true" for 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.

## npm scripts
`dev` (tsx watch), `build` (tsc), `start` (node dist), `migrate` (run pending migrations — also auto-run at boot).
