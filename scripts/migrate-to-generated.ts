// scripts/migrate-to-generated.ts — Stage 4 migration to generated mode
// (Deepika, 2026-11-13 — background rotations).
//
// Migrates ONE company from live drawing to stored generated shifts:
//   1. computes the live draw over the range (the old way),
//   2. generates the same range as ALREADY-PUBLISHED stored rows
//      (allowPast: true, publishMode: 'published', mode 'fresh'),
//   3. writes a comparison report (per person per week: drawn vs
//      stored counts, plus every differing date) to the goal's
//      hidden_files/,
//   4. flips the company's schedule_mode flag — ONLY with --flip.
//
// Run via `npx tsx`, NOT a route. Rehearse on the fixture only.
// NEVER run against production without Deepika's explicit go at a
// quiet evening AND a full production DB dump first — the script
// enforces the dump: a remote (non-localhost) DATABASE_URL refuses
// to run unless --allow-remote-db AND --dump-file <existing file>
// are both given.
//
// Usage (from the app dir):
//   npx tsx scripts/migrate-to-generated.ts --company <uuid>
//     [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//     [--dry-run] [--flip] [--out <path>]
//     [--allow-remote-db --dump-file <path>]
//   Default range (N4): earliest active pattern start through
//   6 months out from today. --dry-run computes the report without
//   writing anything or flipping. Without --flip the flag is left
//   alone — re-run with --flip after reviewing the report.
//
// Env: same as the server (PGDATA_DIR for local PGlite, or
// DATABASE_URL for a remote DB). Add TZ=America/Chicago when
// timezone-sensitive.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, withTransaction } from '../src/db.js';
import { generateRotations } from '../src/util/rotationEngine.js';
import { getScheduleMode, setScheduleMode } from '../src/util/scheduleMode.js';
import { companyTodayStr } from '../src/util/notifyJobs.js';
import { drawRotationOccurrences } from '../src/routes/schedule.js';
import { auditLog } from '../src/util/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOAL_DIR = path.resolve(__dirname, '..', '..');

function usage(): never {
  console.error(`Usage: npx tsx scripts/migrate-to-generated.ts --company <uuid>
  [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--dry-run] [--flip]
  [--out <path>] [--allow-remote-db --dump-file <path>]`);
  process.exit(2);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) usage();
    const key = a.slice(2);
    if (key === 'dry-run' || key === 'flip' || key === 'allow-remote-db') { out[key] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) usage();
    out[key] = v;
  }
  return out;
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday (ISO week start) for a date. */
function weekStart(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const companyId = String(args.company || '');
  if (!companyId) usage();
  const dryRun = args['dry-run'] === true;
  const flip = args.flip === true;

  // ---- Remote-DB guard: production migration needs her explicit go
  // AND a full DB dump first. A localhost DATABASE_URL (or none,
  // i.e. local PGlite) is the fixture path and needs no dump.
  const dbUrl = process.env.DATABASE_URL || '';
  let remote = false;
  if (dbUrl) {
    try {
      const host = new URL(dbUrl).hostname;
      remote = host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
    } catch { remote = true; }
  }
  if (remote) {
    if (args['allow-remote-db'] !== true || typeof args['dump-file'] !== 'string') {
      console.error('REFUSING: DATABASE_URL points at a remote database.\n' +
        'Production migration needs Deepika\'s explicit go AND a full DB dump first.\n' +
        'Re-run with --allow-remote-db --dump-file <path to the dump>.');
      process.exit(3);
    }
    const st = await fs.stat(String(args['dump-file'])).catch(() => null);
    if (!st || !st.isFile() || st.size === 0) {
      console.error(`REFUSING: --dump-file ${args['dump-file']} does not exist or is empty. Take a full production DB dump first.`);
      process.exit(3);
    }
  }

  const { rows: coRows } = await query(
    'SELECT id, name FROM companies WHERE id = $1', [companyId]
  );
  if (!coRows.length) {
    console.error(`Company not found: ${companyId}`);
    process.exit(1);
  }
  const companyName = coRows[0].name || companyId;
  const modeBefore = await getScheduleMode(query, companyId);
  if (modeBefore === 'generated' && !dryRun) {
    console.error(`Company ${companyName} is ALREADY in generated mode — nothing to migrate.`);
    process.exit(1);
  }

  const today = await companyTodayStr(companyId);
  // Default range (N4): earliest active pattern start through
  // 6 months out from today.
  let from = String(args.from || '');
  let to = String(args.to || '');
  if (!from || !to) {
    const { rows: rRows } = await query(
      `SELECT MIN(start_date)::text AS "minStart" FROM rotations
       WHERE company_id = $1 AND is_active = true`, [companyId]
    );
    const minStart = rRows[0]?.minStart as string | null;
    if (!from) from = minStart || today;
    if (!to) to = addDays(today, 182);
  }
  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    console.error(`Bad range: ${from} – ${to}`);
    process.exit(2);
  }
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) {
    console.error('Range is over a year — narrow it.');
    process.exit(2);
  }

  const { rows: rotRows } = await query(
    `SELECT id, name FROM rotations WHERE company_id = $1 AND is_active = true ORDER BY name`,
    [companyId]
  );
  const rotationIds = rotRows.map((r: any) => r.id);
  if (!rotationIds.length) {
    console.error(`Company ${companyName} has no active rotations — nothing to migrate.`);
    process.exit(1);
  }

  console.log(`Migrating ${companyName} (${companyId}) — ${from} to ${to} — ` +
    `${rotationIds.length} active rotations — mode before: ${modeBefore}` +
    (dryRun ? ' — DRY RUN (nothing written, flag untouched)' : ''));

  // ---- 1. The live draw over the range (the old way), computed
  // BEFORE generation, against the stored rows as they stand now.
  const { rows: storedNow } = await query(
    `SELECT user_id AS "userId", date::text AS date, shift_type_id AS "shiftTypeId"
     FROM shifts WHERE company_id = $1 AND date >= $2 AND date <= $3`,
    [companyId, from, to]
  );
  const { occurrences: drawn } = await drawRotationOccurrences(query, companyId, from, to, storedNow);

  // ---- 2. Generation. Dry run computes only; the real run writes
  // already-published stored rows (allowPast: migration covers the
  // past too — past shifts are truth, never re-drawn by the grid
  // once stored) and returns the created rows for the report.
  const systemUser = (await query(
    `SELECT id FROM users WHERE company_id = $1 AND role = 'owner' LIMIT 1`,
    [companyId]
  )).rows[0]?.id as string | undefined;
  if (!systemUser) {
    console.error(`No owner user found for ${companyName} — cannot attribute the migration.`);
    process.exit(1);
  }
  const summary = dryRun
    ? await generateRotations(query as any, companyId, {
        rotationIds, from, to, mode: 'fresh', dryRun: true, allowPast: true,
        createdBy: systemUser,
      })
    : await withTransaction(async (tx) => {
        const q: any = (text: string, params?: any[]) => tx.query(text, params);
        return generateRotations(q, companyId, {
          rotationIds, from, to, mode: 'fresh', allowPast: true,
          publishMode: 'published', createdBy: systemUser,
        });
      });
  if (!dryRun) {
    for (const e of summary.auditEntries || []) await auditLog(e);
  }
  const created = summary.createdRows || [];

  // ---- 3. Comparison: per person per week, drawn vs stored.
  const { rows: userRows } = await query(
    `SELECT id, COALESCE(nickname, first_name || ' ' || last_name) AS name
     FROM users WHERE company_id = $1`, [companyId]
  );
  const nameOf = new Map<string, string>(userRows.map((u: any) => [u.id, u.name]));
  const typeOf = new Map<string, string>();
  {
    const { rows: tRows } = await query(
      'SELECT id, name FROM shift_types WHERE company_id = $1', [companyId]
    );
    for (const t of tRows) typeOf.set(t.id, t.name);
  }
  const key = (userId: string, date: string) => `${userId}|${weekStart(date)}`;
  const drawnByKey = new Map<string, number>();
  const createdByKey = new Map<string, number>();
  for (const o of drawn) drawnByKey.set(key(o.userId, o.date), (drawnByKey.get(key(o.userId, o.date)) || 0) + 1);
  for (const c of created) createdByKey.set(key(c.userId, c.date), (createdByKey.get(key(c.userId, c.date)) || 0) + 1);

  const drawnKeys = new Set(drawn.map((o: any) => `${o.userId}|${o.date}|${o.shiftTypeId}`));
  const createdKeys = new Set(created.map((c: any) => `${c.userId}|${c.date}|${c.shiftTypeId}`));
  const skipReason = new Map<string, string>();
  for (const d of summary.skippedDetail || []) {
    skipReason.set(`${d.userId}|${d.date}|${d.shiftTypeId}`, d.reason);
  }
  const drawnNotCreated: Array<{ userId: string; date: string; shiftTypeId: string; reason: string }> = [];
  for (const o of drawn) {
    const k = `${o.userId}|${o.date}|${o.shiftTypeId}`;
    if (!createdKeys.has(k)) {
      drawnNotCreated.push({
        userId: o.userId, date: o.date, shiftTypeId: o.shiftTypeId,
        reason: skipReason.get(k) || 'not created (no skip recorded — see note)',
      });
    }
  }
  const createdNotDrawn: Array<{ userId: string; date: string; shiftTypeId: string }> = [];
  for (const c of created) {
    const k = `${c.userId}|${c.date}|${c.shiftTypeId}`;
    if (!drawnKeys.has(k)) createdNotDrawn.push(c);
  }

  const allKeys = [...new Set([...drawnByKey.keys(), ...createdByKey.keys()])].sort();
  const personWeekRows = allKeys.map((k) => {
    const [userId, wk] = k.split('|');
    const d = drawnByKey.get(k) || 0;
    const c = createdByKey.get(k) || 0;
    return { userId, name: nameOf.get(userId) || userId, week: wk, drawn: d, created: c, diff: c - d };
  });

  // ---- 4. Report.
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const lines: string[] = [];
  lines.push(`# Migration to generated mode — ${companyName}`);
  lines.push('');
  lines.push(`- Company: ${companyName} (${companyId})`);
  lines.push(`- Range: ${from} to ${to}`);
  lines.push(`- Run: ${stamp} UTC — ${dryRun ? 'DRY RUN (nothing written)' : 'REAL (published rows written)'}`);
  lines.push(`- Mode before: ${modeBefore}; mode after: ${dryRun ? '(unchanged — dry run)' : (flip ? 'generated (flipped by this run)' : 'live (NOT flipped — re-run with --flip)')}`);
  lines.push(`- Rotations migrated: ${rotationIds.length} (${rotRows.map((r: any) => r.name).join(', ')})`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Drawn (old way, live draw over the range): ${drawn.length} shifts`);
  lines.push(`- Created (new way, stored ${dryRun ? 'would-be ' : ''}published rows): ${created.length} shifts`);
  lines.push(`- Skipped by generation: vacation ${summary.skipped.vacation}, already-has-shift ${summary.skipped.alreadyHasShift}, ended ${summary.skipped.ended}, excluded ${summary.skipped.excluded}, past ${summary.skipped.past}`);
  if (!dryRun) {
    lines.push(`- Replaced drafts: ${summary.replacedDrafts}; opened slots (rule 7): ${summary.openedSlots}`);
    lines.push(`- Generations: ${summary.generationIds.join(', ')}`);
  }
  lines.push(`- Drawn but not created: ${drawnNotCreated.length}; created but not drawn: ${createdNotDrawn.length}`);
  lines.push('');
  lines.push('## Per person per week');
  lines.push('');
  lines.push('| Person | Week starting | Drawn | Created | Diff |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of personWeekRows) {
    lines.push(`| ${r.name} | ${r.week} | ${r.drawn} | ${r.created} | ${r.diff > 0 ? '+' : ''}${r.diff} |`);
  }
  lines.push('');
  lines.push('## Drawn but not created (expected: D4 skips — vacation, already has a shift, ended, previously deleted)');
  lines.push('');
  if (!drawnNotCreated.length) lines.push('None.');
  else {
    for (const d of drawnNotCreated.slice(0, 500)) {
      lines.push(`- ${nameOf.get(d.userId) || d.userId} — ${d.date} ${typeOf.get(d.shiftTypeId) || d.shiftTypeId} — ${d.reason}`);
    }
    if (drawnNotCreated.length > 500) lines.push(`- …and ${drawnNotCreated.length - 500} more.`);
  }
  lines.push('');
  lines.push('## Created but not drawn (should be rare — a row the live draw suppressed that generation creates)');
  lines.push('');
  if (!createdNotDrawn.length) lines.push('None.');
  else {
    for (const d of createdNotDrawn.slice(0, 500)) {
      lines.push(`- ${nameOf.get(d.userId) || d.userId} — ${d.date} ${typeOf.get(d.shiftTypeId) || d.shiftTypeId}`);
    }
    if (createdNotDrawn.length > 500) lines.push(`- …and ${createdNotDrawn.length - 500} more.`);
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- "Drawn" is what the live grid used to show for these dates; "Created" is what the migration stored as published rows.');
  lines.push('- A negative Diff is usually a D4 skip (the person was on vacation, already had a shift that day, or was previously deleted). Check the list above.');
  lines.push('- A positive Diff is a row generation creates that the draw suppressed (e.g. the draw\'s special-precedence pass hid a per-person occurrence under a group shift; generation deals the group first and skips the clash instead — same person, same day, one row either way).');
  lines.push('- Past dates in the range are stored as published truth and never re-drawn; future dates are stored published so the schedule looks identical the day the flag flips.');
  if (!flip && !dryRun) lines.push('- The flag was NOT flipped by this run. Review this report, then re-run with --flip to switch the company to generated mode.');

  const outPath = String(args.out || '') ||
    path.join(GOAL_DIR, 'hidden_files', `migration-to-generated-${companyId.slice(0, 8)}-${from}-to-${to}${dryRun ? '-dryrun' : ''}.md`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Report written: ${outPath}`);
  console.log(`Drawn ${drawn.length} · created ${created.length} · drawn-not-created ${drawnNotCreated.length} · created-not-drawn ${createdNotDrawn.length}`);

  // ---- 5. Flip the flag — only with --flip, never on a dry run.
  if (flip && !dryRun) {
    await setScheduleMode(query, companyId, 'generated');
    console.log(`Schedule mode flipped to 'generated' for ${companyName}.`);
  } else if (!dryRun) {
    console.log('Flag NOT flipped — re-run with --flip after reviewing the report.');
  }
}

main().catch((err) => {
  console.error('Migration failed:', err?.message || err);
  process.exit(1);
});
