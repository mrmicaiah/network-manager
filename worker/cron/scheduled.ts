/**
 * Scheduled Jobs — Cloudflare Cron Trigger handlers.
 *
 * Each cron trigger defined in wrangler.toml routes here via the
 * scheduled() export in index.ts. Jobs are lightweight dispatchers
 * that call into the appropriate service functions.
 *
 * Cron schedule (all times UTC):
 *
 *   0 9 * * *    → dailyNudgeGeneration (3am Central) — premium users
 *   0 9 * * *    → dailyTrialReminders (3am Central) — trial messaging
 *   0 9 * * 1    → weeklyNudgeGeneration (Monday 3am Central) — free users
 *   0 10 * * 1   → weeklySortingCheckin (Monday 4am Central) — sorting offers
 *   0 14 * * *   → nudgeDelivery (8am Central) — send pending nudges
 *   0 0 * * *    → trialExpirationCheck (midnight) — downgrade expired trials
 *   0 0 * * *    → usageDataCleanup (midnight) — purge old usage rows
 *   0 0 * * 0    → healthRecalculation (Sunday midnight) — refresh health statuses
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
 * @see worker/services/sorting-checkin-service.ts for weekly sorting offers
 * @see worker/services/trial-messaging-service.ts for trial lifecycle messaging
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

// ===========================================================================
// Main Dispatcher
// ===========================================================================

/**
 * Route a scheduled event to the appropriate job handler(s).
 *
 * Called from index.ts scheduled() export. A single cron time can
 * trigger multiple jobs (e.g., midnight runs both trial check and
 * usage cleanup).
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

  // ─── 9am UTC daily (3am Central) — Premium nudge generation + trial reminders ───
  if (trigger === '0 9 * * *') {
    results.push(await runJob('dailyNudgeGeneration', () => dailyNudgeGeneration(env)));
    results.push(await runJob('dailyTrialReminders', () => dailyTrialReminders(env)));
  }

  // ─── 9am UTC Monday (3am Central Monday) — Free tier weekly nudges ───
  if (trigger === '0 9 * * 1') {
    results.push(await runJob('weeklyNudgeGeneration', () => weeklyNudgeGeneration(env)));
  }

  // ─── 10am UTC Monday (4am Central Monday) — Weekly sorting check-in ───
  if (trigger === '0 10 * * 1') {
    results.push(await runJob('weeklySortingCheckin', () => weeklySortingCheckin(env)));
  }

  // ─── 2pm UTC daily (8am Central) — Deliver pending nudges ───
  if (trigger === '0 14 * * *') {
    results.push(await runJob('nudgeDelivery', () => nudgeDelivery(env)));
  }

  // ─── Midnight UTC daily — Trial expiration + usage cleanup ───
  if (trigger === '0 0 * * *') {
    results.push(await runJob('trialExpirationCheck', () => trialExpirationCheck(env)));
    results.push(await runJob('usageDataCleanup', () => usageDataCleanup(env)));
  }

  // ─── Midnight UTC Sunday — Weekly health recalculation ───
  if (trigger === '0 0 * * 0') {
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
// Job Implementations
// ===========================================================================

/**
 * Daily nudge generation for premium users.
 *
 * Runs at 3am Central so nudges are ready for the 8am delivery window.
 * Only processes premium and active trial users — they get daily nudges.
 *
 * Smart grouping limits:
 *   - Maximum 5 nudges per user per day
 *   - Prioritized by urgency (red health > yellow, inner circle > outer)
 *   - Respects 48-hour cooldown per contact
 */
async function dailyNudgeGeneration(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get all premium/trial users with at least one active contact
  const { results: users } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.name
       FROM users u
       INNER JOIN contacts c ON u.id = c.user_id
       WHERE u.subscription_tier IN ('premium', 'trial')
         AND c.archived = 0
         AND c.intent NOT IN ('dormant', 'new')`
    )
    .all<{ id: string; name: string }>();

  let nudgesGenerated = 0;
  let usersProcessed = 0;
  let usersSkipped = 0;

  for (const user of users) {
    try {
      const result = await generateNudgesForUser(db, env, user.id, { weekly: false });
      nudgesGenerated += result.nudgesCreated;
      usersProcessed++;

      if (result.nudgesCreated === 0) {
        usersSkipped++;
      }
    } catch (err) {
      console.error(`[cron:dailyNudge] Failed for user ${user.id}:`, err);
    }
  }

  return {
    usersProcessed,
    usersSkipped,
    nudgesGenerated,
    tier: 'premium/trial',
  };
}

/**
 * Weekly nudge generation for free tier users.
 *
 * Runs Monday 3am Central. Free users get a single weekly digest message
 * listing up to 3 contacts needing attention. This provides value while
 * encouraging upgrade for daily, personalized nudges.
 *
 * Digest format:
 *   🌟 Weekly Check-in Reminder
 *   Here are 3 people who'd love to hear from you:
 *   1. Mom
 *   2. Sarah Chen
 *   3. Mike Johnson
 */
async function weeklyNudgeGeneration(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get all free tier users with at least one active contact
  const { results: users } = await db
    .prepare(
      `SELECT DISTINCT u.id, u.name
       FROM users u
       INNER JOIN contacts c ON u.id = c.user_id
       WHERE u.subscription_tier = 'free'
         AND c.archived = 0
         AND c.intent NOT IN ('dormant', 'new')`
    )
    .all<{ id: string; name: string }>();

  let nudgesGenerated = 0;
  let usersProcessed = 0;
  let usersSkipped = 0;

  for (const user of users) {
    try {
      const result = await generateNudgesForUser(db, env, user.id, { weekly: true });
      nudgesGenerated += result.nudgesCreated;
      usersProcessed++;

      if (result.nudgesCreated === 0) {
        usersSkipped++;
      }
    } catch (err) {
      console.error(`[cron:weeklyNudge] Failed for user ${user.id}:`, err);
    }
  }

  return {
    usersProcessed,
    usersSkipped,
    nudgesGenerated,
    tier: 'free',
  };
}

/**
 * Daily trial reminders for users approaching trial end.
 *
 * Runs at 3am Central daily. Checks trial users and sends appropriate
 * lifecycle messages based on where they are in their trial:
 *
 *   - Day 10-12 + high engagement: Usage highlight ("You're getting good use...")
 *   - Day 12-13: Upgrade prompt with personalized stats
 *
 * Messages are personalized based on actual usage (contacts added,
 * people reconnected, etc.). Each stage is only sent once per user.
 *
 * Note: Signup welcome and expiration notices are sent synchronously
 * from signup-service.ts and subscription-service.ts respectively.
 */
async function dailyTrialReminders(env: Env): Promise<Record<string, unknown>> {
  const result = await processTrialReminders(env.DB, env);

  return {
    usersChecked: result.usersChecked,
    usageHighlightsSent: result.usageHighlightsSent,
    upgradePromptsSent: result.upgradePromptsSent,
    skippedAlreadySent: result.skippedAlreadySent,
    skippedLowUsage: result.skippedLowUsage,
    errors: result.errors,
  };
}

/**
 * Weekly sorting check-in for all users with unsorted contacts.
 *
 * Runs Monday 4am Central (1 hour after nudge generation so messages
 * are staggered). Prompts users who have contacts in the 'new' intent
 * bucket to sort them, offering either SMS-based sorting or dashboard.
 *
 * Smart offer conditions:
 *   - Only users with unsorted contacts OR contacts without clear goals
 *   - Only users who completed onboarding
 *   - Only users not offered in the last 6 days (prevents spam)
 *
 * Tier limits:
 *   - Free users: Can sort up to 5 contacts per week via SMS
 *   - Premium/trial: Unlimited sorting
 *
 * Message format:
 *   "Hey [name]! You've got [X] contacts I haven't placed yet, and [Y]
 *    without a clear goal. Want to sort through a few? You can do it
 *    here via text, or head to your dashboard: [link]"
 */
async function weeklySortingCheckin(env: Env): Promise<Record<string, unknown>> {
  const result = await generateSortingCheckins(env.DB, env);

  return {
    usersChecked: result.usersChecked,
    checkInsSent: result.checkInsSent,
    skippedNoContacts: result.skippedNoContacts,
    skippedCooldown: result.skippedCooldown,
    errors: result.errors,
  };
}

/**
 * Deliver pending nudges via SMS.
 *
 * Runs at 8am Central — the "morning coffee" delivery window when
 * users are most likely to see and act on reminders.
 *
 * Process:
 *   1. Fetch all nudges with status='pending' and scheduled_for <= now
 *   2. For each nudge, send via SendBlue
 *   3. Mark as 'delivered' on success
 *   4. Leave as 'pending' on failure (will retry next run)
 *
 * Rate limiting:
 *   - Processes up to 100 nudges per run
 *   - SendBlue handles rate limiting on their end
 *   - Failed sends are retried on the next cron run
 */
async function nudgeDelivery(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // Get pending nudges ready to send
  const nudges = await getPendingNudges(db, 100);

  let delivered = 0;
  let failed = 0;

  for (const nudge of nudges) {
    try {
      const result = await sendNudge(env, nudge);

      if (result.success) {
        await markNudgeDelivered(db, nudge.id);
        delivered++;
      } else {
        console.error(`[cron:nudgeDelivery] Send failed for nudge ${nudge.id}:`, result.error);
        failed++;
      }
    } catch (err) {
      console.error(`[cron:nudgeDelivery] Exception for nudge ${nudge.id}:`, err);
      failed++;
    }
  }

  return {
    pending: nudges.length,
    delivered,
    failed,
  };
}

/**
 * Check for expired trials and downgrade to free tier.
 *
 * Runs at midnight UTC daily. This catches users whose trial expired
 * but haven't made any requests (so lazy downgrade hasn't fired).
 *
 * Also sends trial expiration notifications to each downgraded user
 * so they know their status has changed.
 */
async function trialExpirationCheck(env: Env): Promise<Record<string, unknown>> {
  const db = env.DB;

  // First, get the list of users who will be downgraded
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

  // Send expiration notifications to each downgraded user
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
 * Runs at midnight UTC daily. Purges rows older than 90 days to
 * keep the usage_tracking table lean. Historical data beyond 90
 * days isn't needed for daily limit enforcement.
 */
async function usageDataCleanup(env: Env): Promise<Record<string, unknown>> {
  const result = await purgeOldUsageData(env.DB, 90);
  return { rowsDeleted: result.rowsDeleted };
}

/**
 * Recalculate health statuses for all contacts.
 *
 * Runs Sunday midnight UTC weekly. Health is stored denormalized
 * on contact rows for query performance, but it can drift if no
 * interactions are logged. This ensures the dashboard always shows
 * accurate health colors.
 */
async function healthRecalculation(env: Env): Promise<Record<string, unknown>> {
  const result = await recalculateAllHealthStatuses(env.DB);
  return {
    usersProcessed: result.usersProcessed,
    contactsUpdated: result.contactsUpdated,
  };
}
