/**
 * Dashboard Awareness Service — Bethany's Web Dashboard Integration
 *
 * Bethany is the primary interface. The dashboard is her visual companion —
 * a place for bulk operations, detailed views, and things that don't work
 * well in SMS. This service provides:
 *
 *   1. Authenticated URL generation for dashboard deep links
 *   2. Context-aware suggestions for when to reference the dashboard
 *   3. Natural language snippets Bethany can use in conversation
 *
 * When to Suggest Dashboard:
 *
 *   - Large number of unsorted contacts (47+) — offer braindump page
 *   - "See my network" / "show me everyone" — send dashboard link
 *   - Export requests — direct to dashboard export
 *   - After bulk updates — casual reference ("see all your [circle] there")
 *   - Health checks — offer breakdown link
 *   - Visual data requests — charts, graphs, detailed views
 *
 * URL Generation:
 *
 *   Dashboard URLs include a short-lived auth token so the user doesn't
 *   need to re-login when clicking from SMS. The token is a signed JWT
 *   with a 30-minute expiry.
 *
 * Usage in Handlers:
 *
 *   ```typescript
 *   import { getDashboardUrl, shouldOfferDashboard } from './dashboard-service';
 *
 *   // Generate a link to a specific page
 *   const url = await getDashboardUrl(env, user.id, 'contacts');
 *
 *   // Check if we should offer the dashboard for unsorted contacts
 *   const check = await shouldOfferDashboard(env, user.id, 'unsorted_contacts');
 *   if (check.should) {
 *     reply += `\n\n${check.suggestion}`;
 *   }
 *   ```
 *
 * @see worker/services/conversation-router.ts for usage in handlers
 * @see worker/services/auth-service.ts for the session token format
 */

import type { Env } from '../../shared/types';
import type { UserRow } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** Dashboard link token expiry in minutes */
const LINK_TOKEN_EXPIRY_MINUTES = 30;

/** Threshold for suggesting dashboard for unsorted contacts */
const UNSORTED_THRESHOLD_HIGH = 47;
const UNSORTED_THRESHOLD_MEDIUM = 20;

/** Threshold for suggesting dashboard for bulk viewing */
const BULK_VIEW_THRESHOLD = 15;

// ===========================================================================
// Types
// ===========================================================================

/**
 * Dashboard pages that can be linked to.
 */
export type DashboardPage =
  | 'home'
  | 'contacts'
  | 'contact'        // Single contact view (requires contactId)
  | 'circles'
  | 'circle'         // Single circle view (requires circleId)
  | 'health'
  | 'sort'           // Contact sorting / braindump page
  | 'import'         // Bulk import page
  | 'export'         // Export page
  | 'settings'
  | 'upgrade';

/**
 * Context for when to check if dashboard should be offered.
 */
export type DashboardSuggestionContext =
  | 'unsorted_contacts'  // User has many unsorted contacts
  | 'bulk_view'          // User asked to see all contacts/circles
  | 'export_request'     // User asked to export
  | 'health_check'       // User checked network health
  | 'after_update'       // After a bulk or circle update
  | 'visual_data';       // User asked for charts/graphs/details

/**
 * Result of a suggestion check.
 */
export interface SuggestionResult {
  should: boolean;
  reason?: string;
  suggestion?: string;
  url?: string;
}

// ===========================================================================
// URL Generation
// ===========================================================================

/**
 * Generate an authenticated dashboard URL for a specific page.
 *
 * The URL includes a short-lived token that auto-logs the user in
 * when clicked. This is a UX improvement for SMS — no login required.
 *
 * @param env       - Environment bindings (needs DASHBOARD_URL, PIN_SIGNING_SECRET)
 * @param userId    - The user's ID
 * @param page      - Which dashboard page to link to
 * @param params    - Optional parameters (contactId, circleId, etc.)
 * @param now       - Override current time (for testing)
 */
export async function getDashboardUrl(
  env: Env,
  userId: string,
  page: DashboardPage = 'home',
  params?: {
    contactId?: string;
    circleId?: string;
    filter?: string;
  },
  now?: Date,
): Promise<string> {
  const baseUrl = env.DASHBOARD_URL || 'https://app.untitledpublishers.com';

  // Build the path
  let path: string;
  switch (page) {
    case 'home':
      path = '/';
      break;
    case 'contacts':
      path = '/contacts';
      break;
    case 'contact':
      path = params?.contactId ? `/contacts/${params.contactId}` : '/contacts';
      break;
    case 'circles':
      path = '/circles';
      break;
    case 'circle':
      path = params?.circleId ? `/circles/${params.circleId}` : '/circles';
      break;
    case 'health':
      path = '/health';
      break;
    case 'sort':
      path = '/sort';
      break;
    case 'import':
      path = '/import';
      break;
    case 'export':
      path = '/export';
      break;
    case 'settings':
      path = '/settings';
      break;
    case 'upgrade':
      path = '/upgrade';
      break;
    default:
      path = '/';
  }

  // Generate a short-lived token for auto-login
  const token = await generateLinkToken(userId, env.PIN_SIGNING_SECRET, now);

  // Add filter query param if provided
  const queryParams = new URLSearchParams();
  queryParams.set('token', token);
  if (params?.filter) {
    queryParams.set('filter', params.filter);
  }

  return `${baseUrl}${path}?${queryParams.toString()}`;
}

/**
 * Generate a shorter, friendlier dashboard URL for SMS.
 *
 * Since SMS has character limits and long URLs look scary,
 * this returns a simplified URL. The token is still included
 * but the path is cleaner.
 */
export async function getShortDashboardUrl(
  env: Env,
  userId: string,
  page: DashboardPage = 'home',
  now?: Date,
): Promise<string> {
  const baseUrl = env.DASHBOARD_URL || 'https://app.untitledpublishers.com';
  const token = await generateLinkToken(userId, env.PIN_SIGNING_SECRET, now);

  // For short links, use a single path segment + token
  const paths: Record<DashboardPage, string> = {
    home: '/',
    contacts: '/contacts',
    contact: '/contacts',
    circles: '/circles',
    circle: '/circles',
    health: '/health',
    sort: '/sort',
    import: '/import',
    export: '/export',
    settings: '/settings',
    upgrade: '/upgrade',
  };

  return `${baseUrl}${paths[page]}?t=${token}`;
}

// ===========================================================================
// Suggestion Logic
// ===========================================================================

/**
 * Check if the dashboard should be offered in a given context.
 *
 * Returns whether to suggest, why, and a natural language suggestion
 * Bethany can use in her response.
 *
 * @param env     - Environment bindings
 * @param userId  - The user's ID
 * @param context - What context we're checking for
 * @param data    - Additional data for the check (counts, etc.)
 */
export async function shouldOfferDashboard(
  env: Env,
  userId: string,
  context: DashboardSuggestionContext,
  data?: {
    unsortedCount?: number;
    contactCount?: number;
    circleName?: string;
  },
): Promise<SuggestionResult> {
  switch (context) {
    case 'unsorted_contacts':
      return checkUnsortedContacts(env, userId, data?.unsortedCount);

    case 'bulk_view':
      return checkBulkView(env, userId, data?.contactCount);

    case 'export_request':
      return {
        should: true,
        reason: 'User requested export',
        suggestion: 'You can export your network from the dashboard.',
        url: await getShortDashboardUrl(env, userId, 'export'),
      };

    case 'health_check':
      return {
        should: true,
        reason: 'User checked health',
        suggestion: 'Check out your dashboard for a full breakdown.',
        url: await getShortDashboardUrl(env, userId, 'health'),
      };

    case 'after_update':
      if (data?.circleName) {
        return {
          should: true,
          reason: 'Circle update completed',
          suggestion: `You can see all your ${data.circleName} contacts on your dashboard anytime.`,
          url: await getShortDashboardUrl(env, userId, 'circles'),
        };
      }
      return {
        should: true,
        reason: 'Update completed',
        suggestion: 'You can see your updated network on the dashboard.',
        url: await getShortDashboardUrl(env, userId, 'contacts'),
      };

    case 'visual_data':
      return {
        should: true,
        reason: 'User wants visual data',
        suggestion: 'Check your dashboard for charts and detailed views.',
        url: await getShortDashboardUrl(env, userId, 'health'),
      };

    default:
      return { should: false };
  }
}

/**
 * Check if we should suggest the dashboard for unsorted contacts.
 */
async function checkUnsortedContacts(
  env: Env,
  userId: string,
  providedCount?: number,
): Promise<SuggestionResult> {
  // If count is provided, use it; otherwise query
  let count = providedCount;
  if (count === undefined) {
    const result = await env.DB
      .prepare(
        `SELECT COUNT(*) as count FROM contacts
         WHERE user_id = ? AND archived = 0 AND intent = 'new'`
      )
      .bind(userId)
      .first<{ count: number }>();
    count = result?.count ?? 0;
  }

  if (count >= UNSORTED_THRESHOLD_HIGH) {
    const url = await getShortDashboardUrl(env, userId, 'sort');
    return {
      should: true,
      reason: `High unsorted count: ${count}`,
      suggestion: `That's a lot to sort via text! You can knock them out faster on the braindump page: ${url}`,
      url,
    };
  }

  if (count >= UNSORTED_THRESHOLD_MEDIUM) {
    const url = await getShortDashboardUrl(env, userId, 'sort');
    return {
      should: true,
      reason: `Medium unsorted count: ${count}`,
      suggestion: `You've got ${count} contacts to sort. Want to do it here, or use the dashboard for a faster view? ${url}`,
      url,
    };
  }

  return { should: false };
}

/**
 * Check if we should suggest the dashboard for bulk viewing.
 */
async function checkBulkView(
  env: Env,
  userId: string,
  providedCount?: number,
): Promise<SuggestionResult> {
  let count = providedCount;
  if (count === undefined) {
    const result = await env.DB
      .prepare(
        `SELECT COUNT(*) as count FROM contacts
         WHERE user_id = ? AND archived = 0`
      )
      .bind(userId)
      .first<{ count: number }>();
    count = result?.count ?? 0;
  }

  if (count >= BULK_VIEW_THRESHOLD) {
    const url = await getShortDashboardUrl(env, userId, 'contacts');
    return {
      should: true,
      reason: `Large network: ${count} contacts`,
      suggestion: `With ${count} contacts, the dashboard might be easier to browse: ${url}`,
      url,
    };
  }

  return { should: false };
}

// ===========================================================================
// Natural Language Snippets
// ===========================================================================

/**
 * Get a natural-sounding dashboard reference for Bethany.
 *
 * These are casual, context-appropriate ways to mention the dashboard
 * without sounding robotic or salesy.
 */
export function getDashboardMention(
  context: 'health' | 'circles' | 'sorting' | 'general' | 'after_update',
  url?: string,
): string {
  const mentions: Record<string, string[]> = {
    health: [
      "Your dashboard has the full breakdown.",
      "Check your dashboard for all the details.",
      "Pop over to the dashboard for a visual.",
    ],
    circles: [
      "You can see everyone on the dashboard.",
      "Your dashboard has the full list.",
      "Check the dashboard to see them all.",
    ],
    sorting: [
      "The dashboard's braindump page is faster for lots of contacts.",
      "Want to speed through these? Try the dashboard.",
      "The web version is quicker for batch sorting.",
    ],
    after_update: [
      "You can see the changes on your dashboard anytime.",
      "Check your dashboard to see how it looks now.",
      "Your dashboard's updated with the changes.",
    ],
    general: [
      "Check out your dashboard for more.",
      "Your dashboard has everything.",
      "Pop over to the dashboard anytime.",
    ],
  };

  const options = mentions[context] || mentions.general;
  const mention = options[Math.floor(Math.random() * options.length)];

  return url ? `${mention} ${url}` : mention;
}

/**
 * Get a feature explanation for when users ask about the dashboard.
 */
export function getDashboardExplanation(): string {
  return `Your dashboard is where you can:

📊 See your whole network at a glance
🔴🟡🟢 Visual health breakdown by layer
📋 Sort contacts faster with the braindump page
📤 Export your network
⚙️ Manage settings and subscription

I handle most things via text, but the dashboard is great for visual stuff and bulk actions. Want a link?`;
}

// ===========================================================================
// Token Generation
// ===========================================================================

/**
 * Generate a short-lived JWT for dashboard auto-login.
 *
 * This token is included in dashboard URLs sent via SMS. When the
 * user clicks, the dashboard validates the token and creates a session.
 *
 * Token format: { sub: userId, purpose: 'link', iat, exp }
 */
async function generateLinkToken(
  userId: string,
  secret: string,
  now?: Date,
): Promise<string> {
  const currentTime = now ?? new Date();
  const expiresAt = new Date(currentTime);
  expiresAt.setMinutes(expiresAt.getMinutes() + LINK_TOKEN_EXPIRY_MINUTES);

  const payload = {
    sub: userId,
    purpose: 'link',
    iat: Math.floor(currentTime.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  return signLinkJwt(payload, secret);
}

/**
 * Validate a link token from a dashboard URL.
 *
 * Returns the userId if valid, null otherwise.
 */
export async function validateLinkToken(
  token: string,
  secret: string,
  now?: Date,
): Promise<string | null> {
  const currentTime = now ?? new Date();

  const payload = await verifyLinkJwt(token, secret);
  if (!payload) return null;

  // Check purpose
  if (payload.purpose !== 'link') return null;

  // Check expiry
  const expiry = new Date(payload.exp * 1000);
  if (expiry <= currentTime) return null;

  return payload.sub;
}

// ===========================================================================
// JWT Helpers (simplified, inline to avoid circular dependencies)
// ===========================================================================

interface LinkTokenPayload {
  sub: string;
  purpose: string;
  iat: number;
  exp: number;
}

async function signLinkJwt(payload: LinkTokenPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await hmacSign(signingInput, secret);
  const signatureB64 = base64UrlEncodeBuffer(signature);

  return `${signingInput}.${signatureB64}`;
}

async function verifyLinkJwt(token: string, secret: string): Promise<LinkTokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const expectedSig = await hmacSign(signingInput, secret);
  const expectedB64 = base64UrlEncodeBuffer(expectedSig);

  if (!constantTimeEqual(signatureB64, expectedB64)) return null;

  try {
    const payloadJson = base64UrlDecode(payloadB64);
    return JSON.parse(payloadJson) as LinkTokenPayload;
  } catch {
    return null;
  }
}

async function hmacSign(data: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64UrlEncode(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  return base64UrlEncodeBuffer(bytes.buffer as ArrayBuffer);
}

function base64UrlEncodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}
