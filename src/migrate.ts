// migrate.ts — `npm run migrate`: run pending migrations, then exit.
import dotenv from 'dotenv';
dotenv.config();

import { ensureReady, close } from './db';

async function main(): Promise<void> {
  await ensureReady();
  console.log('[migrate] all migrations applied.');
  await close();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
