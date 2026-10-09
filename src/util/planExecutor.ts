// util/planExecutor.ts — executes approved schedule change plans.

import { query } from '../db.js';

interface PlanChange {
  action: 'assign' | 'unassign' | 'move' | 'swap';
  person?: string;
  fromPerson?: string;
  toPerson?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  shiftType?: string;
}

interface ExecuteResult {
  action: string;
  success: boolean;
  message: string;
}

/** Find a user ID by fuzzy name match. */
async function findUser(companyId: string, name: string): Promise<{ id: string; display: string } | null> {
  const { rows } = await query(
    `SELECT id, first_name, last_name, nickname FROM users
     WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  const lower = name.toLowerCase().trim();
  for (const u of rows) {
    const names = [
      u.nickname?.toLowerCase(),
      `${u.first_name} ${u.last_name}`.toLowerCase().trim(),
      u.first_name.toLowerCase(),
      u.last_name?.toLowerCase(),
    ].filter(Boolean);
    if (names.some(n => n === lower || (n.length >= 3 && lower.includes(n)) || (lower.length >= 3 && n.includes(lower)))) {
      return { id: u.id, display: u.nickname || `${u.first_name} ${u.last_name || ''}`.trim() };
    }
  }
  return null;
}

/** Find a shift type ID by fuzzy name match. */
async function findShiftType(companyId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { rows } = await query(
    'SELECT id, name FROM shift_types WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  const lower = name.toLowerCase().trim();
  for (const st of rows) {
    if (st.name.toLowerCase() === lower || st.name.toLowerCase().includes(lower) || lower.includes(st.name.toLowerCase())) {
      return { id: st.id, name: st.name };
    }
  }
  // Keyword fallback.
  if (lower.includes('night')) {
    const night = rows.find((r: any) => r.name.toLowerCase().includes('night'));
    if (night) return { id: night.id, name: night.name };
  }
  if (lower.includes('day')) {
    const day = rows.find((r: any) => r.name.toLowerCase().includes('day') && !r.name.toLowerCase().includes('night'));
    if (day) return { id: day.id, name: day.name };
  }
  return null;
}

/** Execute a plan's changes. Returns per-change results. */
export async function executePlan(
  companyId: string,
  plan: { changes: PlanChange[] },
  executedBy: string
): Promise<ExecuteResult[]> {
  const results: ExecuteResult[] = [];
  for (const change of plan.changes || []) {
    try {
      if (change.action === 'assign' && change.person && change.date && change.shiftType) {
        const user = await findUser(companyId, change.person);
        const st = await findShiftType(companyId, change.shiftType);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           ON CONFLICT DO NOTHING`,
          [uuidv4(), companyId, user.id, st.id, change.date, executedBy]
        );
        results.push({ action: 'assign', success: true, message: `Assigned ${user.display} to ${st.name} on ${change.date}` });
      } else if (change.action === 'unassign' && change.person && change.date) {
        const user = await findUser(companyId, change.person);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        let q = 'DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3';
        const params: any[] = [companyId, user.id, change.date];
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { q += ' AND shift_type_id = $4'; params.push(st.id); }
        }
        await query(q, params);
        results.push({ action: 'unassign', success: true, message: `Removed ${user.display} from ${change.date}` });
      } else if (change.action === 'move' && change.fromPerson && change.toPerson && change.date) {
        // Move = unassign fromPerson + assign toPerson (same shift type).
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        if (!fromUser) throw new Error(`Person not found: ${change.fromPerson}`);
        if (!toUser) throw new Error(`Person not found: ${change.toPerson}`);
        // Find the shift to move.
        let shiftQ = 'SELECT shift_type_id FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 LIMIT 1';
        const shiftParams: any[] = [companyId, fromUser.id, change.date];
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { shiftQ = 'SELECT shift_type_id FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4 LIMIT 1'; shiftParams.push(st.id); }
        }
        const { rows: srows } = await query(shiftQ, shiftParams);
        if (!srows.length) throw new Error(`No shift found for ${fromUser.display} on ${change.date}`);
        const shiftTypeId = srows[0].shift_type_id;
        await query('DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4',
          [companyId, fromUser.id, change.date, shiftTypeId]);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT DO NOTHING`,
          [uuidv4(), companyId, toUser.id, shiftTypeId, change.date, executedBy]
        );
        results.push({ action: 'move', success: true, message: `Moved ${fromUser.display} → ${toUser.display} on ${change.date}` });
      } else {
        results.push({ action: change.action, success: false, message: `Unsupported or incomplete change: ${JSON.stringify(change)}` });
      }
    } catch (err: any) {
      results.push({ action: change.action, success: false, message: err?.message || 'Failed' });
    }
  }
  return results;
}
