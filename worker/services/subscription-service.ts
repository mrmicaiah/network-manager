/**
 * Subscription & Usage Tracking Service
 *
 * Manages subscription tiers, trial lifecycle, and per-user usage enforcement.
 *
 * Subscription model:
 *
 *   trial   → 14-day full access, auto-downgrades to free on expiry
 *   free    → limited contacts, messages, braindumps, nudges per day
 *   premium → unlimited everything (Stripe-managed)
 *
 * Usage tracking:
 *
 *   One row per user per day in usage_tracking table. Counters are
 *   incremented atomically via SQL. Free tier checks happen before
 *   the operation, not after — if you're at the limit, the request
 *   is denied before any work is done.
 *
 * Trial lifecycle:
 *
 *   - Created during web signup (14 days from account creation)
 *   - Checked on every inbound SMS and API call
 *   - Auto-downgraded to free when expired (lazy — on next request)
 *   - Once downgraded, trial_ends_at is preserved for "you had a trial" logic
 *
 * Usage:
 *
 *   // Before processing a message
 *   const allowed = await checkUsageLimit(db, userId, 'messages_sent');
 *   if (!allowed.permitted) {
 *     return reply(allowed.reason);
 *   }
 *   // ... process message ...
 *   await incrementUsage(db, userId, 'messages_sent');
 *
 * @see shared/models.ts for FREE_TIER_LIMITS, UsageTrackingRow, SubscriptionTier
 * @see worker/services/user-service.ts for getSubscriptionStatus()
 */

import type {
  UserRow,
  UsageTrackingRow,
  SubscriptionTier,
} from '../../shared/models';
import { FREE_TIER_LIMITS } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** Trial duration in days from account creation */
const TRIAL_DURATION_DAYS = 14;

/**
 * Usage counter keys — must match UsageTrackingRow column names.
 * This is the source of truth for what we track.
 */
export type UsageMetric =
  | 'messages_sent'
  | 'nudges_generated'
  | 'contacts_added'
  | 'braindumps_processed';

/**
 * Maps usage metrics to their free tier limit.
 * Keeps the lookup centralized so limit changes only happen in models.ts.
 */
const METRIC_TO_LIMIT: Record<UsageMetric, number> = {
  messages_sent: FREE_TIER_LIMITS.max_messages_per_day,
  nudges_generated: FREE_TIER_LIMITS.max_nudges_per_day,
  contacts_added: FREE_TIER_LIMITS.max_contacts, // treated as total, not daily — see checkContactLimit()
  braindumps_processed: FREE_TIER_LIMITS.max_braindumps_per_day,
};

/**
 * Human-readable names for limit-reached messages.
 */
const METRIC_LABELS: Record<UsageMetric, string> = {
  messages_sent: 'messages',
  nudges_generated: 'nudges',
  contacts_added: 'contacts',
  braindumps_processed: 'braindumps',
};

// ===========================================================================
// Types
// ===========================================================================

/**
 * Full subscription status — everything the app needs to make decisions.
 */
export interface SubscriptionStatus {
  /** Current effective tier (accounts for trial expiry) */
  tier: 'premium' | 'trial' | 'free';
  /** Whether the user has an active premium subscription */
  isPremium: boolean;
  /** Whether the trial is currently active (not expired) */
  isTrialActive: boolean;
  /** Whether the user has ever had a trial (even if expired) */
  hadTrial: boolean;
  /** Days remaining in trial, null if no active trial */
  daysUntilTrialExpires: number | null;
  /** Whether the trial just expired this check (was trial, now free) */
  justDowngraded: boolean;
}

/**
 * Result of a usage limit check.
 */
export interface UsageLimitResult {
  /** Whether the operation is allowed */
  permitted: boolean;
  /** Current count for this metric today */
  currentUsage: number;
  /** The limit (Infinity for premium/trial) */
  limit: number;
  /** Remaining before hitting the limit */
  remaining: number;
  /** Human-readable denial reason (null if permitted) */
  reason: string | null;
}

/**
 * Today's usage summary for a user.
 */
export interface DailyUsageSummary {
  date: string;
  messagesSent: number;
  nudgesGenerated: number;
  contactsAdded: number;
  braindumpsProcessed: number;
  /** Only populated for free tier users */
  limits: {
    messages: { used: number; max: number; remaining: number } | null;
    nudges: { used: number; max: number; remaining: number } | null;
    braindumps: { used: number; max: number; remaining: number } | null;
    contacts: { used: number; max: number; remaining: number } | null;
  } | null;
}

// ===========================================================================
// Subscription Status
// ===========================================================================

/**
 * Get the full subscription status for a user.
 *
 * This is the single source of truth — call this instead of checking
 * individual fields on UserRow. It handles trial expiry detection and
 * lazy downgrade in one shot.
 *
 * If the trial has expired, this function writes the downgrade to D1
 * so subsequent checks are fast. The `justDowngraded` flag tells the
 * caller to show a "your trial ended" message.
 *
 * @param db   - D1 database binding
 * @param user - The user to check
 * @param now  - Override current time (for testing)
 */
export async function checkSubscriptionStatus(
  db: D1Database,
  user: UserRow,
  now?: Date,
): Promise<SubscriptionStatus> {
  const currentTime = now ?? new Date();

  // Premium users — nothing to calculate
  if (user.subscription_tier === 'premium') {
    return {
      tier: 'premium',
      isPremium: true,
      isTrialActive: false,
      hadTrial: user.trial_ends_at !== null,
      daysUntilTrialExpires: null,
      justDowngraded: false,
    };
  }

  // Already on free tier — check if they ever had a trial
  if (user.subscription_tier === 'free') {
    return {
      tier: 'free',
      isPremium: false,
      isTrialActive: false,
      hadTrial: user.trial_ends_at !== null,
      daysUntilTrialExpires: null,
      justDowngraded: false,
    };
  }

  // Trial tier — check if still active
  if (user.subscription_tier === 'trial') {
    if (!user.trial_ends_at) {
      // Trial tier but no end date — data inconsistency, treat as free
      await downgradeToFree(db, user.id);
      return {
        tier: 'free',
        isPremium: false,
        isTrialActive: false,
        hadTrial: false,
        daysUntilTrialExpires: null,
        justDowngraded: true,
      };
    }

    const trialEnd = new Date(user.trial_ends_at);
    const msRemaining = trialEnd.getTime() - currentTime.getTime();

    if (msRemaining > 0) {
      // Trial still active
      const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
      return {
        tier: 'trial',
        isPremium: false,
        isTrialActive: true,
        hadTrial: true,
        daysUntilTrialExpires: daysRemaining,
        justDowngraded: false,
      };
    }

    // Trial expired — lazy downgrade
    await downgradeToFree(db, user.id);
    return {
      tier: 'free',
      isPremium: false,
      isTrialActive: false,
      hadTrial: true,
      daysUntilTrialExpires: null,
      justDowngraded: true,
    };
  }

  // Unknown tier — defensive fallback
  return {
    tier: 'free',
    isPremium: false,
    isTrialActive: false,
    hadTrial: user.trial_ends_at !== null,
    daysUntilTrialExpires: null,
    justDowngraded: false,
  };
}

// ===========================================================================
// Usage Limit Checks
// ===========================================================================

/**
 * Check whether a user can perform a metered operation.
 *
 * Premium and active trial users are always permitted (no limits).
 * Free tier users are checked against FREE_TIER_LIMITS.
 *
 * For contacts_added, this checks the total contact count in the DB,
 * not the daily counter — because the free limit on contacts is a
 * total cap, not a daily one.
 *
 * @param db     - D1 database binding
 * @param userId - The user's ID
 * @param metric - Which usage counter to check
 * @param tier   - Pre-resolved tier (pass this if you already called checkSubscriptionStatus)
 * @param now    - Override current time (for testing)
 */
export async function checkUsageLimit(
  db: D1Database,
  userId: string,
  metric: UsageMetric,
  tier?: 'premium' | 'trial' | 'free',
  now?: Date,
): Promise<UsageLimitResult> {
  // Premium and trial users have no limits
  const effectiveTier = tier ?? 'free';
  if (effectiveTier === 'premium' || effectiveTier === 'trial') {
    return {
      permitted: true,
      currentUsage: 0,
      limit: Infinity,
      remaining: Infinity,
      reason: null,
    };
  }

  // Contact limit is a total cap, not daily
  if (metric === 'contacts_added') {
    return checkContactLimit(db, userId);
  }

  // Daily usage check for free tier
  const today = getDateString(now);
  const usage = await getOrCreateDailyUsage(db, userId, today);
  const currentValue = usage[metric] as number;
  const limit = METRIC_TO_LIMIT[metric];
  const remaining = Math.max(0, limit - currentValue);

  if (currentValue >= limit) {
    const label = METRIC_LABELS[metric];
    return {
      permitted: false,
      currentUsage: currentValue,
      limit,
      remaining: 0,
      reason: `You've hit your daily limit of ${limit} ${label} on the free plan. Upgrade to premium for unlimited access, or check back tomorrow!`,
    };
  }

  return {
    permitted: true,
    currentUsage: currentValue,
    limit,
    remaining,
    reason: null,
  };
}

/**
 * Check the total contact count against the free tier cap.
 * This is separate from daily usage because it's a lifetime limit.
 */
async function checkContactLimit(
  db: D1Database,
  userId: string,
): Promise<UsageLimitResult> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM contacts
       WHERE user_id = ? AND archived = 0`
    )
    .bind(userId)
    .first<{ count: number }>();

  const currentCount = result?.count ?? 0;
  const limit = FREE_TIER_LIMITS.max_contacts;
  const remaining = Math.max(0, limit - currentCount);

  if (currentCount >= limit) {
    return {
      permitted: false,
      currentUsage: currentCount,
      limit,
      remaining: 0,
      reason: `You've reached the free plan limit of ${limit} contacts. Upgrade to premium for unlimited contacts, or archive some existing ones to make room.`,
    };
  }

  return {
    permitted: true,
    currentUsage: currentCount,
    limit,
    remaining,
    reason: null,
  };
}

// ===========================================================================
// Usage Incrementing
// ===========================================================================

/**
 * Increment a usage counter for today.
 *
 * Uses INSERT ... ON CONFLICT UPDATE (upsert) to atomically create or
 * increment the daily row. This is safe for concurrent calls.
 *
 * Call this AFTER the operation succeeds, not before.
 *
 * @param db     - D1 database binding
 * @param userId - The user's ID
 * @param metric - Which counter to increment
 * @param count  - How much to increment by (default 1)
 * @param now    - Override current time (for testing)
 */
export async function incrementUsage(
  db: D1Database,
  userId: string,
  metric: UsageMetric,
  count: number = 1,
  now?: Date,
): Promise<void> {
  const today = getDateString(now);
  const id = crypto.randomUUID();

  // Upsert: create today's row if it doesn't exist, then increment
  await db
    .prepare(
      `INSERT INTO usage_tracking (id, user_id, date, ${metric})
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, date)
       DO UPDATE SET ${metric} = ${metric} + ?`
    )
    .bind(id, userId, today, count, count)
    .run();
}

// ===========================================================================
// Daily Usage Summary
// ===========================================================================

/**
 * Get today's usage summary for a user.
 *
 * Returns raw counters plus limit info for free tier users.
 * Premium/trial users get null limits (unlimited).
 *
 * @param db     - D1 database binding
 * @param userId - The user's ID
 * @param tier   - Pre-resolved tier
 * @param now    - Override current time (for testing)
 */
export async function getDailyUsageSummary(
  db: D1Database,
  userId: string,
  tier: 'premium' | 'trial' | 'free',
  now?: Date,
): Promise<DailyUsageSummary> {
  const today = getDateString(now);
  const usage = await getOrCreateDailyUsage(db, userId, today);

  const summary: DailyUsageSummary = {
    date: today,
    messagesSent: usage.messages_sent,
    nudgesGenerated: usage.nudges_generated,
    contactsAdded: usage.contacts_added,
    braindumpsProcessed: usage.braindumps_processed,
    limits: null,
  };

  if (tier === 'free') {
    // Also fetch total contact count for the contact limit
    const contactResult = await db
      .prepare(
        `SELECT COUNT(*) as count FROM contacts
         WHERE user_id = ? AND archived = 0`
      )
      .bind(userId)
      .first<{ count: number }>();

    const totalContacts = contactResult?.count ?? 0;

    summary.limits = {
      messages: {
        used: usage.messages_sent,
        max: FREE_TIER_LIMITS.max_messages_per_day,
        remaining: Math.max(0, FREE_TIER_LIMITS.max_messages_per_day - usage.messages_sent),
      },
      nudges: {
        used: usage.nudges_generated,
        max: FREE_TIER_LIMITS.max_nudges_per_day,
        remaining: Math.max(0, FREE_TIER_LIMITS.max_nudges_per_day - usage.nudges_generated),
      },
      braindumps: {
        used: usage.braindumps_processed,
        max: FREE_TIER_LIMITS.max_braindumps_per_day,
        remaining: Math.max(0, FREE_TIER_LIMITS.max_braindumps_per_day - usage.braindumps_processed),
      },
      contacts: {
        used: totalContacts,
        max: FREE_TIER_LIMITS.max_contacts,
        remaining: Math.max(0, FREE_TIER_LIMITS.max_contacts - totalContacts),
      },
    };
  }

  return summary;
}

// ===========================================================================
// Daily Usage Reset (Cron)
// ===========================================================================

/**
 * No explicit reset needed — the daily row pattern handles this naturally.
 *
 * Each day gets a new row via the UNIQUE(user_id, date) constraint.
 * Old rows are kept for analytics. If storage becomes a concern,
 * a cleanup cron can purge rows older than 90 days:
 *
 *   DELETE FROM usage_tracking WHERE date < date('now', '-90 days')
 *
 * This function exists for explicit cleanup if desired.
 *
 * @param db       - D1 database binding
 * @param olderThanDays - Purge rows older than this many days (default 90)
 */
export async function purgeOldUsageData(
  db: D1Database,
  olderThanDays: number = 90,
): Promise<{ rowsDeleted: number }> {
  const result = await db
    .prepare(
      `DELETE FROM usage_tracking
       WHERE date < date('now', '-' || ? || ' days')`
    )
    .bind(olderThanDays)
    .run();

  return { rowsDeleted: result.meta.changes ?? 0 };
}

// ===========================================================================
// Trial Management
// ===========================================================================

/**
 * Initialize a trial for a new user.
 * Called during web signup when converting a PendingSignup to a User.
 *
 * @param db     - D1 database binding
 * @param userId - The user's ID
 * @param now    - Override current time (for testing)
 */
export async function initializeTrial(
  db: D1Database,
  userId: string,
  now?: Date,
): Promise<{ trialEndsAt: string }> {
  const currentTime = now ?? new Date();
  const trialEnd = new Date(currentTime);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DURATION_DAYS);
  const trialEndsAt = trialEnd.toISOString();

  await db
    .prepare(
      `UPDATE users
       SET subscription_tier = 'trial',
           trial_ends_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(trialEndsAt, userId)
    .run();

  return { trialEndsAt };
}

/**
 * Upgrade a user to premium.
 * Called after successful Stripe checkout.
 *
 * @param db               - D1 database binding
 * @param userId           - The user's ID
 * @param stripeCustomerId - Stripe customer ID for future billing operations
 */
export async function upgradeToPremium(
  db: D1Database,
  userId: string,
  stripeCustomerId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET subscription_tier = 'premium',
           stripe_customer_id = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(stripeCustomerId, userId)
    .run();
}

/**
 * Downgrade a user to free tier.
 * Called on trial expiry or Stripe subscription cancellation.
 *
 * Preserves trial_ends_at so we know they've had a trial.
 * Does NOT clear stripe_customer_id — they might resubscribe.
 */
export async function downgradeToFree(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET subscription_tier = 'free',
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(userId)
    .run();
}

/**
 * Batch check for expired trials and downgrade them.
 * Designed for a daily cron job — catches any users whose trial expired
 * but haven't made a request (so lazy downgrade hasn't fired).
 *
 * @param db  - D1 database binding
 * @param now - Override current time (for testing)
 * @returns Number of users downgraded
 */
export async function processExpiredTrials(
  db: D1Database,
  now?: Date,
): Promise<{ downgraded: number }> {
  const currentTime = (now ?? new Date()).toISOString();

  const result = await db
    .prepare(
      `UPDATE users
       SET subscription_tier = 'free',
           updated_at = datetime('now')
       WHERE subscription_tier = 'trial'
         AND trial_ends_at IS NOT NULL
         AND trial_ends_at < ?`
    )
    .bind(currentTime)
    .run();

  return { downgraded: result.meta.changes ?? 0 };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Get or create today's usage tracking row for a user.
 * Returns the row with all counters (defaulting to 0 for new rows).
 */
async function getOrCreateDailyUsage(
  db: D1Database,
  userId: string,
  date: string,
): Promise<UsageTrackingRow> {
  // Try to fetch existing row
  const existing = await db
    .prepare(
      `SELECT * FROM usage_tracking
       WHERE user_id = ? AND date = ?`
    )
    .bind(userId, date)
    .first<UsageTrackingRow>();

  if (existing) {
    return existing;
  }

  // Create new row with zero counters
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO usage_tracking (id, user_id, date, messages_sent, nudges_generated, contacts_added, braindumps_processed)
       VALUES (?, ?, ?, 0, 0, 0, 0)`
    )
    .bind(id, userId, date)
    .run();

  return {
    id,
    user_id: userId,
    date,
    messages_sent: 0,
    nudges_generated: 0,
    contacts_added: 0,
    braindumps_processed: 0,
    created_at: new Date().toISOString(),
  };
}

/**
 * Get a YYYY-MM-DD date string for a given time.
 * Uses UTC to avoid timezone issues in Workers.
 */
function getDateString(now?: Date): string {
  const d = now ?? new Date();
  return d.toISOString().split('T')[0];
}
