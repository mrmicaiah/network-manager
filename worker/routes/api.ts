/**
 * Dashboard API Router — RESTful routes for the web dashboard.
 *
 * All routes require authentication via requireAuth() from auth-service.
 * Session cookies are automatically refreshed when nearing expiry.
 *
 * Route groups:
 *
 *   /api/auth/*          — Login, verify, logout, session check
 *   /api/contacts/*      — CRUD, search, health recalculation
 *   /api/circles/*       — CRUD for contact circles
 *   /api/interactions/*  — Log and list interactions
 *   /api/braindump/*     — Parse natural language contact dumps
 *   /api/export/*        — CSV export with filters
 *   /api/import/*        — CSV import and bulk import flow
 *   /api/user/*          — Profile read/update
 *   /api/subscription/*  — Tier info, checkout, portal
 *   /api/stripe/webhook  — Stripe webhook handler (no auth)
 *
 * Standard response format:
 *
 *   Success: { data: <payload> }
 *   Error:   { error: "message", code?: "error_code" }
 *
 * @see worker/services/auth-service.ts for requireAuth(), withRefreshedSession()
 * @see worker/services/stripe-service.ts for Stripe integration
 * @see shared/http.ts for jsonResponse(), errorResponse()
 */

import type { Env } from '../../shared/types';
import { jsonResponse, errorResponse } from '../../shared/http';
import {
  requireAuth,
  withRefreshedSession,
  handleSendCode,
  handleVerifyCode,
  handleLogout,
  handleGetMe,
  type AuthContext,
} from '../services/auth-service';
import {
  createContact,
  getContactWithCircles,
  updateContact,
  archiveContact,
  restoreContact,
  deleteContact,
  listContacts,
  searchContacts,
  recalculateHealthStatuses,
  getHealthCounts,
  getIntentCounts,
  getContactCount,
  type PaginationOptions,
} from '../services/contact-service';
import {
  createCircle,
  getCircle,
  updateCircle,
  deleteCircle,
  listCircles,
} from '../services/circle-service';
import {
  logInteraction,
  listInteractions,
  getRecentInteractions,
} from '../services/interaction-service';
import { exportContacts, type ExportFilters } from '../services/export-service';
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
} from '../services/stripe-service';
import type {
  CreateContactInput,
  UpdateContactInput,
  ContactListFilters,
  IntentType,
  HealthStatus,
  ContactKind,
  InteractionMethod,
  CircleType,
} from '../../shared/models';

// ===========================================================================
// Main Router
// ===========================================================================

/**
 * Route an /api/* request to the appropriate handler.
 *
 * Called from index.ts when url.pathname.startsWith('/api/').
 */
export async function handleApiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ─── Auth routes (unauthenticated) ──────────────────────────
  if (path === '/api/auth/send-code' && method === 'POST') {
    return handleSendCode(request, env);
  }
  if (path === '/api/auth/verify' && method === 'POST') {
    return handleVerifyCode(request, env);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    return handleLogout();
  }
  if (path === '/api/auth/me' && method === 'GET') {
    return handleGetMe(request, env);
  }

  // ─── Stripe webhook (unauthenticated, verified by signature) ─
  if (path === '/api/stripe/webhook' && method === 'POST') {
    return handleStripeWebhook(request, env);
  }

  // ─── All remaining routes require auth ──────────────────────
  const auth = await requireAuth(request, env);
  if (!auth.valid) return auth.response;

  const { user } = auth.auth;
  const db = env.DB;

  let response: Response;

  try {
    // ─── Contacts ───────────────────────────────────────────────
    if (path === '/api/contacts' && method === 'GET') {
      response = await handleListContacts(url, db, user.id);
    } else if (path === '/api/contacts' && method === 'POST') {
      response = await handleCreateContact(request, db, user.id);
    } else if (path === '/api/contacts/search' && method === 'GET') {
      response = await handleSearchContacts(url, db, user.id);
    } else if (path === '/api/contacts/health' && method === 'GET') {
      response = await handleHealthSummary(db, user.id);
    } else if (path === '/api/contacts/recalculate' && method === 'POST') {
      response = await handleRecalculateHealth(db, user.id);
    } else if (path.match(/^\/api\/contacts\/[^/]+$/) && method === 'GET') {
      response = await handleGetContact(path, db, user.id);
    } else if (path.match(/^\/api\/contacts\/[^/]+$/) && method === 'PATCH') {
      response = await handleUpdateContact(request, path, db, user.id);
    } else if (path.match(/^\/api\/contacts\/[^/]+$/) && method === 'DELETE') {
      response = await handleDeleteContact(url, path, db, user.id);
    } else if (path.match(/^\/api\/contacts\/[^/]+\/archive$/) && method === 'POST') {
      response = await handleArchiveContact(path, db, user.id);
    } else if (path.match(/^\/api\/contacts\/[^/]+\/restore$/) && method === 'POST') {
      response = await handleRestoreContact(path, db, user.id);

    // ─── Circles ──────────────────────────────────────────────
    } else if (path === '/api/circles' && method === 'GET') {
      response = await handleListCircles(db, user.id);
    } else if (path === '/api/circles' && method === 'POST') {
      response = await handleCreateCircle(request, db, user.id);
    } else if (path.match(/^\/api\/circles\/[^/]+$/) && method === 'GET') {
      response = await handleGetCircle(path, db, user.id);
    } else if (path.match(/^\/api\/circles\/[^/]+$/) && method === 'PATCH') {
      response = await handleUpdateCircle(request, path, db, user.id);
    } else if (path.match(/^\/api\/circles\/[^/]+$/) && method === 'DELETE') {
      response = await handleDeleteCircle(path, db, user.id);

    // ─── Interactions ─────────────────────────────────────────
    } else if (path === '/api/interactions' && method === 'POST') {
      response = await handleLogInteraction(request, db, user.id);
    } else if (path === '/api/interactions' && method === 'GET') {
      response = await handleListInteractions(url, db, user.id);

    // ─── Braindump ────────────────────────────────────────────
    } else if (path === '/api/braindump/parse' && method === 'POST') {
      response = await handleBraindumpParse(request, env, user.id);

    // ─── Export ───────────────────────────────────────────────
    } else if (path === '/api/export' && method === 'GET') {
      response = await handleExport(url, db, user.id);

    // ─── Import (CSV upload, bulk import flow) ────────────────
    } else if (path.startsWith('/api/import/')) {
      const { handleImportRoute } = await import('./import');
      response = await handleImportRoute(request, env, user, path);

    // ─── User ─────────────────────────────────────────────────
    } else if (path === '/api/user' && method === 'GET') {
      response = await handleGetUser(auth.auth);
    } else if (path === '/api/user' && method === 'PATCH') {
      response = await handleUpdateUser(request, db, user.id);

    // ─── Subscription ─────────────────────────────────────────
    } else if (path === '/api/subscription' && method === 'GET') {
      response = await handleGetSubscription(db, user.id);
    } else if (path === '/api/subscription/checkout' && method === 'POST') {
      response = await handleCheckout(request, env, auth.auth);
    } else if (path === '/api/subscription/portal' && method === 'POST') {
      response = await handlePortal(request, env, auth.auth);

    // ─── 404 ──────────────────────────────────────────────────
    } else {
      response = errorResponse('Not found', 404);
    }
  } catch (err) {
    console.error(`[api] ${method} ${path} error:`, err);
    response = errorResponse('Internal server error', 500);
  }

  // Attach refreshed session cookie if needed
  if (auth.refreshedCookie) {
    response = withRefreshedSession(response, auth.refreshedCookie);
  }

  return response;
}

// ===========================================================================
// Contacts Handlers
// ===========================================================================

async function handleListContacts(
  url: URL,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const filters: ContactListFilters = {};
  const pagination: PaginationOptions = {};

  // Parse query params
  const intent = url.searchParams.get('intent');
  if (intent) filters.intent = intent as IntentType;

  const health = url.searchParams.get('health_status');
  if (health) filters.health_status = health as HealthStatus;

  const kind = url.searchParams.get('contact_kind');
  if (kind) filters.contact_kind = kind as ContactKind;

  const circleId = url.searchParams.get('circle_id');
  if (circleId) filters.circle_id = circleId;

  const search = url.searchParams.get('search');
  if (search) filters.search = search;

  const archived = url.searchParams.get('archived');
  if (archived === 'true') filters.archived = true;

  const limit = url.searchParams.get('limit');
  if (limit) pagination.limit = Math.min(parseInt(limit, 10) || 50, 100);

  const offset = url.searchParams.get('offset');
  if (offset) pagination.offset = parseInt(offset, 10) || 0;

  const orderBy = url.searchParams.get('order_by');
  if (orderBy) pagination.orderBy = orderBy as PaginationOptions['orderBy'];

  const orderDir = url.searchParams.get('order_dir');
  if (orderDir) pagination.orderDir = orderDir as PaginationOptions['orderDir'];

  const result = await listContacts(db, userId, filters, pagination);
  return jsonResponse({ data: result });
}

async function handleCreateContact(
  request: Request,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const body = await request.json<CreateContactInput>();

  if (!body.name?.trim()) {
    return errorResponse('Contact name is required', 400);
  }

  const contact = await createContact(db, userId, {
    ...body,
    name: body.name.trim(),
  });

  return jsonResponse({ data: contact }, 201);
}

async function handleGetContact(
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const contactId = extractId(path, '/api/contacts/');
  const contact = await getContactWithCircles(db, userId, contactId);

  if (!contact) return errorResponse('Contact not found', 404);
  return jsonResponse({ data: contact });
}

async function handleUpdateContact(
  request: Request,
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const contactId = extractId(path, '/api/contacts/');
  const body = await request.json<UpdateContactInput>();

  const contact = await updateContact(db, userId, contactId, body);
  if (!contact) return errorResponse('Contact not found', 404);

  return jsonResponse({ data: contact });
}

async function handleDeleteContact(
  url: URL,
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const contactId = extractId(path, '/api/contacts/');
  const hard = url.searchParams.get('hard') === 'true';

  const success = hard
    ? await deleteContact(db, userId, contactId)
    : await archiveContact(db, userId, contactId);

  if (!success) return errorResponse('Contact not found', 404);
  return jsonResponse({ data: { deleted: true } });
}

async function handleArchiveContact(
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const contactId = path.replace('/api/contacts/', '').replace('/archive', '');
  const success = await archiveContact(db, userId, contactId);

  if (!success) return errorResponse('Contact not found or already archived', 404);
  return jsonResponse({ data: { archived: true } });
}

async function handleRestoreContact(
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const contactId = path.replace('/api/contacts/', '').replace('/restore', '');
  const success = await restoreContact(db, userId, contactId);

  if (!success) return errorResponse('Contact not found or not archived', 404);
  return jsonResponse({ data: { restored: true } });
}

async function handleSearchContacts(
  url: URL,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const query = url.searchParams.get('q') ?? '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);

  const results = await searchContacts(db, userId, query, limit);
  return jsonResponse({ data: results });
}

async function handleHealthSummary(
  db: D1Database,
  userId: string,
): Promise<Response> {
  const [healthCounts, intentCounts, totalContacts] = await Promise.all([
    getHealthCounts(db, userId),
    getIntentCounts(db, userId),
    getContactCount(db, userId),
  ]);

  return jsonResponse({
    data: {
      total: totalContacts,
      byHealth: healthCounts,
      byIntent: intentCounts,
    },
  });
}

async function handleRecalculateHealth(
  db: D1Database,
  userId: string,
): Promise<Response> {
  const result = await recalculateHealthStatuses(db, userId);
  return jsonResponse({ data: result });
}

// ===========================================================================
// Circles Handlers
// ===========================================================================

async function handleListCircles(
  db: D1Database,
  userId: string,
): Promise<Response> {
  const circles = await listCircles(db, userId);
  return jsonResponse({ data: circles });
}

async function handleCreateCircle(
  request: Request,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const body = await request.json<{
    name: string;
    default_cadence_days?: number;
  }>();

  if (!body.name?.trim()) {
    return errorResponse('Circle name is required', 400);
  }

  const circle = await createCircle(db, userId, {
    name: body.name.trim(),
    type: 'custom' as CircleType,
    default_cadence_days: body.default_cadence_days ?? null,
  });

  return jsonResponse({ data: circle }, 201);
}

async function handleGetCircle(
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const circleId = extractId(path, '/api/circles/');
  const circle = await getCircle(db, userId, circleId);

  if (!circle) return errorResponse('Circle not found', 404);
  return jsonResponse({ data: circle });
}

async function handleUpdateCircle(
  request: Request,
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const circleId = extractId(path, '/api/circles/');
  const body = await request.json<{
    name?: string;
    default_cadence_days?: number | null;
    sort_order?: number;
  }>();

  const circle = await updateCircle(db, userId, circleId, body);
  if (!circle) return errorResponse('Circle not found', 404);

  return jsonResponse({ data: circle });
}

async function handleDeleteCircle(
  path: string,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const circleId = extractId(path, '/api/circles/');
  const success = await deleteCircle(db, userId, circleId);

  if (!success) return errorResponse('Circle not found or is a default circle', 404);
  return jsonResponse({ data: { deleted: true } });
}

// ===========================================================================
// Interactions Handlers
// ===========================================================================

async function handleLogInteraction(
  request: Request,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const body = await request.json<{
    contact_id: string;
    method: InteractionMethod;
    date?: string;
    summary?: string;
  }>();

  if (!body.contact_id) {
    return errorResponse('contact_id is required', 400);
  }
  if (!body.method) {
    return errorResponse('method is required', 400);
  }

  const interaction = await logInteraction(db, userId, {
    contact_id: body.contact_id,
    method: body.method,
    date: body.date,
    summary: body.summary,
    logged_via: 'dashboard',
  });

  return jsonResponse({ data: interaction }, 201);
}

async function handleListInteractions(
  url: URL,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const contactId = url.searchParams.get('contact_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

  if (contactId) {
    const interactions = await listInteractions(db, userId, contactId, limit);
    return jsonResponse({ data: interactions });
  }

  // Recent interactions across all contacts
  const interactions = await getRecentInteractions(db, userId, limit);
  return jsonResponse({ data: interactions });
}

// ===========================================================================
// Braindump Handler
// ===========================================================================

async function handleBraindumpParse(
  request: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const body = await request.json<{ text: string }>();

  if (!body.text?.trim()) {
    return errorResponse('Text content is required', 400);
  }

  // TODO: TASK — Implement braindump parsing with Claude API
  // For now, return a placeholder that signals the structure
  return errorResponse('Braindump parsing not yet implemented', 501);
}

// ===========================================================================
// Export Handler
// ===========================================================================

async function handleExport(
  url: URL,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const filters: ExportFilters = {};

  const intent = url.searchParams.get('intent');
  if (intent) filters.intent = intent as IntentType;

  const health = url.searchParams.get('health_status');
  if (health) filters.health_status = health as HealthStatus;

  const kind = url.searchParams.get('contact_kind');
  if (kind) filters.contact_kind = kind as ContactKind;

  const circleId = url.searchParams.get('circle_id');
  if (circleId) filters.circle_id = circleId;

  const archived = url.searchParams.get('archived');
  if (archived === 'true') filters.archived = true;

  const csv = await exportContacts(db, userId, filters);

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="bethany-contacts-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ===========================================================================
// User Handlers
// ===========================================================================

async function handleGetUser(auth: AuthContext): Promise<Response> {
  const { user } = auth;
  return jsonResponse({
    data: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      gender: user.gender,
      subscriptionTier: user.subscription_tier,
      onboardingStage: user.onboarding_stage,
      createdAt: user.created_at,
    },
  });
}

async function handleUpdateUser(
  request: Request,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const body = await request.json<{
    name?: string;
    email?: string;
    gender?: 'male' | 'female' | null;
  }>();

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.name !== undefined) {
    if (!body.name.trim()) return errorResponse('Name cannot be empty', 400);
    sets.push('name = ?');
    binds.push(body.name.trim());
  }
  if (body.email !== undefined) {
    sets.push('email = ?');
    binds.push(body.email);
  }
  if (body.gender !== undefined) {
    sets.push('gender = ?');
    binds.push(body.gender);
  }

  if (sets.length === 0) {
    return errorResponse('No fields to update', 400);
  }

  sets.push("updated_at = datetime('now')");
  binds.push(userId);

  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  // Return updated user
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first();

  return jsonResponse({ data: user });
}

// ===========================================================================
// Subscription Handlers
// ===========================================================================

async function handleGetSubscription(
  db: D1Database,
  userId: string,
): Promise<Response> {
  const user = await db
    .prepare(
      'SELECT subscription_tier, trial_ends_at, stripe_customer_id FROM users WHERE id = ?',
    )
    .bind(userId)
    .first<{
      subscription_tier: string;
      trial_ends_at: string | null;
      stripe_customer_id: string | null;
    }>();

  if (!user) return errorResponse('User not found', 404);

  const isTrialActive =
    user.subscription_tier === 'trial' &&
    user.trial_ends_at !== null &&
    new Date(user.trial_ends_at) > new Date();

  return jsonResponse({
    data: {
      tier: user.subscription_tier,
      isTrialActive,
      trialEndsAt: user.trial_ends_at,
      isPremium: user.subscription_tier === 'premium',
      hasStripe: !!user.stripe_customer_id,
    },
  });
}

/**
 * Create a Stripe Checkout session for upgrading to premium.
 * Returns the checkout URL for client-side redirect.
 */
async function handleCheckout(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const { user } = auth;

  // Already premium — no need to checkout
  if (user.subscription_tier === 'premium') {
    return errorResponse('Already subscribed to premium', 400, 'already_subscribed');
  }

  // Build redirect URLs
  const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
  const successUrl = `${dashboardUrl}/settings?upgrade=success`;
  const cancelUrl = `${dashboardUrl}/settings?upgrade=cancelled`;

  try {
    const result = await createCheckoutSession(
      env,
      user.id,
      user.email,
      user.phone,
      successUrl,
      cancelUrl,
      user.stripe_customer_id,
    );

    return jsonResponse({
      data: {
        checkoutUrl: result.url,
        sessionId: result.sessionId,
      },
    });
  } catch (err) {
    console.error('[api] Checkout session creation failed:', err);
    return errorResponse(
      err instanceof Error ? err.message : 'Failed to create checkout session',
      500,
    );
  }
}

/**
 * Create a Stripe Customer Portal session for managing subscription.
 * Only available for users with a Stripe customer ID.
 */
async function handlePortal(
  request: Request,
  env: Env,
  auth: AuthContext,
): Promise<Response> {
  const { user } = auth;

  if (!user.stripe_customer_id) {
    return errorResponse('No active subscription to manage', 400, 'no_subscription');
  }

  const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
  const returnUrl = `${dashboardUrl}/settings`;

  try {
    const result = await createPortalSession(env, user.stripe_customer_id, returnUrl);

    return jsonResponse({
      data: {
        portalUrl: result.url,
      },
    });
  } catch (err) {
    console.error('[api] Portal session creation failed:', err);
    return errorResponse(
      err instanceof Error ? err.message : 'Failed to create portal session',
      500,
    );
  }
}

// ===========================================================================
// Stripe Webhook Handler
// ===========================================================================

/**
 * Handle Stripe webhook events.
 * This endpoint is unauthenticated but verified via Stripe signature.
 */
async function handleStripeWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const signature = request.headers.get('Stripe-Signature');
  if (!signature) {
    return errorResponse('Missing Stripe-Signature header', 400);
  }

  const payload = await request.text();

  try {
    const result = await handleWebhook(env, env.DB, payload, signature);

    if (!result.success) {
      console.error(`[stripe] Webhook processing failed: ${result.message}`);
      // Return 200 anyway to acknowledge receipt (Stripe will retry on 4xx/5xx)
      // Only return error for signature failures
      if (result.message === 'Invalid webhook signature') {
        return errorResponse('Invalid signature', 401);
      }
    }

    return jsonResponse({
      data: {
        received: true,
        eventType: result.eventType,
        message: result.message,
      },
    });
  } catch (err) {
    console.error('[stripe] Webhook error:', err);
    return errorResponse('Webhook processing failed', 500);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract a resource ID from a path.
 * e.g., extractId('/api/contacts/abc-123', '/api/contacts/') → 'abc-123'
 */
function extractId(path: string, prefix: string): string {
  return path.slice(prefix.length).split('/')[0];
}
