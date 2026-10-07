// db.ts — database connection, migration runner, query helper.
//
// Two modes:
//  - DATABASE_URL set → managed Postgres via `pg` Pool (production / Render).
//    Data persists across deploys.
//  - DATABASE_URL unset → PGlite embedded Postgres (local dev).
//    Data persists to ./data/pgdata; override with PGDATA_DIR.
//
// Same SQL and migrations in both modes — no schema changes needed.

import path from 'path';
import fs from 'fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

function dataDir(): string {
  const configured = process.env.PGDATA_DIR || './data/pgdata';
  return path.resolve(__dirname, '..', configured);
}

type DbClient = PGlite | Pool;
let db: DbClient | null = null;
let ready: Promise<void> | null = null;
let usingPool = false;

async function open(): Promise<DbClient> {
  if (db) return db;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
    });
    // Verify connectivity now so boot fails fast on a bad URL.
    await pool.query('SELECT 1');
    db = pool;
    usingPool = true;
    console.log('[db] using managed Postgres (pg Pool)');
  } else {
    const dir = dataDir();
    await fs.mkdir(dir, { recursive: true });
    const pg = new PGlite({ dataDir: dir });
    await pg.waitReady;
    db = pg;
    console.log('[db] using embedded PGlite');
  }
  return db;
}

/** Ensure the DB is open and all pending migrations have run (idempotent). */
export function ensureReady(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const client = await open();
      if (usingPool) {
        const pool = client as Pool;
        await pool.query(`
          CREATE TABLE IF NOT EXISTS migrations (
            name text PRIMARY KEY,
            applied_at timestamptz NOT NULL DEFAULT now()
          );
        `);
        const { rows } = await pool.query<{ name: string }>(
          'SELECT name FROM migrations ORDER BY name'
        );
        const appliedSet = new Set(rows.map((r) => r.name));
        const files = (await fs.readdir(MIGRATIONS_DIR))
          .filter((f) => f.endsWith('.sql'))
          .sort();
        for (const file of files) {
          if (appliedSet.has(file)) continue;
          const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
          const pgClient = await pool.connect();
          try {
            await pgClient.query('BEGIN');
            await pgClient.query(sql);
            await pgClient.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
            await pgClient.query('COMMIT');
            console.log(`[db] applied migration ${file}`);
          } catch (err) {
            await pgClient.query('ROLLBACK');
            throw err;
          } finally {
            pgClient.release();
          }
        }
      } else {
        const pg = client as PGlite;
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
          await pg.exec(
            `BEGIN;\n${sql}\nINSERT INTO migrations (name) VALUES ('${file.replace(/'/g, "''")}');\nCOMMIT;`
          );
          console.log(`[db] applied migration ${file}`);
        }
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
  if (usingPool) {
    const result = await (db as Pool).query(text, params);
    const rows = result.rows as T[];
    return { rows, rowCount: result.rowCount ?? rows.length };
  }
  const result = await (db as PGlite).query(text, params);
  const rows = result.rows as T[];
  const affected =
    typeof (result as any).affectedRows === 'number' ? (result as any).affectedRows : 0;
  return { rows, rowCount: rows.length > 0 ? rows.length : affected };
}

/** Close the DB client (used by the migrate CLI). */
export async function close(): Promise<void> {
  if (db) {
    if (usingPool) await (db as Pool).end();
    else await (db as PGlite).close();
    db = null;
    ready = null;
    usingPool = false;
  }
}
