// util/emailLearning.ts — the email scheduler's example book
// (Deepika, 2026-11-01: "make our AI learn with this").
//
// When an email could not be understood and the sender later resolves
// it — through the request form or a plain-words reply — into a real
// plan, the pair (their original words -> the clean request) is saved
// for THAT company only. Before the planner reads a new email, the
// few most similar pairs are placed in its prompt as examples, so the
// same kind of wording is understood the first time. Only resolutions
// that ended in a created plan are saved — never guesses.

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;

const MAX_PER_COMPANY = 200;
const STOP = new Set(['the', 'a', 'an', 'on', 'in', 'to', 'for', 'of', 'and', 'or', 'my', 'me', 'i', 'please', 'can', 'could', 'you', 'we', 'is', 'it', 'this', 'that', 'with', 'from', 'be', 'am', 'pm']);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    if (w.length > 2 && !STOP.has(w)) out.add(w);
  }
  return out;
}

export async function saveLearningExample(
  query: QueryFn, companyId: string, originalText: string, resolvedText: string, source: string
): Promise<void> {
  const original = String(originalText || '').trim().slice(0, 1500);
  const resolved = String(resolvedText || '').trim().slice(0, 800);
  if (!original || !resolved) return;
  // Do not store near-duplicates of the same lesson.
  const { rows: dup } = await query(
    'SELECT 1 FROM email_learning_examples WHERE company_id = $1 AND original_text = $2 LIMIT 1',
    [companyId, original]
  );
  if (dup.length) return;
  await query(
    'INSERT INTO email_learning_examples (company_id, original_text, resolved_text, source) VALUES ($1, $2, $3, $4)',
    [companyId, original, resolved, source || 'clarification']
  );
  // Keep the book bounded: drop the oldest beyond the cap.
  await query(
    `DELETE FROM email_learning_examples WHERE company_id = $1 AND id NOT IN (
       SELECT id FROM email_learning_examples WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2)`,
    [companyId, MAX_PER_COMPANY]
  );
}

/** Up to `limit` example lines for the planner prompt, most similar to
 * the incoming text first (ties and no-match fall back to newest). */
export async function getRelevantExamples(
  query: QueryFn, companyId: string, incomingText: string, limit = 4
): Promise<string[]> {
  try {
    const { rows } = await query(
      'SELECT original_text, resolved_text FROM email_learning_examples WHERE company_id = $1 ORDER BY created_at DESC LIMIT 60',
      [companyId]
    );
    if (!rows.length) return [];
    const target = words(incomingText);
    const scored = rows.map((r: any) => {
      const w = words(r.original_text);
      let score = 0;
      for (const x of w) if (target.has(x)) score++;
      return { r, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ r }: any) =>
      `When a team member wrote: "${String(r.original_text).replace(/\s+/g, ' ').slice(0, 400)}" — they meant: ${String(r.resolved_text).replace(/\s+/g, ' ').slice(0, 300)}`
    );
  } catch {
    return [];
  }
}
