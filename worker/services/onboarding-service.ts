/**
 * SMS Onboarding Service — Post-Signup Conversation State Machine
 *
 * FLOW (new as of web-first redesign):
 *
 *   1. User signs up on web form (email + phone)
 *   2. Bethany sends intro message via SendBlue send-message API
 *      (this registers the contact for inbound routing on SendBlue's standard plan)
 *   3. User replies → conversation begins here
 *   4. State machine walks through: intro_sent → user_replies → learn_circles →
 *      explain_features → ready
 *   5. On completion, user record is updated and onboarding state is archived
 *
 * OLD FLOW (deprecated):
 *   User texts first → Bethany collects name → discusses circles → sends signup link
 *   That SMS-first model is gone. The web form is the entry point now.
 *   The send_signup_link stage no longer exists.
 *
 * STATE STORAGE:
 *   Conversation state lives in a Durable Object keyed by phone number.
 *   This gives us:
 *     - Single-writer guarantee (no race conditions on rapid messages)
 *     - Persistent state across Worker invocations
 *     - Automatic hibernation when idle
 *     - WebSocket support if we ever add real-time dashboard updates
 *
 *   State is NOT stored in D1. The Durable Object is the source of truth
 *   during onboarding. On completion, relevant data is written to D1
 *   (circles, preferences) and the DO state is archived to R2.
 *
 * BETHANY'S VOICE:
 *   All outbound messages go through generateBethanyResponse() which calls
 *   the Anthropic API with Bethany's personality config. The stage-specific
 *   prompts guide the conversation but Bethany's voice is always her own —
 *   warm, sharp, real. Never robotic or corporate.
 *
 * @see shared/models.ts for OnboardingStage, OnboardingState
 * @see docs/personality-config.md for Bethany's voice
 * @see worker/routes/sms.ts for routing into this service
 */

import type { Env } from '../../shared/types';
import type { OnboardingState } from '../../shared/models';

// ===========================================================================
// Updated Stage Type (replaces old OnboardingStage in models.ts)
// ===========================================================================

/**
 * Post-signup onboarding stages.
 *
 * intro_sent       — Bethany's welcome message was delivered after web signup.
 *                     Waiting for user's first reply.
 * user_replies     — User has responded. Bethany acknowledges and begins
 *                     learning about their world.
 * learn_circles    — Active conversation about who matters to the user.
 *                     Bethany helps identify key relationships and groups.
 * explain_features — Bethany shows what she can do (nudges, check-ins,
 *                     brain dumps, drafting messages).
 * ready            — Onboarding complete. User is oriented and active.
 */
export type PostSignupStage =
  | 'intro_sent'
  | 'user_replies'
  | 'learn_circles'
  | 'explain_features'
  | 'ready';

// ===========================================================================
// Onboarding State (Durable Object storage shape)
// ===========================================================================

export interface OnboardingConversationState {
  phone: string;
  userId: string;               // The real user ID from web signup
  email: string | null;
  stage: PostSignupStage;
  name: string;                 // Already known from web signup
  circlesDiscussed: string[];   // Circles identified during learn_circles
  peopleDiscussed: Array<{      // Specific people mentioned
    name: string;
    relationship?: string;      // "sister", "college roommate", "boss"
    circle?: string;            // Which circle they fit
    notes?: string;             // Anything Bethany picks up
  }>;
  messages: Array<{
    role: 'user' | 'bethany';
    content: string;
    timestamp: string;
  }>;
  startedAt: string;
  lastMessageAt: string;
  introMessageId?: string;      // SendBlue message ID for the intro
}

// ===========================================================================
// Stage Transition Rules
// ===========================================================================

/**
 * Valid transitions. Each stage can only move forward.
 * The state machine is linear — no branching, no going back.
 */
const VALID_TRANSITIONS: Record<PostSignupStage, PostSignupStage | null> = {
  intro_sent: 'user_replies',
  user_replies: 'learn_circles',
  learn_circles: 'explain_features',
  explain_features: 'ready',
  ready: null, // Terminal state
};

/**
 * Check if a stage transition is valid.
 */
export function canTransition(from: PostSignupStage, to: PostSignupStage): boolean {
  return VALID_TRANSITIONS[from] === to;
}

// ===========================================================================
// Stage-Specific System Prompts
// ===========================================================================

/**
 * System prompt fragments injected alongside Bethany's personality config.
 * These guide the conversation at each stage without overriding her voice.
 *
 * The personality config (docs/personality-config.md) is ALWAYS included.
 * These stage prompts add context about what to accomplish in this turn.
 */
const STAGE_PROMPTS: Record<PostSignupStage, string> = {
  intro_sent: `
    The user just signed up on the web and you've sent your intro message.
    You're waiting for their first reply. When they respond, acknowledge them
    warmly — they took the step of signing up, that's worth something.
    
    Your goal: Make them feel like they made a good choice. Be curious about
    who they're here for — not in an intake-form way, in a "tell me about
    your people" way.
    
    After acknowledging their reply, transition naturally into asking about
    their world. Who are the people they'd hate to lose touch with?
  `,

  user_replies: `
    The user has responded to your intro. You're getting to know them.
    
    Your goal: Understand the shape of their social world. Start identifying
    who matters most. Listen for:
    - Names and relationships ("my sister Emily", "old college friend Jake")
    - Emotional weight ("I really need to call my mom more")
    - Natural groupings that suggest circles
    
    Be a great listener here. Ask one follow-up at a time. Don't overwhelm
    them with questions. Let the conversation breathe.
    
    When you have a sense of at least 2-3 key people, naturally transition
    to learn_circles by starting to organize what you've heard.
  `,

  learn_circles: `
    You're helping the user identify their key relationship circles.
    You already know some people from the conversation. Now organize them.
    
    Your goal: Help the user see their relationships in groups. Start with
    what's obvious from what they've shared, then ask about gaps.
    
    Default circles exist (Family, Friends, Work, Community) but the user
    might have others — "Book Club", "College Crew", "Gym Friends", etc.
    
    Keep it conversational. Not: "Let's categorize your contacts into groups."
    More: "Sounds like Emily and your mom are the family core. And Jake and
    Marcus are the friend crew you don't want to lose. Anyone else in that
    inner ring?"
    
    When you've identified the major circles and key people in each,
    transition to explain_features. Don't aim for perfection — they can
    always add more later.
    
    IMPORTANT: Track circles and people discussed in your state. The
    extractCirclesAndPeople function will pull these from the conversation.
  `,

  explain_features: `
    The user has shared their world with you. Now show them what you can do.
    
    Your goal: Brief, practical overview of your capabilities. Not a feature
    list — show them through the lens of what they just told you.
    
    Key features to mention naturally:
    - Nudges: "I'll ping you when someone's slipping off your radar"
    - Check-ins: "You can text me anytime to see who's overdue"
    - Brain dumps: "Had a great lunch with someone? Just text me about it
      and I'll log it"
    - Drafting: "Stuck on what to say? I'll help you draft something"
    
    Use THEIR people as examples. "So when it's been two weeks since you
    talked to Jake, I'll give you a nudge. Nothing annoying — just a heads up."
    
    Don't over-explain. Don't list everything. Hit the highlights and let
    them discover the rest naturally.
    
    When done, transition to ready. The user is oriented and good to go.
  `,

  ready: `
    Onboarding is complete. The user is oriented and ready to use the system.
    
    This is your "welcome to the real thing" moment. Keep it brief and warm.
    Maybe reference something specific they shared during onboarding.
    
    End with something actionable — not a generic "let me know if you need
    anything" but a specific suggestion based on what you learned.
    Like: "Your mom hasn't heard from you in a bit — want me to nudge you
    about that tomorrow morning?"
    
    This is the last onboarding message. After this, they're in the normal
    conversation flow.
  `,
};

// ===========================================================================
// Onboarding Service
// ===========================================================================

/**
 * Initialize onboarding state after web signup.
 *
 * Called when the web signup form is completed. Creates the initial state
 * and triggers Bethany's intro message via SendBlue.
 *
 * @param env     - Worker environment bindings
 * @param userId  - The new user's ID (from completeSignup)
 * @param phone   - User's phone number (E.164)
 * @param name    - User's name (from signup form)
 * @param email   - User's email (from signup form)
 * @returns The intro message text and SendBlue message ID
 */
export async function initializeOnboarding(
  env: Env,
  userId: string,
  phone: string,
  name: string,
  email: string | null,
): Promise<{ introMessage: string; messageId: string; state: OnboardingConversationState }> {
  const now = new Date().toISOString();

  // Generate Bethany's intro message
  const introMessage = await generateIntroMessage(env, name);

  // Send via SendBlue (this also registers the contact for inbound routing)
  const messageId = await sendViaSendBlue(env, phone, introMessage);

  // Create initial onboarding state
  const state: OnboardingConversationState = {
    phone,
    userId,
    email,
    stage: 'intro_sent',
    name,
    circlesDiscussed: [],
    peopleDiscussed: [],
    messages: [
      {
        role: 'bethany',
        content: introMessage,
        timestamp: now,
      },
    ],
    startedAt: now,
    lastMessageAt: now,
    introMessageId: messageId,
  };

  // Store in Durable Object
  await storeOnboardingState(env, phone, state);

  return { introMessage, messageId, state };
}

/**
 * Handle an inbound SMS during onboarding.
 *
 * This is the main entry point called by the SMS router when it
 * identifies a message from a user in the onboarding flow.
 *
 * @param env       - Worker environment bindings
 * @param phone     - Sender's phone number (E.164)
 * @param body      - Message text
 * @param userId    - The user's ID
 * @returns Bethany's response and the updated stage
 */
export async function handleOnboardingMessage(
  env: Env,
  phone: string,
  body: string,
  userId: string,
): Promise<{ response: string; stage: PostSignupStage; isComplete: boolean }> {
  // Load current state
  let state = await loadOnboardingState(env, phone);

  if (!state) {
    // Edge case: state was lost (DO eviction, etc.)
    // Recreate with minimal info
    console.warn(`[onboarding] State not found for ${phone}, reconstructing`);
    state = await reconstructState(env, phone, userId);
  }

  // Record the inbound message
  const now = new Date().toISOString();
  state.messages.push({
    role: 'user',
    content: body,
    timestamp: now,
  });
  state.lastMessageAt = now;

  // Determine next stage
  const nextStage = determineNextStage(state, body);

  if (nextStage && canTransition(state.stage, nextStage)) {
    state.stage = nextStage;
  }

  // Generate Bethany's response for the current stage
  const response = await generateBethanyResponse(env, state);

  // Record outbound message
  state.messages.push({
    role: 'bethany',
    content: response,
    timestamp: new Date().toISOString(),
  });

  // Extract circles and people from conversation if in learn_circles
  if (state.stage === 'learn_circles' || state.stage === 'explain_features') {
    const extracted = await extractCirclesAndPeople(env, state);
    state.circlesDiscussed = extracted.circles;
    state.peopleDiscussed = extracted.people;
  }

  // Send the response
  await sendViaSendBlue(env, phone, response);

  // Check if onboarding is complete
  const isComplete = state.stage === 'ready';

  if (isComplete) {
    // Finalize: write circles to D1, archive state
    await finalizeOnboarding(env, state);
  }

  // Persist updated state
  await storeOnboardingState(env, phone, state);

  return { response, stage: state.stage, isComplete };
}

// ===========================================================================
// Stage Determination
// ===========================================================================

/**
 * Determine if the conversation should advance to the next stage.
 *
 * This is intentionally simple. The AI generates responses that
 * naturally guide the conversation, and the stage transitions are
 * based on what's been accomplished — not rigid turn counts.
 *
 * The AI itself signals readiness by including transition markers
 * in its response metadata (not shown to user).
 */
function determineNextStage(
  state: OnboardingConversationState,
  _userMessage: string,
): PostSignupStage | null {
  const messageCount = state.messages.filter(m => m.role === 'user').length;

  switch (state.stage) {
    case 'intro_sent':
      // Any reply from user triggers transition
      return 'user_replies';

    case 'user_replies':
      // After user has shared some initial info (at least 1 exchange),
      // transition to learning circles. The AI prompt handles the
      // conversational bridge.
      if (messageCount >= 2) {
        return 'learn_circles';
      }
      return null;

    case 'learn_circles':
      // Transition when we have enough material.
      // At least 2 circles discussed or 3+ exchanges in this stage.
      if (
        state.circlesDiscussed.length >= 2 ||
        messageCount >= 5
      ) {
        return 'explain_features';
      }
      return null;

    case 'explain_features':
      // After explaining, any acknowledgment moves to ready.
      if (messageCount >= 7) {
        return 'ready';
      }
      return null;

    case 'ready':
      return null; // Terminal
  }
}

// ===========================================================================
// AI Response Generation
// ===========================================================================

/**
 * Generate Bethany's intro message for a new signup.
 *
 * This is the very first message — sent via SendBlue right after
 * web signup. It should feel personal, not automated.
 */
async function generateIntroMessage(
  env: Env,
  name: string,
): Promise<string> {
  const systemPrompt = `
    You are Bethany. A user named ${name} just signed up to use your
    network management service. Send them your very first message via text.
    
    This is critical — it's your first impression. Make it:
    - Short (2-4 sentences max for a text message)
    - Warm and real (not corporate, not robotic)
    - Curious about them (end with something that invites a reply)
    - Reference that they just signed up (they're expecting this)
    
    Do NOT list features. Do NOT be overly excited. Be yourself —
    a real person who's genuinely glad they signed up and curious
    about who matters to them.
    
    Remember: this is an SMS/iMessage. Keep it text-message length.
  `;

  return callAnthropicAPI(env, systemPrompt, []);
}

/**
 * Generate Bethany's response for the current onboarding stage.
 *
 * Combines Bethany's personality config with the stage-specific prompt
 * and the full conversation history.
 */
async function generateBethanyResponse(
  env: Env,
  state: OnboardingConversationState,
): Promise<string> {
  const stagePrompt = STAGE_PROMPTS[state.stage];

  const systemPrompt = `
    You are Bethany — a romance novelist and relationship network manager.
    You're in the middle of an onboarding conversation with ${state.name}.
    
    Current stage: ${state.stage}
    Circles discussed so far: ${JSON.stringify(state.circlesDiscussed)}
    People discussed so far: ${JSON.stringify(state.peopleDiscussed.map(p => p.name))}
    
    STAGE GUIDANCE:
    ${stagePrompt}
    
    CRITICAL RULES FOR SMS:
    - Keep responses to 2-4 sentences. This is a text conversation.
    - Never send walls of text.
    - One question at a time, max.
    - Sound like a real person texting, not an AI assistant.
    - Use Bethany's actual voice: warm, sharp, real.
    - Fragments are fine. Complete sentences are for emails.
    - Emojis: one max per message, many messages have none.
    
    Respond ONLY with Bethany's next message. No metadata, no stage markers,
    no explanatory text. Just her words.
  `;

  // Convert state messages to Anthropic message format
  const messages = state.messages.map(m => ({
    role: m.role === 'bethany' ? 'assistant' as const : 'user' as const,
    content: m.content,
  }));

  return callAnthropicAPI(env, systemPrompt, messages);
}

// ===========================================================================
// Circle & People Extraction
// ===========================================================================

/**
 * Extract circles and people discussed from the conversation.
 *
 * Uses Claude to analyze the conversation and pull out structured data.
 * This runs after each message in learn_circles and explain_features.
 */
async function extractCirclesAndPeople(
  env: Env,
  state: OnboardingConversationState,
): Promise<{
  circles: string[];
  people: OnboardingConversationState['peopleDiscussed'];
}> {
  const conversationText = state.messages
    .map(m => `${m.role === 'bethany' ? 'Bethany' : state.name}: ${m.content}`)
    .join('\n');

  const systemPrompt = `
    Analyze this conversation and extract:
    1. Circle names mentioned or implied (e.g., "Family", "College Friends", "Work Team")
    2. Specific people mentioned with their relationship and which circle they fit
    
    Respond ONLY with valid JSON in this exact format:
    {
      "circles": ["Family", "College Friends"],
      "people": [
        {"name": "Emily", "relationship": "sister", "circle": "Family"},
        {"name": "Jake", "relationship": "college roommate", "circle": "College Friends"}
      ]
    }
    
    Rules:
    - Include default circles (Family, Friends, Work, Community) only if actually discussed
    - Include custom circles if the user mentions specific groups
    - Only include people the USER mentioned, not Bethany's examples
    - If uncertain about a circle for a person, omit the circle field
    - Return empty arrays if nothing concrete was discussed yet
  `;

  const messages = [{
    role: 'user' as const,
    content: conversationText,
  }];

  try {
    const responseText = await callAnthropicAPI(env, systemPrompt, messages);
    // Strip any markdown fencing
    const cleaned = responseText.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      circles: Array.isArray(parsed.circles) ? parsed.circles : [],
      people: Array.isArray(parsed.people) ? parsed.people : [],
    };
  } catch (err) {
    console.error('[onboarding] Extraction failed:', err);
    return { circles: state.circlesDiscussed, people: state.peopleDiscussed };
  }
}

// ===========================================================================
// Finalization
// ===========================================================================

/**
 * Finalize onboarding — write discovered data to D1 and archive state.
 *
 * Called when the stage reaches 'ready'. This bridges the conversational
 * data back into the structured system:
 *   - Creates custom circles in D1
 *   - Creates contacts for discussed people
 *   - Archives the conversation to R2
 *   - Marks the user as onboarding-complete
 */
async function finalizeOnboarding(
  env: Env,
  state: OnboardingConversationState,
): Promise<void> {
  const db = env.DB;
  const now = new Date().toISOString();

  // 1. Create custom circles (defaults already exist from signup)
  const defaultNames = new Set(['family', 'friends', 'work', 'community']);

  for (const circleName of state.circlesDiscussed) {
    if (!defaultNames.has(circleName.toLowerCase().trim())) {
      try {
        const id = crypto.randomUUID();
        await db.prepare(
          `INSERT INTO circles (id, user_id, name, type, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, 'custom', 99, ?, ?)`
        ).bind(id, state.userId, circleName.trim(), now, now).run();
      } catch {
        // Duplicate or other error — non-fatal
      }
    }
  }

  // 2. Create contact stubs for discussed people
  for (const person of state.peopleDiscussed) {
    try {
      const contactId = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO contacts
          (id, user_id, name, intent, health_status, contact_kind, source, archived, created_at, updated_at)
         VALUES (?, ?, ?, 'new', 'green', 'non_kin', 'onboarding', 0, ?, ?)`
      ).bind(contactId, state.userId, person.name, now, now).run();

      // Link to circle if identified
      if (person.circle) {
        const circle = await db.prepare(
          `SELECT id FROM circles WHERE user_id = ? AND LOWER(name) = LOWER(?)`
        ).bind(state.userId, person.circle).first<{ id: string }>();

        if (circle) {
          await db.prepare(
            `INSERT INTO contact_circles (contact_id, circle_id, added_at) VALUES (?, ?, ?)`
          ).bind(contactId, circle.id, now).run();
        }
      }
    } catch {
      // Non-fatal — user can always add contacts manually
    }
  }

  // 3. Archive conversation to R2
  try {
    const archiveKey = `onboarding/${state.userId}/${state.startedAt}.json`;
    await env.STORAGE.put(archiveKey, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[onboarding] R2 archive failed:', err);
  }

  console.log(
    `[onboarding] Finalized for ${state.name} (${state.phone}). ` +
    `Circles: ${state.circlesDiscussed.length}, People: ${state.peopleDiscussed.length}`
  );
}

// ===========================================================================
// Durable Object State Management
// ===========================================================================

/**
 * Store onboarding state in the Durable Object.
 *
 * The DO is keyed by phone number. This ensures single-writer access
 * and prevents race conditions from rapid messages.
 *
 * Implementation note: The actual Durable Object class is defined
 * separately (see OnboardingDO below). These helpers abstract the
 * fetch-based communication with the DO.
 */
async function storeOnboardingState(
  env: Env,
  phone: string,
  state: OnboardingConversationState,
): Promise<void> {
  const doId = (env as any).ONBOARDING_DO.idFromName(phone);
  const doStub = (env as any).ONBOARDING_DO.get(doId);
  await doStub.fetch(new Request('https://do/state', {
    method: 'PUT',
    body: JSON.stringify(state),
  }));
}

/**
 * Load onboarding state from the Durable Object.
 */
async function loadOnboardingState(
  env: Env,
  phone: string,
): Promise<OnboardingConversationState | null> {
  const doId = (env as any).ONBOARDING_DO.idFromName(phone);
  const doStub = (env as any).ONBOARDING_DO.get(doId);
  const response = await doStub.fetch(new Request('https://do/state'));

  if (response.status === 404) return null;
  return response.json();
}

/**
 * Reconstruct minimal state when DO state is lost.
 *
 * This is a safety net — pulls what we can from D1 and starts
 * the conversation at a reasonable point.
 */
async function reconstructState(
  env: Env,
  phone: string,
  userId: string,
): Promise<OnboardingConversationState> {
  const user = await env.DB.prepare(
    'SELECT name, email FROM users WHERE id = ?'
  ).bind(userId).first<{ name: string; email: string | null }>();

  const now = new Date().toISOString();
  return {
    phone,
    userId,
    email: user?.email ?? null,
    stage: 'user_replies', // Assume intro was sent
    name: user?.name ?? 'there',
    circlesDiscussed: [],
    peopleDiscussed: [],
    messages: [],
    startedAt: now,
    lastMessageAt: now,
  };
}

// ===========================================================================
// SendBlue Integration
// ===========================================================================

/**
 * Send an SMS via SendBlue.
 *
 * Uses the send-message endpoint. On SendBlue's standard plan,
 * sending a message to a number also registers it for inbound
 * webhook routing — which is why the intro message is critical.
 *
 * @returns SendBlue message ID
 */
async function sendViaSendBlue(
  env: Env,
  phone: string,
  message: string,
): Promise<string> {
  const response = await fetch('https://api.sendblue.co/api/send-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'sb-api-key-id': env.SENDBLUE_API_KEY,
      'sb-api-secret-key': env.SENDBLUE_API_SECRET,
    },
    body: JSON.stringify({
      number: phone,
      content: message,
      send_style: 'invisible', // No typing indicator
      from_number: env.SENDBLUE_PHONE_NUMBER,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[sendblue] Send failed: ${response.status} — ${errorBody}`);
    throw new Error(`SendBlue send failed: ${response.status}`);
  }

  const result = await response.json() as { message_id?: string; id?: string };
  return result.message_id || result.id || 'unknown';
}

// ===========================================================================
// Anthropic API
// ===========================================================================

/**
 * Call the Anthropic API for response generation.
 *
 * Uses Claude Sonnet for onboarding conversations — fast enough for
 * SMS response times, smart enough for natural conversation.
 */
async function callAnthropicAPI(
  env: Env,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300, // SMS messages should be short
      system: systemPrompt,
      messages: messages.length > 0 ? messages : [
        { role: 'user', content: '(generate the message)' },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[anthropic] API error: ${response.status} — ${errorBody}`);
    throw new Error(`Anthropic API failed: ${response.status}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const textBlock = data.content.find(b => b.type === 'text');
  return textBlock?.text?.trim() ?? 'Hey! Something went wrong on my end. Text me again?';
}

// ===========================================================================
// Durable Object Class
// ===========================================================================

/**
 * OnboardingDO — Durable Object for onboarding conversation state.
 *
 * Provides single-writer access to a user's onboarding state,
 * keyed by phone number. Handles GET (load) and PUT (store) requests.
 *
 * Wrangler config:
 *   [[durable_objects.bindings]]
 *   name = "ONBOARDING_DO"
 *   class_name = "OnboardingDO"
 */
export class OnboardingDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/state') {
      if (request.method === 'GET') {
        const data = await this.state.storage.get<OnboardingConversationState>('state');
        if (!data) {
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PUT') {
        const body = await request.json() as OnboardingConversationState;
        await this.state.storage.put('state', body);
        return new Response('ok', { status: 200 });
      }

      if (request.method === 'DELETE') {
        await this.state.storage.delete('state');
        return new Response('ok', { status: 200 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}
