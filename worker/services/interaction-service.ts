/**
 * Interaction Logging Service — records touchpoints and keeps contacts fresh.
 *
 * An interaction is any meaningful contact between the user and someone in
 * their network: a text, phone call, in-person meeting, email, or social
 * media exchange. Logging an interaction does two things:
 *
 *   1. Creates an InteractionRow in the interactions table
 *   2. Updates the contact's last_contact_date and recalculates health
 *      via touchContactDate() from contact-service
 *
 * This is the service that keeps the relationship health system alive.
 * Without interactions being logged, contacts drift to yellow → red and
 * the nudge system generates increasingly urgent reminders.
 *
 * Logging sources:
 *
 *   'sms'       — User confirms via SMS that they reached out
 *   'dashboard' — Logged through the web dashboard
 *   'auto'      — System-detected (e.g., outbound SMS tracked automatically)
 *   'braindump' — Extracted from a braindump message
 *   'import'    — Bulk imported from external source
 *
 * Usage:
 *
 *   // User tells Bethany "I called Mom yesterday"
 *   await logInteraction(db, userId, {
 *     contact_id: momContactId,
 *     method: 'call',
 *     date: yesterday.toISOString(),
 *     summary: 'Caught up about holiday plans',
 *     logged_via: 'sms',
 *   });
 *
 *   // Dashboard timeline for a contact
 *   const history = await getInteractionHistory(db, userId, momContactId, 20);
 *
 *   // User's activity feed for the last 7 days
 *   const recent = await getRecentInteractions(db, userId, 7);
 *
 * @see shared/models.ts for InteractionRow, LogInteractionInput, InteractionMethod
 * @see worker/services/contact-service.ts for touchContactDate()
 */

import type {
  InteractionRow,
  LogInteractionInput,
  InteractionMethod,
} from '../../shared/models';
import { touchContactDate } from './contact-service';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Interaction with the contact's name resolved.
 * Used by activity feeds where we need to show "Called Mom" not just a contact_id.
 */
export interface InteractionWithContact extends InteractionRow {
  contact_name: string;
}

/**
 * Grouped interactions for the activity feed.
 */
export interface DailyInteractionGroup {
  date: string;
  interactions: InteractionWithContact[];
}

/**
 * Summary stats for a user's interaction activity.
 */
export interface InteractionStats {
  totalThisPeriod: number;
  byMethod: Record<InteractionMethod, number>;
  uniqueContacts: number;
  mostActiveContact: { id: string; name: string; count: number } | null;
}

// ===========================================================================
// Log Interaction
// ===========================================================================

/**
 * Log a new interaction and update the contact's health.
 *
 * This is the primary write path. It:
 *   1. Validates the contact belongs to the user
 *   2. Creates the interaction row
 *   3. Calls touchContactDate() to update last_contact_date and
 *      recalculate health_status on the contact
 *
 * The date field defaults to now if not provided. If a past date is
 * provided (e.g., "I called her yesterday"), touchContactDate() only
 * updates last_contact_date if the new date is more recent than the
 * existing value.
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param input  - Interaction details
 * @param now    - Override current time (for testing)
 * @returns The created interaction, or null if the contact wasn't found
 */
export async function logInteraction(
  db: D1Database,
  userId: string,
  input: LogInteractionInput,
  now?: Date,
): Promise<InteractionRow | null> {
  // Validate contact ownership
  const contact = await db
    .prepare('SELECT id FROM contacts WHERE id = ? AND user_id = ?')
    .bind(input.contact_id, userId)
    .first<{ id: string }>();

  if (!contact) return null;

  const id = crypto.randomUUID();
  const interactionDate = input.date ?? (now ?? new Date()).toISOString();
  const loggedVia = input.logged_via ?? 'dashboard';

  // Create the interaction row
  await db
    .prepare(
      `INSERT INTO interactions
         (id, user_id, contact_id, date, method, summary, logged_via, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      id,
      userId,
      input.contact_id,
      interactionDate,
      input.method,
      input.summary ?? null,
      loggedVia,
    )
    .run();

  // Update the contact's last_contact_date and recalculate health
  await touchContactDate(db, userId, input.contact_id, interactionDate, now);

  // Return the created row
  return db
    .prepare('SELECT * FROM interactions WHERE id = ?')
    .bind(id)
    .first<InteractionRow>();
}

/**
 * Log multiple interactions in a batch.
 *
 * Used by braindump processing and import flows where multiple
 * interactions are extracted at once. Each interaction still triggers
 * a touchContactDate() call.
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param inputs - Array of interaction inputs
 * @param now    - Override current time (for testing)
 * @returns Count of successfully logged interactions
 */
export async function logInteractionBatch(
  db: D1Database,
  userId: string,
  inputs: LogInteractionInput[],
  now?: Date,
): Promise<{ logged: number; failed: number }> {
  let logged = 0;
  let failed = 0;

  for (const input of inputs) {
    const result = await logInteraction(db, userId, input, now);
    if (result) {
      logged++;
    } else {
      failed++;
    }
  }

  return { logged, failed };
}

// ===========================================================================
// Read — Contact History
// ===========================================================================

/**
 * Get interaction history for a specific contact, newest first.
 *
 * This is the contact detail timeline view. Returns raw InteractionRows
 * since the contact context is already known.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact to get history for
 * @param limit     - Max results (default 20)
 * @param offset    - Pagination offset (default 0)
 */
export async function getInteractionHistory(
  db: D1Database,
  userId: string,
  contactId: string,
  limit: number = 20,
  offset: number = 0,
): Promise<{ interactions: InteractionRow[]; total: number }> {
  // Count total
  const countResult = await db
    .prepare(
      `SELECT COUNT(*) as total FROM interactions
       WHERE contact_id = ? AND user_id = ?`
    )
    .bind(contactId, userId)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // Fetch page — uses idx_interactions_contact_date
  const { results } = await db
    .prepare(
      `SELECT * FROM interactions
       WHERE contact_id = ? AND user_id = ?
       ORDER BY date DESC
       LIMIT ? OFFSET ?`
    )
    .bind(contactId, userId, limit, offset)
    .all<InteractionRow>();

  return { interactions: results, total };
}

/**
 * Get the most recent interaction with a specific contact.
 * Useful for nudge generation — knowing when and how they last connected.
 */
export async function getLastInteraction(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<InteractionRow | null> {
  return db
    .prepare(
      `SELECT * FROM interactions
       WHERE contact_id = ? AND user_id = ?
       ORDER BY date DESC
       LIMIT 1`
    )
    .bind(contactId, userId)
    .first<InteractionRow>();
}

// ===========================================================================
// Read — User Activity Feed
// ===========================================================================

/**
 * Get recent interactions across all contacts for a user.
 *
 * Returns interactions enriched with the contact's name so the
 * activity feed can show "Called Mom" instead of a raw contact_id.
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param days   - How many days back to look (default 7)
 * @param limit  - Max results (default 50)
 */
export async function getRecentInteractions(
  db: D1Database,
  userId: string,
  days: number = 7,
  limit: number = 50,
): Promise<InteractionWithContact[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*, c.name as contact_name
       FROM interactions i
       INNER JOIN contacts c ON i.contact_id = c.id
       WHERE i.user_id = ? AND i.date >= date('now', '-' || ? || ' days')
       ORDER BY i.date DESC
       LIMIT ?`
    )
    .bind(userId, days, limit)
    .all<InteractionWithContact>();

  return results;
}

/**
 * Get recent interactions grouped by date.
 *
 * Returns an array of { date, interactions[] } groups for rendering
 * a timeline-style activity feed with date headers.
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param days   - How many days back to look (default 7)
 * @param limit  - Max total interactions (default 100)
 */
export async function getRecentInteractionsGrouped(
  db: D1Database,
  userId: string,
  days: number = 7,
  limit: number = 100,
): Promise<DailyInteractionGroup[]> {
  const interactions = await getRecentInteractions(db, userId, days, limit);

  const groups = new Map<string, InteractionWithContact[]>();
  for (const interaction of interactions) {
    const dateKey = interaction.date.split('T')[0]; // YYYY-MM-DD
    const group = groups.get(dateKey) ?? [];
    group.push(interaction);
    groups.set(dateKey, group);
  }

  // Convert to array, sorted by date descending
  return Array.from(groups.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, interactions]) => ({ date, interactions }));
}

// ===========================================================================
// Stats & Analytics
// ===========================================================================

/**
 * Get interaction stats for a user over a time period.
 *
 * Used by the dashboard summary and weekly recap. Provides:
 *   - Total interaction count
 *   - Breakdown by method (text, call, in_person, etc.)
 *   - Number of unique contacts reached
 *   - Most frequently contacted person
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param days   - How many days back to analyze (default 7)
 */
export async function getInteractionStats(
  db: D1Database,
  userId: string,
  days: number = 7,
): Promise<InteractionStats> {
  // Total and by-method counts
  const { results: methodCounts } = await db
    .prepare(
      `SELECT method, COUNT(*) as count
       FROM interactions
       WHERE user_id = ? AND date >= date('now', '-' || ? || ' days')
       GROUP BY method`
    )
    .bind(userId, days)
    .all<{ method: InteractionMethod; count: number }>();

  const byMethod: Record<InteractionMethod, number> = {
    text: 0,
    call: 0,
    in_person: 0,
    email: 0,
    social: 0,
    other: 0,
  };
  let total = 0;
  for (const row of methodCounts) {
    byMethod[row.method] = row.count;
    total += row.count;
  }

  // Unique contacts
  const uniqueResult = await db
    .prepare(
      `SELECT COUNT(DISTINCT contact_id) as unique_contacts
       FROM interactions
       WHERE user_id = ? AND date >= date('now', '-' || ? || ' days')`
    )
    .bind(userId, days)
    .first<{ unique_contacts: number }>();

  // Most active contact
  const topContact = await db
    .prepare(
      `SELECT i.contact_id as id, c.name, COUNT(*) as count
       FROM interactions i
       INNER JOIN contacts c ON i.contact_id = c.id
       WHERE i.user_id = ? AND i.date >= date('now', '-' || ? || ' days')
       GROUP BY i.contact_id
       ORDER BY count DESC
       LIMIT 1`
    )
    .bind(userId, days)
    .first<{ id: string; name: string; count: number }>();

  return {
    totalThisPeriod: total,
    byMethod,
    uniqueContacts: uniqueResult?.unique_contacts ?? 0,
    mostActiveContact: topContact ?? null,
  };
}

/**
 * Check if a user has interacted with a specific contact within a given period.
 *
 * Used by the nudge system to avoid nudging about contacts the user
 * has already reached out to recently.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact to check
 * @param days      - How many days back to check (default 1)
 */
export async function hasRecentInteraction(
  db: D1Database,
  userId: string,
  contactId: string,
  days: number = 1,
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT 1 FROM interactions
       WHERE user_id = ? AND contact_id = ?
         AND date >= date('now', '-' || ? || ' days')
       LIMIT 1`
    )
    .bind(userId, contactId, days)
    .first();

  return result !== null;
}

// ===========================================================================
// Delete
// ===========================================================================

/**
 * Delete a specific interaction.
 *
 * Note: This does NOT recalculate the contact's last_contact_date.
 * If the deleted interaction was the most recent one, the contact's
 * last_contact_date will be stale until the next health recalc cron.
 * This is acceptable because interaction deletion is rare.
 *
 * @param db            - D1 database binding
 * @param userId        - The owning user's ID
 * @param interactionId - The interaction to delete
 * @returns true if deleted, false if not found
 */
export async function deleteInteraction(
  db: D1Database,
  userId: string,
  interactionId: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM interactions WHERE id = ? AND user_id = ?')
    .bind(interactionId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Delete all interactions for a specific contact.
 *
 * Used when hard-deleting a contact. Normally the ON DELETE CASCADE
 * handles this, but this exists for cases where you want to clear
 * history without deleting the contact itself.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact whose interactions to clear
 * @returns Number of interactions deleted
 */
export async function deleteInteractionsForContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<{ deleted: number }> {
  const result = await db
    .prepare(
      'DELETE FROM interactions WHERE contact_id = ? AND user_id = ?'
    )
    .bind(contactId, userId)
    .run();

  return { deleted: result.meta.changes ?? 0 };
}
