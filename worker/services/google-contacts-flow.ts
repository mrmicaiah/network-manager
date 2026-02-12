/**
 * Google Contacts Connection Flow — Bethany's SMS conversation for Google import.
 *
 * This module handles the conversational experience around connecting Google
 * Contacts. It's triggered in two ways:
 *
 *   1. Proactively — After onboarding or when Bethany detects the user
 *      has few contacts, she offers to import from Google.
 *   2. On request — User says "import contacts", "connect Google", etc.
 *
 * Flow:
 *
 *   Bethany: Explains benefit → sends OAuth link
 *   User: Taps link → Google consent → callback
 *   Callback: Triggers import → analyzes contacts → Bethany texts results
 *   Bethany: Reports stats → offers to start sorting (with link to /review)
 *
 * Error handling:
 *   - User declines → graceful acceptance, no pressure
 *   - Auth error → explains what went wrong, offers retry link
 *   - Empty contacts → friendly acknowledgment, suggests manual add
 *   - Already connected → offers re-sync instead
 *
 * @see worker/services/google-oauth-service.ts for OAuth lifecycle
 * @see worker/services/google-contacts-service.ts for import pipeline
 * @see worker/services/contact-analysis-service.ts for analysis
 * @see worker/services/conversation-router.ts for intent dispatch
 */

import type { Env } from '../../shared/types';
import type { UserRow } from '../../shared/models';
import {
  generateAuthUrl,
  getConnectionStatus,
  revokeAccess,
} from './google-oauth-service';
import { importGoogleContacts, type ImportResult } from './google-contacts-service';
import { analyzeUserContacts } from './contact-analysis-service';

// ===========================================================================
// Types
// ===========================================================================

export interface GoogleFlowResponse {
  /** SMS text to send to the user */
  reply: string;
  /** Whether we expect a follow-up message */
  expectsReply: boolean;
}

// ===========================================================================
// 1. Offer to Connect Google Contacts
// ===========================================================================

/**
 * Generate Bethany's pitch to connect Google Contacts.
 *
 * Called when:
 *   - User asks about importing contacts
 *   - After onboarding if contact count is low
 *   - User says "connect Google" or similar
 *
 * @param env  - Worker environment
 * @param user - The authenticated user
 * @returns Bethany's message with the OAuth link
 */
export async function offerGoogleConnect(
  env: Env,
  user: UserRow,
): Promise<GoogleFlowResponse> {
  // Check if already connected
  const status = await getConnectionStatus(env.DB, user.id);

  if (status.connected) {
    return handleAlreadyConnected(env, user, status.lastSync);
  }

  // Generate OAuth URL
  const { url } = await generateAuthUrl(env, user.id);

  return {
    reply:
      `I can pull in your contacts from Google — saves you from adding everyone manually.\n\n` +
      `I'll only read your contact list (names, numbers, emails). I never change or delete anything in your Google account.\n\n` +
      `Tap here to connect: ${url}`,
    expectsReply: false,
  };
}

/**
 * Handle the case where Google is already connected.
 * Offers to re-sync instead of re-connecting.
 */
async function handleAlreadyConnected(
  env: Env,
  user: UserRow,
  lastSync: string | null,
): Promise<GoogleFlowResponse> {
  if (lastSync) {
    const syncAge = formatSyncAge(lastSync);
    return {
      reply:
        `Your Google Contacts are already connected! Last synced ${syncAge}.\n\n` +
        `Want me to sync again to pick up any changes? Just say "sync contacts."`,
      expectsReply: true,
    };
  }

  return {
    reply:
      `Your Google account is connected but hasn't synced yet. ` +
      `Want me to import your contacts now?`,
    expectsReply: true,
  };
}

// ===========================================================================
// 2. Post-Auth Callback — Trigger Import & Report Results
// ===========================================================================

/**
 * Called after the OAuth callback succeeds.
 *
 * This is the critical moment — the user just authorized Google access,
 * and now we import their contacts, analyze them, and text the results.
 *
 * @param env  - Worker environment
 * @param user - The user who just connected
 * @returns Bethany's results message (sent via SendBlue by the caller)
 */
export async function handlePostAuthImport(
  env: Env,
  user: UserRow,
): Promise<GoogleFlowResponse> {
  try {
    const result = await importGoogleContacts(env, env.DB, user.id, {
      requirePhone: true,
    });

    // Trigger analysis for newly imported contacts so suggestions are ready
    // when user visits the review page
    if (result.imported > 0) {
      try {
        await analyzeUserContacts(user.id, env.DB);
        console.log(`[google-flow] Analyzed contacts for user ${user.id}`);
      } catch (err) {
        // Log but don't fail the import — analysis can be triggered later
        console.error(`[google-flow] Analysis failed for user ${user.id}:`, err);
      }
    }

    return formatImportResults(result, user, env);
  } catch (err) {
    console.error(`[google-flow] Import failed for user ${user.id}:`, err);
    return handleImportError(err);
  }
}

/**
 * Format import results into Bethany's natural language response.
 */
function formatImportResults(
  result: ImportResult,
  user: UserRow,
  env: Env,
): GoogleFlowResponse {
  const { imported, duplicates, skipped } = result;
  const total = imported + duplicates;

  // Get review URL
  const dashboardUrl = env.DASHBOARD_URL || 'https://network-manager.pages.dev';
  const reviewUrl = `${dashboardUrl}/review`;

  // No contacts found at all
  if (total === 0 && skipped === 0) {
    return {
      reply:
        `Connected to Google, but I didn't find any contacts with phone numbers. ` +
        `No worries — you can add people by texting me their names, or do a brain dump ` +
        `of everyone you want to track.`,
      expectsReply: true,
    };
  }

  // All contacts were duplicates (already in the system)
  if (imported === 0 && duplicates > 0) {
    return {
      reply:
        `Synced with Google! Looks like I already had everyone — ` +
        `matched ${duplicates} contact${duplicates === 1 ? '' : 's'} that were already in your network. ` +
        `I've linked them to your Google account so future changes sync automatically.`,
      expectsReply: false,
    };
  }

  // Build the main results message
  let reply = `Done! Found ${total} contact${total === 1 ? '' : 's'} in Google.`;

  if (imported > 0 && duplicates > 0) {
    reply += ` Added ${imported} new, matched ${duplicates} you already had.`;
  } else if (imported > 0) {
    reply += ` Added ${imported} to your network.`;
  }

  if (skipped > 0) {
    reply += ` (Skipped ${skipped} without phone numbers.)`;
  }

  // Offer to sort if there are new unsorted contacts — include review link
  if (imported > 0) {
    reply += `\n\nI've analyzed them and have some suggestions. Tap here to review: ${reviewUrl}`;
  }

  return {
    reply,
    expectsReply: false, // Changed: link is in message, no need for reply
  };
}

// ===========================================================================
// 3. Re-sync (for already connected users)
// ===========================================================================

/**
 * Trigger a re-sync for a user who's already connected.
 *
 * Uses incremental sync when possible (only fetches changes since last sync).
 *
 * @param env  - Worker environment
 * @param user - The authenticated user
 * @returns Bethany's sync results message
 */
export async function handleResync(
  env: Env,
  user: UserRow,
): Promise<GoogleFlowResponse> {
  const status = await getConnectionStatus(env.DB, user.id);

  if (!status.connected) {
    return offerGoogleConnect(env, user);
  }

  try {
    const result = await importGoogleContacts(env, env.DB, user.id, {
      requirePhone: true,
    });

    // Trigger analysis for newly imported contacts
    if (result.imported > 0) {
      try {
        await analyzeUserContacts(user.id, env.DB);
        console.log(`[google-flow] Analyzed contacts after re-sync for user ${user.id}`);
      } catch (err) {
        console.error(`[google-flow] Analysis failed after re-sync for user ${user.id}:`, err);
      }
    }

    return formatResyncResults(result, env);
  } catch (err) {
    console.error(`[google-flow] Re-sync failed for user ${user.id}:`, err);
    return handleImportError(err);
  }
}

/**
 * Format re-sync results (different tone from initial import).
 */
function formatResyncResults(result: ImportResult, env: Env): GoogleFlowResponse {
  const { imported, updated, duplicates } = result;

  // Get review URL
  const dashboardUrl = env.DASHBOARD_URL || 'https://network-manager.pages.dev';
  const reviewUrl = `${dashboardUrl}/review`;

  if (imported === 0 && updated === 0) {
    return {
      reply: `All synced up — no changes since last time.`,
      expectsReply: false,
    };
  }

  const parts: string[] = [];
  if (imported > 0) parts.push(`${imported} new contact${imported === 1 ? '' : 's'}`);
  if (updated > 0) parts.push(`${updated} updated`);

  let reply = `Sync complete! ${parts.join(', ')}.`;

  if (imported > 0) {
    reply += ` I've analyzed them — tap here to review: ${reviewUrl}`;
  }

  return {
    reply,
    expectsReply: false,
  };
}

// ===========================================================================
// 4. Disconnect Google
// ===========================================================================

/**
 * Handle a user requesting to disconnect Google Contacts.
 *
 * @param env  - Worker environment
 * @param user - The authenticated user
 * @returns Bethany's confirmation message
 */
export async function handleDisconnect(
  env: Env,
  user: UserRow,
): Promise<GoogleFlowResponse> {
  const status = await getConnectionStatus(env.DB, user.id);

  if (!status.connected) {
    return {
      reply: `Google Contacts isn't connected. Nothing to disconnect!`,
      expectsReply: false,
    };
  }

  const result = await revokeAccess(env, env.DB, user.id);

  if (!result.success) {
    return {
      reply: `Had trouble disconnecting Google. Try again in a minute?`,
      expectsReply: false,
    };
  }

  return {
    reply:
      `Disconnected from Google. Your contacts are still here — ` +
      `I just won't sync new changes from Google anymore. ` +
      `You can reconnect anytime.`,
    expectsReply: false,
  };
}

// ===========================================================================
// 5. Error Handling
// ===========================================================================

/**
 * Handle auth errors — sent when the OAuth callback fails.
 *
 * @param env     - Worker environment
 * @param user    - The user who tried to connect
 * @param errCode - Error code from the callback
 * @returns Bethany's error message with retry link
 */
export async function handleAuthError(
  env: Env,
  user: UserRow,
  errCode: string,
): Promise<GoogleFlowResponse> {
  // Generate a fresh auth URL for retry
  let retryUrl: string | null = null;
  try {
    const { url } = await generateAuthUrl(env, user.id);
    retryUrl = url;
  } catch {
    // If we can't generate a URL, just give a generic message
  }

  if (errCode === 'access_denied') {
    // User clicked "Deny" on the Google consent screen
    return {
      reply:
        `No worries! You can always add contacts manually instead. ` +
        `Just tell me about the people you want to track.` +
        (retryUrl ? `\n\nChanged your mind? Tap here: ${retryUrl}` : ''),
      expectsReply: true,
    };
  }

  // Generic auth error
  return {
    reply:
      `Something went wrong connecting to Google. These things happen.` +
      (retryUrl ? `\n\nWant to try again? ${retryUrl}` : ` Try again in a minute.`),
    expectsReply: false,
  };
}

/**
 * Handle import errors (Google API failures, token issues, etc.)
 */
function handleImportError(err: unknown): GoogleFlowResponse {
  const message = err instanceof Error ? err.message : 'Unknown error';

  if (message.includes('revoked') || message.includes('re-authorize')) {
    return {
      reply:
        `Looks like my Google access was revoked. ` +
        `You'll need to reconnect — just say "connect Google" and I'll send a new link.`,
      expectsReply: true,
    };
  }

  return {
    reply:
      `Hit a snag pulling contacts from Google. ` +
      `Want to try again? Just say "sync contacts."`,
    expectsReply: true,
  };
}

// ===========================================================================
// 6. Proactive Offer (Post-Onboarding)
// ===========================================================================

/**
 * Generate a proactive offer to connect Google Contacts.
 *
 * Called after onboarding when the user has few contacts.
 * Lighter touch than the full offerGoogleConnect — just a suggestion.
 *
 * @param env  - Worker environment
 * @param user - The user who just finished onboarding
 * @param contactCount - How many contacts they have so far
 * @returns Bethany's suggestion message, or null if not appropriate
 */
export async function proactiveGoogleOffer(
  env: Env,
  user: UserRow,
  contactCount: number,
): Promise<GoogleFlowResponse | null> {
  // Don't offer if they already have plenty of contacts
  if (contactCount >= 10) return null;

  // Don't offer if already connected
  const status = await getConnectionStatus(env.DB, user.id);
  if (status.connected) return null;

  const { url } = await generateAuthUrl(env, user.id);

  return {
    reply:
      `By the way — I can import your contacts from Google if you want a head start. ` +
      `Way easier than adding everyone one by one 😏\n\n` +
      `${url}`,
    expectsReply: false,
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Format how long ago the last sync was in natural language.
 */
function formatSyncAge(isoDate: string): string {
  const syncDate = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - syncDate.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 5) return 'just now';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return 'last week';
  return `${Math.floor(diffDays / 7)} weeks ago`;
}
