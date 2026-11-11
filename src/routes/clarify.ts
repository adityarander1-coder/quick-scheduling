// routes/clarify.ts — the clarification answer page (Deepika,
// 2026-11-10): where the clickable options in a clarification
// email land. The token in the URL IS the auth (unguessable,
// scoped to one pending clarification, dies with its row) — the
// same pattern as the form and approver links. GET renders all
// rows with real POST buttons; a GET carrying ?item&pick is the
// email's one-tap fast path (the Approve/Reject pattern) and does
// exactly what the matching button would. Each pick is saved
// immediately; when every row is answered the SAME replan path a
// prose reply takes runs, with the picks stated as exact
// resolutions, and the resulting plan goes through the normal
// gate + approver flow. Whichever door resolves the clarification
// first wins — a later click lands on the already-answered page.

import { Router, urlencoded } from 'express';
import { query } from '../db.js';
import {
  loadClarificationByToken,
  recordClarificationAnswers,
  claimClarification,
  restoreClarification,
  clarificationExpired,
  type PendingClarification,
} from '../util/pendingClarifications.js';
import {
  answerPageHtml,
  alreadyAnsweredPageHtml,
  confirmationPageHtml,
  clarifyErrorPageHtml,
} from '../util/clarifyOptions.js';
import { formLinkUrl } from '../util/formLinks.js';
import { processScheduleEmail } from '../util/emailPoller.js';

const router = Router();

/** The prefilled form link saved for this clarification (the
 * "None of these" door) — the same lookup the expired-link sweep
 * uses: latest clarification link for this sender. */
async function pageFormUrl(row: PendingClarification): Promise<string | null> {
  try {
    const { rows } = await query(
      `SELECT token FROM form_links
       WHERE company_id = $1 AND sender_email = $2 AND kind = 'clarification'
       ORDER BY created_at DESC LIMIT 1`,
      [row.company_id, row.sender_address]
    );
    return rows.length ? formLinkUrl(rows[0].token) : null;
  } catch {
    return null;
  }
}

function pickName(item: any, userId: string): string | null {
  const c = (item.candidates || []).find((x: any) => x.id === userId);
  return c ? c.name : null;
}

/**
 * All rows answered → claim the clarification (the DELETE is the
 * single-winner claim: a prose reply, a form submission, or this
 * completion racing it loses) and run the prose-reply replan with
 * the picks appended as exact resolutions.
 */
async function completeFromPicks(row: PendingClarification, answers: Record<string, string>) {
  const items: any[] = row.options?.items || [];
  const lines = items.map((item, i) => `"${item.fragment}" means ${pickName(item, answers[String(i)])}.`);
  const picksSummary = items
    .map((item, i) => `"${item.fragment}" means ${pickName(item, answers[String(i)])}`)
    .join('; ');
  const claimed = await claimClarification(query, row.id);
  if (!claimed) return { raced: true as const };
  const stitched =
    `${row.original_body}\n\n--- Sender's reply to the clarification question ---\n${lines.join('\n')}`;
  const outcome = await processScheduleEmail(
    query,
    row.company_id,
    {
      from: row.sender_address,
      subject: row.subject,
      body: stitched,
      cc: null,
      attachments: [],
    },
    `click-${row.id}`,
    { checked: 0, newPlans: 0, questionsAnswered: 0, errors: [] }
  );
  if (!outcome) {
    // The run failed before resolving anything — put the question
    // back (with the picks) so a retry or another door still works.
    try { await restoreClarification(query, { ...claimed, answers }); } catch { /* best-effort */ }
    return { failed: true as const };
  }
  if (outcome.kind === 'plan_created') {
    // Learning, tagged distinctly from the prose and form doors:
    // original unclear words -> the resolved plan, same shape as
    // the clarification-reply save.
    try {
      const { rows: plans } = await query(
        `SELECT plan FROM schedule_plans WHERE source_email_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [`click-${row.id}`]
      );
      if (plans.length) {
        const plan = plans[0].plan || {};
        const { saveLearningExample } = await import('../util/emailLearning.js');
        const resolvedText = `${plan.summary || ''} Changes: ${(plan.changes || []).map((c: any) =>
          [c.action, c.person || c.fromPerson || '', c.shiftType || c.sessionTitle || c.title || '', c.date || c.fromDate || ''].filter(Boolean).join(' ')
        ).join('; ')}`;
        await saveLearningExample(query, row.company_id, row.original_body || row.subject, resolvedText, 'clarification-click');
      }
    } catch { /* best-effort */ }
  }
  return { outcomeKind: outcome.kind as string, picksSummary };
}

async function handlePick(
  res: any, row: PendingClarification, token: string,
  itemRaw: unknown, pickRaw: unknown
): Promise<void> {
  const items: any[] = row.options?.items || [];
  const idx = Number(itemRaw);
  const pick = String(pickRaw || '');
  const answers: Record<string, string> = { ...(row.answers || {}) };
  const formUrl = await pageFormUrl(row);
  const renderPage = (notice?: string) => res.type('html').send(answerPageHtml({
    token, missing: row.missing, items, answers, formUrl, notice: notice || null,
  }));
  const item = Number.isInteger(idx) && idx >= 0 && idx < items.length ? items[idx] : null;
  if (!item) return renderPage();
  if (pick === 'no') {
    // "No" never resolves an item (Deepika's rule): the row stays
    // open and the escape doors below are the path.
    return renderPage('No problem — the row stays open. If none of these are right, use the "None of these" button below, or just reply to the clarification email in your own words.');
  }
  if (!pickName(item, pick)) return renderPage();
  // Idempotent per item: an already-recorded pick stands (a stale
  // email link can't silently change an answer).
  if (!answers[String(idx)]) answers[String(idx)] = pick;
  const allAnswered = items.every((_, i) => !!answers[String(i)]);
  if (!allAnswered) {
    await recordClarificationAnswers(query, row.id, answers);
    return renderPage();
  }
  const done = await completeFromPicks(row, answers);
  if ((done as any).raced) return res.type('html').send(alreadyAnsweredPageHtml());
  if ((done as any).failed) return res.status(500).type('html').send(clarifyErrorPageHtml());
  return res.type('html').send(confirmationPageHtml((done as any).picksSummary, (done as any).outcomeKind));
}

router.get('/clarify/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const row = await loadClarificationByToken(query, token);
    if (!row || clarificationExpired(row) || !row.options?.items?.length) {
      return res.type('html').send(alreadyAnsweredPageHtml());
    }
    if (req.query.item !== undefined && req.query.pick !== undefined) {
      return await handlePick(res, row, token, req.query.item, req.query.pick);
    }
    const formUrl = await pageFormUrl(row);
    return res.type('html').send(answerPageHtml({
      token, missing: row.missing, items: row.options.items,
      answers: row.answers || {}, formUrl,
    }));
  } catch (err: any) {
    console.error('[clarify] GET failed:', err?.message);
    return res.status(500).type('html').send(clarifyErrorPageHtml());
  }
});

// urlencoded is attached per-route (the requests/act pattern) —
// there is no global form parser.
router.post('/clarify/:token', urlencoded({ extended: false }), async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const row = await loadClarificationByToken(query, token);
    if (!row || clarificationExpired(row) || !row.options?.items?.length) {
      return res.type('html').send(alreadyAnsweredPageHtml());
    }
    return await handlePick(res, row, token, (req.body || {}).item, (req.body || {}).pick);
  } catch (err: any) {
    console.error('[clarify] POST failed:', err?.message);
    return res.status(500).type('html').send(clarifyErrorPageHtml());
  }
});

export default router;
