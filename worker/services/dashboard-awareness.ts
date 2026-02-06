/**
 * Dashboard Awareness Module — Bethany's Knowledge of the Web Dashboard
 *
 * This module gives Bethany contextual awareness of the web dashboard so she
 * can naturally reference it in conversation. Bethany is the primary interface;
 * the dashboard is secondary. She suggests it when it genuinely helps — for
 * visual overviews, bulk operations, or exports — not as a deflection.
 *
 * Key capabilities:
 *
 *   1. Magic link generation — Creates short-lived, pre-authenticated URLs
 *      that Bethany can text to users. Clicking the link logs them in
 *      automatically and lands them on the right page.
 *
 *   2. Trigger detection — Logic for when Bethany should mention the dashboard
 *      based on conversation context (unsorted contacts, health checks,
 *      export requests, etc.)
 *
 *   3. Response helpers — Pre-built snippets Bethany can weave into her
 *      replies that feel natural, not robotic.
 *
 * Magic Link Flow:
 *
 *   1. Bethany generates a magic token (signed JWT, 15-min expiry)
 *   2. Token is embedded as a query param: /magic?token=xxx&redirect=/overview
 *   3. Dashboard's magic route verifies the token, sets a session cookie,
 *      and redirects to the target page
 *   4. User lands on the dashboard already logged in
 *
 * Security:
 *
 *   - Magic tokens are single-use (consumed on first use via D1 tracking)
 *   - 15-minute expiry window (short enough to be secure, long enough to tap)
 *   - Same HMAC-SHA256 signing as session JWTs
 *   - Tokens are scoped to a specific user ID
 *
 * Schema requirement:
 *
 *   This module requires a `magic_tokens` table in D1.
 *   See migrations/0005_magic_tokens.sql
 *
 * @see worker/services/auth-service.ts for session creation after magic link
 * @see worker/services/conversation-router.ts for integration points
 */

import type { Env } from '../../shared/types';
import type { UserRow } from '../../shared/models';
import { createSessionToken, buildSessionCookie } from './auth-service';

// ===========================================================================
// Configuration
// ===========================================================================

/** Magic link token expiry in minutes */
const MAGIC_TOKEN_EXPIRY_MINUTES = 15;

/** Max magic links per user per hour (rate limiting) */
const MAX_MAGIC_LINKS_PER_HOUR = 10;

// ===========================================================================
// Dashboard Pages — URL mapping for each page
// ===========================================================================

/**
 * Dashboard page identifiers and their paths.
 *
 * Used by Bethany to generate the right URL when she references
 * a specific dashboard feature.
 */
export type DashboardPage =
  | 'overview'
  | 'contacts'
  | 'braindump'
  | 'import'
  | 'settings';

const PAGE_PATHS: Record<DashboardPage, string> = {
  overview: '/overview',
  contacts: '/contacts',
  braindump: '/braindump',
  import: '/import',
  settings: '/settings',
};

/**
 * Human-friendly page descriptions for Bethany's responses.
 */
const PAGE_DESCRIPTIONS: Record<DashboardPage, string> = {
  overview: 'your network overview',
  contacts: 'your full contact list',
  braindump: 'the braindump page',
  import: 'the import page',
  settings: 'your account settings',
};

// ===========================================================================
// Magic Link Generation
// ===========================================================================

/**
 * Generate a pre-authenticated magic link to a specific dashboard page.
 *
 * The link contains a signed, single-use token that automatically logs
 * the user in and redirects to the target page.
 *
 * @param env       - Worker environment bindings
 * @param user      - The user record
 * @param page      - Dashboard page to link to (default: 'overview')
 * @param extraParams - Optional query params to append to the redirect URL
 * @returns The full magic link URL, or error if rate limited
 */
export async function generateMagicLink(
  env: Env,
  user: UserRow,
  page: DashboardPage = 'overview',
  extraParams?: Record<string, string>,
): Promise<{ url: string } | { error: string; reason: 'rate_limited' }> {
  const db = env.DB;
  const now = new Date();

  // Rate limit: max links per hour per user
  const recentCount = await countRecentMagicLinks(db, user.id, now);
  if (recentCount >= MAX_MAGIC_LINKS_PER_HOUR) {
    return { error: 'Too many dashboard links requested. Try again in a bit.', reason: 'rate_limited' };
  }

  // Generate a random token
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = arrayToBase64Url(tokenBytes);

  // Hash the token for storage (we never store the raw token)
  const tokenHash = await hmacHash(token, env.PIN_SIGNING_SECRET);

  // Build redirect path with optional params
  let redirect = PAGE_PATHS[page];
  if (extraParams && Object.keys(extraParams).length > 0) {
    const searchParams = new URLSearchParams(extraParams);
    redirect += `?${searchParams.toString()}`;
  }

  // Expiry
  const expiresAt = new Date(now);
  expiresAt.setMinutes(expiresAt.getMinutes() + MAGIC_TOKEN_EXPIRY_MINUTES);

  // Store in D1
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO magic_tokens
         (id, user_id, token_hash, redirect, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(id, user.id, tokenHash, redirect, now.toISOString(), expiresAt.toISOString())
    .run();

  // Build the full URL
  const dashboardBaseUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
  const magicUrl = `${dashboardBaseUrl}/magic?token=${encodeURIComponent(token)}`;

  return { url: magicUrl };
}

/**
 * Verify and consume a magic link token.
 *
 * Called by the dashboard's /magic route handler. If valid:
 *   1. Marks the token as consumed (single-use)
 *   2. Creates a session JWT and cookie
 *   3. Returns the redirect path and cookie
 *
 * @param env   - Worker environment bindings
 * @param token - The raw token from the magic link query param
 * @returns Verification result with session cookie and redirect path
 */
export async function verifyMagicLink(
  env: Env,
  token: string,
): Promise<
  | { valid: true; redirect: string; cookie: string; userId: string }
  | { valid: false; reason: 'invalid' | 'expired' | 'consumed'; message: string }
> {
  const db = env.DB;
  const now = new Date();

  // Hash the provided token to look it up
  const tokenHash = await hmacHash(token, env.PIN_SIGNING_SECRET);

  // Find the token record
  const record = await db
    .prepare(
      `SELECT * FROM magic_tokens
       WHERE token_hash = ? AND status = 'pending'
       LIMIT 1`
    )
    .bind(tokenHash)
    .first<{
      id: string;
      user_id: string;
      token_hash: string;
      redirect: string;
      status: string;
      created_at: string;
      expires_at: string;
    }>();

  if (!record) {
    // Could be consumed or just invalid
    const consumed = await db
      .prepare(
        `SELECT id FROM magic_tokens WHERE token_hash = ? AND status = 'consumed' LIMIT 1`
      )
      .bind(tokenHash)
      .first();

    if (consumed) {
      return { valid: false, reason: 'consumed', message: 'This link has already been used. Request a new one from Bethany.' };
    }

    return { valid: false, reason: 'invalid', message: 'Invalid or expired link. Text Bethany to get a new one.' };
  }

  // Check expiry
  if (new Date(record.expires_at) <= now) {
    await db
      .prepare(`UPDATE magic_tokens SET status = 'expired' WHERE id = ?`)
      .bind(record.id)
      .run();

    return { valid: false, reason: 'expired', message: 'This link has expired. Text Bethany to get a fresh one.' };
  }

  // Consume the token (single-use)
  await db
    .prepare(
      `UPDATE magic_tokens SET status = 'consumed', consumed_at = ? WHERE id = ?`
    )
    .bind(now.toISOString(), record.id)
    .run();

  // Look up the user and create a session
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(record.user_id)
    .first<UserRow>();

  if (!user) {
    return { valid: false, reason: 'invalid', message: 'Account not found.' };
  }

  // Create session
  const sessionToken = await createSessionToken(user, env.PIN_SIGNING_SECRET, now);
  const cookie = buildSessionCookie(sessionToken, now);

  return {
    valid: true,
    redirect: record.redirect,
    cookie,
    userId: user.id,
  };
}

// ===========================================================================
// Dashboard Trigger Detection
// ===========================================================================

/**
 * Context about the user's current state, used to determine when
 * Bethany should reference the dashboard.
 */
export interface DashboardTriggerContext {
  /** Total contacts in the network */
  totalContacts: number;
  /** Number of unsorted contacts (no intent assigned) */
  unsortedCount: number;
  /** Health counts */
  healthCounts: { green: number; yellow: number; red: number };
  /** The conversation intent that was just handled */
  handledIntent: string;
  /** Whether the user asked about the dashboard explicitly */
  explicitDashboardRequest: boolean;
}

/**
 * Possible dashboard suggestions Bethany can make.
 */
export type DashboardSuggestion =
  | { type: 'none' }
  | {
      type: 'suggest';
      page: DashboardPage;
      reason: string;
      /** The snippet to append to Bethany's response */
      snippet: string;
      /** Priority — higher = more important to mention */
      priority: number;
    };

/**
 * Determine whether Bethany should reference the dashboard in her response.
 *
 * This is the main decision function. Call it after handling an intent
 * to see if a dashboard mention should be appended.
 *
 * Rules (from task spec):
 *   1. Large unsorted count (47+) → offer braindump page vs SMS sorting
 *   2. User asks to see their network → send dashboard link
 *   3. User asks to export → send to dashboard
 *   4. After updates → mention dashboard for the relevant circle/view
 *   5. Health checks → mention dashboard for the breakdown
 *
 * @param ctx - Current conversation context
 * @returns A suggestion, or { type: 'none' } if no dashboard mention needed
 */
export function detectDashboardTrigger(ctx: DashboardTriggerContext): DashboardSuggestion {
  // Explicit request always wins
  if (ctx.explicitDashboardRequest) {
    return {
      type: 'suggest',
      page: 'overview',
      reason: 'explicit_request',
      snippet: "Here's your dashboard — you can see everything at a glance:",
      priority: 100,
    };
  }

  // Rule 1: Large number of unsorted contacts → offer braindump page
  if (ctx.unsortedCount >= 47 && ctx.handledIntent === 'sort_contacts') {
    return {
      type: 'suggest',
      page: 'braindump',
      reason: 'bulk_unsorted',
      snippet: `With ${ctx.unsortedCount} contacts to sort, it might be faster to do this on the dashboard where you can see them all at once. Want me to send you a link?`,
      priority: 90,
    };
  }

  // Rule 2: User wants to see their network (check_health)
  if (ctx.handledIntent === 'check_health') {
    // If lots of unsorted, prioritize that message instead
    if (ctx.unsortedCount >= 15) {
      return {
        type: 'suggest',
        page: 'braindump',
        reason: 'unsorted_mention',
        snippet: `You've got ${ctx.unsortedCount} unsorted contacts — we can sort them here over text, or you can knock them out faster on the braindump page.`,
        priority: 70,
      };
    }

    return {
      type: 'suggest',
      page: 'overview',
      reason: 'health_check',
      snippet: "Your network's looking healthy — check your dashboard for the full breakdown anytime.",
      priority: 60,
    };
  }

  // Rule 3: Export request
  if (ctx.handledIntent === 'export') {
    return {
      type: 'suggest',
      page: 'contacts',
      reason: 'export_request',
      snippet: 'Head to your dashboard to export your contacts as CSV — you can filter by circle, layer, or health status.',
      priority: 80,
    };
  }

  // Rule 4: After sorting or updating contacts — gentle dashboard mention
  if (
    ctx.handledIntent === 'sort_contact' ||
    ctx.handledIntent === 'manage_circles' ||
    ctx.handledIntent === 'add_contact'
  ) {
    // Only mention if they have a decent-sized network (not during onboarding)
    if (ctx.totalContacts >= 10) {
      const page: DashboardPage = ctx.handledIntent === 'manage_circles' ? 'contacts' : 'overview';
      const circleLabel = ctx.handledIntent === 'manage_circles' ? 'circle' : 'network';
      return {
        type: 'suggest',
        page,
        reason: 'post_update',
        snippet: `You can see all your ${circleLabel} contacts on your dashboard anytime.`,
        priority: 30,
      };
    }
  }

  return { type: 'none' };
}

// ===========================================================================
// Response Helpers — Natural Snippets for Bethany
// ===========================================================================

/**
 * Build a response that includes a dashboard link.
 *
 * Generates the magic link and wraps it in Bethany's voice.
 *
 * @param env     - Worker environment
 * @param user    - User record
 * @param page    - Target dashboard page
 * @param intro   - Optional custom intro text (Bethany's voice)
 * @returns The text snippet with the magic link, ready to append to a response
 */
export async function buildDashboardSnippet(
  env: Env,
  user: UserRow,
  page: DashboardPage,
  intro?: string,
): Promise<string> {
  const result = await generateMagicLink(env, user, page);

  if ('error' in result) {
    // Rate limited — fall back to generic dashboard mention
    const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
    return intro
      ? `${intro}\n${dashboardUrl}`
      : `Check it out on your dashboard: ${dashboardUrl}`;
  }

  const defaultIntro = `Here's a link to ${PAGE_DESCRIPTIONS[page]}:`;
  return `${intro ?? defaultIntro}\n${result.url}`;
}

/**
 * Build Bethany's response when user explicitly asks for the dashboard.
 *
 * Handles messages like "dashboard", "show me my network", "send me the link".
 */
export async function handleDashboardRequest(
  env: Env,
  user: UserRow,
  page?: DashboardPage,
): Promise<{ reply: string; expectsReply: boolean }> {
  const targetPage = page ?? 'overview';
  const snippet = await buildDashboardSnippet(
    env,
    user,
    targetPage,
    "Here you go! This link will log you right in:",
  );

  return {
    reply: snippet,
    expectsReply: false,
  };
}

/**
 * Build a response offering the choice between SMS sorting and dashboard
 * for bulk contact operations.
 *
 * Used when unsorted count is high (47+) and the user triggers sort_contacts.
 */
export async function offerBulkSortingChoice(
  env: Env,
  user: UserRow,
  unsortedCount: number,
): Promise<{ reply: string; expectsReply: boolean }> {
  const dashboardLink = await generateMagicLink(env, user, 'braindump');

  let reply = `You've got ${unsortedCount} contacts waiting to be sorted! Two ways to tackle this:\n\n`;
  reply += `📱 Right here — I'll walk you through them one at a time over text. Say "let's sort" to start.\n\n`;
  reply += `💻 Dashboard — See them all at once and sort visually. Way faster for big batches.`;

  if (!('error' in dashboardLink)) {
    reply += `\n${dashboardLink.url}`;
  }

  reply += `\n\nWhat's your preference?`;

  return { reply, expectsReply: true };
}

/**
 * Build the post-health-check dashboard mention.
 *
 * Appends a natural dashboard suggestion after a health summary.
 */
export async function buildHealthCheckDashboardNote(
  env: Env,
  user: UserRow,
): Promise<string> {
  const link = await generateMagicLink(env, user, 'overview');
  if ('error' in link) {
    return "Check your dashboard for the full breakdown anytime.";
  }
  return `See the full breakdown on your dashboard:\n${link.url}`;
}

/**
 * Build the post-update dashboard mention.
 *
 * Gentle, non-pushy reminder after contact updates.
 */
export function buildPostUpdateNote(
  circleName?: string,
): string {
  if (circleName) {
    return `You can see all your ${circleName} contacts on your dashboard anytime.`;
  }
  return 'You can see your updated network on your dashboard anytime.';
}

// ===========================================================================
// Cleanup Cron
// ===========================================================================

/**
 * Purge expired magic link tokens.
 * Run daily alongside verification code cleanup.
 *
 * @param db - D1 database binding
 * @returns Number of rows deleted
 */
export async function purgeExpiredMagicTokens(
  db: D1Database,
): Promise<{ purged: number }> {
  const result = await db
    .prepare(
      `DELETE FROM magic_tokens
       WHERE created_at < datetime('now', '-1 day')`
    )
    .run();

  return { purged: result.meta.changes ?? 0 };
}

// ===========================================================================
// Crypto Helpers (duplicated from auth-service to avoid circular deps)
// ===========================================================================

async function hmacHash(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function arrayToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ===========================================================================
// D1 Helpers
// ===========================================================================

async function countRecentMagicLinks(
  db: D1Database,
  userId: string,
  now: Date,
): Promise<number> {
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM magic_tokens
       WHERE user_id = ? AND created_at > ?`
    )
    .bind(userId, oneHourAgo)
    .first<{ count: number }>();
  return result?.count ?? 0;
}