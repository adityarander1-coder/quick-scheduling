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
  findShiftOption,
  shiftOptionLabel,
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

/** The recorded pick's display label: a name for a name row, the
 * "holder — type" label for a shift row (namespaced pick values
 * can never collide with user ids). Null when the pick does not
 * belong to this item — an invalid pick never resolves a row. */
function pickName(item: any, pick: string): string | null {
  if (!pick) return null;
  if (item.kind === 'shift') {
    const o = findShiftOption(item, pick);
    return o ? shiftOptionLabel(o) : null;
  }
  const c = (item.candidates || []).find((x: any) => x.id === pick);
  return c ? c.name : null;
}

/** The resolution line a pick appends to the original request for
 * the replan: a name row states what the fragment means; a shift
 * row states whose shift is being given up, so the planner builds
 * the move from the right holder. */
function resolutionLine(item: any, pick: string): string | null {
  if (item.kind === 'shift') {
    const o = findShiftOption(item, pick);
    return o ? `${o.shiftTypeName} on ${o.date} is ${o.holderName}'s shift.` : null;
  }
  const name = pickName(item, pick);
  return name ? `"${item.fragment}" means ${name}.` : null;
}

/** Learning for a click-door completion, tagged distinctly from
 * the prose and form doors: original unclear words -> the resolved
 * plan, same shape as the clarification-reply save. `suffix` is an
 * optional verbatim fragment appended to the resolved text (e.g.
 * the name picked from the dropdown). */
async function saveClickLearning(row: PendingClarification, suffix?: string | null): Promise<void> {
  try {
    const { rows: plans } = await query(
      `SELECT plan FROM schedule_plans WHERE source_email_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [`click-${row.id}`]
    );
    if (!plans.length) return;
    const plan = plans[0].plan || {};
    const { saveLearningExample } = await import('../util/emailLearning.js');
    const resolvedText = `${plan.summary || ''} Changes: ${(plan.changes || []).map((c: any) =>
      [c.action, c.person || c.fromPerson || '', c.shiftType || c.sessionTitle || c.title || '', c.date || c.fromDate || ''].filter(Boolean).join(' ')
    ).join('; ')}${suffix || ''}`;
    await saveLearningExample(query, row.company_id, row.original_body || row.subject, resolvedText, 'clarification-click');
  } catch { /* best-effort */ }
}

/**
 * The shared completion tail: claim the clarification (the DELETE
 * is the single-winner claim — a prose reply, a form submission,
 * or this completion racing it loses), run the replan with the
 * stitched request, save the click learning when a plan is built.
 * A failed run puts the question back so a retry still works.
 */
async function finishCompletion(
  row: PendingClarification, answers: Record<string, string>,
  stitched: string, picksSummary: string, learnSuffix?: string | null
): Promise<{ raced: true } | { failed: true } | { outcomeKind: string; picksSummary: string }> {
  const claimed = await claimClarification(query, row.id);
  if (!claimed) return { raced: true as const };
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
    try { await restoreClarification(query, { ...claimed, answers }); } catch { /* best-effort */ }
    return { failed: true as const };
  }
  if (outcome.kind === 'plan_created') await saveClickLearning(row, learnSuffix);
  return { outcomeKind: outcome.kind as string, picksSummary };
}

/**
 * All rows answered → claim the clarification (the DELETE is the
 * single-winner claim: a prose reply, a form submission, or this
 * completion racing it loses) and run the prose-reply replan with
 * the picks appended as exact resolutions.
 */
async function completeFromPicks(row: PendingClarification, answers: Record<string, string>) {
  const items: any[] = row.options?.items || [];
  const lines = items.map((item, i) => resolutionLine(item, answers[String(i)]) || '');
  const picksSummary = items
    .map((item, i) => {
      if (item.kind === 'shift') {
        const o = findShiftOption(item, answers[String(i)]);
        return o ? `${o.shiftTypeName} on ${o.date} is ${o.holderName}'s shift` : '';
      }
      const name = pickName(item, answers[String(i)]);
      return name ? `"${item.fragment}" means ${name}` : '';
    })
    .filter(Boolean)
    .join('; ');
  const stitched =
    `${row.original_body}\n\n--- Sender's reply to the clarification question ---\n${lines.join('\n')}`;
  return finishCompletion(row, answers, stitched, picksSummary);
}

/** One row's summary line for the confirmation page, shared by
 * the tap and dropdown completions. */
function pickSummaryLine(item: any, pick: string): string {
  if (item.kind === 'shift') {
    const o = findShiftOption(item, pick);
    return o ? `${o.shiftTypeName} on ${o.date} is ${o.holderName}'s shift` : '';
  }
  const name = pickName(item, pick);
  return name ? `"${item.fragment}" means ${name}` : '';
}

/** True when a row's fragment is a short form of the picked
 * person (first name, last name, or a prefix of either) — the
 * fragment was written about this person even though they were
 * not among the row's listed candidates. */
function pickMatchesFragment(
  fragment: string, picked: { firstName: string; lastName: string; fullName: string }
): boolean {
  const f = String(fragment || '').trim().toLowerCase();
  if (!f || f.length < 2) return false;
  const first = String(picked.firstName || '').toLowerCase();
  const last = String(picked.lastName || '').toLowerCase();
  if (f === first || f === last) return true;
  if ((first && first.startsWith(f)) || (last && last.startsWith(f))) return true;
  return String(picked.fullName || '').toLowerCase().split(/\s+/).includes(f);
}

/**
 * The roster-dropdown door (Deepika, 2026-11-11 — supersedes the
 * free-text box the same evening): the sender picks a team member
 * from the searchable list instead of a button. The picked name
 * answers the rows it addresses — a name row it is a candidate
 * of, or whose fragment is a short form of the picked person —
 * overriding a tapped row it contradicts, and it answers a shift
 * row when the picked person is the holder of exactly one of its
 * options. Tapped rows it does not address keep their picks. The
 * whole stitch runs the REAL replan, exactly like a reply. The
 * pick is a roster id resolved server-side — no free-text name
 * can be submitted through this door.
 */
async function handleNamePick(
  res: any, row: PendingClarification, token: string, pickedRaw: unknown
): Promise<void> {
  const pickedUserId = String(pickedRaw || '').trim();
  const items: any[] = row.options?.items || [];
  const answers: Record<string, string> = { ...(row.answers || {}) };
  const formUrl = await pageFormUrl(row);
  const renderPage = (notice?: string) => res.type('html').send(answerPageHtml({
    token, missing: row.missing, items, answers, formUrl, notice: notice || null,
  }));
  if (!pickedUserId) return renderPage();
  const { rows: urows } = await query(
    `SELECT id, first_name, last_name,
            TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
     FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [pickedUserId, row.company_id]
  );
  const picked = urows[0];
  if (!picked) return renderPage('That person is not on the team — pick a name from the list.');
  const pickedName: string = picked.name;
  const pickedUser = { id: picked.id, firstName: picked.first_name || '', lastName: picked.last_name || '', fullName: pickedName };
  const lines: string[] = [];
  const summaries: string[] = [];
  let addressedAny = false;
  items.forEach((item, i) => {
    const tap = answers[String(i)];
    if (item.kind === 'shift') {
      const mine = (item.options || []).filter((o: any) => o.holderId === pickedUserId);
      if (mine.length === 1) {
        addressedAny = true;
        const o = mine[0];
        lines.push(`${o.shiftTypeName} on ${o.date} is ${o.holderName}'s shift.`);
        summaries.push(`${o.shiftTypeName} on ${o.date} is ${o.holderName}'s shift`);
      } else if (tap) {
        const line = resolutionLine(item, tap);
        if (line) { lines.push(line); summaries.push(pickSummaryLine(item, tap)); }
      }
      return;
    }
    const addressed = (item.candidates || []).some((c: any) => c.id === pickedUserId) ||
      pickMatchesFragment(item.fragment, pickedUser);
    if (addressed) {
      addressedAny = true;
      lines.push(`"${item.fragment}" means ${pickedName}.`);
      summaries.push(`"${item.fragment}" means ${pickedName}`);
    } else if (tap) {
      const line = resolutionLine(item, tap);
      if (line) { lines.push(line); summaries.push(pickSummaryLine(item, tap)); }
    }
  });
  // The pick addressed no row: it is still the sender's answer to
  // the question as a whole, so it rides as one line for the
  // planner to interpret against the original request.
  if (!addressedAny) {
    lines.push(`The correct person is ${pickedName}.`);
    summaries.push(`Picked ${pickedName}`);
  } else {
    summaries.push(`Picked ${pickedName}`);
  }
  const stitched =
    `${row.original_body}\n\n--- Sender's reply to the clarification question ---\n${lines.join('\n')}`;
  const picksSummary = summaries.filter(Boolean).join('; ');
  const done = await finishCompletion(row, answers, stitched, picksSummary, ` Picked: ${pickedName}`);
  if ((done as any).raced) return res.type('html').send(alreadyAnsweredPageHtml());
  if ((done as any).failed) return res.status(500).type('html').send(clarifyErrorPageHtml());
  return res.type('html').send(confirmationPageHtml((done as any).picksSummary, (done as any).outcomeKind));
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
  // No Yes/No shape exists anymore (Deepika, 2026-11-11): a
  // single candidate is a single full-name button, and the 'no'
  // path is the none-of-these escape. A stale 'no' pick from an
  // old page falls through to the validity check below and renders
  // the page unchanged.
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

/**
 * GET /api/schedule/clarify/:token/search — the roster dropdown's
 * backing (Deepika, 2026-11-11): token-scoped, so the login-free
 * answer page can offer names without embedding the whole roster.
 * Scope (Deepika, 2026-11-11, 7:58 PM): ALL active employees of
 * THIS company — never other companies — ordered with the people
 * of the clarification's department first when that department is
 * known, then the rest of the company; plain company order when
 * no department is known. The clarification's department is the
 * department of the shift the question is about, else the
 * sender's department, else the one department the named
 * candidates share. Matches by first/last/nickname/full name,
 * min 2 chars, up to 8 results, id + name only. The gate still
 * conflict-checks any pick on replan, so a cross-department pick
 * that can't take the shift gets re-asked rather than applied.
 * A bad or expired token gets nothing.
 */
router.get('/clarify/:token/search', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const row = await loadClarificationByToken(query, token);
    if (!row || clarificationExpired(row) || !row.options?.items?.length) {
      return res.status(404).json({ results: [] });
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ results: [] });
    const items: any[] = row.options?.items || [];
    // The clarification's department, most specific first.
    let deptId: string | null = null;
    try {
      const shiftTypeIds = [...new Set(
        items.filter((it) => it.kind === 'shift')
          .flatMap((it) => (it.options || []).map((o: any) => o.shiftTypeId))
          .filter(Boolean)
      )];
      if (shiftTypeIds.length) {
        const { rows: drows } = await query(
          `SELECT DISTINCT department_id FROM shift_types WHERE id = ANY($1) AND department_id IS NOT NULL`,
          [shiftTypeIds]
        );
        if (drows.length === 1) deptId = drows[0].department_id;
        if (!deptId) {
          const { rows: jrows } = await query(
            `SELECT DISTINCT department_id FROM shift_type_departments WHERE shift_type_id = ANY($1)`,
            [shiftTypeIds]
          );
          if (jrows.length === 1) deptId = jrows[0].department_id;
        }
      }
      if (!deptId) {
        const { rows: srows } = await query(
          `SELECT department_id FROM users WHERE company_id = $1 AND lower(email) = $2 AND is_active = true LIMIT 1`,
          [row.company_id, String(row.sender_address || '').toLowerCase()]
        );
        if (srows[0]?.department_id) deptId = srows[0].department_id;
      }
      if (!deptId) {
        const candIds = [...new Set(
          items.filter((it) => it.kind !== 'shift')
            .flatMap((it) => (it.candidates || []).map((c: any) => c.id))
            .filter(Boolean)
        )];
        if (candIds.length) {
          const { rows: crows } = await query(
            `SELECT DISTINCT department_id FROM users WHERE id = ANY($1) AND department_id IS NOT NULL`,
            [candIds]
          );
          if (crows.length === 1) deptId = crows[0].department_id;
        }
      }
    } catch { /* anchor unreadable — plain company order below */ }
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const { rows } = await query(
      `SELECT id, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name
       FROM users
       WHERE company_id = $1 AND is_active = true
         AND (lower(first_name) LIKE $2 ESCAPE '\\'
           OR lower(last_name) LIKE $2 ESCAPE '\\'
           OR lower(nickname) LIKE $2 ESCAPE '\\'
           OR lower(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''))) LIKE $2 ESCAPE '\\')
       ORDER BY CASE WHEN department_id = $3 THEN 0 ELSE 1 END,
         lower(first_name), lower(last_name)
       LIMIT 8`,
      [row.company_id, like, deptId]
    );
    return res.json({ results: rows.map((r: any) => ({ id: r.id, name: r.name })) });
  } catch (err: any) {
    console.error('[clarify] search failed:', err?.message);
    return res.status(500).json({ results: [] });
  }
});

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
    // Roster-dropdown door: a picked roster id only — there is no
    // free-text submission path on this page (Deepika, 2026-11-11).
    const pickedUserId = String((req.body || {}).pickedUserId || '').trim();
    if (pickedUserId) {
      return await handleNamePick(res, row, token, pickedUserId);
    }
    return await handlePick(res, row, token, (req.body || {}).item, (req.body || {}).pick);
  } catch (err: any) {
    console.error('[clarify] POST failed:', err?.message);
    return res.status(500).type('html').send(clarifyErrorPageHtml());
  }
});

export default router;
