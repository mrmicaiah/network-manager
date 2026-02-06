/**
 * Contact Management Service — CRUD, filtering, search, and circle linking.
 *
 * Every operation is scoped by userId. No cross-user data access is possible
 * through this service.
 *
 * Circle management:
 *
 *   Contacts have a many-to-many relationship with circles via the
 *   contact_circles junction table. When creating or updating a contact,
 *   pass circle_ids to set the links. On update, passing circle_ids
 *   replaces ALL existing links (delete-then-insert). Omitting circle_ids
 *   leaves links untouched.
 *
 * Health status:
 *
 *   Health is computed on create and update using calculateHealthStatus()
 *   from intent-config.ts, then stored denormalized on the contact row
 *   for fast query filtering. A weekly cron should recalculate all
 *   contacts' health to keep the denormalized values fresh.
 *
 * Deletion:
 *
 *   Soft delete by default (archived = 1). Hard delete available but
 *   cascades through contact_circles, interactions, and nudges via
 *   ON DELETE CASCADE in the schema.
 *
 * Usage:
 *
 *   const contact = await createContact(db, userId, {
 *     name: 'Sarah Chen',
 *     intent: 'nurture',
 *     circle_ids: [friendsCircleId],
 *     source: 'braindump',
 *   });
 *
 *   const list = await listContacts(db, userId, {
 *     intent: 'inner_circle',
 *     health_status: 'red',
 *   });
 *
 * @see shared/models.ts for ContactRow, CreateContactInput, UpdateContactInput, ContactListFilters
 * @see shared/intent-config.ts for calculateHealthStatus()
 */

import type {
  ContactRow,
  ContactWithCircles,
  ContactSummary,
  CircleRow,
  CreateContactInput,
  UpdateContactInput,
  ContactListFilters,
  IntentType,
  HealthStatus,
} from '../../shared/models';
import { calculateHealthStatus } from '../../shared/intent-config';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Paginated list result.
 */
export interface ContactListResult {
  contacts: ContactSummary[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Options for listContacts pagination.
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'last_contact_date' | 'health_status' | 'created_at';
  orderDir?: 'asc' | 'desc';
}

// ===========================================================================
// Create
// ===========================================================================

/**
 * Create a new contact for a user.
 *
 * Computes initial health status from intent and last_contact_date (null
 * for new contacts → yellow for tracked intents, green for dormant/new).
 *
 * If circle_ids are provided, links the contact to those circles in a
 * single batch insert.
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param input  - Contact creation fields
 * @param now    - Override current time (for testing)
 * @returns The created contact with circles resolved
 */
export async function createContact(
  db: D1Database,
  userId: string,
  input: CreateContactInput,
  now?: Date,
): Promise<ContactWithCircles> {
  const id = crypto.randomUUID();
  const intent: IntentType = input.intent ?? 'new';
  const healthStatus = calculateHealthStatus(
    intent,
    null, // new contact — no last_contact_date
    input.custom_cadence_days,
    now,
  );

  await db
    .prepare(
      `INSERT INTO contacts
         (id, user_id, name, phone, email, intent, custom_cadence_days,
          last_contact_date, health_status, notes, source, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, datetime('now'), datetime('now'))`
    )
    .bind(
      id,
      userId,
      input.name,
      input.phone ?? null,
      input.email ?? null,
      intent,
      input.custom_cadence_days ?? null,
      healthStatus,
      input.notes ?? null,
      input.source ?? 'manual',
    )
    .run();

  // Link to circles if provided
  if (input.circle_ids && input.circle_ids.length > 0) {
    await linkCircles(db, id, userId, input.circle_ids);
  }

  // Return the full contact with circles
  return getContactWithCircles(db, userId, id) as Promise<ContactWithCircles>;
}

// ===========================================================================
// Read
// ===========================================================================

/**
 * Get a single contact by ID, scoped to user.
 * Returns null if not found or belongs to a different user.
 */
export async function getContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<ContactRow | null> {
  return db
    .prepare('SELECT * FROM contacts WHERE id = ? AND user_id = ?')
    .bind(contactId, userId)
    .first<ContactRow>();
}

/**
 * Get a contact with its circles resolved.
 * Used by API responses and the dashboard detail view.
 */
export async function getContactWithCircles(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<ContactWithCircles | null> {
  const contact = await getContact(db, userId, contactId);
  if (!contact) return null;

  const circles = await getCirclesForContact(db, contactId);
  return { ...contact, circles };
}

/**
 * Get all circles linked to a contact.
 */
async function getCirclesForContact(
  db: D1Database,
  contactId: string,
): Promise<CircleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.* FROM circles c
       INNER JOIN contact_circles cc ON c.id = cc.circle_id
       WHERE cc.contact_id = ?
       ORDER BY c.sort_order`
    )
    .bind(contactId)
    .all<CircleRow>();

  return results;
}

// ===========================================================================
// Update
// ===========================================================================

/**
 * Update an existing contact.
 *
 * Only the fields present in the input are updated. If intent or
 * custom_cadence_days change, health status is recalculated.
 *
 * If circle_ids is provided, it REPLACES all existing circle links.
 * Omit circle_ids to leave links unchanged.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact to update
 * @param input     - Fields to update
 * @param now       - Override current time (for testing)
 * @returns The updated contact with circles, or null if not found
 */
export async function updateContact(
  db: D1Database,
  userId: string,
  contactId: string,
  input: UpdateContactInput,
  now?: Date,
): Promise<ContactWithCircles | null> {
  // Fetch current state for merge
  const existing = await getContact(db, userId, contactId);
  if (!existing) return null;

  // Build the SET clause dynamically from provided fields
  const sets: string[] = [];
  const binds: unknown[] = [];

  if (input.name !== undefined) {
    sets.push('name = ?');
    binds.push(input.name);
  }
  if (input.phone !== undefined) {
    sets.push('phone = ?');
    binds.push(input.phone);
  }
  if (input.email !== undefined) {
    sets.push('email = ?');
    binds.push(input.email);
  }
  if (input.intent !== undefined) {
    sets.push('intent = ?');
    binds.push(input.intent);
  }
  if (input.custom_cadence_days !== undefined) {
    sets.push('custom_cadence_days = ?');
    binds.push(input.custom_cadence_days);
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(input.notes);
  }
  if (input.archived !== undefined) {
    sets.push('archived = ?');
    binds.push(input.archived ? 1 : 0);
  }

  // Recalculate health if intent or cadence changed
  const effectiveIntent = input.intent ?? existing.intent;
  const effectiveCadence = input.custom_cadence_days !== undefined
    ? input.custom_cadence_days
    : existing.custom_cadence_days;

  if (input.intent !== undefined || input.custom_cadence_days !== undefined) {
    const newHealth = calculateHealthStatus(
      effectiveIntent,
      existing.last_contact_date,
      effectiveCadence,
      now,
    );
    sets.push('health_status = ?');
    binds.push(newHealth);
  }

  // Always touch updated_at
  sets.push("updated_at = datetime('now')");

  if (sets.length === 1) {
    // Only updated_at — nothing meaningful to change, but still valid
  }

  // Execute update
  binds.push(contactId, userId);
  await db
    .prepare(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
    )
    .bind(...binds)
    .run();

  // Replace circle links if provided
  if (input.circle_ids !== undefined) {
    await replaceCircleLinks(db, contactId, userId, input.circle_ids);
  }

  return getContactWithCircles(db, userId, contactId);
}

/**
 * Update a contact's last_contact_date and recalculate health.
 *
 * Called by the interaction logging flow — separated from updateContact
 * because it's a hot path that doesn't need the full update machinery.
 *
 * @param db          - D1 database binding
 * @param userId      - The owning user's ID
 * @param contactId   - The contact to touch
 * @param contactDate - The interaction date (ISO string)
 * @param now         - Override current time (for testing)
 */
export async function touchContactDate(
  db: D1Database,
  userId: string,
  contactId: string,
  contactDate: string,
  now?: Date,
): Promise<void> {
  // Fetch intent and cadence for health recalc
  const contact = await db
    .prepare(
      `SELECT intent, custom_cadence_days, last_contact_date
       FROM contacts WHERE id = ? AND user_id = ?`
    )
    .bind(contactId, userId)
    .first<Pick<ContactRow, 'intent' | 'custom_cadence_days' | 'last_contact_date'>>();

  if (!contact) return;

  // Only update if this interaction is more recent
  if (contact.last_contact_date && contactDate <= contact.last_contact_date) {
    return;
  }

  const newHealth = calculateHealthStatus(
    contact.intent,
    contactDate,
    contact.custom_cadence_days,
    now,
  );

  await db
    .prepare(
      `UPDATE contacts
       SET last_contact_date = ?,
           health_status = ?,
           updated_at = datetime('now')
       WHERE id = ? AND user_id = ?`
    )
    .bind(contactDate, newHealth, contactId, userId)
    .run();
}

// ===========================================================================
// Delete
// ===========================================================================

/**
 * Soft-delete a contact (set archived = 1).
 *
 * Archived contacts disappear from lists and don't generate nudges,
 * but can be restored. This is the default delete behavior.
 *
 * @returns true if the contact was found and archived, false if not found
 */
export async function archiveContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE contacts
       SET archived = 1, updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND archived = 0`
    )
    .bind(contactId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Restore an archived contact.
 */
export async function restoreContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE contacts
       SET archived = 0, updated_at = datetime('now')
       WHERE id = ? AND user_id = ? AND archived = 1`
    )
    .bind(contactId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Hard-delete a contact and all related data.
 *
 * Schema uses ON DELETE CASCADE, so this also removes:
 *   - contact_circles links
 *   - interactions for this contact
 *   - nudges for this contact
 *
 * Use sparingly — prefer archiveContact for normal "delete" UX.
 *
 * @returns true if the contact was found and deleted
 */
export async function deleteContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?')
    .bind(contactId, userId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

// ===========================================================================
// List & Filter
// ===========================================================================

/**
 * List contacts with filtering, sorting, and pagination.
 *
 * Filters are combined with AND logic. All filters are optional.
 * By default, only non-archived contacts are returned.
 *
 * Uses the schema's partial indexes for efficient queries:
 *   - idx_contacts_user_active for the base user+archived filter
 *   - idx_contacts_user_intent for intent filtering
 *   - idx_contacts_user_health for health filtering
 *
 * @param db         - D1 database binding
 * @param userId     - The owning user's ID
 * @param filters    - Optional filters (circle, intent, health, search, archived)
 * @param pagination - Limit, offset, sort options
 */
export async function listContacts(
  db: D1Database,
  userId: string,
  filters?: ContactListFilters,
  pagination?: PaginationOptions,
): Promise<ContactListResult> {
  const limit = pagination?.limit ?? 50;
  const offset = pagination?.offset ?? 0;
  const orderBy = pagination?.orderBy ?? 'name';
  const orderDir = pagination?.orderDir ?? 'asc';

  // Validate orderBy to prevent SQL injection
  const allowedOrderBy = ['name', 'last_contact_date', 'health_status', 'created_at'];
  const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'name';
  const safeOrderDir = orderDir === 'desc' ? 'DESC' : 'ASC';

  // Build WHERE clause
  const conditions: string[] = ['c.user_id = ?'];
  const binds: unknown[] = [userId];

  // Archived filter — default to non-archived
  const showArchived = filters?.archived ?? false;
  conditions.push('c.archived = ?');
  binds.push(showArchived ? 1 : 0);

  if (filters?.intent) {
    conditions.push('c.intent = ?');
    binds.push(filters.intent);
  }

  if (filters?.health_status) {
    conditions.push('c.health_status = ?');
    binds.push(filters.health_status);
  }

  if (filters?.search) {
    conditions.push('c.name LIKE ?');
    binds.push(`%${filters.search}%`);
  }

  // Circle filter requires a join
  let circleJoin = '';
  if (filters?.circle_id) {
    circleJoin = 'INNER JOIN contact_circles cc ON c.id = cc.contact_id';
    conditions.push('cc.circle_id = ?');
    binds.push(filters.circle_id);
  }

  const whereClause = conditions.join(' AND ');

  // Count total matching contacts
  const countResult = await db
    .prepare(
      `SELECT COUNT(DISTINCT c.id) as total
       FROM contacts c ${circleJoin}
       WHERE ${whereClause}`
    )
    .bind(...binds)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // Fetch the page of contacts as summaries
  // We need circles for the summary, so we do a left join + group
  const queryBinds = [...binds, limit, offset];
  const { results: rawContacts } = await db
    .prepare(
      `SELECT DISTINCT c.id, c.name, c.intent, c.health_status, c.last_contact_date
       FROM contacts c ${circleJoin}
       WHERE ${whereClause}
       ORDER BY c.${safeOrderBy} ${safeOrderDir}
       LIMIT ? OFFSET ?`
    )
    .bind(...queryBinds)
    .all<Pick<ContactRow, 'id' | 'name' | 'intent' | 'health_status' | 'last_contact_date'>>();

  // Batch-fetch circles for all contacts in this page
  const contacts: ContactSummary[] = [];
  if (rawContacts.length > 0) {
    const circleMap = await getCirclesForContacts(
      db,
      rawContacts.map((c) => c.id),
    );

    for (const row of rawContacts) {
      contacts.push({
        id: row.id,
        name: row.name,
        intent: row.intent,
        health_status: row.health_status,
        last_contact_date: row.last_contact_date,
        circles: circleMap.get(row.id) ?? [],
      });
    }
  }

  return { contacts, total, limit, offset };
}

/**
 * Search contacts by name (case-insensitive).
 *
 * Optimized for typeahead/autocomplete — returns lightweight summaries
 * with a low default limit.
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param query  - Search term (matched against name with LIKE %query%)
 * @param limit  - Max results (default 10)
 */
export async function searchContacts(
  db: D1Database,
  userId: string,
  query: string,
  limit: number = 10,
): Promise<ContactSummary[]> {
  if (!query.trim()) return [];

  const { results } = await db
    .prepare(
      `SELECT id, name, intent, health_status, last_contact_date
       FROM contacts
       WHERE user_id = ? AND archived = 0 AND name LIKE ?
       ORDER BY name COLLATE NOCASE
       LIMIT ?`
    )
    .bind(userId, `%${query}%`, limit)
    .all<Pick<ContactRow, 'id' | 'name' | 'intent' | 'health_status' | 'last_contact_date'>>();

  if (results.length === 0) return [];

  const circleMap = await getCirclesForContacts(
    db,
    results.map((c) => c.id),
  );

  return results.map((row) => ({
    id: row.id,
    name: row.name,
    intent: row.intent,
    health_status: row.health_status,
    last_contact_date: row.last_contact_date,
    circles: circleMap.get(row.id) ?? [],
  }));
}

// ===========================================================================
// Bulk Health Recalculation (Cron)
// ===========================================================================

/**
 * Recalculate health_status for all active contacts belonging to a user.
 *
 * Designed for a weekly cron job that keeps denormalized health values
 * fresh. Without this, a contact's status only updates on interaction
 * logging or profile edits.
 *
 * @param db     - D1 database binding
 * @param userId - The user whose contacts to recalculate
 * @param now    - Override current time (for testing)
 * @returns Number of contacts updated
 */
export async function recalculateHealthStatuses(
  db: D1Database,
  userId: string,
  now?: Date,
): Promise<{ updated: number }> {
  const { results: contacts } = await db
    .prepare(
      `SELECT id, intent, custom_cadence_days, last_contact_date, health_status
       FROM contacts
       WHERE user_id = ? AND archived = 0`
    )
    .bind(userId)
    .all<Pick<ContactRow, 'id' | 'intent' | 'custom_cadence_days' | 'last_contact_date' | 'health_status'>>();

  let updated = 0;

  for (const contact of contacts) {
    const newStatus = calculateHealthStatus(
      contact.intent,
      contact.last_contact_date,
      contact.custom_cadence_days,
      now,
    );

    if (newStatus !== contact.health_status) {
      await db
        .prepare(
          `UPDATE contacts
           SET health_status = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(newStatus, contact.id)
        .run();
      updated++;
    }
  }

  return { updated };
}

/**
 * Recalculate health for ALL users' contacts.
 * Top-level cron entry point.
 *
 * @param db  - D1 database binding
 * @param now - Override current time (for testing)
 */
export async function recalculateAllHealthStatuses(
  db: D1Database,
  now?: Date,
): Promise<{ usersProcessed: number; contactsUpdated: number }> {
  const { results: users } = await db
    .prepare('SELECT DISTINCT user_id FROM contacts WHERE archived = 0')
    .all<{ user_id: string }>();

  let totalUpdated = 0;
  for (const { user_id } of users) {
    const { updated } = await recalculateHealthStatuses(db, user_id, now);
    totalUpdated += updated;
  }

  return { usersProcessed: users.length, contactsUpdated: totalUpdated };
}

// ===========================================================================
// Count Helpers
// ===========================================================================

/**
 * Get the total count of active (non-archived) contacts for a user.
 * Used by subscription limit checks.
 */
export async function getContactCount(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db
    .prepare(
      'SELECT COUNT(*) as count FROM contacts WHERE user_id = ? AND archived = 0'
    )
    .bind(userId)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Get contact counts grouped by health status.
 * Used by the dashboard summary view.
 */
export async function getHealthCounts(
  db: D1Database,
  userId: string,
): Promise<Record<HealthStatus, number>> {
  const { results } = await db
    .prepare(
      `SELECT health_status, COUNT(*) as count
       FROM contacts
       WHERE user_id = ? AND archived = 0
       GROUP BY health_status`
    )
    .bind(userId)
    .all<{ health_status: HealthStatus; count: number }>();

  const counts: Record<HealthStatus, number> = {
    green: 0,
    yellow: 0,
    red: 0,
  };

  for (const row of results) {
    counts[row.health_status] = row.count;
  }

  return counts;
}

/**
 * Get contact counts grouped by intent type.
 * Used by the dashboard summary view.
 */
export async function getIntentCounts(
  db: D1Database,
  userId: string,
): Promise<Record<IntentType, number>> {
  const { results } = await db
    .prepare(
      `SELECT intent, COUNT(*) as count
       FROM contacts
       WHERE user_id = ? AND archived = 0
       GROUP BY intent`
    )
    .bind(userId)
    .all<{ intent: IntentType; count: number }>();

  const counts: Record<IntentType, number> = {
    inner_circle: 0,
    nurture: 0,
    maintain: 0,
    transactional: 0,
    dormant: 0,
    new: 0,
  };

  for (const row of results) {
    counts[row.intent] = row.count;
  }

  return counts;
}

// ===========================================================================
// Circle Linking (internal)
// ===========================================================================

/**
 * Link a contact to circles. Validates that circles belong to the same user.
 * Silently skips invalid circle IDs.
 */
async function linkCircles(
  db: D1Database,
  contactId: string,
  userId: string,
  circleIds: string[],
): Promise<void> {
  if (circleIds.length === 0) return;

  // Validate circles belong to this user
  const placeholders = circleIds.map(() => '?').join(', ');
  const { results: validCircles } = await db
    .prepare(
      `SELECT id FROM circles WHERE id IN (${placeholders}) AND user_id = ?`
    )
    .bind(...circleIds, userId)
    .all<{ id: string }>();

  const validIds = new Set(validCircles.map((c) => c.id));

  // Batch insert — D1 doesn't support multi-row INSERT, so we use a batch
  const stmts = circleIds
    .filter((id) => validIds.has(id))
    .map((circleId) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO contact_circles (contact_id, circle_id, added_at)
           VALUES (?, ?, datetime('now'))`
        )
        .bind(contactId, circleId)
    );

  if (stmts.length > 0) {
    await db.batch(stmts);
  }
}

/**
 * Replace all circle links for a contact.
 * Deletes existing links, then inserts new ones.
 */
async function replaceCircleLinks(
  db: D1Database,
  contactId: string,
  userId: string,
  circleIds: string[],
): Promise<void> {
  // Delete existing links
  await db
    .prepare('DELETE FROM contact_circles WHERE contact_id = ?')
    .bind(contactId)
    .run();

  // Insert new links
  if (circleIds.length > 0) {
    await linkCircles(db, contactId, userId, circleIds);
  }
}

/**
 * Batch-fetch circles for multiple contacts.
 * Returns a Map of contactId → array of {id, name}.
 *
 * Used by list/search to avoid N+1 queries.
 */
async function getCirclesForContacts(
  db: D1Database,
  contactIds: string[],
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string }>>();
  if (contactIds.length === 0) return map;

  const placeholders = contactIds.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT cc.contact_id, c.id, c.name
       FROM contact_circles cc
       INNER JOIN circles c ON cc.circle_id = c.id
       WHERE cc.contact_id IN (${placeholders})
       ORDER BY c.sort_order`
    )
    .bind(...contactIds)
    .all<{ contact_id: string; id: string; name: string }>();

  for (const row of results) {
    const existing = map.get(row.contact_id) ?? [];
    existing.push({ id: row.id, name: row.name });
    map.set(row.contact_id, existing);
  }

  return map;
}
