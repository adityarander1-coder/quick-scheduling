/**
 * scheduleMode.ts — per-department schedule mode (Deepika, 2026-11-14):
 * each department picks its own mode — 'live' (rotations fill the
 * schedule in on their own, as today) or 'generated' (nothing appears
 * until drafted from the rotations). The old per-company flag in
 * company_settings ('schedule_mode') is retired (migration 108 seeds
 * the per-department table from it); all readers go through these
 * helpers now.
 *
 * A shift type's mode: a type belongs to departments through
 * shift_type_departments (and the legacy department_id column on
 * shift_types for older rows — same rule as shiftTypeDeptMap). A
 * type is 'generated' only when EVERY department it belongs to is
 * generated — a type shared by a live department and a generated one
 * keeps drawing in the live department's view (the read paths filter
 * per shift, so the live department still sees it and the generated
 * one doesn't draw it).
 * A type with no departments at all is treated as live (same as the
 * no-department case in getShiftsForRange: unscoped types always
 * draw).
 */
type QueryFn = (text: string, params: any[]) => Promise<{ rows: any[] }>;

export type ScheduleMode = 'live' | 'generated';
export type CompanyModeSummary = 'live' | 'generated' | 'mixed';

/** Modes for every department of a company (missing row = 'live'). */
export async function getDepartmentModes(
  q: QueryFn,
  companyId: string
): Promise<Map<string, ScheduleMode>> {
  const { rows } = await q(
    'SELECT department_id AS "departmentId", mode FROM department_schedule_modes WHERE company_id = $1',
    [companyId]
  );
  const out = new Map<string, ScheduleMode>();
  for (const r of rows) out.set(r.departmentId, r.mode === 'generated' ? 'generated' : 'live');
  return out;
}

/** Upsert one department's mode. */
export async function setDepartmentMode(
  q: QueryFn,
  companyId: string,
  departmentId: string,
  mode: ScheduleMode
): Promise<void> {
  await q(
    `INSERT INTO department_schedule_modes (company_id, department_id, mode, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (company_id, department_id)
     DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
    [companyId, departmentId, mode]
  );
}

/**
 * shift_type_id -> departments it belongs to. Mirrors
 * shiftTypeDeptMap (schedule.ts) exactly: the shift_type_departments
 * join table UNION the legacy single-department column on
 * shift_types. A type in no department maps to an empty set.
 */
export async function getTypeDepartments(
  q: QueryFn,
  companyId: string
): Promise<Map<string, Set<string>>> {
  const { rows } = await q(
    `SELECT shift_type_id AS "shiftTypeId", department_id AS "departmentId"
     FROM (
       SELECT std.shift_type_id, std.department_id
       FROM shift_type_departments std
       JOIN shift_types st ON st.id = std.shift_type_id
       WHERE st.company_id = $1
       UNION
       SELECT id, department_id FROM shift_types
       WHERE company_id = $1 AND department_id IS NOT NULL
     ) d`,
    [companyId]
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!out.has(r.shiftTypeId)) out.set(r.shiftTypeId, new Set());
    out.get(r.shiftTypeId)!.add(r.departmentId);
  }
  return out;
}

/**
 * The set of shift types that are 'generated': every department the
 * type belongs to is generated. Types in no department are live.
 */
export async function getGeneratedTypeIds(
  q: QueryFn,
  companyId: string
): Promise<Set<string>> {
  const [typeDepts, modes] = await Promise.all([
    getTypeDepartments(q, companyId),
    getDepartmentModes(q, companyId),
  ]);
  const out = new Set<string>();
  for (const [typeId, depts] of typeDepts) {
    if (depts.size && [...depts].every((d) => (modes.get(d) || 'live') === 'generated')) {
      out.add(typeId);
    }
  }
  return out;
}

/**
 * Shift types any ACTIVE rotation in the company produces (per-person
 * assignments + group types). A type in this set can be drafted; a
 * type outside it never can — no rotation will ever place its people.
 *
 * Requirements and rotations are independent (Deepika, 2026-11-15):
 * a staffing requirement (target) can exist without a rotation
 * behind it, and the app must never assume a requirement has one.
 */
export async function getTypesWithRotations(
  q: QueryFn,
  companyId: string
): Promise<Set<string>> {
  const { rows } = await q(
    `SELECT ra.shift_type_id AS "shiftTypeId"
     FROM rotation_assignments ra
     JOIN rotations r ON r.id = ra.rotation_id
     WHERE r.company_id = $1 AND r.is_active = true
     UNION
     SELECT group_shift_type_id FROM rotations
     WHERE company_id = $1 AND is_active = true AND group_shift_type_id IS NOT NULL`,
    [companyId]
  );
  return new Set(rows.map((r: any) => r.shiftTypeId));
}

/**
 * Stored-model types (detached open slots, Deepika 2026-11-20):
 * generated AND produced by an active rotation. Only these types
 * store their open slots at draft time and stop counting from the
 * target afterwards. Live types and rotation-less generated types
 * (e.g. Day NP — Nov 15 rule: its target always counts) keep the
 * computed model: opens = target + extra − suppressed − filled.
 */
export async function getStoredModelTypeIds(
  q: QueryFn,
  companyId: string
): Promise<Set<string>> {
  const [generated, withRotations] = await Promise.all([
    getGeneratedTypeIds(q, companyId),
    getTypesWithRotations(q, companyId),
  ]);
  return new Set([...generated].filter((t) => withRotations.has(t)));
}
export async function isTypeGenerated(
  q: QueryFn,
  companyId: string,
  shiftTypeId: string
): Promise<boolean> {
  return (await getGeneratedTypeIds(q, companyId)).has(shiftTypeId);
}

/**
 * Company-wide summary for the grid header / response field:
 * 'live' when no department is generated, 'generated' when every
 * department is generated, 'mixed' otherwise.
 */
export async function getCompanyModeSummary(
  q: QueryFn,
  companyId: string
): Promise<CompanyModeSummary> {
  const modes = await getDepartmentModes(q, companyId);
  const { rows } = await q('SELECT id FROM departments WHERE company_id = $1', [companyId]);
  if (!rows.length) return 'live';
  let any = false;
  let all = true;
  for (const r of rows) {
    const m = modes.get(r.id) || 'live';
    if (m === 'generated') any = true;
    else all = false;
  }
  return all ? 'generated' : any ? 'mixed' : 'live';
}

function dayNum(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, (m || 1) - 1, d || 1) / 86400000);
}
function dateOfDayNum(n: number): string {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

/**
 * Coverage of PARTIAL generations (user_ids set — a draft for picked
 * members only): the (date, type) pairs the generation actually
 * created rows for, read from the stored shifts carrying that
 * generation_id. A partial generation's unpicked turns produce no
 * rows, so those days read as not-drafted for the type — never an
 * OPEN row, never a phantom shift. Returns generationId ->
 * Set<"date|shiftTypeId">. (A side effect worth knowing: if every
 * row a partial generation created is later deleted, its dates read
 * as not-drafted again — which is true, nothing is drafted there
 * any more. Full generations are unaffected: they cover by range.)
 */
async function getPartialCoverage(
  q: QueryFn, companyId: string, from: string, to: string,
  partialGenIds: string[]
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!partialGenIds.length) return out;
  const { rows } = await q(
    `SELECT generation_id AS "generationId", date::text AS date,
            shift_type_id AS "shiftTypeId"
     FROM shifts
     WHERE company_id = $1 AND generation_id = ANY($2::uuid[])
       AND date >= $3 AND date <= $4`,
    [companyId, partialGenIds, from, to]
  );
  for (const r of rows) {
    if (!out.has(r.generationId)) out.set(r.generationId, new Set());
    out.get(r.generationId)!.add(`${r.date}|${r.shiftTypeId}`);
  }
  return out;
}

/** A generation row is partial (drafted for picked members only) when
 *  its user_ids is a non-empty array; NULL/empty means the whole
 *  rotation, which covers its full range as before. */
function isPartialGeneration(r: any): boolean {
  return Array.isArray(r.userIds) && r.userIds.length > 0;
}

/**
 * Dates in [from, to] covered by at least one generation for this
 * company (any rotation, any type). A date is "drafted" at day level
 * when a generation covers it — the grid's "Not drafted yet" day
 * header and the plan gate's old date-level read both use this.
 * Per-type coverage is finer (one type may be drafted while another
 * is not); the per-type map (getNotDraftedByType) is what drives the
 * per-type OPEN suppression.
 */
export async function getDraftedDates(
  q: QueryFn, companyId: string, from: string, to: string
): Promise<Set<string>> {
  const covered = new Set<string>();
  const { rows } = await q(
    `SELECT id, range_start::text AS "rangeStart", range_end::text AS "rangeEnd",
            user_ids AS "userIds"
     FROM rotation_generations
     WHERE company_id = $1 AND range_end >= $2 AND range_start <= $3`,
    [companyId, from, to]
  );
  const fromN = dayNum(from);
  const toN = dayNum(to);
  const partialIds = rows.filter(isPartialGeneration).map((r: any) => r.id);
  const partialCov = await getPartialCoverage(q, companyId, from, to, partialIds);
  for (const r of rows) {
    if (!isPartialGeneration(r)) {
      const s = Math.max(fromN, dayNum(r.rangeStart));
      const e = Math.min(toN, dayNum(r.rangeEnd));
      for (let n = s; n <= e; n++) covered.add(dateOfDayNum(n));
    } else {
      for (const key of partialCov.get(r.id) || []) {
        covered.add(key.split('|')[0]);
      }
    }
  }
  return covered;
}

/** Dates in [from, to] with no generation covering them, ascending. */
export async function getUndraftedDates(
  q: QueryFn, companyId: string, from: string, to: string
): Promise<string[]> {
  const covered = await getDraftedDates(q, companyId, from, to);
  const out: string[] = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) {
    const d = dateOfDayNum(n);
    if (!covered.has(d)) out.push(d);
  }
  return out;
}

/**
 * Dates in [from, to] for which a generated shift type has NOT been
 * drafted yet (no generation batch covers the date for a rotation
 * producing that type). Used by the plan gate (N1) so the AI knows an
 * undrafted day is not an empty day.
 */
export async function getUndraftedDatesForType(
  q: QueryFn,
  companyId: string,
  shiftTypeId: string,
  from: string,
  to: string
): Promise<string[]> {
  // Requirements and rotations are independent (Deepika, 2026-11-15):
  // a generated type NO rotation produces can never be drafted, so it
  // is never "not drafted" — the same exemption getNotDraftedByType
  // applies to the grid, and it must apply here too. Without it the
  // two reads disagreed for rotation-less types: the grid showed
  // their target opens while the close paths (closeTypeForDate,
  // deleteOneOpenSlot — both read undrafted-ness from here) counted
  // the target as 0, so a rotation-less type's close found "no open slots" with 3
  // opens on screen and the Task close-all reported exactly that
  // (live Nov 21, 8:53 PM). The plan gate is unaffected: it already
  // exempts rotation-less types before calling this.
  const withRotations = await getTypesWithRotations(q, companyId);
  if (!withRotations.has(shiftTypeId)) return [];
  const { rows } = await q(
    `SELECT rg.id, rg.range_start::text AS "rangeStart", rg.range_end::text AS "rangeEnd",
            rg.user_ids AS "userIds"
     FROM rotation_generations rg
     JOIN rotations r ON r.id = rg.rotation_id
     WHERE rg.company_id = $1 AND rg.range_end >= $2::date AND rg.range_start <= $3::date
       AND (
         EXISTS (SELECT 1 FROM rotation_assignments ra
                 WHERE ra.rotation_id = r.id AND ra.shift_type_id = $4)
         OR r.group_shift_type_id = $4
       )`,
    [companyId, from, to, shiftTypeId]
  );
  const covered = new Set<string>();
  const fromN = dayNum(from);
  const toN = dayNum(to);
  const partialIds = rows.filter(isPartialGeneration).map((r: any) => r.id);
  const partialCov = await getPartialCoverage(q, companyId, from, to, partialIds);
  for (const r of rows) {
    if (!isPartialGeneration(r)) {
      const s = Math.max(fromN, dayNum(r.rangeStart));
      const e = Math.min(toN, dayNum(r.rangeEnd));
      for (let n = s; n <= e; n++) covered.add(dateOfDayNum(n));
    } else {
      for (const key of partialCov.get(r.id) || []) {
        const [d, t] = key.split('|');
        if (t === shiftTypeId) covered.add(d);
      }
    }
  }
  const out: string[] = [];
  for (let n = fromN; n <= toN; n++) {
    const d = dateOfDayNum(n);
    if (!covered.has(d)) out.push(d);
  }
  return out;
}

/**
 * Per generated type, the undrafted dates in [from, to] — the grid's
 * "Not drafted yet" label, per shift type. Only generated types are
 * keys; live types are never undrafted.
 */
export async function getNotDraftedByType(
  q: QueryFn,
  companyId: string,
  generatedTypeIds: Set<string>,
  from: string,
  to: string
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (!generatedTypeIds.size) return out;
  const { rows } = await q(
    `SELECT rg.id AS "generationId", rg.range_start::text AS "rangeStart",
            rg.range_end::text AS "rangeEnd", rg.user_ids AS "userIds",
            t.shift_type_id AS "shiftTypeId"
     FROM rotation_generations rg
     JOIN rotations r ON r.id = rg.rotation_id
     JOIN (
       SELECT rotation_id, shift_type_id FROM rotation_assignments
       UNION
       SELECT id, group_shift_type_id FROM rotations WHERE group_shift_type_id IS NOT NULL
     ) t ON t.rotation_id = r.id
     WHERE rg.company_id = $1 AND rg.range_end >= $2::date AND rg.range_start <= $3::date`,
    [companyId, from, to]
  );
  const coveredByType = new Map<string, Set<string>>();
  const fromN = dayNum(from);
  const toN = dayNum(to);
  const partialIds = rows.filter(isPartialGeneration).map((r: any) => r.generationId);
  const partialCov = await getPartialCoverage(q, companyId, from, to, [...new Set(partialIds)]);
  for (const r of rows) {
    if (!generatedTypeIds.has(r.shiftTypeId)) continue;
    if (!coveredByType.has(r.shiftTypeId)) coveredByType.set(r.shiftTypeId, new Set());
    const covered = coveredByType.get(r.shiftTypeId)!;
    if (!isPartialGeneration(r)) {
      const s = Math.max(fromN, dayNum(r.rangeStart));
      const e = Math.min(toN, dayNum(r.rangeEnd));
      for (let n = s; n <= e; n++) covered.add(dateOfDayNum(n));
    } else {
      for (const key of partialCov.get(r.generationId) || []) {
        const [d, t] = key.split('|');
        if (t === r.shiftTypeId) covered.add(d);
      }
    }
  }
  for (const typeId of generatedTypeIds) {
    const covered = coveredByType.get(typeId) || new Set<string>();
    const undrafted: string[] = [];
    for (let n = fromN; n <= toN; n++) {
      const d = dateOfDayNum(n);
      if (!covered.has(d)) undrafted.push(d);
    }
    out[typeId] = undrafted;
  }
  // Requirements and rotations are independent (Deepika, 2026-11-15):
  // a generated type NO rotation produces can never be drafted, so it
  // is never "not drafted" — its staffing target always counts and
  // its open slots show as per the set requirement. Types WITH a
  // rotation keep the N2 rule: undrafted dates show no opens until
  // drafted. The check is dynamic (rotations as they exist now), so
  // creating a rotation for the type later returns it to normal
  // generated behaviour.
  const withRotations = await getTypesWithRotations(q, companyId);
  for (const typeId of generatedTypeIds) {
    if (!withRotations.has(typeId)) out[typeId] = [];
  }
  return out;
}

/**
 * Per generated type, the dates in [from, to] whose opens read from
 * STORED rows (draft design, Deepika 2026-11-23): a drafted date
 * reads stored opens for ALL generated types; the computed target
 * count survives only on undrafted dates.
 *
 * A date is stored for a type when either:
 *  (a) a rotation producing the type generated over it (the
 *      complement of getNotDraftedByType), or
 *  (b) a rotation-less shortfall ledger row covers it (step 1 of a
 *      draft stored that type's target there, under a NULL-rotation
 *      generation — count 0 included, the row is the marker).
 *
 * The rotation-less exemption in getNotDraftedByType is deliberately
 * NOT reproduced here: for a type with no rotation, (a) is empty and
 * only (b) marks dates stored — an undrafted rotation-less date
 * keeps its computed target count until a draft actually stores it.
 * That exemption stays load-bearing for the gate's undrafted
 * target-zeroing and for the close paths; this map is ONLY for the
 * grid's stored-vs-computed determination.
 */
export async function getStoredModelDates(
  q: QueryFn,
  companyId: string,
  generatedTypeIds: Set<string>,
  from: string,
  to: string
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (!generatedTypeIds.size) return out;
  const [notDrafted, withRotations] = await Promise.all([
    getNotDraftedByType(q, companyId, generatedTypeIds, from, to),
    getTypesWithRotations(q, companyId),
  ]);
  const fromN = dayNum(from);
  const toN = dayNum(to);
  const allDates: string[] = [];
  for (let n = fromN; n <= toN; n++) allDates.push(dateOfDayNum(n));
  for (const typeId of generatedTypeIds) {
    if (!withRotations.has(typeId)) { out[typeId] = []; continue; }
    const undrafted = new Set(notDrafted[typeId] || []);
    out[typeId] = allDates.filter((d) => !undrafted.has(d));
  }
  // (b) step-1 ledger coverage: shortfall rows under
  // NULL-rotation generations (step 1's target store) — every
  // step-1 type, not just rotation-less ones, so a footprint type
  // with no rotation in the draft still reads stored after publish
  // instead of the computed count double-counting shortfall + extra.
  const { rows } = await q(
    `SELECT DISTINCT gos.date::text AS date, gos.shift_type_id AS "shiftTypeId"
     FROM generation_open_slots gos
     JOIN rotation_generations rg ON rg.id = gos.generation_id
     WHERE gos.company_id = $1 AND gos.kind = 'shortfall'
       AND rg.rotation_id IS NULL AND gos.date >= $2 AND gos.date <= $3`,
    [companyId, from, to]
  );
  for (const r of rows) {
    if (!generatedTypeIds.has(r.shiftTypeId)) continue;
    if (!out[r.shiftTypeId].includes(r.date)) out[r.shiftTypeId].push(r.date);
  }
  for (const typeId of Object.keys(out)) out[typeId].sort();
  return out;
}

/**
 * Gate check for POST /generate: every named rotation must produce
 * only generated-type shifts. Returns the names of the live-mode
 * departments blocking the draft (empty when all generatable).
 */
export async function checkRotationsGeneratable(
  q: QueryFn,
  companyId: string,
  rotationIds: string[]
): Promise<{ ok: boolean; liveDepartmentNames: string[] }> {
  // Unknown rotations pass through to the engine (it answers 404) —
  // the gate only judges rotations that exist. A rotation with no
  // shift types at all (no assignments, no group type) also passes
  // through: it drafts nothing, and the engine decides what to do
  // with it.
  const { rows: existing } = await q(
    'SELECT id FROM rotations WHERE company_id = $1 AND id = ANY($2::uuid[])',
    [companyId, rotationIds]
  );
  const existingIds = new Set(existing.map((r: any) => r.id));
  const { rows } = await q(
    `SELECT ra.rotation_id AS "rotationId", ra.shift_type_id AS "shiftTypeId"
     FROM rotation_assignments ra
     JOIN rotations r ON r.id = ra.rotation_id
     WHERE r.company_id = $1 AND ra.rotation_id = ANY($2::uuid[])
     UNION
     SELECT r.id, r.group_shift_type_id FROM rotations r
     WHERE r.company_id = $1 AND r.id = ANY($2::uuid[]) AND r.group_shift_type_id IS NOT NULL`,
    [companyId, rotationIds]
  );
  const typesByRotation = new Map<string, string[]>();
  for (const row of rows) {
    if (!typesByRotation.has(row.rotationId)) typesByRotation.set(row.rotationId, []);
    typesByRotation.get(row.rotationId)!.push(row.shiftTypeId);
  }
  const generatedTypes = await getGeneratedTypeIds(q, companyId);
  const blocked = rotationIds.filter((rid) => {
    if (!existingIds.has(rid)) return false;
    const types = typesByRotation.get(rid) || [];
    return types.length > 0 && types.some((t) => !generatedTypes.has(t));
  });
  if (!blocked.length) return { ok: true, liveDepartmentNames: [] };
  const [typeDepts, modes] = await Promise.all([
    getTypeDepartments(q, companyId),
    getDepartmentModes(q, companyId),
  ]);
  const liveDeptIds = new Set<string>();
  for (const rid of blocked) {
    for (const t of typesByRotation.get(rid) || []) {
      for (const d of typeDepts.get(t) || []) {
        if ((modes.get(d) || 'live') !== 'generated') liveDeptIds.add(d);
      }
    }
  }
  let names: string[] = [];
  if (liveDeptIds.size) {
    const { rows: drows } = await q(
      'SELECT name FROM departments WHERE id = ANY($1::uuid[]) ORDER BY name',
      [[...liveDeptIds]]
    );
    names = drows.map((r: any) => r.name);
  }
  return { ok: false, liveDepartmentNames: names };
}

/**
 * The most recent generation per rotation (for the D6 badge and the
 * draft panel): rotation id -> { id, createdAt }.
 */
export async function getLastGenerations(
  q: QueryFn,
  companyId: string,
  rotationIds: string[]
): Promise<Map<string, { id: string; createdAt: string }>> {
  const out = new Map<string, { id: string; createdAt: string }>();
  if (!rotationIds.length) return out;
  const { rows } = await q(
    `SELECT DISTINCT ON (rotation_id) rotation_id AS "rotationId", id,
            created_at::text AS "createdAt"
     FROM rotation_generations
     WHERE company_id = $1 AND rotation_id = ANY($2::uuid[])
     ORDER BY rotation_id, created_at DESC`,
    [companyId, rotationIds]
  );
  for (const r of rows) out.set(r.rotationId, { id: r.id, createdAt: r.createdAt });
  return out;
}
