/**
 * Contact Service — CRUD operations for user contacts.
 *
 * Contacts are the core data model in the Network Manager. Each contact:
 *   - Belongs to one user (user_id)
 *   - Has a relationship layer (intent: inner_circle, nurture, etc.)
 *   - Has a health status (green, yellow, red) based on last contact date
 *   - Can belong to multiple circles (many-to-many via contact_circles)
 *
 * Health status is calculated based on:
 *   - Intent-specific cadence (inner_circle = 7 days, nurture = 14, etc.)
 *   - Optional custom cadence override per contact
 *   - Modifiers for kin relationships and new contacts
 *
 * @see shared/models.ts for ContactRow, IntentType, HealthStatus
 * @see shared/intent-config.ts for cadence configuration
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
  ContactRow,
  ContactWithCircles,
  CreateContactInput,
  UpdateContactInput,
  ContactListFilters,
  IntentType,
  HealthStatus,
  ContactKind,
} from '../../shared/models';
import { calculateHealthStatus, INTENT_CONFIGS } from '../../shared/intent-config';

// ===========================================================================
// Types
// ===========================================================================

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  orderBy?: 'name' | 'last_contact_date' | 'created_at' | 'health_status';
  orderDir?: 'asc' | 'desc';
}

export interface ContactListResult {
  contacts: ContactWithCircles[];
  total: number;
  hasMore: boolean;
}

// ===========================================================================
// Nickname Mappings for Duplicate Detection
// ===========================================================================

/**
 * Common nickname to formal name mappings.
 * Bidirectional — both directions are checked.
 */
const NICKNAME_MAP: Record<string, string[]> = {
  // Male names
  'bob': ['robert', 'bobby', 'rob'],
  'robert': ['bob', 'bobby', 'rob', 'bert'],
  'rob': ['robert', 'bob', 'robbie'],
  'bill': ['william', 'billy', 'will'],
  'william': ['bill', 'billy', 'will', 'liam'],
  'will': ['william', 'bill', 'billy'],
  'jim': ['james', 'jimmy', 'jamie'],
  'james': ['jim', 'jimmy', 'jamie'],
  'mike': ['michael', 'mikey', 'mick'],
  'michael': ['mike', 'mikey', 'mick'],
  'dick': ['richard', 'rick', 'richie'],
  'richard': ['dick', 'rick', 'richie', 'ricky'],
  'rick': ['richard', 'dick', 'ricky'],
  'tom': ['thomas', 'tommy'],
  'thomas': ['tom', 'tommy'],
  'dave': ['david', 'davy'],
  'david': ['dave', 'davy'],
  'dan': ['daniel', 'danny'],
  'daniel': ['dan', 'danny'],
  'joe': ['joseph', 'joey'],
  'joseph': ['joe', 'joey'],
  'jack': ['john', 'johnny', 'jackson'],
  'john': ['jack', 'johnny', 'jon'],
  'jon': ['jonathan', 'john', 'johnny'],
  'jonathan': ['jon', 'john', 'johnny'],
  'steve': ['steven', 'stephen', 'stevie'],
  'steven': ['steve', 'stevie'],
  'stephen': ['steve', 'stevie'],
  'tony': ['anthony', 'ant'],
  'anthony': ['tony', 'ant'],
  'chris': ['christopher', 'christy'],
  'christopher': ['chris', 'christy', 'topher'],
  'matt': ['matthew', 'matty'],
  'matthew': ['matt', 'matty'],
  'alex': ['alexander', 'alexandra', 'alexis'],
  'alexander': ['alex', 'xander'],
  'nick': ['nicholas', 'nicky'],
  'nicholas': ['nick', 'nicky'],
  'pat': ['patrick', 'patricia', 'patty'],
  'patrick': ['pat', 'patty', 'paddy'],
  'sam': ['samuel', 'samantha', 'sammy'],
  'samuel': ['sam', 'sammy'],
  'ben': ['benjamin', 'benny'],
  'benjamin': ['ben', 'benny'],
  'ted': ['theodore', 'teddy', 'edward'],
  'theodore': ['ted', 'teddy', 'theo'],
  'ed': ['edward', 'eddie', 'ted'],
  'edward': ['ed', 'eddie', 'ted', 'teddy'],
  'charlie': ['charles', 'chuck', 'chas'],
  'charles': ['charlie', 'chuck', 'chas'],
  'chuck': ['charles', 'charlie'],
  'frank': ['francis', 'frankie'],
  'francis': ['frank', 'frankie', 'fran'],
  'larry': ['lawrence', 'laurence'],
  'lawrence': ['larry', 'laurie'],
  'harry': ['harold', 'henry'],
  'harold': ['harry', 'hal'],
  'henry': ['harry', 'hank'],
  'hank': ['henry'],
  'greg': ['gregory'],
  'gregory': ['greg'],
  'pete': ['peter'],
  'peter': ['pete'],
  
  // Female names
  'liz': ['elizabeth', 'lizzy', 'beth', 'betty'],
  'elizabeth': ['liz', 'lizzy', 'beth', 'betty', 'eliza'],
  'beth': ['elizabeth', 'bethany'],
  'betty': ['elizabeth'],
  'kate': ['katherine', 'catherine', 'kathy', 'katie'],
  'katherine': ['kate', 'kathy', 'katie', 'kitty'],
  'catherine': ['kate', 'kathy', 'cathy', 'cat'],
  'kathy': ['katherine', 'catherine', 'kate'],
  'cathy': ['catherine'],
  'jen': ['jennifer', 'jenny'],
  'jennifer': ['jen', 'jenny', 'jenn'],
  'jenny': ['jennifer', 'jen'],
  'meg': ['margaret', 'megan', 'meghan'],
  'margaret': ['meg', 'maggie', 'peggy', 'marge'],
  'sue': ['susan', 'susie', 'suzanne'],
  'susan': ['sue', 'susie', 'suzy'],
  'deb': ['deborah', 'debbie', 'debra'],
  'deborah': ['deb', 'debbie'],
  'samantha': ['sam', 'sammy'],
  'vicky': ['victoria', 'vic', 'tori'],
  'victoria': ['vicky', 'vic', 'tori'],
  'becky': ['rebecca', 'becca'],
  'rebecca': ['becky', 'becca'],
  'mandy': ['amanda'],
  'amanda': ['mandy'],
  'kim': ['kimberly', 'kimmy'],
  'kimberly': ['kim', 'kimmy'],
  'jess': ['jessica', 'jessie'],
  'jessica': ['jess', 'jessie'],
  'chris': ['christina', 'christine', 'christy'],
  'christina': ['chris', 'tina', 'christy'],
  'christine': ['chris', 'christy'],
  'ann': ['anne', 'anna', 'annie'],
  'anne': ['ann', 'anna', 'annie'],
  'anna': ['ann', 'anne', 'annie'],
  'mary': ['marie', 'maria'],
  'marie': ['mary', 'maria'],
  'nancy': ['nan', 'annie'],
  'barb': ['barbara', 'barbie'],
  'barbara': ['barb', 'barbie'],
  'pam': ['pamela'],
  'pamela': ['pam'],
  'diane': ['di'],
  'jackie': ['jacqueline'],
  'jacqueline': ['jackie'],
  'terri': ['teresa', 'theresa'],
  'teresa': ['terri', 'tess'],
  'theresa': ['terri', 'tess'],
  'abby': ['abigail'],
  'abigail': ['abby', 'gail'],
  'maddie': ['madison', 'madeline'],
  'madison': ['maddie'],
  'madeline': ['maddie'],
  'ally': ['allison', 'alison'],
  'allison': ['ally', 'ali'],
  'alison': ['ally', 'ali'],
  'emma': ['emily', 'em'],
  'emily': ['emma', 'em'],
  'sophie': ['sophia'],
  'sophia': ['sophie'],
};

// ===========================================================================
// Levenshtein Distance for Fuzzy Matching
// ===========================================================================

/**
 * Calculate Levenshtein distance between two strings.
 * Lower distance = more similar.
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score (0-1) based on Levenshtein distance.
 */
function calculateSimilarity(a: string, b: string): number {
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  
  if (longer.length === 0) return 1.0;
  
  const distance = levenshteinDistance(longer.toLowerCase(), shorter.toLowerCase());
  return (longer.length - distance) / longer.length;
}

/**
 * Check if two names are nickname variants of each other.
 */
function areNicknameVariants(name1: string, name2: string): boolean {
  const n1 = name1.toLowerCase();
  const n2 = name2.toLowerCase();
  
  // Direct match
  if (n1 === n2) return true;
  
  // Check nickname mappings
  const n1Variants = NICKNAME_MAP[n1] ?? [];
  const n2Variants = NICKNAME_MAP[n2] ?? [];
  
  return n1Variants.includes(n2) || n2Variants.includes(n1);
}

// ===========================================================================
// Duplicate Detection
// ===========================================================================

export interface PotentialDuplicate {
  existingContactId: string;
  existingName: string;
  newName: string;
  similarity: number;
  matchReason: 'exact' | 'fuzzy' | 'nickname';
}

/**
 * Find potential duplicate contacts by name.
 * Returns matches above similarity threshold, sorted by confidence.
 *
 * @param db - D1 database
 * @param userId - User's ID
 * @param newName - Name to check for duplicates
 * @param threshold - Minimum similarity (0-1), default 0.7
 * @returns Array of potential duplicates
 */
export async function findPotentialDuplicates(
  db: D1Database,
  userId: string,
  newName: string,
  threshold: number = 0.7,
): Promise<PotentialDuplicate[]> {
  // Get all existing contacts for this user
  const { results: existingContacts } = await db.prepare(`
    SELECT id, name FROM contacts
    WHERE user_id = ? AND archived = 0
  `).bind(userId).all<{ id: string; name: string }>();

  const duplicates: PotentialDuplicate[] = [];
  const newNameLower = newName.toLowerCase().trim();
  const newFirstName = newNameLower.split(' ')[0];

  for (const contact of existingContacts) {
    const existingNameLower = contact.name.toLowerCase().trim();
    const existingFirstName = existingNameLower.split(' ')[0];

    // 1. Exact match (case insensitive)
    if (newNameLower === existingNameLower) {
      duplicates.push({
        existingContactId: contact.id,
        existingName: contact.name,
        newName,
        similarity: 1.0,
        matchReason: 'exact',
      });
      continue;
    }

    // 2. Check nickname variants (first name only)
    if (areNicknameVariants(newFirstName, existingFirstName)) {
      // If first names are nickname variants, check last names match (if present)
      const newParts = newNameLower.split(' ');
      const existingParts = existingNameLower.split(' ');
      
      // If both have last names, they should match
      if (newParts.length > 1 && existingParts.length > 1) {
        const newLast = newParts.slice(1).join(' ');
        const existingLast = existingParts.slice(1).join(' ');
        if (calculateSimilarity(newLast, existingLast) > 0.8) {
          duplicates.push({
            existingContactId: contact.id,
            existingName: contact.name,
            newName,
            similarity: 0.9,
            matchReason: 'nickname',
          });
          continue;
        }
      } else {
        // One or both don't have last names — match on first name nickname
        duplicates.push({
          existingContactId: contact.id,
          existingName: contact.name,
          newName,
          similarity: 0.85,
          matchReason: 'nickname',
        });
        continue;
      }
    }

    // 3. Fuzzy match on full name
    const similarity = calculateSimilarity(newNameLower, existingNameLower);
    if (similarity >= threshold) {
      duplicates.push({
        existingContactId: contact.id,
        existingName: contact.name,
        newName,
        similarity,
        matchReason: 'fuzzy',
      });
    }
  }

  // Sort by similarity descending
  duplicates.sort((a, b) => b.similarity - a.similarity);
  return duplicates;
}

// ===========================================================================
// CRUD Operations
// ===========================================================================

/**
 * Create a new contact for a user.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param input - Contact data
 * @returns The created contact
 */
export async function createContact(
  db: D1Database,
  userId: string,
  input: CreateContactInput,
): Promise<ContactRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Calculate initial health status
  const healthStatus = calculateHealthStatus(
    input.intent ?? 'new',
    input.last_contact_date ?? null,
    input.contact_kind ?? 'non_kin',
    now,
  );

  await db.prepare(`
    INSERT INTO contacts (
      id, user_id, name, phone, email, intent, contact_kind,
      last_contact_date, custom_cadence_days, preferred_method,
      health_status, source, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId,
    input.name.trim(),
    input.phone ?? null,
    input.email ?? null,
    input.intent ?? 'new',
    input.contact_kind ?? 'non_kin',
    input.last_contact_date ?? null,
    input.custom_cadence_days ?? null,
    input.preferred_method ?? null,
    healthStatus,
    input.source ?? 'manual',
    input.notes ?? null,
    now,
    now,
  ).run();

  // Add to circles if specified
  if (input.circle_ids && input.circle_ids.length > 0) {
    for (const circleId of input.circle_ids) {
      await db.prepare(`
        INSERT INTO contact_circles (contact_id, circle_id)
        VALUES (?, ?)
      `).bind(id, circleId).run();
    }
  }

  const contact = await db.prepare(`
    SELECT * FROM contacts WHERE id = ?
  `).bind(id).first<ContactRow>();

  return contact!;
}

/**
 * Get a single contact with its circle memberships.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param contactId - The contact's ID
 * @returns Contact with circles or null if not found
 */
export async function getContactWithCircles(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<ContactWithCircles | null> {
  const contact = await db.prepare(`
    SELECT * FROM contacts WHERE id = ? AND user_id = ?
  `).bind(contactId, userId).first<ContactRow>();

  if (!contact) return null;

  const { results: circles } = await db.prepare(`
    SELECT c.id, c.name
    FROM circles c
    INNER JOIN contact_circles cc ON c.id = cc.circle_id
    WHERE cc.contact_id = ?
    ORDER BY c.sort_order
  `).bind(contactId).all<{ id: string; name: string }>();

  return { ...contact, circles };
}

/**
 * Update an existing contact.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param contactId - The contact's ID
 * @param input - Fields to update
 * @returns Updated contact with circles or null if not found
 */
export async function updateContact(
  db: D1Database,
  userId: string,
  contactId: string,
  input: UpdateContactInput,
): Promise<ContactWithCircles | null> {
  // Verify ownership
  const existing = await db.prepare(`
    SELECT * FROM contacts WHERE id = ? AND user_id = ?
  `).bind(contactId, userId).first<ContactRow>();

  if (!existing) return null;

  // Build update query dynamically
  const updates: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    updates.push('name = ?');
    values.push(input.name.trim());
  }
  if (input.phone !== undefined) {
    updates.push('phone = ?');
    values.push(input.phone);
  }
  if (input.email !== undefined) {
    updates.push('email = ?');
    values.push(input.email);
  }
  if (input.intent !== undefined) {
    updates.push('intent = ?');
    values.push(input.intent);
  }
  if (input.contact_kind !== undefined) {
    updates.push('contact_kind = ?');
    values.push(input.contact_kind);
  }
  if (input.last_contact_date !== undefined) {
    updates.push('last_contact_date = ?');
    values.push(input.last_contact_date);
  }
  if (input.custom_cadence_days !== undefined) {
    updates.push('custom_cadence_days = ?');
    values.push(input.custom_cadence_days);
  }
  if (input.preferred_method !== undefined) {
    updates.push('preferred_method = ?');
    values.push(input.preferred_method);
  }
  if (input.notes !== undefined) {
    updates.push('notes = ?');
    values.push(input.notes);
  }

  // Recalculate health if intent, contact_kind, last_contact_date, or cadence changed
  if (
    input.intent !== undefined ||
    input.contact_kind !== undefined ||
    input.last_contact_date !== undefined ||
    input.custom_cadence_days !== undefined
  ) {
    const newIntent = input.intent ?? existing.intent;
    const newKind = input.contact_kind ?? existing.contact_kind;
    const newLastContact = input.last_contact_date ?? existing.last_contact_date;
    const newHealth = calculateHealthStatus(
      newIntent,
      newLastContact,
      newKind,
      new Date().toISOString(),
    );
    updates.push('health_status = ?');
    values.push(newHealth);
  }

  updates.push("updated_at = datetime('now')");
  values.push(contactId, userId);

  if (updates.length > 1) {
    await db.prepare(`
      UPDATE contacts SET ${updates.join(', ')}
      WHERE id = ? AND user_id = ?
    `).bind(...values).run();
  }

  // Update circle memberships if specified
  if (input.circle_ids !== undefined) {
    // Remove all existing memberships
    await db.prepare(`
      DELETE FROM contact_circles WHERE contact_id = ?
    `).bind(contactId).run();

    // Add new memberships
    for (const circleId of input.circle_ids) {
      await db.prepare(`
        INSERT INTO contact_circles (contact_id, circle_id)
        VALUES (?, ?)
      `).bind(contactId, circleId).run();
    }
  }

  return getContactWithCircles(db, userId, contactId);
}

/**
 * Soft delete a contact (set archived = 1).
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param contactId - The contact's ID
 * @returns true if archived, false if not found
 */
export async function archiveContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE contacts
    SET archived = 1, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND archived = 0
  `).bind(contactId, userId).run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Restore an archived contact.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param contactId - The contact's ID
 * @returns true if restored, false if not found
 */
export async function restoreContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE contacts
    SET archived = 0, updated_at = datetime('now')
    WHERE id = ? AND user_id = ? AND archived = 1
  `).bind(contactId, userId).run();

  return (result.meta.changes ?? 0) > 0;
}

/**
 * Permanently delete a contact.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param contactId - The contact's ID
 * @returns true if deleted, false if not found
 */
export async function deleteContact(
  db: D1Database,
  userId: string,
  contactId: string,
): Promise<boolean> {
  // Delete circle memberships first
  await db.prepare(`
    DELETE FROM contact_circles WHERE contact_id = ?
  `).bind(contactId).run();

  // Delete interactions
  await db.prepare(`
    DELETE FROM interactions WHERE contact_id = ?
  `).bind(contactId).run();

  // Delete the contact
  const result = await db.prepare(`
    DELETE FROM contacts WHERE id = ? AND user_id = ?
  `).bind(contactId, userId).run();

  return (result.meta.changes ?? 0) > 0;
}

// ===========================================================================
// List & Search
// ===========================================================================

/**
 * List contacts with filtering and pagination.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param filters - Optional filters
 * @param pagination - Pagination options
 * @returns Paginated contact list with circles
 */
export async function listContacts(
  db: D1Database,
  userId: string,
  filters: ContactListFilters = {},
  pagination: PaginationOptions = {},
): Promise<ContactListResult> {
  const {
    limit = 50,
    offset = 0,
    orderBy = 'name',
    orderDir = 'asc',
  } = pagination;

  // Build WHERE clause
  const conditions: string[] = ['c.user_id = ?'];
  const params: unknown[] = [userId];

  if (filters.archived !== true) {
    conditions.push('c.archived = 0');
  }
  if (filters.intent) {
    conditions.push('c.intent = ?');
    params.push(filters.intent);
  }
  if (filters.health_status) {
    conditions.push('c.health_status = ?');
    params.push(filters.health_status);
  }
  if (filters.contact_kind) {
    conditions.push('c.contact_kind = ?');
    params.push(filters.contact_kind);
  }
  if (filters.circle_id) {
    conditions.push(`EXISTS (
      SELECT 1 FROM contact_circles cc
      WHERE cc.contact_id = c.id AND cc.circle_id = ?
    )`);
    params.push(filters.circle_id);
  }
  if (filters.search) {
    conditions.push('c.name LIKE ?');
    params.push(`%${filters.search}%`);
  }

  const whereClause = conditions.join(' AND ');

  // Get total count
  const countResult = await db.prepare(`
    SELECT COUNT(*) as count FROM contacts c WHERE ${whereClause}
  `).bind(...params).first<{ count: number }>();
  const total = countResult?.count ?? 0;

  // Map orderBy to column
  const orderColumn = {
    name: 'c.name',
    last_contact_date: 'c.last_contact_date',
    created_at: 'c.created_at',
    health_status: `CASE c.health_status WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 WHEN 'green' THEN 2 END`,
  }[orderBy];

  // Get contacts
  const { results: contacts } = await db.prepare(`
    SELECT c.* FROM contacts c
    WHERE ${whereClause}
    ORDER BY ${orderColumn} ${orderDir.toUpperCase()}
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all<ContactRow>();

  // Get circles for all contacts in one query
  const contactIds = contacts.map((c) => c.id);
  let circleMap: Record<string, Array<{ id: string; name: string }>> = {};

  if (contactIds.length > 0) {
    const placeholders = contactIds.map(() => '?').join(',');
    const { results: circleRows } = await db.prepare(`
      SELECT cc.contact_id, ci.id, ci.name
      FROM contact_circles cc
      INNER JOIN circles ci ON cc.circle_id = ci.id
      WHERE cc.contact_id IN (${placeholders})
      ORDER BY ci.sort_order
    `).bind(...contactIds).all<{ contact_id: string; id: string; name: string }>();

    for (const row of circleRows) {
      if (!circleMap[row.contact_id]) {
        circleMap[row.contact_id] = [];
      }
      circleMap[row.contact_id].push({ id: row.id, name: row.name });
    }
  }

  const contactsWithCircles: ContactWithCircles[] = contacts.map((c) => ({
    ...c,
    circles: circleMap[c.id] ?? [],
  }));

  return {
    contacts: contactsWithCircles,
    total,
    hasMore: offset + contacts.length < total,
  };
}

/**
 * Search contacts by name (fuzzy).
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param query - Search query
 * @param limit - Max results
 * @returns Matching contacts with circles
 */
export async function searchContacts(
  db: D1Database,
  userId: string,
  query: string,
  limit: number = 10,
): Promise<ContactWithCircles[]> {
  const { results: contacts } = await db.prepare(`
    SELECT * FROM contacts
    WHERE user_id = ? AND archived = 0
      AND name LIKE ?
    ORDER BY name
    LIMIT ?
  `).bind(userId, `%${query}%`, limit).all<ContactRow>();

  // Get circles
  const contactIds = contacts.map((c) => c.id);
  let circleMap: Record<string, Array<{ id: string; name: string }>> = {};

  if (contactIds.length > 0) {
    const placeholders = contactIds.map(() => '?').join(',');
    const { results: circleRows } = await db.prepare(`
      SELECT cc.contact_id, ci.id, ci.name
      FROM contact_circles cc
      INNER JOIN circles ci ON cc.circle_id = ci.id
      WHERE cc.contact_id IN (${placeholders})
    `).bind(...contactIds).all<{ contact_id: string; id: string; name: string }>();

    for (const row of circleRows) {
      if (!circleMap[row.contact_id]) {
        circleMap[row.contact_id] = [];
      }
      circleMap[row.contact_id].push({ id: row.id, name: row.name });
    }
  }

  return contacts.map((c) => ({
    ...c,
    circles: circleMap[c.id] ?? [],
  }));
}

// ===========================================================================
// Health Calculations
// ===========================================================================

/**
 * Recalculate health status for all contacts of a user.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @returns Count of contacts updated
 */
export async function recalculateHealthStatuses(
  db: D1Database,
  userId: string,
): Promise<{ updated: number }> {
  const now = new Date().toISOString();

  const { results: contacts } = await db.prepare(`
    SELECT id, intent, last_contact_date, contact_kind, health_status
    FROM contacts
    WHERE user_id = ? AND archived = 0
  `).bind(userId).all<{
    id: string;
    intent: IntentType;
    last_contact_date: string | null;
    contact_kind: ContactKind;
    health_status: HealthStatus;
  }>();

  let updated = 0;

  for (const contact of contacts) {
    const newStatus = calculateHealthStatus(
      contact.intent,
      contact.last_contact_date,
      contact.contact_kind,
      now,
    );

    if (newStatus !== contact.health_status) {
      await db.prepare(`
        UPDATE contacts SET health_status = ?, updated_at = ?
        WHERE id = ?
      `).bind(newStatus, now, contact.id).run();
      updated++;
    }
  }

  return { updated };
}

/**
 * Recalculate health for ALL users' contacts.
 * Used by cron jobs.
 *
 * @param db - D1 database
 * @returns Summary of updates
 */
export async function recalculateAllHealthStatuses(
  db: D1Database,
): Promise<{ usersProcessed: number; contactsUpdated: number }> {
  const { results: users } = await db.prepare(`
    SELECT DISTINCT user_id FROM contacts WHERE archived = 0
  `).all<{ user_id: string }>();

  let totalUpdated = 0;

  for (const { user_id } of users) {
    const result = await recalculateHealthStatuses(db, user_id);
    totalUpdated += result.updated;
  }

  return {
    usersProcessed: users.length,
    contactsUpdated: totalUpdated,
  };
}

// ===========================================================================
// Statistics
// ===========================================================================

/**
 * Get health status counts for a user.
 */
export async function getHealthCounts(
  db: D1Database,
  userId: string,
): Promise<Record<HealthStatus, number>> {
  const { results } = await db.prepare(`
    SELECT health_status, COUNT(*) as count
    FROM contacts
    WHERE user_id = ? AND archived = 0
    GROUP BY health_status
  `).bind(userId).all<{ health_status: HealthStatus; count: number }>();

  const counts: Record<HealthStatus, number> = { green: 0, yellow: 0, red: 0 };
  for (const row of results) {
    counts[row.health_status] = row.count;
  }
  return counts;
}

/**
 * Get intent counts for a user.
 */
export async function getIntentCounts(
  db: D1Database,
  userId: string,
): Promise<Record<IntentType, number>> {
  const { results } = await db.prepare(`
    SELECT intent, COUNT(*) as count
    FROM contacts
    WHERE user_id = ? AND archived = 0
    GROUP BY intent
  `).bind(userId).all<{ intent: IntentType; count: number }>();

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

/**
 * Get total contact count for a user.
 */
export async function getContactCount(
  db: D1Database,
  userId: string,
): Promise<number> {
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM contacts
    WHERE user_id = ? AND archived = 0
  `).bind(userId).first<{ count: number }>();

  return result?.count ?? 0;
}
