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
