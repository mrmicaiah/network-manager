/**
 * Conversation Router — Intent Classification & Dispatch for Established Users
 *
 * This is the brain of Bethany's SMS conversation for users who have
 * completed onboarding. Every inbound message from an established user
 * flows through here:
 *
 *   1. Classify intent — Claude analyzes the message and returns a
 *      structured intent with extracted entities (contact names, dates,
 *      methods, circle names, etc.)
 *   2. Dispatch — route to the appropriate sub-handler based on intent
 *   3. Respond — sub-handler generates Bethany's reply and sends via SendBlue
 *
 * Intent Types:
 *
 *   query_contact     — "How's my relationship with Sarah?"
 *   log_interaction   — "I called Mom yesterday"
 *   get_suggestions   — "Who should I reach out to?"
 *   manage_circles    — "Add Jake to my Work circle"
 *   sort_contact      — "Move Sarah to inner circle"
 *   sort_contacts     — "Sort my contacts" / "Help me organize my network"
 *   add_contact       — "Add John Smith, he's a new friend"
 *   braindump         — Long message with multiple contacts/interactions
 *   check_health      — "How's my network looking?"
 *   small_talk        — Casual conversation, thanks, greetings
 *   help              — "What can you do?" / "Help"
 *   unknown           — Couldn't classify with confidence
 *
 * Design Decisions:
 *
 *   - Claude does the intent classification, NOT regex/keyword matching.
 *     Natural language is too varied for pattern matching to work well.
 *     A user might say "touched base with Jake over coffee" and mean
 *     log_interaction, which no keyword list would reliably catch.
 *
 *   - Classification uses Claude Haiku for speed and cost. The full
 *     conversation response uses the model configured per-handler.
 *
 *   - The classifier extracts entities (names, dates, methods) alongside
 *     intent so handlers don't need to re-parse the message.
 *
 *   - Ambiguous messages get a clarification response rather than a
 *     wrong guess. "Sarah" alone could be query_contact or sort_contact
 *     or log_interaction — better to ask than assume.
 *
 *   - The router is stateless per-message. Multi-turn context (e.g.,
 *     "yes" in response to a clarification) is handled by checking
 *     the conversation history stored in the user's session state.
 *
 * @see worker/routes/sms.ts for the webhook entry point
 * @see shared/models.ts for UserRow, ContactRow, IntentType
 *
 * Last deploy bump: 2026-02-11
 */

import type { Env } from '../../shared/types';
import type { UserRow, InteractionMethod, IntentType } from '../../shared/models';
import type { NormalizedInboundMessage } from '../routes/sms';

// ===========================================================================
// Intent Classification Types
// ===========================================================================

/**
 * All conversation intents Bethany can handle for established users.
 */
export type ConversationIntent =
  | 'query_contact'
  | 'log_interaction'
  | 'get_suggestions'
  | 'manage_circles'
  | 'sort_contact'
  | 'sort_contacts'
  | 'add_contact'
  | 'braindump'
  | 'check_health'
  | 'google_contacts'
  | 'small_talk'
  | 'help'
  | 'unknown';

/**
 * Structured classification result from Claude.
 *
 * Contains the intent plus any entities extracted from the message.
 * Not all fields are populated for every intent — handlers check
 * what they need and fall back gracefully.
 */
export interface ClassifiedMessage {
  /** Primary intent */
  intent: ConversationIntent;
  /** Confidence level — 'low' triggers clarification instead of dispatch */
  confidence: 'high' | 'medium' | 'low';
  /** Contact name(s) mentioned in the message */
  contactNames: string[];
  /** Circle name mentioned, if any */
  circleName: string | null;
  /** Interaction method mentioned (called, texted, saw, etc.) */
  interactionMethod: InteractionMethod | null;
  /** Date/time reference extracted ("yesterday", "last week", etc.) */
  dateReference: string | null;
  /** Resolved ISO date from the date reference, if parseable */
  resolvedDate: string | null;
  /** Intent/layer the user wants to assign (for sort_contact) */
  targetIntent: IntentType | null;
  /** Summary or notes extracted from the message */
  extractedSummary: string | null;
  /** The raw message for handlers that need it */
  rawMessage: string;
  /** Reasoning from the classifier (for debugging, not shown to user) */
  classifierReasoning: string;
}

/**
 * Result from a sub-handler — what Bethany sends back.
 */
export interface ConversationResponse {
  /** The text message to send to the user via SendBlue */
  reply: string;
  /** Whether this is a follow-up that expects a response */
  expectsReply: boolean;
  /**
   * If expecting a reply, what context to store for the next message.
   * This is saved in the user's session so the router can handle
   * follow-up messages like "yes" or "the first one" in context.
   */
  pendingContext?: PendingContext;
}

/**
 * Stored context for multi-turn interactions.
 *
 * When Bethany asks a clarifying question or presents options,
 * this context is saved so the next message can be interpreted
 * in the right frame.
 */
export interface PendingContext {
  /** What kind of follow-up we're expecting */
  type: 'clarify_intent' | 'confirm_action' | 'select_contact' | 'select_option' | 'intent_assignment' | 'confirm_duplicate';
  /** The original intent being clarified */
  originalIntent: ConversationIntent;
  /** Any data the handler needs carried forward */
  data: Record<string, unknown>;
  /** When this context was created (expire after 5 minutes) */
  createdAt: string;
}

// ===========================================================================
// Sub-handler Type
// ===========================================================================

/**
 * A sub-handler processes a classified message and returns Bethany's response.
 *
 * Each handler receives:
 *   - The classified message with extracted entities
 *   - The user record (for name, subscription tier, gender, etc.)
 *   - The environment bindings (DB, API keys, etc.)
 *
 * Handlers are responsible for:
 *   - Querying the database for relevant data
 *   - Generating Bethany's response (optionally using Claude)
 *   - Returning the response text and any pending context
 */
export type SubHandler = (
  classified: ClassifiedMessage,
  user: UserRow,
  env: Env,
) => Promise<ConversationResponse>;

// ===========================================================================
// Intent Classification (Claude-powered)
// ===========================================================================

/**
 * System prompt for the intent classifier.
 *
 * This runs on Claude Haiku for speed. It returns structured JSON
 * with the intent and extracted entities. The prompt is carefully
 * designed to:
 *   - Handle casual, abbreviated SMS language
 *   - Extract multiple entities in one pass
 *   - Flag low-confidence classifications instead of guessing
 *   - Recognize braindumps (long messages with multiple people/events)
 */
const CLASSIFIER_SYSTEM_PROMPT = `You are an intent classifier for a relationship management app called Bethany Network Manager. Users text Bethany to manage their personal network.

Your job: analyze the user's SMS message and return a JSON object with the classified intent and extracted entities.

INTENT TYPES:
- query_contact: Asking about a specific person. "How's things with Sarah?" / "When did I last talk to Mom?" / "Tell me about Jake"
- log_interaction: Reporting they connected with someone. "Called Mom yesterday" / "Had lunch with Jake" / "Texted Sarah last week" / "Just saw Dave at the gym"
- get_suggestions: Asking who to reach out to. "Who should I call?" / "Anyone I'm behind on?" / "Who needs attention?" / "Give me someone to text"
- manage_circles: Circle operations. "Add Jake to Work" / "Create a Church circle" / "Show my circles" / "Remove Sarah from Friends"
- sort_contact: Changing ONE person's intent/layer. "Move Sarah to inner circle" / "Jake should be nurture" / "Put Mom in maintain" / "Sarah is more of a transactional contact"
- sort_contacts: Organizing MULTIPLE contacts or starting a sorting session. "Sort my contacts" / "Help me organize" / "I have unsorted contacts" / "Let's go through my network" / "Organize my people"
- add_contact: Adding a new person. "Add John Smith" / "New contact: Sarah Chen, she's a coworker" / "Remember my friend Jake, 555-1234"
- braindump: Long message mentioning multiple people or events. "This week I called Mom, had coffee with Jake, ran into Sarah at the store, and need to follow up with Dave about the project"
- check_health: Asking about overall network health, contact counts, or listing contacts. "How's my network?" / "Give me a summary" / "Dashboard" / "Status report" / "How many contacts do I have?" / "Who are my contacts?" / "List my contacts" / "Do I have any contacts?" / "Show me my network" / "Who's in my network?"
- google_contacts: Requests to connect, import, sync, or disconnect Google Contacts. "Import my contacts" / "Connect to Google" / "Sync my contacts" / "Import from Google" / "Pull contacts from my phone" / "Disconnect Google" / "Link Google Contacts"
- small_talk: Greetings, thanks, casual chat. "Hey" / "Thanks!" / "Good morning" / "You're the best" / "Haha"
- help: Asking what Bethany can do. "Help" / "What can you do?" / "Commands" / "How does this work?"
- unknown: Can't determine intent with reasonable confidence.

IMPORTANT: Any question about how many contacts the user has, who their contacts are, or requests to list/show contacts MUST be classified as "check_health" — NEVER as "small_talk" or "unknown". These require a database lookup.

ENTITY EXTRACTION:
- contactNames: Array of people mentioned by name. Never include "Bethany" or "you" as a contact name.
- circleName: Circle/group name if mentioned (Family, Friends, Work, or custom names).
- interactionMethod: How they connected — "text", "call", "in_person", "email", "social", "other". Infer from verbs: "called"→call, "texted"/"messaged"→text, "saw"/"met"/"lunch"/"coffee"/"dinner"→in_person, "emailed"→email.
- dateReference: Raw date text. "yesterday", "last week", "Tuesday", "2 days ago", etc.
- resolvedDate: Best-effort ISO date. Today is {{TODAY}}. "yesterday" → {{YESTERDAY}}. If ambiguous, null.
- targetIntent: For sort_contact — the layer they want: "inner_circle", "nurture", "maintain", "transactional", "dormant".
- extractedSummary: Any details about what happened. "talked about holiday plans", "project update", etc.

BRAINDUMP DETECTION:
If the message mentions 3+ contacts or 2+ distinct interactions, classify as "braindump" regardless of other signals. Braindumps are long, messy, stream-of-consciousness messages.

SORT_CONTACT vs SORT_CONTACTS:
- sort_contact = ONE specific person being moved to a layer (has a name + optionally a target layer)
- sort_contacts = Batch/session request to organize multiple contacts (no specific name, or asking about unsorted contacts)

CONFIDENCE:
- high: Clear intent, unambiguous.
- medium: Likely correct but some ambiguity. Still dispatch normally.
- low: Genuinely ambiguous. Could be multiple intents. Triggers clarification.

Just a name with no context (e.g., "Sarah") is low confidence — could be query, sort, log, or something else.

Respond ONLY with valid JSON. No markdown, no backticks, no explanation.

{
  "intent": "...",
  "confidence": "high|medium|low",
  "contactNames": [],
  "circleName": null,
  "interactionMethod": null,
  "dateReference": null,
  "resolvedDate": null,
  "targetIntent": null,
  "extractedSummary": null,
  "classifierReasoning": "Brief explanation of why you chose this intent"
}`;

/**
 * Classify an inbound SMS message using Claude Haiku.
 *
 * This is the first step in every conversation turn. Fast and cheap —
 * Haiku handles this in ~200ms.
 *
 * @param message - The normalized inbound message
 * @param env     - Environment bindings (needs ANTHROPIC_API_KEY)
 * @param pendingContext - Any pending context from a previous turn
 * @returns Structured classification result
 */
export async function classifyMessage(
  message: NormalizedInboundMessage,
  env: Env,
  pendingContext?: PendingContext | null,
): Promise<ClassifiedMessage> {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const yesterday = new Date(now.getTime() - 86400000).toISOString().split('T')[0];

  // Build the system prompt with today's date injected
  const systemPrompt = CLASSIFIER_SYSTEM_PROMPT
    .replace('{{TODAY}}', today)
    .replace('{{YESTERDAY}}', yesterday);

  // If there's pending context, include it so Claude can interpret
  // follow-up messages like "yes" or "the first one"
  let userPrompt = message.body;
  if (pendingContext && !isContextExpired(pendingContext)) {
    userPrompt = `[CONTEXT: Previous turn was "${pendingContext.type}" for intent "${pendingContext.originalIntent}". Data: ${JSON.stringify(pendingContext.data)}]\n\nUser's reply: ${message.body}`;
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
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      console.error('[classifier] Claude API error:', response.status, await response.text());
      return fallbackClassification(message.body);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    // Parse the JSON response
    const parsed = JSON.parse(text) as Partial<ClassifiedMessage>;

    return {
      intent: validateIntent(parsed.intent),
      confidence: validateConfidence(parsed.confidence),
      contactNames: Array.isArray(parsed.contactNames) ? parsed.contactNames : [],
      circleName: parsed.circleName ?? null,
      interactionMethod: validateMethod(parsed.interactionMethod),
      dateReference: parsed.dateReference ?? null,
      resolvedDate: parsed.resolvedDate ?? null,
      targetIntent: validateTargetIntent(parsed.targetIntent),
      extractedSummary: parsed.extractedSummary ?? null,
      rawMessage: message.body,
      classifierReasoning: parsed.classifierReasoning ?? '',
    };
  } catch (err) {
    console.error('[classifier] Classification failed:', err);
    return fallbackClassification(message.body);
  }
}

// ===========================================================================
// Main Router
// ===========================================================================

/**
 * Route an established user's message to the appropriate handler.
 *
 * This is the main entry point called by sms.ts for users who have
 * completed onboarding. It:
 *   1. Checks for pending context (multi-turn state)
 *   2. Classifies the message intent
 *   3. Dispatches to the appropriate sub-handler
 *   4. Returns Bethany's response for sending via SendBlue
 *
 * @param message - The normalized inbound SMS message
 * @param user    - The authenticated user record
 * @param env     - Environment bindings
 * @param pendingContext - Any pending context from the previous turn
 * @returns Bethany's response to send back
 */
export async function routeConversation(
  message: NormalizedInboundMessage,
  user: UserRow,
  env: Env,
  pendingContext?: PendingContext | null,
): Promise<ConversationResponse> {
  // Check for intent_assignment context first — this takes priority
  if (pendingContext?.type === 'intent_assignment') {
    const { handleIntentResponse, PendingIntentAssignmentContext } = await import('./intent-assignment-flow');
    const intentContext = pendingContext.data as unknown as import('./intent-assignment-flow').PendingIntentAssignmentContext;
    
    const result = await handleIntentResponse(env, user, message.body, intentContext);
    
    // If sorted and there might be more, offer to continue
    if (result.sorted && result.pendingContext === null) {
      const { countUnsortedContacts, getNextUnsortedAndPrompt } = await import('./intent-assignment-flow');
      const remaining = await countUnsortedContacts(env.DB, user.id);
      
      if (remaining > 0) {
        const next = await getNextUnsortedAndPrompt(env, user);
        return {
          reply: result.reply + `\n\n${remaining} more to go. ${next.reply}`,
          expectsReply: true,
          pendingContext: next.pendingContext ? {
            type: 'intent_assignment',
            originalIntent: 'sort_contacts',
            data: next.pendingContext as unknown as Record<string, unknown>,
            createdAt: new Date().toISOString(),
          } : undefined,
        };
      }
    }
    
    // Convert to ConversationResponse
    return {
      reply: result.reply,
      expectsReply: result.expectsReply,
      pendingContext: result.pendingContext ? {
        type: 'intent_assignment',
        originalIntent: 'sort_contacts',
        data: result.pendingContext as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      } : undefined,
    };
  }

  // Handle duplicate confirmation context
  if (pendingContext?.type === 'confirm_duplicate') {
    return await handleDuplicateConfirmation(message, user, env, pendingContext);
  }

  // Step 1: Classify the message
  const classified = await classifyMessage(message, env, pendingContext);

  console.log(
    `[router] User: ${user.name} | Intent: ${classified.intent} ` +
    `(${classified.confidence}) | Contacts: [${classified.contactNames.join(', ')}] | ` +
    `Reasoning: ${classified.classifierReasoning}`,
  );

  // Step 2: Handle low-confidence classifications with clarification
  if (classified.confidence === 'low') {
    return handleAmbiguous(classified, user);
  }

  // Step 3: Dispatch to the appropriate handler
  const handler = getHandler(classified.intent);
  try {
    return await handler(classified, user, env);
  } catch (err) {
    console.error(`[router] Handler error for ${classified.intent}:`, err);
    return {
      reply: "Hmm, something went wrong on my end trying to process that. Mind trying again?",
      expectsReply: true,
    };
  }
}

// ===========================================================================
// Handler Registry
// ===========================================================================

/**
 * Get the sub-handler for a given intent.
 */
function getHandler(intent: ConversationIntent): SubHandler {
  switch (intent) {
    case 'query_contact':
      return handleQueryContact;
    case 'log_interaction':
      return handleLogInteraction;
    case 'get_suggestions':
      return handleGetSuggestions;
    case 'manage_circles':
      return handleManageCircles;
    case 'sort_contact':
      return handleSortContact;
    case 'sort_contacts':
      return handleSortContacts;
    case 'add_contact':
      return handleAddContact;
    case 'braindump':
      return handleBraindump;
    case 'check_health':
      return handleCheckHealth;
    case 'google_contacts':
      return handleGoogleContacts;
    case 'small_talk':
      return handleSmallTalk;
    case 'help':
      return handleHelp;
    case 'unknown':
    default:
      return handleUnknown;
  }
}

// ===========================================================================
// Ambiguous Message Handler
// ===========================================================================

/**
 * Handle low-confidence classifications by asking for clarification.
 */
function handleAmbiguous(
  classified: ClassifiedMessage,
  user: UserRow,
): ConversationResponse {
  const names = classified.contactNames;

  if (names.length === 1 && classified.rawMessage.trim().split(/\s+/).length <= 3) {
    return {
      reply: `What about ${names[0]}? I can look them up, log that you connected, move them to a different circle, or something else — just let me know!`,
      expectsReply: true,
      pendingContext: {
        type: 'clarify_intent',
        originalIntent: classified.intent,
        data: { contactNames: names, rawMessage: classified.rawMessage },
        createdAt: new Date().toISOString(),
      },
    };
  }

  return {
    reply: "I'm not quite sure what you're asking me to do. Could you give me a bit more detail? For example: \"I called Mom yesterday\" or \"How's my relationship with Jake?\"",
    expectsReply: true,
    pendingContext: {
      type: 'clarify_intent',
      originalIntent: 'unknown',
      data: { rawMessage: classified.rawMessage },
      createdAt: new Date().toISOString(),
    },
  };
}

// ===========================================================================
// Sub-Handlers
// ===========================================================================

const handleQueryContact: SubHandler = async (classified, user, env) => {
  if (classified.contactNames.length === 0) {
    return {
      reply: "Who are you asking about? Give me a name and I'll look them up.",
      expectsReply: true,
    };
  }

  const { searchContacts } = await import('./contact-service');
  const name = classified.contactNames[0];
  const matches = await searchContacts(env.DB, user.id, name, 5);

  if (matches.length === 0) {
    return {
      reply: `I don't have anyone named "${name}" in your network. Want to add them?`,
      expectsReply: true,
      pendingContext: {
        type: 'confirm_action',
        originalIntent: 'add_contact',
        data: { contactName: name },
        createdAt: new Date().toISOString(),
      },
    };
  }

  if (matches.length === 1) {
    const contact = matches[0];
    const healthEmoji = contact.health_status === 'green' ? '🟢' : contact.health_status === 'yellow' ? '🟡' : '🔴';
    const circles = contact.circles.map((c) => c.name).join(', ') || 'no circles';
    const lastContact = contact.last_contact_date
      ? formatRelativeDate(contact.last_contact_date)
      : 'never';

    return {
      reply: `${contact.name} ${healthEmoji}\nLayer: ${formatIntentLabel(contact.intent)}\nCircles: ${circles}\nLast contact: ${lastContact}`,
      expectsReply: false,
    };
  }

  const nameList = matches.map((c, i) => `${i + 1}. ${c.name} (${formatIntentLabel(c.intent)})`).join('\n');
  return {
    reply: `I found a few people matching "${name}":\n${nameList}\n\nWhich one?`,
    expectsReply: true,
    pendingContext: {
      type: 'select_contact',
      originalIntent: 'query_contact',
      data: { matches: matches.map((c) => ({ id: c.id, name: c.name })) },
      createdAt: new Date().toISOString(),
    },
  };
};

const handleLogInteraction: SubHandler = async (classified, user, env) => {
  if (classified.contactNames.length === 0) {
    return {
      reply: "Got it — who did you connect with?",
      expectsReply: true,
      pendingContext: {
        type: 'clarify_intent',
        originalIntent: 'log_interaction',
        data: {
          method: classified.interactionMethod,
          dateReference: classified.dateReference,
          summary: classified.extractedSummary,
        },
        createdAt: new Date().toISOString(),
      },
    };
  }

  const { searchContacts } = await import('./contact-service');
  const { logInteraction } = await import('./interaction-service');
  const name = classified.contactNames[0];
  const matches = await searchContacts(env.DB, user.id, name, 3);

  if (matches.length === 0) {
    return {
      reply: `I don't have a "${name}" in your network. Want me to add them and log this interaction?`,
      expectsReply: true,
      pendingContext: {
        type: 'confirm_action',
        originalIntent: 'log_interaction',
        data: {
          contactName: name,
          method: classified.interactionMethod,
          dateReference: classified.dateReference,
          resolvedDate: classified.resolvedDate,
          summary: classified.extractedSummary,
        },
        createdAt: new Date().toISOString(),
      },
    };
  }

  const contact = matches[0];
  const method = classified.interactionMethod ?? 'other';
  const date = classified.resolvedDate ?? new Date().toISOString();

  const interaction = await logInteraction(env.DB, user.id, {
    contact_id: contact.id,
    method,
    date,
    summary: classified.extractedSummary ?? undefined,
    logged_via: 'sms',
  });

  if (!interaction) {
    return {
      reply: "Hmm, I couldn't log that interaction. Mind trying again?",
      expectsReply: true,
    };
  }

  const methodLabel = formatMethodLabel(method);
  const dateLabel = classified.dateReference ?? 'today';
  return {
    reply: `Logged! ${methodLabel} with ${contact.name} (${dateLabel}). ${contact.health_status === 'red' ? "That was overdue — good on you for reaching out!" : contact.health_status === 'yellow' ? 'Good timing — they were starting to slip.' : 'Looking good!'}`,
    expectsReply: false,
  };
};

const handleGetSuggestions: SubHandler = async (classified, user, env) => {
  const { listContacts } = await import('./contact-service');

  const redResult = await listContacts(env.DB, user.id, { health_status: 'red' }, { limit: 3, orderBy: 'last_contact_date', orderDir: 'asc' });
  const yellowResult = await listContacts(env.DB, user.id, { health_status: 'yellow' }, { limit: 3, orderBy: 'last_contact_date', orderDir: 'asc' });

  const reds = redResult.contacts;
  const yellows = yellowResult.contacts;

  if (reds.length === 0 && yellows.length === 0) {
    return {
      reply: "Your network is looking great right now — everyone's in the green! Keep it up.",
      expectsReply: false,
    };
  }

  let reply = '';

  if (reds.length > 0) {
    const redList = reds.map((c) => {
      const last = c.last_contact_date ? formatRelativeDate(c.last_contact_date) : 'never';
      return `🔴 ${c.name} — last contact: ${last}`;
    }).join('\n');
    reply += `Overdue:\n${redList}\n\n`;
  }

  if (yellows.length > 0) {
    const yellowList = yellows.map((c) => {
      const last = c.last_contact_date ? formatRelativeDate(c.last_contact_date) : 'never';
      return `🟡 ${c.name} — last contact: ${last}`;
    }).join('\n');
    reply += `Slipping:\n${yellowList}`;
  }

  reply += '\n\nWant me to help you reach out to any of them?';
  return { reply: reply.trim(), expectsReply: true };
};

const handleManageCircles: SubHandler = async (classified, user, env) => {
  const { listCirclesWithCounts } = await import('./circle-service');
  const circles = await listCirclesWithCounts(env.DB, user.id);

  if (circles.length === 0) {
    return {
      reply: "You don't have any circles set up yet. That's unusual — let me know if you'd like me to create the defaults (Family, Friends, Work, Community).",
      expectsReply: true,
    };
  }

  const circleList = circles.map((c) =>
    `${c.name} (${c.contact_count} contact${c.contact_count === 1 ? '' : 's'})`
  ).join('\n');

  return {
    reply: `Your circles:\n${circleList}\n\nYou can tell me to add someone to a circle, create a new one, or see who's in a specific circle.`,
    expectsReply: true,
  };
};

const handleSortContact: SubHandler = async (classified, user, env) => {
  if (classified.contactNames.length === 0) {
    return {
      reply: "Who do you want to move? Give me a name and which layer — like \"Move Sarah to nurture.\"",
      expectsReply: true,
    };
  }

  if (!classified.targetIntent) {
    const { searchContacts } = await import('./contact-service');
    const { startIntentAssignment } = await import('./intent-assignment-flow');
    
    const name = classified.contactNames[0];
    const matches = await searchContacts(env.DB, user.id, name, 3);
    
    if (matches.length === 0) {
      return {
        reply: `I don't have anyone named "${name}" in your network. Want to add them?`,
        expectsReply: true,
      };
    }
    
    const result = await startIntentAssignment(env, user, matches[0].id);
    return {
      reply: result.reply,
      expectsReply: result.expectsReply,
      pendingContext: result.pendingContext ? {
        type: 'intent_assignment',
        originalIntent: 'sort_contact',
        data: result.pendingContext as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      } : undefined,
    };
  }

  const { searchContacts, updateContact } = await import('./contact-service');
  const name = classified.contactNames[0];
  const matches = await searchContacts(env.DB, user.id, name, 3);

  if (matches.length === 0) {
    return {
      reply: `I don't have anyone named "${name}" in your network. Want to add them?`,
      expectsReply: true,
    };
  }

  const contact = matches[0];
  const updated = await updateContact(env.DB, user.id, contact.id, {
    intent: classified.targetIntent,
  });

  if (!updated) {
    return {
      reply: "Something went wrong trying to update that contact. Mind trying again?",
      expectsReply: true,
    };
  }

  const { INTENT_CONFIGS } = await import('../../shared/intent-config');
  const config = INTENT_CONFIGS[classified.targetIntent];

  return {
    reply: `Done! Moved ${contact.name} to ${config.label}.${config.defaultCadenceDays ? ` I'll nudge you to reach out every ${config.defaultCadenceDays} days.` : ''}`,
    expectsReply: false,
  };
};

const handleSortContacts: SubHandler = async (classified, user, env) => {
  const { startSortingSession, countUnsortedContacts } = await import('./intent-assignment-flow');
  
  const count = await countUnsortedContacts(env.DB, user.id);
  
  if (count === 0) {
    return {
      reply: "All your contacts are sorted! Everyone has a relationship layer assigned. 🎉",
      expectsReply: false,
    };
  }
  
  const session = await startSortingSession(env, user);
  
  return {
    reply: session.openingMessage,
    expectsReply: true,
    pendingContext: session.pendingContext ? {
      type: 'intent_assignment',
      originalIntent: 'sort_contacts',
      data: session.pendingContext as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    } : undefined,
  };
};

/**
 * add_contact — Add a new person to the network.
 *
 * BUG FIX (2026-02-10): Three issues were fixed:
 *   1. checkSubscriptionStatus was called with (db, userId, env) but expects (db, userRow, now?)
 *   2. Checked non-existent `canAddContact` property on SubscriptionStatus
 *   3. No error handling around createContact — Bethany could claim success without DB write
 *
 * FEATURE (2026-02-11): Added duplicate detection
 *   - Checks for potential duplicates using fuzzy name matching before creating
 *   - Uses Levenshtein distance + nickname mappings (200+ common nicknames)
 *   - Asks user to confirm if a close match is found
 */
const handleAddContact: SubHandler = async (classified, user, env) => {
  if (classified.contactNames.length === 0) {
    return {
      reply: "Sure, who do you want to add? Give me their name.",
      expectsReply: true,
      pendingContext: {
        type: 'clarify_intent',
        originalIntent: 'add_contact',
        data: {},
        createdAt: new Date().toISOString(),
      },
    };
  }

  const { createContact, findPotentialDuplicates } = await import('./contact-service');
  const { checkSubscriptionStatus } = await import('./subscription-service');

  // Check subscription — pass the full user object, not just the ID
  const subStatus = await checkSubscriptionStatus(env.DB, user);

  // Free tier users cannot add new contacts
  if (subStatus.tier === 'free') {
    return {
      reply: "Adding new contacts is a premium feature. Your existing contacts are still here — nothing's going anywhere. Upgrade to keep growing your network!",
      expectsReply: false,
    };
  }

  const name = classified.contactNames[0];

  // Check for potential duplicates before creating
  const duplicates = await findPotentialDuplicates(env.DB, user.id, name);
  
  if (duplicates.length > 0) {
    // Found potential duplicates — ask user to confirm
    const topMatch = duplicates[0];
    const matchList = duplicates.slice(0, 3).map((d, i) => 
      `${i + 1}. ${d.existingName} (${Math.round(d.similarity * 100)}% match${d.matchReason === 'nickname' ? ', nickname' : ''})`
    ).join('\n');
    
    return {
      reply: `I found someone similar in your network:\n${matchList}\n\nIs "${name}" the same person as one of these, or someone new?\n\nReply with the number if it's a match, or "new" to add them as a new contact.`,
      expectsReply: true,
      pendingContext: {
        type: 'confirm_duplicate',
        originalIntent: 'add_contact',
        data: {
          newName: name,
          duplicates: duplicates.slice(0, 3).map(d => ({
            id: d.existingContactId,
            name: d.existingName,
            similarity: d.similarity,
          })),
        },
        createdAt: new Date().toISOString(),
      },
    };
  }

  // No duplicates found — create the contact
  try {
    const contact = await createContact(env.DB, user.id, {
      name,
      source: 'sms',
    });

    // Verify the contact was actually created and returned
    if (!contact || !contact.id) {
      console.error('[add_contact] createContact returned null/empty for:', name);
      return {
        reply: `I tried to add ${name} but something went wrong with the save. Mind trying again?`,
        expectsReply: true,
      };
    }

    console.log(`[add_contact] Successfully created contact: ${contact.id} (${contact.name}) for user ${user.id}`);

    // Immediately start intent assignment for the new contact
    const { startIntentAssignment } = await import('./intent-assignment-flow');
    const result = await startIntentAssignment(env, user, contact.id);

    return {
      reply: `Added ${contact.name} to your network!\n\n${result.reply}`,
      expectsReply: result.expectsReply,
      pendingContext: result.pendingContext ? {
        type: 'intent_assignment',
        originalIntent: 'add_contact',
        data: result.pendingContext as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      } : undefined,
    };
  } catch (err) {
    console.error('[add_contact] Failed to create contact:', err);
    return {
      reply: `Something went wrong trying to add ${name}. Mind trying again?`,
      expectsReply: true,
    };
  }
};

const handleBraindump: SubHandler = async (classified, user, env) => {
  const contactCount = classified.contactNames.length;
  return {
    reply: `Got it — I caught ${contactCount} name${contactCount === 1 ? '' : 's'} in there. Let me process this and I'll confirm what I logged. Give me a moment!`,
    expectsReply: false,
  };
};

/**
 * check_health — Show a network health summary.
 *
 * Also handles "how many contacts do I have", "list my contacts",
 * "who's in my network", etc.
 */
const handleCheckHealth: SubHandler = async (classified, user, env) => {
  const { getHealthCounts, getContactCount } = await import('./contact-service');
  const { getInteractionStats } = await import('./interaction-service');
  const { countUnsortedContacts } = await import('./intent-assignment-flow');

  const [healthCounts, totalContacts, stats, unsortedCount] = await Promise.all([
    getHealthCounts(env.DB, user.id),
    getContactCount(env.DB, user.id),
    getInteractionStats(env.DB, user.id, 7),
    countUnsortedContacts(env.DB, user.id),
  ]);

  if (totalContacts === 0) {
    return {
      reply: "You don't have any contacts yet! Start by telling me about the people in your life — try \"Add Sarah Chen\" or just brain-dump everyone you want to keep up with.",
      expectsReply: true,
    };
  }

  let reply = `Network snapshot (${totalContacts} contact${totalContacts === 1 ? '' : 's'}):\n`;
  reply += `🟢 ${healthCounts.green} on track\n`;
  reply += `🟡 ${healthCounts.yellow} slipping\n`;
  reply += `🔴 ${healthCounts.red} overdue\n\n`;
  reply += `This week: ${stats.totalThisPeriod} interaction${stats.totalThisPeriod === 1 ? '' : 's'} with ${stats.uniqueContacts} contact${stats.uniqueContacts === 1 ? '' : 's'}`;

  if (stats.mostActiveContact) {
    reply += `\nMost active: ${stats.mostActiveContact.name} (${stats.mostActiveContact.count}x)`;
  }

  if (unsortedCount > 0) {
    reply += `\n\n📋 ${unsortedCount} contact${unsortedCount === 1 ? '' : 's'} need sorting. Say "sort my contacts" to assign layers.`;
  }

  if (healthCounts.red > 0) {
    reply += '\n\nWant to see who needs attention?';
  }

  return { reply, expectsReply: healthCounts.red > 0 || unsortedCount > 0 };
};

const handleSmallTalk: SubHandler = async (classified, user) => {
  const msg = classified.rawMessage.toLowerCase().trim();

  if (/^(hey|hi|hello|morning|good morning|evening|yo|sup|what's up)/i.test(msg)) {
    const hour = new Date().getUTCHours() - 5;
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return {
      reply: `${greeting}, ${user.name}! What can I help you with today?`,
      expectsReply: true,
    };
  }

  if (/^(thanks|thank you|thx|ty|appreciate)/i.test(msg)) {
    return {
      reply: "You got it! Let me know if you need anything else.",
      expectsReply: false,
    };
  }

  return {
    reply: `Ha, love it. Anything I can help you with, ${user.name}?`,
    expectsReply: true,
  };
};

// ===========================================================================
// Google Contacts Handler
// ===========================================================================

const handleGoogleContacts: SubHandler = async (classified, user, env) => {
  const lowerMessage = classified.rawMessage.toLowerCase();
  
  // Check if they want to disconnect
  if (/disconnect|unlink|remove google|stop sync/i.test(lowerMessage)) {
    const { handleDisconnect } = await import('./google-contacts-flow');
    const result = await handleDisconnect(env, user);
    return {
      reply: result.reply,
      expectsReply: result.expectsReply,
    };
  }
  
  // Check if they want to sync/re-sync
  if (/sync|refresh|update|pull/i.test(lowerMessage)) {
    const { handleResync, getConnectionStatus } = await import('./google-contacts-flow');
    const { getConnectionStatus: checkStatus } = await import('./google-oauth-service');
    
    const status = await checkStatus(env.DB, user.id);
    
    if (!status.connected) {
      // Not connected yet — offer to connect
      const { offerGoogleConnect } = await import('./google-contacts-flow');
      const result = await offerGoogleConnect(env, user);
      return {
        reply: result.reply,
        expectsReply: result.expectsReply,
      };
    }
    
    // Already connected — do a resync
    const result = await handleResync(env, user);
    return {
      reply: result.reply,
      expectsReply: result.expectsReply,
    };
  }
  
  // Default: offer to connect (or show status if already connected)
  const { offerGoogleConnect } = await import('./google-contacts-flow');
  const result = await offerGoogleConnect(env, user);
  return {
    reply: result.reply,
    expectsReply: result.expectsReply,
  };
};

const handleHelp: SubHandler = async () => {
  return {
    reply: `Here's what I can help with:\n\n` +
      `📋 "How's Sarah?" — look up a contact\n` +
      `✏️ "Called Mom yesterday" — log an interaction\n` +
      `💡 "Who should I reach out to?" — get suggestions\n` +
      `📊 "How's my network?" — health summary\n` +
      `🏷️ "Move Jake to inner circle" — change someone's layer\n` +
      `📝 "Sort my contacts" — organize unsorted contacts\n` +
      `➕ "Add Sarah Chen" — new contact\n` +
      `⭕ "Show my circles" — manage circles\n` +
      `📱 "Import my contacts" — connect Google Contacts\n\n` +
      `Or just brain-dump everything — "This week I called Mom, saw Jake at lunch, texted Sarah..." and I'll sort it out.`,
    expectsReply: false,
  };
};

const handleUnknown: SubHandler = async (classified, user) => {
  return {
    reply: `I'm not sure what to do with that one. You can tell me about someone you connected with, ask who needs attention, or type "help" to see what I can do.`,
    expectsReply: true,
  };
};

// ===========================================================================
// Duplicate Confirmation Handler
// ===========================================================================

/**
 * Handle user's response to duplicate contact confirmation.
 *
 * User can reply with:
 *   - A number (1, 2, 3) to select an existing contact
 *   - "new" / "add" / "different" to add as new contact anyway
 *   - "cancel" / "nevermind" to abort
 */
async function handleDuplicateConfirmation(
  message: NormalizedInboundMessage,
  user: UserRow,
  env: Env,
  pendingContext: PendingContext,
): Promise<ConversationResponse> {
  const { createContact } = await import('./contact-service');
  const { startIntentAssignment } = await import('./intent-assignment-flow');

  const data = pendingContext.data as {
    newName: string;
    duplicates: Array<{ id: string; name: string; similarity: number }>;
  };

  const reply = message.body.toLowerCase().trim();

  // Check for cancel
  if (/^(cancel|nevermind|never mind|nvm|forget it|stop)$/i.test(reply)) {
    return {
      reply: "No problem, cancelled. Let me know if you need anything else!",
      expectsReply: false,
    };
  }

  // Check for "new" / "add anyway"
  if (/^(new|add|different|no|nope|someone else|add anyway|new person|new contact)$/i.test(reply)) {
    // User confirmed this is a new person — create the contact
    try {
      const contact = await createContact(env.DB, user.id, {
        name: data.newName,
        source: 'sms',
      });

      if (!contact || !contact.id) {
        return {
          reply: `I tried to add ${data.newName} but something went wrong. Mind trying again?`,
          expectsReply: true,
        };
      }

      console.log(`[add_contact] Created new contact after duplicate check: ${contact.id} (${contact.name})`);

      // Start intent assignment
      const result = await startIntentAssignment(env, user, contact.id);

      return {
        reply: `Added ${contact.name} to your network!\n\n${result.reply}`,
        expectsReply: result.expectsReply,
        pendingContext: result.pendingContext ? {
          type: 'intent_assignment',
          originalIntent: 'add_contact',
          data: result.pendingContext as unknown as Record<string, unknown>,
          createdAt: new Date().toISOString(),
        } : undefined,
      };
    } catch (err) {
      console.error('[add_contact] Failed to create contact after duplicate check:', err);
      return {
        reply: `Something went wrong trying to add ${data.newName}. Mind trying again?`,
        expectsReply: true,
      };
    }
  }

  // Check for number selection (1, 2, 3)
  const numMatch = reply.match(/^(\d+)$/);
  if (numMatch) {
    const index = parseInt(numMatch[1], 10) - 1;
    if (index >= 0 && index < data.duplicates.length) {
      const selected = data.duplicates[index];
      return {
        reply: `Got it — "${data.newName}" is the same as ${selected.name}. I won't add a duplicate. Want me to look up ${selected.name} for you?`,
        expectsReply: true,
        pendingContext: {
          type: 'confirm_action',
          originalIntent: 'query_contact',
          data: { contactId: selected.id, contactName: selected.name },
          createdAt: new Date().toISOString(),
        },
      };
    }
  }

  // Check if they mentioned one of the existing names
  for (let i = 0; i < data.duplicates.length; i++) {
    const dup = data.duplicates[i];
    if (reply.includes(dup.name.toLowerCase())) {
      return {
        reply: `Got it — "${data.newName}" is the same as ${dup.name}. I won't add a duplicate. Want me to look up ${dup.name} for you?`,
        expectsReply: true,
        pendingContext: {
          type: 'confirm_action',
          originalIntent: 'query_contact',
          data: { contactId: dup.id, contactName: dup.name },
          createdAt: new Date().toISOString(),
        },
      };
    }
  }

  // Didn't understand — ask again
  return {
    reply: `I didn't catch that. Reply with a number (1-${data.duplicates.length}) if "${data.newName}" is the same as one of the matches I found, or say "new" to add them as a new contact.`,
    expectsReply: true,
    pendingContext: pendingContext, // Keep the same context
  };
}

// ===========================================================================
// Utility Functions
// ===========================================================================

function fallbackClassification(body: string): ClassifiedMessage {
  const lower = body.toLowerCase().trim();

  let intent: ConversationIntent = 'unknown';
  const confidence: 'high' | 'medium' | 'low' = 'medium';

  if (/^(help|commands|what can you do|how does this work)/i.test(lower)) {
    intent = 'help';
  } else if (/^(hey|hi|hello|morning|thanks|thank you|thx)/i.test(lower)) {
    intent = 'small_talk';
  } else if (/how many contacts|list.*contacts|who('s| is| are) (in )?my (network|contacts)|do i have.*contacts|show.*contacts|status|summary|dashboard|health|how('s| is) my network/i.test(lower)) {
    intent = 'check_health';
  } else if (/who should i|who needs|suggest|anyone i/i.test(lower)) {
    intent = 'get_suggestions';
  } else if (/sort my|organize|unsorted/i.test(lower)) {
    intent = 'sort_contacts';
  } else if (/^add\s/i.test(lower)) {
    intent = 'add_contact';
  } else if (/google|import.*contacts|sync.*contacts|connect.*contacts|pull.*contacts/i.test(lower)) {
    intent = 'google_contacts';
  }

  return {
    intent,
    confidence,
    contactNames: [],
    circleName: null,
    interactionMethod: null,
    dateReference: null,
    resolvedDate: null,
    targetIntent: null,
    extractedSummary: null,
    rawMessage: body,
    classifierReasoning: 'Fallback keyword matching (Claude unavailable)',
  };
}

function isContextExpired(ctx: PendingContext): boolean {
  const created = new Date(ctx.createdAt).getTime();
  const now = Date.now();
  return now - created > 5 * 60 * 1000;
}

function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return 'last week';
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 60) return 'last month';
  return `${Math.floor(diffDays / 30)} months ago`;
}

function formatIntentLabel(intent: string): string {
  const labels: Record<string, string> = {
    inner_circle: 'Inner Circle',
    nurture: 'Nurture',
    maintain: 'Maintain',
    transactional: 'Transactional',
    dormant: 'Dormant',
    new: 'New',
  };
  return labels[intent] ?? intent;
}

function formatMethodLabel(method: InteractionMethod): string {
  const labels: Record<InteractionMethod, string> = {
    text: 'Text',
    call: 'Call',
    in_person: 'Hangout',
    email: 'Email',
    social: 'Social',
    other: 'Connection',
  };
  return labels[method] ?? method;
}

// ===========================================================================
// Validators
// ===========================================================================

const VALID_INTENTS: ConversationIntent[] = [
  'query_contact', 'log_interaction', 'get_suggestions', 'manage_circles',
  'sort_contact', 'sort_contacts', 'add_contact', 'braindump', 'check_health',
  'google_contacts', 'small_talk', 'help', 'unknown',
];

function validateIntent(raw: unknown): ConversationIntent {
  if (typeof raw === 'string' && VALID_INTENTS.includes(raw as ConversationIntent)) {
    return raw as ConversationIntent;
  }
  return 'unknown';
}

function validateConfidence(raw: unknown): 'high' | 'medium' | 'low' {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return 'medium';
}

const VALID_METHODS: InteractionMethod[] = ['text', 'call', 'in_person', 'email', 'social', 'other'];

function validateMethod(raw: unknown): InteractionMethod | null {
  if (typeof raw === 'string' && VALID_METHODS.includes(raw as InteractionMethod)) {
    return raw as InteractionMethod;
  }
  return null;
}

const VALID_INTENTS_TARGET: IntentType[] = ['inner_circle', 'nurture', 'maintain', 'transactional', 'dormant', 'new'];

function validateTargetIntent(raw: unknown): IntentType | null {
  if (typeof raw === 'string' && VALID_INTENTS_TARGET.includes(raw as IntentType)) {
    return raw as IntentType;
  }
  return null;
}
