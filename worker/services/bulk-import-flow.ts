/**
 * Bulk Import Flow — Guided Conversation for Organizing Imported Contacts
 *
 * This service handles the conversational flow after a user uploads a CSV
 * of contacts. Imported contacts arrive with minimal data (just names and
 * maybe phone/email). This flow helps the user organize them efficiently.
 *
 * FLOW STAGES:
 *
 *   1. import_count      — "You've got 127 new contacts. Let's get them organized."
 *   2. learn_circles     — "Tell me about the different worlds you operate in..."
 *   3. create_circles    — Auto-create circles from their description
 *   4. offer_sorting     — "Do you have your [DJ] contacts in one file? Or sort one by one?"
 *   5. sorting_active    — Either filtered import mode or sequential sorting
 *   6. complete          — All contacts sorted or user opts to handle later
 *
 * ENTRY POINTS:
 *
 *   - Web dashboard CSV upload → triggers startBulkImportFlow()
 *   - SMS "I just imported contacts" → conversation router dispatches here
 *   - Dashboard sends Bethany an intro message via API after CSV processing
 *
 * DESIGN DECISIONS:
 *
 *   - Bethany's personality shines through — conversational, not robotic
 *   - User choice at every step — we don't force a single path
 *   - "Chaos mode" is explicitly supported — mark all as unsorted for later
 *   - Circles are created on-the-fly during conversation
 *   - State is stored in a Durable Object per user (like onboarding)
 *
 * @see worker/services/conversation-router.ts for SMS entry
 * @see worker/routes/api.ts for dashboard entry
 * @see worker/services/intent-assignment-flow.ts for sorting contacts
 */

import type { Env } from '../../shared/types';
import type { UserRow, CircleRow, IntentType } from '../../shared/models';
import { createCircle, getCircleByName, listCircles } from './circle-service';
import { listContacts, updateContact } from './contact-service';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Stages in the bulk import flow.
 */
export type BulkImportStage =
  | 'import_count'     // Just opened — show count and intro
  | 'learn_circles'    // Asking about their worlds
  | 'circles_created'  // Confirmed circles, ready to sort
  | 'offer_sorting'    // Explaining sorting options
  | 'sorting_active'   // Actively sorting (hand off to intent-assignment)
  | 'chaos_mode'       // User opted to defer sorting
  | 'complete';        // All done

/**
 * State for the bulk import conversation — stored in Durable Object.
 */
export interface BulkImportState {
  userId: string;
  phone: string;
  stage: BulkImportStage;
  
  /** Total contacts imported in this batch */
  importedCount: number;
  
  /** Contacts still without intent/circles */
  unsortedCount: number;
  
  /** Circles the user mentioned during conversation */
  circlesMentioned: string[];
  
  /** Circles we've created so far */
  circlesCreated: string[];
  
  /** If doing filtered sorting, which circle are we focusing on? */
  activeCircleFocus: string | null;
  
  /** Conversation history for context */
  messages: Array<{
    role: 'user' | 'bethany';
    content: string;
    timestamp: string;
  }>;
  
  startedAt: string;
  lastMessageAt: string;
}

/**
 * Result from processing a user message.
 */
export interface BulkImportResponse {
  reply: string;
  stage: BulkImportStage;
  expectsReply: boolean;
  /** If we need to hand off to intent assignment flow */
  handoffToSorting?: {
    contactId?: string;
    circleFilter?: string;
  };
}

/**
 * Context for pending bulk import conversation.
 */
export interface PendingBulkImportContext {
  stage: BulkImportStage;
  unsortedCount: number;
  circlesMentioned: string[];
  circlesCreated: string[];
  activeCircleFocus: string | null;
}

// ===========================================================================
// State Management
// ===========================================================================

const IMPORT_STATE_PREFIX = 'import_state:';
const STATE_TTL_HOURS = 24;

/**
 * Get or initialize bulk import state for a user.
 */
async function getImportState(
  env: Env,
  userId: string,
  phone: string,
): Promise<BulkImportState | null> {
  const key = `${IMPORT_STATE_PREFIX}${userId}`;
  const obj = await env.MEMORY.get(key);
  if (!obj) return null;
  
  try {
    return JSON.parse(await obj.text()) as BulkImportState;
  } catch {
    return null;
  }
}

/**
 * Save bulk import state.
 */
async function saveImportState(
  env: Env,
  state: BulkImportState,
): Promise<void> {
  const key = `${IMPORT_STATE_PREFIX}${state.userId}`;
  await env.MEMORY.put(key, JSON.stringify(state), {
    expirationTtl: STATE_TTL_HOURS * 60 * 60,
  });
}

/**
 * Clear bulk import state (flow complete or abandoned).
 */
async function clearImportState(env: Env, userId: string): Promise<void> {
  const key = `${IMPORT_STATE_PREFIX}${userId}`;
  await env.MEMORY.delete(key);
}

// ===========================================================================
// Count Helpers
// ===========================================================================

/**
 * Count contacts that are unsorted (intent = 'new' and no circles).
 */
export async function countUnsortedImports(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(`
      SELECT COUNT(*) as count
      FROM contacts c
      WHERE c.user_id = ?
        AND c.archived = 0
        AND c.intent = 'new'
        AND NOT EXISTS (
          SELECT 1 FROM contact_circles cc WHERE cc.contact_id = c.id
        )
    `)
    .bind(userId)
    .first<{ count: number }>();
  
  return result?.count ?? 0;
}

/**
 * Count all contacts with intent = 'new'.
 */
export async function countNewContacts(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(`
      SELECT COUNT(*) as count
      FROM contacts
      WHERE user_id = ? AND archived = 0 AND intent = 'new'
    `)
    .bind(userId)
    .first<{ count: number }>();
  
  return result?.count ?? 0;
}

/**
 * Get unsorted contacts, optionally filtered by name pattern.
 */
export async function getUnsortedContacts(
  db: D1Database,
  userId: string,
  limit: number = 50,
): Promise<Array<{ id: string; name: string; source: string | null }>> {
  const { results } = await db
    .prepare(`
      SELECT c.id, c.name, c.source
      FROM contacts c
      WHERE c.user_id = ?
        AND c.archived = 0
        AND c.intent = 'new'
      ORDER BY c.created_at DESC
      LIMIT ?
    `)
    .bind(userId, limit)
    .all<{ id: string; name: string; source: string | null }>();
  
  return results;
}

// ===========================================================================
// Flow Entry Points
// ===========================================================================

/**
 * Start the bulk import flow after CSV upload.
 *
 * Called by the dashboard after processing a CSV file. Returns Bethany's
 * opening message and initializes conversation state.
 *
 * @param env       - Environment bindings
 * @param user      - The user who uploaded
 * @param csvStats  - How many contacts were imported
 */
export async function startBulkImportFlow(
  env: Env,
  user: UserRow,
  csvStats: { imported: number; duplicatesSkipped: number },
): Promise<BulkImportResponse> {
  const unsortedCount = await countUnsortedImports(env.DB, user.id);
  
  // Initialize state
  const state: BulkImportState = {
    userId: user.id,
    phone: user.phone,
    stage: 'import_count',
    importedCount: csvStats.imported,
    unsortedCount,
    circlesMentioned: [],
    circlesCreated: [],
    activeCircleFocus: null,
    messages: [],
    startedAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
  };
  
  // Build opening message
  let reply: string;
  
  if (csvStats.imported === 0) {
    reply = "Hmm, that CSV didn't have any new contacts. Double-check the format? I need at least a name column.";
    return { reply, stage: 'complete', expectsReply: false };
  }
  
  if (csvStats.imported === 1) {
    reply = `Got it — added 1 new contact.${csvStats.duplicatesSkipped > 0 ? ` (Skipped ${csvStats.duplicatesSkipped} duplicate${csvStats.duplicatesSkipped > 1 ? 's' : ''})` : ''} Want to tell me about them so I can help you stay connected?`;
  } else if (csvStats.imported <= 10) {
    reply = `Nice! Added ${csvStats.imported} new contacts.${csvStats.duplicatesSkipped > 0 ? ` (Skipped ${csvStats.duplicatesSkipped} duplicate${csvStats.duplicatesSkipped > 1 ? 's' : ''})` : ''} Let's get them organized. Tell me about the different worlds you operate in — work, friends, family, hobbies?`;
    state.stage = 'learn_circles';
  } else {
    reply = `You've got ${csvStats.imported} new contacts! ${csvStats.duplicatesSkipped > 0 ? `(Skipped ${csvStats.duplicatesSkipped} duplicate${csvStats.duplicatesSkipped > 1 ? 's' : ''}) ` : ''}Let's get them organized.\n\nFirst, tell me about the different worlds you operate in — businesses, friend groups, family, hobbies. We'll create circles for each.`;
    state.stage = 'learn_circles';
  }
  
  // Record the message
  state.messages.push({
    role: 'bethany',
    content: reply,
    timestamp: new Date().toISOString(),
  });
  
  await saveImportState(env, state);
  
  return {
    reply,
    stage: state.stage,
    expectsReply: true,
  };
}

/**
 * Check if a user has an active bulk import flow.
 */
export async function hasActiveBulkImport(
  env: Env,
  userId: string,
): Promise<boolean> {
  const state = await getImportState(env, userId, '');
  return state !== null && state.stage !== 'complete';
}

/**
 * Get pending context for conversation router.
 */
export async function getBulkImportContext(
  env: Env,
  userId: string,
): Promise<PendingBulkImportContext | null> {
  const state = await getImportState(env, userId, '');
  if (!state || state.stage === 'complete') return null;
  
  return {
    stage: state.stage,
    unsortedCount: state.unsortedCount,
    circlesMentioned: state.circlesMentioned,
    circlesCreated: state.circlesCreated,
    activeCircleFocus: state.activeCircleFocus,
  };
}

// ===========================================================================
// Message Handler
// ===========================================================================

/**
 * Process a user message in the bulk import flow.
 *
 * Routes to the appropriate stage handler based on current state.
 */
export async function handleBulkImportMessage(
  env: Env,
  user: UserRow,
  message: string,
): Promise<BulkImportResponse> {
  let state = await getImportState(env, user.id, user.phone);
  
  if (!state) {
    // No active import flow — shouldn't happen if routed correctly
    return {
      reply: "I don't have an active import session. Did you upload a CSV? If so, try refreshing the dashboard.",
      stage: 'complete',
      expectsReply: false,
    };
  }
  
  // Record user message
  state.messages.push({
    role: 'user',
    content: message,
    timestamp: new Date().toISOString(),
  });
  state.lastMessageAt = new Date().toISOString();
  
  let response: BulkImportResponse;
  
  switch (state.stage) {
    case 'import_count':
    case 'learn_circles':
      response = await handleLearnCircles(env, user, state, message);
      break;
    
    case 'circles_created':
    case 'offer_sorting':
      response = await handleOfferSorting(env, user, state, message);
      break;
    
    case 'sorting_active':
      response = await handleSortingActive(env, user, state, message);
      break;
    
    case 'chaos_mode':
      response = await handleChaosMode(env, user, state, message);
      break;
    
    case 'complete':
      // Flow ended — shouldn't be called
      response = {
        reply: "We finished organizing your contacts! Need to import more?",
        stage: 'complete',
        expectsReply: false,
      };
      break;
    
    default:
      response = {
        reply: "I lost track of where we were. Want to start over with organizing your contacts?",
        stage: 'learn_circles',
        expectsReply: true,
      };
      state.stage = 'learn_circles';
  }
  
  // Record Bethany's response
  state.messages.push({
    role: 'bethany',
    content: response.reply,
    timestamp: new Date().toISOString(),
  });
  state.stage = response.stage;
  
  // Save or clear state
  if (response.stage === 'complete') {
    await clearImportState(env, user.id);
  } else {
    await saveImportState(env, state);
  }
  
  return response;
}

// ===========================================================================
// Stage Handlers
// ===========================================================================

/**
 * Handle the "learn_circles" stage.
 *
 * User describes their worlds. We extract circle names and create them.
 */
async function handleLearnCircles(
  env: Env,
  user: UserRow,
  state: BulkImportState,
  message: string,
): Promise<BulkImportResponse> {
  // Use Claude to extract circle names from natural language
  const extractedCircles = await extractCirclesFromDescription(env, message);
  
  if (extractedCircles.length === 0) {
    // Couldn't extract any — ask for clarification
    return {
      reply: "I want to make sure I set up the right groups. Can you give me a quick list? Like: \"Work, DJ gigs, church friends, close family\"",
      stage: 'learn_circles',
      expectsReply: true,
    };
  }
  
  // Get existing circles to avoid duplicates
  const existingCircles = await listCircles(env.DB, user.id);
  const existingNames = new Set(existingCircles.map(c => c.name.toLowerCase()));
  
  const circlesToCreate: string[] = [];
  const alreadyExist: string[] = [];
  
  for (const circleName of extractedCircles) {
    if (existingNames.has(circleName.toLowerCase())) {
      alreadyExist.push(circleName);
    } else {
      circlesToCreate.push(circleName);
    }
  }
  
  // Create new circles
  const created: string[] = [];
  for (const name of circlesToCreate) {
    try {
      await createCircle(env.DB, user.id, { name });
      created.push(name);
    } catch (err) {
      // Might be duplicate if race condition — ignore
      console.log(`[bulk-import] Failed to create circle "${name}":`, err);
    }
  }
  
  // Update state
  state.circlesMentioned = [...new Set([...state.circlesMentioned, ...extractedCircles])];
  state.circlesCreated = [...new Set([...state.circlesCreated, ...created])];
  
  // Build response
  let reply: string;
  
  if (created.length > 0) {
    const circleList = created.join(', ');
    reply = `Got it! Created circles for: ${circleList}.`;
    
    if (alreadyExist.length > 0) {
      reply += ` (You already had: ${alreadyExist.join(', ')})`;
    }
    
    // Move to sorting options
    const allCircles = [...existingCircles.map(c => c.name), ...created];
    
    if (state.unsortedCount > 20) {
      reply += `\n\nNow for the ${state.unsortedCount} contacts. A few options:\n`;
      reply += `\n1️⃣ If you have a file with just [specific group] contacts, I can do a focused upload`;
      reply += `\n2️⃣ We can go through them one by one — I'll ask about each person`;
      reply += `\n3️⃣ Mark them all as unsorted and tackle them later`;
      reply += `\n\nWhat sounds good?`;
    } else {
      reply += `\n\nWant to sort your ${state.unsortedCount} contacts now? I can walk you through each one, or we can save it for later.`;
    }
    
    return {
      reply,
      stage: 'offer_sorting',
      expectsReply: true,
    };
  } else if (alreadyExist.length > 0) {
    reply = `You already have circles for those: ${alreadyExist.join(', ')}. Want to add any other groups, or should we start sorting?`;
    return {
      reply,
      stage: 'offer_sorting',
      expectsReply: true,
    };
  } else {
    return {
      reply: "Hmm, I didn't catch any group names there. Try something like \"I've got work contacts, church friends, and family\"",
      stage: 'learn_circles',
      expectsReply: true,
    };
  }
}

/**
 * Handle sorting options stage.
 *
 * User picks how they want to sort: focused upload, one-by-one, or defer.
 */
async function handleOfferSorting(
  env: Env,
  user: UserRow,
  state: BulkImportState,
  message: string,
): Promise<BulkImportResponse> {
  const lowerMsg = message.toLowerCase();
  
  // Check for "later" / "defer" / "chaos" signals
  if (
    lowerMsg.includes('later') ||
    lowerMsg.includes('unsorted') ||
    lowerMsg.includes('tackle') ||
    lowerMsg.includes('save') ||
    lowerMsg.includes('skip') ||
    lowerMsg.includes('not now') ||
    lowerMsg.includes('nah') ||
    lowerMsg.match(/^3|three|third$/)
  ) {
    return {
      reply: `No worries! I'll mark them as unsorted. Whenever you're ready, just say "sort my contacts" and we'll work through them together. 👍`,
      stage: 'chaos_mode',
      expectsReply: false,
    };
  }
  
  // Check for "one by one" / "walk through" signals
  if (
    lowerMsg.includes('one by one') ||
    lowerMsg.includes('walk through') ||
    lowerMsg.includes('each one') ||
    lowerMsg.includes('go through') ||
    lowerMsg.includes('sort now') ||
    lowerMsg.includes("let's do it") ||
    lowerMsg.includes('yes') ||
    lowerMsg.match(/^2|two|second$/) ||
    lowerMsg.match(/^y$|^yeah$|^yep$|^sure$/)
  ) {
    // Hand off to intent assignment flow
    return {
      reply: "Perfect! Let's do this.",
      stage: 'sorting_active',
      expectsReply: true,
      handoffToSorting: {},
    };
  }
  
  // Check for circle focus / filtered upload
  const circles = await listCircles(env.DB, user.id);
  const mentionedCircle = circles.find(c => 
    lowerMsg.includes(c.name.toLowerCase())
  );
  
  if (mentionedCircle || lowerMsg.includes('file') || lowerMsg.includes('upload') || lowerMsg.match(/^1|one|first$/)) {
    if (mentionedCircle) {
      state.activeCircleFocus = mentionedCircle.name;
      return {
        reply: `Got it — focusing on ${mentionedCircle.name} contacts. You can upload a CSV with just those, or if they're already in your import, tell me which names go there.`,
        stage: 'sorting_active',
        expectsReply: true,
      };
    } else {
      return {
        reply: `Which group do you want to focus on first? (${circles.map(c => c.name).join(', ')})`,
        stage: 'offer_sorting',
        expectsReply: true,
      };
    }
  }
  
  // Didn't understand — clarify
  return {
    reply: `Not sure I caught that. Would you like to:\n\n1️⃣ Focus on one group at a time\n2️⃣ Go through all ${state.unsortedCount} contacts one by one\n3️⃣ Save it for later`,
    stage: 'offer_sorting',
    expectsReply: true,
  };
}

/**
 * Handle active sorting stage.
 *
 * This is a passthrough to the intent-assignment-flow for most cases.
 */
async function handleSortingActive(
  env: Env,
  user: UserRow,
  state: BulkImportState,
  message: string,
): Promise<BulkImportResponse> {
  const lowerMsg = message.toLowerCase();
  
  // Check for "done" / "stop" signals
  if (
    lowerMsg.includes('done') ||
    lowerMsg.includes('stop') ||
    lowerMsg.includes('enough') ||
    lowerMsg.includes('finish') ||
    lowerMsg.includes('exit')
  ) {
    const remaining = await countNewContacts(env.DB, user.id);
    if (remaining > 0) {
      return {
        reply: `Okay, stopping there! You still have ${remaining} unsorted contact${remaining === 1 ? '' : 's'}. Just say "sort my contacts" whenever you want to continue.`,
        stage: 'complete',
        expectsReply: false,
      };
    } else {
      return {
        reply: "All done! Every contact is sorted. 🎉",
        stage: 'complete',
        expectsReply: false,
      };
    }
  }
  
  // Hand off to intent assignment
  return {
    reply: "Let me pull up the next one...",
    stage: 'sorting_active',
    expectsReply: true,
    handoffToSorting: {
      circleFilter: state.activeCircleFocus ?? undefined,
    },
  };
}

/**
 * Handle chaos mode — user deferred sorting.
 *
 * They might text back later wanting to start. Keep the door open.
 */
async function handleChaosMode(
  env: Env,
  user: UserRow,
  state: BulkImportState,
  message: string,
): Promise<BulkImportResponse> {
  const lowerMsg = message.toLowerCase();
  
  // Check if they want to start sorting now
  if (
    lowerMsg.includes('sort') ||
    lowerMsg.includes('organize') ||
    lowerMsg.includes('start') ||
    lowerMsg.includes('ready') ||
    lowerMsg.includes('now')
  ) {
    return {
      reply: "Great! Let's tackle those contacts.",
      stage: 'sorting_active',
      expectsReply: true,
      handoffToSorting: {},
    };
  }
  
  // Otherwise, wrap up
  return {
    reply: "Sounds good! Your contacts are there whenever you need them. Just say \"sort my contacts\" when you're ready.",
    stage: 'complete',
    expectsReply: false,
  };
}

// ===========================================================================
// Circle Extraction (Claude-powered)
// ===========================================================================

/**
 * Extract circle names from user's natural language description.
 *
 * Examples:
 *   "I've got work stuff, DJ business, and church" → ["Work", "DJ Business", "Church"]
 *   "Family, close friends, some acquaintances" → ["Family", "Close Friends", "Acquaintances"]
 */
async function extractCirclesFromDescription(
  env: Env,
  description: string,
): Promise<string[]> {
  const systemPrompt = `You extract circle/group names from a user's description of their social circles.

The user is setting up a relationship management app and describing the different "worlds" they operate in.

Rules:
- Extract distinct group names
- Title case each name (e.g., "work stuff" → "Work", "dj business" → "DJ Business")
- Don't extract generic words like "stuff", "people", "contacts"
- Keep it to 1-3 words per circle name
- Return as a JSON array of strings
- If you can't extract any groups, return []

Examples:
Input: "I've got work colleagues, my DJ gig people, church friends, and close family"
Output: ["Work", "DJ Business", "Church", "Family"]

Input: "mostly business contacts and some personal friends"
Output: ["Business", "Personal"]

Respond ONLY with the JSON array, no other text.`;

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
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: 'user', content: description }],
      }),
    });

    if (!response.ok) {
      console.error('[bulk-import] Claude API error:', response.status);
      return fallbackCircleExtraction(description);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };

    const text = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string =>
          typeof item === 'string' && item.length > 0 && item.length < 50
      );
    }
    return [];
  } catch (err) {
    console.error('[bulk-import] Circle extraction failed:', err);
    return fallbackCircleExtraction(description);
  }
}

/**
 * Fallback circle extraction using basic keyword matching.
 */
function fallbackCircleExtraction(description: string): string[] {
  const circles: string[] = [];
  const lower = description.toLowerCase();
  
  // Common circle patterns
  const patterns: Array<{ regex: RegExp; name: string }> = [
    { regex: /\b(work|job|office|colleagues?|coworkers?)\b/, name: 'Work' },
    { regex: /\b(family|relatives?|kin)\b/, name: 'Family' },
    { regex: /\b(friends?|buddies|pals)\b/, name: 'Friends' },
    { regex: /\b(church|faith|religious|ministry)\b/, name: 'Church' },
    { regex: /\b(business|clients?|professional)\b/, name: 'Business' },
    { regex: /\b(school|college|university|alumni)\b/, name: 'School' },
    { regex: /\b(gym|fitness|workout|sports?)\b/, name: 'Fitness' },
    { regex: /\b(neighbors?|neighborhood|community)\b/, name: 'Community' },
    { regex: /\b(dj|music|band|gig)\b/, name: 'Music' },
  ];
  
  for (const { regex, name } of patterns) {
    if (regex.test(lower) && !circles.includes(name)) {
      circles.push(name);
    }
  }
  
  return circles;
}

// ===========================================================================
// Dashboard API Helpers
// ===========================================================================

/**
 * Notify Bethany that a CSV upload completed.
 *
 * Called by the dashboard after CSV processing. Triggers the flow
 * and optionally sends an SMS to the user.
 */
export async function notifyBulkUploadComplete(
  env: Env,
  user: UserRow,
  stats: { imported: number; duplicatesSkipped: number },
  sendSms: boolean = true,
): Promise<{ message: string; stage: BulkImportStage }> {
  const response = await startBulkImportFlow(env, user, stats);
  
  if (sendSms && response.reply) {
    // Send via SendBlue
    try {
      await fetch('https://api.sendblue.co/api/send-message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sb-api-key-id': env.SENDBLUE_API_KEY,
          'sb-api-secret-key': env.SENDBLUE_API_SECRET,
        },
        body: JSON.stringify({
          number: user.phone,
          content: response.reply,
          send_style: 'regular',
        }),
      });
    } catch (err) {
      console.error('[bulk-import] Failed to send SMS:', err);
    }
  }
  
  return {
    message: response.reply,
    stage: response.stage,
  };
}

/**
 * Assign multiple contacts to a circle in batch.
 *
 * Used when user says "all the [Name] people go in [Circle]".
 */
export async function batchAssignToCircle(
  env: Env,
  userId: string,
  contactIds: string[],
  circleId: string,
  intent?: IntentType,
): Promise<{ assigned: number; failed: number }> {
  const { addContactToCircle } = await import('./circle-service');
  
  let assigned = 0;
  let failed = 0;
  
  for (const contactId of contactIds) {
    try {
      const added = await addContactToCircle(env.DB, userId, contactId, circleId);
      if (added) {
        assigned++;
        
        // Also update intent if provided
        if (intent) {
          await updateContact(env.DB, userId, contactId, { intent });
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  
  return { assigned, failed };
}
