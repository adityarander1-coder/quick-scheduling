/**
 * Shared audit log helper — records who changed what (schedule + settings).
 * Used by schedule.ts, departments.ts, jobRoles.ts, users.ts.
 */
import { query } from '../db.js';

export interface AuditEntry {
  companyId: string;
  date: string; // YYYY-MM-DD (schedule date, or today for settings changes)
  action: 'created' | 'updated' | 'deleted' | 'published' | 'unpublished' | 'rotation_excluded';
  category?: 'schedule' | 'settings';
  personName?: string | null;
  shiftTypeName?: string | null;
  source?: 'manual' | 'rotation' | 'agent' | 'email';
  rotationName?: string | null;
  changedBy?: string | null; // user id
  /** Human-readable description, e.g. 'Deleted job role "secretary" from Internal Medicine'. */
  description?: string | null;
  details?: any;
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
    await query(
      `INSERT INTO schedule_audit_log
         (company_id, date, action, category, person_name, shift_type_name, source,
          rotation_name, changed_by, changed_by_name, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [e.companyId, e.date, e.action, e.category || 'schedule',
       e.personName || null, e.shiftTypeName || null,
       e.source || 'manual', e.rotationName || null,
       e.changedBy || null, changedByName,
       JSON.stringify({ ...(e.details || {}), ...(e.description ? { description: e.description } : {}) })]
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
 */
export async function auditPlanChanges(companyId: string, plan: any, results: any[], changedBy: string | null): Promise<void> {
  try {
    const planSrc = plan.source_subject === 'In-app agent task' ? 'agent' : 'email';
    const changes = (plan.plan && (plan.plan as any).changes) || [];
    const settingsActions = new Set(['add_job_role', 'rename_job_role', 'delete_job_role',
      'add_department', 'rename_department', 'add_team_member', 'update_team_member',
      'add_shift_type', 'rename_shift_type', 'set_staffing_target']);
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i];
      const r = (results as any[])[i];
      if (!r || r.success === false) continue;
      const isSettings = settingsActions.has(c.action);
      const action = (c.action === 'unassign' || String(c.action).startsWith('delete')) ? 'deleted'
        : (c.action === 'bulk_publish') ? 'published'
        : (c.action === 'bulk_unpublish') ? 'unpublished'
        : (c.action === 'assign' || c.action === 'assign_recurring' || String(c.action).startsWith('add')) ? 'created' : 'updated';
      const dates = planChangeDates(c, r);
      const perDate = dates.length > 1;
      for (const date of dates) {
        await auditLog({
          companyId,
          date,
          action,
          category: isSettings ? 'settings' : 'schedule',
          personName: r.personDisplay || c.person || c.toPerson || c.firstName || null,
          shiftTypeName: c.shiftType || null,
          source: planSrc as any,
          changedBy,
          description: perDate ? null : (r.message || plan.plan_summary || null),
          details: { planId: plan.id, action: c.action, summary: plan.plan_summary },
        });
      }
    }
  } catch (err) {
    console.error('[audit] plan audit log failed:', (err as any)?.message);
  }
}
