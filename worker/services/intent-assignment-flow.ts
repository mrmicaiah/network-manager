/**
 * Intent Assignment Flow — Sort Contacts into Relationship Layers
 *
 * This service handles the conversational flow for assigning intents to
 * contacts that have circles but no intent set. It integrates with the
 * weekly sorting session and can also run standalone.
 *
 * THE PROBLEM:
 *
 *   Contacts without intent are incomplete. The nudge system relies on
 *   intent to calculate cadence and health status. A contact in the
 *   "Friends" circle with no intent won't generate nudges, which means
 *   they'll silently drift out of the user's life.
 *
 * THE FLOW:
 *
 *   1. Query: Find contacts with circle assignments but intent = 'new'
 *   2. Present: For each contact, show context and ask about the goal
 *   3. Map: Convert natural language responses to intent types
 *   4. Suggest: If user is unsure, suggest based on circle + Dunbar research
 *   5. Apply: Update the contact's intent and recalculate health
 *
 * BETHANY'S VOICE:
 *
 *   The prompts should feel like a helpful friend checking in, not a
 *   database form. Example:
 *
 *   "What's the goal with Mike Johnson from Golf Buddies? Stay in touch
 *   casually, deepen the relationship, or just keep him on file?"
 *
 * INTENT MAPPING:
 *
 *   User says...                    → Maps to...
 *   "stay in touch"                 → maintain
 *   "deepen" / "grow" / "invest"    → nurture
 *   "keep on file" / "maybe later"  → dormant
 *   "strategic" / "professional"    → transactional (or nurture if warm)
 *   "family" / "closest"            → inner_circle (or maintain for extended)
 *
 * CIRCLE-BASED SUGGESTIONS:
 *
 *   When a user says "not sure" or "you decide", Bethany suggests:
 *
 *   Family circle     → inner_circle (immediate) or maintain (extended)
 *   Friends circle    → nurture (close friends) or maintain (casual)
 *   Work circle       → transactional (colleagues) or nurture (mentors)
 *   Community circle  → maintain (default) or transactional
 *
 * STATE MANAGEMENT:
 *
 *   When Bethany presents a contact for sorting, she stores pending context
 *   so the next message can be interpreted correctly:
 *
 *   {
 *     type: 'intent_assignment',
 *     contactId: 'uuid',
 *     contactName: 'Mike Johnson',
 *     circles: ['Golf Buddies'],
 *     suggestedIntent: 'maintain',
 *     presentedAt: '2026-02-05T...'
 *   }
 *
 * INTEGRATION POINTS:
 *
 *   - Called by nudge-service.ts during the weekly sorting session
 *   - Can be triggered by conversation-router.ts when user says "sort my contacts"
 *   - Dashboard can show unsorted contacts as a to-do item
 *
 * @see worker/services/nudge-service.ts for weekly session integration
 * @see worker/services/conversation-router.ts for SMS routing
 * @see shared/intent-config.ts for INTENT_CONFIGS
 */

import type { Env } from '../../shared/types';
import type { UserRow, ContactRow, IntentType, ContactSummary } from '../../shared/models';
import { INTENT_CONFIGS } from '../../shared/intent-config';
import { updateContact, getContactWithCircles, listContacts } from './contact-service';

// ===========================================================================
// Types
// ===========================================================================

/**
 * A contact that needs intent assignment.
 */
export interface UnsortedContact {
  contactId: string;
  name: string;
  circles: Array<{ id: string; name: string }>;
  notes: string | null;
  createdAt: string;
  /** Bethany's suggested intent based on circles */
  suggestedIntent: IntentType;
  /** Reasoning for the suggestion */
  suggestionReason: string;
}

/**
 * Pending context for intent assignment.
 */
export interface PendingIntentAssignmentContext {
  type: 'intent_assignment';
  contactId: string;
  contactName: string;
  circles: string[];
  suggestedIntent: IntentType;
  presentedAt: string;
}

/**
 * Result of parsing user's intent response.
 */
export interface IntentResponseParsed {
  /** The resolved intent, or null if unclear */
  intent: IntentType | null;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
  /** Whether the user asked for a suggestion */
  wantsSuggestion: boolean;
  /** Whether to skip this contact */
  skip: boolean;
}

/**
 * Result of the intent assignment flow.
 */
export interface IntentAssignmentResult {
  /** Bethany's response message */
  reply: string;
  /** Whether we're expecting a follow-up */
  expectsReply: boolean;
  /** Pending context if expecting reply */
  pendingContext?: PendingIntentAssignmentContext | null;
  /** Whether the contact was successfully sorted */
  sorted: boolean;
  /** The assigned intent, if sorted */
  assignedIntent?: IntentType;
}

// ===========================================================================
// Query Unsorted Contacts
// ===========================================================================

/**
 * Find contacts that have circle assignments but intent = 'new'.
 *
 * These are the contacts that need sorting. The query prioritizes:
 *   1. Contacts with more circles (more context to work with)
 *   2. Older contacts (been waiting longer)
 *
 * @param db     - D1 database binding
 * @param userId - The user to query
 * @param limit  - Max contacts to return (default: 5)
 */
export async function getUnsortedContacts(
  db: D1Database,
  userId: string,
  limit: number = 5,
): Promise<UnsortedContact[]> {
  // Find contacts with intent = 'new' that have at least one circle
  const { results } = await db
    .prepare(
      `SELECT DISTINCT c.id, c.name, c.notes, c.created_at
       FROM contacts c
       INNER JOIN contact_circles cc ON c.id = cc.contact_id
       WHERE c.user_id = ?
         AND c.intent = 'new'
         AND c.archived = 0
       ORDER BY c.created_at ASC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<{ id: string; name: string; notes: string | null; created_at: string }>();

  if (results.length === 0) return [];

  // Batch-fetch circles for these contacts
  const contactIds = results.map((r) => r.id);
  const placeholders = contactIds.map(() => '?').join(', ');

  const { results: circleLinks } = await db
    .prepare(
      `SELECT cc.contact_id, cr.id, cr.name
       FROM contact_circles cc
       INNER JOIN circles cr ON cc.circle_id = cr.id
       WHERE cc.contact_id IN (${placeholders})
       ORDER BY cr.sort_order`
    )
    .bind(...contactIds)
    .all<{ contact_id: string; id: string; name: string }>();

  // Group circles by contact
  const circleMap = new Map<string, Array<{ id: string; name: string }>>();
  for (const row of circleLinks) {
    const existing = circleMap.get(row.contact_id) ?? [];
    existing.push({ id: row.id, name: row.name });
    circleMap.set(row.contact_id, existing);
  }

  // Build enriched results with suggestions
  return results.map((row) => {
    const circles = circleMap.get(row.id) ?? [];
    const { intent, reason } = suggestIntentFromCircles(circles);

    return {
      contactId: row.id,
      name: row.name,
      circles,
      notes: row.notes,
      createdAt: row.created_at,
      suggestedIntent: intent,
      suggestionReason: reason,
    };
  });
}

/**
 * Count how many contacts need sorting.
 */
export async function countUnsortedContacts(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(DISTINCT c.id) as count
       FROM contacts c
       INNER JOIN contact_circles cc ON c.id = cc.contact_id
       WHERE c.user_id = ?
         AND c.intent = 'new'
         AND c.archived = 0`
    )
    .bind(userId)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

// ===========================================================================
// Intent Suggestion Logic
// ===========================================================================

/**
 * Suggest an intent based on a contact's circle memberships.
 *
 * Uses Dunbar research to map common circle patterns:
 *   - Family → inner_circle for immediate family, maintain for extended
 *   - Friends → nurture for close friends, maintain for casual
 *   - Work → transactional for colleagues, nurture for mentors/sponsors
 *   - Community → maintain by default
 *
 * When multiple circles are present, we weight toward the closer layer.
 */
export function suggestIntentFromCircles(
  circles: Array<{ id: string; name: string }>,
): { intent: IntentType; reason: string } {
  if (circles.length === 0) {
    return { intent: 'maintain', reason: 'no circles for context — defaulting to maintain' };
  }

  const circleNames = circles.map((c) => c.name.toLowerCase());

  // Check for Family circle — suggests close relationship
  if (circleNames.some((n) => n.includes('family') || n.includes('relatives'))) {
    // Immediate family tends to be inner_circle, but extended can be maintain
    // For now, suggest maintain as a safe middle ground — user can elevate to inner_circle
    return {
      intent: 'maintain',
      reason: 'family contacts usually need at least monthly check-ins',
    };
  }

  // Check for Work circle — suggests transactional or nurture
  if (circleNames.some((n) => n.includes('work') || n.includes('colleagues') || n.includes('professional'))) {
    return {
      intent: 'transactional',
      reason: 'work contacts typically need quarterly touchpoints',
    };
  }

  // Check for Friends circle — suggests nurture or maintain
  if (circleNames.some((n) => n.includes('friend'))) {
    return {
      intent: 'nurture',
      reason: 'friendships grow with regular investment — suggest every couple weeks',
    };
  }

  // Check for Community/Church/Club circles — maintain
  if (circleNames.some((n) =>
    n.includes('community') ||
    n.includes('church') ||
    n.includes('club') ||
    n.includes('group') ||
    n.includes('team')
  )) {
    return {
      intent: 'maintain',
      reason: 'community contacts stay warm with monthly check-ins',
    };
  }

  // Check for hobby/activity circles (Golf Buddies, Book Club, etc.)
  if (circleNames.some((n) =>
    n.includes('golf') ||
    n.includes('book') ||
    n.includes('running') ||
    n.includes('gaming') ||
    n.includes('sport')
  )) {
    return {
      intent: 'maintain',
      reason: 'activity-based relationships stay warm with monthly touchpoints',
    };
  }

  // Default to maintain — safe middle ground
  return {
    intent: 'maintain',
    reason: 'monthly check-ins keep most relationships warm',
  };
}

/**
 * Get a human-friendly intent suggestion message.
 */
export function formatIntentSuggestion(
  contactName: string,
  circles: Array<{ name: string }>,
  suggestedIntent: IntentType,
): string {
  const circleList = circles.map((c) => c.name).join(', ') || 'no circles';
  const config = INTENT_CONFIGS[suggestedIntent];

  let suggestion = `Since ${contactName} is in ${circleList}, I'd guess **${config.label}**`;

  if (suggestedIntent === 'inner_circle') {
    suggestion += ' — checking in weekly keeps your closest people close.';
  } else if (suggestedIntent === 'nurture') {
    suggestion += ' — every couple weeks keeps the relationship growing.';
  } else if (suggestedIntent === 'maintain') {
    suggestion += ' — checking in monthly keeps things warm without pressure.';
  } else if (suggestedIntent === 'transactional') {
    suggestion += ' — quarterly touchpoints keep the professional connection alive.';
  } else if (suggestedIntent === 'dormant') {
    suggestion += ' — no reminders for now, but they stay in your network.';
  }

  return suggestion;
}

// ===========================================================================
// Response Parsing
// ===========================================================================

/**
 * Parse the user's response to an intent assignment prompt.
 *
 * Maps natural language to intent types:
 *   - "stay in touch" / "casual" → maintain
 *   - "deepen" / "grow" / "invest" → nurture
 *   - "closest" / "family" → inner_circle
 *   - "keep on file" / "dormant" → dormant
 *   - "strategic" / "professional" → transactional
 *   - "not sure" / "you decide" → wantsSuggestion: true
 *   - "skip" / "later" → skip: true
 */
export function parseIntentResponse(userMessage: string): IntentResponseParsed {
  const lower = userMessage.toLowerCase().trim();

  // Check for skip signals
  const skipSignals = ['skip', 'later', 'next', 'pass', 'not now', 'move on'];
  if (skipSignals.some((s) => lower.includes(s))) {
    return { intent: null, confidence: 'high', wantsSuggestion: false, skip: true };
  }

  // Check for "you decide" / suggestion request
  const suggestionSignals = [
    'not sure',
    'you decide',
    'you pick',
    'your call',
    'i don\'t know',
    'idk',
    'whatever you think',
    'suggest',
    'recommend',
  ];
  if (suggestionSignals.some((s) => lower.includes(s))) {
    return { intent: null, confidence: 'high', wantsSuggestion: true, skip: false };
  }

  // Check for inner_circle signals
  const innerCircleSignals = [
    'inner circle',
    'closest',
    'every week',
    'weekly',
    'most important',
    'my person',
    'best friend',
    'immediate family',
  ];
  if (innerCircleSignals.some((s) => lower.includes(s))) {
    return { intent: 'inner_circle', confidence: 'high', wantsSuggestion: false, skip: false };
  }

  // Check for nurture signals
  const nurtureSignals = [
    'nurture',
    'deepen',
    'grow',
    'invest',
    'build',
    'get closer',
    'every couple weeks',
    'biweekly',
    'important to me',
  ];
  if (nurtureSignals.some((s) => lower.includes(s))) {
    return { intent: 'nurture', confidence: 'high', wantsSuggestion: false, skip: false };
  }

  // Check for maintain signals
  const maintainSignals = [
    'maintain',
    'stay in touch',
    'casual',
    'monthly',
    'once a month',
    'keep warm',
    'check in occasionally',
  ];
  if (maintainSignals.some((s) => lower.includes(s))) {
    return { intent: 'maintain', confidence: 'high', wantsSuggestion: false, skip: false };
  }

  // Check for transactional signals
  const transactionalSignals = [
    'transactional',
    'professional',
    'strategic',
    'business',
    'quarterly',
    'networking',
    'when needed',
    'as needed',
  ];
  if (transactionalSignals.some((s) => lower.includes(s))) {
    return { intent: 'transactional', confidence: 'high', wantsSuggestion: false, skip: false };
  }

  // Check for dormant signals
  const dormantSignals = [
    'dormant',
    'keep on file',
    'maybe later',
    'not now',
    'pause',
    'hold off',
    'no reminders',
    'just keep them',
  ];
  if (dormantSignals.some((s) => lower.includes(s))) {
    return { intent: 'dormant', confidence: 'high', wantsSuggestion: false, skip: false };
  }

  // Family-specific handling
  if (lower.includes('family') || lower.includes('relative')) {
    // If they mention family, suggest maintain (safe middle) or inner_circle
    if (lower.includes('close') || lower.includes('immediate')) {
      return { intent: 'inner_circle', confidence: 'medium', wantsSuggestion: false, skip: false };
    }
    return { intent: 'maintain', confidence: 'medium', wantsSuggestion: false, skip: false };
  }

  // Affirmative responses (accepting suggestion)
  const affirmativeSignals = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'sounds good', 'perfect'];
  if (affirmativeSignals.some((s) => lower === s || lower === s + '!')) {
    return { intent: null, confidence: 'high', wantsSuggestion: true, skip: false };
  }

  // Couldn't determine — low confidence
  return { intent: null, confidence: 'low', wantsSuggestion: false, skip: false };
}

// ===========================================================================
// Flow Handlers
// ===========================================================================

/**
 * Generate the initial prompt for a contact that needs sorting.
 *
 * This is called when presenting a contact during the sorting session
 * or when the user asks to sort a specific contact.
 */
export function generateIntentPrompt(contact: UnsortedContact): string {
  const circleList = contact.circles.map((c) => c.name).join(', ') || 'no circles yet';

  let prompt = `What's the goal with **${contact.name}** (${circleList})?`;
  prompt += `\n\n`;
  prompt += `Stay in touch casually, deepen the relationship, or just keep them on file?`;

  return prompt;
}

/**
 * Handle the user's response to an intent assignment prompt.
 *
 * This is called by the conversation router when there's pending
 * intent assignment context.
 *
 * @param env - Worker environment bindings
 * @param user - The user responding
 * @param userMessage - Their reply text
 * @param pendingContext - The intent assignment context
 */
export async function handleIntentResponse(
  env: Env,
  user: UserRow,
  userMessage: string,
  pendingContext: PendingIntentAssignmentContext,
): Promise<IntentAssignmentResult> {
  const parsed = parseIntentResponse(userMessage);

  // Handle skip
  if (parsed.skip) {
    return {
      reply: `Okay, skipping ${pendingContext.contactName} for now. You can sort them later!`,
      expectsReply: false,
      pendingContext: null,
      sorted: false,
    };
  }

  // Handle suggestion request or affirmative (accepting suggestion)
  if (parsed.wantsSuggestion || (parsed.intent === null && parsed.confidence === 'high')) {
    // Apply the suggested intent
    const suggestedIntent = pendingContext.suggestedIntent;
    const updated = await updateContact(env.DB, user.id, pendingContext.contactId, {
      intent: suggestedIntent,
    });

    if (!updated) {
      return {
        reply: `Hmm, something went wrong updating ${pendingContext.contactName}. Mind trying again?`,
        expectsReply: false,
        pendingContext: null,
        sorted: false,
      };
    }

    const config = INTENT_CONFIGS[suggestedIntent];
    let cadenceNote = '';
    if (config.defaultCadenceDays) {
      cadenceNote = ` I'll nudge you to check in every ${config.defaultCadenceDays} days.`;
    }

    return {
      reply: `Done! Moved ${pendingContext.contactName} to ${config.label}.${cadenceNote}`,
      expectsReply: false,
      pendingContext: null,
      sorted: true,
      assignedIntent: suggestedIntent,
    };
  }

  // Handle clear intent
  if (parsed.intent && parsed.confidence !== 'low') {
    const updated = await updateContact(env.DB, user.id, pendingContext.contactId, {
      intent: parsed.intent,
    });

    if (!updated) {
      return {
        reply: `Hmm, something went wrong updating ${pendingContext.contactName}. Mind trying again?`,
        expectsReply: false,
        pendingContext: null,
        sorted: false,
      };
    }

    const config = INTENT_CONFIGS[parsed.intent];
    let cadenceNote = '';
    if (config.defaultCadenceDays) {
      cadenceNote = ` I'll nudge you to check in every ${config.defaultCadenceDays} days.`;
    }

    return {
      reply: `Got it! ${pendingContext.contactName} is now in ${config.label}.${cadenceNote}`,
      expectsReply: false,
      pendingContext: null,
      sorted: true,
      assignedIntent: parsed.intent,
    };
  }

  // Low confidence — offer suggestion and clarify
  const circlesList = pendingContext.circles.join(', ');
  const config = INTENT_CONFIGS[pendingContext.suggestedIntent];

  let clarification = `I'm not sure what you mean. For ${pendingContext.contactName}, you could:\n\n`;
  clarification += `• "Stay in touch" → Monthly check-ins\n`;
  clarification += `• "Deepen" → Every couple weeks\n`;
  clarification += `• "Inner circle" → Weekly\n`;
  clarification += `• "Keep on file" → No reminders\n\n`;
  clarification += `Since they're in ${circlesList}, I'd suggest **${config.label}**. Sound good?`;

  return {
    reply: clarification,
    expectsReply: true,
    pendingContext: {
      ...pendingContext,
      presentedAt: new Date().toISOString(), // Reset timer
    },
    sorted: false,
  };
}

/**
 * Start the intent assignment flow for a single contact.
 *
 * Called when a user wants to sort a specific contact, or when
 * presenting the next contact in a sorting session.
 *
 * @param env - Worker environment bindings
 * @param user - The user
 * @param contactId - The contact to sort
 */
export async function startIntentAssignment(
  env: Env,
  user: UserRow,
  contactId: string,
): Promise<IntentAssignmentResult> {
  const contact = await getContactWithCircles(env.DB, user.id, contactId);

  if (!contact) {
    return {
      reply: "I couldn't find that contact. Maybe it was deleted?",
      expectsReply: false,
      sorted: false,
    };
  }

  if (contact.intent !== 'new') {
    const config = INTENT_CONFIGS[contact.intent];
    return {
      reply: `${contact.name} is already sorted — they're in ${config.label}. Want to change that?`,
      expectsReply: true,
      sorted: false,
      pendingContext: {
        type: 'intent_assignment',
        contactId: contact.id,
        contactName: contact.name,
        circles: contact.circles.map((c) => c.name),
        suggestedIntent: contact.intent,
        presentedAt: new Date().toISOString(),
      },
    };
  }

  const { intent: suggestedIntent, reason } = suggestIntentFromCircles(contact.circles);

  const prompt = generateIntentPrompt({
    contactId: contact.id,
    name: contact.name,
    circles: contact.circles,
    notes: contact.notes,
    createdAt: contact.created_at,
    suggestedIntent,
    suggestionReason: reason,
  });

  return {
    reply: prompt,
    expectsReply: true,
    pendingContext: {
      type: 'intent_assignment',
      contactId: contact.id,
      contactName: contact.name,
      circles: contact.circles.map((c) => c.name),
      suggestedIntent,
      presentedAt: new Date().toISOString(),
    },
    sorted: false,
  };
}

/**
 * Get the next unsorted contact and present it for sorting.
 *
 * Used by the weekly sorting session to iterate through contacts.
 *
 * @param env - Worker environment bindings
 * @param user - The user
 */
export async function getNextUnsortedAndPrompt(
  env: Env,
  user: UserRow,
): Promise<IntentAssignmentResult & { hasMore: boolean; remaining: number }> {
  const unsorted = await getUnsortedContacts(env.DB, user.id, 1);
  const totalRemaining = await countUnsortedContacts(env.DB, user.id);

  if (unsorted.length === 0) {
    return {
      reply: "All your contacts are sorted! 🎉 Your network is fully set up.",
      expectsReply: false,
      sorted: false,
      hasMore: false,
      remaining: 0,
    };
  }

  const contact = unsorted[0];
  const prompt = generateIntentPrompt(contact);

  return {
    reply: prompt,
    expectsReply: true,
    pendingContext: {
      type: 'intent_assignment',
      contactId: contact.contactId,
      contactName: contact.name,
      circles: contact.circles.map((c) => c.name),
      suggestedIntent: contact.suggestedIntent,
      presentedAt: new Date().toISOString(),
    },
    sorted: false,
    hasMore: totalRemaining > 1,
    remaining: totalRemaining,
  };
}

/**
 * Run a batch sorting session — presents multiple contacts in sequence.
 *
 * This generates the opening message for a sorting session. After
 * each response, handleIntentResponse processes the user's choice,
 * then getNextUnsortedAndPrompt presents the next contact.
 */
export async function startSortingSession(
  env: Env,
  user: UserRow,
): Promise<{ openingMessage: string; pendingContext: PendingIntentAssignmentContext | null; count: number }> {
  const count = await countUnsortedContacts(env.DB, user.id);

  if (count === 0) {
    return {
      openingMessage: "Good news — all your contacts are sorted! Nothing to do here.",
      pendingContext: null,
      count: 0,
    };
  }

  const unsorted = await getUnsortedContacts(env.DB, user.id, 1);
  const contact = unsorted[0];

  let opening = `You have ${count} contact${count === 1 ? '' : 's'} that need sorting. `;
  opening += `I'll walk through each one — just tell me what kind of relationship it is.\n\n`;
  opening += generateIntentPrompt(contact);

  return {
    openingMessage: opening,
    pendingContext: {
      type: 'intent_assignment',
      contactId: contact.contactId,
      contactName: contact.name,
      circles: contact.circles.map((c) => c.name),
      suggestedIntent: contact.suggestedIntent,
      presentedAt: new Date().toISOString(),
    },
    count,
  };
}

// ===========================================================================
// Conversation Router Integration
// ===========================================================================

/**
 * Check if there's a pending intent assignment context for a user.
 */
export async function hasPendingIntentAssignmentContext(
  env: Env,
  userId: string,
): Promise<PendingIntentAssignmentContext | null> {
  // This would typically check a Durable Object or session store
  // For now, we rely on the conversation router passing the context
  // Similar pattern to nudge-conversation-flow.ts

  try {
    // Check if a DO is configured for context storage
    const doId = (env as any).INTENT_CONTEXT_DO?.idFromName(userId);
    if (!doId) return null;

    const doStub = (env as any).INTENT_CONTEXT_DO.get(doId);
    const response = await doStub.fetch(new Request('https://do/context'));

    if (response.status === 404) return null;

    const context = await response.json() as PendingIntentAssignmentContext;

    // Check if context has expired (10 minute window)
    const presentedAt = new Date(context.presentedAt).getTime();
    const now = Date.now();
    if (now - presentedAt > 10 * 60 * 1000) {
      // Expired — clear it
      await clearIntentAssignmentContext(env, userId);
      return null;
    }

    return context;
  } catch {
    return null;
  }
}

/**
 * Store pending intent assignment context for a user.
 */
export async function storeIntentAssignmentContext(
  env: Env,
  userId: string,
  context: PendingIntentAssignmentContext,
): Promise<void> {
  try {
    const doId = (env as any).INTENT_CONTEXT_DO?.idFromName(userId);
    if (!doId) return;

    const doStub = (env as any).INTENT_CONTEXT_DO.get(doId);
    await doStub.fetch(new Request('https://do/context', {
      method: 'PUT',
      body: JSON.stringify(context),
    }));
  } catch (err) {
    console.error('[intent-flow] Failed to store context:', err);
  }
}

/**
 * Clear pending intent assignment context for a user.
 */
export async function clearIntentAssignmentContext(
  env: Env,
  userId: string,
): Promise<void> {
  try {
    const doId = (env as any).INTENT_CONTEXT_DO?.idFromName(userId);
    if (!doId) return;

    const doStub = (env as any).INTENT_CONTEXT_DO.get(doId);
    await doStub.fetch(new Request('https://do/context', { method: 'DELETE' }));
  } catch {
    // Ignore cleanup failures
  }
}

// ===========================================================================
// Durable Object for Intent Assignment Context (Optional)
// ===========================================================================

/**
 * IntentContextDO — Stores pending intent assignment context per user.
 *
 * Optional — if not configured, context won't persist between messages.
 * The conversation router can also pass context directly.
 *
 * Wrangler config:
 *   [[durable_objects.bindings]]
 *   name = "INTENT_CONTEXT_DO"
 *   class_name = "IntentContextDO"
 */
export class IntentContextDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/context') {
      if (request.method === 'GET') {
        const data = await this.state.storage.get<PendingIntentAssignmentContext>('context');
        if (!data) {
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PUT') {
        const body = await request.json() as PendingIntentAssignmentContext;
        await this.state.storage.put('context', body);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'DELETE') {
        await this.state.storage.delete('context');
        return new Response('ok', { status: 200 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}
