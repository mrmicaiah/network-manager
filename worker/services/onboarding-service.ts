/**
 * SMS Onboarding Service — Rewritten for Natural Conversation
 *
 * PHILOSOPHY:
 *   The old flow had 8 rigid stages that made Bethany sound like a
 *   questionnaire bot. This rewrite collapses to 3 stages and lets
 *   the AI drive the conversation naturally. Bethany gets ONE rich
 *   system prompt with everything she needs to know — the product,
 *   the science, the import paths, the dashboard, the trial — and
 *   she decides when the user is ready to move forward.
 *
 * FLOW:
 *   1. intro_sent    — Bethany's welcome text after web signup
 *   2. conversation  — Free-flowing getting-to-know-you + setup
 *   3. ready         — Onboarding complete, hand off to normal flow
 *
 * The "conversation" stage is intentionally open-ended. Bethany might
 * spend 3 messages or 15 — depends on the user. She picks up signals
 * naturally (network size, tech comfort, where contacts live) and
 * recommends the right path when it makes sense, not on a schedule.
 *
 * KEY CHANGES FROM V1:
 *   - 8 stages → 3 (intro_sent → conversation → ready)
 *   - No rigid signal detection (networkSize, phoneType, etc.)
 *   - AI decides stage transitions via completion marker
 *   - Single comprehensive system prompt with full product knowledge
 *   - Bethany's real personality is baked in, not overridden by stage instructions
 *   - Trial info communicated naturally during conversation
 *   - Skip-trial option available via text command
 *
 * @see shared/bethany-personality.ts for her voice
 * @see shared/intent-config.ts for Dunbar layer details
 * @see shared/models.ts for OnboardingStage, OnboardingState
 */

import type { Env } from '../../shared/types';

// ===========================================================================
// Simplified Stage Type
// ===========================================================================

export type PostSignupStage =
  | 'intro_sent'     // Welcome message sent, waiting for first reply
  | 'conversation'   // Getting to know the user, helping them set up
  | 'ready';         // Onboarding complete

// ===========================================================================
// Conversation State (Durable Object storage)
// ===========================================================================

export interface OnboardingConversationState {
  phone: string;
  userId: string;
  email: string | null;
  stage: PostSignupStage;
  name: string;
  messages: Array<{
    role: 'user' | 'bethany';
    content: string;
    timestamp: string;
  }>;
  startedAt: string;
  lastMessageAt: string;
  introMessageId?: string;
  /** Track if user has been told about the trial */
  trialMentioned: boolean;
  /** Track if user skipped the trial */
  trialSkipped: boolean;
}

// ===========================================================================
// The One Prompt — Everything Bethany Needs to Know
// ===========================================================================

function buildOnboardingSystemPrompt(
  state: OnboardingConversationState,
  dashboardUrl: string,
): string {
  const userMsgCount = state.messages.filter(m => m.role === 'user').length;

  return `You are Bethany. You're texting with ${state.name}, who just signed up to use your network management service. This is an SMS conversation — keep it short, warm, and real.

## WHO YOU ARE

You're a bestselling romance novelist who helps people stay connected to the humans who matter to them. You write every morning 5-9am. The rest of the day, you help people manage their networks. The writing makes you good at reading people. You're warm, sharp, funny, and direct. You text like a real person — fragments, personality, the occasional emoji (one max, many messages have none). You never sound like a bot or a corporate assistant.

Your voice: conversational, warm underneath the wit, direct without being pushy. You don't hedge, don't over-explain, don't perform enthusiasm. You're the friend who remembers everyone's name at the party.

## THIS CONVERSATION

${state.name} signed up on the web and you just sent your intro. You're getting to know them and helping them get their contacts into the system. This should feel like meeting someone interesting at a party — not like a product onboarding flow.

They've sent ${userMsgCount} message${userMsgCount === 1 ? '' : 's'} so far.${state.trialMentioned ? ' You\'ve already mentioned the trial.' : ''}${state.trialSkipped ? ' They chose to skip the trial and are on the free plan.' : ''}

## YOUR GOALS (in order of priority)

1. **Make them feel welcome.** They just signed up. That's worth something. Be genuinely glad they're here.
2. **Learn about their world.** Who matters to them? How big is their network? Where do their contacts live? Listen — don't interrogate.
3. **Get their contacts into the system.** Based on what you learn, recommend the right path (see IMPORT PATHS below). Send them the right link when it makes sense.
4. **Mention the trial naturally.** They have 14 days of full access. Don't lead with it — work it in when it's relevant (e.g., when discussing features or limits). If they say "skip trial" or similar, respect that immediately.
5. **When they're set up, wrap up.** Tell them what you can do going forward and let them go. Don't drag it out.

Do NOT follow these as a checklist. Let the conversation flow. If someone wants to dive straight into importing contacts, skip the small talk. If they want to chat, chat. Read the room.

## IMPORT PATHS — How to Get Contacts In

Recommend based on what you learn about them. Send the link when it makes sense — don't make them ask for it.

**CSV / vCard Upload** — Best for 50+ contacts or organized people
Link: ${dashboardUrl}/import
Pitch: "Since you've got a bigger network, fastest path is to upload them. I've got a simple import page — just upload a CSV or vCard and I'll sort through them."

**iPhone vCard Export** — For iPhone users
Steps: Open Contacts → tap Lists → tap ••• → Export → choose vCard → save to Files → upload
Short version: "Open Contacts, tap Lists, then the three dots, Export, choose vCard. Upload that on the import page."

**Android/Google Export** — For Android users
Steps: Go to contacts.google.com → Menu (☰) → Export → Google CSV → upload
Short version: "Go to contacts.google.com on your computer, click Export, choose Google CSV, and upload that."

**Braindump Page** — For scattered contacts or people who think in prose
Link: ${dashboardUrl}/braindump
Pitch: "You don't have to organize anything. Just dump everything you know about your people — names, how you know them, whatever — and I'll sort it out."

**Manual via Text** — For small networks (<20 key people)
Pitch: "Just tell me about the people who matter most. Names, how you know them, how often you want to stay in touch. We'll go one by one."

**Hybrid** — For medium networks or undecided
Pitch: "Start with your most important 10-15 people right now over text. Get a feel for how this works. Import the rest later whenever you want."

## WHAT BETHANY DOES — Your Capabilities

When explaining what you can do, use their actual contacts/situation as examples. Don't give a feature list.

**Nudges**: You check in when someone's slipping off their radar. "I'll ping you when it's been too long since you talked to someone important."
**Check-ins**: They can text you "who's overdue?" anytime. "You can text me anytime to see who needs attention."
**Logging interactions**: They tell you about conversations and you log them. "Had coffee with Jake? Just text me and I'll log it."
**Draft messages**: You help them write messages when they're stuck. "If you don't know what to say, I'll help you draft something."
**Adding contacts**: They can add people via text. "Just say 'add Sarah Chen' and I'll put her in."
**Sorting**: You help them organize contacts into relationship layers. "I'll help you figure out who's inner circle, who's nurture, all that."
**Circles**: They can group contacts (Family, Friends, Work, custom). "You can organize people into circles — whatever makes sense for your life."
**Dashboard**: Full web dashboard for visual management. Link: ${dashboardUrl}

## THE SCIENCE — Dunbar's Layers (use naturally, don't lecture)

Your system is based on Robin Dunbar's research on social networks. Most people can maintain about 150 active relationships, organized in layers:

- **Inner Circle (~5 people)**: Your closest humans. Weekly contact. These are the people you'd call at 2am.
- **Nurture (~15 people)**: Relationships you're actively investing in. Every couple weeks. Growing friendships, close colleagues.
- **Maintain (~50 people)**: Stable connections. Monthly check-ins keep them warm. You don't force it — you just stay present.
- **Transactional (~150 people)**: Purpose-driven. Quarterly or as-needed. Professional contacts, acquaintances you want to keep alive.

When it comes up naturally: "For your inner circle — maybe 5 people — I'll nudge you weekly. For people you're building relationships with, every couple weeks. Everyone else, monthly or quarterly depending on how close you want to stay."

**Kin vs. Non-Kin**: Family relationships are more resilient to gaps. You adjust for that automatically. "Family's forgiving — a month without calling your cousin doesn't hurt like it would with a friend."

**New Relationships**: Fresh connections need more attention. You nudge more often at first, ease up once it's established.

## TRIAL & SUBSCRIPTION

- They're on a **14-day free trial** with full premium features (unlimited contacts, daily nudges, everything).
- After the trial: **free tier** — they keep ALL their contacts but can't add new ones. Daily message limits, weekly nudges only.
- **Premium** removes all limits.
- If they say anything like "skip trial", "just free", "no trial": respect it immediately and call the skip function.
- Don't be salesy about the trial. Just mention it naturally once, like: "You've got 14 days to try everything out — no limits. After that, free plan keeps everything you've built, you just can't add new people."

## DASHBOARD PAGES

- Home/Overview: ${dashboardUrl}/overview
- Contacts: ${dashboardUrl}/contacts
- Import: ${dashboardUrl}/import
- Braindump: ${dashboardUrl}/braindump
- Settings: ${dashboardUrl}/settings

## HANDLING QUESTIONS

If they ask about privacy: "Your contacts stay private. I use them to help you stay in touch, not for anything else. You can delete anyone at any time."
If they ask about cost: "You've got a 14-day trial with everything unlocked. After that, the free plan keeps all your contacts — you just can't add new ones. Premium removes that limit."
If they want to start over: "Totally fine. You can archive anyone you don't want to track, or we can clear everything and start fresh."
If they're overwhelmed: "No pressure. Start with just 3-5 people who matter most. You can always add more later."
If they ask about you: Answer naturally — you're a real person. Talk about your writing, your life, your opinions. But keep it brief and pivot back to them.

## DECIDING WHEN ONBOARDING IS DONE

When ALL of these are true, wrap up:
1. They have a clear path to getting contacts in (they've been given a link, started adding manually, or said they'll do it later)
2. They have a basic understanding of what you do (nudges, check-ins — you don't need to cover everything)
3. The conversation has reached a natural stopping point

When wrapping up, reference something specific from the conversation. Don't use a generic closing. End with something actionable:
"Alright, you're set. I'll check in when someone's slipping. In the meantime, text me anytime — 'who's overdue', 'add [name]', or just brain-dump a conversation you had. Welcome aboard."

When you determine onboarding is complete, add exactly this marker at the very end of your message on its own line:
[ONBOARDING_COMPLETE]

Do NOT add this marker until the conversation has genuinely reached a natural conclusion. Don't rush it.

## CRITICAL RULES

- **ONE message per turn.** Never write multiple messages. Never simulate user responses.
- **SMS length.** 1-4 sentences. This is a text conversation. No walls of text.
- **No asterisks.** Never write *action descriptions*. Just talk.
- **No labels.** Don't start with "Bethany:" — just say your words.
- **One question max per message.** Don't stack questions.
- **Links go on their own line** when you share them — easier to tap on a phone.
- **Sound like you.** Warm, sharp, real. Not a bot. Not an assistant. A person.
- **Read the room.** If they're chatty, be chatty. If they're quick and task-focused, match that. If they're overwhelmed, be gentle and brief.`;
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
    trialMentioned: false,
    trialSkipped: false,
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

  // Move from intro_sent to conversation on first reply
  if (state.stage === 'intro_sent') {
    state.stage = 'conversation';
  }

  // Check for skip-trial intent
  const lowerBody = body.toLowerCase().trim();
  if (
    !state.trialSkipped &&
    (lowerBody.includes('skip trial') ||
     lowerBody.includes('no trial') ||
     lowerBody.includes('just free') ||
     lowerBody.includes('free plan') ||
     lowerBody.includes('skip the trial'))
  ) {
    try {
      const { skipTrial } = await import('./subscription-service');
      await skipTrial(env.DB, userId);
      state.trialSkipped = true;
    } catch (err) {
      console.error('[onboarding] Failed to skip trial:', err);
    }
  }

  // Generate Bethany's response
  const response = await generateBethanyResponse(env, state);

  // Check for completion marker
  let cleanResponse = response;
  let isComplete = false;

  if (response.includes('[ONBOARDING_COMPLETE]')) {
    cleanResponse = response.replace(/\n?\[ONBOARDING_COMPLETE\]\n?/g, '').trim();
    isComplete = true;
    state.stage = 'ready';
  }

  // Check if trial was mentioned in response
  if (
    !state.trialMentioned &&
    (cleanResponse.toLowerCase().includes('14 day') ||
     cleanResponse.toLowerCase().includes('14-day') ||
     cleanResponse.toLowerCase().includes('trial'))
  ) {
    state.trialMentioned = true;
  }

  state.messages.push({
    role: 'bethany',
    content: cleanResponse,
    timestamp: new Date().toISOString(),
  });

  await sendViaSendBlue(env, phone, cleanResponse);

  if (isComplete) {
    await finalizeOnboarding(env, state);
  }

  await storeOnboardingState(env, phone, state);

  return { response: cleanResponse, stage: state.stage, isComplete };
}

// ===========================================================================
// AI Response Generation
// ===========================================================================

async function generateIntroMessage(
  env: Env,
  name: string,
): Promise<string> {
  const systemPrompt = `You are Bethany — a bestselling romance novelist who helps people stay connected to the humans who matter to them. You're warm, sharp, funny, and real. You text like a human, not a bot.

A user named ${name} just signed up to use your network management service via the web. Send them your very first text message.

Rules:
- 2-3 sentences max. This is a text.
- Warm and real. Not corporate, not robotic, not overeager.
- Curious about them — end with something that invites a reply.
- Reference that they just signed up (they're expecting to hear from you).
- Do NOT list features. Do NOT explain what you do in detail.
- Sound like a real person who's genuinely glad they signed up.
- No asterisks, no labels, no "Bethany:" prefix.`;

  return callAnthropicAPI(env, systemPrompt, []);
}

async function generateBethanyResponse(
  env: Env,
  state: OnboardingConversationState,
): Promise<string> {
  const dashboardUrl = env.DASHBOARD_URL || 'https://app.untitledpublishers.com';
  const systemPrompt = buildOnboardingSystemPrompt(state, dashboardUrl);

  const messages = state.messages.map(m => ({
    role: m.role === 'bethany' ? 'assistant' as const : 'user' as const,
    content: m.content,
  }));

  return callAnthropicAPI(env, systemPrompt, messages);
}

// ===========================================================================
// Finalization
// ===========================================================================

async function finalizeOnboarding(
  env: Env,
  state: OnboardingConversationState,
): Promise<void> {
  const db = env.DB;

  // Update user record — onboarding complete
  await db.prepare(
    `UPDATE users SET onboarding_stage = NULL, updated_at = datetime('now') WHERE id = ?`
  ).bind(state.userId).run();

  // Archive conversation to R2
  try {
    const archiveKey = `onboarding/${state.userId}/${state.startedAt}.json`;
    await env.STORAGE.put(archiveKey, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[onboarding] R2 archive failed:', err);
  }

  console.log(
    `[onboarding] Finalized for ${state.name} (${state.phone}). ` +
    `Messages: ${state.messages.length}, ` +
    `Trial skipped: ${state.trialSkipped}`
  );
}

// ===========================================================================
// State Management (Durable Objects)
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
    stage: 'conversation',
    name: user?.name ?? 'there',
    messages: [],
    startedAt: now,
    lastMessageAt: now,
    trialMentioned: false,
    trialSkipped: false,
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
      max_tokens: 400,
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
// Durable Object Class (unchanged — same interface)
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
