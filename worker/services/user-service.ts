/**
 * User Service — D1 lookup, creation, and update operations.
 *
 * All user queries are scoped by phone number (the primary identifier
 * for SMS-first users). Email is added later during web signup.
 */

import type { UserRow } from '../../shared/models';

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export interface UserLookupResult {
  found: true;
  user: UserRow;
} | {
  found: false;
  user: null;
}

/**
 * Look up a user by phone number.
 * This is the hot path — called on every inbound SMS.
 */
export async function getUserByPhone(
  db: D1Database,
  phone: string,
): Promise<UserLookupResult> {
  const row = await db
    .prepare('SELECT * FROM users WHERE phone = ?')
    .bind(phone)
    .first<UserRow>();

  if (row) {
    return { found: true, user: row };
  }
  return { found: false, user: null };
}

/**
 * Look up a user by ID.
 */
export async function getUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();
}

// ---------------------------------------------------------------------------
// Pending Signup Check
// ---------------------------------------------------------------------------

/**
 * Check if there's an active (pending, non-expired) signup token for a phone.
 * Used to determine if we should resume onboarding or start fresh.
 */
export async function getActivePendingSignup(
  db: D1Database,
  phone: string,
): Promise<{ id: string; token: string; name: string | null; circles_discussed: string; stage?: string } | null> {
  const row = await db
    .prepare(
      `SELECT id, token, name, circles_discussed
       FROM pending_signups
       WHERE phone = ? AND status = 'pending' AND expires_at > datetime('now')
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(phone)
    .first();

  return row as any ?? null;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Touch the updated_at timestamp on a user.
 * Called after meaningful interactions.
 */
export async function touchUser(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(`UPDATE users SET updated_at = datetime('now') WHERE id = ?`)
    .bind(userId)
    .run();
}

/**
 * Check if a user's account is locked.
 */
export function isAccountLocked(user: UserRow): boolean {
  return user.account_locked === 1;
}

/**
 * Check if a user's trial is still active.
 */
export function isTrialActive(user: UserRow): boolean {
  if (user.subscription_tier !== 'trial' || !user.trial_ends_at) {
    return false;
  }
  return new Date(user.trial_ends_at) > new Date();
}

/**
 * Get the effective subscription status.
 */
export function getSubscriptionStatus(user: UserRow): 'premium' | 'trial' | 'free' {
  if (user.subscription_tier === 'premium') return 'premium';
  if (user.subscription_tier === 'trial' && isTrialActive(user)) return 'trial';
  return 'free';
}
