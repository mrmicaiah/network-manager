/**
 * Admin API Routes — permission-guarded endpoints for the admin dashboard.
 *
 * All routes require authentication (via requireAuth in the parent router)
 * AND a specific RBAC permission checked via requirePermission middleware.
 *
 * Route summary:
 *
 *   GET    /api/admin/stats              — Dashboard overview stats      (stats:read)
 *   GET    /api/admin/users              — Paginated user list           (users:read)
 *   GET    /api/admin/users/:id          — Full user detail              (users:read)
 *   PATCH  /api/admin/users/:id          — Update user fields            (users:write)
 *   DELETE /api/admin/users/:id          — Delete user + cascade         (users:delete)
 *   GET    /api/admin/activity           — Paginated audit log           (activity:read)
 *   POST   /api/admin/users/:id/resend-intro — Re-send Bethany intro    (users:write)
 *
 * @see worker/services/permission-service.ts for permission checks
 * @see worker/middleware/require-permission.ts for the guard pattern
 * @see worker/services/audit-service.ts for action logging
 */

import type { Env } from '../../shared/types';
import type { UserRow, SubscriptionTier, OnboardingStage } from '../../shared/models';
import { jsonResponse, errorResponse } from '../../shared/http';
import { requirePermission } from '../middleware/require-permission';
import { logAdminAction } from '../services/audit-service';
import { getAuditLog, countAuditLog } from '../services/audit-service';

// ===========================================================================
// Router
// ===========================================================================

/**
 * Route admin API requests. Called from handleApiRoute in api.ts
 * after auth has already been validated.
 *
 * @param request - The incoming request
 * @param env     - Worker environment bindings
 * @param userId  - The authenticated admin's user ID
 * @param path    - URL pathname (e.g., '/api/admin/users')
 * @param method  - HTTP method
 * @param origin  - Request origin for CORS
 */
export async function handleAdminRoute(
  request: Request,
  env: Env,
  userId: string,
  path: string,
  method: string,
  origin?: string | null,
): Promise<Response> {
  const db = env.DB;

  // -----------------------------------------------------------------------
  // GET /api/admin/stats
  // -----------------------------------------------------------------------
  if (path === '/api/admin/stats' && method === 'GET') {
    const perm = await requirePermission(db, userId, 'stats:read', request, origin);
    if (!perm.allowed) return perm.response;
    return handleGetStats(db, origin);
  }

  // -----------------------------------------------------------------------
  // GET /api/admin/users
  // -----------------------------------------------------------------------
  if (path === '/api/admin/users' && method === 'GET') {
    const perm = await requirePermission(db, userId, 'users:read', request, origin);
    if (!perm.allowed) return perm.response;
    return handleListUsers(request, db, origin);
  }

  // -----------------------------------------------------------------------
  // GET /api/admin/activity
  // -----------------------------------------------------------------------
  if (path === '/api/admin/activity' && method === 'GET') {
    const perm = await requirePermission(db, userId, 'activity:read', request, origin);
    if (!perm.allowed) return perm.response;
    return handleGetActivity(request, db, origin);
  }

  // -----------------------------------------------------------------------
  // /api/admin/users/:id/resend-intro
  // -----------------------------------------------------------------------
  if (path.match(/^\/api\/admin\/users\/[^/]+\/resend-intro$/) && method === 'POST') {
    const perm = await requirePermission(db, userId, 'users:write', request, origin);
    if (!perm.allowed) return perm.response;
    const targetId = extractAdminUserId(path);
    return handleResendIntro(request, env, db, userId, targetId, origin);
  }

  // -----------------------------------------------------------------------
  // /api/admin/users/:id — GET, PATCH, DELETE
  // -----------------------------------------------------------------------
  if (path.match(/^\/api\/admin\/users\/[^/]+$/) ) {
    const targetId = extractAdminUserId(path);

    if (method === 'GET') {
      const perm = await requirePermission(db, userId, 'users:read', request, origin);
      if (!perm.allowed) return perm.response;
      return handleGetUser(db, targetId, origin);
    }

    if (method === 'PATCH') {
      const perm = await requirePermission(db, userId, 'users:write', request, origin);
      if (!perm.allowed) return perm.response;
      return handleUpdateUser(request, db, userId, targetId, origin);
    }

    if (method === 'DELETE') {
      const perm = await requirePermission(db, userId, 'users:delete', request, origin);
      if (!perm.allowed) return perm.response;
      return handleDeleteUser(request, db, userId, targetId, origin);
    }
  }

  return errorResponse('Not found', 404, undefined, origin);
}

// ===========================================================================
// 1. GET /api/admin/stats
// ===========================================================================

async function handleGetStats(db: D1Database, origin?: string | null): Promise<Response> {
  // Run all stat queries in parallel
  const [
    totalUsers,
    usersByTier,
    usersByOnboarding,
    totalContacts,
    avgContactsPerUser,
    signupsToday,
    signupsThisWeek,
    signupsThisMonth,
    activeTrials,
    trialsExpiringSoon,
  ] = await Promise.all([
    // Total users
    db.prepare(`SELECT COUNT(*) as count FROM users`)
      .first<{ count: number }>(),

    // Users by subscription tier
    db.prepare(
      `SELECT subscription_tier as tier, COUNT(*) as count
       FROM users GROUP BY subscription_tier`
    ).all<{ tier: string; count: number }>(),

    // Users by onboarding stage
    db.prepare(
      `SELECT
         COALESCE(onboarding_stage, 'complete') as stage,
         COUNT(*) as count
       FROM users GROUP BY onboarding_stage`
    ).all<{ stage: string; count: number }>(),

    // Total contacts (non-archived)
    db.prepare(`SELECT COUNT(*) as count FROM contacts WHERE archived = 0`)
      .first<{ count: number }>(),

    // Average contacts per user
    db.prepare(
      `SELECT ROUND(AVG(cnt), 1) as avg FROM (
         SELECT COUNT(*) as cnt FROM contacts
         WHERE archived = 0
         GROUP BY user_id
       )`
    ).first<{ avg: number }>(),

    // Signups today
    db.prepare(
      `SELECT COUNT(*) as count FROM users
       WHERE created_at >= date('now')`
    ).first<{ count: number }>(),

    // Signups this week
    db.prepare(
      `SELECT COUNT(*) as count FROM users
       WHERE created_at >= date('now', '-7 days')`
    ).first<{ count: number }>(),

    // Signups this month
    db.prepare(
      `SELECT COUNT(*) as count FROM users
       WHERE created_at >= date('now', '-30 days')`
    ).first<{ count: number }>(),

    // Active trials
    db.prepare(
      `SELECT COUNT(*) as count FROM users
       WHERE subscription_tier = 'trial'
         AND trial_ends_at > datetime('now')`
    ).first<{ count: number }>(),

    // Trials expiring in next 3 days
    db.prepare(
      `SELECT COUNT(*) as count FROM users
       WHERE subscription_tier = 'trial'
         AND trial_ends_at > datetime('now')
         AND trial_ends_at <= datetime('now', '+3 days')`
    ).first<{ count: number }>(),
  ]);

  // Transform tier/onboarding results into objects
  const tierMap: Record<string, number> = {};
  for (const row of usersByTier.results ?? []) {
    tierMap[row.tier] = row.count;
  }

  const onboardingMap: Record<string, number> = {};
  for (const row of usersByOnboarding.results ?? []) {
    onboardingMap[row.stage] = row.count;
  }

  return jsonResponse({
    data: {
      totalUsers: totalUsers?.count ?? 0,
      usersByTier: tierMap,
      usersByOnboardingStage: onboardingMap,
      totalContacts: totalContacts?.count ?? 0,
      avgContactsPerUser: avgContactsPerUser?.avg ?? 0,
      signupsToday: signupsToday?.count ?? 0,
      signupsThisWeek: signupsThisWeek?.count ?? 0,
      signupsThisMonth: signupsThisMonth?.count ?? 0,
      activeTrials: activeTrials?.count ?? 0,
      trialsExpiringSoon: trialsExpiringSoon?.count ?? 0,
    },
  }, 200, origin);
}

// ===========================================================================
// 2. GET /api/admin/users
// ===========================================================================

async function handleListUsers(
  request: Request,
  db: D1Database,
  origin?: string | null,
): Promise<Response> {
  const url = new URL(request.url);

  // Pagination
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10)));
  const offset = (page - 1) * limit;

  // Filters
  const search = url.searchParams.get('search')?.trim() ?? null;
  const tier = url.searchParams.get('tier') as SubscriptionTier | null;
  const onboardingStage = url.searchParams.get('onboarding_stage') as OnboardingStage | null;

  // Sorting
  const validSortFields = ['name', 'created_at', 'subscription_tier', 'email', 'phone'];
  const sortBy = validSortFields.includes(url.searchParams.get('sort_by') ?? '')
    ? url.searchParams.get('sort_by')!
    : 'created_at';
  const sortDir = url.searchParams.get('sort_dir') === 'asc' ? 'ASC' : 'DESC';

  // Build WHERE clause
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (search) {
    conditions.push(`(u.name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)`);
    const likePattern = `%${search}%`;
    params.push(likePattern, likePattern, likePattern);
  }

  if (tier) {
    conditions.push(`u.subscription_tier = ?`);
    params.push(tier);
  }

  if (onboardingStage) {
    if (onboardingStage === 'complete' as string) {
      conditions.push(`u.onboarding_stage IS NULL`);
    } else {
      conditions.push(`u.onboarding_stage = ?`);
      params.push(onboardingStage);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count total matching
  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM users u ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  const total = countResult?.count ?? 0;

  // Fetch page with contact count subquery
  const rows = await db
    .prepare(
      `SELECT
         u.id, u.name, u.email, u.phone,
         u.subscription_tier, u.onboarding_stage,
         u.created_at,
         (SELECT COUNT(*) FROM contacts c WHERE c.user_id = u.id AND c.archived = 0) as contact_count
       FROM users u
       ${where}
       ORDER BY u.${sortBy} ${sortDir}
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<{
      id: string;
      name: string;
      email: string | null;
      phone: string;
      subscription_tier: string;
      onboarding_stage: string | null;
      created_at: string;
      contact_count: number;
    }>();

  return jsonResponse({
    data: {
      users: rows.results ?? [],
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    },
  }, 200, origin);
}

// ===========================================================================
// 3. GET /api/admin/users/:id
// ===========================================================================

async function handleGetUser(
  db: D1Database,
  targetId: string,
  origin?: string | null,
): Promise<Response> {
  // Fetch user
  const user = await db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(targetId)
    .first<UserRow>();

  if (!user) return errorResponse('User not found', 404, undefined, origin);

  // Fetch in parallel: contacts, circles, recent interactions, subscription details, roles
  const [contacts, circles, recentInteractions, roles] = await Promise.all([
    // Contact summaries
    db.prepare(
      `SELECT id, name, intent, health_status, contact_kind, last_contact_date
       FROM contacts
       WHERE user_id = ? AND archived = 0
       ORDER BY name ASC
       LIMIT 100`
    ).bind(targetId).all<{
      id: string;
      name: string;
      intent: string;
      health_status: string;
      contact_kind: string;
      last_contact_date: string | null;
    }>(),

    // Circles
    db.prepare(
      `SELECT c.id, c.name, c.type, c.sort_order,
         (SELECT COUNT(*) FROM contact_circles cc WHERE cc.circle_id = c.id) as contact_count
       FROM circles c
       WHERE c.user_id = ?
       ORDER BY c.sort_order ASC`
    ).bind(targetId).all<{
      id: string;
      name: string;
      type: string;
      sort_order: number;
      contact_count: number;
    }>(),

    // Recent interactions (last 20)
    db.prepare(
      `SELECT i.id, i.contact_id, i.date, i.method, i.summary, i.logged_via,
         c.name as contact_name
       FROM interactions i
       JOIN contacts c ON i.contact_id = c.id
       WHERE i.user_id = ?
       ORDER BY i.date DESC
       LIMIT 20`
    ).bind(targetId).all<{
      id: string;
      contact_id: string;
      date: string;
      method: string;
      summary: string | null;
      logged_via: string;
      contact_name: string;
    }>(),

    // Roles
    db.prepare(
      `SELECT r.name, r.description
       FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    ).bind(targetId).all<{ name: string; description: string | null }>(),
  ]);

  // Compute subscription details
  const isTrialActive =
    user.subscription_tier === 'trial' &&
    user.trial_ends_at !== null &&
    new Date(user.trial_ends_at) > new Date();

  const daysUntilTrialExpires = isTrialActive && user.trial_ends_at
    ? Math.ceil((new Date(user.trial_ends_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return jsonResponse({
    data: {
      user: {
        ...user,
        // Redact sensitive fields
        pin_hash: undefined,
        passphrase: undefined,
      },
      contacts: contacts.results ?? [],
      circles: circles.results ?? [],
      recentInteractions: recentInteractions.results ?? [],
      roles: (roles.results ?? []).map((r) => r.name),
      subscription: {
        tier: user.subscription_tier,
        isTrialActive,
        daysUntilTrialExpires,
        trialEndsAt: user.trial_ends_at,
        isPremium: user.subscription_tier === 'premium',
        hasStripe: !!user.stripe_customer_id,
      },
    },
  }, 200, origin);
}

// ===========================================================================
// 4. PATCH /api/admin/users/:id
// ===========================================================================

const ALLOWED_UPDATE_FIELDS = ['subscription_tier', 'onboarding_stage', 'name'] as const;
const VALID_TIERS: SubscriptionTier[] = ['free', 'trial', 'premium'];

async function handleUpdateUser(
  request: Request,
  db: D1Database,
  adminId: string,
  targetId: string,
  origin?: string | null,
): Promise<Response> {
  const body = await request.json<Record<string, unknown>>();

  // Validate target exists
  const existing = await db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(targetId)
    .first<UserRow>();

  if (!existing) return errorResponse('User not found', 404, undefined, origin);

  // Build update
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changes: Record<string, { before: unknown; after: unknown }> = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return errorResponse('Name cannot be empty', 400, undefined, origin);
    sets.push('name = ?');
    binds.push(name);
    changes.name = { before: existing.name, after: name };
  }

  if (body.subscription_tier !== undefined) {
    const tier = body.subscription_tier as string;
    if (!VALID_TIERS.includes(tier as SubscriptionTier)) {
      return errorResponse(`Invalid tier. Must be one of: ${VALID_TIERS.join(', ')}`, 400, undefined, origin);
    }
    sets.push('subscription_tier = ?');
    binds.push(tier);
    changes.subscription_tier = { before: existing.subscription_tier, after: tier };

    // If upgrading to trial, set trial_ends_at
    if (tier === 'trial' && existing.subscription_tier !== 'trial') {
      const trialEnd = new Date();
      trialEnd.setDate(trialEnd.getDate() + 14);
      sets.push('trial_ends_at = ?');
      binds.push(trialEnd.toISOString());
      changes.trial_ends_at = { before: existing.trial_ends_at, after: trialEnd.toISOString() };
    }
  }

  if (body.onboarding_stage !== undefined) {
    // Allow null to mark onboarding complete
    const stage = body.onboarding_stage as string | null;
    sets.push('onboarding_stage = ?');
    binds.push(stage);
    changes.onboarding_stage = { before: existing.onboarding_stage, after: stage };
  }

  if (sets.length === 0) {
    return errorResponse(
      `No valid fields to update. Allowed: ${ALLOWED_UPDATE_FIELDS.join(', ')}`,
      400,
      undefined,
      origin,
    );
  }

  sets.push("updated_at = datetime('now')");
  binds.push(targetId);

  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();

  // Audit log
  await logAdminAction(db, {
    userId: adminId,
    action: 'user.update',
    resourceType: 'user',
    resourceId: targetId,
    details: { changes },
    request,
  });

  // Return updated user
  const updated = await db
    .prepare(`SELECT * FROM users WHERE id = ?`)
    .bind(targetId)
    .first<UserRow>();

  return jsonResponse({
    data: {
      ...updated,
      pin_hash: undefined,
      passphrase: undefined,
    },
  }, 200, origin);
}

// ===========================================================================
// 5. DELETE /api/admin/users/:id
// ===========================================================================

async function handleDeleteUser(
  request: Request,
  db: D1Database,
  adminId: string,
  targetId: string,
  origin?: string | null,
): Promise<Response> {
  // Prevent self-deletion via admin endpoint
  if (targetId === adminId) {
    return errorResponse(
      'Cannot delete your own account via the admin endpoint. Use the regular account deletion flow.',
      400,
      'self_delete',
      origin,
    );
  }

  // Verify target exists
  const target = await db
    .prepare(`SELECT id, name, phone, email, subscription_tier FROM users WHERE id = ?`)
    .bind(targetId)
    .first<{ id: string; name: string; phone: string; email: string | null; subscription_tier: string }>();

  if (!target) return errorResponse('User not found', 404, undefined, origin);

  // Cascade delete — same order as the user self-delete in api.ts
  const { results: contacts } = await db
    .prepare(`SELECT id FROM contacts WHERE user_id = ?`)
    .bind(targetId)
    .all<{ id: string }>();

  const contactIds = contacts.map((c) => c.id);

  if (contactIds.length > 0) {
    const placeholders = contactIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM circle_scores WHERE contact_id IN (${placeholders})`).bind(...contactIds).run();
    await db.prepare(`DELETE FROM contact_circles WHERE contact_id IN (${placeholders})`).bind(...contactIds).run();
  }

  await db.prepare('DELETE FROM interactions WHERE user_id = ?').bind(targetId).run();
  await db.prepare('DELETE FROM nudges WHERE user_id = ?').bind(targetId).run();
  await db.prepare('DELETE FROM usage_tracking WHERE user_id = ?').bind(targetId).run();
  await db.prepare('DELETE FROM contacts WHERE user_id = ?').bind(targetId).run();
  await db.prepare('DELETE FROM circles WHERE user_id = ?').bind(targetId).run();
  await db.prepare('DELETE FROM verification_codes WHERE phone = ?').bind(target.phone).run();
  await db.prepare('DELETE FROM user_roles WHERE user_id = ?').bind(targetId).run();
  await db.prepare('DELETE FROM users WHERE id = ?').bind(targetId).run();

  // Audit log (after delete so the target's data is captured in details)
  await logAdminAction(db, {
    userId: adminId,
    action: 'user.delete',
    resourceType: 'user',
    resourceId: targetId,
    details: {
      deletedUser: {
        name: target.name,
        phone: target.phone,
        email: target.email,
        tier: target.subscription_tier,
        contactsDeleted: contactIds.length,
      },
    },
    request,
  });

  return jsonResponse({
    data: {
      deleted: true,
      userId: targetId,
      contactsDeleted: contactIds.length,
    },
  }, 200, origin);
}

// ===========================================================================
// 6. GET /api/admin/activity
// ===========================================================================

async function handleGetActivity(
  request: Request,
  db: D1Database,
  origin?: string | null,
): Promise<Response> {
  const url = new URL(request.url);

  // Pagination
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '25', 10)));
  const offset = (page - 1) * limit;

  // Filters
  const filters: {
    userId?: string;
    action?: string;
    resourceType?: string;
  } = {};

  const userIdFilter = url.searchParams.get('user_id');
  if (userIdFilter) filters.userId = userIdFilter;

  const actionFilter = url.searchParams.get('action');
  if (actionFilter) filters.action = actionFilter;

  const resourceTypeFilter = url.searchParams.get('resource_type');
  if (resourceTypeFilter) filters.resourceType = resourceTypeFilter;

  // Date range filters need custom handling
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  // If we have date filters, we need to query directly instead of using
  // the audit service (which doesn't support date ranges yet)
  if (dateFrom || dateTo) {
    return handleGetActivityWithDateRange(db, filters, dateFrom, dateTo, page, limit, offset, origin);
  }

  // Use audit service for standard queries
  const [entries, total] = await Promise.all([
    getAuditLog(db, { ...filters, limit, offset }),
    countAuditLog(db, filters),
  ]);

  // Resolve actor names for display
  const actorIds = [...new Set(entries.map((e) => e.user_id))];
  const actorMap = await resolveUserNames(db, actorIds);

  return jsonResponse({
    data: {
      entries: entries.map((e) => ({
        id: e.id,
        userId: e.user_id,
        userName: actorMap.get(e.user_id) ?? 'Unknown',
        action: e.action,
        resourceType: e.resource_type,
        resourceId: e.resource_id,
        details: e.parsed_details,
        ipAddress: e.ip_address,
        createdAt: e.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    },
  }, 200, origin);
}

/**
 * Activity query with date range filters.
 * Handles date_from/date_to that the base audit service doesn't support.
 */
async function handleGetActivityWithDateRange(
  db: D1Database,
  filters: { userId?: string; action?: string; resourceType?: string },
  dateFrom: string | null,
  dateTo: string | null,
  page: number,
  limit: number,
  offset: number,
  origin?: string | null,
): Promise<Response> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.userId) {
    conditions.push('user_id = ?');
    params.push(filters.userId);
  }
  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.resourceType) {
    conditions.push('resource_type = ?');
    params.push(filters.resourceType);
  }
  if (dateFrom) {
    conditions.push('created_at >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push('created_at <= ?');
    params.push(dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [rows, countResult] = await Promise.all([
    db.prepare(
      `SELECT * FROM admin_audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all<{
      id: string;
      user_id: string;
      action: string;
      resource_type: string | null;
      resource_id: string | null;
      details: string | null;
      ip_address: string | null;
      created_at: string;
    }>(),
    db.prepare(
      `SELECT COUNT(*) as count FROM admin_audit_log ${where}`
    ).bind(...params).first<{ count: number }>(),
  ]);

  const total = countResult?.count ?? 0;
  const entries = rows.results ?? [];

  const actorIds = [...new Set(entries.map((e) => e.user_id))];
  const actorMap = await resolveUserNames(db, actorIds);

  return jsonResponse({
    data: {
      entries: entries.map((e) => ({
        id: e.id,
        userId: e.user_id,
        userName: actorMap.get(e.user_id) ?? 'Unknown',
        action: e.action,
        resourceType: e.resource_type,
        resourceId: e.resource_id,
        details: e.details ? safeJsonParse(e.details) : null,
        ipAddress: e.ip_address,
        createdAt: e.created_at,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: offset + limit < total,
      },
    },
  }, 200, origin);
}

// ===========================================================================
// 7. POST /api/admin/users/:id/resend-intro
// ===========================================================================

async function handleResendIntro(
  request: Request,
  env: Env,
  db: D1Database,
  adminId: string,
  targetId: string,
  origin?: string | null,
): Promise<Response> {
  const target = await db
    .prepare(`SELECT id, name, phone, onboarding_stage FROM users WHERE id = ?`)
    .bind(targetId)
    .first<{ id: string; name: string; phone: string; onboarding_stage: string | null }>();

  if (!target) return errorResponse('User not found', 404, undefined, origin);

  // Send Bethany's intro message
  const introMessage = `Hey ${target.name}! 👋 It's Bethany, your relationship assistant. I'm here to help you stay connected with the people who matter most. Ready to get started?`;

  try {
    const smsResponse = await fetch('https://api.sendblue.co/api/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': env.SENDBLUE_API_KEY,
        'sb-api-secret-key': env.SENDBLUE_API_SECRET,
      },
      body: JSON.stringify({
        number: target.phone,
        content: introMessage,
        send_style: 'invisible',
      }),
    });

    if (!smsResponse.ok) {
      const error = await smsResponse.text();
      console.error('[admin] Resend intro SMS failed:', error);
      return errorResponse('Failed to send SMS', 500, undefined, origin);
    }
  } catch (err) {
    console.error('[admin] Resend intro error:', err);
    return errorResponse('Failed to send SMS', 500, undefined, origin);
  }

  // Reset onboarding stage to intro_sent
  await db
    .prepare(`UPDATE users SET onboarding_stage = 'intro_sent', updated_at = datetime('now') WHERE id = ?`)
    .bind(targetId)
    .run();

  // Audit log
  await logAdminAction(db, {
    userId: adminId,
    action: 'user.update',
    resourceType: 'user',
    resourceId: targetId,
    details: {
      action: 'resend_intro',
      previousOnboardingStage: target.onboarding_stage,
    },
    request,
  });

  return jsonResponse({
    data: {
      sent: true,
      userId: targetId,
      previousStage: target.onboarding_stage,
      newStage: 'intro_sent',
    },
  }, 200, origin);
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract user ID from admin user paths.
 * /api/admin/users/abc-123 → abc-123
 * /api/admin/users/abc-123/resend-intro → abc-123
 */
function extractAdminUserId(path: string): string {
  const segments = path.replace('/api/admin/users/', '').split('/');
  return segments[0];
}

/**
 * Resolve user IDs to names for display in audit logs.
 */
async function resolveUserNames(
  db: D1Database,
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;

  const placeholders = userIds.map(() => '?').join(',');
  const { results } = await db
    .prepare(`SELECT id, name FROM users WHERE id IN (${placeholders})`)
    .bind(...userIds)
    .all<{ id: string; name: string }>();

  for (const row of results ?? []) {
    map.set(row.id, row.name);
  }

  return map;
}

/**
 * Safely parse a JSON string, returning null on failure.
 */
function safeJsonParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
