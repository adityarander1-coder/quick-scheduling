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

/**
 * Exclude rotation-generated instances for a user on a date (the "give off"
 * path for rotation days, which have no shift row). Returns the number of
 * rotation instances actually excluded.
 */
async function excludeRotationInstances(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeId: string | null
): Promise<number> {
  const { rows: rotations } = await query(
    `SELECT id, cycle_days AS "cycleDays", start_date::text AS "startDate"
     FROM rotations WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  let excluded = 0;
  for (const rot of rotations) {
    const { rows: assignments } = await query(
      `SELECT ra.cycle_day AS "cycleDay", ra.shift_type_id AS "shiftTypeId"
       FROM rotation_assignments ra
       JOIN users u ON u.id = ra.user_id
       WHERE ra.rotation_id = $1 AND ra.user_id = $2 AND u.is_active = true
         AND (u.end_date IS NULL OR u.end_date::text >= $3)`,
      [rot.id, userId, date]
    );
    if (!assignments.length) continue;
    const startDate = new Date(rot.startDate + 'T00:00:00');
    const target = new Date(date + 'T00:00:00');
    if (isNaN(startDate.getTime()) || isNaN(target.getTime()) || target < startDate) continue;
    const daysSinceStart = Math.floor((target.getTime() - startDate.getTime()) / 86400000);
    const cycleDay = (daysSinceStart % rot.cycleDays) + 1; // 1-indexed, matches schedule.ts
    const matches = assignments.filter(
      (a: any) => a.cycleDay === cycleDay && (!shiftTypeId || a.shiftTypeId === shiftTypeId)
    );
    if (!matches.length) continue;
    // Skip dates inside a pause period (vacation etc.).
    const { rows: pauses } = await query(
      `SELECT 1 FROM rotation_pauses
       WHERE rotation_id = $1 AND start_date::text <= $2 AND end_date::text >= $2 LIMIT 1`,
      [rot.id, date]
    );
    if (pauses.length) continue;
    for (const m of matches) {
      const ins = await query(
        `INSERT INTO rotation_shift_exclusions (company_id, rotation_id, user_id, date, shift_type_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (rotation_id, user_id, date, shift_type_id) DO NOTHING`,
        [companyId, rot.id, userId, date, m.shiftTypeId]
      );
      if (ins.rowCount && ins.rowCount > 0) excluded++;
    }
  }
  return excluded;
}

/** Find one manual shift row for a user on a date, optionally filtered by shift type name. */
async function findShiftRow(
  companyId: string,
  userId: string,
  date: string,
  shiftTypeName?: string
): Promise<{ id: string; shift_type_id: string; date: string; published: boolean; notes: string | null; shift_type_name: string } | null> {
  let stId: string | null = null;
  if (shiftTypeName) {
    const st = await findShiftType(companyId, shiftTypeName);
    if (!st) throw new Error(`Shift type not found: ${shiftTypeName}`);
    stId = st.id;
  }
  const params: any[] = [companyId, userId, date];
  let q = `SELECT s.id, s.shift_type_id, s.date::text AS date, s.published, s.notes, st.name AS shift_type_name
           FROM shifts s JOIN shift_types st ON st.id = s.shift_type_id
           WHERE s.company_id = $1 AND s.user_id = $2 AND s.date = $3`;
  if (stId) { q += ' AND s.shift_type_id = $4'; params.push(stId); }
  q += ' ORDER BY s.created_at LIMIT 1';
  const { rows } = await query(q, params);
  return rows[0] ?? null;
}

function noManualShiftMsg(display: string, date: string, shiftTypeName?: string): string {
  return `No shift found for ${display} on ${date}${shiftTypeName ? ` (${shiftTypeName})` : ''}. ` +
    `Only manually-assigned shifts can be swapped — rotation-generated shifts need the scheduler.`;
}

/** Execute a plan's changes. Returns per-change results. */
export async function executePlan(
  companyId: string,
  plan: { changes: PlanChange[] },
  executedBy: string
): Promise<ExecuteResult[]> {
  const results: ExecuteResult[] = [];
  // created_by is a uuid FK — only use executedBy when it's actually a user id.
  const createdBy = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(executedBy)
    ? executedBy
    : null;
  for (const change of plan.changes || []) {
    try {
      if (change.action === 'assign' && change.person && change.date && change.shiftType) {
        const user = await findUser(companyId, change.person);
        const st = await findShiftType(companyId, change.shiftType);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        if (!st) throw new Error(`Shift type not found: ${change.shiftType}`);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        const inserted = await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           ON CONFLICT DO NOTHING`,
          [uuidv4(), companyId, user.id, st.id, change.date, createdBy]
        );
        if (inserted.rowCount === 0) {
          results.push({ action: 'assign', success: true, message: `Already on ${st.name} on ${change.date} — no change needed` });
        } else {
          results.push({ action: 'assign', success: true, message: `Assigned ${user.display} to ${st.name} on ${change.date}` });
        }
      } else if (change.action === 'swap' && change.fromPerson && change.toPerson) {
        // Swap exchanges two people's shifts. Same-day swap uses `date`;
        // cross-date swap uses fromDate/toDate. Runs in one transaction so a
        // half-applied swap is impossible.
        const fromUser = await findUser(companyId, change.fromPerson);
        const toUser = await findUser(companyId, change.toPerson);
        if (!fromUser) throw new Error(`Person not found: ${change.fromPerson}`);
        if (!toUser) throw new Error(`Person not found: ${change.toPerson}`);
        const fromDate = change.fromDate || change.date;
        const toDate = change.toDate || change.date;
        if (!fromDate || !toDate) throw new Error('Swap needs a date (or fromDate/toDate).');
        const fromShift = await findShiftRow(companyId, fromUser.id, fromDate, change.shiftType);
        if (!fromShift) throw new Error(noManualShiftMsg(fromUser.display, fromDate, change.shiftType));
        const toShift = await findShiftRow(companyId, toUser.id, toDate, change.shiftType);
        const { withTransaction } = await import('../db.js');
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        if (!toShift) {
          // toPerson has no shift on that date: treat as a move of fromPerson's shift.
          await withTransaction(async (tx) => {
            const del = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [fromShift.id, companyId]);
            if (del.rowCount === 0) throw new Error(`Could not remove ${fromUser.display}'s shift on ${fromDate} — it may have changed.`);
            const ins = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [uuidv4(), companyId, toUser.id, fromShift.shift_type_id, toDate, fromShift.notes, fromShift.published, createdBy]
            );
            if (ins.rowCount === 0) throw new Error(`${toUser.display} is already on ${fromShift.shift_type_name} on ${toDate} — no change made.`);
          });
          results.push({ action: 'swap', success: true, message: `Moved ${fromUser.display}'s ${fromShift.shift_type_name} on ${fromDate} to ${toUser.display} on ${toDate} (${toUser.display} had no shift to swap)` });
        } else {
          // Exchange the two assignments: delete both rows, re-insert with
          // swapped people (avoids UNIQUE conflicts on same-type same-day swaps).
          await withTransaction(async (tx) => {
            const del1 = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [fromShift.id, companyId]);
            if (del1.rowCount === 0) throw new Error(`Could not remove ${fromUser.display}'s shift on ${fromDate} — it may have changed.`);
            const del2 = await tx.query('DELETE FROM shifts WHERE id = $1 AND company_id = $2', [toShift.id, companyId]);
            if (del2.rowCount === 0) throw new Error(`Could not remove ${toUser.display}'s shift on ${toDate} — it may have changed.`);
            const ins1 = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [uuidv4(), companyId, toUser.id, fromShift.shift_type_id, fromDate, fromShift.notes, fromShift.published, createdBy]
            );
            if (ins1.rowCount === 0) throw new Error(`Could not place ${toUser.display} on ${fromShift.shift_type_name} on ${fromDate} — conflicting shift exists.`);
            const ins2 = await tx.query(
              `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, notes, published, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
              [uuidv4(), companyId, fromUser.id, toShift.shift_type_id, toDate, toShift.notes, toShift.published, createdBy]
            );
            if (ins2.rowCount === 0) throw new Error(`Could not place ${fromUser.display} on ${toShift.shift_type_name} on ${toDate} — conflicting shift exists.`);
          });
          const sameDay = fromDate === toDate;
          results.push({
            action: 'swap', success: true,
            message: sameDay
              ? `Swapped ${fromUser.display} (${fromShift.shift_type_name}) ↔ ${toUser.display} (${toShift.shift_type_name}) on ${fromDate}`
              : `Swapped ${fromUser.display}'s ${fromShift.shift_type_name} on ${fromDate} ↔ ${toUser.display}'s ${toShift.shift_type_name} on ${toDate}`,
          });
        }
      } else if (change.action === 'unassign' && change.person && change.date) {
        const user = await findUser(companyId, change.person);
        if (!user) throw new Error(`Person not found: ${change.person}`);
        let q = 'DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3';
        const params: any[] = [companyId, user.id, change.date];
        let shiftTypeId: string | null = null;
        if (change.shiftType) {
          const st = await findShiftType(companyId, change.shiftType);
          if (st) { q += ' AND shift_type_id = $4'; params.push(st.id); shiftTypeId = st.id; }
        }
        const deleted = await query(q, params);
        if (deleted.rowCount === 0) {
          // No direct shift row — the visible entry is rotation-generated, so
          // exclude the rotation instance(s) for that date instead.
          const excluded = await excludeRotationInstances(companyId, user.id, change.date, shiftTypeId);
          if (excluded > 0) {
            results.push({
              action: 'unassign', success: true,
              message: `Removed ${user.display} from ${change.date} (rotation day)`,
            });
          } else {
            results.push({
              action: 'unassign', success: false,
              message: `No shift found for ${user.display} on ${change.date} to remove.`,
            });
          }
        } else {
          results.push({ action: 'unassign', success: true, message: `Removed ${user.display} from ${change.date}` });
        }
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
        if (!srows.length) throw new Error(`No shift found for ${fromUser.display} on ${change.date}. Only manually-assigned shifts can be moved — rotation-generated shifts need the scheduler.`);
        const shiftTypeId = srows[0].shift_type_id;
        await query('DELETE FROM shifts WHERE company_id = $1 AND user_id = $2 AND date = $3 AND shift_type_id = $4',
          [companyId, fromUser.id, change.date, shiftTypeId]);
        const { v4: uuidv4 } = await import('crypto').then(m => ({ v4: () => m.randomUUID() }));
        await query(
          `INSERT INTO shifts (id, company_id, user_id, shift_type_id, date, published, created_by)
           VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT DO NOTHING`,
          [uuidv4(), companyId, toUser.id, shiftTypeId, change.date, createdBy]
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
