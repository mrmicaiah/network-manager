/**
 * Braindump Service — AI-Powered Contact Extraction
 *
 * Parses free-form text about contacts and relationships into structured data.
 * This is the "magic" feature that makes adding contacts feel effortless.
 *
 * Example inputs:
 *   "Sarah Chen - college roommate, lives in Denver, works at Google. Inner circle."
 *   "Had lunch with Jake last week, talked about startups"
 *   "Mom - call every Sunday. Birthday in March."
 *
 * Uses Claude Sonnet 4 for quality extraction without overkill.
 *
 * @see dashboard/src/pages/BraindumpPage.tsx for the frontend
 * @see shared/models.ts for BraindumpExtraction type
 */

import type { Env } from '../../shared/types';
import type { IntentType, InteractionMethod, BraindumpExtraction } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** Model to use for parsing — Sonnet 4 for quality without overkill */
const PARSING_MODEL = 'claude-sonnet-4-20250514';

/** Max tokens for the response */
const MAX_TOKENS = 2000;

// ===========================================================================
// Types
// ===========================================================================

export interface ParseResult {
  success: true;
  data: BraindumpExtraction;
}

export interface ParseError {
  success: false;
  error: string;
}

export type BraindumpResult = ParseResult | ParseError;

// ===========================================================================
// System Prompt
// ===========================================================================

const SYSTEM_PROMPT = `You are an expert at extracting structured contact and interaction data from natural language.

Your task is to parse free-form text about someone's social network and extract:
1. **Contacts** — people mentioned with their details
2. **Interactions** — past touchpoints mentioned (e.g., "had lunch last week")
3. **Unresolved** — text fragments you couldn't confidently parse

## Intent Mapping (Dunbar Layers)

Map relationship descriptions to these intent levels:
- **inner_circle**: Closest relationships. Keywords: "best friend", "inner circle", "closest", "talk every day", "can't live without"
- **nurture**: Growing/investing relationships. Keywords: "getting closer", "new friend", "want to know better", "weekly calls"
- **maintain**: Stable relationships. Keywords: "catch up monthly", "good friend", "stay in touch", "regular contact"
- **transactional**: Purpose-driven. Keywords: "work contact", "professional", "business", "networking", "useful to know"
- **dormant**: Paused relationships. Keywords: "lost touch", "should reconnect", "haven't talked in years", "dormant"
- **new**: Default when unclear — the user hasn't indicated how they want to maintain this relationship

## Circle Suggestions

Suggest circles based on context:
- Family mentions → "Family"
- Work/colleague → "Work"
- Friend context → "Friends"
- Church/religious → "Community"
- Specific groups mentioned → Use their words (e.g., "Book Club", "Gym Friends", "College Crew")

## Confidence Levels

- **high**: Name + clear relationship/context + specific details
- **medium**: Name + some context but missing key details
- **low**: Just a name, or ambiguous reference

## Interaction Detection

Look for past touchpoints:
- "Had coffee with X yesterday"
- "Talked to X last week"
- "Saw X at the party"
- "X texted me about..."

Map to methods: text, call, in_person, email, social, other

## Output Format

Return ONLY valid JSON matching this exact structure:
{
  "contacts": [
    {
      "name": "Sarah Chen",
      "phone": null,
      "email": null,
      "suggested_intent": "inner_circle",
      "suggested_circles": ["Friends"],
      "notes": "College roommate, lives in Denver, works at Google",
      "confidence": "high"
    }
  ],
  "interactions": [
    {
      "contact_name": "Jake",
      "date": "2026-01-30",
      "method": "in_person",
      "summary": "Had lunch, talked about startup scene",
      "confidence": "medium"
    }
  ],
  "unresolved": ["some text that couldn't be parsed"]
}

## Rules

1. Extract ALL people mentioned, even with minimal context
2. For family (mom, dad, sister, brother, etc.), suggest intent based on described behavior, default to "maintain" if unclear
3. Phone/email only if explicitly stated (e.g., "555-123-4567" or "email@example.com")
4. Dates: Convert relative dates ("last week", "yesterday") to ISO format based on today's date
5. If multiple people in one sentence, extract each separately
6. Notes should capture relationship context, NOT just repeat the name
7. If you can't parse something meaningful, add it to "unresolved"
8. Return empty arrays if nothing to extract (don't make things up)

Today's date for reference: ${new Date().toISOString().split('T')[0]}`;

// ===========================================================================
// Main Parsing Function
// ===========================================================================

/**
 * Parse free-form text about contacts into structured data.
 *
 * @param env - Worker environment (for API key)
 * @param text - The raw text to parse
 * @returns Parsed contacts, interactions, and unresolved fragments
 */
export async function parseBraindump(
  env: Env,
  text: string,
): Promise<BraindumpResult> {
  if (!text.trim()) {
    return {
      success: false,
      error: 'No text provided to parse',
    };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: PARSING_MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[braindump] Anthropic API error: ${response.status} — ${errorBody}`);
      return {
        success: false,
        error: 'Failed to process your braindump. Please try again.',
      };
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content.find(b => b.type === 'text');
    const responseText = textBlock?.text?.trim();

    if (!responseText) {
      return {
        success: false,
        error: 'No response from AI. Please try again.',
      };
    }

    // Parse JSON response
    const parsed = parseJsonResponse(responseText);

    if (!parsed) {
      console.error('[braindump] Failed to parse JSON:', responseText);
      return {
        success: false,
        error: 'Failed to parse the AI response. Please try again.',
      };
    }

    // Validate and sanitize the response
    const validated = validateAndSanitize(parsed);

    return {
      success: true,
      data: validated,
    };
  } catch (err) {
    console.error('[braindump] Unexpected error:', err);
    return {
      success: false,
      error: 'An unexpected error occurred. Please try again.',
    };
  }
}

// ===========================================================================
// JSON Parsing Helpers
// ===========================================================================

/**
 * Parse JSON from AI response, handling markdown code blocks.
 */
function parseJsonResponse(text: string): unknown | null {
  // Remove markdown code blocks if present
  let cleaned = text.replace(/```json\n?|```\n?/g, '').trim();

  // Sometimes the model adds explanation before/after JSON
  // Try to find the JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    cleaned = jsonMatch[0];
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Validate and sanitize the parsed response.
 * Ensures type safety and reasonable defaults.
 */
function validateAndSanitize(parsed: unknown): BraindumpExtraction {
  const result: BraindumpExtraction = {
    contacts: [],
    interactions: [],
    unresolved: [],
  };

  if (!parsed || typeof parsed !== 'object') {
    return result;
  }

  const obj = parsed as Record<string, unknown>;

  // Validate contacts
  if (Array.isArray(obj.contacts)) {
    for (const contact of obj.contacts) {
      if (typeof contact === 'object' && contact !== null) {
        const c = contact as Record<string, unknown>;
        
        // Name is required
        if (typeof c.name !== 'string' || !c.name.trim()) {
          continue;
        }

        result.contacts.push({
          name: c.name.trim(),
          phone: typeof c.phone === 'string' ? c.phone.trim() || undefined : undefined,
          email: typeof c.email === 'string' ? c.email.trim() || undefined : undefined,
          suggested_intent: isValidIntent(c.suggested_intent) ? c.suggested_intent : undefined,
          suggested_circles: Array.isArray(c.suggested_circles)
            ? c.suggested_circles.filter((s): s is string => typeof s === 'string')
            : undefined,
          notes: typeof c.notes === 'string' ? c.notes.trim() || undefined : undefined,
          confidence: isValidConfidence(c.confidence) ? c.confidence : 'medium',
        });
      }
    }
  }

  // Validate interactions
  if (Array.isArray(obj.interactions)) {
    for (const interaction of obj.interactions) {
      if (typeof interaction === 'object' && interaction !== null) {
        const i = interaction as Record<string, unknown>;

        // contact_name and summary are required
        if (
          typeof i.contact_name !== 'string' ||
          !i.contact_name.trim() ||
          typeof i.summary !== 'string' ||
          !i.summary.trim()
        ) {
          continue;
        }

        result.interactions.push({
          contact_name: i.contact_name.trim(),
          date: typeof i.date === 'string' ? i.date.trim() || undefined : undefined,
          method: isValidMethod(i.method) ? i.method : undefined,
          summary: i.summary.trim(),
          confidence: isValidConfidence(i.confidence) ? i.confidence : 'medium',
        });
      }
    }
  }

  // Validate unresolved
  if (Array.isArray(obj.unresolved)) {
    for (const item of obj.unresolved) {
      if (typeof item === 'string' && item.trim()) {
        result.unresolved.push(item.trim());
      }
    }
  }

  return result;
}

// ===========================================================================
// Type Guards
// ===========================================================================

const VALID_INTENTS: IntentType[] = [
  'inner_circle',
  'nurture',
  'maintain',
  'transactional',
  'dormant',
  'new',
];

const VALID_METHODS: InteractionMethod[] = [
  'text',
  'call',
  'in_person',
  'email',
  'social',
  'other',
];

const VALID_CONFIDENCES = ['high', 'medium', 'low'] as const;

function isValidIntent(value: unknown): value is IntentType {
  return typeof value === 'string' && VALID_INTENTS.includes(value as IntentType);
}

function isValidMethod(value: unknown): value is InteractionMethod {
  return typeof value === 'string' && VALID_METHODS.includes(value as InteractionMethod);
}

function isValidConfidence(value: unknown): value is 'high' | 'medium' | 'low' {
  return typeof value === 'string' && VALID_CONFIDENCES.includes(value as 'high' | 'medium' | 'low');
}
