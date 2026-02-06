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
 * STATE STORAGE:
 *   Conversation state lives in a Durable Object keyed by phone number.
 *
 * @see shared/models.ts for OnboardingStage, OnboardingState
 * @see docs/personality-config.md for Bethany's voice
 * @see worker/routes/sms.ts for routing into this service
 */

import type { Env } from '../../shared/types';
import type { OnboardingState } from '../../shared/models';

// ===========================================================================
// Updated Stage Type
// ===========================================================================

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
  userId: string;
  email: string | null;
  stage: PostSignupStage;
  name: string;
  circlesDiscussed: string[];
  peopleDiscussed: Array<{
    name: string;
    relationship?: string;
    circle?: string;
    notes?: string;
  }>;
  messages: Array<{
    role: 'user' | 'bethany';
    content: string;
    timestamp: string;
  }>;
  startedAt: string;
  lastMessageAt: string;
  introMessageId?: string;
}

// ===========================================================================
// Stage Transition Rules
// ===========================================================================

const VALID_TRANSITIONS: Record<PostSignupStage, PostSignupStage | null> = {
  intro_sent: 'user_replies',
  user_replies: 'learn_circles',
  learn_circles: 'explain_features',
  explain_features: 'ready',
  ready: null,
};

export function canTransition(from: PostSignupStage, to: PostSignupStage): boolean {
  return VALID_TRANSITIONS[from] === to;
}

// ===========================================================================
// Stage-Specific System Prompts
// ===========================================================================

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
    
    Use THEIR people as examples.
    
    When done, transition to ready. The user is oriented and good to go.
  `,

  ready: `
    Onboarding is complete. The user is oriented and ready to use the system.
    
    This is your "welcome to the real thing" moment. Keep it brief and warm.
    Maybe reference something specific they shared during onboarding.
    
    End with something actionable — not a generic "let me know if you need
    anything" but a specific suggestion based on what you learned.
    
    This is the last onboarding message. After this, they're in the normal
    conversation flow.
  `,
};

// ===========================================================================
// Onboarding Service
// ===========================================================================

export async function initializeOnboarding(
  env: Env,
  userId: string,
  phone: string,
  name: string,
  email: string | null,
): Promise<{ introMessage: string; messageId: string; state: OnboardingConversationState }> {
  const now = new Date().toISOString();

  const introMessage = await generateIntroMessage(env, name);
  const messageId = await sendViaSendBlue(env, phone, introMessage);

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

  await storeOnboardingState(env, phone, state);

  return { introMessage, messageId, state };
}

export async function handleOnboardingMessage(
  env: Env,
  phone: string,
  body: string,
  userId: string,
): Promise<{ response: string; stage: PostSignupStage; isComplete: boolean }> {
  let state = await loadOnboardingState(env, phone);

  if (!state) {
    console.warn(`[onboarding] State not found for ${phone}, reconstructing`);
    state = await reconstructState(env, phone, userId);
  }

  const now = new Date().toISOString();
  state.messages.push({
    role: 'user',
    content: body,
    timestamp: now,
  });
  state.lastMessageAt = now;

  const nextStage = determineNextStage(state, body);

  if (nextStage && canTransition(state.stage, nextStage)) {
    state.stage = nextStage;
  }

  const response = await generateBethanyResponse(env, state);

  state.messages.push({
    role: 'bethany',
    content: response,
    timestamp: new Date().toISOString(),
  });

  if (state.stage === 'learn_circles' || state.stage === 'explain_features') {
    const extracted = await extractCirclesAndPeople(env, state);
    state.circlesDiscussed = extracted.circles;
    state.peopleDiscussed = extracted.people;
  }

  await sendViaSendBlue(env, phone, response);

  const isComplete = state.stage === 'ready';

  if (isComplete) {
    await finalizeOnboarding(env, state);
  }

  await storeOnboardingState(env, phone, state);

  return { response, stage: state.stage, isComplete };
}

// ===========================================================================
// Stage Determination
// ===========================================================================

function determineNextStage(
  state: OnboardingConversationState,
  _userMessage: string,
): PostSignupStage | null {
  const messageCount = state.messages.filter(m => m.role === 'user').length;

  switch (state.stage) {
    case 'intro_sent':
      return 'user_replies';

    case 'user_replies':
      if (messageCount >= 2) {
        return 'learn_circles';
      }
      return null;

    case 'learn_circles':
      if (state.circlesDiscussed.length >= 2 || messageCount >= 5) {
        return 'explain_features';
      }
      return null;

    case 'explain_features':
      if (messageCount >= 7) {
        return 'ready';
      }
      return null;

    case 'ready':
      return null;
  }
}

// ===========================================================================
// AI Response Generation
// ===========================================================================

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

  const messages = state.messages.map(m => ({
    role: m.role === 'bethany' ? 'assistant' as const : 'user' as const,
    content: m.content,
  }));

  return callAnthropicAPI(env, systemPrompt, messages);
}

// ===========================================================================
// Circle & People Extraction
// ===========================================================================

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

async function finalizeOnboarding(
  env: Env,
  state: OnboardingConversationState,
): Promise<void> {
  const db = env.DB;
  const now = new Date().toISOString();

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

  for (const person of state.peopleDiscussed) {
    try {
      const contactId = crypto.randomUUID();
      await db.prepare(
        `INSERT INTO contacts
          (id, user_id, name, intent, health_status, contact_kind, source, archived, created_at, updated_at)
         VALUES (?, ?, ?, 'new', 'green', 'non_kin', 'onboarding', 0, ?, ?)`
      ).bind(contactId, state.userId, person.name, now, now).run();

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
      // Non-fatal
    }
  }

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
    stage: 'user_replies',
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
      max_tokens: 300,
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
