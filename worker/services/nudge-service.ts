/**
 * Nudge Generation & Delivery Service
 *
 * Implements proactive relationship nudges — the core value proposition
 * of the Network Manager. This service handles:
 *
 *   1. Identifying contacts that need attention (getContactsNeedingAttention)
 *   2. Generating personalized nudge messages (generateNudgesForUser)
 *   3. Delivering nudges via SMS through SendBlue (sendNudge)
 *   4. Tracking nudge status (markNudgeDelivered, markNudgeDismissed, etc.)
 *
 * Notification Preferences:
 *
 *   Users can configure:
 *   - nudge_frequency: 'daily', 'weekly', or 'as_needed'
 *   - quiet_hours_start/end: time window when no SMS should be sent
 *   - timezone: IANA timezone for local time calculations
 *   - preferred_nudge_hour: when to deliver nudges (0-23)
 *
 * Cron Integration:
 *
 *   The scheduled jobs in worker/cron/scheduled.ts call into this service:
 *
 *   - hourlyNudgeProcessing — Checks each user's preferred_nudge_hour
 *     and timezone, generates and delivers nudges at that time
 *
 * Smart Grouping (Premium):
 *
 *   Premium users get intelligent contact grouping to avoid nudge fatigue:
 *   - Max 3-5 contacts per day (configurable via PREMIUM_DAILY_NUDGE_LIMIT)
 *   - Prioritized by urgency (red > yellow), then by days overdue
 *   - Inner circle and kin contacts get priority
 *
 * Free Tier Weekly Digest:
 *
 *   Free users get a consolidated Monday morning message listing their
 *   top 3 contacts needing attention, formatted as a single SMS.
 *
 * Quiet Hours:
 *
 *   Before sending any SMS, the service checks if the current time falls
 *   within the user's quiet hours window. If so, delivery is deferred.
 *
 * Duplicate Prevention:
 *
 *   The service checks for existing pending/delivered nudges before creating
 *   new ones. A contact won't receive a new nudge until their previous one
 *   is acted on, dismissed, or delivered and aged out (48 hours).
 *
 * @see shared/intent-config.ts for nudge templates and health calculation
 * @see worker/cron/scheduled.ts for cron trigger integration
 * @see shared/models.ts for NudgeRow, NudgeStatus, NudgeFrequency types
 */

import type { Env } from '../../shared/types';
import type {
  NudgeRow,
  NudgeStatus,
  ContactRow,
  UserRow,
  IntentType,
  HealthStatus,
  ContactKind,
  UserGender,
  NudgeFrequency,
} from '../../shared/models';
import { FREE_TIER_LIMITS } from '../../shared/models';
import {
  INTENT_CONFIGS,
  calculateHealthStatus,
  resolveEffectiveCadence,
  pickNudgeTemplate,
  renderNudge,
} from '../../shared/intent-config';
import { incrementUsage } from './subscription-service';

// ===========================================================================
// Configuration
// ===========================================================================

/** Maximum nudges per day for premium/trial users */
const PREMIUM_DAILY_NUDGE_LIMIT = 5;

/** Maximum contacts in a free tier weekly digest */
const FREE_WEEKLY_DIGEST_LIMIT = 3;

/** Hours after delivery before a nudge "ages out" and a new one can be created */
const NUDGE_COOLDOWN_HOURS = 48;

/** Delivery window hour (8am in user's timezone) - now configurable per user */
const DEFAULT_DELIVERY_HOUR = 8;

// ===========================================================================
// Types
// ===========================================================================

/**
 * A contact that needs attention, with urgency scoring.
 */
export interface ContactNeedingAttention {
  contactId: string;
  contactName: string;
  phone: string | null;
  intent: IntentType;
  healthStatus: HealthStatus;
  contactKind: ContactKind;
  lastContactDate: string | null;
  daysOverdue: number;
  urgencyScore: number;
  notes: string | null;
  suggestedReason: string;
}

/**
 * Options for nudge generation.
 */
export interface NudgeGenerationOptions {
  /** Generate for weekly digest (free tier) */
  weekly?: boolean;
  /** Override max nudges to generate */
  maxNudges?: number;
  /** Override scheduled delivery time */
  scheduledFor?: string;
  /** If true, schedule for immediate delivery (used by hourly cron) */
  immediate?: boolean;
}

/**
 * Result of nudge generation for a user.
 */
export interface NudgeGenerationResult {
  userId: string;
  nudgesCreated: number;
  contactsConsidered: number;
  skippedDueToCooldown: number;
  skippedDueToFrequency?: boolean;
}

/**
 * Result of a nudge delivery attempt.
 */
export interface NudgeDeliveryResult {
  nudgeId: string;
  success: boolean;
  error?: string;
  skippedDueToQuietHours?: boolean;
}

/**
 * User notification preferences for nudge delivery.
 */
interface UserNotificationPrefs {
  timezone: string;
  preferred_nudge_hour: number;
  nudge_frequency: NudgeFrequency;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
}

// ===========================================================================
// Quiet Hours Checking
// ===========================================================================

/**
 * Check if the current time is within a user's quiet hours.
 *
 * Quiet hours can span midnight (e.g., 22:00 to 08:00).
 * Returns true if we should NOT send SMS right now.
 *
 * @param quietStart - Start time in HH:MM format (e.g., "22:00")
 * @param quietEnd - End time in HH:MM format (e.g., "08:00")
 * @param timezone - IANA timezone (e.g., "America/New_York")
 * @param now - Optional override for current time (for testing)
 */
export function isInQuietHours(
  quietStart: string | null,
  quietEnd: string | null,
  timezone: string,
  now?: Date,
): boolean {
  // If quiet hours aren't configured, never block
  if (!quietStart || !quietEnd) {
    return false;
  }

  const currentTime = now ?? new Date();

  // Get current time in user's timezone
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });

  let currentHour: number;
  let currentMinute: number;

  try {
    const parts = formatter.formatToParts(currentTime);
    currentHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);
    currentMinute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
  } catch {
    // Invalid timezone, assume not in quiet hours
    console.warn(`[nudge] Invalid timezone: ${timezone}`);
    return false;
  }

  // Parse quiet hours
  const [startHour, startMinute] = quietStart.split(':').map(Number);
  const [endHour, endMinute] = quietEnd.split(':').map(Number);

  // Convert to minutes since midnight for easier comparison
  const currentMinutes = currentHour * 60 + currentMinute;
  const startMinutes = startHour * 60 + startMinute;
  const endMinutes = endHour * 60 + endMinute;

  // Handle quiet hours that span midnight (e.g., 22:00 to 08:00)
  if (startMinutes > endMinutes) {
    // Quiet hours span midnight
    // In quiet hours if: current >= start OR current < end
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  } else {
    // Normal range (e.g., 08:00 to 18:00)
    // In quiet hours if: start <= current < end
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
}

/**
 * Check if a user should receive nudges based on their frequency preference.
 *
 * @param frequency - User's nudge_frequency preference
 * @param healthStatus - The contact's health status (for 'as_needed' mode)
 * @param isWeeklyRun - Whether this is the weekly Monday run
 */
export function shouldGenerateNudge(
  frequency: NudgeFrequency,
  healthStatus: HealthStatus,
  isWeeklyRun: boolean,
): boolean {
  switch (frequency) {
    case 'daily':
      // Daily users get nudges every day
      return true;
    case 'weekly':
      // Weekly users only get nudges on Monday (weekly run)
      return isWeeklyRun;
    case 'as_needed':
      // As-needed users only get nudges for red/critical contacts
      return healthStatus === 'red';
    default:
      return true;
  }
}

// ===========================================================================
// Contact Prioritization
// ===========================================================================

/**
 * Get contacts that need attention for a user, sorted by urgency.
 *
 * Queries contacts where:
 *   - archived = 0
 *   - intent is active (not dormant)
 *   - health_status is yellow or red
 *
 * Returns them scored and sorted by urgency for nudge prioritization.
 *
 * @param db     - D1 database binding
 * @param userId - The user whose contacts to check
 * @param limit  - Maximum contacts to return (default: 20)
 * @param now    - Override current time (for testing)
 */
export async function getContactsNeedingAttention(
  db: D1Database,
  userId: string,
  limit: number = 20,
  now?: Date,
): Promise<ContactNeedingAttention[]> {
  const currentTime = now ?? new Date();

  // Get user for gender modifiers
  const user = await db
    .prepare('SELECT gender FROM users WHERE id = ?')
    .bind(userId)
    .first<Pick<UserRow, 'gender'>>();

  // Query contacts needing attention
  const { results: contacts } = await db
    .prepare(
      `SELECT id, name, phone, intent, health_status, contact_kind,
              last_contact_date, notes, custom_cadence_days, created_at
       FROM contacts
       WHERE user_id = ?
         AND archived = 0
         AND intent NOT IN ('dormant', 'new')
         AND health_status IN ('yellow', 'red')
       ORDER BY
         CASE health_status WHEN 'red' THEN 0 ELSE 1 END,
         last_contact_date ASC
       LIMIT ?`
    )
    .bind(userId, limit * 2) // Fetch extra to account for cooldown filtering
    .all<ContactRow>();

  const results: ContactNeedingAttention[] = [];

  for (const contact of contacts) {
    const cadence = resolveEffectiveCadence(
      contact.intent,
      contact.custom_cadence_days,
      contact.created_at,
      currentTime,
      user?.gender,
    );

    // Calculate days overdue
    let daysOverdue = 0;
    if (contact.last_contact_date && cadence) {
      const lastContact = new Date(contact.last_contact_date);
      const elapsedMs = currentTime.getTime() - lastContact.getTime();
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
      daysOverdue = Math.max(0, elapsedDays - cadence);
    } else if (!contact.last_contact_date) {
      // Never contacted — treat as moderately overdue
      daysOverdue = cadence ?? 14;
    }

    // Calculate urgency score
    // Higher = more urgent
    // Factors: health status (red=10, yellow=5), days overdue, intent importance
    const healthWeight = contact.health_status === 'red' ? 10 : 5;
    const intentWeight = getIntentWeight(contact.intent);
    const kinBonus = contact.contact_kind === 'kin' ? 2 : 0;
    const urgencyScore = healthWeight + (daysOverdue * 0.5) + intentWeight + kinBonus;

    // Generate suggested reason
    const suggestedReason = generateNudgeReason(
      contact.name,
      contact.intent,
      contact.health_status,
      daysOverdue,
      contact.contact_kind === 'kin',
    );

    results.push({
      contactId: contact.id,
      contactName: contact.name,
      phone: contact.phone,
      intent: contact.intent,
      healthStatus: contact.health_status,
      contactKind: contact.contact_kind,
      lastContactDate: contact.last_contact_date,
      daysOverdue: Math.round(daysOverdue),
      urgencyScore,
      notes: contact.notes,
      suggestedReason,
    });
  }

  // Sort by urgency score (highest first) and limit
  return results
    .sort((a, b) => b.urgencyScore - a.urgencyScore)
    .slice(0, limit);
}

/**
 * Get intent weight for urgency scoring.
 * Inner circle contacts are more urgent than outer layers.
 */
function getIntentWeight(intent: IntentType): number {
  const weights: Record<IntentType, number> = {
    inner_circle: 5,
    nurture: 3,
    maintain: 1,
    transactional: 0,
    dormant: 0,
    new: 0,
  };
  return weights[intent] ?? 0;
}

/**
 * Generate a human-readable reason for why this nudge is being sent.
 */
function generateNudgeReason(
  name: string,
  intent: IntentType,
  healthStatus: HealthStatus,
  daysOverdue: number,
  isKin: boolean,
): string {
  const config = INTENT_CONFIGS[intent];
  const cadence = config.defaultCadenceDays ?? 14;

  if (healthStatus === 'red') {
    return `${name} is overdue by ${Math.round(daysOverdue)} days (${config.label} cadence: ${cadence} days)`;
  }

  if (daysOverdue > 0) {
    return `${name} is ${Math.round(daysOverdue)} days past ${config.label} check-in`;
  }

  return `${name} is approaching ${config.label} check-in window`;
}

// ===========================================================================
// Nudge Generation
// ===========================================================================

/**
 * Generate nudges for a single user.
 *
 * Respects user's nudge_frequency preference:
 * - 'daily': Creates individual nudges for top priority contacts
 * - 'weekly': Creates a single digest nudge (only on Monday runs)
 * - 'as_needed': Only creates nudges for red/critical contacts
 *
 * Nudges are scheduled for immediate delivery when called from the
 * hourly cron (options.immediate = true), or for the next delivery
 * window otherwise.
 *
 * Respects cooldown period — won't create a new nudge for a contact
 * if they have a pending or recently delivered nudge.
 *
 * @param db      - D1 database binding
 * @param env     - Worker environment (for API keys, but not used in generation)
 * @param userId  - The user to generate nudges for
 * @param options - Generation options (weekly mode, limits, immediate, etc.)
 * @param now     - Override current time (for testing)
 */
export async function generateNudgesForUser(
  db: D1Database,
  env: Env,
  userId: string,
  options?: NudgeGenerationOptions,
  now?: Date,
): Promise<NudgeGenerationResult> {
  const currentTime = now ?? new Date();
  const isWeeklyRun = options?.weekly ?? false;

  // Get user with notification preferences
  const user = await db
    .prepare('SELECT id, gender, nudge_frequency, timezone, preferred_nudge_hour FROM users WHERE id = ?')
    .bind(userId)
    .first<Pick<UserRow, 'id' | 'gender' | 'nudge_frequency' | 'timezone' | 'preferred_nudge_hour'>>();

  if (!user) {
    return { userId, nudgesCreated: 0, contactsConsidered: 0, skippedDueToCooldown: 0 };
  }

  const nudgeFrequency = user.nudge_frequency ?? 'daily';

  // Determine max nudges based on frequency and tier
  let maxNudges: number;
  if (nudgeFrequency === 'weekly' || isWeeklyRun) {
    maxNudges = options?.maxNudges ?? FREE_WEEKLY_DIGEST_LIMIT;
  } else {
    maxNudges = options?.maxNudges ?? PREMIUM_DAILY_NUDGE_LIMIT;
  }

  // Get contacts needing attention
  const contacts = await getContactsNeedingAttention(db, userId, maxNudges * 2, currentTime);

  if (contacts.length === 0) {
    return { userId, nudgesCreated: 0, contactsConsidered: 0, skippedDueToCooldown: 0 };
  }

  // Filter contacts based on nudge frequency preference
  const eligibleByFrequency = contacts.filter(contact =>
    shouldGenerateNudge(nudgeFrequency, contact.healthStatus, isWeeklyRun)
  );

  if (eligibleByFrequency.length === 0) {
    return {
      userId,
      nudgesCreated: 0,
      contactsConsidered: contacts.length,
      skippedDueToCooldown: 0,
      skippedDueToFrequency: true,
    };
  }

  // Calculate scheduled delivery time
  // If immediate=true (called from hourly cron at user's preferred time),
  // schedule for NOW so it can be delivered immediately
  let scheduledFor: string;
  if (options?.scheduledFor) {
    scheduledFor = options.scheduledFor;
  } else if (options?.immediate) {
    // Schedule for NOW - the cron already determined this is the right time
    scheduledFor = currentTime.toISOString();
  } else {
    // Schedule for next occurrence of preferred hour
    scheduledFor = calculateNextDeliveryTime(
      currentTime,
      user.timezone ?? 'America/Chicago',
      user.preferred_nudge_hour ?? DEFAULT_DELIVERY_HOUR,
    );
  }

  // Check for cooldown on each contact
  const eligibleContacts: ContactNeedingAttention[] = [];
  let skippedDueToCooldown = 0;

  for (const contact of eligibleByFrequency) {
    const hasCooldown = await hasRecentNudge(db, userId, contact.contactId, currentTime);
    if (hasCooldown) {
      skippedDueToCooldown++;
    } else {
      eligibleContacts.push(contact);
      if (eligibleContacts.length >= maxNudges) break;
    }
  }

  if (eligibleContacts.length === 0) {
    return {
      userId,
      nudgesCreated: 0,
      contactsConsidered: contacts.length,
      skippedDueToCooldown,
    };
  }

  // For weekly digest or weekly frequency, create a single combined nudge
  if (isWeeklyRun || nudgeFrequency === 'weekly') {
    await createDigestNudge(db, userId, eligibleContacts, scheduledFor);
    await incrementUsage(db, userId, 'nudges_generated', 1, currentTime);
    return {
      userId,
      nudgesCreated: 1,
      contactsConsidered: contacts.length,
      skippedDueToCooldown,
    };
  }

  // For daily nudges (premium/trial), create individual nudges
  let nudgesCreated = 0;
  for (const contact of eligibleContacts) {
    await createIndividualNudge(db, userId, contact, user.gender, scheduledFor);
    nudgesCreated++;
  }

  // Track usage
  await incrementUsage(db, userId, 'nudges_generated', nudgesCreated, currentTime);

  return {
    userId,
    nudgesCreated,
    contactsConsidered: contacts.length,
    skippedDueToCooldown,
  };
}

/**
 * Check if a contact has a recent nudge (pending or within cooldown period).
 */
async function hasRecentNudge(
  db: D1Database,
  userId: string,
  contactId: string,
  now: Date,
): Promise<boolean> {
  const cooldownCutoff = new Date(now.getTime() - NUDGE_COOLDOWN_HOURS * 60 * 60 * 1000);

  const existing = await db
    .prepare(
      `SELECT id FROM nudges
       WHERE user_id = ? AND contact_id = ?
         AND (status = 'pending'
              OR (status = 'delivered' AND delivered_at > ?))
       LIMIT 1`
    )
    .bind(userId, contactId, cooldownCutoff.toISOString())
    .first();

  return existing !== null;
}

/**
 * Create an individual nudge for a contact.
 */
async function createIndividualNudge(
  db: D1Database,
  userId: string,
  contact: ContactNeedingAttention,
  gender: UserGender,
  scheduledFor: string,
): Promise<void> {
  const id = crypto.randomUUID();

  // Pick a nudge template based on health status and gender preferences
  const template = pickNudgeTemplate(contact.intent, contact.healthStatus, gender);
  const message = template
    ? renderNudge(template.message, contact.contactName)
    : `Hey, it's been a while since you connected with ${contact.contactName}. Want to reach out today?`;

  await db
    .prepare(
      `INSERT INTO nudges (id, user_id, contact_id, message, reason, status, scheduled_for, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`
    )
    .bind(id, userId, contact.contactId, message, contact.suggestedReason, scheduledFor)
    .run();
}

/**
 * Create a weekly digest nudge for free tier users.
 * Combines multiple contacts into a single SMS.
 */
async function createDigestNudge(
  db: D1Database,
  userId: string,
  contacts: ContactNeedingAttention[],
  scheduledFor: string,
): Promise<void> {
  const id = crypto.randomUUID();

  // Build digest message
  const contactList = contacts
    .slice(0, FREE_WEEKLY_DIGEST_LIMIT)
    .map((c, i) => `${i + 1}. ${c.contactName}`)
    .join('\n');

  const message = `🌟 Weekly Check-in Reminder\n\nHey! Here are ${contacts.length} people who'd love to hear from you:\n\n${contactList}\n\nPick one and send a quick message — your relationships will thank you!`;

  const reason = `Weekly digest: ${contacts.length} contacts need attention`;

  // Use the first contact as the primary (for tracking purposes)
  const primaryContact = contacts[0];

  await db
    .prepare(
      `INSERT INTO nudges (id, user_id, contact_id, message, reason, status, scheduled_for, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`
    )
    .bind(id, userId, primaryContact.contactId, message, reason, scheduledFor)
    .run();
}

/**
 * Calculate the next delivery window time based on user's timezone and preferred hour.
 *
 * NOTE: This is used when scheduling nudges for future delivery (not from cron).
 * When the hourly cron calls generateNudgesForUser with immediate=true,
 * this function is NOT called — nudges are scheduled for immediate delivery.
 *
 * @param now - Current time
 * @param timezone - User's IANA timezone
 * @param preferredHour - User's preferred delivery hour (0-23)
 */
function calculateNextDeliveryTime(
  now: Date,
  timezone: string,
  preferredHour: number,
): string {
  try {
    // Get current time in user's timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const currentHour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10);

    // Determine if we need to schedule for today or tomorrow
    const deliveryDate = new Date(now);

    // Use > instead of >= so that if we're exactly AT the preferred hour,
    // we schedule for TODAY (now), not tomorrow
    if (currentHour > preferredHour) {
      // Already past preferred hour, schedule for tomorrow
      deliveryDate.setDate(deliveryDate.getDate() + 1);
    }

    // Set the delivery time to preferred hour in the user's timezone
    // We approximate by setting UTC hours based on timezone offset
    const tzOffset = getTimezoneOffsetHours(timezone, deliveryDate);
    const utcHour = (preferredHour - tzOffset + 24) % 24;

    deliveryDate.setUTCHours(utcHour, 0, 0, 0);

    return deliveryDate.toISOString();
  } catch {
    // Fallback to simple UTC calculation
    const deliveryDate = new Date(now);
    deliveryDate.setUTCDate(deliveryDate.getUTCDate() + 1);
    deliveryDate.setUTCHours(14, 0, 0, 0); // 8am Central as fallback
    return deliveryDate.toISOString();
  }
}

/**
 * Get timezone offset in hours for a given timezone and date.
 */
function getTimezoneOffsetHours(timezone: string, date: Date): number {
  try {
    const utcDate = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
    return (tzDate.getTime() - utcDate.getTime()) / (1000 * 60 * 60);
  } catch {
    return -6; // Default to Central Time
  }
}

// ===========================================================================
// Nudge Delivery
// ===========================================================================

/**
 * Send a single nudge via SMS.
 *
 * Checks quiet hours before sending. If the user is in quiet hours,
 * the nudge is not sent but marked as skipped (to be retried later).
 *
 * Uses SendBlue API to deliver the message. Updates nudge status
 * to 'delivered' on success, logs error on failure (status unchanged
 * so it can be retried).
 *
 * @param env   - Worker environment with SendBlue credentials
 * @param nudge - The nudge to deliver (must include user's phone and prefs)
 */
export async function sendNudge(
  env: Env,
  nudge: NudgeRow & { userPhone: string; quietHoursStart?: string | null; quietHoursEnd?: string | null; timezone?: string },
): Promise<NudgeDeliveryResult> {
  // Check quiet hours
  if (nudge.quietHoursStart && nudge.quietHoursEnd && nudge.timezone) {
    if (isInQuietHours(nudge.quietHoursStart, nudge.quietHoursEnd, nudge.timezone)) {
      console.log(`[nudge:send] Skipping nudge ${nudge.id} - user in quiet hours`);
      return { nudgeId: nudge.id, success: false, skippedDueToQuietHours: true };
    }
  }

  try {
    const response = await fetch('https://api.sendblue.co/api/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': env.SENDBLUE_API_KEY,
        'sb-api-secret-key': env.SENDBLUE_API_SECRET,
      },
      body: JSON.stringify({
        number: nudge.userPhone,
        content: nudge.message,
        send_style: 'invisible', // No typing indicator
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[nudge:send] SendBlue error for nudge ${nudge.id}:`, error);
      return { nudgeId: nudge.id, success: false, error };
    }

    return { nudgeId: nudge.id, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[nudge:send] Exception for nudge ${nudge.id}:`, errorMsg);
    return { nudgeId: nudge.id, success: false, error: errorMsg };
  }
}

/**
 * Mark a nudge as delivered.
 */
export async function markNudgeDelivered(
  db: D1Database,
  nudgeId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE nudges
       SET status = 'delivered', delivered_at = datetime('now')
       WHERE id = ?`
    )
    .bind(nudgeId)
    .run();
}

/**
 * Mark a nudge as dismissed (user acknowledged but didn't act).
 */
export async function markNudgeDismissed(
  db: D1Database,
  nudgeId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE nudges
       SET status = 'dismissed', dismissed_at = datetime('now')
       WHERE id = ?`
    )
    .bind(nudgeId)
    .run();
}

/**
 * Mark a nudge as acted on (user reached out to the contact).
 */
export async function markNudgeActedOn(
  db: D1Database,
  nudgeId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE nudges
       SET status = 'acted_on', acted_on_at = datetime('now')
       WHERE id = ?`
    )
    .bind(nudgeId)
    .run();
}

// ===========================================================================
// Nudge Queries
// ===========================================================================

/**
 * Get pending nudges ready for delivery, including user notification preferences.
 *
 * @param db    - D1 database binding
 * @param limit - Maximum nudges to return (default: 100)
 * @param userId - Optional: filter to specific user
 * @param now   - Override current time (for testing)
 */
export async function getPendingNudges(
  db: D1Database,
  limit: number = 100,
  userId?: string,
  now?: Date,
): Promise<Array<NudgeRow & { userPhone: string; quietHoursStart: string | null; quietHoursEnd: string | null; timezone: string }>> {
  const currentTime = (now ?? new Date()).toISOString();

  let query = `
    SELECT n.*, u.phone as userPhone, u.quiet_hours_start as quietHoursStart, 
           u.quiet_hours_end as quietHoursEnd, u.timezone
    FROM nudges n
    INNER JOIN users u ON n.user_id = u.id
    WHERE n.status = 'pending'
      AND n.scheduled_for <= ?
  `;

  const binds: unknown[] = [currentTime];

  if (userId) {
    query += ' AND n.user_id = ?';
    binds.push(userId);
  }

  query += ' ORDER BY n.scheduled_for ASC LIMIT ?';
  binds.push(limit);

  const { results } = await db
    .prepare(query)
    .bind(...binds)
    .all<NudgeRow & { userPhone: string; quietHoursStart: string | null; quietHoursEnd: string | null; timezone: string }>();

  return results;
}

/**
 * Get nudge history for a user.
 *
 * @param db     - D1 database binding
 * @param userId - The user's ID
 * @param limit  - Maximum nudges to return (default: 20)
 */
export async function getNudgeHistory(
  db: D1Database,
  userId: string,
  limit: number = 20,
): Promise<NudgeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM nudges
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(userId, limit)
    .all<NudgeRow>();

  return results;
}

/**
 * Get recent nudges for a specific contact.
 *
 * @param db        - D1 database binding
 * @param userId    - The user's ID
 * @param contactId - The contact's ID
 * @param limit     - Maximum nudges to return (default: 5)
 */
export async function getContactNudges(
  db: D1Database,
  userId: string,
  contactId: string,
  limit: number = 5,
): Promise<NudgeRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM nudges
       WHERE user_id = ? AND contact_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .bind(userId, contactId, limit)
    .all<NudgeRow>();

  return results;
}
