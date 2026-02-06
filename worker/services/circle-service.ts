/**
 * Circle Management Service — CRUD, contact linking, and default initialization.
 *
 * Circles are named groups for organizing contacts (Family, Friends, Work,
 * DJ Business, Real Estate, etc.). Each user gets default circles on signup
 * and can create custom ones.
 *
 * Key constraints:
 *
 *   - Circle names are unique per user (UNIQUE(user_id, name) in schema)
 *   - Default circles (type = 'default') can be renamed but not deleted
 *   - Custom circles (type = 'custom') can be deleted — cascades through
 *     contact_circles junction, but does NOT delete the contacts themselves
 *   - Contacts can belong to multiple circles (many-to-many)
 *
 * Sort order:
 *
 *   Circles have a sort_order field for display ordering. Default circles
 *   get sort_order 1–4. Custom circles default to max(sort_order) + 1.
 *   Reordering is supported via updateCircle or reorderCircles.
 *
 * Usage:
 *
 *   // On new user signup
 *   await initializeDefaultCircles(db, userId);
 *
 *   // User creates a custom circle
 *   const circle = await createCircle(db, userId, {
 *     name: 'DJ Business',
 *     default_cadence_days: 14,
 *   });
 *
 *   // Add a contact to the circle
 *   await addContactToCircle(db, userId, contactId, circle.id);
 *
 * @see shared/models.ts for CircleRow, DEFAULT_CIRCLES, CircleType
 * @see worker/services/contact-service.ts for contact-side circle operations
 */

import type {
  CircleRow,
  ContactSummary,
  CircleType,
  ContactRow,
} from '../../shared/models';
import { DEFAULT_CIRCLES } from '../../shared/models';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Input for creating a new circle.
 */
export interface CreateCircleInput {
  name: string;
  default_cadence_days?: number | null;
  sort_order?: number;
}

/**
 * Input for updating an existing circle.
 */
export interface UpdateCircleInput {
  name?: string;
  default_cadence_days?: number | null;
  sort_order?: number;
}

/**
 * Circle with a count of its contacts.
 */
export interface CircleWithCount extends CircleRow {
  contact_count: number;
}

/**
 * Result of a delete attempt.
 */
export interface DeleteCircleResult {
  deleted: boolean;
  reason?: string;
}

// ===========================================================================
// Create
// ===========================================================================

/**
 * Create a custom circle for a user.
 *
 * If sort_order is not provided, the new circle is placed at the end
 * (max existing sort_order + 1).
 *
 * @param db     - D1 database binding
 * @param userId - The owning user's ID
 * @param input  - Circle creation fields
 * @returns The created circle
 * @throws If circle name already exists for this user (UNIQUE constraint)
 */
export async function createCircle(
  db: D1Database,
  userId: string,
  input: CreateCircleInput,
): Promise<CircleRow> {
  const id = crypto.randomUUID();

  // Determine sort_order
  let sortOrder = input.sort_order;
  if (sortOrder === undefined) {
    const maxResult = await db
      .prepare(
        'SELECT MAX(sort_order) as max_order FROM circles WHERE user_id = ?'
      )
      .bind(userId)
      .first<{ max_order: number | null }>();
    sortOrder = (maxResult?.max_order ?? 0) + 1;
  }

  try {
    await db
      .prepare(
        `INSERT INTO circles
           (id, user_id, name, type, default_cadence_days, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, 'custom', ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(
        id,
        userId,
        input.name.trim(),
        input.default_cadence_days ?? null,
        sortOrder,
      )
      .run();
  } catch (err: unknown) {
    // Check for unique constraint violation
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new CircleNameExistsError(input.name);
    }
    throw err;
  }

  return (await getCircle(db, userId, id))!;
}

/**
 * Initialize default circles for a new user.
 *
 * Creates the four default circles defined in models.ts:
 * Family (1), Friends (2), Work (3), Community (4).
 *
 * Safe to call multiple times — uses INSERT OR IGNORE to skip
 * circles that already exist (matched by UNIQUE(user_id, name)).
 *
 * @param db     - D1 database binding
 * @param userId - The user to initialize
 * @returns Number of circles created (0–4)
 */
export async function initializeDefaultCircles(
  db: D1Database,
  userId: string,
): Promise<{ created: number }> {
  const stmts = DEFAULT_CIRCLES.map((circle) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO circles
           (id, user_id, name, type, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
      .bind(
        crypto.randomUUID(),
        userId,
        circle.name,
        circle.type,
        circle.sort_order,
      )
  );

  const results = await db.batch(stmts);

  const created = results.reduce(
    (sum, r) => sum + (r.meta.changes ?? 0),
    0,
  );

  return { created };
}

// ===========================================================================
// Read
// ===========================================================================

/**
 * Get a single circle by ID, scoped to user.
 * Returns null if not found or belongs to a different user.
 */
export async function getCircle(
  db: D1Database,
  userId: string,
  circleId: string,
): Promise<CircleRow | null> {
  return db
    .prepare('SELECT * FROM circles WHERE id = ? AND user_id = ?')
    .bind(circleId, userId)
    .first<CircleRow>();
}

/**
 * Get a circle by name, scoped to user.
 * Useful for braindump flows that reference circles by name.
 */
export async function getCircleByName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<CircleRow | null> {
  return db
    .prepare(
      'SELECT * FROM circles WHERE user_id = ? AND name = ? COLLATE NOCASE'
    )
    .bind(userId, name)
    .first<CircleRow>();
}

/**
 * List all circles for a user, ordered by sort_order.
 */
export async function listCircles(
  db: D1Database,
  userId: string,
): Promise<CircleRow[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM circles WHERE user_id = ? ORDER BY sort_order, name'
    )
    .bind(userId)
    .all<CircleRow>();

  return results;
}

/**
 * List all circles with contact counts.
 * Used by the dashboard sidebar and circle management views.
 */
export async function listCirclesWithCounts(
  db: D1Database,
  userId: string,
): Promise<CircleWithCount[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*,
              COUNT(cc.contact_id) as contact_count
       FROM circles c
       LEFT JOIN contact_circles cc ON c.id = cc.circle_id
       LEFT JOIN contacts ct ON cc.contact_id = ct.id AND ct.archived = 0
       WHERE c.user_id = ?
       GROUP BY c.id
       ORDER BY c.sort_order, c.name`
    )
    .bind(userId)
    .all<CircleWithCount>();

  return results;
}

// ===========================================================================
// Update
// ===========================================================================

/**
 * Update an existing circle.
 *
 * Only the fields present in the input are updated.
 * Default circles can be renamed and have their cadence changed,
 * but their type stays 'default'.
 *
 * @param db       - D1 database binding
 * @param userId   - The owning user's ID
 * @param circleId - The circle to update
 * @param input    - Fields to update
 * @returns The updated circle, or null if not found
 * @throws If new name conflicts with an existing circle
 */
export async function updateCircle(
  db: D1Database,
  userId: string,
  circleId: string,
  input: UpdateCircleInput,
): Promise<CircleRow | null> {
  const existing = await getCircle(db, userId, circleId);
  if (!existing) return null;

  const sets: string[] = [];
  const binds: unknown[] = [];

  if (input.name !== undefined) {
    sets.push('name = ?');
    binds.push(input.name.trim());
  }
  if (input.default_cadence_days !== undefined) {
    sets.push('default_cadence_days = ?');
    binds.push(input.default_cadence_days);
  }
  if (input.sort_order !== undefined) {
    sets.push('sort_order = ?');
    binds.push(input.sort_order);
  }

  sets.push("updated_at = datetime('now')");

  binds.push(circleId, userId);

  try {
    await db
      .prepare(
        `UPDATE circles SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
      )
      .bind(...binds)
      .run();
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      throw new CircleNameExistsError(input.name ?? existing.name);
    }
    throw err;
  }

  return getCircle(db, userId, circleId);
}

/**
 * Reorder circles by providing an array of circle IDs in the desired order.
 *
 * Sets sort_order = index position for each circle. Circles not in the
 * array keep their current sort_order.
 *
 * @param db       - D1 database binding
 * @param userId   - The owning user's ID
 * @param circleIds - Array of circle IDs in desired display order
 */
export async function reorderCircles(
  db: D1Database,
  userId: string,
  circleIds: string[],
): Promise<void> {
  if (circleIds.length === 0) return;

  const stmts = circleIds.map((id, index) =>
    db
      .prepare(
        `UPDATE circles
         SET sort_order = ?, updated_at = datetime('now')
         WHERE id = ? AND user_id = ?`
      )
      .bind(index + 1, id, userId)
  );

  await db.batch(stmts);
}

// ===========================================================================
// Delete
// ===========================================================================

/**
 * Delete a circle.
 *
 * Default circles cannot be deleted — they're core organizational
 * structure. Custom circles can be deleted freely.
 *
 * Deletion cascades through contact_circles (removing the links),
 * but does NOT delete the contacts themselves. Contacts that were
 * only in this circle become "unlinked" but still exist.
 *
 * @param db       - D1 database binding
 * @param userId   - The owning user's ID
 * @param circleId - The circle to delete
 * @returns Result with deleted status and reason if blocked
 */
export async function deleteCircle(
  db: D1Database,
  userId: string,
  circleId: string,
): Promise<DeleteCircleResult> {
  const circle = await getCircle(db, userId, circleId);
  if (!circle) {
    return { deleted: false, reason: 'Circle not found.' };
  }

  if (circle.type === 'default') {
    return {
      deleted: false,
      reason: `"${circle.name}" is a default circle and can't be deleted. You can rename it if you'd like.`,
    };
  }

  await db
    .prepare('DELETE FROM circles WHERE id = ? AND user_id = ?')
    .bind(circleId, userId)
    .run();

  return { deleted: true };
}

// ===========================================================================
// Contact ↔ Circle Linking
// ===========================================================================

/**
 * Add a contact to a circle.
 *
 * Validates that both the contact and circle belong to the user.
 * Uses INSERT OR IGNORE — safe to call if the link already exists.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact to add
 * @param circleId  - The circle to add them to
 * @returns true if the link was created, false if it already existed or inputs were invalid
 */
export async function addContactToCircle(
  db: D1Database,
  userId: string,
  contactId: string,
  circleId: string,
): Promise<boolean> {
  // Validate ownership of both entities
  const [contact, circle] = await Promise.all([
    db
      .prepare('SELECT id FROM contacts WHERE id = ? AND user_id = ?')
      .bind(contactId, userId)
      .first<{ id: string }>(),
    db
      .prepare('SELECT id FROM circles WHERE id = ? AND user_id = ?')
      .bind(circleId, userId)
      .first<{ id: string }>(),
  ]);

  if (!contact || !circle) return false;

  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO contact_circles (contact_id, circle_id, added_at)
       VALUES (?, ?, datetime('now'))`
    )
    .bind(contactId, circleId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Remove a contact from a circle.
 *
 * Does NOT delete the contact — just removes the circle membership.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact to remove
 * @param circleId  - The circle to remove them from
 * @returns true if the link was removed, false if it didn't exist
 */
export async function removeContactFromCircle(
  db: D1Database,
  userId: string,
  contactId: string,
  circleId: string,
): Promise<boolean> {
  // Validate ownership — we check the circle belongs to the user.
  // The contact_circles junction doesn't store user_id, so we verify
  // via the circle's ownership.
  const circle = await db
    .prepare('SELECT id FROM circles WHERE id = ? AND user_id = ?')
    .bind(circleId, userId)
    .first<{ id: string }>();

  if (!circle) return false;

  const result = await db
    .prepare(
      'DELETE FROM contact_circles WHERE contact_id = ? AND circle_id = ?'
    )
    .bind(contactId, circleId)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Get all contacts in a circle as summaries.
 *
 * Only returns non-archived contacts. Includes their other circle
 * memberships for the summary view.
 *
 * @param db       - D1 database binding
 * @param userId   - The owning user's ID
 * @param circleId - The circle to list
 * @param limit    - Max results (default 50)
 * @param offset   - Pagination offset (default 0)
 */
export async function getContactsInCircle(
  db: D1Database,
  userId: string,
  circleId: string,
  limit: number = 50,
  offset: number = 0,
): Promise<{ contacts: ContactSummary[]; total: number }> {
  // Verify circle ownership
  const circle = await getCircle(db, userId, circleId);
  if (!circle) return { contacts: [], total: 0 };

  // Count total
  const countResult = await db
    .prepare(
      `SELECT COUNT(*) as total
       FROM contact_circles cc
       INNER JOIN contacts c ON cc.contact_id = c.id
       WHERE cc.circle_id = ? AND c.user_id = ? AND c.archived = 0`
    )
    .bind(circleId, userId)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  // Fetch contacts
  const { results: rawContacts } = await db
    .prepare(
      `SELECT c.id, c.name, c.intent, c.health_status, c.last_contact_date
       FROM contact_circles cc
       INNER JOIN contacts c ON cc.contact_id = c.id
       WHERE cc.circle_id = ? AND c.user_id = ? AND c.archived = 0
       ORDER BY c.name COLLATE NOCASE
       LIMIT ? OFFSET ?`
    )
    .bind(circleId, userId, limit, offset)
    .all<Pick<ContactRow, 'id' | 'name' | 'intent' | 'health_status' | 'last_contact_date'>>();

  if (rawContacts.length === 0) return { contacts: [], total };

  // Batch-fetch all circle memberships for these contacts
  const contactIds = rawContacts.map((c) => c.id);
  const circleMap = await getCircleSummariesForContacts(db, contactIds);

  const contacts: ContactSummary[] = rawContacts.map((row) => ({
    id: row.id,
    name: row.name,
    intent: row.intent,
    health_status: row.health_status,
    last_contact_date: row.last_contact_date,
    circles: circleMap.get(row.id) ?? [],
  }));

  return { contacts, total };
}

/**
 * Get circles a specific contact belongs to.
 *
 * @param db        - D1 database binding
 * @param userId    - The owning user's ID
 * @param contactId - The contact to check
 */
export async function getCirclesForContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<CircleRow[]> {
  const { results } = await db
    .prepare(
      `SELECT c.*
       FROM circles c
       INNER JOIN contact_circles cc ON c.id = cc.circle_id
       WHERE cc.contact_id = ? AND c.user_id = ?
       ORDER BY c.sort_order`
    )
    .bind(contactId, userId)
    .all<CircleRow>();

  return results;
}

/**
 * Move a contact from one circle to another.
 * Convenience wrapper — removes from source, adds to target.
 *
 * @returns true if both operations succeeded
 */
export async function moveContactBetweenCircles(
  db: D1Database,
  userId: string,
  contactId: string,
  fromCircleId: string,
  toCircleId: string,
): Promise<boolean> {
  const removed = await removeContactFromCircle(db, userId, contactId, fromCircleId);
  if (!removed) return false;

  return addContactToCircle(db, userId, contactId, toCircleId);
}

// ===========================================================================
// Helpers (internal)
// ===========================================================================

/**
 * Batch-fetch circle summaries for multiple contacts.
 * Returns Map of contactId → [{id, name}].
 *
 * Same pattern as contact-service's getCirclesForContacts but exported
 * at the circle-service level for use by getContactsInCircle.
 */
async function getCircleSummariesForContacts(
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

// ===========================================================================
// Error Types
// ===========================================================================

/**
 * Thrown when a circle name conflicts with an existing circle for the user.
 */
export class CircleNameExistsError extends Error {
  public readonly circleName: string;

  constructor(name: string) {
    super(`A circle named "${name}" already exists.`);
    this.name = 'CircleNameExistsError';
    this.circleName = name;
  }
}
