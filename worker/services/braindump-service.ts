/**
 * Braindump Service — AI-Powered Network Command Center
 *
 * Parses free-form text into structured actions across the entire app:
 *   - Add new contacts
 *   - Log interactions with existing contacts
 *   - Assign/change Dunbar layers
 *   - Manage circle membership
 *   - Edit contact details
 *
 * The braindump is the natural language interface to everything except settings.
 *
 * @see dashboard/src/pages/BraindumpPage.tsx for the frontend
 * @see shared/models.ts for type definitions
 */

import type { Env } from '../../shared/types';
import type { IntentType, InteractionMethod, ContactSummary } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

const PARSING_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4000;

// ===========================================================================
// Types — Action-Based Results
// ===========================================================================

/**
 * Every action the braindump can produce.
 * Each has a type, the parsed data, and a confidence level.
 */
export type BraindumpAction =
  | AddContactAction
  | LogInteractionAction
  | UpdateLayerAction
  | AssignCircleAction
  | EditContactAction;

export interface AddContactAction {
  type: 'add_contact';
  data: {
    name: string;
    phone?: string;
    email?: string;
    suggested_intent?: IntentType;
    suggested_circles?: string[];
    contact_kind?: 'kin' | 'non_kin';
    notes?: string;
  };
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface LogInteractionAction {
  type: 'log_interaction';
  data: {
    contact_name: string;
    /** Set by the execute step after matching to an existing contact */
    contact_id?: string;
    date: string;
    method: InteractionMethod;
    summary: string;
  };
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface UpdateLayerAction {
  type: 'update_layer';
  data: {
    contact_name: string;
    contact_id?: string;
    new_intent: IntentType;
    current_intent?: IntentType;
  };
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface AssignCircleAction {
  type: 'assign_circle';
  data: {
    contact_name: string;
    contact_id?: string;
    circle_name: string;
    circle_id?: string;
    create_circle?: boolean;
  };
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface EditContactAction {
  type: 'edit_contact';
  data: {
    contact_name: string;
    contact_id?: string;
    updates: {
      name?: string;
      phone?: string;
      email?: string;
      notes?: string;
      contact_kind?: 'kin' | 'non_kin';
      preferred_method?: InteractionMethod;
    };
  };
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

export interface BraindumpParseResult {
  actions: BraindumpAction[];
  summary: string;
  unresolved: string[];
}

export interface ParseResult {
  success: true;
  data: BraindumpParseResult;
}

export interface ParseError {
  success: false;
  error: string;
}

export type BraindumpResult = ParseResult | ParseError;

// ===========================================================================
// Execution Types
// ===========================================================================

export interface ExecuteActionResult {
  action: BraindumpAction;
  success: boolean;
  message: string;
  /** ID of created/updated resource */
  resourceId?: string;
}

export interface ExecuteResult {
  results: ExecuteActionResult[];
  summary: string;
}

// ===========================================================================
// System Prompt
// ===========================================================================

function buildSystemPrompt(
  existingContacts: Array<{ name: string; id: string; intent: string }>,
  existingCircles: Array<{ name: string; id: string }>,
): string {
  const contactList = existingContacts.length > 0
    ? existingContacts.map(c => `- "${c.name}" (id: ${c.id}, layer: ${c.intent})`).join('\n')
    : '(no contacts yet)';

  const circleList = existingCircles.length > 0
    ? existingCircles.map(c => `- "${c.name}" (id: ${c.id})`).join('\n')
    : '(no circles yet)';

  return `You are the AI brain of Bethany Network Manager — a relationship management app built on Dunbar's social layer research.

Your job: parse the user's natural language input and produce a list of ACTIONS to execute. You are the command center — anything the user says about their contacts, relationships, interactions, circles, or network should become concrete actions.

## EXISTING CONTACTS
${contactList}

## EXISTING CIRCLES
${circleList}

## ACTION TYPES

### add_contact
When the user mentions someone NOT in their existing contacts list.
Include any details they mention: phone, email, relationship context, family status.
Suggest an intent (Dunbar layer) based on context clues.
Suggest circles based on context.
Mark family members as contact_kind: "kin".

### log_interaction
When the user describes connecting with someone. Look for:
- "called/texted/emailed/saw/met/had lunch with X"
- "X and I talked about..."
- "caught up with X"
- Past tense verbs indicating contact happened.
If the person is in existing contacts, include their contact_id.
If NOT in existing contacts, ALSO generate an add_contact action for them.
Convert relative dates to ISO format. Today is ${new Date().toISOString().split('T')[0]}.

### update_layer
When the user indicates a relationship level change:
- "Sarah should be inner circle"
- "Move Jake to transactional"
- "I'm not really close with Mike anymore" → dormant
- "Getting closer to Lisa" → nurture
Include both new_intent and current_intent (from existing contacts).

### assign_circle
When the user mentions circle membership:
- "Sarah is in my Work circle"
- "Add Jake to Friends"
- "Put Mom in Family"
If the circle doesn't exist in the existing circles list, set create_circle: true.

### edit_contact
When the user provides updated info about an existing contact:
- "Sarah's new number is 555-1234"
- "Jake's email is jake@company.com"
- "Mom prefers phone calls"
- "Actually Sarah is family" (contact_kind change)

## DUNBAR LAYERS (intent types)
- inner_circle: Closest 5. "best friend", "ride or die", "talk daily/weekly"
- nurture: Next 10. "getting closer", "investing in", "new friend I like"
- maintain: Next 35. "good friend", "catch up monthly", "stay in touch"
- transactional: Next 100. "work contact", "professional", "networking"
- dormant: Paused. "lost touch", "not active", "don't need to track"
- new: Default when intent is unclear

## RULES

1. Match names against existing contacts FIRST. Use fuzzy matching — "mom" might match "Susan Chen" if context suggests it, but don't guess. If unsure, treat as new.
2. One message can produce MANY actions. "I called Mom yesterday and had coffee with my new friend Jake" = log_interaction(Mom) + add_contact(Jake) + log_interaction(Jake).
3. Family keywords (mom, dad, sister, brother, wife, husband, etc.) → contact_kind: "kin" and suggest "Family" circle.
4. Include reasoning for every action — brief explanation of why you chose this action type and values.
5. Be aggressive about extracting actions. If there's any signal about a contact or interaction, capture it.
6. For interactions, always try to determine the method (text/call/in_person/email/social/other) and date.
7. If you can't parse something meaningful, put it in unresolved.
8. Generate a brief, natural summary of all actions for the confirmation UI.

## OUTPUT FORMAT

Return ONLY valid JSON:
{
  "actions": [
    {
      "type": "add_contact",
      "data": { ... },
      "confidence": "high",
      "reasoning": "User mentioned Sarah as a new person"
    }
  ],
  "summary": "Adding 2 new contacts and logging 3 interactions",
  "unresolved": []
}`;
}

// ===========================================================================
// Main Parse Function
// ===========================================================================

/**
 * Parse free-form text into structured actions.
 *
 * Fetches the user's existing contacts and circles first so the AI
 * can match names and avoid duplicates.
 */
export async function parseBraindump(
  env: Env,
  text: string,
  userId?: string,
): Promise<BraindumpResult> {
  if (!text.trim()) {
    return { success: false, error: 'No text provided to parse' };
  }

  // Fetch existing contacts and circles for context
  let existingContacts: Array<{ name: string; id: string; intent: string }> = [];
  let existingCircles: Array<{ name: string; id: string }> = [];

  if (userId) {
    try {
      const [contactsResult, circlesResult] = await Promise.all([
        env.DB.prepare(
          `SELECT id, name, intent FROM contacts WHERE user_id = ? AND archived = 0 ORDER BY name`
        ).bind(userId).all<{ id: string; name: string; intent: string }>(),
        env.DB.prepare(
          `SELECT id, name FROM circles WHERE user_id = ? ORDER BY sort_order`
        ).bind(userId).all<{ id: string; name: string }>(),
      ]);
      existingContacts = contactsResult.results;
      existingCircles = circlesResult.results;
    } catch (err) {
      console.error('[braindump] Failed to fetch context:', err);
    }
  }

  const systemPrompt = buildSystemPrompt(existingContacts, existingCircles);

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
        system: systemPrompt,
        messages: [{ role: 'user', content: text }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[braindump] Anthropic API error: ${response.status} — ${errorBody}`);
      return { success: false, error: 'Failed to process your braindump. Please try again.' };
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const textBlock = data.content.find(b => b.type === 'text');
    const responseText = textBlock?.text?.trim();

    if (!responseText) {
      return { success: false, error: 'No response from AI. Please try again.' };
    }

    const parsed = parseJsonResponse(responseText);
    if (!parsed) {
      console.error('[braindump] Failed to parse JSON:', responseText);
      return { success: false, error: 'Failed to parse the AI response. Please try again.' };
    }

    const validated = validateActions(parsed, existingContacts, existingCircles);

    return { success: true, data: validated };
  } catch (err) {
    console.error('[braindump] Unexpected error:', err);
    return { success: false, error: 'An unexpected error occurred. Please try again.' };
  }
}

// ===========================================================================
// Execute Actions
// ===========================================================================

/**
 * Execute a list of braindump actions against the database.
 *
 * Actions are executed in dependency order:
 *   1. add_contact (so new contacts exist for subsequent actions)
 *   2. edit_contact
 *   3. update_layer
 *   4. assign_circle (may create circles)
 *   5. log_interaction
 */
export async function executeBraindumpActions(
  env: Env,
  userId: string,
  actions: BraindumpAction[],
): Promise<ExecuteResult> {
  const { createContact, updateContact, searchContacts } = await import('./contact-service');
  const { logInteraction } = await import('./interaction-service');
  const { createCircle, listCirclesWithCounts } = await import('./circle-service');

  const results: ExecuteActionResult[] = [];
  /** Map of contact_name → contact_id for linking actions */
  const nameToIdMap = new Map<string, string>();

  // Pre-populate with existing contacts
  const { results: existing } = await env.DB.prepare(
    `SELECT id, name FROM contacts WHERE user_id = ? AND archived = 0`
  ).bind(userId).all<{ id: string; name: string }>();
  for (const c of existing) {
    nameToIdMap.set(c.name.toLowerCase(), c.id);
  }

  // Sort actions by execution order
  const ordered = sortActionsByDependency(actions);

  for (const action of ordered) {
    try {
      const result = await executeAction(
        env, userId, action, nameToIdMap,
        { createContact, updateContact, searchContacts, logInteraction, createCircle, listCirclesWithCounts },
      );
      results.push(result);

      // Track new contact IDs
      if (action.type === 'add_contact' && result.success && result.resourceId) {
        nameToIdMap.set(action.data.name.toLowerCase(), result.resourceId);
      }
    } catch (err) {
      console.error(`[braindump] Action failed:`, action.type, err);
      results.push({
        action,
        success: false,
        message: `Failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const summary = failed === 0
    ? `All ${succeeded} actions completed successfully!`
    : `${succeeded} succeeded, ${failed} failed.`;

  return { results, summary };
}

async function executeAction(
  env: Env,
  userId: string,
  action: BraindumpAction,
  nameToIdMap: Map<string, string>,
  services: {
    createContact: typeof import('./contact-service').createContact;
    updateContact: typeof import('./contact-service').updateContact;
    searchContacts: typeof import('./contact-service').searchContacts;
    logInteraction: typeof import('./interaction-service').logInteraction;
    createCircle: typeof import('./circle-service').createCircle;
    listCirclesWithCounts: typeof import('./circle-service').listCirclesWithCounts;
  },
): Promise<ExecuteActionResult> {
  const db = env.DB;

  switch (action.type) {
    case 'add_contact': {
      const contact = await services.createContact(db, userId, {
        name: action.data.name,
        phone: action.data.phone,
        email: action.data.email,
        intent: action.data.suggested_intent ?? 'new',
        contact_kind: action.data.contact_kind ?? 'non_kin',
        notes: action.data.notes,
        source: 'braindump',
      });
      return {
        action,
        success: true,
        message: `Added ${contact.name}`,
        resourceId: contact.id,
      };
    }

    case 'log_interaction': {
      const contactId = action.data.contact_id
        ?? nameToIdMap.get(action.data.contact_name.toLowerCase());

      if (!contactId) {
        return {
          action,
          success: false,
          message: `Couldn't find contact "${action.data.contact_name}" to log interaction`,
        };
      }

      const interaction = await services.logInteraction(db, userId, {
        contact_id: contactId,
        method: action.data.method,
        date: action.data.date,
        summary: action.data.summary,
        logged_via: 'braindump',
      });

      return {
        action,
        success: !!interaction,
        message: interaction
          ? `Logged ${action.data.method} with ${action.data.contact_name}`
          : `Failed to log interaction with ${action.data.contact_name}`,
        resourceId: interaction?.id,
      };
    }

    case 'update_layer': {
      const contactId = action.data.contact_id
        ?? nameToIdMap.get(action.data.contact_name.toLowerCase());

      if (!contactId) {
        return {
          action,
          success: false,
          message: `Couldn't find contact "${action.data.contact_name}" to update layer`,
        };
      }

      const updated = await services.updateContact(db, userId, contactId, {
        intent: action.data.new_intent,
      });

      return {
        action,
        success: !!updated,
        message: updated
          ? `Moved ${action.data.contact_name} to ${action.data.new_intent}`
          : `Failed to update ${action.data.contact_name}`,
      };
    }

    case 'assign_circle': {
      const contactId = action.data.contact_id
        ?? nameToIdMap.get(action.data.contact_name.toLowerCase());

      if (!contactId) {
        return {
          action,
          success: false,
          message: `Couldn't find contact "${action.data.contact_name}" for circle assignment`,
        };
      }

      let circleId = action.data.circle_id;

      // Create circle if needed
      if (!circleId && action.data.create_circle) {
        const circle = await services.createCircle(db, userId, {
          name: action.data.circle_name,
          default_cadence_days: null,
        });
        circleId = circle.id;
      }

      // Find existing circle by name if no ID
      if (!circleId) {
        const circle = await db.prepare(
          `SELECT id FROM circles WHERE user_id = ? AND name = ? COLLATE NOCASE`
        ).bind(userId, action.data.circle_name).first<{ id: string }>();
        circleId = circle?.id;
      }

      if (!circleId) {
        return {
          action,
          success: false,
          message: `Circle "${action.data.circle_name}" not found`,
        };
      }

      // Add to circle (ignore if already linked)
      await db.prepare(
        `INSERT OR IGNORE INTO contact_circles (contact_id, circle_id, added_at)
         VALUES (?, ?, datetime('now'))`
      ).bind(contactId, circleId).run();

      return {
        action,
        success: true,
        message: `Added ${action.data.contact_name} to ${action.data.circle_name}`,
      };
    }

    case 'edit_contact': {
      const contactId = action.data.contact_id
        ?? nameToIdMap.get(action.data.contact_name.toLowerCase());

      if (!contactId) {
        return {
          action,
          success: false,
          message: `Couldn't find contact "${action.data.contact_name}" to edit`,
        };
      }

      const updated = await services.updateContact(db, userId, contactId, action.data.updates);

      return {
        action,
        success: !!updated,
        message: updated
          ? `Updated ${action.data.contact_name}`
          : `Failed to update ${action.data.contact_name}`,
      };
    }

    default:
      return {
        action,
        success: false,
        message: `Unknown action type`,
      };
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function sortActionsByDependency(actions: BraindumpAction[]): BraindumpAction[] {
  const order: Record<string, number> = {
    add_contact: 0,
    edit_contact: 1,
    update_layer: 2,
    assign_circle: 3,
    log_interaction: 4,
  };
  return [...actions].sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99));
}

function parseJsonResponse(text: string): unknown | null {
  let cleaned = text.replace(/```json\n?|```\n?/g, '').trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) cleaned = jsonMatch[0];
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

// ===========================================================================
// Validation
// ===========================================================================

const VALID_INTENTS: IntentType[] = ['inner_circle', 'nurture', 'maintain', 'transactional', 'dormant', 'new'];
const VALID_METHODS: InteractionMethod[] = ['text', 'call', 'in_person', 'email', 'video', 'social', 'other'];

function validateActions(
  parsed: unknown,
  existingContacts: Array<{ name: string; id: string; intent: string }>,
  existingCircles: Array<{ name: string; id: string }>,
): BraindumpParseResult {
  const result: BraindumpParseResult = { actions: [], summary: '', unresolved: [] };

  if (!parsed || typeof parsed !== 'object') return result;
  const obj = parsed as Record<string, unknown>;

  result.summary = typeof obj.summary === 'string' ? obj.summary : '';
  result.unresolved = Array.isArray(obj.unresolved)
    ? obj.unresolved.filter((s): s is string => typeof s === 'string' && !!s.trim())
    : [];

  if (!Array.isArray(obj.actions)) return result;

  for (const raw of obj.actions) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const type = a.type as string;
    const data = a.data as Record<string, unknown> | undefined;
    const confidence = (['high', 'medium', 'low'].includes(a.confidence as string) ? a.confidence : 'medium') as 'high' | 'medium' | 'low';
    const reasoning = typeof a.reasoning === 'string' ? a.reasoning : '';

    if (!data) continue;

    switch (type) {
      case 'add_contact': {
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!name) continue;
        result.actions.push({
          type: 'add_contact',
          data: {
            name,
            phone: typeof data.phone === 'string' ? data.phone.trim() || undefined : undefined,
            email: typeof data.email === 'string' ? data.email.trim() || undefined : undefined,
            suggested_intent: VALID_INTENTS.includes(data.suggested_intent as IntentType) ? data.suggested_intent as IntentType : undefined,
            suggested_circles: Array.isArray(data.suggested_circles) ? data.suggested_circles.filter((s): s is string => typeof s === 'string') : undefined,
            contact_kind: data.contact_kind === 'kin' ? 'kin' : data.contact_kind === 'non_kin' ? 'non_kin' : undefined,
            notes: typeof data.notes === 'string' ? data.notes.trim() || undefined : undefined,
          },
          confidence,
          reasoning,
        });
        break;
      }
      case 'log_interaction': {
        const contactName = typeof data.contact_name === 'string' ? data.contact_name.trim() : '';
        if (!contactName) continue;
        // Try to resolve contact_id
        const match = existingContacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
        result.actions.push({
          type: 'log_interaction',
          data: {
            contact_name: contactName,
            contact_id: match?.id ?? (typeof data.contact_id === 'string' ? data.contact_id : undefined),
            date: typeof data.date === 'string' ? data.date : new Date().toISOString().split('T')[0],
            method: VALID_METHODS.includes(data.method as InteractionMethod) ? data.method as InteractionMethod : 'other',
            summary: typeof data.summary === 'string' ? data.summary.trim() : '',
          },
          confidence,
          reasoning,
        });
        break;
      }
      case 'update_layer': {
        const contactName = typeof data.contact_name === 'string' ? data.contact_name.trim() : '';
        const newIntent = data.new_intent as IntentType;
        if (!contactName || !VALID_INTENTS.includes(newIntent)) continue;
        const match = existingContacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
        result.actions.push({
          type: 'update_layer',
          data: {
            contact_name: contactName,
            contact_id: match?.id ?? (typeof data.contact_id === 'string' ? data.contact_id : undefined),
            new_intent: newIntent,
            current_intent: match?.intent as IntentType ?? undefined,
          },
          confidence,
          reasoning,
        });
        break;
      }
      case 'assign_circle': {
        const contactName = typeof data.contact_name === 'string' ? data.contact_name.trim() : '';
        const circleName = typeof data.circle_name === 'string' ? data.circle_name.trim() : '';
        if (!contactName || !circleName) continue;
        const contactMatch = existingContacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
        const circleMatch = existingCircles.find(c => c.name.toLowerCase() === circleName.toLowerCase());
        result.actions.push({
          type: 'assign_circle',
          data: {
            contact_name: contactName,
            contact_id: contactMatch?.id,
            circle_name: circleName,
            circle_id: circleMatch?.id,
            create_circle: !circleMatch,
          },
          confidence,
          reasoning,
        });
        break;
      }
      case 'edit_contact': {
        const contactName = typeof data.contact_name === 'string' ? data.contact_name.trim() : '';
        if (!contactName) continue;
        const match = existingContacts.find(c => c.name.toLowerCase() === contactName.toLowerCase());
        const updates = data.updates as Record<string, unknown> | undefined;
        if (!updates || Object.keys(updates).length === 0) continue;
        result.actions.push({
          type: 'edit_contact',
          data: {
            contact_name: contactName,
            contact_id: match?.id,
            updates: {
              name: typeof updates.name === 'string' ? updates.name.trim() || undefined : undefined,
              phone: typeof updates.phone === 'string' ? updates.phone.trim() || undefined : undefined,
              email: typeof updates.email === 'string' ? updates.email.trim() || undefined : undefined,
              notes: typeof updates.notes === 'string' ? updates.notes.trim() || undefined : undefined,
              contact_kind: updates.contact_kind === 'kin' ? 'kin' : updates.contact_kind === 'non_kin' ? 'non_kin' : undefined,
              preferred_method: VALID_METHODS.includes(updates.preferred_method as InteractionMethod) ? updates.preferred_method as InteractionMethod : undefined,
            },
          },
          confidence,
          reasoning,
        });
        break;
      }
    }
  }

  return result;
}
