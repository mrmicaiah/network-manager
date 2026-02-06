/**
 * User Discovery Service — SMS-first onboarding for unknown numbers.
 *
 * FLOW:
 *
 *   1. Unknown phone number texts Bethany
 *   2. Bethany: "Hey! I don't think we've met. I'm Bethany..."
 *   3. User shares their name
 *   4. Bethany learns about them — what they do, why they're texting
 *   5. Discovery conversation about their network/circles
 *   6. Bethany sells the value: "I can help you keep track of all these people..."
 *   7. When ready, generate signup token and send link
 *
 * This is the PRE-SIGNUP discovery flow. After the user clicks the signup
 * link and completes web registration, they enter the POST-SIGNUP onboarding
 * flow (see onboarding-service.ts).
 *
 * STATE STORAGE:
 *   Discovery state lives in a Durable Object keyed by phone number.
 *   This is SEPARATE from the post-signup OnboardingDO — we use
 *   UserDiscoveryDO for pre-signup conversations.
 *
 *   Discovery state is temporary. When the user completes signup:
 *   - Name, circles, people are carried into pending_signups
 *   - Discovery DO state is archived to R2
 *   - The signup token bridges discovery → registration → onboarding
 *
 * BETHANY'S VOICE:
 *   This is Bethany's first impression with strangers. She should be:
 *   - Warm but not over-eager
 *   - Curious about THEM, not talking about herself
 *   - Brief (it's SMS, not email)
 *   - Natural — this should feel like meeting someone at a party
 *
 * @see worker/services/signup-service.ts for token generation
 * @see worker/services/onboarding-service.ts for post-signup flow
 */

import type { Env } from '../../shared/types';
import { createPendingSignup, type CreatePendingSignupInput } from './signup-service';

// ===========================================================================
// Discovery Stages
// ===========================================================================

/**
 * Pre-signup discovery stages.
 *
 * intro              — First contact. Bethany introduces herself, asks name.
 * learn_name         — Getting to know who they are.
 * learn_about        — Understanding their world, what they do.
 * discover_circles   — Learning about the people in their life.
 * sell_value         — Explaining how Bethany can help.
 * send_signup        — Ready to sign up — sending the link.
 * waiting_signup     — Link sent, waiting for web completion.
 */
export type DiscoveryStage =
  | 'intro'
  | 'learn_name'
  | 'learn_about'
  | 'discover_circles'
  | 'sell_value'
  | 'send_signup'
  | 'waiting_signup';

// ===========================================================================
// Discovery State
// ===========================================================================

export interface DiscoveryConversationState {
  phone: string;
  stage: DiscoveryStage;
  name: string | null;
  whatTheyDo: string | null;          // Job, role, or life situation
  whyTheyTexted: string | null;       // What brought them here
  circlesDiscussed: string[];         // Circle names identified
  peopleDiscussed: Array<{            // Specific people mentioned
    name: string;
    relationship?: string;
    circle?: string;
    notes?: string;
  }>;
  painPoints: string[];               // What they struggle with
  messages: Array<{
    role: 'user' | 'bethany';
    content: string;
    timestamp: string;
  }>;
  signupToken: string | null;         // Set when signup link is sent
  signupUrl: string | null;
  startedAt: string;
  lastMessageAt: string;
}

// ===========================================================================
// Stage Prompts
// ===========================================================================

/**
 * Stage-specific guidance for Bethany's responses.
 * Combined with her personality config for each AI call.
 */
const STAGE_PROMPTS: Record<DiscoveryStage, string> = {
  intro: `
    You're texting with a complete stranger who just reached out.
    You have NO idea who they are or why they're texting.
    
    Your goal: Introduce yourself warmly and ask who they are.
    
    Key points:
    - You're Bethany — you help people stay on top of their relationships
    - You don't know them yet — be curious, not presumptuous
    - Ask for their name naturally
    
    Keep it SHORT. This is a text message. 2-3 sentences max.
    Don't launch into a pitch. Just say hi and ask who you're talking to.
    
    Example energy (don't copy exactly):
    "Hey! I don't think we've met — I'm Bethany. I help people keep track of
    the relationships that matter to them. Who am I texting with?"
  `,

  learn_name: `
    The user just told you their name (or something about themselves).
    
    Your goal: Acknowledge their name warmly, then learn more about them.
    
    Ask ONE follow-up question. Good options:
    - What do they do? (job, life situation)
    - What brought them to you? (how did they hear about you)
    - Who are they trying to stay connected with?
    
    Stay curious and conversational. Don't be an intake form.
    1-2 sentences. This is texting, not email.
  `,

  learn_about: `
    You know their name and are learning about their world.
    
    Your goal: Understand their situation. Are they...
    - A busy professional losing touch with friends?
    - Someone trying to maintain family connections?
    - A networker who meets too many people to remember?
    - Someone rebuilding relationships after a life change?
    
    Listen for pain points. When they mention struggles, acknowledge them.
    When they mention specific people, remember those names.
    
    Guide naturally toward talking about WHO matters to them.
    Don't rush — this is a real conversation.
    
    2-3 sentences max. One question at a time.
  `,

  discover_circles: `
    You're in the discovery phase — learning who matters to this person.
    
    Your goal: Map out their relationship world. Listen for:
    - Specific people and relationships ("my sister Emily", "college buddy Jake")
    - Natural groupings ("my work team", "the friend group I never see")
    - Emotional weight ("I really need to call my mom more")
    - Pain points ("I'm terrible at staying in touch")
    
    Reflect back what you're hearing. Group people into circles naturally.
    "Sounds like you've got your family core — Mom and Emily — and then
    this work crew you're trying to not lose touch with."
    
    Ask about gaps: "Anyone else in that inner ring?"
    
    Don't try to capture everyone. Get the shape of their world.
    2-3 sentences. One question max.
  `,

  sell_value: `
    You've learned enough about their world. Time to show value.
    
    Your goal: Connect what you do to what THEY told you.
    
    Don't list features. Use THEIR people, THEIR pain points:
    "Sounds like you've got a lot going on. Here's what I can do for you —
    I'll nudge you when someone's slipping off your radar. Like when it's
    been two weeks since you talked to Jake. Nothing annoying, just a heads up."
    
    Keep it concrete and brief. One or two capabilities, framed as help.
    
    End with moving toward signup: "Want to get set up? I can send you
    a quick link to create your dashboard."
    
    2-3 sentences. Make them want to try it.
  `,

  send_signup: `
    The user is ready (or seems ready) to sign up.
    
    Your goal: Generate and send the signup link.
    
    Keep it simple and clear:
    "Here's your link: [URL]. Takes about 30 seconds — just need your
    email to get you set up. I'll be here when you're done."
    
    The URL will be injected by the system. Just include [URL] as placeholder
    or structure your message expecting the URL to be appended.
    
    Don't over-explain. The link speaks for itself.
    1-2 sentences plus the link.
  `,

  waiting_signup: `
    You've sent the signup link and are waiting for them to complete it.
    
    If they text again without signing up, you can:
    - Gently remind them about the link
    - Answer questions about what happens next
    - Resend the link if they ask
    - Continue the conversation casually
    
    Don't be pushy. They'll sign up when ready.
    If they seem to have forgotten, one gentle reminder is fine.
    
    Keep responses brief and helpful.
  `,
};

// ===========================================================================
// Main Entry Point
// ===========================================================================

/**
 * Handle an inbound SMS from an unknown number.
 *
 * This is called by the SMS router when:
 *   1. Phone number is not in the users table
 *   2. Phone number is not in an active pending_signups record
 *
 * @param env   - Worker environment bindings
 * @param phone - Sender's phone number (E.164)
 * @param body  - Message text
 * @returns Bethany's response and the current stage
 */
export async function handleDiscoveryMessage(
  env: Env,
  phone: string,
  body: string,
): Promise<{
  response: string;
  stage: DiscoveryStage;
  signupUrl: string | null;
}> {
  // Load or create discovery state
  let state = await loadDiscoveryState(env, phone);

  if (!state) {
    // First message from this number — start fresh
    state = createInitialState(phone);
  }

  // Record the inbound message
  const now = new Date().toISOString();
  state.messages.push({
    role: 'user',
    content: body,
    timestamp: now,
  });
  state.lastMessageAt = now;

  // Determine stage transitions
  const nextStage = await determineNextStage(env, state, body);
  if (nextStage && nextStage !== state.stage) {
    state.stage = nextStage;
  }

  // Handle signup link generation if we've reached that stage
  let signupUrl: string | null = null;
  if (state.stage === 'send_signup' && !state.signupToken) {
    const signupResult = await generateSignupLink(env, state);
    state.signupToken = signupResult.token;
    state.signupUrl = signupResult.url;
    signupUrl = signupResult.url;
  }

  // Generate Bethany's response
  let response = await generateBethanyResponse(env, state);

  // Inject signup URL if needed
  if (signupUrl && (state.stage === 'send_signup' || state.stage === 'waiting_signup')) {
    // Append URL if Bethany didn't include a placeholder
    if (!response.includes(signupUrl) && !response.includes('[URL]')) {
      response = response.replace(/\.$/, '') + ': ' + signupUrl;
    } else {
      response = response.replace('[URL]', signupUrl);
    }

    // Move to waiting stage
    state.stage = 'waiting_signup';
  }

  // Record Bethany's response
  state.messages.push({
    role: 'bethany',
    content: response,
    timestamp: new Date().toISOString(),
  });

  // Extract learnings from conversation
  if (['learn_name', 'learn_about', 'discover_circles'].includes(state.stage)) {
    const extracted = await extractLearnings(env, state);
    if (extracted.name) state.name = extracted.name;
    if (extracted.whatTheyDo) state.whatTheyDo = extracted.whatTheyDo;
    if (extracted.circles.length > 0) state.circlesDiscussed = extracted.circles;
    if (extracted.people.length > 0) state.peopleDiscussed = extracted.people;
    if (extracted.painPoints.length > 0) state.painPoints = extracted.painPoints;
  }

  // Send the response via SendBlue
  await sendViaSendBlue(env, phone, response);

  // Persist state
  await storeDiscoveryState(env, phone, state);

  return {
    response,
    stage: state.stage,
    signupUrl: state.signupUrl,
  };
}

// ===========================================================================
// State Management
// ===========================================================================

/**
 * Create initial discovery state for a new unknown number.
 */
function createInitialState(phone: string): DiscoveryConversationState {
  const now = new Date().toISOString();
  return {
    phone,
    stage: 'intro',
    name: null,
    whatTheyDo: null,
    whyTheyTexted: null,
    circlesDiscussed: [],
    peopleDiscussed: [],
    painPoints: [],
    messages: [],
    signupToken: null,
    signupUrl: null,
    startedAt: now,
    lastMessageAt: now,
  };
}

/**
 * Load discovery state from Durable Object.
 */
async function loadDiscoveryState(
  env: Env,
  phone: string,
): Promise<DiscoveryConversationState | null> {
  try {
    const doId = (env as any).USER_DISCOVERY_DO.idFromName(phone);
    const doStub = (env as any).USER_DISCOVERY_DO.get(doId);
    const response = await doStub.fetch(new Request('https://do/state'));

    if (response.status === 404) return null;
    return response.json();
  } catch (err) {
    console.error('[discovery] Failed to load state:', err);
    return null;
  }
}

/**
 * Store discovery state in Durable Object.
 */
async function storeDiscoveryState(
  env: Env,
  phone: string,
  state: DiscoveryConversationState,
): Promise<void> {
  try {
    const doId = (env as any).USER_DISCOVERY_DO.idFromName(phone);
    const doStub = (env as any).USER_DISCOVERY_DO.get(doId);
    await doStub.fetch(new Request('https://do/state', {
      method: 'PUT',
      body: JSON.stringify(state),
    }));
  } catch (err) {
    console.error('[discovery] Failed to store state:', err);
  }
}

/**
 * Archive discovery state to R2 after signup completion.
 * Called when the signup token is consumed.
 */
export async function archiveDiscoveryState(
  env: Env,
  phone: string,
): Promise<void> {
  const state = await loadDiscoveryState(env, phone);
  if (!state) return;

  try {
    const archiveKey = `discovery/${phone}/${state.startedAt}.json`;
    await env.STORAGE.put(archiveKey, JSON.stringify(state, null, 2));

    // Clear the DO state
    const doId = (env as any).USER_DISCOVERY_DO.idFromName(phone);
    const doStub = (env as any).USER_DISCOVERY_DO.get(doId);
    await doStub.fetch(new Request('https://do/state', { method: 'DELETE' }));
  } catch (err) {
    console.error('[discovery] Archive failed:', err);
  }
}

// ===========================================================================
// Stage Transitions
// ===========================================================================

/**
 * Determine if we should advance to the next stage.
 *
 * Uses a combination of message counts and AI analysis.
 * The conversation should flow naturally — stages are guides, not walls.
 */
async function determineNextStage(
  env: Env,
  state: DiscoveryConversationState,
  userMessage: string,
): Promise<DiscoveryStage | null> {
  const userMessageCount = state.messages.filter(m => m.role === 'user').length;
  const lowerMessage = userMessage.toLowerCase();

  switch (state.stage) {
    case 'intro':
      // Any response from user after intro moves to learn_name
      return 'learn_name';

    case 'learn_name':
      // Once we have a name (AI will extract it), move to learn_about
      // This happens after 1-2 exchanges typically
      if (userMessageCount >= 2 || state.name) {
        return 'learn_about';
      }
      return null;

    case 'learn_about':
      // After learning about them, move to circle discovery
      // 2-3 exchanges is usually enough
      if (userMessageCount >= 4 || state.whatTheyDo) {
        return 'discover_circles';
      }
      return null;

    case 'discover_circles':
      // Once we have some circles/people, move to selling value
      // Or after 3+ exchanges in this stage
      const circleExchanges = userMessageCount - 4; // Rough count
      if (
        state.circlesDiscussed.length >= 2 ||
        state.peopleDiscussed.length >= 3 ||
        circleExchanges >= 3
      ) {
        return 'sell_value';
      }
      return null;

    case 'sell_value':
      // If they express interest or ask for the link, send it
      const readySignals = [
        'yes', 'yeah', 'sure', 'let\'s do it', 'sign me up', 'sounds good',
        'i\'m in', 'link', 'send it', 'okay', 'ok', 'ready', 'let\'s go',
        'how do i', 'get started', 'try it', 'interested',
      ];

      if (readySignals.some(signal => lowerMessage.includes(signal))) {
        return 'send_signup';
      }
      // After another exchange, try again to move toward signup
      return null;

    case 'send_signup':
      // Immediately transition to waiting after sending
      return 'waiting_signup';

    case 'waiting_signup':
      // Check if they're asking for the link again
      if (lowerMessage.includes('link') || lowerMessage.includes('again')) {
        return 'send_signup'; // Resend
      }
      return null;
  }

  return null;
}

// ===========================================================================
// Signup Link Generation
// ===========================================================================

/**
 * Generate a signup link for this user.
 * Bridges discovery data into pending_signups.
 */
async function generateSignupLink(
  env: Env,
  state: DiscoveryConversationState,
): Promise<{ token: string; url: string }> {
  const input: CreatePendingSignupInput = {
    phone: state.phone,
    name: state.name,
    circlesDiscussed: state.circlesDiscussed,
    onboardingContext: {
      whatTheyDo: state.whatTheyDo,
      whyTheyTexted: state.whyTheyTexted,
      peopleDiscussed: state.peopleDiscussed,
      painPoints: state.painPoints,
      discoveryConversationLength: state.messages.length,
    },
  };

  const { signupUrl, signup } = await createPendingSignup(
    env.DB,
    input,
    env.SIGNUP_BASE_URL,
  );

  return {
    token: signup.token,
    url: signupUrl,
  };
}

// ===========================================================================
// AI Response Generation
// ===========================================================================

/**
 * Generate Bethany's response for the current discovery stage.
 */
async function generateBethanyResponse(
  env: Env,
  state: DiscoveryConversationState,
): Promise<string> {
  const stagePrompt = STAGE_PROMPTS[state.stage];

  const systemPrompt = `
    You are Bethany — a romance novelist who also helps people manage their
    relationship networks. You're texting with someone new.
    
    Current stage: ${state.stage}
    Their name: ${state.name ?? 'Unknown'}
    What they do: ${state.whatTheyDo ?? 'Unknown'}
    Circles discussed: ${JSON.stringify(state.circlesDiscussed)}
    People discussed: ${JSON.stringify(state.peopleDiscussed.map(p => `${p.name} (${p.relationship || 'unknown relationship'})`).join(', ') || 'None yet'}
    Pain points: ${JSON.stringify(state.painPoints)}
    
    STAGE GUIDANCE:
    ${stagePrompt}
    
    BETHANY'S VOICE:
    - Warm but not saccharine
    - Sharp and real — you're a romance novelist, you notice things about people
    - Brief — this is SMS, not email. 2-4 sentences max.
    - Curious about THEM, not talking about yourself
    - Use natural texting language. Fragments are fine. Contractions are good.
    - One emoji max per message, many messages have none
    - Never sound like a chatbot or corporate marketing
    
    CRITICAL: Respond ONLY with Bethany's next text message.
    No stage markers, no metadata, no explanatory text.
    Just her words as they'd appear in a text message.
  `;

  // Convert messages to Anthropic format
  const messages = state.messages.map(m => ({
    role: m.role === 'bethany' ? 'assistant' as const : 'user' as const,
    content: m.content,
  }));

  return callAnthropicAPI(env, systemPrompt, messages);
}

// ===========================================================================
// Conversation Extraction
// ===========================================================================

/**
 * Extract learnings from the conversation using AI.
 * Pulls out name, job, circles, people, and pain points.
 */
async function extractLearnings(
  env: Env,
  state: DiscoveryConversationState,
): Promise<{
  name: string | null;
  whatTheyDo: string | null;
  circles: string[];
  people: DiscoveryConversationState['peopleDiscussed'];
  painPoints: string[];
}> {
  const conversationText = state.messages
    .map(m => `${m.role === 'bethany' ? 'Bethany' : 'User'}: ${m.content}`)
    .join('\n');

  const systemPrompt = `
    Analyze this conversation and extract information about the user.
    
    Respond ONLY with valid JSON:
    {
      "name": "their name if mentioned, or null",
      "whatTheyDo": "their job/role/life situation if mentioned, or null",
      "circles": ["circle names mentioned or implied"],
      "people": [
        {"name": "person's name", "relationship": "how they're related", "circle": "which circle they fit"}
      ],
      "painPoints": ["struggles or frustrations they mentioned"]
    }
    
    Rules:
    - Only include information the USER explicitly shared
    - Don't infer or assume — if uncertain, omit
    - Circles can be explicit ("my work team") or implied ("the friends I never see")
    - People must have names. "My sister" without a name = skip until name given
    - Pain points are direct quotes or clear paraphrases of frustrations
    - Return nulls and empty arrays if not enough info yet
  `;

  try {
    const response = await callAnthropicAPI(env, systemPrompt, [{
      role: 'user',
      content: conversationText,
    }]);

    const cleaned = response.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      name: parsed.name ?? state.name,
      whatTheyDo: parsed.whatTheyDo ?? state.whatTheyDo,
      circles: Array.isArray(parsed.circles) ? parsed.circles : state.circlesDiscussed,
      people: Array.isArray(parsed.people) ? parsed.people : state.peopleDiscussed,
      painPoints: Array.isArray(parsed.painPoints) ? parsed.painPoints : state.painPoints,
    };
  } catch (err) {
    console.error('[discovery] Extraction failed:', err);
    return {
      name: state.name,
      whatTheyDo: state.whatTheyDo,
      circles: state.circlesDiscussed,
      people: state.peopleDiscussed,
      painPoints: state.painPoints,
    };
  }
}

// ===========================================================================
// SendBlue Integration
// ===========================================================================

/**
 * Send an SMS via SendBlue.
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
      send_style: 'invisible',
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
 * Call Claude for response generation.
 * Uses Sonnet for speed — discovery conversations need fast responses.
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
      max_tokens: 300,
      system: systemPrompt,
      messages: messages.length > 0 ? messages : [
        { role: 'user', content: '(start the conversation)' },
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
 * UserDiscoveryDO — Durable Object for pre-signup discovery state.
 *
 * Keyed by phone number. Handles GET, PUT, DELETE for state management.
 *
 * Wrangler config:
 *   [[durable_objects.bindings]]
 *   name = "USER_DISCOVERY_DO"
 *   class_name = "UserDiscoveryDO"
 */
export class UserDiscoveryDO {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/state') {
      if (request.method === 'GET') {
        const data = await this.state.storage.get<DiscoveryConversationState>('state');
        if (!data) {
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (request.method === 'PUT') {
        const body = await request.json() as DiscoveryConversationState;
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

// ===========================================================================
// Resend Signup Link
// ===========================================================================

/**
 * Resend the signup link if user asks for it again.
 * Called when user texts while in waiting_signup stage.
 */
export async function resendSignupLink(
  env: Env,
  phone: string,
): Promise<{ response: string; url: string }> {
  const state = await loadDiscoveryState(env, phone);

  if (!state || !state.signupUrl) {
    // No existing link — generate new one
    const newState = state ?? createInitialState(phone);
    const { url, token } = await generateSignupLink(env, newState);
    newState.signupToken = token;
    newState.signupUrl = url;
    await storeDiscoveryState(env, phone, newState);

    return {
      response: `Here's a fresh link for you: ${url}`,
      url,
    };
  }

  // Resend existing link
  const response = `Here's that link again: ${state.signupUrl}`;
  await sendViaSendBlue(env, phone, response);

  return {
    response,
    url: state.signupUrl,
  };
}

// ===========================================================================
// Check Discovery Status
// ===========================================================================

/**
 * Check if a phone number is in an active discovery conversation.
 * Used by SMS router to determine routing.
 */
export async function hasActiveDiscovery(
  env: Env,
  phone: string,
): Promise<boolean> {
  const state = await loadDiscoveryState(env, phone);
  if (!state) return false;

  // Consider active if started within last 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return new Date(state.lastMessageAt) > sevenDaysAgo;
}

/**
 * Get discovery state for routing decisions.
 */
export async function getDiscoveryState(
  env: Env,
  phone: string,
): Promise<DiscoveryConversationState | null> {
  return loadDiscoveryState(env, phone);
}
