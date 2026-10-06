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
- No email sending: the temp password must be handed to the hire manually;
  the reset flow is still DEV_MODE-only.
- `end_date` is stored but not yet enforced in any schedule (Phase 3).
- No audit log of who approved/deactivated whom.
- CSRF tokens, account lockout, backups still pending (see Phase 1 notes).
- Test data was wiped after verification (`data/pgdata` removed); the app
  boots with zero data.
