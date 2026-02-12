/**
 * Debug Routes — Diagnostic endpoints for troubleshooting.
 * 
 * These endpoints help diagnose issues with the nudge system,
 * cron jobs, and other scheduled processes.
 * 
 * All routes require admin permission.
 */

import type { Env } from '../../shared/types';
import { jsonResponse, errorResponse } from '../../shared/http';
import { requirePermission } from '../middleware/require-permission';
import {
  getContactsNeedingAttention,
  generateNudgesForUser,
  getPendingNudges,
  sendNudge,
  markNudgeDelivered,
} from '../services/nudge-service';

// ===========================================================================
// Types
// ===========================================================================

interface UserNudgeState {
  id: string;
  name: string;
  phone: string;
  timezone: string | null;
  preferred_nudge_hour: number | null;
  nudge_frequency: string | null;
  subscription_tier: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

interface ContactState {
  id: string;
  name: string;
  intent: string;
  health_status: string;
  last_contact_date: string | null;
  archived: number;
}

interface NudgeState {
  id: string;
  contact_id: string;
  contact_name?: string;
  status: string;
  scheduled_for: string;
  delivered_at: string | null;
  created_at: string;
  message: string;
}

// ===========================================================================
// Router
// ===========================================================================

export async function handleDebugRoute(
  request: Request,
  env: Env,
  userId: string,
  path: string,
  method: string,
  origin?: string | null,
): Promise<Response> {
  const db = env.DB;

  // All debug routes require admin permission
  const perm = await requirePermission(db, userId, 'stats:read', request, origin);
  if (!perm.allowed) return perm.response;

  // GET /api/debug/nudge-diagnostic
  if (path === '/api/debug/nudge-diagnostic' && method === 'GET') {
    return handleNudgeDiagnostic(request, env, userId, origin);
  }

  // POST /api/debug/test-nudge-generation
  if (path === '/api/debug/test-nudge-generation' && method === 'POST') {
    return handleTestNudgeGeneration(request, env, userId, origin);
  }

  // POST /api/debug/test-nudge-delivery
  if (path === '/api/debug/test-nudge-delivery' && method === 'POST') {
    return handleTestNudgeDelivery(request, env, userId, origin);
  }

  // GET /api/debug/cron-simulation
  if (path === '/api/debug/cron-simulation' && method === 'GET') {
    return handleCronSimulation(request, env, userId, origin);
  }

  return errorResponse('Not found', 404, undefined, origin);
}

// ===========================================================================
// GET /api/debug/nudge-diagnostic
// ===========================================================================

async function handleNudgeDiagnostic(
  request: Request,
  env: Env,
  userId: string,
  origin?: string | null,
): Promise<Response> {
  const db = env.DB;
  const url = new URL(request.url);
  const targetUserId = url.searchParams.get('user_id') || userId;

  const now = new Date();

  // 1. Get user's nudge settings
  const user = await db
    .prepare(
      `SELECT id, name, phone, timezone, preferred_nudge_hour, nudge_frequency,
              subscription_tier, quiet_hours_start, quiet_hours_end
       FROM users WHERE id = ?`
    )
    .bind(targetUserId)
    .first<UserNudgeState>();

  if (!user) {
    return errorResponse('User not found', 404, undefined, origin);
  }

  // 2. Calculate current hour in user's timezone
  let currentHourInTimezone: number | null = null;
  let timezoneError: string | null = null;
  
  if (user.timezone) {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: user.timezone,
        hour: 'numeric',
        hour12: false,
      });
      currentHourInTimezone = parseInt(formatter.format(now), 10);
    } catch (err) {
      timezoneError = `Invalid timezone: ${user.timezone}`;
    }
  }

  // 3. Check if it's the user's nudge hour
  const isNudgeHour = currentHourInTimezone === user.preferred_nudge_hour;

  // 4. Get contacts needing attention
  const contactsNeedingAttention = await getContactsNeedingAttention(db, targetUserId, 20, now);

  // 5. Get all contacts for comparison
  const { results: allContacts } = await db
    .prepare(
      `SELECT id, name, intent, health_status, last_contact_date, archived
       FROM contacts
       WHERE user_id = ?
       ORDER BY name ASC
       LIMIT 50`
    )
    .bind(targetUserId)
    .all<ContactState>();

  // 6. Get recent nudges
  const { results: recentNudges } = await db
    .prepare(
      `SELECT n.id, n.contact_id, n.status, n.scheduled_for, n.delivered_at, 
              n.created_at, n.message, c.name as contact_name
       FROM nudges n
       LEFT JOIN contacts c ON n.contact_id = c.id
       WHERE n.user_id = ?
       ORDER BY n.created_at DESC
       LIMIT 20`
    )
    .bind(targetUserId)
    .all<NudgeState>();

  // 7. Get pending nudges ready for delivery
  const pendingNudges = await getPendingNudges(db, 20, targetUserId, now);

  // 8. Check if user would be included in hourly cron query
  const { results: cronQueryResult } = await db
    .prepare(
      `SELECT DISTINCT u.id
       FROM users u
       INNER JOIN contacts c ON u.id = c.user_id
       WHERE c.archived = 0
         AND c.intent NOT IN ('dormant', 'new')
         AND u.timezone IS NOT NULL
         AND u.id = ?`
    )
    .bind(targetUserId)
    .all<{ id: string }>();

  const wouldBeIncludedInCron = cronQueryResult.length > 0;

  // 9. Eligibility breakdown
  const eligibilityChecks = {
    hasTimezone: !!user.timezone,
    timezoneValid: !timezoneError,
    hasPreferredHour: user.preferred_nudge_hour !== null,
    isCurrentlyNudgeHour: isNudgeHour,
    hasActiveContacts: allContacts.some(c => 
      c.archived === 0 && !['dormant', 'new'].includes(c.intent)
    ),
    hasContactsNeedingAttention: contactsNeedingAttention.length > 0,
    wouldBeIncludedInCronQuery: wouldBeIncludedInCron,
  };

  // 10. Contact breakdown
  const contactBreakdown = {
    total: allContacts.length,
    archived: allContacts.filter(c => c.archived === 1).length,
    dormant: allContacts.filter(c => c.intent === 'dormant').length,
    new: allContacts.filter(c => c.intent === 'new').length,
    active: allContacts.filter(c => 
      c.archived === 0 && !['dormant', 'new'].includes(c.intent)
    ).length,
    needingAttention: contactsNeedingAttention.length,
    byHealth: {
      green: allContacts.filter(c => c.health_status === 'green' && c.archived === 0).length,
      yellow: allContacts.filter(c => c.health_status === 'yellow' && c.archived === 0).length,
      red: allContacts.filter(c => c.health_status === 'red' && c.archived === 0).length,
    },
  };

  return jsonResponse({
    data: {
      diagnosticTime: now.toISOString(),
      user: {
        ...user,
        // Don't expose full phone
        phone: user.phone.slice(0, 5) + '...',
      },
      timezone: {
        configured: user.timezone,
        valid: !timezoneError,
        error: timezoneError,
        currentHourInTimezone,
        preferredNudgeHour: user.preferred_nudge_hour,
        isNudgeHour,
        utcHour: now.getUTCHours(),
      },
      eligibility: eligibilityChecks,
      contacts: {
        breakdown: contactBreakdown,
        needingAttention: contactsNeedingAttention.map(c => ({
          id: c.contactId,
          name: c.contactName,
          intent: c.intent,
          healthStatus: c.healthStatus,
          daysOverdue: c.daysOverdue,
          urgencyScore: c.urgencyScore,
        })),
      },
      nudges: {
        pendingCount: pendingNudges.length,
        pending: pendingNudges.map(n => ({
          id: n.id,
          scheduledFor: n.scheduled_for,
          status: n.status,
        })),
        recent: recentNudges.map(n => ({
          id: n.id,
          contactName: n.contact_name,
          status: n.status,
          scheduledFor: n.scheduled_for,
          deliveredAt: n.delivered_at,
          createdAt: n.created_at,
        })),
      },
      diagnosis: generateDiagnosis(eligibilityChecks, contactBreakdown, user, recentNudges),
    },
  }, 200, origin);
}

function generateDiagnosis(
  eligibility: Record<string, boolean>,
  contacts: { needingAttention: number; active: number },
  user: UserNudgeState,
  recentNudges: NudgeState[],
): string[] {
  const issues: string[] = [];

  if (!eligibility.hasTimezone) {
    issues.push('❌ CRITICAL: User has no timezone set. Cron will skip this user.');
  } else if (!eligibility.timezoneValid) {
    issues.push('❌ CRITICAL: User timezone is invalid. Cron will skip this user.');
  }

  if (eligibility.hasPreferredHour === false) {
    issues.push('⚠️ WARNING: preferred_nudge_hour is null. Using default (8).');
  }

  if (!eligibility.wouldBeIncludedInCronQuery) {
    issues.push('❌ CRITICAL: User would NOT be included in hourly cron query. Check: timezone set? has active contacts?');
  }

  if (!eligibility.hasActiveContacts) {
    issues.push('❌ No active contacts (all are archived, dormant, or new).');
  }

  if (!eligibility.hasContactsNeedingAttention) {
    issues.push('ℹ️ No contacts currently need attention (all are green health).');
  }

  if (!eligibility.isCurrentlyNudgeHour) {
    issues.push(`ℹ️ Not currently nudge hour. Will process when hour matches ${user.preferred_nudge_hour ?? 8}.`);
  }

  // Check for recent nudges that might indicate cooldown
  const pendingOrRecentDelivered = recentNudges.filter(n => 
    n.status === 'pending' || 
    (n.status === 'delivered' && n.delivered_at && 
      new Date(n.delivered_at).getTime() > Date.now() - 48 * 60 * 60 * 1000)
  );

  if (pendingOrRecentDelivered.length > 0) {
    issues.push(`ℹ️ ${pendingOrRecentDelivered.length} nudges in cooldown (pending or delivered <48h ago).`);
  }

  if (user.subscription_tier === 'free' && user.nudge_frequency !== 'weekly') {
    issues.push('ℹ️ Free tier user but nudge_frequency is not "weekly". May affect delivery.');
  }

  if (issues.length === 0) {
    issues.push('✅ All checks passed. Nudges should be generated and delivered at the configured hour.');
  }

  return issues;
}

// ===========================================================================
// POST /api/debug/test-nudge-generation
// ===========================================================================

async function handleTestNudgeGeneration(
  request: Request,
  env: Env,
  userId: string,
  origin?: string | null,
): Promise<Response> {
  const db = env.DB;
  const body = await request.json<{ user_id?: string; dry_run?: boolean }>();
  const targetUserId = body.user_id || userId;
  const dryRun = body.dry_run !== false; // Default to dry run

  if (dryRun) {
    // Simulate generation without actually creating nudges
    const contacts = await getContactsNeedingAttention(db, targetUserId, 10);
    
    return jsonResponse({
      data: {
        dryRun: true,
        message: 'Simulation only - no nudges created',
        wouldGenerate: contacts.length,
        contacts: contacts.map(c => ({
          name: c.contactName,
          intent: c.intent,
          healthStatus: c.healthStatus,
          daysOverdue: c.daysOverdue,
        })),
      },
    }, 200, origin);
  }

  // Actually generate nudges
  const result = await generateNudgesForUser(db, env, targetUserId);

  return jsonResponse({
    data: {
      dryRun: false,
      result,
    },
  }, 200, origin);
}

// ===========================================================================
// POST /api/debug/test-nudge-delivery
// ===========================================================================

async function handleTestNudgeDelivery(
  request: Request,
  env: Env,
  userId: string,
  origin?: string | null,
): Promise<Response> {
  const db = env.DB;
  const body = await request.json<{ user_id?: string; nudge_id?: string; dry_run?: boolean }>();
  const targetUserId = body.user_id || userId;
  const dryRun = body.dry_run !== false;

  // Get pending nudges
  const pendingNudges = await getPendingNudges(db, 10, targetUserId);

  if (pendingNudges.length === 0) {
    return jsonResponse({
      data: {
        message: 'No pending nudges to deliver',
        pendingCount: 0,
      },
    }, 200, origin);
  }

  if (dryRun) {
    return jsonResponse({
      data: {
        dryRun: true,
        message: 'Simulation only - no nudges sent',
        pendingNudges: pendingNudges.map(n => ({
          id: n.id,
          scheduledFor: n.scheduled_for,
          userPhone: n.userPhone.slice(0, 5) + '...',
          message: n.message.slice(0, 50) + '...',
        })),
      },
    }, 200, origin);
  }

  // Actually deliver nudges
  const results = [];
  for (const nudge of pendingNudges) {
    if (body.nudge_id && nudge.id !== body.nudge_id) continue;

    const sendResult = await sendNudge(env, nudge);
    if (sendResult.success) {
      await markNudgeDelivered(db, nudge.id);
    }
    results.push({
      nudgeId: nudge.id,
      ...sendResult,
    });

    // Only send one if nudge_id specified
    if (body.nudge_id) break;
  }

  return jsonResponse({
    data: {
      dryRun: false,
      results,
    },
  }, 200, origin);
}

// ===========================================================================
// GET /api/debug/cron-simulation
// ===========================================================================

async function handleCronSimulation(
  request: Request,
  env: Env,
  userId: string,
  origin?: string | null,
): Promise<Response> {
  const db = env.DB;
  const now = new Date();

  // Simulate what the hourly cron would do

  // 1. Get all users with timezone (same query as cron)
  const { results: users } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.timezone, u.preferred_nudge_hour, u.subscription_tier
       FROM users u
       INNER JOIN contacts c ON u.id = c.user_id
       WHERE c.archived = 0
         AND c.intent NOT IN ('dormant', 'new')
         AND u.timezone IS NOT NULL`
    )
    .all<{
      id: string;
      name: string;
      timezone: string;
      preferred_nudge_hour: number;
      subscription_tier: string;
    }>();

  // 2. Check which users would be processed this hour
  const usersAtTheirHour: Array<{
    id: string;
    name: string;
    timezone: string;
    preferredHour: number;
    currentHourInTz: number;
  }> = [];

  const usersNotAtTheirHour: Array<{
    id: string;
    name: string;
    timezone: string;
    preferredHour: number;
    currentHourInTz: number;
  }> = [];

  for (const user of users) {
    let currentHour: number;
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: user.timezone,
        hour: 'numeric',
        hour12: false,
      });
      currentHour = parseInt(formatter.format(now), 10);
    } catch {
      currentHour = now.getUTCHours();
    }

    const record = {
      id: user.id,
      name: user.name,
      timezone: user.timezone,
      preferredHour: user.preferred_nudge_hour,
      currentHourInTz: currentHour,
    };

    if (currentHour === user.preferred_nudge_hour) {
      usersAtTheirHour.push(record);
    } else {
      usersNotAtTheirHour.push(record);
    }
  }

  return jsonResponse({
    data: {
      simulationTime: now.toISOString(),
      utcHour: now.getUTCHours(),
      totalUsersWithContacts: users.length,
      usersAtTheirNudgeHour: usersAtTheirHour.length,
      usersNotAtTheirNudgeHour: usersNotAtTheirHour.length,
      wouldProcess: usersAtTheirHour,
      wouldSkip: usersNotAtTheirHour.slice(0, 10), // Just first 10
    },
  }, 200, origin);
}
