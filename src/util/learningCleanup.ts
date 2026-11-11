// util/learningCleanup.ts — one-time removal of the poisoned planner
// learning example(s) saved on the evening of 2026-11-10.
//
// That evening a clarification reply was resolved into a plan that
// WRONGLY gave Sha Kum's 2026-12-02 Day Hospitalist shift to
// Aditya Rander (the reader anchored the request's "me" to the
// mailbox's quoted author instead of the named person, Bon Dah).
// Because the reply resolved into a created plan, saveLearningExample
// stored the pair in the company's example book — and the very next
// email (a clean plain send) repeated the same wrong reading,
// apparently by copying that fresh lesson. Deepika approved deleting
// the bad example(s); she declined any wider change to how the
// planner reads or learns (parked 2026-11-10), so this deletes ONLY
// those rows and nothing else.
//
// Runs exactly once per database: the run is claimed by inserting a
// marker row into platform_state (migration 069 — the same
// claim-by-insert pattern util/platformAlert.ts uses), so restarts
// and later deploys skip it. The DELETE itself is fenced four ways
// so it cannot touch anything else:
//   - source must be 'clarification-reply' (form resolutions are
//     'clarification-form' and are never touched);
//   - created_at must fall in the Nov 10 evening window
//     (2026-11-10 23:00 UTC .. 2026-11-11 06:00 UTC — 8:03 PM CST is
//     2026-11-11 02:03 UTC; the CORRECT 4:49 PM plan that day, which
//     resolved to Bon Dah, is 22:49 UTC and outside the window);
//   - resolved_text must name Aditya Rander (the wrong resolution);
//   - resolved_text must reference the Dec 2 Day Hospitalist move
//     (both the ISO date and the spelled-out date are accepted, as
//     the stored summary uses the spelled-out form).

import { query } from '../db';

const MARKER_KEY = 'cleanup:learning-examples-2026-11-10';

export async function runLearningCleanupOnce(): Promise<void> {
  try {
    // Claim the one run: only the boot whose INSERT lands proceeds.
    const { rows: claimed } = await query(
      `INSERT INTO platform_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [MARKER_KEY, 'claimed']
    );
    if (!claimed.length) return; // already ran on an earlier boot

    const { rows: deleted } = await query(
      `DELETE FROM email_learning_examples
        WHERE source = 'clarification-reply'
          AND created_at >= TIMESTAMPTZ '2026-11-10 23:00+00'
          AND created_at <  TIMESTAMPTZ '2026-11-11 06:00+00'
          AND resolved_text ILIKE '%Aditya Rander%'
          AND resolved_text ILIKE '%Day Hospitalist%'
          AND (resolved_text ILIKE '%2026-12-02%'
               OR resolved_text ILIKE '%December 2, 2026%')
        RETURNING id`
    );
    const n = deleted.length;
    await query(
      `UPDATE platform_state SET value = $2, updated_at = NOW() WHERE key = $1`,
      [MARKER_KEY, `deleted=${n} at ${new Date().toISOString()}`]
    );
    console.log(`[learning-cleanup] deleted ${n} learning example(s)`);
  } catch (err: any) {
    // Never block boot on a cleanup. Release the claim so a later
    // boot retries, and leave a trace in the log.
    try {
      await query('DELETE FROM platform_state WHERE key = $1', [MARKER_KEY]);
    } catch { /* best-effort */ }
    console.error('[learning-cleanup] failed (will retry on next boot):', err?.message || err);
  }
}
