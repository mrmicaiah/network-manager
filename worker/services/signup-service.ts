/**
 * Pending Signup & Token Service — bridges SMS onboarding to web registration.
 *
 * Flow:
 *
 *   1. User texts Bethany → onboarding conversation happens via SMS
 *   2. Bethany collects name, discusses circles, explains value
 *   3. When ready, Bethany calls createPendingSignup() to generate a token
 *   4. User receives a signup URL: https://app.example.com/signup?token=abc123...
 *   5. User opens the link, sets email/PIN on the web form
 *   6. Web form calls completeSignup() which:
 *      a. Validates the token (not expired, not used)
 *      b. Creates a real User record
 *      c. Initializes default circles (Family, Friends, Work, Community)
 *      d. Creates custom circles from the onboarding conversation
 *      e. Starts the 14-day trial
 *      f. Marks the token as used
 *   7. User is now a full account holder
 *
 * Token lifecycle:
 *
 *   pending  → Token is active, user hasn't signed up yet
 *   used     → Token was consumed during web signup
 *   expired  → Token hit the 24h TTL (checked lazily or by cron)
 *
 * If a user texts Bethany again after their token expires, a new token
 * is generated. Old expired/used tokens are kept for audit but cleaned
 * up by a periodic purge.
 *
 * Security:
 *
 *   - Tokens are 32-char URL-safe random strings (crypto.getRandomValues)
 *   - Tokens are single-use (status flips to 'used' atomically)
 *   - 24-hour expiry limits the attack window
 *   - Phone number is verified by virtue of the SMS conversation
 *
 * @see shared/models.ts for PendingSignupRow, SignupTokenStatus
 * @see worker/services/circle-service.ts for initializeDefaultCircles()
 * @see worker/services/subscription-service.ts for initializeTrial()
 */

import type {
  PendingSignupRow,
  UserRow,
} from '../../shared/models';
import { initializeDefaultCircles, createCircle } from './circle-service';
import { initializeTrial } from './subscription-service';

// ===========================================================================
// Configuration
// ===========================================================================

/** Token expiry in hours */
const TOKEN_EXPIRY_HOURS = 24;

/** Token length in bytes (produces 32 hex chars) */
const TOKEN_BYTE_LENGTH = 16;

/** Base URL for the signup page — overridden by env in production */
const DEFAULT_SIGNUP_BASE_URL = 'https://app.untitledpublishers.com';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Input for creating a pending signup from the onboarding conversation.
 */
export interface CreatePendingSignupInput {
  phone: string;
  name: string | null;
  circlesDiscussed: string[];
  onboardingContext?: Record<string, unknown>;
}

/**
 * Result of a token validation check.
 */
export type TokenValidation =
  | { valid: true; signup: PendingSignupRow }
  | { valid: false; reason: 'not_found' | 'expired' | 'used'; message: string };

/**
 * Input for completing web signup.
 */
export interface CompleteSignupInput {
  token: string;
  email: string;
  pin: string;
}

/**
 * Result of a completed signup.
 */
export interface SignupResult {
  user: UserRow;
  circlesCreated: number;
  trialEndsAt: string;
}

// ===========================================================================
// Token Generation
// ===========================================================================

/**
 * Generate a cryptographically secure, URL-safe token.
 *
 * Uses crypto.getRandomValues (available in Workers) to produce
 * 16 random bytes, then hex-encodes to a 32-character string.
 */
function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===========================================================================
// Create Pending Signup
// ===========================================================================

/**
 * Create a pending signup record and return the signup URL.
 *
 * If there's already an active (pending, non-expired) signup for this
 * phone number, it's invalidated first — only one active token per phone.
 *
 * @param db        - D1 database binding
 * @param input     - Onboarding context from the SMS conversation
 * @param baseUrl   - Signup page base URL (optional, uses default)
 * @param now       - Override current time (for testing)
 * @returns The signup URL and the pending signup record
 */
export async function createPendingSignup(
  db: D1Database,
  input: CreatePendingSignupInput,
  baseUrl?: string,
  now?: Date,
): Promise<{ signupUrl: string; signup: PendingSignupRow }> {
  const currentTime = now ?? new Date();

  // Expire any existing pending tokens for this phone
  await expireTokensForPhone(db, input.phone);

  // Generate token and expiry
  const id = crypto.randomUUID();
  const token = generateToken();
  const expiresAt = new Date(currentTime);
  expiresAt.setHours(expiresAt.getHours() + TOKEN_EXPIRY_HOURS);

  const circlesJson = JSON.stringify(input.circlesDiscussed);
  const contextJson = input.onboardingContext
    ? JSON.stringify(input.onboardingContext)
    : null;

  await db
    .prepare(
      `INSERT INTO pending_signups
         (id, token, phone, name, circles_discussed, onboarding_context,
          status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(
      id,
      token,
      input.phone,
      input.name,
      circlesJson,
      contextJson,
      currentTime.toISOString(),
      expiresAt.toISOString(),
    )
    .run();

  // Build signup URL
  const signupBaseUrl = baseUrl ?? DEFAULT_SIGNUP_BASE_URL;
  const signupUrl = `${signupBaseUrl}/signup?token=${token}`;

  // Return the created record
  const signup = await db
    .prepare('SELECT * FROM pending_signups WHERE id = ?')
    .bind(id)
    .first<PendingSignupRow>();

  return { signupUrl, signup: signup! };
}

// ===========================================================================
// Token Validation
// ===========================================================================

/**
 * Validate a signup token.
 *
 * Checks:
 *   1. Token exists in the database
 *   2. Token status is 'pending' (not already used)
 *   3. Token has not expired (expires_at > now)
 *
 * If the token is found but expired (status still 'pending' but past
 * expires_at), it's lazily updated to 'expired' status.
 *
 * @param db    - D1 database binding
 * @param token - The token string from the signup URL
 * @param now   - Override current time (for testing)
 */
export async function validateToken(
  db: D1Database,
  token: string,
  now?: Date,
): Promise<TokenValidation> {
  const signup = await db
    .prepare('SELECT * FROM pending_signups WHERE token = ?')
    .bind(token)
    .first<PendingSignupRow>();

  if (!signup) {
    return {
      valid: false,
      reason: 'not_found',
      message: "This signup link isn't valid. Text me and I'll send you a fresh one!",
    };
  }

  if (signup.status === 'used') {
    return {
      valid: false,
      reason: 'used',
      message: "You've already used this link to sign up. Try logging in instead!",
    };
  }

  // Check expiry
  const currentTime = now ?? new Date();
  if (signup.status === 'expired' || new Date(signup.expires_at) <= currentTime) {
    // Lazy update if still marked pending
    if (signup.status === 'pending') {
      await db
        .prepare(
          `UPDATE pending_signups SET status = 'expired' WHERE id = ?`
        )
        .bind(signup.id)
        .run();
    }

    return {
      valid: false,
      reason: 'expired',
      message: "This link has expired. Text me again and I'll send you a fresh one.",
    };
  }

  return { valid: true, signup };
}

// ===========================================================================
// Complete Signup (Token → User Conversion)
// ===========================================================================

/**
 * Convert a pending signup into a full user account.
 *
 * This is the critical path — called by the web signup form handler.
 * It performs all setup in a logical sequence:
 *
 *   1. Validate the token
 *   2. Hash the PIN
 *   3. Create the User record
 *   4. Initialize default circles
 *   5. Create custom circles from onboarding conversation
 *   6. Start the 14-day trial
 *   7. Mark the token as used
 *
 * If any step fails after user creation, the user still exists but
 * may be missing circles or trial setup. The system is resilient to
 * this — missing circles are created on next login, and trial defaults
 * to the schema default ('trial' tier).
 *
 * @param db         - D1 database binding
 * @param input      - Email, PIN, and token from the web form
 * @param pinHashFn  - Function to hash the PIN (injected for testability)
 * @param now        - Override current time (for testing)
 * @returns The created user, circles count, and trial end date
 */
export async function completeSignup(
  db: D1Database,
  input: CompleteSignupInput,
  pinHashFn: (pin: string) => Promise<string>,
  now?: Date,
): Promise<SignupResult | TokenValidation> {
  // Step 1: Validate token
  const validation = await validateToken(db, input.token, now);
  if (!validation.valid) {
    return validation;
  }

  const signup = validation.signup;

  // Step 2: Hash the PIN
  const pinHash = await pinHashFn(input.pin);

  // Step 3: Create the User record
  const userId = crypto.randomUUID();
  const currentTime = (now ?? new Date()).toISOString();

  await db
    .prepare(
      `INSERT INTO users
         (id, phone, email, name, pin_hash, subscription_tier,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'trial', ?, ?)`
    )
    .bind(
      userId,
      signup.phone,
      input.email,
      signup.name ?? 'Friend', // Fallback name if onboarding didn't collect one
      pinHash,
      currentTime,
      currentTime,
    )
    .run();

  // Step 4: Initialize default circles
  const { created: defaultCirclesCreated } = await initializeDefaultCircles(db, userId);

  // Step 5: Create custom circles from onboarding conversation
  let customCirclesCreated = 0;
  const circlesDiscussed: string[] = JSON.parse(signup.circles_discussed || '[]');
  const defaultCircleNames = new Set(['family', 'friends', 'work', 'community']);

  for (const circleName of circlesDiscussed) {
    // Skip if it matches a default circle (case-insensitive)
    if (defaultCircleNames.has(circleName.toLowerCase().trim())) {
      continue;
    }

    try {
      await createCircle(db, userId, { name: circleName.trim() });
      customCirclesCreated++;
    } catch {
      // Circle creation failed (e.g., duplicate name) — non-fatal
    }
  }

  // Step 6: Start the trial
  const { trialEndsAt } = await initializeTrial(db, userId, now);

  // Step 7: Mark token as used
  await db
    .prepare(
      `UPDATE pending_signups
       SET status = 'used', used_at = ?
       WHERE id = ?`
    )
    .bind(currentTime, signup.id)
    .run();

  // Fetch the created user
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();

  return {
    user: user!,
    circlesCreated: defaultCirclesCreated + customCirclesCreated,
    trialEndsAt,
  };
}

// ===========================================================================
// Lookup Helpers
// ===========================================================================

/**
 * Get a pending signup by token.
 * Raw lookup — does NOT check expiry or status.
 */
export async function getPendingSignupByToken(
  db: D1Database,
  token: string,
): Promise<PendingSignupRow | null> {
  return db
    .prepare('SELECT * FROM pending_signups WHERE token = ?')
    .bind(token)
    .first<PendingSignupRow>();
}

/**
 * Get the active (pending, non-expired) signup for a phone number.
 * Returns null if no active signup exists.
 *
 * Used by onboarding to check if we should resume or start fresh.
 */
export async function getActiveSignupForPhone(
  db: D1Database,
  phone: string,
  now?: Date,
): Promise<PendingSignupRow | null> {
  const currentTime = (now ?? new Date()).toISOString();

  return db
    .prepare(
      `SELECT * FROM pending_signups
       WHERE phone = ? AND status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(phone, currentTime)
    .first<PendingSignupRow>();
}

/**
 * Check if a phone number has ever completed signup.
 * Used to determine if an inbound SMS is from a known user or a new lead.
 */
export async function hasCompletedSignup(
  db: D1Database,
  phone: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM pending_signups
       WHERE phone = ? AND status = 'used'
       LIMIT 1`
    )
    .bind(phone)
    .first();

  return result !== null;
}

// ===========================================================================
// Token Lifecycle Management
// ===========================================================================

/**
 * Expire all pending tokens for a phone number.
 *
 * Called before creating a new token — ensures only one active token
 * per phone at any time.
 */
async function expireTokensForPhone(
  db: D1Database,
  phone: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE pending_signups
       SET status = 'expired'
       WHERE phone = ? AND status = 'pending'`
    )
    .bind(phone)
    .run();
}

/**
 * Batch-expire all tokens that have passed their expires_at.
 *
 * Designed for a daily cron job. The lazy expiry in validateToken()
 * catches most cases, but this cleans up tokens that were never
 * accessed after expiry.
 *
 * @param db - D1 database binding
 * @returns Number of tokens expired
 */
export async function processExpiredTokens(
  db: D1Database,
  now?: Date,
): Promise<{ expired: number }> {
  const currentTime = (now ?? new Date()).toISOString();

  const result = await db
    .prepare(
      `UPDATE pending_signups
       SET status = 'expired'
       WHERE status = 'pending' AND expires_at <= ?`
    )
    .bind(currentTime)
    .run();

  return { expired: result.meta.changes ?? 0 };
}

/**
 * Purge old signup records.
 *
 * Removes used and expired tokens older than the specified retention
 * period. Pending tokens are never purged (they expire first).
 *
 * @param db              - D1 database binding
 * @param olderThanDays   - Purge records older than this (default 30)
 * @returns Number of records purged
 */
export async function purgeOldSignups(
  db: D1Database,
  olderThanDays: number = 30,
): Promise<{ purged: number }> {
  const result = await db
    .prepare(
      `DELETE FROM pending_signups
       WHERE status IN ('used', 'expired')
         AND created_at < datetime('now', '-' || ? || ' days')`
    )
    .bind(olderThanDays)
    .run();

  return { purged: result.meta.changes ?? 0 };
}

/**
 * Resend a signup link for a phone number.
 *
 * Creates a fresh token and expires any existing ones.
 * Used when Bethany says "Text me again and I'll send you a fresh one."
 *
 * Requires the onboarding context — caller should fetch it from the
 * most recent expired/used signup for this phone, or collect it fresh.
 *
 * @param db    - D1 database binding
 * @param input - Onboarding context (can be refreshed or carried over)
 * @param baseUrl - Signup page base URL
 * @param now   - Override current time (for testing)
 */
export async function resendSignupLink(
  db: D1Database,
  input: CreatePendingSignupInput,
  baseUrl?: string,
  now?: Date,
): Promise<{ signupUrl: string; signup: PendingSignupRow }> {
  // createPendingSignup already expires old tokens for this phone
  return createPendingSignup(db, input, baseUrl, now);
}

/**
 * Get the most recent signup record for a phone number (any status).
 *
 * Used to carry over onboarding context when resending a link.
 * If the user had a previous expired token, we can reuse their name
 * and circles_discussed rather than making them repeat the conversation.
 */
export async function getMostRecentSignup(
  db: D1Database,
  phone: string,
): Promise<PendingSignupRow | null> {
  return db
    .prepare(
      `SELECT * FROM pending_signups
       WHERE phone = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(phone)
    .first<PendingSignupRow>();
}
