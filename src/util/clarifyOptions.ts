// util/clarifyOptions.ts — clickable clarification options
// (Deepika, 2026-11-10; one-email fix 2026-11-11): when a
// clarification question names its unknowns, every one of them
// becomes tappable — one button per candidate, the click IS the
// answer — in the email (one-tap token links, the Approve/Reject
// pattern) and on the answer page the links land on (real POST
// buttons, the requests/act pattern). Name rows show FULL names
// only, never the fragment; a single candidate is a single
// full-name button, same code as the multi-candidate rows — there
// is deliberately no Yes/No shape anywhere. Shift rows offer the
// candidate shifts (holder + type) the same way. The mandatory
// escape line rides with every options block: when none of the
// options are right, the sender replies in their own words or
// finishes with the form, exactly as before this feature existed.

import { escHtml } from './mailer.js';
import type { NameAmbiguityItem, ShiftChoiceItem, ShiftChoiceOption, ClarificationItem } from './planGate.js';

export const NONE_OF_THESE_TEXT =
  'None of these right? Open the link and pick the person from the list.';

export function clarifyUrl(token: string): string {
  const base = process.env.APP_URL || 'https://quick-scheduling.onrender.com';
  return `${base}/api/schedule/clarify/${token}`;
}

export function clarifyPickUrl(token: string, itemIndex: number, pick: string): string {
  return `${clarifyUrl(token)}?item=${itemIndex}&pick=${encodeURIComponent(pick)}`;
}

/** Namespaced pick value for a shift option, so it can never
 * collide with a user id in the stored answers map. */
export function shiftOptionKey(o: ShiftChoiceOption): string {
  return `shift:${o.holderId}:${o.shiftTypeId}:${o.date}`;
}

export function findShiftOption(item: ShiftChoiceItem, pick: string): ShiftChoiceOption | null {
  return (item.options || []).find((o) => shiftOptionKey(o) === pick) || null;
}

/** The button label for a shift option: holder + type, full names. */
export function shiftOptionLabel(o: ShiftChoiceOption): string {
  return `${o.holderName} — ${o.shiftTypeName}`;
}

/** The recorded pick's display label: a name for a name row, the
 * "holder — type" label for a shift row (namespaced pick values
 * can never collide with user ids). Null when the pick does not
 * belong to this item — an invalid pick never resolves a row. */
export function pickName(item: any, pick: string): string | null {
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
export function resolutionLine(item: any, pick: string): string | null {
  if (item.kind === 'shift') {
    const o = findShiftOption(item, pick);
    return o ? `${o.shiftTypeName} on ${o.date} is ${o.holderName}'s shift.` : null;
  }
  const name = pickName(item, pick);
  return name ? `"${item.fragment}" means ${name}.` : null;
}

/** One row's summary line for the confirmation page, shared by
 * the tap and dropdown completions. */
export function pickSummaryLine(item: any, pick: string): string {
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
export function pickMatchesFragment(
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

/** The question line for one item: a name row asks who the
 * fragment means; a shift row asks which shift is being given up. */
export function itemQuestion(item: ClarificationItem): string {
  if ((item as ShiftChoiceItem).kind === 'shift') return (item as ShiftChoiceItem).label;
  const nameItem = item as NameAmbiguityItem;
  return `Who did you mean by "${nameItem.fragment}"?`;
}

/**
 * The single email's question text, authored FROM the merged items
 * (Deepika, 2026-11-11 — one-email fix): the planner/gate free
 * text is dropped, so two sources can never contradict each other
 * in one mail. Candidate order follows the original question's
 * wording when it already lists them, else roster order — so a
 * question that already read well keeps reading the same way.
 */
export function buildDetailFromItems(items: ClarificationItem[], originalDetail: string): string {
  const lower = String(originalDetail || '').toLowerCase();
  const parts: string[] = [];
  for (const item of items) {
    if ((item as ShiftChoiceItem).kind === 'shift') {
      const shift = item as ShiftChoiceItem;
      parts.push(`Which shift is being given up on ${shift.date} — ${shift.options.map((o) => `${o.holderName}'s ${o.shiftTypeName}`).join(' or ')}?`);
    } else {
      const nameItem = item as NameAmbiguityItem;
      const names = [...nameItem.candidates];
      names.sort((a, b) => {
        const ia = lower.indexOf(a.name.toLowerCase());
        const ib = lower.indexOf(b.name.toLowerCase());
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
      parts.push(`You wrote "${nameItem.fragment}" — did you mean ${names.map((c) => c.name).join(' or ')}?`);
    }
  }
  return parts.join(' ');
}

/** The options block spliced into the clarification email, under
 * the question: one row per item (names and shifts alike), then
 * the escape line. */
export function buildOptionsEmailBlock(
  items: ClarificationItem[], token: string, formUrl: string | null
): { text: string; html: string } {
  const textRows: string[] = [];
  const htmlRows: string[] = [];
  items.forEach((item, i) => {
    textRows.push(itemQuestion(item));
    htmlRows.push(`<p style="margin:14px 0 6px"><strong>${escHtml(itemQuestion(item))}</strong></p>`);
    if ((item as ShiftChoiceItem).kind === 'shift') {
      const shift = item as ShiftChoiceItem;
      for (const o of shift.options) {
        const key = shiftOptionKey(o);
        const label = shiftOptionLabel(o);
        textRows.push(`- ${label}: ${clarifyPickUrl(token, i, key)}`);
        htmlRows.push(
          `<p style="margin:4px 0"><a href="${clarifyPickUrl(token, i, key)}" style="background:#0e7c86;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;display:inline-block;">${escHtml(label)}</a></p>`
        );
      }
    } else {
      const nameItem = item as NameAmbiguityItem;
      for (const c of nameItem.candidates) {
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
    `${NONE_OF_THESE_TEXT}\n${clarifyUrl(token)}${formUrl ? `\nOr finish it with the form: ${formUrl}` : ''}`;
  const html =
    `<p><strong>Quickest — tap your answer:</strong></p>${htmlRows.join('')}` +
    `<p style="color:#5b6b76;font-size:13px">${escHtml(NONE_OF_THESE_TEXT)} <a href="${clarifyUrl(token)}">Open the answer page</a>${formUrl ? ` — or <a href="${formUrl}">finish it with the form</a>` : ''}</p>`;
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
 * POST buttons. Answered rows show their pick; below the rows sits
 * the searchable roster dropdown ("None of these are right?") and
 * the "None of these" button into the prefilled form.
 */
export function answerPageHtml(args: {
  token: string;
  missing: string;
  items: ClarificationItem[];
  answers: Record<string, string>;
  formUrl: string | null;
  notice?: string | null;
}): string {
  const { token, missing, items, answers, formUrl, notice } = args;
  const action = clarifyUrl(token);
  const rows: string[] = [];
  items.forEach((item, i) => {
    const picked = answers[String(i)];
    // A recorded pick renders as the answered line: a name, or a
    // "holder — type" label for a shift pick.
    let pickedLabel: string | null = null;
    if (picked) {
      if ((item as ShiftChoiceItem).kind === 'shift') {
        const o = findShiftOption(item as ShiftChoiceItem, picked);
        pickedLabel = o ? shiftOptionLabel(o) : null;
      } else {
        pickedLabel = (item as NameAmbiguityItem).candidates.find((c) => c.id === picked)?.name || null;
      }
    }
    rows.push(`<p style="margin:16px 0 6px"><strong>${escHtml(itemQuestion(item))}</strong></p>`);
    if (pickedLabel) {
      rows.push(`<p style="margin:4px 0;color:#166534">✓ ${escHtml(pickedLabel)}</p>`);
      return;
    }
    const buttons: Array<{ pick: string; label: string }> =
      (item as ShiftChoiceItem).kind === 'shift'
        ? (item as ShiftChoiceItem).options.map((o) => ({ pick: shiftOptionKey(o), label: shiftOptionLabel(o) }))
        : (item as NameAmbiguityItem).candidates.map((c) => ({ pick: c.id, label: c.name }));
    for (const b of buttons) {
      rows.push(
        `<form method="post" action="${action}" style="display:inline-block;margin:4px 8px 4px 0">` +
        `<input type="hidden" name="item" value="${i}"><input type="hidden" name="pick" value="${escHtml(b.pick)}">` +
        `<button type="submit" style="${BTN}">${escHtml(b.label)}</button></form>`
      );
    }
  });
  const inner =
    `<h2 style="margin:0 0 8px">One quick question</h2>` +
    `<p style="color:#5b6b76;line-height:1.5">About your schedule request — ${escHtml(missing)}</p>` +
    (notice ? `<p style="background:#fdf6e3;border:1px solid #ead9a0;border-radius:8px;padding:10px 12px;line-height:1.5">${escHtml(notice)}</p>` : '') +
    rows.join('') +
    `<hr style="border:none;border-top:1px solid #e5ebee;margin:20px 0">` +
    // Searchable roster dropdown (Deepika, 2026-11-11 — supersedes
    // the free-text box the same evening): when none of the buttons
    // is the answer, type a few letters, pick the person from the
    // team list, then press Send. Matches come from the roster
    // behind the token-scoped search — the whole roster is never
    // embedded in the page. Send stays disabled until a name is
    // picked; a name that isn't on the roster can't be entered.
    `<p style="margin:0 0 6px"><strong>None of these are right?</strong></p>` +
    `<p style="margin:4px 0;color:#5b6b76;font-size:14px;line-height:1.5">Pick the person from the team list — type a few letters, choose a name, then press Send.</p>` +
    `<form method="post" action="${action}" style="margin:10px 0;position:relative">` +
    `<input type="text" id="qs-name-search" autocomplete="off" maxlength="100" placeholder="Type a name…" style="padding:10px 12px;border:1px solid #cbd5e1;border-radius:5px;font-size:15px;width:min(320px,65%);"> ` +
    `<input type="hidden" id="qs-picked-id" name="pickedUserId" value="">` +
    `<button type="submit" id="qs-name-send" disabled style="${BTN}opacity:.55;">Send</button>` +
    `<div id="qs-name-results" style="display:none;position:absolute;left:0;top:100%;width:min(320px,65%);background:#fff;border:1px solid #cbd5e1;border-radius:5px;box-shadow:0 4px 14px rgba(20,50,60,.12);z-index:5;max-height:220px;overflow:auto"></div>` +
    `<p id="qs-name-none" style="display:none;margin:8px 0 0;color:#5b6b76;font-size:13px">No one by that name on the team</p>` +
    `</form>` +
    `<script>(function(){var input=document.getElementById('qs-name-search');var hidden=document.getElementById('qs-picked-id');var send=document.getElementById('qs-name-send');var list=document.getElementById('qs-name-results');var none=document.getElementById('qs-name-none');var timer=null;function clearPick(){hidden.value='';send.disabled=true;send.style.opacity='.55';}function hide(){list.innerHTML='';list.style.display='none';none.style.display='none';}input.addEventListener('input',function(){clearPick();var q=input.value.trim();if(timer)clearTimeout(timer);if(q.length<2){hide();return;}timer=setTimeout(function(){fetch(${JSON.stringify(action + '/search')}+'?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(d){var rows=(d&&d.results)||[];list.innerHTML='';if(!rows.length){list.style.display='none';none.style.display='block';return;}none.style.display='none';rows.forEach(function(person){var b=document.createElement('button');b.type='button';b.textContent=person.name;b.style.cssText='display:block;width:100%;text-align:left;padding:10px 12px;background:#fff;border:none;border-bottom:1px solid #e5ebee;cursor:pointer;font-size:15px;';b.addEventListener('click',function(){input.value=person.name;hidden.value=person.id;send.disabled=false;send.style.opacity='1';hide();});list.appendChild(b);});list.style.display='block';}).catch(function(){hide();});},200);});})();</script>` +
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
