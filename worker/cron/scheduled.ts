/**
 * Scheduled Jobs — Cloudflare Cron Trigger handlers.
 *
 * TIMEZONE-AWARE DELIVERY:
 *
 *   The hourly trigger (`0 * * * *`) handles all timezone-sensitive jobs.
 *   Each user has a `timezone` and `preferred_nudge_hour` in their profile.
 *   The hourly job checks: "Which users have their preferred hour NOW?"
 *   and only processes those users.
 *
 * Cron schedule (all times UTC):
 *
 *   0 * * * *    → Hourly: timezone-aware nudge generation, delivery, sorting
 *   0 0 * * *    → Midnight UTC: trial expiration, usage cleanup
 *   0 6 * * 1    → Monday 6am UTC: weekly health recalculation
 *
 * Error handling:
 *
 *   Each job catches its own errors and logs them. A failed job doesn't
 *   affect other jobs scheduled at the same time. Cloudflare will retry
 *   failed crons according to its retry policy.
 *
 * @see wrangler.toml [triggers] for cron expressions
 * @see worker/services/subscription-service.ts for processExpiredTrials()
 * @see worker/services/contact-service.ts for recalculateAllHealthStatuses()
 * @see worker/services/nudge-service.ts for nudge generation and delivery
 */

import type { Env } from '../../shared/types';
import { processExpiredTrials, purgeOldUsageData } from '../services/subscription-service';
import { recalculateAllHealthStatuses } from '../services/contact-service';
import {
  generateNudgesForUser,
  getPendingNudges,
  sendNudge,
  markNudgeDelivered,
} from '../services/nudge-service';
import { generateSortingCheckins } from '../services/sorting-checkin-service';
import { processTrialReminders, sendTrialExpiredNotification } from '../services/trial-messaging-service';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Result from a cron job for logging.
 */
export interface CronJobResult {
  job: string;
  success: boolean;
  duration: number;
  details?: Record<string, unknown>;
  error?: string;
}

/**
 * User with timezone info for hourly processing.
 */
interface UserWithTimezone {
  id: string;
  name: string;
  timezone: string;
  preferred_nudge_hour: number;
  subscription_tier: string;
}

// ===========================================================================
// Timezone Helpers
// ===========================================================================

/**
 * Get the current hour in a given timezone.
 * Returns 0-23.
 */
function getCurrentHourInTimezone(timezone: string): number {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const hourStr = formatter.format(now);
    return parseInt(hourStr, 10);
  } catch {
    // Invalid timezone, default to UTC
    return new Date().getUTCHours();
  }
}

/**
 * Check if it's Monday in the given timezone.
 */
function isMondayInTimezone(timezone: string): boolean {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    });
    return formatter.format(now) === 'Monday';
  } catch {
    // Invalid timezone, check UTC
    return new Date().getUTCDay() === 1;
  }
}

// ===========================================================================
// Main Dispatcher
// ===========================================================================

/**
 * Route a scheduled event to the appropriate job handler(s).
 *
 * @param event - Cloudflare ScheduledEvent with cron trigger info
 * @param env   - Worker environment bindings
 * @param ctx   - Execution context for waitUntil
 */
export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const trigger = event.cron;
  const results: CronJobResult[] = [];

  console.log(`[cron] Triggered: ${trigger} at ${new Date().toISOString()}`);

  // ─── Hourly: Timezone-aware nudge generation & delivery ───
  if (trigger === '0 * * * *') {
    results.push(await runJob('hourlyNudgeProcessing', () => hourlyNudgeProcessing(env)));
    results.push(await runJob('hourlyTrialReminders', () => hourlyTrialReminders(env)));
    results.push(await runJob('hourlySortingCheckin', () => hourlySortingCheckin(env)));
  }

  // ─── Midnight UTC daily — Trial expiration + usage cleanup ───
  if (trigger === '0 0 * * *') {
    results.push(await runJob('trialExpirationCheck', () => trialExpirationCheck(env)));
    results.push(await runJob('usageDataCleanup', () => usageDataCleanup(env)));
  }

  // ─── Monday 6am UTC — Weekly health recalculation ───
  if (trigger === '0 6 * * 1') {
    results.push(await runJob('healthRecalculation', () => healthRecalculation(env)));
  }

  // Log summary
  const successful = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`[cron] Completed: ${successful} succeeded, ${failed} failed`);

  for (const result of results) {
    if (result.success) {
      console.log(`[cron] ✓ ${result.job} (${result.duration}ms)`, result.details);
    } else {
      console.error(`[cron] ✗ ${result.job} (${result.duration}ms):`, result.error);
    }
  }
}

// ===========================================================================
// Job Wrapper
// ===========================================================================

/**
 * Run a job with timing and error handling.
 */
async function runJob(
  name: string,
  fn: () => Promise<Record<string, unknown>>,
): Promise<CronJobResult> {
  const start = Date.now();

  try {
    const details = await fn();
    return {
      job: name,
      success: true,
      duration: Date.now() - start,
      details,
    };
  } catch (err) {
    return {
      job: name,
      success: false,
      duration: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ===========================================================================
// Timezone-Aware Hourly Jobs
// ===========================================================================

/**
 * Hourly nudge generation and delivery.
 *
 * Runs every hour. For each user, checks if their preferred_nudge_hour
 * matches the current hour in their timezone. If so:
 *   1. Generate nudges for that user
 *   2. Immediately deliver any pending nudges
 *
 * This ensures users get nudges at 8am (or their preferred time) in
 * their local timezone, regardless of where they are in the world.
 */
async function hourlyNudgeProcessing(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get all users with their timezone settings
  const { results: users } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.timezone, u.preferred_nudge_hour, u.subscription_tier
       FROM users u
       INNER JOIN contacts c ON u.id = c.user_id
       WHERE c.archived = 0
         AND c.intent NOT IN ('dormant', 'new')
         AND u.timezone IS NOT NULL`
    )
    .all<UserWithTimezone>();

  let usersProcessed = 0;
  let nudgesGenerated = 0;
  let nudgesDelivered = 0;

  for (const user of users) {
    const currentHour = getCurrentHourInTimezone(user.timezone);

    // Skip if it's not their preferred nudge hour
    if (currentHour !== user.preferred_nudge_hour) {
      continue;
    }

    usersProcessed++;

    try {
      // Generate nudges
      const isWeekly = user.subscription_tier === 'free';
      const genResult = await generateNudgesForUser(db, env, user.id, { weekly: isWeekly });
      nudgesGenerated += genResult.nudgesCreated;

      // Immediately deliver pending nudges for this user
      const pendingNudges = await getPendingNudges(db, 10, user.id);
      for (const nudge of pendingNudges) {
        const sendResult = await sendNudge(env, nudge);
        if (sendResult.success) {
          await markNudgeDelivered(db, nudge.id);
          nudgesDelivered++;
        }
      }
    } catch (err) {
      console.error(`[cron:hourlyNudge] Failed for user ${user.id}:`, err);
    }
  }

  return {
    totalUsers: users.length,
    usersAtTheirHour: usersProcessed,
    nudgesGenerated,
    nudgesDelivered,
  };
}

/**
 * Hourly trial reminders — timezone-aware.
 *
 * Checks trial users and sends reminders at their preferred hour.
 */
async function hourlyTrialReminders(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get trial users with timezone
  const { results: users } = await db
    .prepare(
      `SELECT id, name, timezone, preferred_nudge_hour
       FROM users
       WHERE subscription_tier = 'trial'
         AND timezone IS NOT NULL`
    )
    .all<UserWithTimezone>();

  let usersChecked = 0;
  let remindersSent = 0;

  for (const user of users) {
    const currentHour = getCurrentHourInTimezone(user.timezone);
    if (currentHour !== user.preferred_nudge_hour) {
      continue;
    }

    usersChecked++;

    try {
      // Process trial reminder for this user
      const result = await processTrialReminders(db, env, user.id);
      if (result.usageHighlightsSent > 0 || result.upgradePromptsSent > 0) {
        remindersSent++;
      }
    } catch (err) {
      console.error(`[cron:hourlyTrialReminder] Failed for user ${user.id}:`, err);
    }
  }

  return {
    totalTrialUsers: users.length,
    usersAtTheirHour: usersChecked,
    remindersSent,
  };
}

/**
 * Hourly sorting check-in — timezone-aware, Monday only.
 *
 * Runs every hour but only processes users where:
 *   1. It's Monday in their timezone
 *   2. It's their preferred nudge hour
 */
async function hourlySortingCheckin(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get users with unsorted contacts
  const { results: users } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.timezone, u.preferred_nudge_hour
       FROM users u
       INNER JOIN contacts c ON u.id = c.user_id
       WHERE c.intent = 'new'
         AND c.archived = 0
         AND u.timezone IS NOT NULL`
    )
    .all<UserWithTimezone>();

  let usersChecked = 0;
  let checkInsSent = 0;

  for (const user of users) {
    // Only process on Monday at their preferred hour
    if (!isMondayInTimezone(user.timezone)) {
      continue;
    }

    const currentHour = getCurrentHourInTimezone(user.timezone);
    if (currentHour !== user.preferred_nudge_hour) {
      continue;
    }

    usersChecked++;

    try {
      const result = await generateSortingCheckins(db, env, user.id);
      if (result.checkInsSent > 0) {
        checkInsSent++;
      }
    } catch (err) {
      console.error(`[cron:hourlySorting] Failed for user ${user.id}:`, err);
    }
  }

  return {
    totalUsersWithUnsorted: users.length,
    usersAtMondayHour: usersChecked,
    checkInsSent,
  };
}

// ===========================================================================
// Daily/Weekly Jobs (UTC-based)
// ===========================================================================

/**
 * Check for expired trials and downgrade to free tier.
 *
 * Runs at midnight UTC daily. This catches users whose trial expired
 * but haven't made any requests (so lazy downgrade hasn't fired).
 */
async function trialExpirationCheck(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get users who will be downgraded
  const { results: expiringUsers } = await db
    .prepare(
      `SELECT id FROM users
       WHERE subscription_tier = 'trial'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < datetime('now')`
    )
    .all<{ id: string }>();

  // Process the downgrades
  const result = await processExpiredTrials(db);

  // Send expiration notifications
  let notificationsSent = 0;
  let notificationErrors = 0;

  for (const user of expiringUsers) {
    try {
      await sendTrialExpiredNotification(db, env, user.id);
      notificationsSent++;
    } catch (err) {
      console.error(`[cron:trialExpiration] Failed to notify user ${user.id}:`, err);
      notificationErrors++;
    }
  }

  return {
    usersDowngraded: result.downgraded,
    notificationsSent,
    notificationErrors,
  };
}

/**
 * Clean up old usage tracking data.
 *
 * Runs at midnight UTC daily. Purges rows older than 90 days.
 */
async function usageDataCleanup(env: Env): Promise<Record<string, unknown>> {
  const result = await purgeOldUsageData(env.DB, 90);
  return { rowsDeleted: result.rowsDeleted };
}

/**
 * Recalculate health statuses for all contacts.
 *
 * Runs Monday 6am UTC weekly. Ensures dashboard shows accurate health.
 */
async function healthRecalculation(env: Env): Promise<Record<string, unknown>> {
  const result = await recalculateAllHealthStatuses(env.DB);
  return {
    usersProcessed: result.usersProcessed,
    contactsUpdated: result.contactsUpdated,
  };
}
