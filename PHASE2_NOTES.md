# Quick Scheduling — Phase 2 Notes (Team management)
*Built 2026-10-06 · Status: built + curl-tested locally (62 checks)*

## What Phase 2 delivers
Departments, employee profiles (nickname, phone, department, job role, end date,
active/inactive), a public candidate-intake form + admin approval queue with
duplicate/similar-name warnings, and a full Team members page. Phase 1
(signup/login/reset, tenant isolation) is unchanged except where noted below.

## Schema (migration `003_team.sql`)
- `departments(id uuid PK, company_id uuid FK→companies ON DELETE CASCADE,
  name text NOT NULL, created_at)` + unique index on `(company_id, lower(name))`
  (names unique per company, case-insensitive) + index on `company_id`.
- `users` gains: `nickname text NULL`, `phone text NULL`,
  `department_id uuid NULL FK→departments ON DELETE SET NULL`,
  `job_role text NULL` (free text, e.g. "Day Hospitalist", "Night NP" —
  **not** the system role), `end_date date NULL`
  (Phase 3: employee stops appearing in future schedules; history kept),
  `is_active boolean NOT NULL DEFAULT true`.
- `candidates(id uuid PK, company_id uuid FK→companies ON DELETE CASCADE,
  name text NOT NULL, nickname, email, phone, department_id FK→departments
  ON DELETE SET NULL, job_role, notes, status CHECK IN
  ('pending','approved','declined') DEFAULT 'pending',
  submitted_at timestamptz DEFAULT now())`
  + indexes on `company_id` and `(company_id, status)`.

## API
### Departments — `/api/departments` (session company scope)
- `GET /` → `{departments:[{id,name,createdAt}]}` — any authenticated user
  (employees read-only).
- `POST /` `{name}` → 201 — owner/scheduler. 409 on duplicate name (per company).
- `PATCH /:id` `{name}` → 200 — owner/scheduler. 404 when not in caller's company.
- `DELETE /:id` → `{ok:true}` — owner/scheduler. Members keep accounts;
  their `department_id` is cleared (FK `ON DELETE SET NULL`).

### Users — `/api/users` (extended; session company scope)
- `GET /` → `{users:[{id,name,nickname,email,phone,departmentId,department,
  jobRole,role,endDate,isActive,createdAt}]}` — **any authenticated user**
  (contract change: employees now get the read-only directory; Phase 1 returned
  403). `role` = system role; `jobRole` = clinical role. Never interchanged.
- `POST /` `{name,email,password,role,nickname?,phone?,departmentId?,jobRole?}`
  → 201 — owner/scheduler (scheduler cannot create `owner`). Now enforces the
  strict password policy (8+ chars, uppercase, digit, special) like signup.
- `PATCH /:id` — profile updates:
  - employee: only their **own** `phone`/`nickname`; any other field or target → 403.
  - scheduler: any profile field of anyone in the company **except** `role`.
  - owner: everything, including `role` (not on self).
  - `isActive:false`: deactivates immediately (all sessions destroyed); cannot
    deactivate self; cannot deactivate the company's last active owner.
  - `endDate`: `YYYY-MM-DD` or empty (clears); bad format → 400.
  - `departmentId`: must belong to the caller's company (or empty to clear).

### Candidates — `/api/candidates`
Public (no login, rate-limited):
- `GET /api/candidates/company?id=<uuid>` → `{company:{id,name}}` — resolves an
  apply link; 400/404 on bad id.
- `GET /api/candidates/departments?companyId=<uuid>` → `{departments:[{id,name}]}`.
- `POST /api/candidates`
  `{companyId,name,nickname?,email?,phone?,departmentId?,jobRole?,notes?}`
  → 201 `{candidate, company, warnings}`. `companyId` comes from the apply link
  and is validated against `companies` — the one sanctioned exception to the
  "company_id only from session" rule. Warnings never block submission.
Admin (owner/scheduler, session company scope):
- `GET /?status=pending|approved|declined|all` (default `pending`) — queue rows
  carry `warnings` computed against the company's users + other candidates.
- `PATCH /:id` — edit a **pending** candidate (400 once approved/declined).
- `POST /:id/approve` → 201 `{user, tempPassword}` — creates an `employee` user
  (copies name/nickname/phone/department/jobRole); requires an email (400
  otherwise — edit the candidate first); 409 if the email is taken. The
  16-char temp password satisfies the strict policy and is returned **once**;
  only its bcrypt hash is stored. Candidate → `approved`.
- `POST /:id/decline` → `{ok:true}` — candidate → `declined` (stays in history).

### Auth changes (`/api/auth/...`)
- `POST /api/auth/login` now rejects deactivated accounts with
  401 `This account has been deactivated. Contact your administrator.`
  (Unknown email vs wrong password still share one message.)
- `GET /api/auth/me` response `user` now also carries `nickname, phone,
  departmentId, jobRole, endDate, isActive` (additive; old clients unaffected).

## Duplicate / similar-name warnings
`src/util/names.ts` — `findNameWarnings(name, existing[])`:
- **exact**: case-insensitive full-name match → red "Duplicate" badge.
- **similar**: same last name + same first initial (case-insensitive)
  → amber "Similar" badge, e.g. "Jon Smith" vs "John Smith".
Checked on public submit (returned in the response) and on every admin queue
row (against users + other candidates in the same company). Single-token names
can only exact-match. Warnings never block anything.

## Pages (`public/`)
- `team.html` (login required) — "Team members" table (name/nickname, email,
  phone, department, job role, system role, end date, active status).
  Owner/scheduler: add-member form, edit form (incl. end date; system-role
  change owner-only), deactivate/reactivate, department manager
  (add/rename/delete). Employee: read-only table + "My profile"
  (phone/nickname only).
- `candidates.html` (owner/scheduler; server-guarded) — pending/approved/
  declined tabs, warning badges, edit form, approve (temp password shown once),
  decline; apply-link shown with copy button.
- `apply.html` (public) — `?c=<company_id>`; company-name + department lookup,
  applicant form, generic success message (warnings not shown to applicants).
- `home.html` — nav links added; stale "10 characters" password hint/client
  check updated to the strict policy; show/hide password toggle added.

## Tenant isolation & security
- Every admin query is scoped `WHERE company_id = $sessionCompanyId`
  (departments, users, candidates); cross-company ids → 404 (no existence leak).
- Public candidate endpoints validate `companyId` against `companies`; no
  session data is exposed through them.
- All queries parameterized; error JSON never leaks stacks; rate limits:
  public intake 10/min/IP, public lookups 30/min/IP (auth limits unchanged).
- Approved candidates always enter with system role `employee`; the approval
  endpoint cannot mint owners/schedulers.

## Verified 2026-10-06 (local dev server, curl — 62 checks, all passing)
- Two companies; B sees none of A's departments/users/candidates; B's
  PATCH/DELETE on A's records → 404.
- Employee: directory 200; create → 403; edit other → 403; self role/jobRole
  change → 403; self phone/nickname → 200.
- Scheduler: profile edits → 200; role change → 403. Owner: role change → 200;
  cannot deactivate self; cannot remove last active owner.
- Deactivated user: login → 401 "deactivated"; sessions destroyed;
  reactivate → login works.
- Candidate flow: public submit → queue → edit → approve (no-email → 400;
  with email → 201, temp password logs in as employee) → history tabs;
  decline → history; re-approve/re-edit → 400; warnings fire on exact
  ("Emma Employee" vs user) and similar ("Jon Smith" vs "John Smith").
- Pages: team/candidates guarded (anon → login redirect; employee →
  candidates redirect); apply.html public.
- `npx tsc --noEmit` clean; page scripts `node --check` clean.

## Known limitations / next steps
- `end_date` is stored but not yet enforced in any schedule (Phase 3).
- No audit log of who approved/deactivated whom.
- CSRF tokens, account lockout, backups still pending (see Phase 1 notes).
- Test data was wiped after verification (`data/pgdata` removed); the app
  boots with zero data.

## Update 2026-10-06 — first/last names + invite flow (no admin-set passwords)

### First + last name (`migrations/004_names.sql`)
- `users` gains `first_name` / `last_name`; the old `name` column is kept as a
  populated display value ("First Last") for backward compatibility.
- Existing rows were backfilled by splitting on the first space (single-token
  names get `last_name=''`); same split lives in `src/util/names.ts`
  (`splitName`/`joinName`) and is reused by the API.
- `POST /api/users` and `PATCH /api/users/:id` accept `firstName`/`lastName`
  (and still accept a legacy `name`, split the same way). `GET /api/users` and
  `GET /api/auth/me` return `firstName`, `lastName`, plus computed `name`.
- team.html add/edit forms now show separate First name / Last name fields.
- Candidate approval maps the candidate's `name` → first/last with the same split.
- Duplicate/similar-name warnings keep working on the combined display name.

### Invite flow (`migrations/005_invites.sql`, `src/routes/invites.ts`, `src/util/invites.ts`)
Deepika: "why we need password when adding team members?" — admins no longer
set passwords. Flow:
1. Owner/scheduler adds a member (`POST /api/users`, no password field). The
   account is created with an unusable bcrypt hash (random bytes — no password
   can ever match, so login is impossible before acceptance).
2. The API returns `inviteLink` (`/accept-invite.html?token=<64-hex>`). Tokens
   are 32 crypto-random bytes; only SHA-256 hashes are stored; links expire in
   7 days. The admin copies/shares the link manually (sending is optional).
3. The new member opens the link: `GET /api/invites/info?token=` greets them
   with company + name; they choose their own password on `accept-invite.html`
   (strict policy + strength meter, same as signup). `POST /api/invites/accept`
   sets the bcrypt hash, marks the invite used, and signs them in.
4. Used/expired/unknown tokens → `400 "This invite link is invalid or has expired."`
   Accept is rate-limited (10/min).

Invite status per member (shown in the team table STATUS column):
- `not_sent` — link generated, admin hasn't sent it ("Invite not sent", amber)
- `sent` — admin marked it sent ("Invite sent", blue)
- `expired` — link lapsed, member never accepted ("Invite expired", red)
- `accepted` — member set their password → normal "Active" (green)
- `null` — never invited (e.g. the original owner) → "Active"

Admin endpoints (owner/scheduler, own company only):
- `POST /api/users/:id/reinvite` → fresh link, invalidates prior unused links,
  resets status to "not sent". Blocked once the member accepted.
- `POST /api/users/:id/invite-link` → get a valid link to copy later. Raw
  tokens are never stored, so this mints a fresh link (same effect as reinvite).
- `POST /api/users/:id/invite-sent` → marks the current invite "sent"
  (`404` when there is no unsent invite).
- `POST /api/users/:id/send-invite` → emails the invite link (fresh token) and
  marks it "sent". See email section below.

Security preserved: tenant isolation by session `company_id` on every invite
endpoint (cross-company ids → 404), scheduler still can't create owners or
change roles, employees get 403 on all invite endpoints, no stack leaks.

### Email: mandatory for members/candidates, optional phone
- `POST /api/users` and candidate intake (`POST /api/candidates`) now require a
  valid `email` (400 otherwise); `phone` is optional everywhere. Candidate
  edit can no longer clear the email. team.html and apply.html mark Email
  required and Phone "(optional)".

### Invite emails via Gmail SMTP (temporary)
- `src/util/mailer.ts` (nodemailer). Config: `SMTP_HOST=smtp.gmail.com`,
  `SMTP_PORT=587`, `SMTP_SECURE=false` (STARTTLS), `SMTP_USER`/`SMTP_PASS`
  (Gmail address + **App Password**, not the Gmail password); From defaults to
  `SMTP_USER` (override with `SMTP_FROM`). See `.env.example`.
- `POST /api/users/:id/send-invite` sends subject
  `"[Company] invited you to join Quick Scheduling"` (plain-text + basic HTML,
  invite link + 7-day expiry note). Without SMTP config → `503
  {error:"Email sending is not set up yet."}` and team.html falls back to the
  copy-link button.
- **Gmail is temporary.** The planned long-term provider is Resend — swap the
  transport in `src/util/mailer.ts` when ready; the `sendMail` interface stays.
- Password-reset emails are still not sent; a clearly-marked `TODO(Phase 6)` in
  `src/routes/auth.ts` shows where the reset flow will hook into the mailer.

### Verified 2026-10-06 (local dev server, curl)
- Add member → invite link returned, no password in response; login before
  accept → 401; weak password on accept → 400; accept → 200 + session cookie,
  `/api/auth/me` works; token reuse → 400; expired token → 400; cross-company
  reinvite/invite-sent → 404; reinvite invalidates old token, resets to
  "not sent"; invite-sent → "sent"; send-invite without SMTP → 503;
  reinvite after accept → 400; legacy `{name}` splits on create + PATCH;
  scheduler→owner → 403; employee self firstName → 403, self phone → 200,
  employee reinvite → 403; candidate intake without email → 400; duplicate
  warning fires on exact name; approve splits name; `npx tsc --noEmit` clean.
- Note: one stale `tsx watch` process served old code mid-test (status showed
  `not_sent` for an expired invite); after a clean restart all statuses
  verified correct. If statuses ever look wrong, restart the dev server.
