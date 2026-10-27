// util/gemini.ts — Google Gemini API client for schedule plan generation.

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

// Cache the working model name after first successful discovery
let cachedModel: string | null = null;

/** Discover an available model that supports generateContent */
async function discoverModel(apiKey: string): Promise<string> {
  if (cachedModel) return cachedModel;
  if (process.env.GEMINI_MODEL) {
    cachedModel = process.env.GEMINI_MODEL;
    return cachedModel;
  }
  // List available models and pick the best one supporting generateContent.
  // Prefer newer models (higher version numbers) as older ones get retired.
  const res = await fetch(`${GEMINI_API_BASE}/models?key=${apiKey}`);
  if (!res.ok) throw new Error(`Gemini list models failed: ${res.status}`);
  const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  const models = (data.models || []).filter(m =>
    m.supportedGenerationMethods?.includes('generateContent')
  );
  if (!models.length) throw new Error('No Gemini models support generateContent for this API key');
  // Sort by version number descending (e.g. 3.8 > 2.5 > 1.5), prefer flash models
  const versionOf = (name: string) => {
    const m = name.match(/gemini-(\d+)\.(\d+)/);
    return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0;
  };
  models.sort((a, b) => {
    const aFlash = a.name.toLowerCase().includes('flash') ? 1 : 0;
    const bFlash = b.name.toLowerCase().includes('flash') ? 1 : 0;
    if (aFlash !== bFlash) return bFlash - aFlash;
    return versionOf(b.name) - versionOf(a.name);
  });
  const picked = models[0];
  // name is like "models/gemini-2.5-flash" — strip the prefix
  cachedModel = picked.name.replace('models/', '');
  console.log(`[gemini] using model: ${cachedModel}`);
  return cachedModel;
}

interface PlanChange {
  action: 'assign' | 'unassign' | 'move' | 'swap' | 'add_job_role' | 'rename_job_role' | 'delete_job_role' |
          'add_department' | 'rename_department' |
          'add_team_member' | 'update_team_member' |
          'add_shift_type' | 'rename_shift_type' |
          'set_staffing_target' |
          'bulk_publish' | 'bulk_unpublish' |
          'add_session' | 'update_session' | 'cancel_session';
  person?: string;          // name for assign/unassign/update_team_member
  fromPerson?: string;       // for move/swap
  toPerson?: string;         // for move/swap
  date?: string;             // YYYY-MM-DD
  fromDate?: string;
  toDate?: string;
  shiftType?: string;       // shift type name
  jobRoleName?: string;     // for add_job_role, add_team_member, update_team_member
  newJobRoleName?: string;  // for rename_job_role
  department?: string;      // department name
  newDepartment?: string;   // for rename_department
  firstName?: string;       // for add_team_member
  lastName?: string;        // for add_team_member
  email?: string;           // for add_team_member
  newShiftType?: string;    // for rename_shift_type
  targetCount?: number;     // for set_staffing_target
  // Calendar session fields (add_session / update_session / cancel_session)
  dashboard?: string;       // dashboard name, e.g. "Calendars"
  title?: string;           // add_session: the title; update_session: the NEW title
  sessionTitle?: string;    // update/cancel: the session's current title
  sessionType?: string;     // session type label for that dashboard
  presenter?: string;       // presenter (lecturer) full name
  supervisor?: string;      // supervisor full name
  location?: string;        // room name or location text
  startTime?: string;       // HH:MM (24h)
  endTime?: string;         // HH:MM (24h)
  scope?: 'date' | 'series';// update/cancel of a recurring session
  newDate?: string;         // move the session to this date (YYYY-MM-DD)
  recurRule?: string;       // add_session: none|daily|weekly|monthly|yearly
  recurInterval?: number;   // add_session: every N (e.g. 2 = every 2 weeks)
  recurUntil?: string;      // add_session: repeat until YYYY-MM-DD
  notes?: string;
}

export interface SchedulePlan {
  changes: PlanChange[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  needsClarification?: string; // question to ask if ambiguous
  emailType: 'change_request' | 'schedule_question' | 'settings_change' | 'bulk_action' | 'other';
  question?: {
    kind: 'schedule_for_dates' | 'who_is_on' | 'person_schedule' | 'general';
    startDate?: string;  // YYYY-MM-DD
    endDate?: string;    // YYYY-MM-DD
    person?: string;     // person name if asking about someone
    shiftType?: string;  // shift type if specified
  };
}

/**
 * Ask Gemini to parse an email into a structured schedule change plan,
 * or classify it as a schedule question or unrelated.
 * Returns the plan, or a clarification request if the email is ambiguous.
 */
export async function planFromEmail(
  emailBody: string,
  emailSubject: string,
  context: {
    shiftTypes: string[]; members: string[]; today: string;
    shiftTypeRules?: string[];  // "Red Team: only PGY1, PGY2, PGY3" lines for restricted types
    dashboards?: string[];          // dashboard names, e.g. ["Calendars"]
    sessionKinds?: string[];        // "Calendars: Lecture, Event" lines
    rooms?: string[];               // room / location names
    sessions?: string[];            // upcoming calendar session lines
    dashboardDepartments?: string[];// "Calendars: Internal Medicine" lines
    history?: Array<{ q: string; a: string }>; // in-app Task thread: earlier user messages + agent questions
    attachmentText?: string;        // spreadsheet/doc attachments converted to text
    pdfAttachments?: { filename: string; base64: string }[]; // PDFs, sent to Gemini as documents
    attachmentNotes?: string[];     // attachments that could not be read (name + reason)
  }
): Promise<SchedulePlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured.');

  const prompt = `You are a scheduling assistant. Classify this email and parse it accordingly.

Today's date: ${context.today}

Available shift types: ${context.shiftTypes.join(', ') || '(none listed)'}
Job-role rules for shift types (only assign someone to a shift type when their job role is listed here; types not listed are open to everyone): ${(context.shiftTypeRules || []).join(' | ') || '(none — everyone may take every shift type)'}
Team members: ${context.members.join(', ') || '(none listed)'}
Dashboards (calendars): ${(context.dashboards || []).join(', ') || '(none)'}
Session types by dashboard: ${(context.sessionKinds || []).join(' | ') || '(none)'}
Dashboard departments: ${(context.dashboardDepartments || []).join(' | ') || '(none)'}
Rooms / locations: ${(context.rooms || []).join(', ') || '(none listed)'}
Calendar sessions:
${(context.sessions || []).join('\n') || '(none listed)'}

${(context.history || []).length ? `Earlier in this conversation:
${(context.history || []).map(h => `User: ${h.q}\nQ-Scheduler: ${h.a}`).join('\n')}

The messages above are context for the request below. The latest message refines the original request — carry forward every detail from earlier messages (names, patterns like "every 5th week", dates, weekends off) unless the user changed them. Do not ask again for details already given.

` : ''}Email subject: ${emailSubject}
Email body:
${emailBody}
${context.attachmentText ? `
Attached file contents (files the sender attached — spreadsheets/documents converted to text):
${context.attachmentText}
` : ''}${(context.pdfAttachments || []).length ? `
The sender also attached PDF file(s): ${(context.pdfAttachments || []).map(p => p.filename).join(', ')}. The PDF pages follow this prompt as documents — read them as part of the request.
` : ''}${(context.attachmentNotes || []).length ? `
Some attachments could not be read: ${(context.attachmentNotes || []).join('; ')}. If the request cannot be completed without them, say so in needsClarification.
` : ''}
First, classify the email into one of:
- "change_request": the sender wants to change the schedule (assign, unassign, move, swap shifts) or change the calendar (add, move, cancel a session, change a session's presenter/supervisor/room/time)
- "schedule_question": the sender is asking about the schedule (who is working when, what is the schedule for certain dates)
- "settings_change": the sender wants to manage settings (add a job role, add a department, add a team member)
- "bulk_action": the sender wants a bulk operation (publish/unpublish shifts for a date range)
- "other": not related to scheduling

Respond with JSON only, no other text:
{
  "emailType": "change_request|schedule_question|settings_change|bulk_action|other",
  "changes": [
    {
      "action": "assign|assign_recurring|unassign|move|swap|add_job_role|rename_job_role|add_department|rename_department|add_team_member|update_team_member|add_shift_type|rename_shift_type|set_staffing_target|bulk_publish|bulk_unpublish|add_session|update_session|cancel_session",
      "person": "Full Name (for assign/unassign/update_team_member)",
      "fromPerson": "Full Name (for move/swap)",
      "toPerson": "Full Name (for move/swap)",
      "date": "YYYY-MM-DD",
      "fromDate": "YYYY-MM-DD (for move/bulk)",
      "toDate": "YYYY-MM-DD (for move/bulk)",
      "shiftType": "Shift type name",
      "jobRoleName": "Job role name",
      "newJobRoleName": "New job role name (for rename_job_role)",
      "department": "Department name",
      "newDepartment": "New department name (for rename_department)",
      "firstName": "First name (for add_team_member)",
      "lastName": "Last name (for add_team_member)",
      "email": "Email (for add_team_member)",
      "newShiftType": "New shift type name (for rename_shift_type)",
      "targetCount": "Number (for set_staffing_target)",
      "dashboard": "Dashboard name (for session actions)",
      "title": "Session title (for add_session; the NEW title for update_session)",
      "sessionTitle": "The session's current title (for update_session/cancel_session)",
      "sessionType": "Session type label on that dashboard (for session actions)",
      "presenter": "Presenter full name (for session actions)",
      "supervisor": "Supervisor full name (for session actions)",
      "location": "Room or location (for session actions)",
      "startTime": "HH:MM 24h (for session actions)",
      "endTime": "HH:MM 24h (for session actions)",
      "scope": "date|series (for update_session/cancel_session on a repeating session)",
      "newDate": "YYYY-MM-DD (move a session to this date)",
      "recurRule": "none|daily|weekly|monthly|yearly (for add_session)",
      "recurInterval": "Number, every N (for add_session, e.g. 2 = every 2 weeks)",
      "recurUntil": "YYYY-MM-DD (for add_session, repeat until)",
      "startDate": "YYYY-MM-DD, first day of the pattern (for assign_recurring)",
      "intervalWeeks": "Number, every N weeks (for assign_recurring)",
      "weekendsOff": "true when weekends are off (for assign_recurring)",
      "untilDate": "YYYY-MM-DD, repeat until, inclusive (for assign_recurring)",
      "notes": "Notes (for session actions)"
    }
  ],
  "summary": "Plain-language summary of the proposed changes, or the question being asked",
  "confidence": "high|medium|low",
  "needsClarification": "Question to ask if anything is ambiguous, or null",
  "question": {
    "kind": "schedule_for_dates|who_is_on|person_schedule|general",
    "startDate": "YYYY-MM-DD or null",
    "endDate": "YYYY-MM-DD or null",
    "person": "Person name or null",
    "shiftType": "Shift type name or null"
  }
}

Rules:
- Respect the job-role rules above when choosing people: prefer someone whose role is listed for that shift type. If the request explicitly names someone whose role is NOT listed, still build the change exactly as asked (the approver will see a role-rule warning and may override) — never silently substitute a different person.
- For "change_request": fill in "changes". Every change MUST have all its required fields filled in with real values — never null or empty. Required: assign needs person + date + shiftType; assign_recurring needs person + shiftType + startDate + intervalWeeks + untilDate.
- Repeating shifts: when a request repeats on a pattern ("every 5 weeks", "every other week", "every Monday"), return ONE "assign_recurring" change — NEVER expand it into many "assign" changes and NEVER do calendar math by hand beyond the first date. Compute startDate from the request against today's date ("first Monday of November" with today in late October → the first Monday of the coming November). Set intervalWeeks from the pattern ("every 5 weeks" → 5, "every other week" → 2). Set weekendsOff true when the request says weekends are off. Set untilDate when an end is given ("for a year", "till November next year"); if no end is given, set "needsClarification" to ask until when, and "confidence" to "low". unassign needs person + date; move needs fromPerson + toPerson + date; swap needs fromPerson + toPerson + date. If you cannot determine any required field (e.g. the email doesn't name the person), do NOT emit an incomplete change — instead set "needsClarification" to a specific question (e.g. "Who should be unassigned on 2026-10-24?") and set "confidence" to "low". Resolve relative dates (Friday, tomorrow, next week) against today's date. Match person names fuzzily against the team member list. Match shift descriptions (night, day) against shift type names. If critical info is missing (who, when), set confidence to "low" and ask in needsClarification. Set "question" to null.
- Attachments: when the email has attached file contents or PDFs, they are part of the request. If an attachment is a schedule list or grid of shifts, create one "assign" change per person per shift per day — expand week-long blocks and date ranges into one change per day — following any instructions in the email body. If the email body is empty, the attachment alone is the request. Attached documents can also hold the details for any other request type (e.g. a list of team members to add).
- For "settings_change": fill in "changes" with settings actions. Supported actions:
  - "add_job_role": needs jobRoleName + department. Example: "Add PGY4 role to IM Residency" → jobRoleName "PGY4", department "IM Residency".
  - "rename_job_role": needs jobRoleName + newJobRoleName + department.
  - "delete_job_role": needs jobRoleName + department. Example: "Delete secretary from internal medicine" → jobRoleName "secretary", department "internal medicine".
  - "add_department": needs department. Example: "Add Cardiology department" → department "Cardiology".
  - "rename_department": needs department + newDepartment.
  - "add_team_member": needs firstName + lastName; department and jobRoleName optional. Example: "Add John Smith to IM Residency as PGY2" → firstName "John", lastName "Smith", department "IM Residency", jobRoleName "PGY2".
  - "update_team_member": needs person; department and/or jobRoleName to update.
  - "add_shift_type": needs shiftType + department. Example: "Add Cardiology shift to IM Residency" → shiftType "Cardiology", department "IM Residency".
  - "rename_shift_type": needs shiftType + newShiftType.
  - "set_staffing_target": needs shiftType + targetCount. Example: "Set staffing of 2 for Cardiology" → shiftType "Cardiology", targetCount 2.
  Match department/shift type names fuzzily. If critical info is missing, set needsClarification.
- For "bulk_action": fill in "changes" with bulk actions. Supported: "bulk_publish" needs fromDate + toDate (publishes all draft shifts in range); "bulk_unpublish" needs fromDate + toDate (moves to draft). Optional: shiftType to limit to a specific shift type. Resolve relative dates against today.
- Calendar sessions live on dashboards (see the dashboard / session lists above). Use these actions, classified as "change_request":
  - "add_session": needs dashboard + title + date. Optional: startTime/endTime (convert "8am" to "08:00", "12:30pm" to "12:30"), presenter, supervisor, location (a room name or any location text), sessionType (one of that dashboard's session types), department (pick from that dashboard's departments when the sender names one), notes. If it repeats, set recurRule ("weekly" for weekly, etc.), recurInterval for every-N (e.g. "every other week" = weekly + 2), recurUntil when an end date is given.
  - "update_session": needs dashboard + sessionTitle (the session's current title — match it against the calendar session list). Set ONLY the fields being changed: title (a rename), presenter, supervisor, location, startTime, endTime, sessionType, notes, newDate (to move it). For a repeating session: if the sender names one date and doesn't say "all/every", set date to that date and scope to "date" (just that date changes); use scope "series" to change every occurrence.
  - "cancel_session": needs dashboard + sessionTitle. For a repeating session with one date named, set date + scope "date" (cancels just that date); otherwise the whole session/series is cancelled.
  Match dashboard, session, room and people names fuzzily against the lists. If the dashboard is not named and there is only one dashboard, use it; if there are several and it is unclear, ask in needsClarification. If the session cannot be matched to the session list, ask in needsClarification.
- For "schedule_question": set "changes" to []. Fill in "question" with parsed details. Resolve relative dates against today's date. Examples: "who is working Oct 12" → kind "who_is_on", startDate=endDate="2026-10-12". "Schedule for Oct 11-13" → kind "schedule_for_dates" with startDate/endDate. "When is John working" → kind "person_schedule" with person name.
- For "other": set "changes" to [], "question" to null, summary to "Not schedule related.", confidence to "high".`;

  const model = await discoverModel(apiKey);

  // Attached PDFs ride along as document parts; a request built from a
  // whole schedule file can produce many changes, so give it more room.
  const parts: any[] = [{ text: prompt }];
  for (const pdf of context.pdfAttachments || []) {
    parts.push({ inlineData: { mimeType: 'application/pdf', data: pdf.base64 } });
  }
  const hasAttachments = !!context.attachmentText || (context.pdfAttachments || []).length > 0;

  // Retry on 503 (overloaded) with backoff, up to 3 attempts
  let res: Response | null = null;
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(
      `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: hasAttachments ? 8000 : 2000 },
        }),
      }
    );
    if (res.ok) break;
    if (res.status === 503 && attempt < 3) {
      console.log(`[gemini] 503 overloaded, retrying in ${attempt * 10}s (attempt ${attempt}/3)`);
      await new Promise(r => setTimeout(r, attempt * 10000));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const errBody = res ? await res.text().catch(() => '') : '';
    throw new Error(`Gemini API error: ${res?.status || 'no response'} - ${errBody.substring(0, 500)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  // Extract JSON from response (may have markdown code fences).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini did not return valid JSON.');
  const parsed = JSON.parse(jsonMatch[0]) as SchedulePlan;
  // Backwards compatibility: default emailType if missing
  if (!parsed.emailType) {
    parsed.emailType = (parsed.changes && parsed.changes.length > 0) ? 'change_request' : 'other';
  }
  return parsed;
}


/**
 * Suggest logical next tasks after a completed agent task.
 * Returns 1-3 short plain-language task suggestions (each directly sendable as a new task).
 */
/**
 * Rule-based fallback suggestions when the AI returns nothing.
 * Keyed off the completed action type.
 */
function fallbackSuggestions(action: string, task: string): string[] {
  const t = task.toLowerCase();
  if (action.includes('job_role')) {
    if (action.includes('delete')) return ['Add a replacement job role', 'Reassign affected team members'];
    return ['Assign this role to a team member', 'Allow this role on a shift type'];
  }
  if (action.includes('team_member')) {
    if (action.includes('delete')) return ['Reassign their shifts to someone else'];
    return ['Assign them to a shift', 'Set their job role'];
  }
  if (action.includes('department')) {
    return ['Add a job role to this department', 'Add a team member to this department'];
  }
  if (action.includes('shift_type')) {
    return ['Set the staffing target for this shift', 'Assign someone to this shift'];
  }
  if (action === 'assign') return ['Assign another person to this shift', 'Publish this shift'];
  if (action === 'unassign') return ['Find a replacement for this shift', 'Publish the updated day'];
  if (action.includes('publish')) return ['Check the schedule for gaps'];
  if (action.includes('staffing')) return ['Check if any days are short-staffed'];
  return ['Check the schedule for gaps', 'Publish the updated shifts'];
}

export async function suggestFollowUps(
  task: string,
  planSummary: string,
  action?: string
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallbackSuggestions(action || '', task);
  const prompt = `You are Q-Scheduler, a hospital employee scheduling assistant. The admin just completed this task via chat:

Task: "${task}"
What was done: "${planSummary}"

Suggest 1-3 logical NEXT tasks the admin would likely want to do now, as short plain-language commands (each under 12 words, written as a direct command like "Assign Priya to night shift Oct 20").
Rules:
- Only suggest tasks this scheduling app can do: assign/unassign/move/swap shifts, add/rename departments, job roles, team members, shift types, set staffing targets, publish/unpublish shifts.
- Make them specific follow-ups to what was just done (e.g. after adding a job role → assign it to people; after removing someone → fill the gap).
- If nothing logically follows, return an empty list.
- Return ONLY a JSON array of strings, no other text. Example: ["Assign the Night NP role to Priya", "Set staffing target for Night shift"]`;

  try {
    const model = await discoverModel(apiKey);
    let res: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      res = await fetch(
        `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 300 },
          }),
        }
      );
      if (res.ok) break;
      if (res.status === 503 && attempt < 3) {
        console.log(`[gemini] suggestFollowUps 503, retrying (attempt ${attempt}/3)`);
        await new Promise(r => setTimeout(r, attempt * 8000));
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      console.log(`[gemini] suggestFollowUps HTTP ${res?.status || 'no response'}`);
      return fallbackSuggestions(action || '', task);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[gemini] suggestFollowUps raw: ${text.slice(0, 300)}`);
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (!arrMatch) return fallbackSuggestions(action || '', task);
    try {
      const parsed = JSON.parse(arrMatch[0]);
      const list = Array.isArray(parsed) ? parsed.filter((s: any) => typeof s === 'string').slice(0, 3) : [];
      return list.length ? list : fallbackSuggestions(action || '', task);
    } catch {
      return fallbackSuggestions(action || '', task);
    }
  } catch (e) {
    console.log('[gemini] suggestFollowUps error:', (e as any)?.message);
    return fallbackSuggestions(action || '', task);
  }
}

const HELP_KNOWLEDGE = `
You are the in-app help assistant for "Quick Scheduling", a hospital employee scheduling app. Answer the user's question about how to use the app. Be concise, plain-spoken, and give numbered steps. Refer to exact tab and button names. If the question is not about using the app, say so briefly.

APP GUIDE:

EMPLOYEE (My schedule tab — they land here after login):
- Views: Day / Week / Month / Range tabs at the top; arrow buttons and Today to move between dates; Department and Shift dropdowns filter what shows.
- Pick up an open shift: find a dashed "+ Open slot" box on a day and tap "Pick up". The button only appears if you are eligible for that shift type.
- Swap a shift: tap one of your own shifts, tap "Swap", pick a teammate and date.
- Ask for cover: tap one of your own shifts, tap "Ask for cover". A scheduler must approve it.
- Ask Q-Scheduler: a floating button / Ask tab where you type plain-language questions like "when am I working next week" and get an instant answer.
- Shift requests tab: see your pending swap/cover requests and their status.

ADMIN / SCHEDULER (Schedule tab + Settings):
- The Schedule tab has an Admin view / My schedule toggle at the top. Admin view shows the full team schedule; department dropdown filters it.
- Assign a shift: tap the + button on a day, pick the person, shift type, and time. New shifts start as drafts; publish per shift or tap the status pill on the date header to publish the whole day.
- Draft vs published: draft shifts show a grey "(draft)" tag and are not visible to employees until published.
- Filters: Department and Shift dropdowns narrow the view; Day/Week/Month/Range switch the layout.
- Rotations: Settings → Rotations. Build repeating patterns (1–84 days) and apply them to people.
- Bulk Actions: assign or publish many shifts across a date range at once.
- Promote job roles: Settings → Team members → "Promote job roles". Pick department, from-role, to-role, and an effective date (e.g. July 1). Promotions apply automatically on that date so you can build the next schedule beforehand. Pending promotions are listed with a Cancel option.
- Staffing targets: Settings → Staffing. Set how many people each shift type needs per day; the schedule flags days that are short.
- Shift types: Settings → Shifts. Each has a name, color, and eligible job roles (empty = everyone can pick it up). Drag to reorder — the schedule shows them in that order.
- Job roles: Settings → Job roles. Departments define their own roles (Physician, NP, PGY1…); team members get a role on their profile.
- Payroll: hours report by date range with per-person totals, PDF download, email.
- Schedule audit log: who changed what and when.
- Email AI: forward schedule emails and the app drafts a plan; you Approve or Reject before anything runs. Notification recipients are configured per department in Settings.
`;

const HELP_VISUALS = `
Available screenshot guides (use the file names exactly):
- help-schedule-week.png — Admin schedule week view with tabs and filters
- help-ask.png — Ask Q-Scheduler (admin)
- help-emp-schedule-week.png — Employee week view
- help-emp-schedule-month.png — Employee month view
- help-emp-month-phone.png — Employee month view on phone
- help-emp-available.png — Available shifts list with Pick up buttons
- help-emp-requests.png — Shift requests tab (swap/cover status)
- help-emp-fab.png — Floating Email AI button
- help-emp-email-dialog.png — Email dialog
- help-settings-shifts.png — Settings → Shifts (shift types, colors, order)
- help-settings-staffing.png — Settings → Staffing targets
- help-settings-team.png — Team members list
- help-settings-invite.png — Inviting new team members
- help-settings-rotations.png — Settings → Rotations
- help-share-links.png — Share Links (schedule, availability, open slots)
- help-employee-schedule.png — Employee schedule overview
- help-employee-availability.png — Employee availability
`;

export async function answerHelpQuestion(
  question: string,
  role: string,
  history: Array<{ q: string; a: string }> = []
): Promise<{ answer: string; visuals: string[] }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured.');
  const model = await discoverModel(apiKey);
  const histText = history.length
    ? 'Earlier in this conversation:\n' + history.map(h => `Q: ${h.q}\nA: ${h.a}`).join('\n') + '\n\n'
    : '';
  const prompt = `${HELP_KNOWLEDGE}
${HELP_VISUALS}
The person asking is a(n) ${role}.
${histText}Their question: ${question}

Answer in 2-6 short steps. No preamble. If one or two screenshots from the list above would help illustrate the answer, end your response with a line exactly like:
VISUAL: file1.png, file2.png
Only list files from the catalog above. If no screenshot fits, omit the VISUAL line.`;
  const res = await fetch(
    `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'Sorry, I could not answer that. Try rephrasing.';
  const visuals: string[] = [];
  const m = text.match(/^VISUAL:\s*(.+)$/m);
  let answer = text;
  if (m) {
    answer = text.replace(m[0], '').trim();
    m[1].split(',').forEach((f: string) => {
      const name = f.trim();
      if (/^help-[a-z0-9-]+\.png$/.test(name)) visuals.push(name);
    });
  }
  return { answer, visuals };
}

export interface OnboardingProposal {
  departments: { name: string; jobRoles: string[] }[];
  shiftTypes: { name: string; departmentNames: string[] }[];
}

export interface OnboardingInterviewResult {
  question?: string;          // one follow-up question, when more info is needed
  proposal?: OnboardingProposal;
  summary?: string;           // plain-language summary of the proposal
}

/**
 * Conversational onboarding: given the chat history, either ask one follow-up
 * question or return a complete setup proposal (departments, shift types, job roles).
 */
/**
 * Ask Q-Scheduler fallback: answer an uncovered question from a scoped
 * account data pack (shifts, sessions, open slots, team, settings). The
 * model must answer ONLY from the pack — never invent names, dates, or
 * numbers — and must refuse questions outside this account's schedule.
 */
export async function answerAskWithData(
  question: string,
  dataPack: string,
  role: string
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured.');
  const model = await discoverModel(apiKey);
  const prompt = `You are Q-Scheduler, a scheduling assistant. Answer the question using ONLY the account data below. Do not invent names, dates, numbers, or shifts. If the data does not contain the answer, say so plainly and suggest what to ask instead. If the question is not about this account's schedule, team, calendars, or settings, say you can only answer questions about this account's schedule. Keep the answer short and direct. Use the dates and names exactly as given.

Account data:
${dataPack}

The person asking is a(n) ${role}.
Their question: ${question}`;
  const res = await fetch(
    `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export async function onboardingInterview(
  history: { role: 'user' | 'assistant'; text: string }[]
): Promise<OnboardingInterviewResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured.');

  const convo = history
    .map((h) => `${h.role === 'user' ? 'Owner' : 'Q-Scheduler'}: ${h.text}`)
    .join('\n');

  const prompt = `You are Q-Scheduler, a friendly onboarding assistant for a staff scheduling app. A new business owner is setting up their company. Your job: learn enough to propose their initial setup — departments, shift types, and job roles.

Conversation so far:
${convo || '(just started — greet them and ask what kind of business they run)'}

Rules:
- Ask AT MOST 3 questions total across the conversation. Prefer asking one clear question per turn.
- You need: (1) what kind of business/industry, (2) their departments or teams, (3) shift patterns (names/times, e.g. day/night or morning/evening), (4) job roles per department. Infer sensible defaults from the industry when the owner is vague — don't interrogate.
- When you have enough (or after 3 questions), return a complete proposal. Every department needs 1-4 job roles. Shift types need names; departmentNames lists which departments use each shift type (use [] for all departments).
- Keep names short and plain (e.g. "Emergency", "Day Shift", "Nurse").

Respond with JSON only, no other text. Exactly one of these shapes:
{ "question": "your single follow-up question" }
or
{
  "proposal": {
    "departments": [ { "name": "Emergency", "jobRoles": ["Physician", "Nurse"] } ],
    "shiftTypes": [ { "name": "Day Shift", "departmentNames": [] } ]
  },
  "summary": "2-3 sentence plain-language summary of what you'll set up"
}`;

  const model = await discoverModel(apiKey);
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(
      `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1500 },
        }),
      }
    );
    if (res.ok) break;
    if (res.status === 503 && attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 10000));
      continue;
    }
    break;
  }
  if (!res || !res.ok) throw new Error(`Gemini API error: ${res?.status || 'no response'}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini did not return valid JSON.');
  const parsed = JSON.parse(jsonMatch[0]) as OnboardingInterviewResult;
  if (!parsed.question && !parsed.proposal) throw new Error('Gemini returned no question or proposal.');
  return parsed;
}

export interface ImportedAssignment {
  member: string;
  shift: string;
  date: string; // YYYY-MM-DD
}

/**
 * Read a schedule document (a PDF, or a spreadsheet converted to CSV text)
 * and extract every assignment as { member, shift, date } rows. Used by the
 * Block view "Import schedule" feature; the caller shows the rows in a
 * preview and only creates shifts after the user confirms.
 */
export async function parseScheduleDocument(input: {
  text?: string;
  pdfBase64?: string;
  members: string[];
  shiftTypes: string[];
  today: string;
}): Promise<ImportedAssignment[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('AI is not configured (GEMINI_API_KEY missing).');
  const prompt = `You extract staff shift assignments from a schedule document. Today is ${input.today}.

Team members (use these EXACT names): ${input.members.join(', ') || '(none)'}
Shift types (use these EXACT names): ${input.shiftTypes.join(', ') || '(none)'}

Return ONLY a JSON object: {"assignments": [{"member": "Exact Member Name", "shift": "Exact Shift Type Name", "date": "YYYY-MM-DD"}]}

Rules:
- One entry per person per shift per DAY.
- If the document assigns someone to a shift for a whole week (e.g. a block schedule grid: names down the side, weeks across the top, shift names in the cells), emit one entry for EACH day of that week (7 entries), using the week's actual dates.
- If a cell or row covers a date range, emit one entry per day in the range.
- Match names and shift names to the lists above, using the list's exact spelling. If a person or shift in the document is not in the lists, still include the entry with the document's spelling (the app will flag it).
- Resolve relative or partial dates ("Mar 3", "Week of Mar 3") against the year that makes them closest to today.
- Skip headers, totals, notes, and anything that is not a person working a shift on a date.
- If the document has no assignments, return {"assignments": []}.`;
  const parts: any[] = [{ text: prompt }];
  if (input.pdfBase64) {
    parts.push({ inlineData: { mimeType: 'application/pdf', data: input.pdfBase64 } });
  } else if (input.text) {
    parts.push({ text: 'Document content (spreadsheet as CSV):\n' + input.text.slice(0, 60000) });
  } else {
    throw new Error('Nothing to parse.');
  }
  const model = await discoverModel(apiKey);
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    res = await fetch(
      `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8000 },
        }),
      }
    );
    if (res.ok) break;
    if (res.status === 503 && attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 8000));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const errBody = res ? await res.text().catch(() => '') : '';
    throw new Error(`Gemini API error: ${res?.status || 'no response'} - ${errBody.substring(0, 300)}`);
  }
  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('The AI did not return readable assignments.');
  const parsed = JSON.parse(jsonMatch[0]) as { assignments?: any[] };
  const out: ImportedAssignment[] = [];
  for (const a of Array.isArray(parsed.assignments) ? parsed.assignments : []) {
    const member = String(a?.member || '').trim();
    const shift = String(a?.shift || '').trim();
    const date = String(a?.date || '').trim();
    if (member && shift && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push({ member, shift, date });
  }
  return out;
}
