// util/clarifyOptions.ts — clickable clarification options
// (Deepika, 2026-11-10): when a clarification question is a name
// ambiguity, the candidate set the question already names becomes
// tappable — one button per candidate, the click IS the name — in
// the email (one-tap token links, the Approve/Reject pattern) and
// on the answer page the links land on (real POST buttons, the
// requests/act pattern). The mandatory escape line rides with every
// options block: when none of the options are right, the sender
// replies in their own words or finishes with the form, exactly as
// before this feature existed.

import { escHtml } from './mailer.js';
import type { NameAmbiguityItem } from './planGate.js';

export const NONE_OF_THESE_TEXT =
  'None of these right? Just reply to this email in your own words with the correct name — or finish it with the form.';

export function clarifyUrl(token: string): string {
  const base = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
  return `${base}/api/schedule/clarify/${token}`;
}

export function clarifyPickUrl(token: string, itemIndex: number, userId: string): string {
  return `${clarifyUrl(token)}?item=${itemIndex}&pick=${encodeURIComponent(userId)}`;
}

/** The question line for one item: multi-candidate asks who the
 * fragment means; a single candidate renders Deepika's Yes/No
 * shape ("dah" = Bon Dah?). */
export function itemQuestion(item: NameAmbiguityItem): string {
  if (item.candidates.length === 1) {
    return `"${item.fragment}" = ${item.candidates[0].name}?`;
  }
  return `Who did you mean by "${item.fragment}"?`;
}

/** The options block spliced into the clarification email, under
 * the question: one row per ambiguous item, then the escape line. */
export function buildOptionsEmailBlock(
  items: NameAmbiguityItem[], token: string, formUrl: string | null
): { text: string; html: string } {
  const textRows: string[] = [];
  const htmlRows: string[] = [];
  items.forEach((item, i) => {
    textRows.push(itemQuestion(item));
    htmlRows.push(`<p style="margin:14px 0 6px"><strong>${escHtml(itemQuestion(item))}</strong></p>`);
    if (item.candidates.length === 1) {
      const c = item.candidates[0];
      textRows.push(`- Yes: ${clarifyPickUrl(token, i, c.id)}`);
      textRows.push(`- No: ${clarifyUrl(token)}`);
      htmlRows.push(
        `<p style="margin:4px 0">` +
        `<a href="${clarifyPickUrl(token, i, c.id)}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;margin-right:8px;">Yes</a>` +
        `<a href="${clarifyUrl(token)}" style="background:#fff;color:#0e7c86;padding:9px 19px;text-decoration:none;border-radius:5px;display:inline-block;border:1px solid #0e7c86;">No</a></p>`
      );
    } else {
      for (const c of item.candidates) {
        textRows.push(`- ${c.name}: ${clarifyPickUrl(token, i, c.id)}`);
        htmlRows.push(
          `<p style="margin:4px 0"><a href="${clarifyPickUrl(token, i, c.id)}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;">${escHtml(c.name)}</a></p>`
        );
      }
    }
    textRows.push('');
  });
  const text =
    `Quickest — tap your answer:\n\n${textRows.join('\n')}` +
    `${NONE_OF_THESE_TEXT}${formUrl ? `\n${formUrl}` : ''}`;
  const html =
    `<p><strong>Quickest — tap your answer:</strong></p>${htmlRows.join('')}` +
    `<p style="color:#5b6b76;font-size:13px">${escHtml(NONE_OF_THESE_TEXT)}${formUrl ? ` <a href="${formUrl}">Open the form</a>` : ''}</p>`;
  return { text, html };
}

function pageShell(title: string, inner: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick Scheduling — ${escHtml(title)}</title>
<body style="font-family:system-ui,sans-serif;background:#f4f7f8;margin:0;padding:40px 18px;color:#17242e">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:26px;box-shadow:0 2px 14px rgba(20,50,60,.08)">
${inner}
</div></body>`;
}

const BTN = 'background:#0e7c86;color:white;padding:10px 20px;border:none;border-radius:5px;font-size:15px;cursor:pointer;display:inline-block;';
const BTN_GHOST = 'background:#fff;color:#0e7c86;padding:9px 19px;border:1px solid #0e7c86;border-radius:5px;font-size:15px;cursor:pointer;display:inline-block;text-decoration:none;';

/**
 * The answer page: every row of the pending clarification with real
 * POST buttons. Answered rows show their pick; the escape block
 * (mandatory text + a "None of these" button into the prefilled
 * form) closes the page.
 */
export function answerPageHtml(args: {
  token: string;
  missing: string;
  items: NameAmbiguityItem[];
  answers: Record<string, string>;
  formUrl: string | null;
  notice?: string | null;
}): string {
  const { token, missing, items, answers, formUrl, notice } = args;
  const action = clarifyUrl(token);
  const rows: string[] = [];
  items.forEach((item, i) => {
    const picked = answers[String(i)];
    const pickedName = picked ? (item.candidates.find((c) => c.id === picked)?.name || null) : null;
    rows.push(`<p style="margin:16px 0 6px"><strong>${escHtml(itemQuestion(item))}</strong></p>`);
    if (pickedName) {
      rows.push(`<p style="margin:4px 0;color:#166534">✓ ${escHtml(pickedName)}</p>`);
      return;
    }
    if (item.candidates.length === 1) {
      const c = item.candidates[0];
      rows.push(
        `<form method="post" action="${action}" style="display:inline-block;margin:4px 8px 4px 0">` +
        `<input type="hidden" name="item" value="${i}"><input type="hidden" name="pick" value="${escHtml(c.id)}">` +
        `<button type="submit" style="${BTN}">Yes</button></form>` +
        `<form method="post" action="${action}" style="display:inline-block;margin:4px 0">` +
        `<input type="hidden" name="item" value="${i}"><input type="hidden" name="pick" value="no">` +
        `<button type="submit" style="${BTN_GHOST}">No</button></form>`
      );
    } else {
      for (const c of item.candidates) {
        rows.push(
          `<form method="post" action="${action}" style="display:inline-block;margin:4px 8px 4px 0">` +
          `<input type="hidden" name="item" value="${i}"><input type="hidden" name="pick" value="${escHtml(c.id)}">` +
          `<button type="submit" style="${BTN}">${escHtml(c.name)}</button></form>`
        );
      }
    }
  });
  const inner =
    `<h2 style="margin:0 0 8px">One quick question</h2>` +
    `<p style="color:#5b6b76;line-height:1.5">About your schedule request — ${escHtml(missing)}</p>` +
    (notice ? `<p style="background:#fdf6e3;border:1px solid #ead9a0;border-radius:8px;padding:10px 12px;line-height:1.5">${escHtml(notice)}</p>` : '') +
    rows.join('') +
    `<hr style="border:none;border-top:1px solid #e5ebee;margin:20px 0">` +
    `<p style="color:#5b6b76;font-size:13px;line-height:1.5">${escHtml(NONE_OF_THESE_TEXT)}</p>` +
    (formUrl
      ? `<p><a href="${formUrl}" style="${BTN_GHOST}">None of these — finish it with the form</a></p>`
      : `<p style="color:#5b6b76;font-size:13px">Or open the ✉️ Email Q-Scheduler form inside the app.</p>`);
  return pageShell('Answer a question', inner);
}

/** Friendly dead-end for a resolved / expired / replaced question:
 * the click changes nothing. */
export function alreadyAnsweredPageHtml(): string {
  return pageShell('Already answered',
    `<h2 style="margin:0 0 8px">This question was already answered</h2>` +
    `<p style="color:#5b6b76;line-height:1.5">Thanks — this clarification has already been resolved (by a tap, a reply, or the form), so there's nothing left to answer here. Your change is being handled; watch your email for the approval step.</p>`);
}

/** Confirmation after the final pick triggered the replan. The
 * wording follows what the engine actually did — never a false
 * "done". */
export function confirmationPageHtml(picksSummary: string, outcomeKind: string | undefined): string {
  let next: string;
  if (outcomeKind === 'plan_created') {
    next = 'Your change is built and waiting for approval — the approver has been emailed.';
  } else if (outcomeKind === 'clarification_sent') {
    next = 'Thanks — we\'re preparing the change. If we need anything else, we\'ll email you.';
  } else {
    next = 'Your answers are in — we\'ll email you with the next step.';
  }
  return pageShell('Got it',
    `<h2 style="margin:0 0 8px">Got it — ${escHtml(picksSummary)}</h2>` +
    `<p style="color:#5b6b76;line-height:1.5">${escHtml(next)}</p>`);
}

/** The completion run failed before resolving anything; the row was
 * restored, so a retry (or the other doors) still works. */
export function clarifyErrorPageHtml(): string {
  return pageShell('Something went wrong',
    `<h2 style="margin:0 0 8px">Something went wrong</h2>` +
    `<p style="color:#5b6b76;line-height:1.5">Your answers could not be applied just now. Please try tapping again in a moment — or just reply to the clarification email in your own words, or finish it with the form.</p>`);
}
