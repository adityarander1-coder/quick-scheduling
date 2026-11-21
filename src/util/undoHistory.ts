/**
 * Persistent 3-step Undo/Redo (Deepika, 2026-11-17).
 *
 * Undo/Redo used to live only in the open page — a reload wiped the
 * stacks. The last 3 undoable actions (and their redo counterparts)
 * are now stored server-side, per user per company, so Undo (button
 * or Ctrl+Z) steps back up to 3 changes and Redo (button or
 * Ctrl+Shift+Z) steps forward up to 3, even after a reload, on the
 * phone and the computer alike. Depth is exactly 3, everywhere: the
 * 4th undoable action pushes the oldest one out.
 *
 * Entries are the same shapes the client stacks already hold:
 *   - { kind: 'server', undo: { ops: [...] }, redo: { kind: 'move'|'swap', ... } }
 *     (drag-move / drag-swap returning a server undo payload)
 *   - { kind: 'move', shiftId, fromDate, fromType, redo: { kind: 'move', shiftId, date, typeId } }
 *   - { kind: 'swap', aId, bId, redo: { kind: 'swap', aId, bId } }
 *   - { kind: 'delete', undo: { deletedAt, units, sweepExclusions, grants, pauses },
 *       redo: { kind: 'delete', calls: [...], pauses: [...] } }
 *     (a bulk delete is ONE entry, as today)
 *   - { kind: 'openslot', undo: { slots: [{ date, shiftTypeId,
 *       totalBefore, draftBefore, wasDraft, adjust }] },
 *       redo: { kind: 'openslot', calls: [...] } }
 *     (closing open slots — Deepika, 2026-11-17; a bulk close is ONE
 *     entry; adjust is what the undo adds back to extra_open_slots:
 *     +1 per -1 close, or the exact removed row count for a DELETE)
 *   - { kind: 'import', undo: { shiftIds, rows }, redo: { kind: 'import', rows } }
 *     (a schedule upload — Deepika, 2026-11-20; undo removes exactly
 *     the rows the import added, redo puts them back)
 * Task undo is NOT stored here — it is already server-side
 * (src/util/planUndo.ts) and is untouched.
 *
 * 60-second window (Deepika, 2026-11-20 — "60 seconds like we planned
 * before"): an undo is only valid within 60s of the change, a redo
 * only within 60s of the undo. Every entry carries its action time
 * (`at`, stamped by the client when the action happened — or when it
 * was undone, for redo entries); the execution endpoints refuse a
 * request whose carried time is older than the window
 * (undoWindowExpired). A missing time is allowed through — entries
 * written before this build carry none, and they age out of the
 * depth-3 stacks on their own.
 *
 * The client POSTs the whole stacks whenever they change and GETs
 * them at login. Validation is strict: unknown kinds, malformed
 * fields, or anything over the size cap is dropped (a bad entry never
 * breaks the stacks). The existing server guards still decide
 * whether a restored entry applies — delete-undo skips a unit whose
 * slot was taken, whose person is gone/inactive/past their last
 * working day (Rule 7), or whose rotation ended; drag-undo refuses
 * malformed ops. Persistence never weakens a guard.
 */
import { query } from '../db.js';

export const UNDO_DEPTH = 3;
// A bulk delete of 500 units carries a large undo payload; 1 MB is
// far above any 3-entry stack in practice and far below any abuse.
const MAX_STACK_BYTES = 1_000_000;

// 60-second Undo/Redo window (Deepika, 2026-11-20 — "60 seconds like
// we planned before"): an undo is only valid within 60s of the
// change, a redo only within 60s of the undo. The server enforces it
// on every undo/redo execution endpoint — a client button disable
// alone is not enough.
export const UNDO_WINDOW_MS = 60_000;
export const UNDO_WINDOW_EXPIRED_MSG = 'That change is more than 60 seconds old, so it can no longer be undone.';
export const REDO_WINDOW_EXPIRED_MSG = 'That undo is more than 60 seconds old, so it can no longer be redone.';

/** True when the carried time is unparseable or more than the window
 * old. A MISSING time is NOT expired: entries written before this
 * build (and direct API calls, which the suites use) carry no time,
 * and they predate the window rule — they age out of the depth-3
 * stacks on their own. The client disables no-time entries; the
 * server enforces the window on every request that carries a time. */
export function undoWindowExpired(at: any): boolean {
  if (at === undefined || at === null) return false;
  if (typeof at !== 'string') return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > UNDO_WINDOW_MS;
}

function isPlainObject(v: any): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isValidDate(s: any): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isNonEmptyString(v: any): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Validate one drag-undo op the way /shifts/drag-undo does: exactly one of the three kinds. */
function cleanDragOp(op: any): any | null {
  if (!isPlainObject(op)) return null;
  const kinds = ['deleteShiftId', 'deleteExclusion', 'updateShiftUser'].filter((k) => op[k]);
  if (kinds.length !== 1) return null;
  if (op.deleteShiftId && !isNonEmptyString(op.deleteShiftId)) return null;
  if (op.deleteExclusion) {
    const e = op.deleteExclusion;
    if (!isPlainObject(e) || !isNonEmptyString(e.rotationId) || !isNonEmptyString(e.userId)
      || !isValidDate(e.date) || !isNonEmptyString(e.shiftTypeId)) return null;
  }
  if (op.updateShiftUser) {
    const u = op.updateShiftUser;
    if (!isPlainObject(u) || !isNonEmptyString(u.shiftId) || !isNonEmptyString(u.userId)) return null;
  }
  return op;
}

function cleanMoveRedo(r: any): any | null {
  if (!isPlainObject(r) || r.kind !== 'move') return null;
  if (!isNonEmptyString(r.shiftId) || !isValidDate(r.date) || !isNonEmptyString(r.typeId)) return null;
  return { kind: 'move', shiftId: r.shiftId, date: r.date, typeId: r.typeId };
}

function cleanSwapRedo(r: any): any | null {
  if (!isPlainObject(r) || r.kind !== 'swap') return null;
  if (!isNonEmptyString(r.aId) || !isNonEmptyString(r.bId)) return null;
  return { kind: 'swap', aId: r.aId, bId: r.bId };
}

/** A delete undo payload: the shape delete endpoints return (see the delete-undo route). */
function cleanDeleteUndo(u: any): any | null {
  if (!isPlainObject(u)) return null;
  if (typeof u.deletedAt !== 'string' || !u.deletedAt) return null;
  const units = Array.isArray(u.units) ? u.units : null;
  const sweepExclusions = Array.isArray(u.sweepExclusions) ? u.sweepExclusions : null;
  const grants = Array.isArray(u.grants) ? u.grants : null;
  const pauses = Array.isArray(u.pauses) ? u.pauses : null;
  if (!units || !sweepExclusions || !grants || !pauses) return null;
  const total = units.length + sweepExclusions.length + grants.length + pauses.length;
  if (!total || total > 1000) return null;
  const badUnit = (x: any): boolean => {
    if (!isPlainObject(x)) return true;
    if (x.row) return !isNonEmptyString(x.row.id) || !isNonEmptyString(x.row.userId)
      || !isNonEmptyString(x.row.shiftTypeId) || !isValidDate(x.row.date);
    if (x.primaryExclusion) return !isNonEmptyString(x.primaryExclusion.rotationId)
      || !isNonEmptyString(x.primaryExclusion.userId) || !isValidDate(x.primaryExclusion.date);
    return true;
  };
  if (units.some(badUnit)) return null;
  if (sweepExclusions.some((e: any) => !isPlainObject(e) || !isNonEmptyString(e.rotationId)
    || !isNonEmptyString(e.userId) || !isValidDate(e.date))) return null;
  if (grants.some((g: any) => !isPlainObject(g) || !isValidDate(g.date) || !isNonEmptyString(g.shiftTypeId))) return null;
  if (pauses.some((p: any) => !isPlainObject(p) || !isNonEmptyString(p.rotationId)
    || !isValidDate(p.startDate) || !isValidDate(p.endDate))) return null;
  return { deletedAt: u.deletedAt, units, sweepExclusions, grants, pauses };
}

function cleanDeleteRedo(r: any): any | null {
  if (!isPlainObject(r) || r.kind !== 'delete') return null;
  if (!Array.isArray(r.calls) || !Array.isArray(r.pauses)) return null;
  for (const c of r.calls) {
    if (!isPlainObject(c) || !isNonEmptyString(c.ep) || !isNonEmptyString(c.method)) return null;
  }
  for (const p of r.pauses) {
    if (!isPlainObject(p) || !isNonEmptyString(p.rotationId) || !isValidDate(p.startDate) || !isValidDate(p.endDate)) return null;
  }
  return { kind: 'delete', calls: r.calls, pauses: r.pauses };
}

/** An open-slot close undo payload: the shape the close endpoints return. */
function cleanOpenSlotUndo(u: any): any | null {
  if (!isPlainObject(u)) return null;
  if (!Array.isArray(u.slots) || !u.slots.length || u.slots.length > 1000) return null;
  for (const s of u.slots) {
    if (!isPlainObject(s) || !isValidDate(s.date) || !isNonEmptyString(s.shiftTypeId)) return null;
    if (!Number.isInteger(s.totalBefore) || s.totalBefore < 0 || s.totalBefore > 10000) return null;
    if (!Number.isInteger(s.adjust) || s.adjust === 0 || Math.abs(s.adjust) > 1000) return null;
    if (s.wasDraft !== undefined && typeof s.wasDraft !== 'boolean') return null;
    if (s.draftBefore !== undefined && (!Number.isInteger(s.draftBefore) || s.draftBefore < 0)) return null;
    // Close breakdown (Deepika, 2026-11-20 — "close this slot"
    // really deletes it): how many of the closed slots were stored
    // extras (really deleted) vs computed shortfall opens
    // (suppressed until the next draft/publish). The undo endpoint
    // reverses each part exactly; entries written before this build
    // carry neither and fall back to the suppressed-first rule.
    if (s.extraDeleted !== undefined && (!Number.isInteger(s.extraDeleted) || s.extraDeleted < 0 || s.extraDeleted > 1000)) return null;
    if (s.suppressed !== undefined && (!Number.isInteger(s.suppressed) || s.suppressed < 0 || s.suppressed > 1000)) return null;
    // Whole-type close breakdown (Deepika, 2026-11-20 — "close any
    // where it should be gone"): the close really deleted the stored
    // rows, so the undo puts them back — suppressedDeleted rows are
    // re-inserted, draftDeleted restores the draft-open count,
    // flagSet removes the closed flag the close set.
    if (s.suppressedDeleted !== undefined && (!Number.isInteger(s.suppressedDeleted) || s.suppressedDeleted < 0 || s.suppressedDeleted > 1000)) return null;
    if (s.draftDeleted !== undefined && (!Number.isInteger(s.draftDeleted) || s.draftDeleted < 0 || s.draftDeleted > 1000)) return null;
    if (s.flagSet !== undefined && typeof s.flagSet !== 'boolean') return null;
  }
  return {
    slots: u.slots.map((s: any) => ({
      date: s.date, shiftTypeId: s.shiftTypeId, totalBefore: s.totalBefore, adjust: s.adjust,
      ...(s.wasDraft !== undefined ? { wasDraft: s.wasDraft } : {}),
      ...(s.draftBefore !== undefined ? { draftBefore: s.draftBefore } : {}),
      ...(s.extraDeleted !== undefined ? { extraDeleted: s.extraDeleted } : {}),
      ...(s.suppressed !== undefined ? { suppressed: s.suppressed } : {}),
      ...(s.suppressedDeleted !== undefined ? { suppressedDeleted: s.suppressedDeleted } : {}),
      ...(s.draftDeleted !== undefined ? { draftDeleted: s.draftDeleted } : {}),
      ...(s.flagSet !== undefined ? { flagSet: s.flagSet } : {}),
    })),
  };
}

function cleanOpenSlotRedo(r: any): any | null {
  if (!isPlainObject(r) || r.kind !== 'openslot') return null;
  if (!Array.isArray(r.calls)) return null;
  for (const c of r.calls) {
    if (!isPlainObject(c) || !isNonEmptyString(c.ep) || !isNonEmptyString(c.method)) return null;
  }
  return { kind: 'openslot', calls: r.calls };
}

function isUuid(v: any): boolean {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** One imported shift row, as the import undo/redo endpoints carry it. */
function cleanImportRow(r: any): any | null {
  if (!isPlainObject(r)) return null;
  if (!isUuid(r.id) || !isUuid(r.userId) || !isUuid(r.shiftTypeId) || !isValidDate(r.date)) return null;
  if (typeof r.published !== 'boolean') return null;
  return {
    id: r.id, userId: r.userId, shiftTypeId: r.shiftTypeId, date: r.date, published: r.published,
    ...(isUuid(r.createdBy) ? { createdBy: r.createdBy } : {}),
  };
}

/** A schedule-import undo payload: the shift ids to delete, plus the
 * full rows so the undo can verify each row is still the imported
 * one before deleting it. */
function cleanImportUndo(u: any): any | null {
  if (!isPlainObject(u)) return null;
  if (!Array.isArray(u.shiftIds) || !u.shiftIds.length || u.shiftIds.length > 1000) return null;
  if (u.shiftIds.some((id: any) => !isUuid(id))) return null;
  if (!Array.isArray(u.rows) || !u.rows.length || u.rows.length > 1000) return null;
  const rows = u.rows.map(cleanImportRow);
  if (rows.some((r: any) => !r)) return null;
  return { shiftIds: u.shiftIds, rows };
}

function cleanImportRedo(r: any): any | null {
  if (!isPlainObject(r) || r.kind !== 'import') return null;
  if (!Array.isArray(r.rows) || !r.rows.length || r.rows.length > 1000) return null;
  const rows = r.rows.map(cleanImportRow);
  if (rows.some((x: any) => !x)) return null;
  return { kind: 'import', rows };
}

/** Keep an entry's action time (`at`, stamped by the client when the
 * action happened — or when it was undone, for redo entries) through
 * the sanitizer, so the pinned Undo/Redo pair can tell which action
 * was last — a grid change or a Task plan — even after a reload. The
 * time is advisory only: it never decides whether an entry applies
 * (the server guards still do that). */
function isValidAt(s: any): s is string {
  return typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));
}
function withAt<T extends Record<string, any>>(cleaned: T, src: any): T {
  return isValidAt(src && src.at) ? { ...cleaned, at: src.at } : cleaned;
}

/** Clean one undo-stack entry; null when it cannot be trusted. */
export function cleanUndoEntry(e: any): any | null {
  if (!isPlainObject(e) || typeof e.kind !== 'string') return null;
  if (e.kind === 'server') {
    if (!isPlainObject(e.undo) || !Array.isArray(e.undo.ops) || !e.undo.ops.length || e.undo.ops.length > 8) return null;
    const ops = e.undo.ops.map(cleanDragOp);
    if (ops.some((o: any) => !o)) return null;
    const redo = cleanMoveRedo(e.redo) || cleanSwapRedo(e.redo);
    if (!redo) return null;
    return withAt({ kind: 'server', undo: { ops }, redo }, e);
  }
  if (e.kind === 'move') {
    if (!isNonEmptyString(e.shiftId) || !isValidDate(e.fromDate) || !isNonEmptyString(e.fromType)) return null;
    const redo = cleanMoveRedo(e.redo);
    if (!redo) return null;
    return withAt({ kind: 'move', shiftId: e.shiftId, fromDate: e.fromDate, fromType: e.fromType, redo }, e);
  }
  if (e.kind === 'swap') {
    if (!isNonEmptyString(e.aId) || !isNonEmptyString(e.bId)) return null;
    const redo = cleanSwapRedo(e.redo);
    if (!redo) return null;
    return withAt({ kind: 'swap', aId: e.aId, bId: e.bId, redo }, e);
  }
  if (e.kind === 'delete') {
    const undo = cleanDeleteUndo(e.undo);
    if (!undo) return null;
    const redo = cleanDeleteRedo(e.redo);
    if (!redo) return null;
    return withAt({ kind: 'delete', undo, redo }, e);
  }
  if (e.kind === 'openslot') {
    const undo = cleanOpenSlotUndo(e.undo);
    if (!undo) return null;
    const redo = cleanOpenSlotRedo(e.redo);
    if (!redo) return null;
    return withAt({ kind: 'openslot', undo, redo }, e);
  }
  if (e.kind === 'import') {
    const undo = cleanImportUndo(e.undo);
    if (!undo) return null;
    const redo = cleanImportRedo(e.redo);
    if (!redo) return null;
    return withAt({ kind: 'import', undo, redo }, e);
  }
  return null;
}

/** Clean one redo-stack entry; null when it cannot be trusted. Redo entries are the `redo` half of undo entries. */
export function cleanRedoEntry(e: any): any | null {
  if (!isPlainObject(e) || typeof e.kind !== 'string') return null;
  if (e.kind === 'move') { const r = cleanMoveRedo(e); return r ? withAt(r, e) : null; }
  if (e.kind === 'swap') { const r = cleanSwapRedo(e); return r ? withAt(r, e) : null; }
  if (e.kind === 'delete') { const r = cleanDeleteRedo(e); return r ? withAt(r, e) : null; }
  if (e.kind === 'openslot') { const r = cleanOpenSlotRedo(e); return r ? withAt(r, e) : null; }
  if (e.kind === 'import') { const r = cleanImportRedo(e); return r ? withAt(r, e) : null; }
  return null;
}

/** Clean a whole pair of stacks: keep the newest UNDO_DEPTH entries of each, drop the rest. */
export function sanitizeUndoStacks(undo: any, redo: any): { undo: any[]; redo: any[] } {
  const cleanUndo = (Array.isArray(undo) ? undo : []).map(cleanUndoEntry).filter(Boolean).slice(-UNDO_DEPTH);
  const cleanRedo = (Array.isArray(redo) ? redo : []).map(cleanRedoEntry).filter(Boolean).slice(-UNDO_DEPTH);
  if (JSON.stringify({ undo: cleanUndo, redo: cleanRedo }).length > MAX_STACK_BYTES) return { undo: [], redo: [] };
  return { undo: cleanUndo, redo: cleanRedo };
}

export async function loadUndoHistory(companyId: string, userId: string): Promise<{ undo: any[]; redo: any[] }> {
  const { rows } = await query(
    'SELECT undo_stack AS "undoStack", redo_stack AS "redoStack" FROM schedule_undo_history WHERE company_id = $1 AND user_id = $2',
    [companyId, userId]
  );
  if (!rows.length) return { undo: [], redo: [] };
  return sanitizeUndoStacks(rows[0].undoStack, rows[0].redoStack);
}

export async function saveUndoHistory(companyId: string, userId: string, undo: any, redo: any): Promise<{ undo: any[]; redo: any[] }> {
  const clean = sanitizeUndoStacks(undo, redo);
  await query(
    `INSERT INTO schedule_undo_history (company_id, user_id, undo_stack, redo_stack, updated_at)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, now())
     ON CONFLICT (company_id, user_id) DO UPDATE
       SET undo_stack = EXCLUDED.undo_stack, redo_stack = EXCLUDED.redo_stack, updated_at = now()`,
    [companyId, userId, JSON.stringify(clean.undo), JSON.stringify(clean.redo)]
  );
  return clean;
}
