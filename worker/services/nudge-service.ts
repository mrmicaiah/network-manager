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
 * Cron Integration:
 *
 *   The scheduled jobs in worker/cron/scheduled.ts call into this service:
 *
 *   - dailyNudgeGeneration (3am Central) — Premium/trial users
 *     Generates up to 3-5 nudges per user, scheduled for 8am delivery
 *
 *   - weeklyNudgeGeneration (Monday 3am Central) — Free users
 *     Generates a single weekly digest with up to 3 contacts
 *
 *   - nudgeDelivery (8am Central) — All users
 *     Sends all pending nudges scheduled for today
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
 * Timezone Awareness:
 *
 *   Nudges are scheduled for delivery in a user-friendly window (8am local).
 *   Currently uses a Central Time default; future: respect user's timezone
 *   preference if set.
 *
 * Duplicate Prevention:
 *
 *   The service checks for existing pending/delivered nudges before creating
 *   new ones. A contact won't receive a new nudge until their previous one
 *   is acted on, dismissed, or delivered and aged out (48 hours).
 *
 * @see shared/intent-config.ts for nudge templates and health calculation
 * @see worker/cron/scheduled.ts for cron trigger integration
 * @see shared/models.ts for NudgeRow, NudgeStatus types
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

/** Default timezone offset for scheduling (Central Time = UTC-6, or -5 during DST) */
const DEFAULT_TIMEZONE_OFFSET_HOURS = -6;

/** Delivery window hour (8am in user's timezone) */
const DELIVERY_HOUR = 8;

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
}

/**
 * Result of nudge generation for a user.
 */
export interface NudgeGenerationResult {
  userId: string;
  nudgesCreated: number;
  contactsConsidered: number;
  skippedDueToCooldown: number;
}

/**
 * Result of a nudge delivery attempt.
 */
export interface NudgeDeliveryResult {
  nudgeId: string;
  success: boolean;
  error?: string;
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
 * For premium/trial users: Creates individual nudges for top priority contacts.
 * For free users (weekly mode): Creates a single digest nudge.
 *
 * Nudges are scheduled for the next delivery window (8am user time).
 * Respects cooldown period — won't create a new nudge for a contact
 * if they have a pending or recently delivered nudge.
 *
 * @param db      - D1 database binding
 * @param env     - Worker environment (for API keys, but not used in generation)
 * @param userId  - The user to generate nudges for
 * @param options - Generation options (weekly mode, limits, etc.)
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
  const weekly = options?.weekly ?? false;
  const maxNudges = options?.maxNudges ?? (weekly ? FREE_WEEKLY_DIGEST_LIMIT : PREMIUM_DAILY_NUDGE_LIMIT);

  // Get user for gender preferences
  const user = await db
    .prepare('SELECT id, gender FROM users WHERE id = ?')
    .bind(userId)
    .first<Pick<UserRow, 'id' | 'gender'>>();

  if (!user) {
    return { userId, nudgesCreated: 0, contactsConsidered: 0, skippedDueToCooldown: 0 };
  }

  // Get contacts needing attention
  const contacts = await getContactsNeedingAttention(db, userId, maxNudges * 2, currentTime);

  if (contacts.length === 0) {
    return { userId, nudgesCreated: 0, contactsConsidered: 0, skippedDueToCooldown: 0 };
  }

  // Calculate scheduled delivery time
  const scheduledFor = options?.scheduledFor ?? calculateNextDeliveryTime(currentTime);

  // Check for cooldown on each contact
  const eligibleContacts: ContactNeedingAttention[] = [];
  let skippedDueToCooldown = 0;

  for (const contact of contacts) {
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

  // For weekly digest (free tier), create a single combined nudge
  if (weekly) {
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
 * Calculate the next delivery window time.
 * Defaults to 8am next day if called before 3am, or 8am same day if after 3am.
 */
function calculateNextDeliveryTime(now: Date): string {
  const deliveryDate = new Date(now);

  // Adjust for timezone (assume Central Time for now)
  const utcHour = now.getUTCHours();
  const centralHour = utcHour + DEFAULT_TIMEZONE_OFFSET_HOURS;

  // If it's before 3am Central, schedule for 8am today
  // Otherwise, schedule for 8am tomorrow
  if (centralHour >= 3) {
    deliveryDate.setUTCDate(deliveryDate.getUTCDate() + 1);
  }

  // Set to 8am Central = 14:00 UTC (during standard time)
  deliveryDate.setUTCHours(14, 0, 0, 0);

  return deliveryDate.toISOString();
}

// ===========================================================================
// Nudge Delivery
// ===========================================================================

/**
 * Send a single nudge via SMS.
 *
 * Uses SendBlue API to deliver the message. Updates nudge status
 * to 'delivered' on success, logs error on failure (status unchanged
 * so it can be retried).
 *
 * @param env   - Worker environment with SendBlue credentials
 * @param nudge - The nudge to deliver (must include user's phone)
 */
export async function sendNudge(
  env: Env,
  nudge: NudgeRow & { userPhone: string },
): Promise<NudgeDeliveryResult> {
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
 * Get pending nudges ready for delivery.
 *
 * @param db    - D1 database binding
 * @param limit - Maximum nudges to return (default: 100)
 * @param now   - Override current time (for testing)
 */
export async function getPendingNudges(
  db: D1Database,
  limit: number = 100,
  now?: Date,
): Promise<Array<NudgeRow & { userPhone: string }>> {
  const currentTime = (now ?? new Date()).toISOString();

  const { results } = await db
    .prepare(
      `SELECT n.*, u.phone as userPhone
       FROM nudges n
       INNER JOIN users u ON n.user_id = u.id
       WHERE n.status = 'pending'
         AND n.scheduled_for <= ?
       ORDER BY n.scheduled_for ASC
       LIMIT ?`
    )
    .bind(currentTime, limit)
    .all<NudgeRow & { userPhone: string }>();

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
