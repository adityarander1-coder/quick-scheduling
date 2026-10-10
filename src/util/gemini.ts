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
  // List available models and pick the first flash model supporting generateContent
  const res = await fetch(`${GEMINI_API_BASE}/models?key=${apiKey}`);
  if (!res.ok) throw new Error(`Gemini list models failed: ${res.status}`);
  const data = await res.json() as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
  const models = data.models || [];
  // Prefer flash models (fast & cheap), fall back to any generateContent model
  const flash = models.find(m =>
    m.name.toLowerCase().includes('flash') &&
    m.supportedGenerationMethods?.includes('generateContent')
  );
  const anyModel = models.find(m => m.supportedGenerationMethods?.includes('generateContent'));
  const picked = flash || anyModel;
  if (!picked) throw new Error('No Gemini models support generateContent for this API key');
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
}

/**
 * Ask Gemini to parse an email into a structured schedule change plan.
 * Returns the plan, or a clarification request if the email is ambiguous.
 */
export async function planFromEmail(
  emailBody: string,
  emailSubject: string,
  context: { shiftTypes: string[]; members: string[]; today: string }
): Promise<SchedulePlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini API key not configured.');

  const prompt = `You are a scheduling assistant. Parse this email into a structured schedule change plan.

Today's date: ${context.today}

Available shift types: ${context.shiftTypes.join(', ') || '(none listed)'}
Team members: ${context.members.join(', ') || '(none listed)'}

Email subject: ${emailSubject}
Email body:
${emailBody}

Respond with JSON only, no other text:
{
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
  "summary": "Plain-language summary of the proposed changes",
  "confidence": "high|medium|low",
  "needsClarification": "Question to ask if anything is ambiguous, or null"
}

Rules:
- Resolve relative dates (Friday, tomorrow, next week) against today's date.
- Match person names fuzzily against the team member list.
- Match shift descriptions (night, day) against shift type names.
- If the email is not about schedule changes, return {"changes": [], "summary": "Not a schedule change request.", "confidence": "high", "needsClarification": null}.
- If critical info is missing (who, when), set confidence to "low" and ask in needsClarification.`;

  const model = await discoverModel(apiKey);
  const res = await fetch(
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

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini API error: ${res.status} - ${errBody.substring(0, 500)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  // Extract JSON from response (may have markdown code fences).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Gemini did not return valid JSON.');
  return JSON.parse(jsonMatch[0]) as SchedulePlan;
}
