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
 *   /api/circles/*       — CRUD for contact circles, reordering
 *   /api/interactions/*  — Log and list interactions (with circle context)
 *   /api/braindump/*     — Parse natural language contact dumps
 *   /api/export/*        — CSV export with filters
 *   /api/import/*        — CSV import and bulk import flow
 *   /api/user/*          — Profile read/update, notification preferences, account deletion
 *   /api/subscription/*  — Tier info, checkout, portal
 *   /api/dashboard/*     — Dashboard tabs and dartboard data
 *   /api/admin/*         — Admin dashboard (permission-guarded)
 *   /api/stripe/webhook  — Stripe webhook handler (no auth)
 *
 * Standard response format:
 *
 *   Success: { data: <payload> }
 *   Error:   { error: "message", code?: "error_code" }
 */

import type { Env } from '../../shared/types';
import { jsonResponse, errorResponse } from '../../shared/http';
import { handleAdminRoute } from './admin';
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
  listCirclesWithCounts,
  reorderCircles,
} from '../services/circle-service';
import {
  logInteraction,
  getInteractionHistory,
  getInteractionHistoryWithCircles,
  getRecentInteractions,
} from '../services/interaction-service';
import { exportContacts, type ExportFilters } from '../services/export-service';
import {
  createCheckoutSession,
  createPortalSession,
  handleWebhook,
  cancelAllSubscriptions,
} from '../services/stripe-service';
import { parseBraindump } from '../services/braindump-service';
import {
  getDashboardTabs,
  calculateDartboardData,
  getUnsortedContacts,
  updateContactScores,
} from '../services/score-service';
import type {
  CreateContactInput,
  UpdateContactInput,
  ContactListFilters,
  IntentType,
  HealthStatus,
  ContactKind,
  InteractionMethod,
  NudgeFrequency,
  UpdateNotificationPreferencesInput,
} from '../../shared/models';

// ===========================================================================
// Main Router
// ===========================================================================

export async function handleApiRoute(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

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
  if (path === '/api/stripe/webhook' && method === 'POST') {
    return handleStripeWebhook(request, env);
  }

  const auth = await requireAuth(request, env);
  if (!auth.valid) return auth.response;

  const { user } = auth.auth;
  const db = env.DB;
  let response: Response;

  try {
    if (path === '/api/dashboard/tabs' && method === 'GET') {
      response = await handleGetDashboardTabs(db, user.id);
    } else if (path.match(/^\/api\/dashboard\/dartboard\/[^/]+$/) && method === 'GET') {
      response = await handleGetDartboard(path, db, user.id);
    } else if (path === '/api/dashboard/unsorted' && method === 'GET') {
      response = await handleGetUnsorted(url, db, user.id);
    } else if (path === '/api/contacts' && method === 'GET') {
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
    } else if (path === '/api/circles' && method === 'GET') {
      response = await handleListCircles(db, user.id);
    } else if (path === '/api/circles' && method === 'POST') {
      response = await handleCreateCircle(request, db, user.id);
    } else if (path === '/api/circles/reorder' && method === 'PATCH') {
      response = await handleReorderCircles(request, db, user.id);
    } else if (path.match(/^\/api\/circles\/[^/]+$/) && method === 'GET') {
      response = await handleGetCircle(path, db, user.id);
    } else if (path.match(/^\/api\/circles\/[^/]+$/) && method === 'PATCH') {
      response = await handleUpdateCircle(request, path, db, user.id);
    } else if (path.match(/^\/api\/circles\/[^/]+$/) && method === 'DELETE') {
      response = await handleDeleteCircle(path, db, user.id);
    } else if (path === '/api/interactions' && method === 'POST') {
      response = await handleLogInteraction(request, db, user.id);
    } else if (path === '/api/interactions' && method === 'GET') {
      response = await handleListInteractions(url, db, user.id);
    } else if (path === '/api/braindump/parse' && method === 'POST') {
      response = await handleBraindumpParse(request, env, user.id);
    } else if (path === '/api/export' && method === 'GET') {
      response = await handleExport(url, db, user.id);
    } else if (path.startsWith('/api/import/')) {
      const { handleImportRoute } = await import('./import');
      response = await handleImportRoute(request, env, user, path);
    } else if (path === '/api/user' && method === 'GET') {
      response = await handleGetUser(auth.auth);
    } else if (path === '/api/user' && method === 'PATCH') {
      response = await handleUpdateUser(request, db, user.id);
    } else if (path === '/api/user' && method === 'DELETE') {
      response = await handleDeleteUser(request, env, db, auth.auth);
    } else if (path === '/api/user/preferences' && method === 'PATCH') {
      response = await handleUpdateUserPreferences(request, db, user.id);
    } else if (path === '/api/user/notifications' && method === 'GET') {
      response = await handleGetNotificationPreferences(db, user.id);
    } else if (path === '/api/user/notifications' && method === 'PATCH') {
      response = await handleUpdateNotificationPreferences(request, db, user.id);
    } else if (path === '/api/subscription' && method === 'GET') {
      response = await handleGetSubscription(db, user.id);
    } else if (path === '/api/subscription/checkout' && method === 'POST') {
      response = await handleCheckout(request, env, auth.auth);
    } else if (path === '/api/subscription/portal' && method === 'POST') {
      response = await handlePortal(request, env, auth.auth);
    } else if (path.startsWith('/api/admin/')) {
      const origin = request.headers.get('Origin');
      response = await handleAdminRoute(request, env, user.id, path, method, origin);
    } else {
      response = errorResponse('Not found', 404);
    }
  } catch (err) {
    console.error(`[api] ${method} ${path} error:`, err);
    response = errorResponse('Internal server error', 500);
  }

  if (auth.refreshedCookie) {
    response = withRefreshedSession(response, auth.refreshedCookie);
  }
  return response;
}

// ===========================================================================
// Dashboard Handlers
// ===========================================================================

async function handleGetDashboardTabs(db: D1Database, userId: string): Promise<Response> {
  const tabs = await getDashboardTabs(db, userId);
  return jsonResponse({ data: tabs });
}

async function handleGetDartboard(path: string, db: D1Database, userId: string): Promise<Response> {
  const circleId = path.replace('/api/dashboard/dartboard/', '');
  try {
    const dartboard = await calculateDartboardData(db, userId, circleId);
    return jsonResponse({ data: dartboard });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      return errorResponse('Circle not found', 404);
    }
    throw err;
  }
}

async function handleGetUnsorted(url: URL, db: D1Database, userId: string): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 100);
  const unsorted = await getUnsortedContacts(db, userId, limit);
  return jsonResponse({ data: unsorted });
}

// ===========================================================================
// Contacts Handlers
// ===========================================================================

async function handleListContacts(url: URL, db: D1Database, userId: string): Promise<Response> {
  const filters: ContactListFilters = {};
  const pagination: PaginationOptions = {};

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

async function handleCreateContact(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<CreateContactInput>();
  if (!body.name?.trim()) {
    return errorResponse('Contact name is required', 400);
  }
  const contact = await createContact(db, userId, { ...body, name: body.name.trim() });
  if (body.circle_ids && body.circle_ids.length > 0) {
    await updateContactScores(db, contact.id);
  }
  return jsonResponse({ data: contact }, 201);
}

async function handleGetContact(path: string, db: D1Database, userId: string): Promise<Response> {
  const contactId = extractId(path, '/api/contacts/');
  const contact = await getContactWithCircles(db, userId, contactId);
  if (!contact) return errorResponse('Contact not found', 404);
  return jsonResponse({ data: contact });
}

async function handleUpdateContact(request: Request, path: string, db: D1Database, userId: string): Promise<Response> {
  const contactId = extractId(path, '/api/contacts/');
  const body = await request.json<UpdateContactInput>();
  const contact = await updateContact(db, userId, contactId, body);
  if (!contact) return errorResponse('Contact not found', 404);
  if (body.intent !== undefined || body.circle_ids !== undefined) {
    await updateContactScores(db, contactId);
  }
  return jsonResponse({ data: contact });
}

async function handleDeleteContact(url: URL, path: string, db: D1Database, userId: string): Promise<Response> {
  const contactId = extractId(path, '/api/contacts/');
  const hard = url.searchParams.get('hard') === 'true';
  const success = hard ? await deleteContact(db, userId, contactId) : await archiveContact(db, userId, contactId);
  if (!success) return errorResponse('Contact not found', 404);
  return jsonResponse({ data: { deleted: true } });
}

async function handleArchiveContact(path: string, db: D1Database, userId: string): Promise<Response> {
  const contactId = path.replace('/api/contacts/', '').replace('/archive', '');
  const success = await archiveContact(db, userId, contactId);
  if (!success) return errorResponse('Contact not found or already archived', 404);
  return jsonResponse({ data: { archived: true } });
}

async function handleRestoreContact(path: string, db: D1Database, userId: string): Promise<Response> {
  const contactId = path.replace('/api/contacts/', '').replace('/restore', '');
  const success = await restoreContact(db, userId, contactId);
  if (!success) return errorResponse('Contact not found or not archived', 404);
  await updateContactScores(db, contactId);
  return jsonResponse({ data: { restored: true } });
}

async function handleSearchContacts(url: URL, db: D1Database, userId: string): Promise<Response> {
  const query = url.searchParams.get('q') ?? '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);
  const results = await searchContacts(db, userId, query, limit);
  return jsonResponse({ data: results });
}

async function handleHealthSummary(db: D1Database, userId: string): Promise<Response> {
  const [healthCounts, intentCounts, totalContacts] = await Promise.all([
    getHealthCounts(db, userId),
    getIntentCounts(db, userId),
    getContactCount(db, userId),
  ]);
  return jsonResponse({ data: { total: totalContacts, byHealth: healthCounts, byIntent: intentCounts } });
}

async function handleRecalculateHealth(db: D1Database, userId: string): Promise<Response> {
  const result = await recalculateHealthStatuses(db, userId);
  return jsonResponse({ data: result });
}

// ===========================================================================
// Circles Handlers
// ===========================================================================

async function handleListCircles(db: D1Database, userId: string): Promise<Response> {
  const circles = await listCirclesWithCounts(db, userId);
  return jsonResponse({ data: circles });
}

async function handleCreateCircle(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<{ name: string; default_cadence_days?: number }>();
  if (!body.name?.trim()) {
    return errorResponse('Circle name is required', 400);
  }
  const circle = await createCircle(db, userId, { name: body.name.trim(), default_cadence_days: body.default_cadence_days ?? null });
  return jsonResponse({ data: circle }, 201);
}

async function handleGetCircle(path: string, db: D1Database, userId: string): Promise<Response> {
  const circleId = extractId(path, '/api/circles/');
  const circle = await getCircle(db, userId, circleId);
  if (!circle) return errorResponse('Circle not found', 404);
  return jsonResponse({ data: circle });
}

async function handleUpdateCircle(request: Request, path: string, db: D1Database, userId: string): Promise<Response> {
  const circleId = extractId(path, '/api/circles/');
  const body = await request.json<{ name?: string; default_cadence_days?: number | null; sort_order?: number }>();
  const circle = await updateCircle(db, userId, circleId, body);
  if (!circle) return errorResponse('Circle not found', 404);
  return jsonResponse({ data: circle });
}

async function handleDeleteCircle(path: string, db: D1Database, userId: string): Promise<Response> {
  const circleId = extractId(path, '/api/circles/');
  const result = await deleteCircle(db, userId, circleId);
  if (!result.deleted) {
    return errorResponse(result.reason || 'Circle not found', 400);
  }
  return jsonResponse({ data: { deleted: true } });
}

/**
 * Reorder circles by providing an array of circle IDs in desired order.
 * Also updates the user's circle_tab_order preference.
 */
async function handleReorderCircles(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<{ circleIds: string[] }>();

  if (!body.circleIds || !Array.isArray(body.circleIds) || body.circleIds.length === 0) {
    return errorResponse('circleIds array is required', 400);
  }

  const placeholders = body.circleIds.map(() => '?').join(',');
  const { results: validCircles } = await db
    .prepare(`SELECT id FROM circles WHERE id IN (${placeholders}) AND user_id = ?`)
    .bind(...body.circleIds, userId)
    .all<{ id: string }>();

  const validIds = new Set(validCircles.map(c => c.id));
  const invalidIds = body.circleIds.filter(id => !validIds.has(id));

  if (invalidIds.length > 0) {
    return errorResponse(`Invalid circle IDs: ${invalidIds.join(', ')}`, 400);
  }

  await reorderCircles(db, userId, body.circleIds);

  await db
    .prepare(`UPDATE users SET circle_tab_order = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(JSON.stringify(body.circleIds), userId)
    .run();

  return jsonResponse({ data: { reordered: true, order: body.circleIds } });
}

// ===========================================================================
// Interactions Handlers
// ===========================================================================

async function handleLogInteraction(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<{
    contact_id: string;
    method: InteractionMethod;
    date?: string;
    summary?: string;
    circle_context?: string[];
  }>();

  if (!body.contact_id) return errorResponse('contact_id is required', 400);
  if (!body.method) return errorResponse('method is required', 400);

  if (body.circle_context && body.circle_context.length > 0) {
    const circleIds = body.circle_context;
    const placeholders = circleIds.map(() => '?').join(',');
    const { results: validCircles } = await db
      .prepare(`SELECT id FROM circles WHERE id IN (${placeholders}) AND user_id = ?`)
      .bind(...circleIds, userId)
      .all<{ id: string }>();

    const validIds = new Set(validCircles.map(c => c.id));
    const invalidIds = circleIds.filter(id => !validIds.has(id));

    if (invalidIds.length > 0) {
      return errorResponse(`Invalid circle IDs: ${invalidIds.join(', ')}`, 400);
    }
  }

  const interaction = await logInteraction(db, userId, {
    contact_id: body.contact_id,
    method: body.method,
    date: body.date,
    summary: body.summary,
    circle_context: body.circle_context,
    logged_via: 'dashboard',
  });

  if (!interaction) return errorResponse('Contact not found', 404);
  return jsonResponse({ data: interaction }, 201);
}

async function handleListInteractions(url: URL, db: D1Database, userId: string): Promise<Response> {
  const contactId = url.searchParams.get('contact_id');
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
  const includeCircles = url.searchParams.get('include_circles') !== 'false';

  if (contactId) {
    if (includeCircles) {
      const result = await getInteractionHistoryWithCircles(db, userId, contactId, limit);
      return jsonResponse({ data: result.interactions, total: result.total });
    } else {
      const result = await getInteractionHistory(db, userId, contactId, limit);
      return jsonResponse({ data: result.interactions, total: result.total });
    }
  }

  const interactions = await getRecentInteractions(db, userId, 7, limit);
  return jsonResponse({ data: interactions });
}

// ===========================================================================
// Braindump Handler
// ===========================================================================

async function handleBraindumpParse(request: Request, env: Env, userId: string): Promise<Response> {
  const body = await request.json<{ text: string }>();
  if (!body.text?.trim()) return errorResponse('Text content is required', 400);
  const result = await parseBraindump(env, body.text);
  if (!result.success) return errorResponse(result.error, 400);
  return jsonResponse({ data: result.data });
}

// ===========================================================================
// Export Handler
// ===========================================================================

async function handleExport(url: URL, db: D1Database, userId: string): Promise<Response> {
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
      defaultCircleId: user.default_circle_id,
      circleTabOrder: user.circle_tab_order ? JSON.parse(user.circle_tab_order) : null,
      timezone: user.timezone,
      preferredNudgeHour: user.preferred_nudge_hour,
      nudgeFrequency: user.nudge_frequency,
      quietHoursStart: user.quiet_hours_start,
      quietHoursEnd: user.quiet_hours_end,
      createdAt: user.created_at,
    },
  });
}

async function handleUpdateUser(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<{ name?: string; email?: string; gender?: 'male' | 'female' | null }>();
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
  if (sets.length === 0) return errorResponse('No fields to update', 400);

  sets.push("updated_at = datetime('now')");
  binds.push(userId);

  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
  return jsonResponse({ data: user });
}

async function handleDeleteUser(request: Request, env: Env, db: D1Database, auth: AuthContext): Promise<Response> {
  const { user } = auth;
  let body: { confirm?: boolean } = {};
  try { body = await request.json(); } catch { /* empty */ }

  if (body.confirm !== true) {
    return errorResponse('Account deletion requires explicit confirmation. Send { "confirm": true } in the request body.', 400, 'confirmation_required');
  }

  console.log(`[api] Account deletion requested for user ${user.id} (${user.phone})`);

  try {
    let stripeCanceled = 0;
    if (user.stripe_customer_id) {
      const stripeResult = await cancelAllSubscriptions(env, user.stripe_customer_id);
      stripeCanceled = stripeResult.canceled;
    }

    const { results: contacts } = await db.prepare('SELECT id FROM contacts WHERE user_id = ?').bind(user.id).all<{ id: string }>();
    const contactIds = contacts.map((c) => c.id);

    if (contactIds.length > 0) {
      const placeholders = contactIds.map(() => '?').join(',');
      await db.prepare(`DELETE FROM circle_scores WHERE contact_id IN (${placeholders})`).bind(...contactIds).run();
      await db.prepare(`DELETE FROM contact_circles WHERE contact_id IN (${placeholders})`).bind(...contactIds).run();
    }

    await db.prepare('DELETE FROM interactions WHERE user_id = ?').bind(user.id).run();
    await db.prepare('DELETE FROM nudges WHERE user_id = ?').bind(user.id).run();
    await db.prepare('DELETE FROM usage_tracking WHERE user_id = ?').bind(user.id).run();
    await db.prepare('DELETE FROM contacts WHERE user_id = ?').bind(user.id).run();
    await db.prepare('DELETE FROM circles WHERE user_id = ?').bind(user.id).run();
    await db.prepare('DELETE FROM verification_codes WHERE phone = ?').bind(user.phone).run();
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

    const response = jsonResponse({ data: { deleted: true, message: 'Account and all data permanently deleted', stripeSubscriptionsCanceled: stripeCanceled } });
    response.headers.set('Set-Cookie', 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return response;
  } catch (err) {
    console.error('[api] Account deletion failed:', err);
    return errorResponse(`Failed to delete account: ${err instanceof Error ? err.message : 'Unknown error'}`, 500);
  }
}

async function handleUpdateUserPreferences(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<{ defaultCircleId?: string | null; circleTabOrder?: string[] }>();
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.defaultCircleId !== undefined) {
    sets.push('default_circle_id = ?');
    binds.push(body.defaultCircleId);
  }
  if (body.circleTabOrder !== undefined) {
    sets.push('circle_tab_order = ?');
    binds.push(JSON.stringify(body.circleTabOrder));
  }
  if (sets.length === 0) return errorResponse('No preferences to update', 400);

  sets.push("updated_at = datetime('now')");
  binds.push(userId);

  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return jsonResponse({ data: { updated: true } });
}

// ===========================================================================
// Notification Preferences Handlers
// ===========================================================================

async function handleGetNotificationPreferences(db: D1Database, userId: string): Promise<Response> {
  const user = await db.prepare(`SELECT timezone, preferred_nudge_hour, nudge_frequency, quiet_hours_start, quiet_hours_end FROM users WHERE id = ?`).bind(userId).first<{
    timezone: string;
    preferred_nudge_hour: number;
    nudge_frequency: NudgeFrequency;
    quiet_hours_start: string | null;
    quiet_hours_end: string | null;
  }>();
  if (!user) return errorResponse('User not found', 404);
  return jsonResponse({ data: { timezone: user.timezone, preferredNudgeHour: user.preferred_nudge_hour, nudgeFrequency: user.nudge_frequency, quietHoursStart: user.quiet_hours_start, quietHoursEnd: user.quiet_hours_end } });
}

async function handleUpdateNotificationPreferences(request: Request, db: D1Database, userId: string): Promise<Response> {
  const body = await request.json<UpdateNotificationPreferencesInput>();
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (body.timezone !== undefined) {
    if (!isValidTimezone(body.timezone)) return errorResponse('Invalid timezone. Use IANA format (e.g., "America/New_York")', 400);
    sets.push('timezone = ?');
    binds.push(body.timezone);
  }
  if (body.preferred_nudge_hour !== undefined) {
    if (!Number.isInteger(body.preferred_nudge_hour) || body.preferred_nudge_hour < 0 || body.preferred_nudge_hour > 23) {
      return errorResponse('preferred_nudge_hour must be an integer from 0-23', 400);
    }
    sets.push('preferred_nudge_hour = ?');
    binds.push(body.preferred_nudge_hour);
  }
  if (body.nudge_frequency !== undefined) {
    const validFrequencies: NudgeFrequency[] = ['daily', 'weekly', 'as_needed'];
    if (!validFrequencies.includes(body.nudge_frequency)) return errorResponse('nudge_frequency must be "daily", "weekly", or "as_needed"', 400);
    sets.push('nudge_frequency = ?');
    binds.push(body.nudge_frequency);
  }

  const hasStart = body.quiet_hours_start !== undefined;
  const hasEnd = body.quiet_hours_end !== undefined;

  if (hasStart || hasEnd) {
    const quietStart = hasStart ? body.quiet_hours_start : null;
    const quietEnd = hasEnd ? body.quiet_hours_end : null;

    if ((quietStart === null) !== (quietEnd === null)) {
      const current = await db.prepare('SELECT quiet_hours_start, quiet_hours_end FROM users WHERE id = ?').bind(userId).first<{ quiet_hours_start: string | null; quiet_hours_end: string | null }>();
      const effectiveStart = hasStart ? quietStart : current?.quiet_hours_start ?? null;
      const effectiveEnd = hasEnd ? quietEnd : current?.quiet_hours_end ?? null;
      if ((effectiveStart === null) !== (effectiveEnd === null)) {
        return errorResponse('quiet_hours_start and quiet_hours_end must both be set or both be null', 400);
      }
    }

    if (quietStart !== null && !isValidTimeFormat(quietStart)) return errorResponse('quiet_hours_start must be in HH:MM format (e.g., "22:00")', 400);
    if (quietEnd !== null && !isValidTimeFormat(quietEnd)) return errorResponse('quiet_hours_end must be in HH:MM format (e.g., "08:00")', 400);

    if (hasStart) { sets.push('quiet_hours_start = ?'); binds.push(quietStart); }
    if (hasEnd) { sets.push('quiet_hours_end = ?'); binds.push(quietEnd); }
  }

  if (sets.length === 0) return errorResponse('No preferences to update', 400);
  sets.push("updated_at = datetime('now')");
  binds.push(userId);

  await db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
  return handleGetNotificationPreferences(db, userId);
}

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function isValidTimeFormat(time: string): boolean {
  return /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/.test(time);
}

// ===========================================================================
// Subscription Handlers
// ===========================================================================

async function handleGetSubscription(db: D1Database, userId: string): Promise<Response> {
  const user = await db.prepare('SELECT subscription_tier, trial_ends_at, stripe_customer_id FROM users WHERE id = ?').bind(userId).first<{ subscription_tier: string; trial_ends_at: string | null; stripe_customer_id: string | null }>();
  if (!user) return errorResponse('User not found', 404);
  const isTrialActive = user.subscription_tier === 'trial' && user.trial_ends_at !== null && new Date(user.trial_ends_at) > new Date();
  return jsonResponse({ data: { tier: user.subscription_tier, isTrialActive, trialEndsAt: user.trial_ends_at, isPremium: user.subscription_tier === 'premium', hasStripe: !!user.stripe_customer_id } });
}

async function handleCheckout(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const { user } = auth;
  if (user.subscription_tier === 'premium') return errorResponse('Already subscribed to premium', 400, 'already_subscribed');
  const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
  try {
    const result = await createCheckoutSession(env, user.id, user.email, user.phone, `${dashboardUrl}/settings?upgrade=success`, `${dashboardUrl}/settings?upgrade=cancelled`, user.stripe_customer_id);
    return jsonResponse({ data: { checkoutUrl: result.url, sessionId: result.sessionId } });
  } catch (err) {
    console.error('[api] Checkout session creation failed:', err);
    return errorResponse(err instanceof Error ? err.message : 'Failed to create checkout session', 500);
  }
}

async function handlePortal(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const { user } = auth;
  if (!user.stripe_customer_id) return errorResponse('No active subscription to manage', 400, 'no_subscription');
  const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
  try {
    const result = await createPortalSession(env, user.stripe_customer_id, `${dashboardUrl}/settings`);
    return jsonResponse({ data: { portalUrl: result.url } });
  } catch (err) {
    console.error('[api] Portal session creation failed:', err);
    return errorResponse(err instanceof Error ? err.message : 'Failed to create portal session', 500);
  }
}

// ===========================================================================
// Stripe Webhook Handler
// ===========================================================================

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get('Stripe-Signature');
  if (!signature) return errorResponse('Missing Stripe-Signature header', 400);
  const payload = await request.text();
  try {
    const result = await handleWebhook(env, env.DB, payload, signature);
    if (!result.success && result.message === 'Invalid webhook signature') {
      return errorResponse('Invalid signature', 401);
    }
    return jsonResponse({ data: { received: true, eventType: result.eventType, message: result.message } });
  } catch (err) {
    console.error('[stripe] Webhook error:', err);
    return errorResponse('Webhook processing failed', 500);
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function extractId(path: string, prefix: string): string {
  return path.slice(prefix.length).split('/')[0];
}
