/**
 * Google OAuth Route Handlers — API routes for Google Contacts integration.
 *
 * Routes:
 *
 *   POST /api/auth/google/connect     — Generate OAuth URL (dashboard-initiated)
 *   GET  /api/auth/google/callback    — OAuth callback from Google (NO auth required)
 *   POST /api/auth/google/disconnect  — Revoke Google access
 *   GET  /api/auth/google/status      — Connection status for dashboard UI
 *   POST /api/auth/google/sync        — Trigger manual re-sync
 *
 * The callback route is special:
 *   - It does NOT require session auth (user is redirected from Google)
 *   - Instead, it verifies the HMAC-signed state parameter
 *   - After processing, it redirects to the dashboard with a status message
 *   - It fires off Bethany's SMS results in the background via ctx.waitUntil
 *
 * @see worker/services/google-oauth-service.ts for OAuth lifecycle
 * @see worker/services/google-contacts-flow.ts for Bethany's conversation flow
 * @see worker/routes/api.ts (imports and calls these handlers)
 */

import type { Env } from '../../shared/types';
import type { UserRow } from '../../shared/models';
import { jsonResponse, errorResponse } from '../../shared/http';
import {
  generateAuthUrl,
  handleCallback,
  getConnectionStatus,
} from '../services/google-oauth-service';
import {
  offerGoogleConnect,
  handlePostAuthImport,
  handleResync,
  handleDisconnect,
  handleAuthError,
} from '../services/google-contacts-flow';

// ===========================================================================
// Types
// ===========================================================================

interface AuthenticatedContext {
  user: UserRow;
  env: Env;
  origin: string | null;
}

// ===========================================================================
// POST /api/auth/google/connect
// ===========================================================================

/**
 * Generate a Google OAuth authorization URL.
 *
 * Called by the dashboard when user clicks "Connect Google Contacts."
 * Returns the URL so the frontend can redirect/open it.
 *
 * Requires: session auth
 */
export async function handleGoogleConnect(
  ctx: AuthenticatedContext,
): Promise<Response> {
  const { user, env, origin } = ctx;

  try {
    // Check if already connected
    const status = await getConnectionStatus(env.DB, user.id);
    if (status.connected) {
      return jsonResponse(
        {
          data: {
            alreadyConnected: true,
            lastSync: status.lastSync,
            message: 'Google Contacts is already connected. Use /sync to refresh.',
          },
        },
        200,
        origin,
      );
    }

    const { url, state } = await generateAuthUrl(env, user.id);

    return jsonResponse(
      { data: { authUrl: url, state } },
      200,
      origin,
    );
  } catch (err) {
    console.error('[google-routes] Connect error:', err);
    return errorResponse('Failed to generate authorization URL', 500, undefined, origin);
  }
}

// ===========================================================================
// GET /api/auth/google/callback
// ===========================================================================

/**
 * Handle Google OAuth callback.
 *
 * This route is hit by Google's redirect after the user consents (or denies).
 * It does NOT require session auth — the state parameter proves the user.
 *
 * Flow:
 *   1. Check for error param (user denied or Google error)
 *   2. Extract code and state from query params
 *   3. Exchange code for tokens via handleCallback
 *   4. Redirect user to dashboard success/error page
 *   5. Fire background task: import contacts + send Bethany SMS
 *
 * @param request - The incoming request from Google's redirect
 * @param env     - Worker environment
 * @param ctx     - ExecutionContext for waitUntil
 */
export async function handleGoogleCallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';

  // Check for Google error (user denied access or other error)
  const error = url.searchParams.get('error');
  if (error) {
    console.log(`[google-routes] OAuth error from Google: ${error}`);

    // Extract userId from state for Bethany's error message
    const state = url.searchParams.get('state');
    if (state) {
      ctx.waitUntil(sendAuthErrorSms(env, state, error));
    }

    return redirectToDashboard(dashboardUrl, 'error', error);
  }

  // Extract code and state
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return redirectToDashboard(dashboardUrl, 'error', 'missing_params');
  }

  // Exchange code for tokens
  const result = await handleCallback(env, env.DB, code, state);

  if (!result.success) {
    console.error(`[google-routes] Callback failed: ${result.error}`);
    return redirectToDashboard(dashboardUrl, 'error', result.code ?? 'callback_failed');
  }

  // Success! Redirect to dashboard immediately — don't make user wait for import
  const response = redirectToDashboard(dashboardUrl, 'success');

  // Fire import + Bethany SMS in the background
  ctx.waitUntil(
    runPostAuthImport(env, result.userId),
  );

  return response;
}

// ===========================================================================
// POST /api/auth/google/disconnect
// ===========================================================================

/**
 * Disconnect Google Contacts.
 *
 * Revokes the OAuth token with Google and removes local records.
 * Existing contacts are preserved.
 *
 * Requires: session auth
 */
export async function handleGoogleDisconnect(
  ctx: AuthenticatedContext,
): Promise<Response> {
  const { user, env, origin } = ctx;

  try {
    const result = await handleDisconnect(env, user);

    return jsonResponse(
      { data: { disconnected: true, message: result.reply } },
      200,
      origin,
    );
  } catch (err) {
    console.error('[google-routes] Disconnect error:', err);
    return errorResponse('Failed to disconnect Google', 500, undefined, origin);
  }
}

// ===========================================================================
// GET /api/auth/google/status
// ===========================================================================

/**
 * Get Google Contacts connection status.
 *
 * Returns whether Google is connected, last sync time, and scopes.
 * Used by the dashboard settings page to show connection state.
 *
 * Requires: session auth
 */
export async function handleGoogleStatus(
  ctx: AuthenticatedContext,
): Promise<Response> {
  const { user, env, origin } = ctx;

  try {
    const status = await getConnectionStatus(env.DB, user.id);

    return jsonResponse(
      {
        data: {
          connected: status.connected,
          scopes: status.scopes,
          lastSync: status.lastSync,
          hasSyncToken: status.hasSyncToken,
        },
      },
      200,
      origin,
    );
  } catch (err) {
    console.error('[google-routes] Status error:', err);
    return errorResponse('Failed to check connection status', 500, undefined, origin);
  }
}

// ===========================================================================
// POST /api/auth/google/sync
// ===========================================================================

/**
 * Trigger a manual re-sync of Google Contacts.
 *
 * Uses incremental sync when possible (only changed contacts).
 * Returns import results.
 *
 * Requires: session auth
 */
export async function handleGoogleSync(
  ctx: AuthenticatedContext,
): Promise<Response> {
  const { user, env, origin } = ctx;

  try {
    const status = await getConnectionStatus(env.DB, user.id);

    if (!status.connected) {
      return errorResponse(
        'Google Contacts is not connected. Connect first.',
        400,
        'not_connected',
        origin,
      );
    }

    const { importGoogleContacts } = await import('../services/google-contacts-service');
    const result = await importGoogleContacts(env, env.DB, user.id, {
      requirePhone: true,
    });

    return jsonResponse(
      {
        data: {
          imported: result.imported,
          duplicates: result.duplicates,
          updated: result.updated,
          skipped: result.skipped,
          errors: result.errors,
        },
      },
      200,
      origin,
    );
  } catch (err) {
    console.error('[google-routes] Sync error:', err);
    return errorResponse('Failed to sync Google Contacts', 500, undefined, origin);
  }
}

// ===========================================================================
// Background Tasks
// ===========================================================================

/**
 * Run post-auth import and send Bethany's results SMS.
 *
 * Called via ctx.waitUntil so the user doesn't wait for import to finish.
 * The user is already redirected to the dashboard.
 */
async function runPostAuthImport(env: Env, userId: string): Promise<void> {
  try {
    // Look up user for Bethany's flow
    const user = await env.DB
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>();

    if (!user) {
      console.error(`[google-routes] User ${userId} not found for post-auth import`);
      return;
    }

    // Run import and get Bethany's message
    const result = await handlePostAuthImport(env, user);

    // Send SMS via SendBlue
    await sendSms(env, user.phone, result.reply);

    console.log(`[google-routes] Post-auth import + SMS sent for user ${userId}`);
  } catch (err) {
    console.error(`[google-routes] Post-auth import failed for user ${userId}:`, err);

    // Best-effort error SMS
    try {
      const user = await env.DB
        .prepare('SELECT phone FROM users WHERE id = ?')
        .bind(userId)
        .first<{ phone: string }>();

      if (user) {
        await sendSms(
          env,
          user.phone,
          'Hit a snag importing your Google contacts. Try saying "sync contacts" in a bit and I\'ll try again.',
        );
      }
    } catch { /* fail silently on error notification */ }
  }
}

/**
 * Send Bethany's auth error message when user denies or something goes wrong.
 *
 * The state parameter contains the userId, so we verify it and find the user.
 */
async function sendAuthErrorSms(
  env: Env,
  state: string,
  errorCode: string,
): Promise<void> {
  try {
    // Import verifyState indirectly — we need to extract userId from state
    // State format is "{userId}:{hmacHex}", so we can get userId without full verification
    const colonIdx = state.lastIndexOf(':');
    if (colonIdx === -1) return;

    const userId = state.substring(0, colonIdx);
    if (!userId) return;

    const user = await env.DB
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(userId)
      .first<UserRow>();

    if (!user) return;

    const result = await handleAuthError(env, user, errorCode);
    await sendSms(env, user.phone, result.reply);
  } catch (err) {
    console.error('[google-routes] Failed to send auth error SMS:', err);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Redirect user to the dashboard with a Google connection status.
 *
 * Builds a URL like:
 *   https://app.bethany.network/settings?google=success
 *   https://app.bethany.network/settings?google=error&reason=access_denied
 */
function redirectToDashboard(
  dashboardUrl: string,
  status: 'success' | 'error',
  reason?: string,
): Response {
  const url = new URL(`${dashboardUrl}/settings`);
  url.searchParams.set('google', status);
  if (reason) {
    url.searchParams.set('reason', reason);
  }

  return new Response(null, {
    status: 302,
    headers: { Location: url.toString() },
  });
}

/**
 * Send an SMS via SendBlue.
 */
async function sendSms(
  env: Env,
  phone: string,
  message: string,
): Promise<void> {
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
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[google-routes] SendBlue error:`, err);
    throw new Error(`SendBlue send failed: ${response.status}`);
  }
}
