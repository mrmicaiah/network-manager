/**
 * Contact Management Service — CRUD, filtering, search, and circle linking.
 *
 * @see shared/models.ts for ContactRow, CreateContactInput, UpdateContactInput, ContactListFilters
 * @see shared/intent-config.ts for calculateHealthStatus()
 * @see shared/point-config.ts for dartboard scoring
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
  ContactKind,
} from '../../shared/models';
import { calculateHealthStatus } from '../../shared/intent-config';

// ===========================================================================
// Types
// ===========================================================================

export interface ContactListResult {
  contacts: ContactSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'last_contact_date' | 'health_status' | 'created_at';
  orderDir?: 'asc' | 'desc';
}

// ===========================================================================
// Create
// ===========================================================================

export async function createContact(
  db: D1Database,
  userId: string,
  input: CreateContactInput,
  now?: Date,
): Promise<ContactWithCircles> {
  const id = crypto.randomUUID();
  const intent: IntentType = input.intent ?? 'new';
  const contactKind: ContactKind = input.contact_kind ?? 'non_kin';
  const healthStatus = calculateHealthStatus(
    intent,
    null,
    input.custom_cadence_days,
    now,
  );

  console.log(`[createContact] START — id=${id}, userId=${userId}, name="${input.name}", intent=${intent}, health=${healthStatus}, source=${input.source ?? 'manual'}`);

  const result = await db
    .prepare(
      `INSERT INTO contacts
         (id, user_id, name, phone, email, intent, custom_cadence_days,
          last_contact_date, health_status, contact_kind, preferred_method,
          notes, source, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))`
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
      contactKind,
      input.preferred_method ?? null,
      input.notes ?? null,
      input.source ?? 'manual',
    )
    .run();

  console.log(`[createContact] INSERT result — success=${result.success}, changes=${result.meta.changes}, duration=${result.meta.duration}ms, last_row_id=${result.meta.last_row_id}`);

  if (!result.success) {
    console.error(`[createContact] INSERT FAILED — D1 reported success=false for id=${id}`);
    throw new Error(`D1 INSERT failed for contact ${id}: success=false`);
  }

  if ((result.meta.changes ?? 0) === 0) {
    console.error(`[createContact] INSERT wrote 0 rows — id=${id}, this should not happen`);
    throw new Error(`D1 INSERT wrote 0 rows for contact ${id}`);
  }

  // Link to circles if provided
  if (input.circle_ids && input.circle_ids.length > 0) {
    await linkCircles(db, id, userId, input.circle_ids);
  }

  // Verify the row exists by reading it back
  const created = await getContactWithCircles(db, userId, id);

  if (!created) {
    console.error(`[createContact] READ-BACK FAILED — INSERT claimed success but SELECT returned null for id=${id}, userId=${userId}`);
    throw new Error(`Contact ${id} not found after INSERT (phantom write)`);
  }

  console.log(`[createContact] SUCCESS — verified contact ${created.id} (${created.name}) exists in DB`);

  return created;
}

// ===========================================================================
// Read
// ===========================================================================

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

export async function updateContact(
  db: D1Database,
  userId: string,
  contactId: string,
  input: UpdateContactInput,
  now?: Date,
): Promise<ContactWithCircles | null> {
  const existing = await getContact(db, userId, contactId);
  if (!existing) return null;

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
  if (input.contact_kind !== undefined) {
    sets.push('contact_kind = ?');
    binds.push(input.contact_kind);
  }
  if (input.preferred_method !== undefined) {
    sets.push('preferred_method = ?');
    binds.push(input.preferred_method);
  }
  if (input.notes !== undefined) {
    sets.push('notes = ?');
    binds.push(input.notes);
  }
  if (input.archived !== undefined) {
    sets.push('archived = ?');
    binds.push(input.archived ? 1 : 0);
  }

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

  sets.push("updated_at = datetime('now')");

  binds.push(contactId, userId);
  await db
    .prepare(
      `UPDATE contacts SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
    )
    .bind(...binds)
    .run();

  if (input.circle_ids !== undefined) {
    await replaceCircleLinks(db, contactId, userId, input.circle_ids);
  }

  return getContactWithCircles(db, userId, contactId);
}

export async function touchContactDate(
  db: D1Database,
  userId: string,
  contactId: string,
  contactDate: string,
  now?: Date,
): Promise<void> {
  const contact = await db
    .prepare(
      `SELECT intent, custom_cadence_days, last_contact_date
       FROM contacts WHERE id = ? AND user_id = ?`
    )
    .bind(contactId, userId)
    .first<Pick<ContactRow, 'intent' | 'custom_cadence_days' | 'last_contact_date'>>();

  if (!contact) return;

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

  const allowedOrderBy = ['name', 'last_contact_date', 'health_status', 'created_at'];
  const safeOrderBy = allowedOrderBy.includes(orderBy) ? orderBy : 'name';
  const safeOrderDir = orderDir === 'desc' ? 'DESC' : 'ASC';

  const conditions: string[] = ['c.user_id = ?'];
  const binds: unknown[] = [userId];

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

  if (filters?.contact_kind) {
    conditions.push('c.contact_kind = ?');
    binds.push(filters.contact_kind);
  }

  if (filters?.search) {
    conditions.push('c.name LIKE ?');
    binds.push(`%${filters.search}%`);
  }

  let circleJoin = '';
  if (filters?.circle_id) {
    circleJoin = 'INNER JOIN contact_circles cc ON c.id = cc.contact_id';
    conditions.push('cc.circle_id = ?');
    binds.push(filters.circle_id);
  }

  const whereClause = conditions.join(' AND ');

  const countResult = await db
    .prepare(
      `SELECT COUNT(DISTINCT c.id) as total
       FROM contacts c ${circleJoin}
       WHERE ${whereClause}`
    )
    .bind(...binds)
    .first<{ total: number }>();

  const total = countResult?.total ?? 0;

  const queryBinds = [...binds, limit, offset];
  const { results: rawContacts } = await db
    .prepare(
      `SELECT DISTINCT c.id, c.name, c.intent, c.health_status, c.contact_kind, c.last_contact_date
       FROM contacts c ${circleJoin}
       WHERE ${whereClause}
       ORDER BY c.${safeOrderBy} ${safeOrderDir}
       LIMIT ? OFFSET ?`
    )
    .bind(...queryBinds)
    .all<Pick<ContactRow, 'id' | 'name' | 'intent' | 'health_status' | 'contact_kind' | 'last_contact_date'>>();

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
        contact_kind: row.contact_kind,
        last_contact_date: row.last_contact_date,
        circles: circleMap.get(row.id) ?? [],
      });
    }
  }

  return { contacts, total, limit, offset };
}

export async function searchContacts(
  db: D1Database,
  userId: string,
  query: string,
  limit: number = 10,
): Promise<ContactSummary[]> {
  if (!query.trim()) return [];

  const { results } = await db
    .prepare(
      `SELECT id, name, intent, health_status, contact_kind, last_contact_date
       FROM contacts
       WHERE user_id = ? AND archived = 0 AND name LIKE ?
       ORDER BY name COLLATE NOCASE
       LIMIT ?`
    )
    .bind(userId, `%${query}%`, limit)
    .all<Pick<ContactRow, 'id' | 'name' | 'intent' | 'health_status' | 'contact_kind' | 'last_contact_date'>>();

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
    contact_kind: row.contact_kind,
    last_contact_date: row.last_contact_date,
    circles: circleMap.get(row.id) ?? [],
  }));
}

// ===========================================================================
// Bulk Health Recalculation (Cron)
// ===========================================================================

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

  const counts: Record<HealthStatus, number> = { green: 0, yellow: 0, red: 0 };
  for (const row of results) {
    counts[row.health_status] = row.count;
  }
  return counts;
}

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
    inner_circle: 0, nurture: 0, maintain: 0,
    transactional: 0, dormant: 0, new: 0,
  };
  for (const row of results) {
    counts[row.intent] = row.count;
  }
  return counts;
}

// ===========================================================================
// Circle Linking (internal)
// ===========================================================================

async function linkCircles(
  db: D1Database,
  contactId: string,
  userId: string,
  circleIds: string[],
): Promise<void> {
  if (circleIds.length === 0) return;

  const placeholders = circleIds.map(() => '?').join(', ');
  const { results: validCircles } = await db
    .prepare(
      `SELECT id FROM circles WHERE id IN (${placeholders}) AND user_id = ?`
    )
    .bind(...circleIds, userId)
    .all<{ id: string }>();

  const validIds = new Set(validCircles.map((c) => c.id));

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

async function replaceCircleLinks(
  db: D1Database,
  contactId: string,
  userId: string,
  circleIds: string[],
): Promise<void> {
  await db
    .prepare('DELETE FROM contact_circles WHERE contact_id = ?')
    .bind(contactId)
    .run();

  if (circleIds.length > 0) {
    await linkCircles(db, contactId, userId, circleIds);
  }
}

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
