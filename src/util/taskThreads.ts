// util/taskThreads.ts — server-side Ask/Task conversation threads
// (Deepika, 2026-11-19 — N3 extension: "I want chat in ask task
// not to forget anything from past").
//
// One row = one conversation = one task plan, per user per company.
// The full turn list of the current conversation is stored here so
// it survives reloads and tab switches; the CURRENT pending task is
// marked as current (pending_plan_id / pending_token), so the
// fixers only ever narrow or re-scope the plan this conversation
// is about. A fresh task instruction (not a continuation of the
// current pending item) archives the current thread and starts a
// new one — the planner then never sees the old plan's dates or
// types, and the old thread stays listable for the later history
// build (New task button + reopen, after add_open_slots).
//
// Retention (Deepika, Nov 19 ~8:37 PM — she corrected 30 days to
// 15): threads older than 15 days drop out of history, enforced
// lazily on lookup — no sweeper.

export const TASK_THREAD_RETENTION_DAYS = 15;
const MAX_TURNS = 100;

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

export interface TaskTurn { q: string; a: string; }
export interface TaskThreadRow {
  id: string;
  company_id: string;
  user_id: string;
  title: string;
  thread: TaskTurn[];
  pending_plan_id: string | null;
  pending_token: string | null;
  is_current: boolean;
  created_at: any;
  updated_at: any;
}

const COLUMNS = 'id, company_id, user_id, title, thread, pending_plan_id, pending_token, is_current, created_at, updated_at';

function parseThread(row: any): TaskThreadRow {
  let thread: TaskTurn[] = [];
  try {
    const raw = typeof row.thread === 'string' ? JSON.parse(row.thread) : row.thread;
    if (Array.isArray(raw)) {
      thread = raw.filter((t: any) => t && typeof t.q === 'string').map((t: any) => ({ q: String(t.q), a: String(t.a || '') }));
    }
  } catch { thread = []; }
  return { ...row, thread };
}

async function expireOldThreads(query: QueryFn, companyId: string, userId: string): Promise<void> {
  await query(
    `DELETE FROM task_threads WHERE company_id = $1 AND user_id = $2
     AND updated_at < now() - ($3 || ' days')::interval`,
    [companyId, userId, String(TASK_THREAD_RETENTION_DAYS)]
  );
}

/** The current thread for this user+company, or null. Threads older
 * than 15 days are deleted on lookup and never returned. */
export async function loadCurrentTaskThread(
  query: QueryFn, companyId: string, userId: string,
): Promise<TaskThreadRow | null> {
  await expireOldThreads(query, companyId, userId);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM task_threads
     WHERE company_id = $1 AND user_id = $2 AND is_current
     ORDER BY updated_at DESC LIMIT 1`,
    [companyId, userId]
  );
  return rows[0] ? parseThread(rows[0]) : null;
}

/** List threads for the later history build (newest first): id,
 * title, turn count, current flag, timestamps — the full thread
 * JSON is NOT returned here, a reopen fetches one row by id. */
export async function listTaskThreads(
  query: QueryFn, companyId: string, userId: string, limit = 50,
): Promise<Array<{ id: string; title: string; turns: number; is_current: boolean; created_at: any; updated_at: any }>> {
  await expireOldThreads(query, companyId, userId);
  const { rows } = await query(
    `SELECT id, title, is_current, created_at, updated_at,
            COALESCE(jsonb_array_length(thread), 0) AS turns
     FROM task_threads
     WHERE company_id = $1 AND user_id = $2
     ORDER BY updated_at DESC LIMIT $3`,
    [companyId, userId, limit]
  );
  return rows.map((r: any) => ({
    id: r.id, title: r.title || '', turns: Number(r.turns) || 0,
    is_current: !!r.is_current, created_at: r.created_at, updated_at: r.updated_at,
  }));
}

/** Save the current thread (upsert on the current row): the turn
 * list plus the current pending markers. A null marker clears it —
 * a decided plan or a closed round leaves no current pending item.
 * Creates the row when none exists (first message). */
export async function saveCurrentTaskThread(
  query: QueryFn, companyId: string, userId: string,
  thread: TaskTurn[], opts?: { title?: string; pendingPlanId?: string | null; pendingToken?: string | null },
): Promise<TaskThreadRow> {
  const turns = (thread || []).slice(-MAX_TURNS);
  const title = (opts?.title || '').slice(0, 120);
  const pendingPlanId = opts?.pendingPlanId === undefined ? null : opts.pendingPlanId;
  const pendingToken = opts?.pendingToken === undefined ? null : opts.pendingToken;
  const { rows: updated } = await query(
    `UPDATE task_threads
     SET thread = $3::jsonb, pending_plan_id = $4, pending_token = $5,
         title = CASE WHEN $6 <> '' THEN $6 ELSE title END,
         updated_at = now()
     WHERE company_id = $1 AND user_id = $2 AND is_current
     RETURNING ${COLUMNS}`,
    [companyId, userId, JSON.stringify(turns), pendingPlanId, pendingToken, title]
  );
  if (updated[0]) return parseThread(updated[0]);
  try {
    const { rows: inserted } = await query(
      `INSERT INTO task_threads (company_id, user_id, title, thread, pending_plan_id, pending_token, is_current)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, true)
       RETURNING ${COLUMNS}`,
      [companyId, userId, title, JSON.stringify(turns), pendingPlanId, pendingToken]
    );
    return parseThread(inserted[0]);
  } catch {
    // Lost a race with another insert of the current row — retry the update.
    const { rows: retried } = await query(
      `UPDATE task_threads
       SET thread = $3::jsonb, pending_plan_id = $4, pending_token = $5,
           title = CASE WHEN $6 <> '' THEN $6 ELSE title END,
           updated_at = now()
       WHERE company_id = $1 AND user_id = $2 AND is_current
       RETURNING ${COLUMNS}`,
      [companyId, userId, JSON.stringify(turns), pendingPlanId, pendingToken, title]
    );
    if (retried[0]) return parseThread(retried[0]);
    throw new Error('Could not save the chat thread.');
  }
}

/** Load one thread by id, scoped to this user+company (history
 * reopen). Threads older than 15 days are expired on lookup and
 * never returned. */
export async function loadTaskThreadById(
  query: QueryFn, companyId: string, userId: string, threadId: string,
): Promise<TaskThreadRow | null> {
  await expireOldThreads(query, companyId, userId);
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM task_threads
     WHERE company_id = $1 AND user_id = $2 AND id = $3`,
    [companyId, userId, threadId]
  );
  return rows[0] ? parseThread(rows[0]) : null;
}

/** Make one of this user's threads the current one (history
 * reopen): every other thread is archived in the same statement,
 * so at most one row is ever current. Returns the row, or null
 * when the id is not this user's thread. */
export async function setCurrentTaskThread(
  query: QueryFn, companyId: string, userId: string, threadId: string,
): Promise<TaskThreadRow | null> {
  const existing = await loadTaskThreadById(query, companyId, userId, threadId);
  if (!existing) return null;
  await query(
    `UPDATE task_threads
     SET is_current = (id = $3),
         updated_at = CASE WHEN id = $3 THEN now() ELSE updated_at END
     WHERE company_id = $1 AND user_id = $2`,
    [companyId, userId, threadId]
  );
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM task_threads
     WHERE company_id = $1 AND user_id = $2 AND id = $3`,
    [companyId, userId, threadId]
  );
  return rows[0] ? parseThread(rows[0]) : null;
}

/** Start a fresh thread for a new task: the current thread is
 * archived (kept for the history list) and a new current row is
 * created with the given title. The caller appends the first turn
 * and saves it. */
export async function startNewTaskThread(
  query: QueryFn, companyId: string, userId: string, title: string,
): Promise<TaskThreadRow> {
  await query(
    `UPDATE task_threads SET is_current = false
     WHERE company_id = $1 AND user_id = $2 AND is_current`,
    [companyId, userId]
  );
  const { rows } = await query(
    `INSERT INTO task_threads (company_id, user_id, title, thread, pending_plan_id, pending_token, is_current)
     VALUES ($1, $2, $3, '[]'::jsonb, NULL, NULL, true)
     RETURNING ${COLUMNS}`,
    [companyId, userId, String(title || '').slice(0, 120)]
  );
  return parseThread(rows[0]);
}

/** Clear the current pending markers (plan decided, round closed)
 * without touching the turns. */
export async function clearTaskThreadPending(
  query: QueryFn, companyId: string, userId: string,
): Promise<void> {
  await query(
    `UPDATE task_threads SET pending_plan_id = NULL, pending_token = NULL, updated_at = now()
     WHERE company_id = $1 AND user_id = $2 AND is_current`,
    [companyId, userId]
  );
}

/** Clear the pending marker wherever it points at this plan — the
 * decider is often not the thread's owner (an admin approving a
 * plan from the panel or by email), so the clear keys on the plan,
 * not the user. A decided plan is no longer "the current pending
 * task", so the next fresh instruction must segment a new thread
 * instead of inheriting this plan's dates and types (Deepika,
 * 2026-11-19 — N3 extension). No-op when no thread points here. */
export async function clearTaskThreadPendingByPlan(
  query: QueryFn, companyId: string, planId: string,
): Promise<void> {
  await query(
    `UPDATE task_threads SET pending_plan_id = NULL, pending_token = NULL, updated_at = now()
     WHERE company_id = $1 AND pending_plan_id = $2`,
    [companyId, planId]
  );
}
