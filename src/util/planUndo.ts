// util/planUndo.ts — undo for approved Q-Scheduler tasks (Deepika
// 2026-11-01: "ctrl z should apply for tasks if possible — not just
// the drag").
//
// How it works: executePlanWithUndo snapshots the plan-touchable
// tables (in memory) before and after executePlan runs, diffs them,
// and stores ONLY the changed rows (before + after) on the plan as
// its undo payload. Undo then:
//   1. verifies every changed row is still EXACTLY as the task left
//      it — if anything was changed again afterwards, it refuses
//      with a plain reason and undoes nothing;
//   2. checks nothing newer depends on rows the task created (a new
//      team member who has since been given shifts, etc.);
//   3. restores the before state in one transaction.
// Executions for one company are serialized in-process so two
// approvals landing at the same moment can't cross-attribute changes.

import { query, withTransaction } from '../db.js';
import { executePlan } from './planExecutor.js';

type Row = Record<string, any>;

interface TableDef { name: string; key: string[]; columns: string[]; scoped: boolean }

const TABLES: TableDef[] = [
  { name: 'departments', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'name', 'created_at'] },
  { name: 'job_roles', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'department_id', 'name', 'created_at'] },
  { name: 'shift_types', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'name', 'color', 'department_id', 'eligible_job_role_ids', 'is_active'] },
  { name: 'users', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'first_name', 'last_name', 'nickname', 'email', 'phone',
              'department_id', 'job_role', 'job_role_id', 'role', 'is_active', 'end_date'] },
  { name: 'academic_sessions', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'title', 'lecturer_user_id', 'department_id', 'session_date',
              'start_time', 'end_time', 'location', 'kind', 'notes', 'created_by', 'dashboard_id',
              'recur_rule', 'recur_until', 'supervisor_user_id', 'recur_days', 'recur_interval',
              'recur_count', 'meeting_url', 'created_at'] },
  { name: 'shifts', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'user_id', 'shift_type_id', 'date', 'notes', 'published',
              'created_by', 'created_at', 'updated_at'] },
  { name: 'rotation_shift_exclusions', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'rotation_id', 'user_id', 'date', 'shift_type_id', 'created_at'] },
  { name: 'academic_session_overrides', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'session_id', 'date', 'lecturer_user_id', 'supervisor_user_id',
              'location', 'meeting_url', 'start_time', 'end_time', 'cancelled', 'has_lecturer',
              'has_supervisor', 'has_location', 'has_meeting_url', 'has_times', 'created_at', 'updated_at'] },
  { name: 'staffing_targets', key: ['id'], scoped: true,
    columns: ['id', 'company_id', 'shift_type_id', 'target_count', 'weekdays', 'start_date', 'end_date', 'created_at'] },
  { name: 'shift_type_departments', key: ['shift_type_id', 'department_id'], scoped: false,
    columns: ['shift_type_id', 'department_id'] },
];
const defOf = (name: string) => TABLES.find((t) => t.name === name)!;

function norm(v: any): any {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    const o: Row = {};
    for (const k of Object.keys(v).sort()) o[k] = norm(v[k]);
    return o;
  }
  return v;
}
const keyOf = (def: TableDef, row: Row) => def.key.map((k) => String(row[k])).join('|');
const keyObjOf = (def: TableDef, row: Row) => {
  const o: Row = {};
  for (const k of def.key) o[k] = row[k];
  return o;
};

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

async function capture(q: QueryFn, companyId: string): Promise<Map<string, Map<string, Row>>> {
  const snap = new Map<string, Map<string, Row>>();
  for (const def of TABLES) {
    const where = def.scoped
      ? 'company_id = $1'
      : 'shift_type_id IN (SELECT id FROM shift_types WHERE company_id = $1)';
    const { rows } = await q(`SELECT ${def.columns.join(', ')} FROM ${def.name} WHERE ${where}`, [companyId]);
    const m = new Map<string, Row>();
    for (const r of rows) m.set(keyOf(def, r), norm(r));
    snap.set(def.name, m);
  }
  return snap;
}

export interface UndoEntry { table: string; key: Row; before: Row | null; after: Row | null }
export interface UndoPayload { v: 1; entries: UndoEntry[] }

function diff(before: Map<string, Map<string, Row>>, after: Map<string, Map<string, Row>>): UndoEntry[] {
  const entries: UndoEntry[] = [];
  for (const def of TABLES) {
    const b = before.get(def.name)!;
    const a = after.get(def.name)!;
    for (const k of new Set([...b.keys(), ...a.keys()])) {
      const br = b.get(k) ?? null;
      const ar = a.get(k) ?? null;
      if (JSON.stringify(br) === JSON.stringify(ar)) continue;
      entries.push({ table: def.name, key: keyObjOf(def, (ar ?? br)!), before: br, after: ar });
    }
  }
  return entries;
}

// Serialize plan executions per company (single-instance server), so
// concurrent approvals can't pollute each other's before/after diff.
const chains = new Map<string, Promise<any>>();
function serialized<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(companyId) || Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(companyId, run.then(() => undefined, () => undefined));
  return run;
}

/** Execute a plan and capture the undo payload for what it changed. */
export async function executePlanWithUndo(
  companyId: string,
  plan: { changes: any[] },
  executedBy: string
): Promise<{ results: any[]; undo: UndoPayload | null }> {
  return serialized(companyId, async () => {
    const before = await capture(query, companyId);
    const results = await executePlan(companyId, plan, executedBy);
    const after = await capture(query, companyId);
    const entries = diff(before, after);
    const anySuccess = (results || []).some((r: any) => r.success);
    return { results, undo: anySuccess && entries.length ? { v: 1, entries } : null };
  });
}

async function fetchRow(q: QueryFn, def: TableDef, companyId: string, key: Row): Promise<Row | null> {
  const conds = def.key.map((k, i) => `${k} = $${i + 1}`);
  const params: any[] = def.key.map((k) => key[k]);
  let sql = `SELECT ${def.columns.join(', ')} FROM ${def.name} WHERE ${conds.join(' AND ')}`;
  if (def.scoped) { sql += ` AND company_id = $${params.length + 1}`; params.push(companyId); }
  const { rows } = await q(sql, params);
  return rows.length ? norm(rows[0]) : null;
}

const REFUSAL = 'Something this task changed was changed again afterwards, so it can’t be undone cleanly. Nothing was undone.';
const DEPENDENT = 'Something newer depends on what this task created, so it can’t be undone cleanly. Nothing was undone.';

/** Replay a plan's undo payload. Throws Error with a plain reason on refusal. */
export async function undoPlanChanges(companyId: string, payload: UndoPayload): Promise<{ restored: number }> {
  const entries = payload?.entries || [];
  if (!entries.length) throw new Error('Nothing to undo.');
  try {
    return await undoInTransaction(companyId, entries);
  } catch (err: any) {
    // Known refusals pass through; a unique-key collision during the
    // restore means the world moved on (same refusal); anything else
    // still rolls back, so the honest summary is the clean-failure one.
    if (err?.message === REFUSAL || err?.message === DEPENDENT || err?.message === 'Nothing to undo.') throw err;
    if (err?.code === '23505') throw new Error(REFUSAL);
    throw new Error('This task can’t be undone cleanly. Nothing was undone.');
  }
}

async function undoInTransaction(companyId: string, entries: UndoEntry[]): Promise<{ restored: number }> {
  return withTransaction(async (tx) => {
    const q: QueryFn = tx.query as QueryFn;
    // 1) Everything the task left behind must still be exactly as it was.
    //    Both sides go through norm(): the stored payload round-tripped
    //    through JSONB, which does not preserve object key order.
    for (const e of entries) {
      const cur = await fetchRow(q, defOf(e.table), companyId, e.key);
      if (JSON.stringify(norm(cur)) !== JSON.stringify(norm(e.after))) throw new Error(REFUSAL);
      // A row the task deleted can only come back if its natural slot
      // is still free (someone may have re-created the same shift by
      // hand — that newer row is theirs, so the undo refuses).
      if (e.table === 'shifts' && e.before && !e.after) {
        const { rows } = await q(
          'SELECT id FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 AND id <> $5',
          [companyId, e.before.user_id, String(e.before.date).slice(0, 10), e.before.shift_type_id, e.before.id]
        );
        if (rows.length) throw new Error(REFUSAL);
      }
    }
    // 2) Rows the task created: refuse if anything newer depends on them.
    const diffIds = (table: string) => new Set(entries.filter((e) => e.table === table).map((e) => String(e.key.id)));
    for (const e of entries) {
      if (e.before) continue;
      const id = e.key.id;
      if (!id) continue;
      if (e.table === 'users') {
        const { rows } = await q('SELECT id FROM shifts WHERE user_id = $1', [id]);
        if (rows.some((r: any) => !diffIds('shifts').has(String(r.id)))) throw new Error(DEPENDENT);
        const { rows: s } = await q('SELECT id FROM academic_sessions WHERE lecturer_user_id = $1 OR supervisor_user_id = $1', [id]);
        if (s.some((r: any) => !diffIds('academic_sessions').has(String(r.id)))) throw new Error(DEPENDENT);
      } else if (e.table === 'departments') {
        const checks: Array<[string, string, string]> = [
          ['job_roles', 'department_id', 'job_roles'],
          ['users', 'department_id', 'users'],
          ['shift_types', 'department_id', 'shift_types'],
        ];
        for (const [table, col, diffTable] of checks) {
          const { rows } = await q(`SELECT id FROM ${table} WHERE ${col} = $1`, [id]);
          if (rows.some((r: any) => !diffIds(diffTable).has(String(r.id)))) throw new Error(DEPENDENT);
        }
      } else if (e.table === 'job_roles') {
        const { rows } = await q('SELECT id FROM users WHERE job_role_id = $1', [id]);
        if (rows.some((r: any) => !diffIds('users').has(String(r.id)))) throw new Error(DEPENDENT);
        const { rows: s } = await q('SELECT id FROM shift_types WHERE $1 = ANY(eligible_job_role_ids)', [id]);
        if (s.some((r: any) => !diffIds('shift_types').has(String(r.id)))) throw new Error(DEPENDENT);
      } else if (e.table === 'shift_types') {
        const { rows } = await q('SELECT id FROM shifts WHERE shift_type_id = $1', [id]);
        if (rows.some((r: any) => !diffIds('shifts').has(String(r.id)))) throw new Error(DEPENDENT);
        const { rows: ra } = await q('SELECT id FROM rotation_assignments WHERE shift_type_id = $1', [id]);
        if (ra.length) throw new Error(DEPENDENT);
        const { rows: tg } = await q('SELECT id FROM staffing_targets WHERE shift_type_id = $1', [id]);
        if (tg.some((r: any) => !diffIds('staffing_targets').has(String(r.id)))) throw new Error(DEPENDENT);
        const linkKeys = new Set(entries.filter((x) => x.table === 'shift_type_departments').map((x) => `${x.key.shift_type_id}|${x.key.department_id}`));
        const { rows: lk } = await q('SELECT shift_type_id, department_id FROM shift_type_departments WHERE shift_type_id = $1', [id]);
        if (lk.some((r: any) => !linkKeys.has(`${r.shift_type_id}|${r.department_id}`))) throw new Error(DEPENDENT);
      } else if (e.table === 'academic_sessions') {
        const { rows } = await q('SELECT id FROM academic_session_overrides WHERE session_id = $1', [id]);
        if (rows.some((r: any) => !diffIds('academic_session_overrides').has(String(r.id)))) throw new Error(DEPENDENT);
      }
    }
    // 3a) Restore rows that existed before the task (re-insert or update),
    //     parents before dependents.
    const RESTORE_FIRST = ['departments', 'job_roles', 'shift_types', 'users', 'academic_sessions',
      'shifts', 'rotation_shift_exclusions', 'academic_session_overrides', 'staffing_targets', 'shift_type_departments'];
    for (const name of RESTORE_FIRST) {
      const def = defOf(name);
      for (const e of entries.filter((x) => x.table === name && x.before)) {
        const cur = await fetchRow(q, def, companyId, e.key);
        const cols = def.columns;
        if (!cur) {
          await q(
            `INSERT INTO ${def.name} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')})`,
            cols.map((c) => e.before![c] ?? null)
          );
        } else {
          const setCols = cols.filter((c) => !def.key.includes(c));
          await q(
            `UPDATE ${def.name} SET ${setCols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
             WHERE ${def.key.map((k, i) => `${k} = $${setCols.length + i + 1}`).join(' AND ')}${def.scoped ? ` AND company_id = $${setCols.length + def.key.length + 1}` : ''}`,
            [...setCols.map((c) => e.before![c] ?? null), ...def.key.map((k) => e.key[k]), ...(def.scoped ? [companyId] : [])]
          );
        }
      }
    }
    // 3b) Delete rows the task created, dependents before parents.
    const DELETE_FIRST = ['shift_type_departments', 'staffing_targets', 'rotation_shift_exclusions',
      'academic_session_overrides', 'shifts', 'academic_sessions', 'users', 'shift_types', 'job_roles', 'departments'];
    for (const name of DELETE_FIRST) {
      const def = defOf(name);
      for (const e of entries.filter((x) => x.table === name && !x.before)) {
        const conds = def.key.map((k, i) => `${k} = $${i + 1}`);
        const params: any[] = def.key.map((k) => e.key[k]);
        let sql = `DELETE FROM ${def.name} WHERE ${conds.join(' AND ')}`;
        if (def.scoped) { sql += ` AND company_id = $${params.length + 1}`; params.push(companyId); }
        await q(sql, params);
      }
    }
    return { restored: entries.length };
  });
}
