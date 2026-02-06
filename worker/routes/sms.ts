/**
 * SMS Webhook Route — SendBlue inbound message handling.
 *
 * Responsibilities:
 *   1. Parse the SendBlue webhook payload (handles multiple formats)
 *   2. Normalize the phone number
 *   3. Look up the sender in D1
 *   4. Route to the correct handler:
 *      - Unknown phone → user discovery flow (pre-signup)
 *      - Active pending signup → resume discovery
 *      - Onboarding user → onboarding conversation flow (post-signup)
 *      - Existing user → conversation router (intent classification + dispatch)
 *      - Locked account → locked account response
 *   5. Return 200 quickly (actual processing via ctx.waitUntil)
 *
 * This is the single entry point for all inbound SMS traffic.
 *
 * FLOW (TASK-f25a28d1-1):
 *   We now support BOTH entry paths:
 *   - SMS-first: Unknown phone → discovery conversation → signup link → web form
 *   - Web-first: Web signup → intro message → onboarding conversation
 *
 *   The discovery flow (user-discovery-service.ts) handles unknown numbers.
 *   Once they complete web signup, they enter the onboarding flow.
 *
 * CONVERSATION ROUTING (TASK-b3480875-7):
 *   Established users' messages now flow through the conversation router,
 *   which uses Claude Haiku for intent classification and dispatches to
 *   appropriate sub-handlers. Responses are sent back via SendBlue.
 */

import type { Env } from '../../shared/types';
import type { UserRow } from '../../shared/models';
import { jsonResponse, errorResponse } from '../../shared/http';
import { getUserByPhone, getActivePendingSignup, isAccountLocked } from '../services/user-service';
import { handleOnboardingMessage } from '../services/onboarding-service';
import { handleDiscoveryMessage, hasActiveDiscovery, getDiscoveryState } from '../services/user-discovery-service';
import { routeConversation } from '../services/conversation-router';

// ---------------------------------------------------------------------------
// SendBlue Payload Types
// ---------------------------------------------------------------------------

/**
 * SendBlue sends webhooks in slightly different shapes depending on
 * the message type. We normalize all of them.
 */
export interface SendBlueWebhookPayload {
  // Phone number fields (SendBlue uses different keys)
  from_number?: string;
  number?: string;
  // Message content fields
  content?: string;
  message?: string;
  text?: string;
  // Metadata
  media_url?: string;
  is_outbound?: boolean;
  date?: string;
  // Group messaging
  group_id?: string;
  participants?: string[];
}

export interface NormalizedInboundMessage {
  phone: string;         // E.164 format
  body: string;          // Message text
  mediaUrl?: string;     // Attached media URL
  receivedAt: string;    // ISO timestamp
  raw: SendBlueWebhookPayload; // Original payload for debugging
}

// ---------------------------------------------------------------------------
// Routing Result
// ---------------------------------------------------------------------------

export type RoutingDecision =
  | { action: 'discovery'; phone: string; message: NormalizedInboundMessage }
  | { action: 'pending_signup'; phone: string; pendingId: string; message: NormalizedInboundMessage }
  | { action: 'onboarding'; user: UserRow; message: NormalizedInboundMessage }
  | { action: 'conversation'; user: UserRow; message: NormalizedInboundMessage }
  | { action: 'account_locked'; user: UserRow; message: NormalizedInboundMessage }
  | { action: 'ignore'; reason: string };

// ---------------------------------------------------------------------------
// Phone Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a phone number to E.164 format.
 * Handles common SendBlue variations.
 */
export function normalizePhone(raw: string): string {
  // Strip everything except digits and leading +
  let cleaned = raw.replace(/[^\d+]/g, '');

  // If it starts with +, keep it; otherwise assume US
  if (!cleaned.startsWith('+')) {
    // Strip leading 1 if 11 digits (US country code)
    if (cleaned.length === 11 && cleaned.startsWith('1')) {
      cleaned = '+' + cleaned;
    } else if (cleaned.length === 10) {
      cleaned = '+1' + cleaned;
    } else {
      // Best effort — prepend +
      cleaned = '+' + cleaned;
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Payload Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a SendBlue webhook payload into a normalized message.
 * Returns null if the payload is invalid or should be ignored.
 */
export function parseWebhookPayload(
  data: SendBlueWebhookPayload,
): NormalizedInboundMessage | null {
  // Extract phone
  const rawPhone = data.from_number || data.number;
  if (!rawPhone) {
    console.warn('[sms] Webhook missing phone number:', JSON.stringify(data));
    return null;
  }

  // Ignore outbound messages (our own sends echoing back)
  if (data.is_outbound === true) {
    return null;
  }

  // Extract message body
  const body = data.content || data.message || data.text || '';

  // Ignore empty messages (unless there's media)
  if (!body.trim() && !data.media_url) {
    console.warn('[sms] Empty message from', rawPhone);
    return null;
  }

  return {
    phone: normalizePhone(rawPhone),
    body: body.trim(),
    mediaUrl: data.media_url || undefined,
    receivedAt: data.date || new Date().toISOString(),
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Routing Logic
// ---------------------------------------------------------------------------

/**
 * Given a normalized inbound message, decide what to do with it.
 *
 * Decision tree:
 *   1. Look up phone in users table
 *   2. If found (existing user):
 *      a. Account locked → locked response
 *      b. onboarding_stage is set (not null, not 'ready') → onboarding flow
 *      c. Otherwise → main conversation handler
 *   3. If not found (new potential user):
 *      a. Check for active pending signup → pending_signup (resume discovery)
 *      b. Check for active discovery conversation → discovery (continue)
 *      c. Neither → discovery (start fresh)
 */
export async function routeInboundMessage(
  db: D1Database,
  env: Env,
  message: NormalizedInboundMessage,
): Promise<RoutingDecision> {
  // Step 1: Look up existing user
  const lookup = await getUserByPhone(db, message.phone);

  if (lookup.found) {
    const user = lookup.user;

    // Step 2a: Account locked?
    if (isAccountLocked(user)) {
      console.log(`[sms] Locked account: ${message.phone}`);
      return { action: 'account_locked', user, message };
    }

    // Step 2b: Still in onboarding?
    if (user.onboarding_stage && user.onboarding_stage !== 'ready') {
      console.log(`[sms] Onboarding user: ${user.name} (${message.phone}), stage: ${user.onboarding_stage}`);
      return { action: 'onboarding', user, message };
    }

    // Step 2c: Normal conversation
    console.log(`[sms] Existing user: ${user.name} (${message.phone})`);
    return { action: 'conversation', user, message };
  }

  // Step 3: Unknown phone — check for pending signup or discovery
  const pendingSignup = await getActivePendingSignup(db, message.phone);
  if (pendingSignup) {
    console.log(`[sms] Pending signup found for ${message.phone} — resuming discovery`);
    return { action: 'pending_signup', phone: message.phone, pendingId: pendingSignup.id, message };
  }

  // Check for active discovery conversation
  const hasDiscovery = await hasActiveDiscovery(env, message.phone);
  if (hasDiscovery) {
    console.log(`[sms] Active discovery for ${message.phone} — continuing`);
    return { action: 'discovery', phone: message.phone, message };
  }

  // New unknown phone — start discovery
  console.log(`[sms] Unknown phone: ${message.phone} — starting discovery`);
  return { action: 'discovery', phone: message.phone, message };
}

// ---------------------------------------------------------------------------
// SendBlue Reply
// ---------------------------------------------------------------------------

/**
 * Send an SMS reply via SendBlue API.
 *
 * Uses the SendBlue send message endpoint to deliver Bethany's response
 * back to the user's phone number.
 *
 * @param phone   - The user's phone number (E.164 format)
 * @param message - The text message to send
 * @param env     - Environment bindings (needs SENDBLUE keys)
 */
async function sendSmsReply(
  phone: string,
  message: string,
  env: Env,
): Promise<void> {
  try {
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
        send_style: 'regular',
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[sms] SendBlue send failed (${response.status}):`, body);
    } else {
      console.log(`[sms] Reply sent to ${phone}: ${message.substring(0, 80)}...`);
    }
  } catch (err) {
    console.error(`[sms] SendBlue send error for ${phone}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Webhook Handler
// ---------------------------------------------------------------------------

/**
 * Handle the /webhook/sms POST endpoint.
 *
 * Returns 200 immediately — actual message processing happens in
 * ctx.waitUntil() so SendBlue doesn't timeout.
 */
export async function handleSmsWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Parse payload
  let data: SendBlueWebhookPayload;
  try {
    data = await request.json() as SendBlueWebhookPayload;
  } catch {
    console.error('[sms] Failed to parse webhook JSON');
    return errorResponse('Invalid JSON', 400);
  }

  // Normalize
  const message = parseWebhookPayload(data);
  if (!message) {
    return jsonResponse({ received: true, processed: false, reason: 'ignored' });
  }

  // Route and dispatch (non-blocking)
  ctx.waitUntil(
    (async () => {
      try {
        const decision = await routeInboundMessage(env.DB, env, message);

        switch (decision.action) {
          case 'discovery':
          case 'pending_signup': {
            // Pre-signup discovery flow (TASK-f25a28d1-1)
            console.log(`[sms] → discovery for ${decision.phone}`);
            try {
              const result = await handleDiscoveryMessage(
                env,
                decision.phone,
                decision.message.body,
              );
              console.log(
                `[sms] ← discovery response sent. Stage: ${result.stage}, ` +
                `SignupUrl: ${result.signupUrl ? 'generated' : 'none'}`
              );
            } catch (err) {
              console.error(`[sms] Discovery error for ${decision.phone}:`, err);
              // Send a graceful error response
              await sendSmsReply(
                decision.phone,
                "Hey! I hit a snag there. Mind texting me again?",
                env,
              );
            }
            break;
          }

          case 'conversation': {
            // Main conversation handler — classify intent and dispatch
            // (TASK-b3480875-7)
            console.log(`[sms] → conversation router for ${decision.user.name}`);
            try {
              // TODO: Load pending context from user session state
              // (stored in R2 or a Durable Object per user).
              // For now, pass null — no multi-turn context.
              const pendingContext = null;

              const response = await routeConversation(
                decision.message,
                decision.user,
                env,
                pendingContext,
              );

              // Send Bethany's reply via SendBlue
              await sendSmsReply(decision.user.phone, response.reply, env);

              // TODO: If response.expectsReply && response.pendingContext,
              // save the pending context to the user's session state so
              // the next message can be interpreted in context.

              console.log(
                `[sms] ← conversation response sent to ${decision.user.name} ` +
                `(expectsReply: ${response.expectsReply})`
              );
            } catch (err) {
              console.error(`[sms] Conversation error for ${decision.user.phone}:`, err);
              // Send a graceful error response so the user isn't left hanging
              await sendSmsReply(
                decision.user.phone,
                "Sorry, I hit a bump processing that. Mind trying again in a moment?",
                env,
              );
            }
            break;
          }

          case 'onboarding': {
            // Post-signup onboarding conversation (TASK-36776bae-4)
            console.log(`[sms] → onboarding for ${decision.user.name} (stage: ${decision.user.onboarding_stage})`);
            try {
              const result = await handleOnboardingMessage(
                env,
                decision.user.phone,
                decision.message.body,
                decision.user.id,
              );
              console.log(
                `[sms] ← onboarding response sent. Stage: ${result.stage}, Complete: ${result.isComplete}`
              );

              // Update onboarding_stage on user record
              if (result.isComplete) {
                await env.DB.prepare(
                  `UPDATE users SET onboarding_stage = NULL, updated_at = datetime('now') WHERE id = ?`
                ).bind(decision.user.id).run();
              } else {
                await env.DB.prepare(
                  `UPDATE users SET onboarding_stage = ?, updated_at = datetime('now') WHERE id = ?`
                ).bind(result.stage, decision.user.id).run();
              }
            } catch (err) {
              console.error(`[sms] Onboarding error for ${decision.user.phone}:`, err);
            }
            break;
          }

          case 'account_locked':
            // Send a locked account response
            console.log(`[sms] → account locked for ${decision.user.name}`);
            await sendSmsReply(
              decision.user.phone,
              "Your account has been locked for security. Please contact support to regain access.",
              env,
            );
            break;

          case 'ignore':
            console.log(`[sms] → ignored: ${decision.reason}`);
            break;
        }
      } catch (err) {
        console.error('[sms] Routing error:', err);
      }
    })()
  );

  // Respond immediately so SendBlue doesn't retry
  return jsonResponse({ received: true, processed: true });
}
