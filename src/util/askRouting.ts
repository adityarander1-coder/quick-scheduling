// util/askRouting.ts — pure routing + clarification helpers for the unified
// Ask/Task bar (no DB imports, so they are unit-testable on their own).
//
// The bar takes questions AND tasks with no mode switch, so routing must be
// decided from state + wording, never from one turn alone:
//  - A message sent while a clarification round is open is a follow-up to
//    that task, not a new question (the Binod failure: the follow-up was
//    answered as trivia because routing ignored history).
//  - Plain sentences that state a staffing change ("Lin is sick tomorrow
//    and binod is covering") are tasks even though they start with no
//    imperative verb.
//  - Employees never get plans: task-like messages get the Requests pointer
//    BEFORE the question engine runs, so a confident AI answer can't leak
//    past the guard. Pure questions still get answers.

import { matchName } from './planHelpers.js';

export type AskRoute = 'question' | 'plan' | 'employee-pointer';

// Task verbs: ONE list, shared by every task matcher below, so the
// imperative form ("Move Nancy…") and the request form ("Can we move
// Nancy…?") can never drift into recognising different tasks.
const TASK_VERBS =
  'put|add|assign|move|remove|delete|schedule|create|publish|unpublish|swap|cancel|set|change|update|give|make|book';

// Leading imperatives: "put Nancy on nights" must never be misread as a
// question about Nancy.
const IMPERATIVE = new RegExp(
  `^[\\s"'“”‘’\\(\\[]*(please\\s+)?(${TASK_VERBS})\\b`,
  'i',
);

// Question forms: starts with a question word, or ends with "?" (except
// requests phrased as "can we / can I ...").
const QUESTION_WORD =
  /^\s*(who|what|when|where|which|whose|how|is|are|do|does|did|tell me|show me)\b/i;
const REQUEST_OPENING = /^\s*(can we|can i|please)\b/i;

// Request-phrased tasks (Finding F1): "Can we move Nancy…?", "Could you
// put…?", "Will you swap…?" are tasks even though no imperative leads.
// isQuestionForm already exempts "can we / can I" openings from question
// form, but nothing positively matched the task. The opener alone is NOT
// enough — "Can I see my schedule?" is a genuine question — so a task verb
// from the shared list must follow the opener directly (an optional
// "please" may sit between), the same leading position IMPERATIVE
// requires. A verb buried later in the sentence does not count: in "Can I
// see my schedule?" the verb-list word "schedule" is a noun, and matching
// it would misroute a real question to the planner.
const REQUEST_TASK = new RegExp(
  `^\\s*(can we|can i|could we|could you|would you|will you|please)\\s+(please\\s+)?(${TASK_VERBS})\\b`,
  'i',
);

// Staffing-change words in a declarative sentence: "Lin is sick tomorrow
// and binod is covering", "Sam called out, who covers?" is NOT this — it
// starts with a question word, so isQuestionForm wins first.
const DECLARATIVE_TASK =
  /\b(covering|cover for|called out|called off|out sick|sick|swap|substitut|taking over)\b/i;

export function isQuestionForm(message: string): boolean {
  const m = message.trim();
  if (QUESTION_WORD.test(m)) return true;
  if (/\?\s*$/.test(m) && !REQUEST_OPENING.test(m)) return true;
  return false;
}

export function isTaskLike(message: string): boolean {
  const m = message.trim();
  if (IMPERATIVE.test(m)) return true;
  if (REQUEST_TASK.test(m)) return true;
  if (!isQuestionForm(m) && DECLARATIVE_TASK.test(m)) return true;
  return false;
}

// Route one Ask/Task message. history is the open clarification thread
// (empty when no round is open).
export function routeAskTask(
  message: string,
  history: Array<{ q: string; a: string }>,
  role: string,
): AskRoute {
  const inThread = history.length > 0;
  const taskLike = isTaskLike(message);
  if (role === 'employee') {
    // Employees: task-like messages get the Requests pointer before the
    // question engine runs. Pure questions still go to the question engine.
    if (taskLike) return 'employee-pointer';
    return 'question';
  }
  // Owner/scheduler: a follow-up inside an open clarification round goes
  // straight to the planner — unless it is unambiguously a new question
  // ("who is on triage today?"), which still gets an answer.
  if (inThread && !isQuestionForm(message)) return 'plan';
  if (taskLike) return 'plan';
  return 'question';
}

// One name problem: the text to ask about + the tappable options for it
// (empty when the reply must be free text).
export interface NameProblem {
  text: string;
  options: string[];
}

// Match every person/shift name in a plan against the real roster. Exact and
// unique first-name matches are fixed silently in place (the preview still
// shows the resolved name before approval). Every other name becomes one
// problem; the caller decides whether to ask them one at a time or all at
// once. Returns all problems, never just the first.
export function collectNameProblems(
  plan: any,
  memberNames: string[],
  shiftNames: string[],
): NameProblem[] {
  const problems: NameProblem[] = [];
  const personFields: Array<[any, string]> = [];
  const shiftFields: Array<[any, string]> = [];
  for (const c of plan.changes || []) {
    if (['assign', 'assign_recurring', 'unassign', 'update_team_member'].includes(c.action) && c.person) personFields.push([c, 'person']);
    if (['move', 'swap'].includes(c.action)) {
      if (c.fromPerson) personFields.push([c, 'fromPerson']);
      if (c.toPerson) personFields.push([c, 'toPerson']);
    }
    if (['assign', 'assign_recurring', 'set_staffing_target'].includes(c.action) && c.shiftType) shiftFields.push([c, 'shiftType']);
  }
  for (const [c, f] of personFields) {
    const m = matchName(c[f], memberNames);
    if (m.status === 'exact') { c[f] = m.name; continue; }
    if (m.status === 'suggestions') {
      problems.push({ text: `Which team member do you mean by "${c[f]}"?`, options: m.names });
    } else {
      problems.push({ text: `I don't see a team member named "${c[f]}". Check the spelling, or pick one:`, options: memberNames.slice(0, 10) });
    }
  }
  for (const [c, f] of shiftFields) {
    const m = matchName(c[f], shiftNames);
    if (m.status === 'exact') { c[f] = m.name; continue; }
    if (m.status === 'suggestions') {
      problems.push({ text: `Which shift type do you mean by "${c[f]}"?`, options: m.names });
    } else {
      problems.push({ text: `I don't see a shift type named "${c[f]}". Pick one:`, options: shiftNames.slice(0, 10) });
    }
  }
  return problems;
}

// Decide the clarification to show from the full problem list. One problem
// keeps today's targeted question + tappable options. Several problems
// become ONE question listing everything needed, with no options — the user
// replies once with all of it, instead of a question per detail.
export function decideClarification(
  problems: NameProblem[],
): { question: string; options: string[] } {
  if (problems.length === 1) {
    return { question: problems[0].text, options: problems[0].options };
  }
  const bullets = problems.map((p) => `• ${p.text}`).join('\n');
  return {
    question: `I need a few details before I can build this plan:\n${bullets}\nReply with all of them.`,
    options: [],
  };
}
