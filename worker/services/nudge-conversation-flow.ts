/**
 * Proactive Nudge Conversation Flow — Weekly/Daily Relationship Check-ins
 *
 * This is Bethany's main proactive outreach. She surfaces contacts that need
 * attention and offers to help the user draft messages or reach out.
 *
 * TWO MODES:
 *
 *   1. Premium Daily Nudge (triggered by cron or smart timing)
 *      - Personalized morning message with 3-5 contacts
 *      - Context-aware: references notes, life events, last interaction
 *      - Warm, low-pressure — "no pressure" is explicit in the message
 *      - Waits for user response → hands off to message drafting
 *
 *   2. Free Tier Weekly Digest (Monday mornings)
 *      - Consolidated list of top 3 contacts needing attention
 *      - Less personalized but still actionable
 *      - Same response handling for follow-up
 *
 * CONVERSATION FLOW:
 *
 *   [Bethany sends proactive nudge]
 *   ↓
 *   User responds: "Draft something for Marcus"
 *   ↓
 *   Bethany generates draft, sends with deep link
 *   ↓
 *   User taps link → pre-filled message opens in Messages app
 *
 * STATE MANAGEMENT:
 *
 *   When Bethany sends a nudge, she stores pending context in the user's
 *   session (via Durable Object or R2). The next inbound message is
 *   interpreted in this context:
 *
 *   - "Marcus" or "the first one" → resolve to contact, offer draft
 *   - "Thanks" or "not now" → acknowledge, dismiss nudge
 *   - "Yes" or "all of them" → offer to draft for each contact
 *   - Unrelated message → route normally (nudge context expires after 15 min)
 *
 * BETHANY'S VOICE:
 *
 *   The nudge should feel like a helpful friend, not a nagging reminder:
 *   - "I was going through your contacts..."
 *   - "No pressure, just a few suggestions..."
 *   - References specific context (job stress, family event, past favor)
 *   - Offers concrete help: "Want me to draft something?"
 *
 * @see worker/services/nudge-service.ts for nudge generation
 * @see worker/services/conversation-router.ts for routing integration
 * @see worker/cron/scheduled.ts for cron triggers
 */

import type { Env } from '../../shared/types';
import type { UserRow, ContactRow, IntentType } from '../../shared/models';
import type { ContactNeedingAttention } from './nudge-service';
import { getContactsNeedingAttention } from './nudge-service';
import { INTENT_CONFIGS } from '../../shared/intent-config';
import { generateSmsLink } from '../utils/deep-links';

// ===========================================================================
// Types
// ===========================================================================

/**
 * A contact formatted for the nudge conversation.
 */
export interface NudgeContact {
  contactId: string;
  name: string;
  intent: IntentType;
  intentLabel: string;
  daysOverdue: number;
  contextSnippet: string | null;  // From notes, last interaction, etc.
  phone: string | null;
}

/**
 * Generated nudge message with metadata.
 */
export interface ProactiveNudgeMessage {
  message: string;
  contacts: NudgeContact[];
  isWeeklyDigest: boolean;
}

/**
 * Pending nudge context — stored in user session for follow-up handling.
 */
export interface PendingNudgeContext {
  type: 'proactive_nudge';
  contacts: NudgeContact[];
  sentAt: string;
  isWeeklyDigest: boolean;
}

/**
 * User's response to a nudge — what they want to do.
 */
export type NudgeResponseIntent =
  | { action: 'draft_for_contact'; contactIndex: number; contact: NudgeContact }
  | { action: 'draft_for_all' }
  | { action: 'dismiss' }
  | { action: 'unclear' };

// ===========================================================================
// Nudge Generation
// ===========================================================================

/**
 * Generate a proactive nudge message for a user.
 *
 * Pulls contacts needing attention, enriches them with context,
 * and generates Bethany's warm, low-pressure message.
 *
 * @param env        - Worker environment bindings
 * @param user       - The user to generate the nudge for
 * @param isWeekly   - Whether this is a weekly digest (free tier)
 * @param maxContacts - Maximum contacts to include (default: 5 for daily, 3 for weekly)
 * @param now        - Override current time (for testing)
 */
export async function generateProactiveNudge(
  env: Env,
  user: UserRow,
  isWeekly: boolean = false,
  maxContacts?: number,
  now?: Date,
): Promise<ProactiveNudgeMessage | null> {
  const currentTime = now ?? new Date();
  const limit = maxContacts ?? (isWeekly ? 3 : 5);

  // Get contacts needing attention
  const contactsNeedingAttention = await getContactsNeedingAttention(
    env.DB,
    user.id,
    limit,
    currentTime,
  );

  if (contactsNeedingAttention.length === 0) {
    return null; // No nudge needed — everyone's in the green!
  }

  // Enrich with context snippets
  const nudgeContacts = await enrichContactsWithContext(
    env,
    user.id,
    contactsNeedingAttention,
  );

  // Generate the message
  const message = await generateNudgeMessage(
    env,
    user,
    nudgeContacts,
    isWeekly,
    currentTime,
  );

  return {
    message,
    contacts: nudgeContacts,
    isWeeklyDigest: isWeekly,
  };
}

/**
 * Enrich contacts with context snippets from notes and interactions.
 */
async function enrichContactsWithContext(
  env: Env,
  userId: string,
  contacts: ContactNeedingAttention[],
): Promise<NudgeContact[]> {
  const enriched: NudgeContact[] = [];

  for (const contact of contacts) {
    // Get the most recent interaction summary if available
    let contextSnippet: string | null = null;

    if (contact.notes) {
      // Use notes as primary context
      contextSnippet = truncateContext(contact.notes);
    } else {
      // Fall back to last interaction summary
      const lastInteraction = await env.DB
        .prepare(
          `SELECT summary FROM interactions
           WHERE contact_id = ? AND summary IS NOT NULL
           ORDER BY date DESC LIMIT 1`
        )
        .bind(contact.contactId)
        .first<{ summary: string }>();

      if (lastInteraction?.summary) {
        contextSnippet = truncateContext(lastInteraction.summary);
      }
    }

    const config = INTENT_CONFIGS[contact.intent];

    enriched.push({
      contactId: contact.contactId,
      name: contact.contactName,
      intent: contact.intent,
      intentLabel: config?.label ?? contact.intent,
      daysOverdue: contact.daysOverdue,
      contextSnippet,
      phone: contact.phone,
    });
  }

  return enriched;
}

/**
 * Truncate context to a reasonable snippet length.
 */
function truncateContext(text: string, maxLength: number = 60): string {
  if (text.length <= maxLength) return text;

  // Try to cut at a word boundary
  const truncated = text.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxLength * 0.7) {
    return truncated.substring(0, lastSpace) + '...';
  }
  return truncated + '...';
}

/**
 * Generate Bethany's nudge message using Claude.
 *
 * The message should be:
 * - Warm and friendly, not nagging
 * - Reference specific context about each contact
 * - Format contacts with their intent layer
 * - End with "Want me to draft something for any of them?"
 */
async function generateNudgeMessage(
  env: Env,
  user: UserRow,
  contacts: NudgeContact[],
  isWeekly: boolean,
  now: Date,
): Promise<string> {
  // Build contact descriptions for the prompt
  const contactDescriptions = contacts.map((c, i) => {
    let desc = `${i + 1}. ${c.name} (${c.intentLabel})`;
    if (c.daysOverdue > 0) {
      desc += ` — ${c.daysOverdue} days overdue`;
    }
    if (c.contextSnippet) {
      desc += ` — Context: "${c.contextSnippet}"`;
    }
    return desc;
  }).join('\n');

  const timeGreeting = getTimeGreeting(now);

  const systemPrompt = `You are Bethany — a warm, sharp romance novelist who helps people maintain their relationships. You're sending a proactive nudge to ${user.name} about contacts that need attention.

CONTACTS NEEDING ATTENTION:
${contactDescriptions}

YOUR TASK:
Generate a friendly, low-pressure SMS nudge. The message should:
1. Start with a casual greeting (like "${timeGreeting}!")
2. Mention you were "going through their contacts" or similar
3. List each contact on its own line with a dash
4. For each contact, include:
   - Their name and intent layer in parentheses
   - How long it's been (if overdue)
   - The context snippet rewritten naturally (if available)
5. End with offering to help draft a message

CRITICAL RULES:
- Keep it SHORT — this is SMS. Under 500 characters total if possible.
- NO emojis except one at the start of the greeting if appropriate
- Sound like a real friend, not an assistant
- Say "no pressure" somewhere — make it feel optional
- Use fragments and casual language — "been a while", not "it has been some time"
- Each contact should be a single line with a dash
- The offer to draft should be a question: "Want me to draft something for any of them?"

${isWeekly ? 'This is a WEEKLY DIGEST for a free tier user — keep it simpler and more consolidated.' : 'This is a personalized daily nudge for a premium user — include more context.'}

Respond ONLY with the message text. No explanation, no metadata.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Generate the nudge message.' }],
      }),
    });

    if (!response.ok) {
      console.error('[nudge-flow] Claude API error:', response.status);
      return generateFallbackNudgeMessage(user.name, contacts, isWeekly, now);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content.find(b => b.type === 'text')?.text?.trim();
    return text ?? generateFallbackNudgeMessage(user.name, contacts, isWeekly, now);
  } catch (err) {
    console.error('[nudge-flow] Message generation failed:', err);
    return generateFallbackNudgeMessage(user.name, contacts, isWeekly, now);
  }
}

/**
 * Generate a fallback nudge message when Claude is unavailable.
 */
function generateFallbackNudgeMessage(
  userName: string,
  contacts: NudgeContact[],
  isWeekly: boolean,
  now: Date,
): string {
  const greeting = getTimeGreeting(now);

  let message = `${greeting}! I was going through your contacts. A few suggestions, no pressure:\n\n`;

  for (const contact of contacts) {
    message += `- ${contact.name} (${contact.intentLabel})`;
    if (contact.daysOverdue > 0) {
      message += ` — been ${contact.daysOverdue} days`;
    }
    if (contact.contextSnippet) {
      message += `, ${contact.contextSnippet.toLowerCase()}`;
    }
    message += '\n';
  }

  message += '\nWant me to draft something for any of them?';

  return message;
}

/**
 * Get a time-appropriate greeting.
 */
function getTimeGreeting(now: Date): string {
  // Assume Central Time (UTC-6)
  const hour = now.getUTCHours() - 6;
  const adjustedHour = hour < 0 ? hour + 24 : hour;

  if (adjustedHour < 12) return 'Good morning';
  if (adjustedHour < 17) return 'Hey';
  return 'Good evening';
}

// ===========================================================================
// Response Handling
// ===========================================================================

/**
 * Parse the user's response to a nudge and determine what they want.
 *
 * @param userMessage - The user's reply text
 * @param pendingContext - The nudge context from the previous message
 */
export async function parseNudgeResponse(
  env: Env,
  userMessage: string,
  pendingContext: PendingNudgeContext,
): Promise<NudgeResponseIntent> {
  const lower = userMessage.toLowerCase().trim();
  const contacts = pendingContext.contacts;

  // Check for dismiss signals
  const dismissSignals = [
    'thanks', 'thank you', 'thx', 'ty', 'nah', 'not now', 'later',
    'no', 'nope', "i'm good", 'all good', 'maybe later', 'pass',
  ];
  if (dismissSignals.some(signal => lower.includes(signal))) {
    return { action: 'dismiss' };
  }

  // Check for "all of them" signals
  const allSignals = ['all of them', 'all', 'everyone', 'each of them', 'all three', 'all five'];
  if (allSignals.some(signal => lower.includes(signal))) {
    return { action: 'draft_for_all' };
  }

  // Check for numbered selection: "the first one", "2", "#3"
  const numberMatch = lower.match(/(?:the\s+)?(?:first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|#?\d)/);
  if (numberMatch) {
    const indexMap: Record<string, number> = {
      'first': 0, '1st': 0, '1': 0, '#1': 0,
      'second': 1, '2nd': 1, '2': 1, '#2': 1,
      'third': 2, '3rd': 2, '3': 2, '#3': 2,
      'fourth': 3, '4th': 3, '4': 3, '#4': 3,
      'fifth': 4, '5th': 4, '5': 4, '#5': 4,
    };

    for (const [key, index] of Object.entries(indexMap)) {
      if (lower.includes(key) && index < contacts.length) {
        return {
          action: 'draft_for_contact',
          contactIndex: index,
          contact: contacts[index],
        };
      }
    }
  }

  // Check for name match
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const firstName = contact.name.split(' ')[0].toLowerCase();

    if (lower.includes(firstName) || lower.includes(contact.name.toLowerCase())) {
      return {
        action: 'draft_for_contact',
        contactIndex: i,
        contact,
      };
    }
  }

  // Check for affirmative that implies first contact
  const yesSignals = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'please'];
  if (yesSignals.some(signal => lower === signal || lower === signal + '!')) {
    // Affirmative with no specific contact — assume first one
    return {
      action: 'draft_for_contact',
      contactIndex: 0,
      contact: contacts[0],
    };
  }

  return { action: 'unclear' };
}

/**
 * Handle the user's response to a nudge.
 *
 * Called by the conversation router when pending context is 'proactive_nudge'.
 *
 * @param env - Worker environment bindings
 * @param user - The user responding
 * @param userMessage - Their reply text
 * @param pendingContext - The nudge context
 */
export async function handleNudgeResponse(
  env: Env,
  user: UserRow,
  userMessage: string,
  pendingContext: PendingNudgeContext,
): Promise<{
  reply: string;
  expectsReply: boolean;
  newContext?: PendingNudgeContext | null;
}> {
  const intent = await parseNudgeResponse(env, userMessage, pendingContext);

  switch (intent.action) {
    case 'draft_for_contact': {
      const draft = await generateMessageDraft(env, user, intent.contact);
      return {
        reply: draft.reply,
        expectsReply: draft.expectsReply,
        newContext: null, // Clear nudge context
      };
    }

    case 'draft_for_all': {
      // Generate drafts for all contacts
      let reply = "Let me help you with each of them:\n\n";
      const contacts = pendingContext.contacts;

      for (const contact of contacts) {
        const draft = await generateShortDraft(env, user, contact);
        reply += `**${contact.name}:**\n${draft.message}\n`;
        if (draft.deepLink) {
          reply += `${draft.deepLink}\n`;
        }
        reply += '\n';
      }

      reply += "Tap any link to open the message in your Messages app!";

      return {
        reply,
        expectsReply: false,
        newContext: null,
      };
    }

    case 'dismiss': {
      return {
        reply: "Got it — no rush! I'll check in again later. 👍",
        expectsReply: false,
        newContext: null,
      };
    }

    case 'unclear': {
      // Re-present the options
      const names = pendingContext.contacts.map((c, i) => `${i + 1}. ${c.name}`).join(', ');
      return {
        reply: `Which one? Just say their name or number: ${names}. Or say "all" and I'll draft something for each.`,
        expectsReply: true,
        newContext: pendingContext, // Keep the context
      };
    }
  }
}

// ===========================================================================
// Message Draft Generation
// ===========================================================================

interface DraftResult {
  reply: string;
  expectsReply: boolean;
  message: string;
  deepLink?: string;
}

/**
 * Generate a message draft for a specific contact.
 * Returns Bethany's response with the draft and a deep link.
 */
async function generateMessageDraft(
  env: Env,
  user: UserRow,
  contact: NudgeContact,
): Promise<DraftResult> {
  // Get more context about the contact
  const contactRow = await env.DB
    .prepare('SELECT * FROM contacts WHERE id = ?')
    .bind(contact.contactId)
    .first<ContactRow>();

  // Get recent interaction summaries
  const { results: recentInteractions } = await env.DB
    .prepare(
      `SELECT method, summary, date FROM interactions
       WHERE contact_id = ?
       ORDER BY date DESC LIMIT 3`
    )
    .bind(contact.contactId)
    .all<{ method: string; summary: string | null; date: string }>();

  // Build context for draft generation
  const interactionContext = recentInteractions
    .filter(i => i.summary)
    .map(i => `${i.method}: ${i.summary}`)
    .join('; ');

  const systemPrompt = `You are helping ${user.name} draft a message to ${contact.name}.

ABOUT ${contact.name.toUpperCase()}:
- Relationship layer: ${contact.intentLabel}
- Days since contact: ${contact.daysOverdue > 0 ? contact.daysOverdue : 'recently'}
${contactRow?.notes ? `- Notes: ${contactRow.notes}` : ''}
${interactionContext ? `- Recent interactions: ${interactionContext}` : ''}
${contact.contextSnippet ? `- Context: ${contact.contextSnippet}` : ''}

GENERATE A SHORT, CASUAL TEXT MESSAGE:
- Sound natural — like something ${user.name} would actually send
- Reference something specific if you have context (don't be generic)
- Keep it under 100 characters — this is a text, not an email
- Don't be overly formal or enthusiastic
- If you have no context, just go for a simple check-in

Respond ONLY with the draft message text. No quotes, no explanation.`;

  let draftMessage: string;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Generate the draft.' }],
      }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    draftMessage = data.content.find(b => b.type === 'text')?.text?.trim()
      ?? generateFallbackDraft(contact);
  } catch (err) {
    console.error('[nudge-flow] Draft generation failed:', err);
    draftMessage = generateFallbackDraft(contact);
  }

  // Generate deep link if phone number available
  let deepLink: string | undefined;
  if (contact.phone) {
    deepLink = generateSmsLink(contact.phone, draftMessage);
  }

  // Build Bethany's response
  let reply = `Here's a draft for ${contact.name}:\n\n"${draftMessage}"`;

  if (deepLink) {
    reply += `\n\nTap to send: ${deepLink}`;
  } else {
    reply += `\n\n(I don't have ${contact.name}'s number on file — you'll need to send it manually!)`;
  }

  return {
    reply,
    expectsReply: false,
    message: draftMessage,
    deepLink,
  };
}

/**
 * Generate a shorter draft for the "all contacts" flow.
 */
async function generateShortDraft(
  env: Env,
  user: UserRow,
  contact: NudgeContact,
): Promise<{ message: string; deepLink?: string }> {
  // Simpler prompt for batch drafts
  const systemPrompt = `Generate a very short, casual check-in text message from ${user.name} to ${contact.name}.
${contact.contextSnippet ? `Context: ${contact.contextSnippet}` : 'No specific context — just a friendly check-in.'}
Keep it under 50 characters. Sound natural. Respond only with the message text.`;

  let draftMessage: string;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: systemPrompt,
        messages: [{ role: 'user', content: 'Generate.' }],
      }),
    });

    if (!response.ok) throw new Error('API error');

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    draftMessage = data.content.find(b => b.type === 'text')?.text?.trim()
      ?? generateFallbackDraft(contact);
  } catch {
    draftMessage = generateFallbackDraft(contact);
  }

  let deepLink: string | undefined;
  if (contact.phone) {
    deepLink = generateSmsLink(contact.phone, draftMessage);
  }

  return { message: draftMessage, deepLink };
}

/**
 * Generate a fallback draft when Claude is unavailable.
 */
function generateFallbackDraft(contact: NudgeContact): string {
  const templates = [
    `Hey! Been thinking about you. How are things?`,
    `Hey ${contact.name.split(' ')[0]}! It's been a bit — hope you're doing well!`,
    `Checking in! How's everything going?`,
    `Hey! Just wanted to say hi and see how you're doing.`,
  ];

  return templates[Math.floor(Math.random() * templates.length)];
}

// ===========================================================================
// Conversation Router Integration
// ===========================================================================

/**
 * Check if there's a pending nudge context for this user.
 * Called by the conversation router to determine if a message
 * should be routed to the nudge handler.
 */
export async function hasPendingNudgeContext(
  env: Env,
  userId: string,
): Promise<PendingNudgeContext | null> {
  try {
    const doId = (env as any).NUDGE_CONTEXT_DO?.idFromName(userId);
    if (!doId) return null;

    const doStub = (env as any).NUDGE_CONTEXT_DO.get(doId);
    const response = await doStub.fetch(new Request('https://do/context'));

    if (response.status === 404) return null;

    const context = await response.json() as PendingNudgeContext;

    // Check if context has expired (15 minute window)
    const sentAt = new Date(context.sentAt).getTime();
    const now = Date.now();
    if (now - sentAt > 15 * 60 * 1000) {
      // Expired — clear it
      await clearNudgeContext(env, userId);
      return null;
    }

    return context;
  } catch {
    return null;
  }
}

/**
 * Store pending nudge context for a user.
 * Called after sending a proactive nudge.
 */
export async function storeNudgeContext(
  env: Env,
  userId: string,
  context: PendingNudgeContext,
): Promise<void> {
  try {
    const doId = (env as any).NUDGE_CONTEXT_DO?.idFromName(userId);
    if (!doId) return;

    const doStub = (env as any).NUDGE_CONTEXT_DO.get(doId);
    await doStub.fetch(new Request('https://do/context', {
      method: 'PUT',
      body: JSON.stringify(context),
    }));
  } catch (err) {
    console.error('[nudge-flow] Failed to store context:', err);
  }
}

/**
 * Clear pending nudge context for a user.
 */
export async function clearNudgeContext(
  env: Env,
  userId: string,
): Promise<void> {
  try {
    const doId = (env as any).NUDGE_CONTEXT_DO?.idFromName(userId);
    if (!doId) return;

    const doStub = (env as any).NUDGE_CONTEXT_DO.get(doId);
    await doStub.fetch(new Request('https://do/context', { method: 'DELETE' }));
  } catch {
    // Ignore cleanup failures
  }
}

// ===========================================================================
// Durable Object for Nudge Context (Optional)
// ===========================================================================

/**
 * NudgeContextDO — Stores pending nudge context per user.
 *
 * This is optional — if not configured, nudge context won't persist
 * and follow-up handling won't work. The system degrades gracefully.
 *
 * Wrangler config:
 *   [[durable_objects.bindings]]
 *   name = "NUDGE_CONTEXT_DO"
 *   class_name = "NudgeContextDO"
 */
export class NudgeContextDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/context') {
      if (request.method === 'GET') {
        const data = await this.state.storage.get<PendingNudgeContext>('context');
        if (!data) {
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PUT') {
        const body = await request.json() as PendingNudgeContext;
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

// ===========================================================================
// SendBlue Integration
// ===========================================================================

/**
 * Send a proactive nudge via SendBlue.
 *
 * This is called by the cron job to deliver the morning nudge.
 * It sends the message AND stores the pending context for follow-up.
 *
 * @param env - Worker environment bindings
 * @param user - The user to nudge
 * @param nudge - The generated nudge message
 */
export async function sendProactiveNudge(
  env: Env,
  user: UserRow,
  nudge: ProactiveNudgeMessage,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Send via SendBlue
    const response = await fetch('https://api.sendblue.co/api/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': env.SENDBLUE_API_KEY,
        'sb-api-secret-key': env.SENDBLUE_API_SECRET,
      },
      body: JSON.stringify({
        number: user.phone,
        content: nudge.message,
        send_style: 'invisible',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error };
    }

    // Store pending context for follow-up handling
    await storeNudgeContext(env, user.id, {
      type: 'proactive_nudge',
      contacts: nudge.contacts,
      sentAt: new Date().toISOString(),
      isWeeklyDigest: nudge.isWeeklyDigest,
    });

    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}
