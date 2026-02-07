/**
 * SMS Onboarding Service — Post-Signup Conversation State Machine
 *
 * FLOW (discovery-first redesign):
 *
 *   1. User signs up on web form (email + phone)
 *   2. Bethany sends intro message via SendBlue send-message API
 *      (this registers the contact for inbound routing on SendBlue's standard plan)
 *   3. User replies → conversation begins here
 *   4. State machine walks through:
 *      intro_sent → user_replies → network_discovery → path_recommendation →
 *      guided_action → learn_circles → explain_features → ready
 *   5. On completion, user record is updated and onboarding state is archived
 *
 * KEY INSIGHT: A user with 1000 contacts shouldn't be asked to add them one by one.
 * Bethany needs to understand the user's situation first, then recommend the right path.
 *
 * STATE STORAGE:
 *   Conversation state lives in a Durable Object keyed by phone number.
 *
 * KNOWLEDGE BASE:
 *   Comprehensive onboarding knowledge stored in R2 at bethany/knowledge/onboarding.md
 *   Loaded and injected into system prompts for intelligent routing.
 *
 * @see shared/models.ts for OnboardingStage, OnboardingState
 * @see docs/bethany-onboarding-kb.md for the knowledge base source
 * @see docs/personality-config.md for Bethany's voice
 * @see worker/routes/sms.ts for routing into this service
 */

import type { Env } from '../../shared/types';
import type { OnboardingState } from '../../shared/models';

// ===========================================================================
// Updated Stage Type — Discovery-First Flow
// ===========================================================================

export type PostSignupStage =
  | 'intro_sent'           // Bethany's welcome message delivered
  | 'user_replies'         // User responded, initial warmth
  | 'network_discovery'    // Ask about network size, where contacts live
  | 'path_recommendation'  // Recommend import vs manual based on answers
  | 'guided_action'        // Walk through import OR collect names
  | 'learn_circles'        // Identify key relationship circles
  | 'explain_features'     // Show what Bethany can do
  | 'ready';               // Onboarding complete

// ===========================================================================
// Detected User Signals
// ===========================================================================

export type DetectedNetworkSize = 'large' | 'medium' | 'small' | 'unknown';
export type RecommendedPath = 'import' | 'braindump' | 'manual' | null;
export type PhoneType = 'iphone' | 'android' | 'unknown';
export type TechComfort = 'savvy' | 'comfortable' | 'needs_guidance' | 'unknown';

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

  // Discovery signals — populated during network_discovery stage
  detectedNetworkSize: DetectedNetworkSize;
  recommendedPath: RecommendedPath;
  phoneType: PhoneType;
  techComfort: TechComfort;
  contactsLocation: 'phone' | 'spreadsheet' | 'scattered' | 'head' | 'unknown';
  userGoal: 'personal' | 'professional' | 'both' | 'unknown';
}

// ===========================================================================
// Stage Transition Rules
// ===========================================================================

const VALID_TRANSITIONS: Record<PostSignupStage, PostSignupStage[]> = {
  intro_sent: ['user_replies'],
  user_replies: ['network_discovery'],
  network_discovery: ['path_recommendation'],
  path_recommendation: ['guided_action'],
  guided_action: ['learn_circles', 'ready'], // Can skip to ready if path is clear
  learn_circles: ['explain_features'],
  explain_features: ['ready'],
  ready: [],
};

export function canTransition(from: PostSignupStage, to: PostSignupStage): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ===========================================================================
// Stage-Specific System Prompts
// ===========================================================================

const STAGE_PROMPTS: Record<PostSignupStage, string> = {
  intro_sent: `
    The user just signed up on the web and you've sent your intro message.
    You're waiting for their first reply. When they respond, acknowledge them
    warmly — they took the step of signing up, that's worth something.
    
    Your goal: Make them feel like they made a good choice. Keep it brief
    and warm. End with something that opens the conversation naturally.
    
    After acknowledging, you'll transition to discovery in your next message.
  `,

  user_replies: `
    The user has responded to your intro. Time to start understanding their situation.
    
    Your goal: Warm acknowledgment, then pivot to discovery. Ask an opening
    question to understand their network:
    
    "Tell me about your network — who are the people you want to stay connected to?"
    
    Or a variant that feels natural based on their reply. Listen for size signals.
    
    Keep it to one question. Let them tell you about their world.
  `,

  network_discovery: `
    You're learning about the user's network to recommend the right import path.
    
    Your goal: Figure out:
    1. Network size (hundreds vs dozens vs handful)
    2. Where contacts live (phone, spreadsheet, scattered, in their head)
    3. Organization level (sorted or chaos)
    4. Their goal (personal, professional, both)
    
    Ask conversationally, not as a checklist. One question at a time.
    
    Size signals to listen for:
    - "Thousands", "my whole phone", "years of networking" → large
    - "Between work and personal", "maybe a hundred" → medium
    - "Just key people", "not that many", "quality over quantity" → small
    
    Source signals:
    - "All in my phone" → phone contacts
    - "I have a spreadsheet" → organized, CSV ready
    - "Scattered everywhere" → might need braindump
    - "I'd have to think about it" → in their head
    
    When you have a sense of size + source, move to path_recommendation.
  `,

  path_recommendation: `
    You've assessed the user's situation. Now recommend the best import path.
    
    PATHS TO RECOMMEND:
    
    1. CSV/vCard Upload (for large networks or organized users):
       Link: {{DASHBOARD_URL}}/import
       "Since you've got a bigger network, the fastest path is to upload..."
    
    2. Braindump (for scattered contacts or prose-thinkers):
       Link: {{DASHBOARD_URL}}/braindump
       "You don't have to organize anything. Just brain-dump everything..."
    
    3. Manual via Text (for small networks, <20 people):
       "Let's start simple. Just tell me about the people who matter most..."
    
    4. Hybrid (for medium networks or undecided):
       "Start with your most important 10-15 people now, import more later..."
    
    Give a clear recommendation based on what you learned, then offer the
    alternative if they seem unsure. Include the relevant dashboard link
    if recommending import or braindump.
    
    Adapt your pitch to their tech comfort level:
    - Tech-savvy: Direct instructions, skip hand-holding
    - Needs guidance: Step-by-step, reassure them
  `,

  guided_action: `
    The user has chosen (or been recommended) a path. Help them execute it.
    
    IF PATH IS IMPORT/BRAINDUMP:
    - They may have clicked the link and are doing it on dashboard
    - Ask if they've started, offer to walk through export steps if stuck
    - iPhone vCard: Contacts app → Lists → ••• → Export → vCard
    - Android/Google: contacts.google.com → Menu → Export → Google CSV
    - Be ready to troubleshoot
    
    IF PATH IS MANUAL:
    - Start collecting key people one at a time
    - "Tell me about the first person who comes to mind..."
    - Listen for names, relationships, context
    - Acknowledge each person warmly before asking about the next
    
    When they've done their initial import/dump OR you have 3-5 key people
    for manual, transition to learn_circles to organize what you've got.
    
    If they seem stuck or frustrated, offer to switch paths.
  `,

  learn_circles: `
    Time to organize what you've learned about their network into circles.
    
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
    
    Mention Dunbar layers naturally:
    "For your inner circle — maybe 5 people — I'll nudge you weekly. For people
    you're actively building relationships with, every couple weeks. Everyone
    else, monthly or quarterly depending on how close you want to stay."
    
    When done, transition to ready.
  `,

  ready: `
    Onboarding is complete. The user is oriented and ready to use the system.
    
    This is your "welcome to the real thing" moment. Keep it brief and warm.
    Maybe reference something specific they shared during onboarding.
    
    End with something actionable — not a generic "let me know if you need
    anything" but a specific suggestion based on what you learned.
    
    Example: "Alright, you're all set. I'll check in when someone's slipping
    off your radar. In the meantime, you can text me anytime to log an
    interaction, ask who's overdue, or add someone new. Welcome aboard."
    
    This is the last onboarding message. After this, they're in the normal
    conversation flow.
  `,
};

// ===========================================================================
// Knowledge Base Loading
// ===========================================================================

let cachedKnowledgeBase: string | null = null;

async function loadKnowledgeBase(env: Env): Promise<string> {
  if (cachedKnowledgeBase) {
    return cachedKnowledgeBase;
  }

  try {
    const r2Object = await env.STORAGE.get('bethany/knowledge/onboarding.md');
    if (r2Object) {
      cachedKnowledgeBase = await r2Object.text();
      return cachedKnowledgeBase;
    }
  } catch (err) {
    console.warn('[onboarding] Could not load knowledge base from R2:', err);
  }

  // Fallback: minimal inline knowledge if R2 fails
  return `
    # Onboarding Knowledge (Fallback)
    
    ## Import Paths
    - Large network (500+): CSV upload or vCard export
    - Medium (50-200): Flexible, recommend hybrid
    - Small (<50): Manual via text
    - Scattered/chaos: Braindump page
    
    ## URLs
    - Import: {{DASHBOARD_URL}}/import
    - Braindump: {{DASHBOARD_URL}}/braindump
    
    ## Phone Export
    - iPhone: Contacts → Lists → ••• → Export → vCard
    - Android: contacts.google.com → Menu → Export → Google CSV
  `;
}

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

    // Discovery signals — unknown until we ask
    detectedNetworkSize: 'unknown',
    recommendedPath: null,
    phoneType: 'unknown',
    techComfort: 'unknown',
    contactsLocation: 'unknown',
    userGoal: 'unknown',
  };

  await storeOnboardingState(env, phone, state);

  // Store knowledge base in R2 if not already there
  await ensureKnowledgeBaseInR2(env);

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

  // Analyze user message for signals during discovery stages
  if (state.stage === 'network_discovery' || state.stage === 'user_replies') {
    const signals = await analyzeUserSignals(env, state, body);
    state.detectedNetworkSize = signals.networkSize;
    state.phoneType = signals.phoneType;
    state.techComfort = signals.techComfort;
    state.contactsLocation = signals.contactsLocation;
    state.userGoal = signals.userGoal;
  }

  // Determine recommended path based on signals
  if (state.stage === 'network_discovery' && state.detectedNetworkSize !== 'unknown') {
    state.recommendedPath = determineRecommendedPath(state);
  }

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

  if (state.stage === 'learn_circles' || state.stage === 'guided_action') {
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
// Signal Analysis
// ===========================================================================

interface UserSignals {
  networkSize: DetectedNetworkSize;
  phoneType: PhoneType;
  techComfort: TechComfort;
  contactsLocation: OnboardingConversationState['contactsLocation'];
  userGoal: OnboardingConversationState['userGoal'];
}

async function analyzeUserSignals(
  env: Env,
  state: OnboardingConversationState,
  latestMessage: string,
): Promise<UserSignals> {
  const conversationText = state.messages
    .map(m => `${m.role === 'bethany' ? 'Bethany' : state.name}: ${m.content}`)
    .join('\n') + `\n${state.name}: ${latestMessage}`;

  const systemPrompt = `
    Analyze this onboarding conversation and detect user signals.
    
    Respond ONLY with valid JSON in this exact format:
    {
      "networkSize": "large" | "medium" | "small" | "unknown",
      "phoneType": "iphone" | "android" | "unknown",
      "techComfort": "savvy" | "comfortable" | "needs_guidance" | "unknown",
      "contactsLocation": "phone" | "spreadsheet" | "scattered" | "head" | "unknown",
      "userGoal": "personal" | "professional" | "both" | "unknown"
    }
    
    SIGNAL DETECTION RULES:
    
    networkSize:
    - "large": thousands, whole phone, years of networking, sales/recruiting
    - "medium": decent network, hundred or so, between work and personal
    - "small": just key people, not that many, quality over quantity, starting fresh
    
    phoneType:
    - "iphone": mentions iPhone, Apple, iOS
    - "android": mentions Android, Samsung, Google, Pixel
    
    techComfort:
    - "savvy": uses specific terms, asks about file formats, mentions other apps
    - "comfortable": can follow instructions, doesn't need lots of explanation
    - "needs_guidance": "not great with this stuff", asks what things mean, hesitant
    
    contactsLocation:
    - "phone": all in phone, phone contacts
    - "spreadsheet": have a list, spreadsheet, organized
    - "scattered": all over, some here some there, multiple places
    - "head": have to think about it, not written down
    
    userGoal:
    - "personal": family, friends, loved ones, people I care about
    - "professional": networking, clients, industry, professional relationships
    - "both": mix, colleagues who became friends
    
    If not enough signal to determine, use "unknown". Don't guess.
  `;

  try {
    const responseText = await callAnthropicAPI(env, systemPrompt, [
      { role: 'user', content: conversationText },
    ], 'claude-3-5-haiku-20241022'); // Use Haiku for signal detection

    const cleaned = responseText.replace(/```json\n?|```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      networkSize: parsed.networkSize || state.detectedNetworkSize,
      phoneType: parsed.phoneType || state.phoneType,
      techComfort: parsed.techComfort || state.techComfort,
      contactsLocation: parsed.contactsLocation || state.contactsLocation,
      userGoal: parsed.userGoal || state.userGoal,
    };
  } catch (err) {
    console.error('[onboarding] Signal analysis failed:', err);
    return {
      networkSize: state.detectedNetworkSize,
      phoneType: state.phoneType,
      techComfort: state.techComfort,
      contactsLocation: state.contactsLocation,
      userGoal: state.userGoal,
    };
  }
}

function determineRecommendedPath(state: OnboardingConversationState): RecommendedPath {
  const { detectedNetworkSize, contactsLocation, techComfort } = state;

  // Large network → always import
  if (detectedNetworkSize === 'large') {
    return 'import';
  }

  // Small network → manual
  if (detectedNetworkSize === 'small') {
    return 'manual';
  }

  // Medium network: depends on where contacts live
  if (detectedNetworkSize === 'medium') {
    if (contactsLocation === 'phone' || contactsLocation === 'spreadsheet') {
      return 'import';
    }
    if (contactsLocation === 'scattered' || contactsLocation === 'head') {
      // If they need guidance, braindump is easier
      if (techComfort === 'needs_guidance') {
        return 'braindump';
      }
      // Otherwise hybrid approach
      return 'manual'; // Start small, import later
    }
  }

  // Scattered contacts regardless of size → braindump
  if (contactsLocation === 'scattered') {
    return 'braindump';
  }

  return null; // Not enough info yet
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
      // Any reply moves us forward
      return 'user_replies';

    case 'user_replies':
      // After initial warmth, move to discovery
      return 'network_discovery';

    case 'network_discovery':
      // Move to recommendation when we have enough signals
      if (state.detectedNetworkSize !== 'unknown' && state.contactsLocation !== 'unknown') {
        return 'path_recommendation';
      }
      // Or after 3 exchanges in this stage
      if (messageCount >= 4) {
        return 'path_recommendation';
      }
      return null;

    case 'path_recommendation':
      // After recommending a path, move to guided action
      return 'guided_action';

    case 'guided_action':
      // If manual path and we have some people, move to circles
      if (state.recommendedPath === 'manual' && state.peopleDiscussed.length >= 3) {
        return 'learn_circles';
      }
      // If import path and they confirm they've done it
      const lastMsg = _userMessage.toLowerCase();
      if (
        (state.recommendedPath === 'import' || state.recommendedPath === 'braindump') &&
        (lastMsg.includes('done') || lastMsg.includes('uploaded') || lastMsg.includes('finished'))
      ) {
        return 'learn_circles';
      }
      // After 5 exchanges in guided action, move on
      if (messageCount >= 6) {
        return 'learn_circles';
      }
      return null;

    case 'learn_circles':
      // Move to features after circles are discussed
      if (state.circlesDiscussed.length >= 2 || messageCount >= 8) {
        return 'explain_features';
      }
      return null;

    case 'explain_features':
      // One message explaining features, then ready
      return 'ready';

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
  const knowledgeBase = await loadKnowledgeBase(env);
  const dashboardUrl = env.DASHBOARD_URL;

  // Replace {{DASHBOARD_URL}} placeholders in stage prompt and knowledge base
  const resolvedStagePrompt = stagePrompt.replace(/\{\{DASHBOARD_URL\}\}/g, dashboardUrl);
  const resolvedKnowledgeBase = knowledgeBase.replace(/\{\{DASHBOARD_URL\}\}/g, dashboardUrl);

  const systemPrompt = `
    You are Bethany — a romance novelist and relationship network manager.
    You're in the middle of an onboarding conversation with ${state.name}.
    
    Current stage: ${state.stage}
    
    DETECTED SIGNALS:
    - Network size: ${state.detectedNetworkSize}
    - Recommended path: ${state.recommendedPath || 'not yet determined'}
    - Phone type: ${state.phoneType}
    - Tech comfort: ${state.techComfort}
    - Contacts location: ${state.contactsLocation}
    - User goal: ${state.userGoal}
    
    Circles discussed so far: ${JSON.stringify(state.circlesDiscussed)}
    People discussed so far: ${JSON.stringify(state.peopleDiscussed.map(p => p.name))}
    
    STAGE GUIDANCE:
    ${resolvedStagePrompt}
    
    KNOWLEDGE BASE (reference as needed):
    ${resolvedKnowledgeBase}
    
    DASHBOARD URLS:
    - Import page: ${dashboardUrl}/import
    - Braindump page: ${dashboardUrl}/braindump
    - Dashboard home: ${dashboardUrl}
    
    CRITICAL RULES FOR SMS:
    - Keep responses to 2-4 sentences. This is a text conversation.
    - Never send walls of text.
    - One question at a time, max.
    - Sound like a real person texting, not an AI assistant.
    - Use Bethany's actual voice: warm, sharp, real.
    - Fragments are fine. Complete sentences are for emails.
    - Emojis: one max per message, many messages have none.
    - When sharing links, keep them clean — no markdown formatting.
    
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
    const responseText = await callAnthropicAPI(env, systemPrompt, messages, 'claude-3-5-haiku-20241022');
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
    `Path: ${state.recommendedPath}, Size: ${state.detectedNetworkSize}, ` +
    `Circles: ${state.circlesDiscussed.length}, People: ${state.peopleDiscussed.length}`
  );
}

// ===========================================================================
// Knowledge Base Initialization
// ===========================================================================

async function ensureKnowledgeBaseInR2(env: Env): Promise<void> {
  const key = 'bethany/knowledge/onboarding.md';

  try {
    const existing = await env.STORAGE.head(key);
    if (existing) {
      return; // Already exists
    }
  } catch {
    // Key doesn't exist, we'll create it
  }

  // Fetch from GitHub or use embedded fallback
  // For now, the knowledge base should be uploaded via a separate deploy step
  // See docs/bethany-onboarding-kb.md
  console.log('[onboarding] Knowledge base not found in R2. Using embedded fallback.');
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
    detectedNetworkSize: 'unknown',
    recommendedPath: null,
    phoneType: 'unknown',
    techComfort: 'unknown',
    contactsLocation: 'unknown',
    userGoal: 'unknown',
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
  model: string = 'claude-sonnet-4-5-20250929',
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
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
