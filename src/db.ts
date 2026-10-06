// db.ts — PGlite (real embedded Postgres) connection, migration runner, query helper.
// Data persists to ./data/pgdata (relative to the app dir); override with PGDATA_DIR.
// Production path: replace this file's PGlite wiring with a `pg` Pool against managed
// Postgres — same SQL, no schema changes (per PHASE1_NOTES.md).

import path from 'path';
import fs from 'fs/promises';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

function dataDir(): string {
  const configured = process.env.PGDATA_DIR || './data/pgdata';
  // Resolve relative to the app dir (parent of src/ or dist/).
  return path.resolve(__dirname, '..', configured);
}

let db: PGlite | null = null;
let ready: Promise<void> | null = null;

async function open(): Promise<PGlite> {
  if (db) return db;
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true }); // PGlite needs the dir to exist
  const pg = new PGlite({ dataDir: dir });
  await pg.waitReady;
  db = pg;
  return pg;
}

/** Ensure the DB is open and all pending migrations have run (idempotent). */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const pg = await open();
      await pg.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      const applied = await pg.query<{ name: string }>(
        'SELECT name FROM migrations ORDER BY name'
      );
      const appliedSet = new Set(applied.rows.map((r) => r.name));

      const files = (await fs.readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      for (const file of files) {
        if (appliedSet.has(file)) continue;
        const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        // Run each migration file atomically: BEGIN; <file>; INSERT record; COMMIT;
        await pg.exec(
          `BEGIN;\n${sql}\nINSERT INTO migrations (name) VALUES ('${file.replace(/'/g, "''")}');\nCOMMIT;`
        );
        console.log(`[db] applied migration ${file}`);
      }
    })();
  }
  return ready;
}

/** Parameterized query helper. Always use $1, $2, … — never interpolate values. */
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<{ rows: T[]; rowCount: number }> {
  await ensureReady();
  const result = await db!.query(text, params);
  const rows = result.rows as T[];
  // PGlite: affectedRows is 0 for SELECTs (rows holds the data); for
  // INSERT/UPDATE/DELETE without RETURNING, rows is empty and affectedRows is the count.
  const affected = typeof (result as any).affectedRows === 'number' ? (result as any).affectedRows : 0;
  return { rows, rowCount: rows.length > 0 ? rows.length : affected };
}

/** Close the PGlite instance (used by the migrate CLI). */
export async function close(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    ready = null;
  }
}
