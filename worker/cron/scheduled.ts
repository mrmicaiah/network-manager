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
 *   0 1 * * *    → 1 AM UTC: daily score recalculation (point decay)
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
 * @see worker/services/score-service.ts for recalculateAllScores()
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
import { recalculateAllScores } from '../services/score-service';

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
// Constants
// ===========================================================================

/**
 * Batch size for processing users in bulk operations.
 * Keeps memory usage bounded and allows progress logging.
 */
const USER_BATCH_SIZE = 100;

/**
 * Timeout for individual user processing (in ms).
 * Prevents one slow user from blocking the entire job.
 */
const USER_PROCESS_TIMEOUT = 10000; // 10 seconds

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

  // ─── 1 AM UTC daily — Score recalculation (point decay) ───
  if (trigger === '0 1 * * *') {
    results.push(await runJob('scoreRecalculation', () => scoreRecalculation(env)));
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
 *   1. Generate nudges for that user (with immediate=true for instant delivery)
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
      // Generate nudges with immediate=true so they're scheduled for NOW
      // This is critical! Without immediate=true, nudges get scheduled for
      // tomorrow and never get delivered.
      const isWeekly = user.subscription_tier === 'free';
      const genResult = await generateNudgesForUser(db, env, user.id, { 
        weekly: isWeekly,
        immediate: true,  // Schedule for NOW, not next delivery window
      });
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
 * Recalculate scores for all users.
 *
 * Runs at 1 AM UTC daily (off-peak). Handles point decay by
 * recalculating scores as the cadence window rolls forward.
 *
 * Processes users in batches to:
 *   1. Keep memory usage bounded
 *   2. Allow progress logging
 *   3. Prevent one slow user from blocking others
 */
async function scoreRecalculation(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get total user count for progress tracking
  const countResult = await db
    .prepare(`SELECT COUNT(*) as count FROM users`)
    .first<{ count: number }>();
  const totalUsers = countResult?.count ?? 0;

  let offset = 0;
  let usersProcessed = 0;
  let scoresUpdated = 0;
  let errors = 0;
  let batchNumber = 0;

  // Process users in batches
  while (offset < totalUsers) {
    batchNumber++;

    // Get batch of user IDs
    const { results: users } = await db
      .prepare(`SELECT id FROM users ORDER BY id LIMIT ? OFFSET ?`)
      .bind(USER_BATCH_SIZE, offset)
      .all<{ id: string }>();

    if (users.length === 0) break;

    console.log(
      `[cron:scoreRecalc] Processing batch ${batchNumber} (users ${offset + 1}-${offset + users.length} of ${totalUsers})`
    );

    // Process each user in the batch
    for (const user of users) {
      try {
        // Wrap in timeout to prevent one slow user from blocking
        const result = await withTimeout(
          recalculateAllScores(db, user.id),
          USER_PROCESS_TIMEOUT,
          `Score recalc timeout for user ${user.id}`
        );
        scoresUpdated += result.updated;
        usersProcessed++;
      } catch (err) {
        errors++;
        console.error(`[cron:scoreRecalc] Failed for user ${user.id}:`, err);
      }
    }

    offset += USER_BATCH_SIZE;
  }

  return {
    totalUsers,
    usersProcessed,
    scoresUpdated,
    errors,
    batches: batchNumber,
  };
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

// ===========================================================================
// Utility Functions
// ===========================================================================

/**
 * Wrap a promise with a timeout.
 * Rejects if the promise doesn't resolve within the given time.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId!);
    return result;
  } catch (err) {
    clearTimeout(timeoutId!);
    throw err;
  }
}
