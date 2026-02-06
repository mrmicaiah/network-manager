/**
 * Trial Messaging Service — Lifecycle messaging for trial users.
 *
 * Implements personalized messaging at key trial touchpoints:
 *
 *   1. Signup: "You've got full access for the next 14 days."
 *   2. Day 10-12: Soft usage highlight (if heavily engaged)
 *   3. Day 12-13: Upgrade prompt with personalized stats
 *   4. Day 14: Downgrade notification when trial expires
 *
 * Philosophy:
 *
 *   Bethany sells value based on what the user actually did during
 *   the trial — not generic marketing speak. If they added 20 contacts
 *   and reconnected with 8 people, she highlights that. The goal is
 *   to make the upgrade decision feel personal and earned.
 *
 * Integration points:
 *
 *   - Signup: Called from signup-service.ts after user creation
 *   - Day 10-13: Daily cron job checks trial users for reminder eligibility
 *   - Day 14: Called from subscription-service.ts on downgrade
 *
 * Duplicate prevention:
 *
 *   Each user has a trial_reminder_stage column tracking which stage
 *   was last sent. We never re-send the same stage, and stages must
 *   progress in order (signup → usage_highlight → upgrade_prompt → expired).
 *
 * @see worker/cron/scheduled.ts for dailyTrialReminders() job
 * @see shared/models.ts for UserRow, TrialReminderStage
 */

import type { Env } from '../../shared/types';
import type { UserRow, SubscriptionTier } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** Day of trial to send usage highlight (if engaged) */
const USAGE_HIGHLIGHT_DAY_START = 10;
const USAGE_HIGHLIGHT_DAY_END = 12;

/** Day of trial to send upgrade prompt */
const UPGRADE_PROMPT_DAY_START = 12;
const UPGRADE_PROMPT_DAY_END = 13;

/** Minimum contacts added to trigger usage highlight */
const USAGE_HIGHLIGHT_MIN_CONTACTS = 5;

/** Minimum interactions to trigger usage highlight */
const USAGE_HIGHLIGHT_MIN_INTERACTIONS = 3;

/** Upgrade link URL */
const UPGRADE_URL = 'https://app.untitledpublishers.com/upgrade';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Trial reminder stages — progress in this order.
 */
export type TrialReminderStage =
  | 'signup'
  | 'usage_highlight'
  | 'upgrade_prompt'
  | 'expired';

/**
 * User's trial usage stats for personalized messaging.
 */
export interface TrialUsageStats {
  contactsAdded: number;
  interactionsLogged: number;
  nudgesReceived: number;
  daysActive: number;
}

/**
 * Result of processing trial reminders.
 */
export interface TrialReminderResult {
  usersChecked: number;
  usageHighlightsSent: number;
  upgradePromptsSent: number;
  skippedAlreadySent: number;
  skippedLowUsage: number;
  errors: number;
}

// ===========================================================================
// Signup Message
// ===========================================================================

/**
 * Send the initial trial welcome message.
 * Called immediately after user signup completes.
 *
 * Message: "You've got full access for the next 14 days. Let's make the most of it."
 *
 * @param db     - D1 database binding
 * @param env    - Worker environment with SendBlue credentials
 * @param userId - The new user's ID
 */
export async function sendTrialWelcome(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<void> {
  const user = await db
    .prepare('SELECT id, phone, name FROM users WHERE id = ?')
    .bind(userId)
    .first<Pick<UserRow, 'id' | 'phone' | 'name'>>();

  if (!user) {
    console.error(`[trial:welcome] User not found: ${userId}`);
    return;
  }

  const firstName = user.name.split(' ')[0];
  const message = `Hey ${firstName}! 🎉 You've got full access to everything for the next 14 days. I'm here to help you stay connected with the people who matter most. Let's make the most of it — start by telling me about someone important to you!`;

  await sendSMS(env, user.phone, message);
  await updateTrialReminderStage(db, userId, 'signup');
}

// ===========================================================================
// Daily Trial Reminder Processing
// ===========================================================================

/**
 * Process trial reminders for all eligible users.
 * Called by daily cron job.
 *
 * Checks each trial user's day number and sends appropriate message:
 *   - Day 10-12 + high usage: Usage highlight
 *   - Day 12-13 (not already sent highlight): Upgrade prompt
 *
 * @param db  - D1 database binding
 * @param env - Worker environment with SendBlue credentials
 * @param now - Override current time (for testing)
 */
export async function processTrialReminders(
  db: D1Database,
  env: Env,
  now?: Date,
): Promise<TrialReminderResult> {
  const currentTime = now ?? new Date();

  const result: TrialReminderResult = {
    usersChecked: 0,
    usageHighlightsSent: 0,
    upgradePromptsSent: 0,
    skippedAlreadySent: 0,
    skippedLowUsage: 0,
    errors: 0,
  };

  // Get all trial users with their trial_ends_at
  const { results: trialUsers } = await db
    .prepare(
      `SELECT id, phone, name, trial_ends_at, trial_reminder_stage
       FROM users
       WHERE subscription_tier = 'trial'
         AND trial_ends_at IS NOT NULL`
    )
    .all<Pick<UserRow, 'id' | 'phone' | 'name' | 'trial_ends_at'> & { trial_reminder_stage: TrialReminderStage | null }>();

  result.usersChecked = trialUsers.length;

  for (const user of trialUsers) {
    try {
      const trialEnd = new Date(user.trial_ends_at!);
      const msRemaining = trialEnd.getTime() - currentTime.getTime();
      const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
      const dayOfTrial = 14 - daysRemaining;

      // Determine what stage to potentially send
      const currentStage = user.trial_reminder_stage;

      // Day 10-12: Usage highlight (only if haven't sent anything since signup)
      if (
        dayOfTrial >= USAGE_HIGHLIGHT_DAY_START &&
        dayOfTrial <= USAGE_HIGHLIGHT_DAY_END &&
        (currentStage === 'signup' || currentStage === null)
      ) {
        const stats = await getTrialUsageStats(db, user.id);

        // Only send if they've been active
        if (
          stats.contactsAdded >= USAGE_HIGHLIGHT_MIN_CONTACTS ||
          stats.interactionsLogged >= USAGE_HIGHLIGHT_MIN_INTERACTIONS
        ) {
          await sendUsageHighlight(db, env, user, stats);
          result.usageHighlightsSent++;
        } else {
          result.skippedLowUsage++;
        }
        continue;
      }

      // Day 12-13: Upgrade prompt (if haven't sent upgrade_prompt yet)
      if (
        dayOfTrial >= UPGRADE_PROMPT_DAY_START &&
        dayOfTrial <= UPGRADE_PROMPT_DAY_END &&
        currentStage !== 'upgrade_prompt' &&
        currentStage !== 'expired'
      ) {
        const stats = await getTrialUsageStats(db, user.id);
        await sendUpgradePrompt(db, env, user, stats, daysRemaining);
        result.upgradePromptsSent++;
        continue;
      }

      // Already processed or not in window
      if (currentStage === 'upgrade_prompt' || currentStage === 'expired') {
        result.skippedAlreadySent++;
      }
    } catch (err) {
      console.error(`[trial:reminder] Failed for user ${user.id}:`, err);
      result.errors++;
    }
  }

  return result;
}

// ===========================================================================
// Usage Highlight (Day 10-12)
// ===========================================================================

/**
 * Send a soft usage highlight message.
 * Only sent to engaged users — acknowledges their activity.
 *
 * Message: "You're getting good use out of this — [X contacts added, Y people reconnected]"
 */
async function sendUsageHighlight(
  db: D1Database,
  env: Env,
  user: Pick<UserRow, 'id' | 'phone' | 'name'>,
  stats: TrialUsageStats,
): Promise<void> {
  const firstName = user.name.split(' ')[0];

  // Build personalized stats string
  const statsParts: string[] = [];
  if (stats.contactsAdded > 0) {
    statsParts.push(`${stats.contactsAdded} contact${stats.contactsAdded === 1 ? '' : 's'} added`);
  }
  if (stats.interactionsLogged > 0) {
    statsParts.push(`${stats.interactionsLogged} ${stats.interactionsLogged === 1 ? 'person' : 'people'} reconnected with`);
  }

  const statsString = statsParts.join(' and ');

  const message = `Hey ${firstName}! You're getting good use out of this — ${statsString}. Keep it up! Your relationships will thank you. 🙌`;

  await sendSMS(env, user.phone, message);
  await updateTrialReminderStage(db, user.id, 'usage_highlight');
}

// ===========================================================================
// Upgrade Prompt (Day 12-13)
// ===========================================================================

/**
 * Send the upgrade prompt with personalized stats.
 * Clear CTA with value recap based on actual usage.
 *
 * Message: "Your trial ends in a couple days. You've added [X] contacts and
 * I've helped you reconnect with [Y] people. Want to keep this going? [link]"
 */
async function sendUpgradePrompt(
  db: D1Database,
  env: Env,
  user: Pick<UserRow, 'id' | 'phone' | 'name'>,
  stats: TrialUsageStats,
  daysRemaining: number,
): Promise<void> {
  const firstName = user.name.split(' ')[0];

  // Build personalized value string
  let valueString: string;
  if (stats.contactsAdded > 0 && stats.interactionsLogged > 0) {
    valueString = `You've added ${stats.contactsAdded} contact${stats.contactsAdded === 1 ? '' : 's'} and I've helped you reconnect with ${stats.interactionsLogged} ${stats.interactionsLogged === 1 ? 'person' : 'people'}.`;
  } else if (stats.contactsAdded > 0) {
    valueString = `You've added ${stats.contactsAdded} contact${stats.contactsAdded === 1 ? '' : 's'} to keep track of.`;
  } else if (stats.interactionsLogged > 0) {
    valueString = `I've helped you reconnect with ${stats.interactionsLogged} ${stats.interactionsLogged === 1 ? 'person' : 'people'}.`;
  } else {
    valueString = `I'm here whenever you're ready to start building better habits.`;
  }

  const daysWord = daysRemaining === 1 ? 'day' : 'days';
  const message = `Hey ${firstName}, your trial ends in ${daysRemaining} ${daysWord}. ${valueString} Want to keep this going? ${UPGRADE_URL}`;

  await sendSMS(env, user.phone, message);
  await updateTrialReminderStage(db, user.id, 'upgrade_prompt');
}

// ===========================================================================
// Expiration Notification (Day 14)
// ===========================================================================

/**
 * Send the trial expiration notification.
 * Called when a user is downgraded from trial to free.
 *
 * Message: "Your trial ended, so I've switched you to the free plan.
 * You can still use me, but I'll be a bit more limited. Upgrade anytime
 * if you want the full experience back."
 *
 * @param db     - D1 database binding
 * @param env    - Worker environment with SendBlue credentials
 * @param userId - The user who just got downgraded
 */
export async function sendTrialExpiredNotification(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<void> {
  const user = await db
    .prepare('SELECT id, phone, name FROM users WHERE id = ?')
    .bind(userId)
    .first<Pick<UserRow, 'id' | 'phone' | 'name'>>();

  if (!user) {
    console.error(`[trial:expired] User not found: ${userId}`);
    return;
  }

  const firstName = user.name.split(' ')[0];
  const message = `Hey ${firstName}, your trial ended, so I've switched you to the free plan. You can still use me, but I'll be a bit more limited — fewer daily messages and nudges. Upgrade anytime if you want the full experience back: ${UPGRADE_URL}`;

  await sendSMS(env, user.phone, message);
  await updateTrialReminderStage(db, userId, 'expired');
}

// ===========================================================================
// Usage Stats
// ===========================================================================

/**
 * Get trial usage statistics for a user.
 * Counts activity since the user signed up.
 */
async function getTrialUsageStats(
  db: D1Database,
  userId: string,
): Promise<TrialUsageStats> {
  // Get user's created_at for trial start
  const user = await db
    .prepare('SELECT created_at FROM users WHERE id = ?')
    .bind(userId)
    .first<{ created_at: string }>();

  if (!user) {
    return { contactsAdded: 0, interactionsLogged: 0, nudgesReceived: 0, daysActive: 0 };
  }

  const trialStart = user.created_at;

  // Count contacts added during trial
  const contactsResult = await db
    .prepare(
      `SELECT COUNT(*) as count FROM contacts
       WHERE user_id = ? AND created_at >= ?`
    )
    .bind(userId, trialStart)
    .first<{ count: number }>();

  // Count interactions logged during trial
  const interactionsResult = await db
    .prepare(
      `SELECT COUNT(*) as count FROM interactions
       WHERE user_id = ? AND created_at >= ?`
    )
    .bind(userId, trialStart)
    .first<{ count: number }>();

  // Count nudges received during trial
  const nudgesResult = await db
    .prepare(
      `SELECT COUNT(*) as count FROM nudges
       WHERE user_id = ? AND created_at >= ? AND status IN ('delivered', 'acted_on')`
    )
    .bind(userId, trialStart)
    .first<{ count: number }>();

  // Count unique active days
  const daysResult = await db
    .prepare(
      `SELECT COUNT(DISTINCT date) as count FROM usage_tracking
       WHERE user_id = ? AND date >= ?`
    )
    .bind(userId, trialStart.split('T')[0])
    .first<{ count: number }>();

  return {
    contactsAdded: contactsResult?.count ?? 0,
    interactionsLogged: interactionsResult?.count ?? 0,
    nudgesReceived: nudgesResult?.count ?? 0,
    daysActive: daysResult?.count ?? 0,
  };
}

// ===========================================================================
// Database Updates
// ===========================================================================

/**
 * Update the trial reminder stage for a user.
 */
async function updateTrialReminderStage(
  db: D1Database,
  userId: string,
  stage: TrialReminderStage,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE users
       SET trial_reminder_stage = ?,
           last_trial_reminder = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(stage, now, userId)
    .run();
}

// ===========================================================================
// SMS Helper
// ===========================================================================

/**
 * Send an SMS via SendBlue.
 */
async function sendSMS(
  env: Env,
  phone: string,
  message: string,
): Promise<void> {
  const response = await fetch('https://api.sendblue.co/api/send-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'sb-api-key-id': env.SENDBLUE_API_KEY,
      'sb-api-secret-key': env.SENDBLUE_API_SECRET,
    },
    body: JSON.stringify({
      number: phone,
      content: message,
      send_style: 'invisible',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SendBlue error: ${error}`);
  }
}
