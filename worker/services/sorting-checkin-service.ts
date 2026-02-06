/**
 * Sorting Check-in Service — Weekly proactive sorting offers.
 *
 * This service implements the "sorting check-in" feature: a weekly
 * scheduled message that prompts users to sort contacts that are still
 * in the 'new' intent bucket or missing clear goals.
 *
 * How it works:
 *
 *   1. Weekly cron (Monday, after nudges) calls generateSortingCheckins()
 *   2. For each user, we count:
 *      - Contacts with intent='new' (unsorted)
 *      - Contacts with intent='new' that have no notes (no context)
 *   3. If counts > 0 and user hasn't been offered this week, send check-in
 *   4. Check-in offers choice: sort via SMS or use web dashboard
 *   5. Update last_sorting_offer to prevent spam
 *
 * Tier limits:
 *
 *   - Free users: Can only sort up to 5 contacts per week via SMS
 *   - Premium/trial: Unlimited sorting
 *
 * The sorting flow itself is handled by IntentSortingDO when the user
 * chooses to sort via SMS. This service only handles the proactive offer.
 *
 * @see worker/cron/scheduled.ts for weeklySortingCheckin() job
 * @see shared/models.ts for IntentType, UserRow, FREE_TIER_LIMITS
 */

import type { Env } from '../../shared/types';
import type { SubscriptionTier } from '../../shared/models';
import { FREE_TIER_LIMITS } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** Minimum days between sorting offers (prevents spam) */
const SORTING_OFFER_COOLDOWN_DAYS = 6;

/** Dashboard URL template for sorting */
const DASHBOARD_SORT_URL = 'https://app.untitledpublishers.com/sort';

// ===========================================================================
// Types
// ===========================================================================

/**
 * User eligible for a sorting check-in.
 */
export interface SortingCheckinCandidate {
  userId: string;
  phone: string;
  name: string;
  tier: SubscriptionTier;
  unsortedCount: number;
  noIntentCount: number;
  lastOffer: string | null;
}

/**
 * Result of generating sorting check-ins.
 */
export interface SortingCheckinResult {
  usersChecked: number;
  checkInsSent: number;
  skippedNoContacts: number;
  skippedCooldown: number;
  errors: number;
}

// ===========================================================================
// Main Generation Function
// ===========================================================================

/**
 * Generate and send sorting check-in messages for all eligible users.
 *
 * Called by the weekly cron job. For each user:
 *   1. Check if they have unsorted contacts
 *   2. Check if they're within cooldown period
 *   3. Send personalized check-in message
 *   4. Update last_sorting_offer timestamp
 *
 * @param db  - D1 database binding
 * @param env - Worker environment with SendBlue credentials
 * @param now - Override current time (for testing)
 */
export async function generateSortingCheckins(
  db: D1Database,
  env: Env,
  now?: Date,
): Promise<SortingCheckinResult> {
  const currentTime = now ?? new Date();
  const cooldownCutoff = new Date(
    currentTime.getTime() - SORTING_OFFER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000
  );

  const result: SortingCheckinResult = {
    usersChecked: 0,
    checkInsSent: 0,
    skippedNoContacts: 0,
    skippedCooldown: 0,
    errors: 0,
  };

  // Get users with unsorted contacts who haven't been offered recently
  const candidates = await getSortingCandidates(db, cooldownCutoff);
  result.usersChecked = candidates.length;

  for (const candidate of candidates) {
    // Skip if in cooldown
    if (candidate.lastOffer && new Date(candidate.lastOffer) > cooldownCutoff) {
      result.skippedCooldown++;
      continue;
    }

    // Skip if no unsorted contacts
    if (candidate.unsortedCount === 0 && candidate.noIntentCount === 0) {
      result.skippedNoContacts++;
      continue;
    }

    try {
      await sendSortingCheckin(env, candidate);
      await updateLastSortingOffer(db, candidate.userId, currentTime);
      result.checkInsSent++;
    } catch (err) {
      console.error(`[sorting:checkin] Failed for user ${candidate.userId}:`, err);
      result.errors++;
    }
  }

  return result;
}

// ===========================================================================
// Candidate Discovery
// ===========================================================================

/**
 * Find users who are candidates for a sorting check-in.
 *
 * Returns users who:
 *   - Have at least one contact with intent='new' (unsorted)
 *   - OR have contacts without a clear intent assignment
 *   - Have completed onboarding (onboarding_stage IS NULL or 'ready')
 *   - Haven't been offered in the last SORTING_OFFER_COOLDOWN_DAYS
 */
async function getSortingCandidates(
  db: D1Database,
  cooldownCutoff: Date,
): Promise<SortingCheckinCandidate[]> {
  const { results } = await db
    .prepare(
      `SELECT 
         u.id as userId,
         u.phone,
         u.name,
         u.subscription_tier as tier,
         u.last_sorting_offer as lastOffer,
         COUNT(CASE WHEN c.intent = 'new' THEN 1 END) as unsortedCount,
         COUNT(CASE WHEN c.intent = 'new' AND (c.notes IS NULL OR c.notes = '') THEN 1 END) as noIntentCount
       FROM users u
       LEFT JOIN contacts c ON u.id = c.user_id AND c.archived = 0
       WHERE (u.onboarding_stage IS NULL OR u.onboarding_stage = 'ready')
         AND (u.last_sorting_offer IS NULL OR u.last_sorting_offer < ?)
       GROUP BY u.id
       HAVING unsortedCount > 0 OR noIntentCount > 0`
    )
    .bind(cooldownCutoff.toISOString())
    .all<{
      userId: string;
      phone: string;
      name: string;
      tier: SubscriptionTier;
      lastOffer: string | null;
      unsortedCount: number;
      noIntentCount: number;
    }>();

  return results.map((row) => ({
    userId: row.userId,
    phone: row.phone,
    name: row.name,
    tier: row.tier,
    unsortedCount: row.unsortedCount,
    noIntentCount: row.noIntentCount,
    lastOffer: row.lastOffer,
  }));
}

// ===========================================================================
// Message Generation & Sending
// ===========================================================================

/**
 * Generate and send a sorting check-in message.
 */
async function sendSortingCheckin(
  env: Env,
  candidate: SortingCheckinCandidate,
): Promise<void> {
  const message = generateSortingMessage(candidate);

  const response = await fetch('https://api.sendblue.co/api/send-message', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'sb-api-key-id': env.SENDBLUE_API_KEY,
      'sb-api-secret-key': env.SENDBLUE_API_SECRET,
    },
    body: JSON.stringify({
      number: candidate.phone,
      content: message,
      send_style: 'invisible',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`SendBlue error: ${error}`);
  }
}

/**
 * Generate personalized sorting check-in message.
 */
function generateSortingMessage(candidate: SortingCheckinCandidate): string {
  const { name, unsortedCount, noIntentCount, tier } = candidate;
  const firstName = name.split(' ')[0];
  const weeklyLimit = FREE_TIER_LIMITS.max_sorting_per_week;

  // Determine what to highlight
  const totalNeedingSorting = unsortedCount + noIntentCount;
  const contactWord = totalNeedingSorting === 1 ? 'contact' : 'contacts';

  // Build the message based on counts
  let intro: string;
  if (unsortedCount > 0 && noIntentCount > 0) {
    intro = `Hey ${firstName}! You've got ${unsortedCount} ${contactWord} I haven't placed yet, and ${noIntentCount} without a clear goal.`;
  } else if (unsortedCount > 0) {
    intro = `Hey ${firstName}! You've got ${unsortedCount} ${contactWord} I haven't sorted yet.`;
  } else {
    intro = `Hey ${firstName}! I noticed ${noIntentCount} of your contacts could use a clearer relationship goal.`;
  }

  // Add tier-specific limit note for free users
  let limitNote = '';
  if (tier === 'free') {
    limitNote = `\n\n(On the free plan, you can sort up to ${weeklyLimit} contacts per week via text.)`;
  }

  // Call to action with both options
  const cta = `\n\nWant to sort through a few? You can do it here via text, or head to your dashboard: ${DASHBOARD_SORT_URL}`;

  return intro + cta + limitNote;
}

// ===========================================================================
// Database Updates
// ===========================================================================

/**
 * Update the last_sorting_offer timestamp for a user.
 */
async function updateLastSortingOffer(
  db: D1Database,
  userId: string,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET last_sorting_offer = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(now.toISOString(), userId)
    .run();
}

// ===========================================================================
// Utility Functions
// ===========================================================================

/**
 * Get the count of unsorted contacts for a specific user.
 * Used by conversation handlers to show current state.
 */
export async function getUnsortedContactCount(
  db: D1Database,
  userId: string,
): Promise<{ unsorted: number; noIntent: number }> {
  const result = await db
    .prepare(
      `SELECT 
         COUNT(CASE WHEN intent = 'new' THEN 1 END) as unsorted,
         COUNT(CASE WHEN intent = 'new' AND (notes IS NULL OR notes = '') THEN 1 END) as noIntent
       FROM contacts
       WHERE user_id = ? AND archived = 0`
    )
    .bind(userId)
    .first<{ unsorted: number; noIntent: number }>();

  return {
    unsorted: result?.unsorted ?? 0,
    noIntent: result?.noIntent ?? 0,
  };
}

/**
 * Get the weekly sorting limit for a user based on their tier.
 * Free users: limited per week (see FREE_TIER_LIMITS)
 * Premium/Trial: Unlimited
 */
export function getWeeklySortingLimit(tier: SubscriptionTier): number {
  return tier === 'free' ? FREE_TIER_LIMITS.max_sorting_per_week : Infinity;
}

/**
 * Check if a user can sort more contacts this week.
 * Tracks sorts via a usage counter pattern similar to other limits.
 */
export async function canSortMoreContacts(
  db: D1Database,
  userId: string,
  tier: SubscriptionTier,
  now?: Date,
): Promise<{ canSort: boolean; remaining: number; limit: number }> {
  if (tier === 'premium' || tier === 'trial') {
    return { canSort: true, remaining: Infinity, limit: Infinity };
  }

  const currentTime = now ?? new Date();
  const weekStart = getWeekStart(currentTime);
  const weeklyLimit = FREE_TIER_LIMITS.max_sorting_per_week;

  // Count how many contacts were sorted this week
  // We'll track this by looking at contacts that transitioned from 'new'
  // to another intent within the current week
  const result = await db
    .prepare(
      `SELECT COUNT(*) as count
       FROM contacts
       WHERE user_id = ?
         AND intent != 'new'
         AND updated_at >= ?
         AND source = 'sms_sort'`
    )
    .bind(userId, weekStart.toISOString())
    .first<{ count: number }>();

  const sorted = result?.count ?? 0;
  const remaining = Math.max(0, weeklyLimit - sorted);

  return {
    canSort: remaining > 0,
    remaining,
    limit: weeklyLimit,
  };
}

/**
 * Get the start of the current week (Monday 00:00:00 UTC).
 */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Monday
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
