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
  action: 'assign' | 'unassign' | 'move' | 'swap';
  person?: string;          // name for assign/unassign
  fromPerson?: string;       // for move/swap
  toPerson?: string;         // for move/swap
  date?: string;             // YYYY-MM-DD
  fromDate?: string;
  toDate?: string;
  shiftType?: string;       // shift type name
}

export interface SchedulePlan {
  changes: PlanChange[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  needsClarification?: string; // question to ask if ambiguous
  emailType: 'change_request' | 'schedule_question' | 'other';
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
  context: { shiftTypes: string[]; members: string[]; today: string }
): Promise<SchedulePlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured.');

  const prompt = `You are a scheduling assistant. Classify this email and parse it accordingly.

Today's date: ${context.today}

Available shift types: ${context.shiftTypes.join(', ') || '(none listed)'}
Team members: ${context.members.join(', ') || '(none listed)'}

Email subject: ${emailSubject}
Email body:
${emailBody}

First, classify the email into one of:
- "change_request": the sender wants to change the schedule (assign, unassign, move, swap shifts)
- "schedule_question": the sender is asking about the schedule (who is working when, what is the schedule for certain dates)
- "other": not related to scheduling

Respond with JSON only, no other text:
{
  "emailType": "change_request|schedule_question|other",
  "changes": [
    {
      "action": "assign|unassign|move|swap",
      "person": "Full Name (for assign/unassign)",
      "fromPerson": "Full Name (for move/swap)",
      "toPerson": "Full Name (for move/swap)",
      "date": "YYYY-MM-DD",
      "fromDate": "YYYY-MM-DD (for move)",
      "toDate": "YYYY-MM-DD (for move)",
      "shiftType": "Shift type name"
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
- For "change_request": fill in "changes". Every change MUST have all its required fields filled in with real values — never null or empty. Required: assign needs person + date + shiftType; unassign needs person + date; move needs fromPerson + toPerson + date; swap needs fromPerson + toPerson + date. If you cannot determine any required field (e.g. the email doesn't name the person), do NOT emit an incomplete change — instead set "needsClarification" to a specific question (e.g. "Who should be unassigned on 2026-10-24?") and set "confidence" to "low". Resolve relative dates (Friday, tomorrow, next week) against today's date. Match person names fuzzily against the team member list. Match shift descriptions (night, day) against shift type names. If critical info is missing (who, when), set confidence to "low" and ask in needsClarification. Set "question" to null.
- For "schedule_question": set "changes" to []. Fill in "question" with parsed details. Resolve relative dates against today's date. Examples: "who is working Oct 12" → kind "who_is_on", startDate=endDate="2026-10-12". "Schedule for Oct 11-13" → kind "schedule_for_dates" with startDate/endDate. "When is John working" → kind "person_schedule" with person name.
- For "other": set "changes" to [], "question" to null, summary to "Not schedule related.", confidence to "high".`;

  const model = await discoverModel(apiKey);

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
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
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
