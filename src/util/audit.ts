/**
 * Shared audit log helper — records who changed what (schedule + settings + calendar).
 * Used by schedule.ts, departments.ts, jobRoles.ts, users.ts.
 *
 * Report redesign (Deepika, 2026-11-13): every row carries the affected
 * person (affectedUserId — resolved live at report time, so renames
 * show the current name), a result, and a schedule date (or range).
 * Names are snapshots at write time (personName / changedByName) as
 * the fallback when the person can no longer be resolved.
 */
import { query } from '../db.js';
import { findRotationOccurrences } from './planExecutor.js';
import { shiftTypesDepartmentIds, rotationRelevantDepartments } from './departmentAccess.js';

export interface AuditEntry {
  companyId: string;
  date: string; // YYYY-MM-DD (schedule date, or today for settings changes)
  action: 'created' | 'updated' | 'deleted' | 'published' | 'unpublished' | 'rotation_excluded'
    | 'archived' | 'restored' | 'delete_requested' | 'delete_rejected' | 'delete_cancelled';
  category?: 'schedule' | 'settings' | 'calendar';
  personName?: string | null;
  shiftTypeName?: string | null;
  source?: 'manual' | 'rotation' | 'agent' | 'email' | 'code';
  rotationName?: string | null;
  changedBy?: string | null; // user id
  /** Human-readable description, e.g. 'Deleted job role "secretary" from Internal Medicine'. */
  description?: string | null;
  details?: any;
  /** The person whose schedule changed (null when no single person is affected). */
  affectedUserId?: string | null;
  /** Whether what was asked for actually happened. Defaults to 'successful'. */
  result?: 'successful' | 'not_successful';
  /** Schedule date the change is about; defaults to `date` for schedule
   *  rows, null for settings/calendar rows unless the caller passes one. */
  scheduleDate?: string | null;
  /** End of the schedule range (bulk publishes), or null. */
  scheduleDateEnd?: string | null;
  /** Shift type id, stored in details so the report can resolve the
   *  type's CURRENT name at read time (a rename shows the new name). */
  shiftTypeId?: string | null;
  /** Explicit department for the change (department-management rows).
   *  Otherwise auditLog derives it — see deriveDepartmentId. */
  departmentId?: string | null;
}

/**
 * Department attribution for one audit row (Deepika, 2026-11-13 — an
 * admin sees updates for the departments they have access to). The
 * PRIMARY department, stored on the row: an explicit department for
 * department-management changes, else the affected person's home
 * department, else the single department of the rotation / shift type
 * involved. NULL means unattributable — visible to the owner only.
 * A deleted department never attributes (the FK would fail), and any
 * failure here returns NULL rather than losing the audit row.
 */
export async function deriveDepartmentId(
  companyId: string,
  e: { affectedUserId?: string | null; departmentId?: string | null },
  details: any
): Promise<string | null> {
  try {
    const explicit = e.departmentId || details?.departmentId || null;
    if (explicit) {
      const { rows } = await query('SELECT 1 FROM departments WHERE id = $1 AND company_id = $2', [explicit, companyId]);
      if (rows.length) return explicit as string;
      return null;
    }
    if (e.affectedUserId) {
      const { rows } = await query('SELECT department_id FROM users WHERE id = $1', [e.affectedUserId]);
      if (rows.length && rows[0].department_id) return rows[0].department_id as string;
    }
    const rotationId = details?.rotationId || null;
    if (rotationId) {
      const depts = await rotationRelevantDepartments(rotationId);
      if (depts.length === 1) return depts[0];
    }
    const stIds = [...new Set([
      ...(details?.shiftTypeId ? [details.shiftTypeId] : []),
      ...((details?.shiftTypeIds || []) as string[]),
    ])].filter(Boolean) as string[];
    if (stIds.length) {
      const depts = await shiftTypesDepartmentIds(stIds, companyId);
      if (depts.length === 1) return depts[0];
    }
    return null;
  } catch {
    return null;
  }
}

export async function auditLog(e: AuditEntry): Promise<void> {
  try {
    let changedByName: string | null = null;
    if (e.changedBy) {
      const { rows } = await query(
        'SELECT first_name, last_name, nickname FROM users WHERE id = $1',
        [e.changedBy]
      );
      if (rows.length) {
        const u = rows[0];
        changedByName = u.nickname || `${u.first_name || ''} ${u.last_name || ''}`.trim() || null;
      }
    }
    const scheduleDate = e.scheduleDate !== undefined
      ? e.scheduleDate
      : (e.category || 'schedule') === 'schedule' ? e.date : null;
    const details = {
      ...(e.details || {}),
      ...(e.shiftTypeId ? { shiftTypeId: e.shiftTypeId } : {}),
      ...(e.description ? { description: e.description } : {}),
    };
    const departmentId = await deriveDepartmentId(e.companyId, e, details);
    await query(
      `INSERT INTO schedule_audit_log
         (company_id, date, action, category, person_name, shift_type_name, source,
          rotation_name, changed_by, changed_by_name, details,
          affected_user_id, result, schedule_date, schedule_date_end, department_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [e.companyId, e.date, e.action, e.category || 'schedule',
       e.personName || null, e.shiftTypeName || null,
       e.source || 'manual', e.rotationName || null,
       e.changedBy || null, changedByName,
       JSON.stringify(details),
       e.affectedUserId || null, e.result || 'successful',
       scheduleDate, e.scheduleDateEnd || null, departmentId]
    );
  } catch (err) {
    // Audit logging must never break the main operation.
    console.error('[audit] log failed:', err);
  }
}

/** Today's date as YYYY-MM-DD, for settings changes not tied to a schedule date. */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve a roster name to a user id for audit recording — exact match
 * only (the same don't-guess rule as the executor), but WITHOUT the
 * is_active filter: a deactivated person's past changes still belong
 * to them. Returns null when the name is ambiguous or unknown.
 */
export async function resolvePersonId(companyId: string, name: string): Promise<{ id: string; display: string } | null> {
  const lower = (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!lower) return null;
  const { rows } = await query(
    `SELECT id, first_name, last_name, nickname FROM users
     WHERE company_id = $1 ORDER BY lower(first_name), lower(last_name), created_at`,
    [companyId]
  );
  const full = (u: any) => `${u.first_name} ${u.last_name || ''}`.toLowerCase().trim().replace(/\s+/g, ' ');
  const found = (u: any) => ({ id: u.id as string, display: u.nickname || `${u.first_name} ${u.last_name || ''}`.trim() });
  const unique = (hits: any[]) => (hits.length === 1 ? found(hits[0]) : null);
  const exactFull = rows.filter((u: any) => full(u) === lower);
  if (exactFull.length) return unique(exactFull);
  const exactNick = rows.filter((u: any) => u.nickname && u.nickname.toLowerCase().trim() === lower);
  if (exactNick.length) return unique(exactNick);
  const firsts = rows.filter((u: any) => (u.first_name || '').toLowerCase() === lower);
  if (firsts.length) return unique(firsts);
  const lasts = rows.filter((u: any) => u.last_name && u.last_name.toLowerCase() === lower);
  if (lasts.length) return unique(lasts);
  return null;
}

/**
 * Draft check (Deepika, 2026-11-13 — the report must document drafts
 * a removal leaves behind, with the why). Call AFTER a stored shift
 * leaves a person (executor move/swap/unassign, drag-move, drag-swap,
 * Replace-person, DELETE, bulk-delete, pickup/claim deletions):
 * when the removed row was suppressing a rotation occurrence and no
 * exclusion covers that day, the occurrence draws again as a draft —
 * record it (source 'code', result 'not_successful') so the report
 * shows the side effect and nobody gets blamed for it. Writes
 * NOTHING on the normal post-fix paths: the exclusion inserted by
 * the removal itself covers the day, and a stored row still covering
 * the slot suppresses the occurrence.
 *
 * Widened (Deepika, 2026-11-13 — delete completely / Bul's Day
 * Hospitalist draft): the removed row may have been suppressing
 * occurrences of OTHER types that day — a published group-origin
 * stored row suppresses any conflicting type — so the check covers
 * EVERY type for this user/date (null-type call), not just the
 * removed one. Each occurrence is judged on its own: a stored row
 * still covering that type suppresses it, an exclusion covers it.
 * One row per removal at most.
 */
export async function auditDraftIfAppeared(
  companyId: string, userId: string, date: string, shiftTypeId: string | null, changedBy: string | null
): Promise<void> {
  try {
    if (!userId || !date || !shiftTypeId) return;
    const occ = await findRotationOccurrences(companyId, userId, date, null);
    for (const o of occ) {
      // A stored row still covering this type suppresses the occurrence.
      const { rows: stored } = await query(
        'SELECT 1 FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 LIMIT 1',
        [companyId, userId, date, o.shiftTypeId]
      );
      if (stored.length) continue;
      const { rows: excl } = await query(
        `SELECT 1 FROM rotation_shift_exclusions
         WHERE rotation_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 LIMIT 1`,
        [o.rotationId, userId, date, o.shiftTypeId]
      );
      if (excl.length) continue;
      // This occurrence draws with nothing covering it — a draft
      // appears where the removed shift used to be.
      const { rows: names } = await query(
        `SELECT u.nickname, u.first_name, u.last_name, st.name AS "shiftTypeName"
         FROM users u, shift_types st
         WHERE u.id = $1 AND st.id = $2 AND u.company_id = $3 AND st.company_id = $3`,
        [userId, o.shiftTypeId, companyId]
      );
      const personName = names.length
        ? (names[0].nickname || `${names[0].first_name || ''} ${names[0].last_name || ''}`.trim() || null)
        : null;
      const shiftTypeName = names.length ? names[0].shiftTypeName : null;
      await auditLog({
        companyId, date, action: 'created', category: 'schedule',
        personName, shiftTypeName, source: 'code', result: 'not_successful',
        affectedUserId: userId, scheduleDate: date, changedBy,
        description: `Draft appeared — ${shiftTypeName || 'shift'} left as a draft. The rotation pattern drew again because the stored shift was removed without excluding the rotation day.`,
        details: {
          cause: 'rotation occurrence re-drew after stored shift removal without exclusion',
          rotationId: o.rotationId, shiftTypeId: o.shiftTypeId,
        },
      });
      return; // one row per removal
    }
  } catch (err) {
    console.error('[audit] draft check failed:', (err as any)?.message);
  }
}

/**
 * Draft check for an approved plan's removals (Deepika, 2026-11-13):
 * each stored row the executor removed is checked for a draft it
 * left behind — see auditDraftIfAppeared. Called by BOTH approval
 * paths after auditPlanChanges, once the whole plan has applied.
 */
export async function auditDraftsForResults(companyId: string, results: any[], changedBy: string | null): Promise<void> {
  for (const r of results || []) {
    for (const s of (r?.removedSlots || [])) {
      await auditDraftIfAppeared(companyId, s.userId, s.date, s.shiftTypeId, changedBy);
    }
  }
}

/** Dates one approved plan change touches, for the Change report. A recurring
 *  pattern and a bulk range expand to one row per schedule date, so the
 *  report for any touched date says what happened on that date. Everything
 *  else is a single row on its own date. */
function planChangeDates(c: any, r: any): string[] {
  if (c.action === 'assign_recurring' && Array.isArray(r?.dates) && r.dates.length) {
    return r.dates;
  }
  if ((c.action === 'bulk_publish' || c.action === 'bulk_unpublish') && c.fromDate && c.toDate && c.fromDate <= c.toDate) {
    const out: string[] = [];
    const [y, m, d] = String(c.fromDate).split('-').map(Number);
    const [y2, m2, d2] = String(c.toDate).split('-').map(Number);
    let cur = Date.UTC(y, m - 1, d);
    const end = Date.UTC(y2, m2 - 1, d2);
    while (cur <= end) {
      out.push(new Date(cur).toISOString().slice(0, 10));
      cur += 86400000;
    }
    return out;
  }
  return [c.date || c.fromDate || c.startDate || todayStr()];
}

/**
 * Shared Change-report logging for approved plans — used by BOTH approval
 * paths (the in-app Approve button and the email Approve link) so no
 * approved change is ever missing from the report. Each row carries the how
 * (agent = in-app Task / Ask Task, email = email approval) and the approver.
 * Per-date rows (recurring, bulk) stand alone in their date's report, so
 * they carry no pattern summary — person + shift says it.
 * A swap writes TWO rows (one per person — the report shows swaps as two
 * separate rows, never one merged line). A FAILED change is recorded too,
 * with result 'not_successful' and the failure reason as its description —
 * the report must say when what was asked for did not happen.
 */
export async function auditPlanChanges(companyId: string, plan: any, results: any[], changedBy: string | null): Promise<void> {
  try {
    const planSrc = plan.source_subject === 'In-app agent task' ? 'agent' : 'email';
    const changes = (plan.plan && (plan.plan as any).changes) || [];
    // Shift type id by (lowercased) name, cached per plan — shift type
    // names are unique per company, so the lookup is exact.
    const typeIdByName = new Map<string, string | null>();
    const settingsActions = new Set(['add_job_role', 'rename_job_role', 'delete_job_role',
      'add_department', 'rename_department', 'add_team_member', 'update_team_member',
      'add_shift_type', 'rename_shift_type', 'set_staffing_target']);
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      const r = (results as any[])[i];
      if (!r) continue;
      const failed = r.success === false;
      const result = failed ? 'not_successful' : 'successful';
      const isSettings = settingsActions.has(c.action);
      // Calendar session changes belong to the separate Calendar
      // report (Deepika, 2026-11-07: calendar reporting stays
      // separate for clarity), never the schedule Run report.
      const isSession = c.action === 'add_session' || c.action === 'update_session' || c.action === 'cancel_session';
      const action = isSession
        ? (c.action === 'add_session' ? 'created' : c.action === 'cancel_session' ? 'deleted' : 'updated')
        : (c.action === 'unassign' || String(c.action).startsWith('delete')) ? 'deleted'
        : (c.action === 'bulk_publish') ? 'published'
        : (c.action === 'bulk_unpublish') ? 'unpublished'
        : (c.action === 'assign' || c.action === 'assign_recurring' || String(c.action).startsWith('add')) ? 'created' : 'updated';
      // One row per affected person. A swap is two moves.
      type Side = { person?: string | null; date?: string; shiftType?: string | null; description?: string | null; swapTo?: string | null };
      const sides: Side[] = [];
      if (c.action === 'swap' && c.fromPerson && c.toPerson) {
        const fromDate = c.fromDate || c.date;
        const toDate = c.toDate || c.date;
        sides.push({
          person: c.fromPerson, date: fromDate, shiftType: c.shiftType || null, swapTo: c.toPerson,
          description: failed ? (r.message || null) : `Moved ${c.fromPerson} → ${c.toPerson} on ${fromDate} (swap)`,
        });
        sides.push({
          person: c.toPerson, date: toDate, shiftType: c.shiftType || null, swapTo: c.fromPerson,
          description: failed ? (r.message || null) : `Moved ${c.toPerson} → ${c.fromPerson} on ${toDate} (swap)`,
        });
      } else {
        // A move is about the giver's shift (the executor's message
        // names them — "No shift found for Gaj Cha…"), so the row
        // belongs to the from-person, not the recipient.
        const person = c.action === 'move'
          ? (c.fromPerson || c.person || c.toPerson
            || (c.firstName ? `${c.firstName} ${c.lastName || ''}`.trim() : null) || null)
          : (c.person || c.toPerson
            || (c.firstName ? `${c.firstName} ${c.lastName || ''}`.trim() : null) || null);
        sides.push({ person, date: undefined, shiftType: c.shiftType || null, description: null });
      }
      for (const side of sides) {
        const who = side.person ? await resolvePersonId(companyId, side.person) : null;
        const personName = who?.display || r.personDisplay || side.person || null;
        // Keep-updated (Deepika, 2026-11-13): store the shift type id
        // and the swap partner's id so the report can resolve their
        // CURRENT names at read time. Shift type names are unique per
        // company, so a name lookup is exact; ambiguous names resolve
        // to nothing rather than a guess.
        let shiftTypeId: string | null = null;
        if (side.shiftType) {
          const key = side.shiftType.toLowerCase().trim();
          if (!typeIdByName.has(key)) {
            const { rows: stRows } = await query(
              'SELECT id FROM shift_types WHERE company_id = $1 AND lower(name) = lower($2)',
              [companyId, side.shiftType]
            );
            typeIdByName.set(key, stRows.length ? stRows[0].id : null);
          }
          shiftTypeId = typeIdByName.get(key) || null;
        }
        const swapToWho = side.swapTo ? await resolvePersonId(companyId, side.swapTo) : null;
        const dates = c.action === 'swap' ? [side.date || todayStr()] : planChangeDates(c, r);
        const perDate = dates.length > 1;
        for (const date of dates) {
          await auditLog({
            companyId,
            date,
            action,
            category: isSession ? 'calendar' : isSettings ? 'settings' : 'schedule',
            personName,
            affectedUserId: who?.id || null,
            shiftTypeName: side.shiftType,
            source: planSrc as any,
            changedBy,
            result,
            description: failed
              ? (r.message || null)
              : (side.description ?? (perDate ? null : (r.message || plan.plan_summary || null))),
            details: {
              planId: plan.id, action: c.action, summary: plan.plan_summary,
              ...(shiftTypeId ? { shiftTypeId } : {}),
              ...(side.swapTo ? { swap: true, swapTo: side.swapTo, ...(swapToWho?.id ? { swapToUserId: swapToWho.id } : {}) } : {}),
            },
          });
        }
      }
    }
  } catch (err) {
    console.error('[audit] plan audit log failed:', (err as any)?.message);
  }
}
