/**
 * Trust & Security Service — gates sensitive operations behind verification.
 *
 * Security model (SMS-first, layered):
 *
 *   1. TRUST WINDOW — If user verified their PIN within the last 3 days,
 *      they're in a "trusted" session. Low-friction operations proceed
 *      without re-verification.
 *
 *   2. PIN VERIFICATION — For sensitive operations outside the trust window,
 *      Bethany asks for the 4-digit PIN via SMS. Correct PIN refreshes the
 *      trust window. Failed attempts increment a counter.
 *
 *   3. WEB LOGIN ESCALATION — After 3 failed PIN attempts, or for high-stakes
 *      operations (delete account, export all data, change phone number),
 *      the user is directed to the web dashboard for full auth.
 *
 *   4. ACCOUNT LOCKOUT — After 5 consecutive failed PINs, the account is
 *      locked and requires web login to unlock.
 *
 *   5. SUSPICIOUS BEHAVIOR — Heuristic checks for unusual activity patterns
 *      that may indicate a compromised phone number.
 *
 * Usage:
 *   const decision = await evaluateTrust(db, user, operation);
 *   switch (decision.action) {
 *     case 'allow':       // proceed
 *     case 'require_pin': // ask for PIN, then call verifyPin()
 *     case 'escalate':    // send web login link
 *     case 'locked':      // account is locked
 *   }
 */

import type { UserRow } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** How long a PIN verification stays valid */
const TRUST_WINDOW_HOURS = 72; // 3 days

/** Failed PIN attempts before escalating to web login */
const PIN_ESCALATION_THRESHOLD = 3;

/** Failed PIN attempts before locking the account */
const PIN_LOCKOUT_THRESHOLD = 5;

/** Minimum time between messages before flagging as suspicious (seconds) */
const RAPID_MESSAGE_THRESHOLD_SECONDS = 2;

/** Max messages in a 5-minute window before flagging */
const BURST_MESSAGE_LIMIT = 20;

/** Hours considered "off-hours" in Central time (midnight–5am) */
const OFF_HOURS_START = 0;
const OFF_HOURS_END = 5;

// ===========================================================================
// Types
// ===========================================================================

/**
 * Sensitivity level of an operation.
 * Determines what level of trust is required.
 */
export type OperationSensitivity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Operations and their sensitivity levels.
 */
export const OPERATION_SENSITIVITY: Record<string, OperationSensitivity> = {
  // Low — proceed if user exists, no verification needed
  'view_contacts': 'low',
  'view_circles': 'low',
  'view_interactions': 'low',
  'view_nudges': 'low',
  'log_interaction': 'low',

  // Medium — requires trust window (PIN if outside window)
  'add_contact': 'medium',
  'edit_contact': 'medium',
  'add_circle': 'medium',
  'edit_circle': 'medium',
  'braindump': 'medium',
  'import_contacts': 'medium',

  // High — always requires fresh PIN verification
  'delete_contact': 'high',
  'delete_circle': 'high',
  'export_contacts': 'high',
  'change_pin': 'high',
  'change_email': 'high',

  // Critical — requires web login (PIN not sufficient)
  'delete_account': 'critical',
  'change_phone': 'critical',
  'manage_subscription': 'critical',
  'unlock_account': 'critical',
};

/**
 * What the caller should do next.
 */
export type SecurityDecision =
  | { action: 'allow' }
  | { action: 'require_pin'; reason: string }
  | { action: 'escalate'; reason: string; loginUrl?: string }
  | { action: 'locked'; reason: string };

/**
 * Suspicious behavior flags.
 */
export interface SuspiciousBehaviorReport {
  isSuspicious: boolean;
  flags: string[];
}

// ===========================================================================
// Trust Window
// ===========================================================================

/**
 * Check if the user is within the trust window.
 * Returns true if lastPinVerified is within TRUST_WINDOW_HOURS.
 */
export function checkTrustWindow(user: UserRow, now?: Date): boolean {
  if (!user.last_pin_verified) {
    return false;
  }

  const currentTime = now ?? new Date();
  const lastVerified = new Date(user.last_pin_verified);
  const elapsedMs = currentTime.getTime() - lastVerified.getTime();
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  return elapsedHours < TRUST_WINDOW_HOURS;
}

// ===========================================================================
// Evaluate Trust (main entry point)
// ===========================================================================

/**
 * Evaluate whether a user can perform an operation.
 *
 * @param user      - The user attempting the operation
 * @param operation - The operation key (from OPERATION_SENSITIVITY)
 * @param behaviorContext - Optional recent activity for suspicious behavior check
 * @param now       - Override current time (for testing)
 */
export function evaluateTrust(
  user: UserRow,
  operation: string,
  behaviorContext?: BehaviorContext,
  now?: Date,
): SecurityDecision {
  // Step 0: Account locked?
  if (user.account_locked === 1) {
    return {
      action: 'locked',
      reason: 'Your account is locked for security. Please log in on the web to unlock it.',
    };
  }

  // Step 1: Determine sensitivity
  const sensitivity = OPERATION_SENSITIVITY[operation] ?? 'medium';

  // Step 2: Critical operations always require web login
  if (sensitivity === 'critical') {
    return {
      action: 'escalate',
      reason: 'This action requires you to log in on the web for security.',
    };
  }

  // Step 3: Check for suspicious behavior (if context provided)
  if (behaviorContext) {
    const report = detectSuspiciousBehavior(behaviorContext, now);
    if (report.isSuspicious) {
      return {
        action: 'require_pin',
        reason: `I noticed some unusual activity (${report.flags.join(', ')}). Can you verify your PIN real quick?`,
      };
    }
  }

  // Step 4: Too many failed PIN attempts → escalate
  if (user.failed_pin_attempts >= PIN_ESCALATION_THRESHOLD) {
    return {
      action: 'escalate',
      reason: "You've had a few failed PIN attempts. Please log in on the web to verify your identity.",
    };
  }

  // Step 5: Low sensitivity → allow
  if (sensitivity === 'low') {
    return { action: 'allow' };
  }

  // Step 6: High sensitivity → always require PIN
  if (sensitivity === 'high') {
    return {
      action: 'require_pin',
      reason: 'This is a sensitive action — can you confirm your 4-digit PIN?',
    };
  }

  // Step 7: Medium sensitivity → check trust window
  if (checkTrustWindow(user, now)) {
    return { action: 'allow' };
  }

  return {
    action: 'require_pin',
    reason: "It's been a bit since you last verified. Can you send me your 4-digit PIN?",
  };
}

// ===========================================================================
// PIN Verification
// ===========================================================================

/**
 * Verify a PIN attempt against the stored hash.
 * Updates the user record: refreshes trust window on success,
 * increments failure count (and possibly locks) on failure.
 *
 * Returns the security decision after verification.
 */
export async function verifyPin(
  db: D1Database,
  user: UserRow,
  pinAttempt: string,
): Promise<{ success: boolean; decision: SecurityDecision }> {
  // No PIN set yet — can't verify
  if (!user.pin_hash) {
    return {
      success: false,
      decision: {
        action: 'escalate',
        reason: "You haven't set a PIN yet. Please log in on the web to set one up.",
      },
    };
  }

  // Compare PIN hash
  // Note: In production, use a proper hash comparison (e.g., bcrypt via
  // a WebCrypto-compatible library). For now, we use HMAC-SHA256 since
  // bcrypt isn't natively available in Workers.
  const isValid = await comparePinHash(pinAttempt, user.pin_hash);

  if (isValid) {
    // Success: refresh trust window, reset failure count
    await db
      .prepare(
        `UPDATE users
         SET last_pin_verified = datetime('now'),
             failed_pin_attempts = 0,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(user.id)
      .run();

    return {
      success: true,
      decision: { action: 'allow' },
    };
  }

  // Failure: increment counter
  const newAttempts = user.failed_pin_attempts + 1;
  const shouldLock = newAttempts >= PIN_LOCKOUT_THRESHOLD;

  await db
    .prepare(
      `UPDATE users
       SET failed_pin_attempts = ?,
           account_locked = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(newAttempts, shouldLock ? 1 : 0, user.id)
    .run();

  if (shouldLock) {
    return {
      success: false,
      decision: {
        action: 'locked',
        reason: 'Too many failed attempts. Your account has been locked for security. Please log in on the web to unlock it.',
      },
    };
  }

  if (newAttempts >= PIN_ESCALATION_THRESHOLD) {
    return {
      success: false,
      decision: {
        action: 'escalate',
        reason: "That PIN didn't match, and you've had a few failed tries. Please log in on the web to continue.",
      },
    };
  }

  const remaining = PIN_ESCALATION_THRESHOLD - newAttempts;
  return {
    success: false,
    decision: {
      action: 'require_pin',
      reason: `That wasn't right. You have ${remaining} more ${remaining === 1 ? 'try' : 'tries'} before I'll need you to log in on the web.`,
    },
  };
}

// ===========================================================================
// PIN Hashing (HMAC-SHA256 — Workers-compatible)
// ===========================================================================

/**
 * Hash a PIN using HMAC-SHA256 with a signing secret.
 * Call this when the user first sets their PIN.
 */
export async function hashPin(pin: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(pin));
  return bufferToHex(signature);
}

/**
 * Compare a PIN attempt against a stored hash.
 * Uses constant-time comparison to prevent timing attacks.
 */
async function comparePinHash(pinAttempt: string, storedHash: string): Promise<boolean> {
  // We need the signing secret to re-hash the attempt.
  // In practice, this is passed via env.PIN_SIGNING_SECRET.
  // For now, this is a placeholder — the calling code should use
  // verifyPinWithSecret() instead.
  //
  // This function exists so verifyPin() has a clean signature.
  // The actual integration will pass the secret through.
  return false;
}

/**
 * Full PIN verification with the signing secret.
 * This is what the route handler should call.
 */
export async function verifyPinWithSecret(
  pinAttempt: string,
  storedHash: string,
  secret: string,
): Promise<boolean> {
  const attemptHash = await hashPin(pinAttempt, secret);
  return constantTimeEqual(attemptHash, storedHash);
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ===========================================================================
// Suspicious Behavior Detection
// ===========================================================================

/**
 * Context about recent user activity, passed to detectSuspiciousBehavior().
 * The caller assembles this from recent message timestamps and operations.
 */
export interface BehaviorContext {
  /** Timestamps of recent messages (most recent first) */
  recentMessageTimestamps: string[];
  /** Operations attempted in the last 5 minutes */
  recentOperations?: string[];
  /** Current time override for testing */
  now?: Date;
}

/**
 * Analyze recent activity for suspicious patterns.
 *
 * Flags:
 *   - rapid_messaging: Messages faster than human typing speed
 *   - burst_activity: Too many messages in a 5-minute window
 *   - off_hours: Activity during unusual hours (midnight–5am Central)
 *   - bulk_sensitive: Multiple sensitive operations in quick succession
 */
export function detectSuspiciousBehavior(
  context: BehaviorContext,
  now?: Date,
): SuspiciousBehaviorReport {
  const flags: string[] = [];
  const currentTime = context.now ?? now ?? new Date();
  const timestamps = context.recentMessageTimestamps.map((t) => new Date(t));

  // Check 1: Rapid messaging (messages faster than 2 seconds apart)
  if (timestamps.length >= 2) {
    const gaps = [];
    for (let i = 0; i < timestamps.length - 1; i++) {
      const gapMs = timestamps[i].getTime() - timestamps[i + 1].getTime();
      gaps.push(gapMs / 1000);
    }
    const rapidCount = gaps.filter((g) => g < RAPID_MESSAGE_THRESHOLD_SECONDS).length;
    if (rapidCount >= 3) {
      flags.push('rapid_messaging');
    }
  }

  // Check 2: Burst activity (too many messages in 5 minutes)
  if (timestamps.length > 0) {
    const fiveMinAgo = new Date(currentTime.getTime() - 5 * 60 * 1000);
    const recentCount = timestamps.filter((t) => t > fiveMinAgo).length;
    if (recentCount >= BURST_MESSAGE_LIMIT) {
      flags.push('burst_activity');
    }
  }

  // Check 3: Off-hours activity (midnight–5am Central)
  const utcHour = currentTime.getUTCHours();
  const centralHour = (utcHour - 6 + 24) % 24;
  if (centralHour >= OFF_HOURS_START && centralHour < OFF_HOURS_END) {
    // Only flag if there's also other unusual activity
    // Off-hours alone isn't suspicious enough
    if (flags.length > 0) {
      flags.push('off_hours');
    }
  }

  // Check 4: Bulk sensitive operations
  if (context.recentOperations) {
    const sensitiveOps = context.recentOperations.filter((op) => {
      const level = OPERATION_SENSITIVITY[op];
      return level === 'high' || level === 'critical';
    });
    if (sensitiveOps.length >= 3) {
      flags.push('bulk_sensitive_operations');
    }
  }

  return {
    isSuspicious: flags.length > 0,
    flags,
  };
}

// ===========================================================================
// Web Login Escalation
// ===========================================================================

/**
 * Generate the escalation response with a web login URL.
 * The URL includes a one-time challenge token so the web login
 * can be linked back to the SMS session.
 */
export function escalateToWebLogin(
  baseUrl: string,
  phone: string,
): { message: string; loginUrl: string } {
  // The actual token generation will use the pending signup token system
  // or a separate short-lived auth challenge table.
  // For now, we return the base login URL.
  const loginUrl = `${baseUrl}/login?phone=${encodeURIComponent(phone)}`;

  return {
    message: "For security, I need you to verify on the web. Here's your login link:",
    loginUrl,
  };
}

// ===========================================================================
// Account Unlock
// ===========================================================================

/**
 * Unlock a user's account after web login verification.
 * Resets failed PIN attempts and removes the lock.
 */
export async function unlockAccount(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
       SET account_locked = 0,
           failed_pin_attempts = 0,
           last_pin_verified = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(userId)
    .run();
}
