/**
 * Google OAuth Service — Manages Google OAuth 2.0 tokens for contacts import.
 *
 * Handles the full OAuth lifecycle:
 *   1. Generate authorization URL with state param encoding user ID
 *   2. Exchange authorization code for access + refresh tokens
 *   3. Retrieve valid access tokens with automatic refresh
 *   4. Revoke access and clean up stored tokens
 *
 * Tokens are stored in the `oauth_tokens` table in D1, keyed by (user_id, provider).
 * The service is designed to be provider-agnostic — the `provider` column allows
 * future OAuth integrations (e.g., Microsoft, Apple) without schema changes.
 *
 * Security:
 *   - State parameter is HMAC-signed to prevent CSRF
 *   - Tokens are stored encrypted-at-rest (D1 disk encryption)
 *   - Access tokens are short-lived (1 hour); refresh tokens are long-lived
 *   - Refresh failures trigger user notification via SMS
 *
 * @see shared/types.ts for Env bindings (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
 * @see docs/google-people-api-reference.md for API details
 */

import type { Env } from '../../shared/types';

// ===========================================================================
// Configuration
// ===========================================================================

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

/** Scope for read-only access to user's contacts */
const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';

/** Buffer before expiry to trigger proactive refresh (5 minutes) */
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** HMAC algorithm for state parameter signing */
const STATE_HMAC_ALGO = 'SHA-256';

// ===========================================================================
// Types
// ===========================================================================

export interface OAuthTokenRow {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scopes: string;
  sync_token: string | null;
  last_sync: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

export type GenerateAuthUrlResult = {
  url: string;
  state: string;
};

export type CallbackResult =
  | { success: true; userId: string; scopes: string }
  | { success: false; error: string; code?: string };

export type GetTokenResult =
  | { success: true; accessToken: string }
  | { success: false; error: string; code: 'no_token' | 'refresh_failed' | 'revoked' };

export type RevokeResult =
  | { success: true }
  | { success: false; error: string };

// ===========================================================================
// 1. Generate Authorization URL
// ===========================================================================

/**
 * Generate a Google OAuth consent URL for a user.
 *
 * The state parameter encodes the user ID + HMAC signature to prevent CSRF.
 * Format: `{userId}:{hmacHex}`
 *
 * @param env    - Worker environment with GOOGLE_CLIENT_ID and PIN_SIGNING_SECRET
 * @param userId - The authenticated user requesting Google access
 * @returns URL to redirect the user to, and the state string for verification
 */
export async function generateAuthUrl(
  env: Env,
  userId: string,
): Promise<GenerateAuthUrlResult> {
  const state = await signState(userId, env.PIN_SIGNING_SECRET);

  const redirectUri = getRedirectUri(env);

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_CONTACTS_SCOPE,
    access_type: 'offline',       // Request refresh token
    prompt: 'consent',            // Force consent to always get refresh token
    state,
    include_granted_scopes: 'true',
  });

  const url = `${GOOGLE_AUTH_URL}?${params.toString()}`;

  return { url, state };
}

// ===========================================================================
// 2. Handle OAuth Callback
// ===========================================================================

/**
 * Handle the OAuth callback after user consents.
 *
 * Steps:
 *   1. Verify state parameter (HMAC check)
 *   2. Extract user ID from state
 *   3. Exchange authorization code for tokens
 *   4. Store tokens in D1 (upsert)
 *
 * @param env   - Worker environment
 * @param db    - D1 database
 * @param code  - Authorization code from Google
 * @param state - State parameter to verify
 * @returns Result with user ID on success, error on failure
 */
export async function handleCallback(
  env: Env,
  db: D1Database,
  code: string,
  state: string,
): Promise<CallbackResult> {
  // Verify state and extract user ID
  const stateResult = await verifyState(state, env.PIN_SIGNING_SECRET);
  if (!stateResult.valid) {
    return { success: false, error: 'Invalid state parameter — possible CSRF attack', code: 'invalid_state' };
  }

  const userId = stateResult.userId;

  // Verify user exists
  const user = await db
    .prepare('SELECT id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ id: string }>();

  if (!user) {
    return { success: false, error: 'User not found', code: 'user_not_found' };
  }

  // Exchange code for tokens
  const redirectUri = getRedirectUri(env);

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error(`[google-oauth] Token exchange failed (${tokenResponse.status}):`, errorBody);
    return { success: false, error: 'Failed to exchange authorization code', code: 'token_exchange_failed' };
  }

  const tokens = await tokenResponse.json<GoogleTokenResponse>();

  if (!tokens.access_token) {
    return { success: false, error: 'No access token in response', code: 'no_access_token' };
  }

  // Calculate expiry
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Upsert token record
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, scopes, created_at, updated_at)
       VALUES (?, ?, 'google', ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id, provider) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
         expires_at = excluded.expires_at,
         scopes = excluded.scopes,
         updated_at = datetime('now')`
    )
    .bind(
      id,
      userId,
      tokens.access_token,
      tokens.refresh_token ?? null,
      expiresAt,
      tokens.scope || GOOGLE_CONTACTS_SCOPE,
    )
    .run();

  console.log(`[google-oauth] Tokens stored for user ${userId}, scopes: ${tokens.scope}`);

  return { success: true, userId, scopes: tokens.scope || GOOGLE_CONTACTS_SCOPE };
}

// ===========================================================================
// 3. Get Valid Access Token (with auto-refresh)
// ===========================================================================

/**
 * Get a valid access token for a user, refreshing if expired or near-expiry.
 *
 * Token refresh is proactive — refreshes 5 minutes before actual expiry to
 * avoid failures during API calls.
 *
 * @param env    - Worker environment
 * @param db     - D1 database
 * @param userId - User to get token for
 * @returns Valid access token or error
 */
export async function getValidToken(
  env: Env,
  db: D1Database,
  userId: string,
): Promise<GetTokenResult> {
  const tokenRow = await db
    .prepare(
      'SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?'
    )
    .bind(userId, 'google')
    .first<OAuthTokenRow>();

  if (!tokenRow) {
    return { success: false, error: 'No Google token found — user needs to connect', code: 'no_token' };
  }

  // Check if token is still valid (with buffer)
  const expiresAt = new Date(tokenRow.expires_at).getTime();
  const now = Date.now();

  if (expiresAt - now > TOKEN_REFRESH_BUFFER_MS) {
    // Token is still valid
    return { success: true, accessToken: tokenRow.access_token };
  }

  // Token expired or expiring soon — refresh it
  if (!tokenRow.refresh_token) {
    return {
      success: false,
      error: 'Token expired and no refresh token available — user needs to re-authorize',
      code: 'revoked',
    };
  }

  const refreshResult = await refreshAccessToken(env, db, userId, tokenRow.refresh_token);
  return refreshResult;
}

/**
 * Refresh an access token using the stored refresh token.
 */
async function refreshAccessToken(
  env: Env,
  db: D1Database,
  userId: string,
  refreshToken: string,
): Promise<GetTokenResult> {
  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error(`[google-oauth] Token refresh failed (${tokenResponse.status}):`, errorBody);

    // Check for specific revocation errors
    try {
      const errorJson = JSON.parse(errorBody);
      if (errorJson.error === 'invalid_grant') {
        // Refresh token has been revoked — clean up
        await db
          .prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?')
          .bind(userId, 'google')
          .run();

        return {
          success: false,
          error: 'Google access has been revoked — user needs to reconnect',
          code: 'revoked',
        };
      }
    } catch { /* ignore parse error */ }

    return {
      success: false,
      error: 'Failed to refresh Google token',
      code: 'refresh_failed',
    };
  }

  const tokens = await tokenResponse.json<GoogleTokenResponse>();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Update stored token
  await db
    .prepare(
      `UPDATE oauth_tokens
       SET access_token = ?, expires_at = ?, updated_at = datetime('now')
       WHERE user_id = ? AND provider = ?`
    )
    .bind(tokens.access_token, newExpiresAt, userId, 'google')
    .run();

  console.log(`[google-oauth] Token refreshed for user ${userId}`);

  return { success: true, accessToken: tokens.access_token };
}

// ===========================================================================
// 4. Revoke Access
// ===========================================================================

/**
 * Disconnect Google access — revokes the token with Google and removes from DB.
 *
 * @param env    - Worker environment
 * @param db     - D1 database
 * @param userId - User to disconnect
 * @returns Success or error
 */
export async function revokeAccess(
  env: Env,
  db: D1Database,
  userId: string,
): Promise<RevokeResult> {
  const tokenRow = await db
    .prepare('SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?')
    .bind(userId, 'google')
    .first<OAuthTokenRow>();

  if (!tokenRow) {
    return { success: false, error: 'No Google connection found' };
  }

  // Revoke with Google (best-effort — we delete locally regardless)
  const tokenToRevoke = tokenRow.refresh_token || tokenRow.access_token;

  try {
    const revokeResponse = await fetch(
      `${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(tokenToRevoke)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    if (!revokeResponse.ok) {
      console.warn(`[google-oauth] Revocation returned ${revokeResponse.status} for user ${userId} — proceeding with local cleanup`);
    }
  } catch (err) {
    console.warn(`[google-oauth] Revocation request failed for user ${userId}:`, err);
  }

  // Always delete local token record
  await db
    .prepare('DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?')
    .bind(userId, 'google')
    .run();

  // Clear sync token from contacts (keep google_resource_name for potential re-connect)
  console.log(`[google-oauth] Google access revoked for user ${userId}`);

  return { success: true };
}

// ===========================================================================
// Sync Token Management
// ===========================================================================

/**
 * Store a sync token for incremental Google Contacts syncing.
 */
export async function storeSyncToken(
  db: D1Database,
  userId: string,
  syncToken: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE oauth_tokens
       SET sync_token = ?, last_sync = datetime('now'), updated_at = datetime('now')
       WHERE user_id = ? AND provider = ?`
    )
    .bind(syncToken, userId, 'google')
    .run();
}

/**
 * Get the stored sync token for a user.
 */
export async function getSyncToken(
  db: D1Database,
  userId: string,
): Promise<{ syncToken: string | null; lastSync: string | null }> {
  const row = await db
    .prepare('SELECT sync_token, last_sync FROM oauth_tokens WHERE user_id = ? AND provider = ?')
    .bind(userId, 'google')
    .first<{ sync_token: string | null; last_sync: string | null }>();

  return {
    syncToken: row?.sync_token ?? null,
    lastSync: row?.last_sync ?? null,
  };
}

/**
 * Clear the sync token (forces full re-sync on next run).
 */
export async function clearSyncToken(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE oauth_tokens
       SET sync_token = NULL, updated_at = datetime('now')
       WHERE user_id = ? AND provider = ?`
    )
    .bind(userId, 'google')
    .run();
}

// ===========================================================================
// Connection Status
// ===========================================================================

/**
 * Check if a user has Google connected and return status info.
 */
export async function getConnectionStatus(
  db: D1Database,
  userId: string,
): Promise<{
  connected: boolean;
  scopes: string | null;
  lastSync: string | null;
  hasSyncToken: boolean;
}> {
  const row = await db
    .prepare('SELECT scopes, last_sync, sync_token FROM oauth_tokens WHERE user_id = ? AND provider = ?')
    .bind(userId, 'google')
    .first<{ scopes: string; last_sync: string | null; sync_token: string | null }>();

  if (!row) {
    return { connected: false, scopes: null, lastSync: null, hasSyncToken: false };
  }

  return {
    connected: true,
    scopes: row.scopes,
    lastSync: row.last_sync,
    hasSyncToken: !!row.sync_token,
  };
}

/**
 * Get all users with active Google connections (for cron sync jobs).
 */
export async function getConnectedUsers(
  db: D1Database,
): Promise<Array<{ userId: string; lastSync: string | null }>> {
  const { results } = await db
    .prepare(
      'SELECT user_id, last_sync FROM oauth_tokens WHERE provider = ? AND refresh_token IS NOT NULL'
    )
    .bind('google')
    .all<{ user_id: string; last_sync: string | null }>();

  return results.map((r) => ({ userId: r.user_id, lastSync: r.last_sync }));
}

// ===========================================================================
// State Parameter Helpers (CSRF protection)
// ===========================================================================

/**
 * Sign a state parameter: `{userId}:{hmacHex}`
 */
async function signState(userId: string, secret: string): Promise<string> {
  const signature = await hmacHex(userId, secret);
  return `${userId}:${signature}`;
}

/**
 * Verify a state parameter and extract the user ID.
 */
async function verifyState(
  state: string,
  secret: string,
): Promise<{ valid: true; userId: string } | { valid: false }> {
  const colonIdx = state.lastIndexOf(':');
  if (colonIdx === -1) return { valid: false };

  const userId = state.substring(0, colonIdx);
  const signature = state.substring(colonIdx + 1);

  if (!userId || !signature) return { valid: false };

  const expectedSig = await hmacHex(userId, secret);

  if (!constantTimeEqual(signature, expectedSig)) {
    return { valid: false };
  }

  return { valid: true, userId };
}

// ===========================================================================
// Crypto Helpers
// ===========================================================================

async function hmacHex(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: STATE_HMAC_ALGO },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ===========================================================================
// Redirect URI Helper
// ===========================================================================

/**
 * Build the OAuth redirect URI based on environment.
 * The callback is handled by the worker at /api/auth/google/callback.
 * 
 * NOTE: We use WORKER_URL, not DASHBOARD_URL, because the Pages site
 * doesn't handle /api/* routes — only the Worker does.
 */
function getRedirectUri(env: Env): string {
  const workerUrl = env.WORKER_URL || 'https://network-manager.micaiah-tasks.workers.dev';
  return `${workerUrl}/api/auth/google/callback`;
}
