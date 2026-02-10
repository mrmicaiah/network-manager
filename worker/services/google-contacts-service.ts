/**
 * Google Contacts Import Service — Fetches, maps, and imports contacts from Google People API.
 *
 * This service handles the data pipeline from Google to Network Manager:
 *   1. Fetch contacts from Google People API (full sync or incremental)
 *   2. Map Google's Person resource to our Contact model
 *   3. Import with duplicate detection (phone number match)
 *   4. Track sync state for incremental updates
 *
 * Duplicate handling:
 *   - Primary match: phone number (normalized to E.164)
 *   - Secondary match: email address (if no phone match)
 *   - On match: update google_resource_name on existing contact, skip creation
 *   - On new: create with intent='new', source='google'
 *
 * Rate limits (Google People API):
 *   - ~90 read requests per user per minute
 *   - pageSize max: 1000 contacts per page
 *   - Most users have <1000 contacts → single page sufficient
 *
 * @see worker/services/google-oauth-service.ts for token management
 * @see docs/google-people-api-reference.md for API details
 */

import type { Env } from '../../shared/types';
import type { IntentType, ContactKind } from '../../shared/models';
import { getValidToken, storeSyncToken, getSyncToken, clearSyncToken } from './google-oauth-service';
import { calculateHealthStatus } from '../../shared/intent-config';

// ===========================================================================
// Configuration
// ===========================================================================

const PEOPLE_API_BASE = 'https://people.googleapis.com/v1';

/** Fields to request from Google People API */
const PERSON_FIELDS = [
  'names',
  'phoneNumbers',
  'emailAddresses',
  'organizations',
  'biographies',
  'birthdays',
  'memberships',
  'metadata',
].join(',');

/** Max contacts per page (Google API maximum) */
const PAGE_SIZE = 1000;

/** Max pages to fetch (safety limit: 10,000 contacts) */
const MAX_PAGES = 10;

/** Delay between pages to respect rate limits (ms) */
const PAGE_DELAY_MS = 500;

// ===========================================================================
// Types
// ===========================================================================

/** Subset of Google Person resource fields we use */
export interface GooglePerson {
  resourceName: string;
  metadata?: {
    deleted?: boolean;
    sources?: Array<{
      type: string;
      id: string;
    }>;
  };
  names?: Array<{
    displayName?: string;
    givenName?: string;
    familyName?: string;
    metadata?: { primary?: boolean };
  }>;
  phoneNumbers?: Array<{
    value?: string;
    type?: string;
    canonicalForm?: string;
    metadata?: { primary?: boolean };
  }>;
  emailAddresses?: Array<{
    value?: string;
    type?: string;
    metadata?: { primary?: boolean };
  }>;
  organizations?: Array<{
    name?: string;
    title?: string;
    metadata?: { primary?: boolean };
  }>;
  biographies?: Array<{
    value?: string;
    metadata?: { primary?: boolean };
  }>;
  birthdays?: Array<{
    date?: { year?: number; month?: number; day?: number };
    metadata?: { primary?: boolean };
  }>;
  memberships?: Array<{
    contactGroupMembership?: {
      contactGroupId?: string;
      contactGroupResourceName?: string;
    };
  }>;
}

interface GoogleConnectionsResponse {
  connections?: GooglePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
  totalPeople?: number;
  totalItems?: number;
}

/** Mapped contact ready for import */
export interface MappedContact {
  name: string;
  phone: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
  birthday: string | null;
  googleResourceName: string;
  suggestedIntent: IntentType;
  suggestedKind: ContactKind;
  googleLabels: string[];
}

export interface ImportOptions {
  /** Skip contacts without phone numbers (default: true) */
  requirePhone?: boolean;
  /** Dry run — return what would be imported without writing (default: false) */
  dryRun?: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  duplicates: number;
  updated: number;
  errors: number;
  contacts: MappedContact[];
}

export interface FetchResult {
  contacts: GooglePerson[];
  syncToken: string | null;
  totalFetched: number;
  isIncremental: boolean;
}

// ===========================================================================
// 1. Fetch Google Contacts
// ===========================================================================

/**
 * Fetch contacts from Google People API.
 *
 * Uses incremental sync when a sync token is available (only fetches changes).
 * Falls back to full sync if no token exists or token is expired.
 *
 * @param env    - Worker environment
 * @param db     - D1 database
 * @param userId - User whose Google contacts to fetch
 * @returns Fetched contacts and sync metadata
 */
export async function fetchGoogleContacts(
  env: Env,
  db: D1Database,
  userId: string,
): Promise<FetchResult> {
  // Get valid access token (auto-refreshes if needed)
  const tokenResult = await getValidToken(env, db, userId);
  if (!tokenResult.success) {
    throw new Error(`Google auth failed: ${tokenResult.error}`);
  }

  const accessToken = tokenResult.accessToken;

  // Check for existing sync token
  const { syncToken } = await getSyncToken(db, userId);

  if (syncToken) {
    // Try incremental sync
    try {
      const result = await fetchIncremental(accessToken, syncToken);
      return result;
    } catch (err) {
      // Sync token expired or invalid — fall back to full sync
      if (err instanceof SyncTokenExpiredError) {
        console.log(`[google-import] Sync token expired for user ${userId}, doing full sync`);
        await clearSyncToken(db, userId);
      } else {
        throw err;
      }
    }
  }

  // Full sync
  return fetchFullSync(accessToken);
}

/**
 * Full sync — fetches all contacts with pagination.
 */
async function fetchFullSync(accessToken: string): Promise<FetchResult> {
  const allContacts: GooglePerson[] = [];
  let pageToken: string | undefined;
  let syncToken: string | null = null;
  let pageCount = 0;

  do {
    const params = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: PAGE_SIZE.toString(),
      requestSyncToken: 'true',
      sortOrder: 'FIRST_NAME_ASCENDING',
    });

    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await fetch(
      `${PEOPLE_API_BASE}/people/me/connections?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[google-import] Fetch failed (${response.status}):`, errorBody);
      throw new Error(`Google People API error: ${response.status}`);
    }

    const data = await response.json<GoogleConnectionsResponse>();

    if (data.connections) {
      allContacts.push(...data.connections);
    }

    pageToken = data.nextPageToken;
    syncToken = data.nextSyncToken ?? syncToken;
    pageCount++;

    // Rate limit protection
    if (pageToken && pageCount < MAX_PAGES) {
      await sleep(PAGE_DELAY_MS);
    }
  } while (pageToken && pageCount < MAX_PAGES);

  if (pageCount >= MAX_PAGES) {
    console.warn(`[google-import] Hit max page limit (${MAX_PAGES}), some contacts may be missing`);
  }

  console.log(`[google-import] Full sync: ${allContacts.length} contacts in ${pageCount} pages`);

  return {
    contacts: allContacts,
    syncToken,
    totalFetched: allContacts.length,
    isIncremental: false,
  };
}

/**
 * Incremental sync — fetches only changes since last sync.
 */
async function fetchIncremental(
  accessToken: string,
  syncToken: string,
): Promise<FetchResult> {
  const allContacts: GooglePerson[] = [];
  let pageToken: string | undefined;
  let newSyncToken: string | null = null;
  let pageCount = 0;

  do {
    const params = new URLSearchParams({
      personFields: PERSON_FIELDS,
      pageSize: PAGE_SIZE.toString(),
      requestSyncToken: 'true',
      syncToken,
    });

    if (pageToken) {
      params.set('pageToken', pageToken);
    }

    const response = await fetch(
      `${PEOPLE_API_BASE}/people/me/connections?${params.toString()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!response.ok) {
      const errorBody = await response.text();

      // Check for expired sync token
      if (response.status === 410 || errorBody.includes('EXPIRED_SYNC_TOKEN')) {
        throw new SyncTokenExpiredError();
      }

      console.error(`[google-import] Incremental fetch failed (${response.status}):`, errorBody);
      throw new Error(`Google People API error: ${response.status}`);
    }

    const data = await response.json<GoogleConnectionsResponse>();

    if (data.connections) {
      allContacts.push(...data.connections);
    }

    pageToken = data.nextPageToken;
    newSyncToken = data.nextSyncToken ?? newSyncToken;
    pageCount++;

    if (pageToken && pageCount < MAX_PAGES) {
      await sleep(PAGE_DELAY_MS);
    }
  } while (pageToken && pageCount < MAX_PAGES);

  console.log(`[google-import] Incremental sync: ${allContacts.length} changes in ${pageCount} pages`);

  return {
    contacts: allContacts,
    syncToken: newSyncToken,
    totalFetched: allContacts.length,
    isIncremental: true,
  };
}

// ===========================================================================
// 2. Map Google Contact → Network Manager Contact
// ===========================================================================

/**
 * Transform a Google Person resource into our contact model.
 *
 * Field selection priority:
 *   - Names: primary → first in list
 *   - Phone: mobile → primary → first available; normalized to E.164
 *   - Email: primary → first in list
 *   - Org: primary → first in list
 *   - Bio: primary → first in list
 *   - Birthday: primary → first in list, formatted as ISO date
 *
 * @param person - Google Person resource
 * @returns Mapped contact or null if no usable name
 */
export function mapGoogleContact(person: GooglePerson): MappedContact | null {
  // Extract name — skip contacts without any name
  const name = extractName(person);
  if (!name) return null;

  // Extract phone — pick mobile first, then primary, then first available
  const phone = extractPhone(person);

  // Extract email
  const email = extractEmail(person);

  // Extract organization
  const org = extractOrganization(person);

  // Extract biography/notes
  const notes = extractBio(person);

  // Extract birthday
  const birthday = extractBirthday(person);

  // Extract Google labels for intent suggestions
  const googleLabels = extractLabels(person);

  // Suggest intent based on Google labels
  const { intent, kind } = suggestIntentFromLabels(googleLabels);

  return {
    name,
    phone,
    email,
    company: org?.company ?? null,
    title: org?.title ?? null,
    notes,
    birthday,
    googleResourceName: person.resourceName,
    suggestedIntent: intent,
    suggestedKind: kind,
    googleLabels,
  };
}

function extractName(person: GooglePerson): string | null {
  if (!person.names || person.names.length === 0) return null;

  // Prefer primary name
  const primary = person.names.find((n) => n.metadata?.primary);
  const name = primary || person.names[0];

  // Use displayName if available, otherwise construct from parts
  if (name.displayName) return name.displayName;

  const parts = [name.givenName, name.familyName].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

function extractPhone(person: GooglePerson): string | null {
  if (!person.phoneNumbers || person.phoneNumbers.length === 0) return null;

  // Priority: mobile → primary → first
  const mobile = person.phoneNumbers.find(
    (p) => p.type?.toLowerCase() === 'mobile',
  );
  const primary = person.phoneNumbers.find((p) => p.metadata?.primary);
  const phone = mobile || primary || person.phoneNumbers[0];

  // Prefer canonicalForm (already E.164) over raw value
  const raw = phone.canonicalForm || phone.value;
  if (!raw) return null;

  return normalizePhone(raw);
}

function extractEmail(person: GooglePerson): string | null {
  if (!person.emailAddresses || person.emailAddresses.length === 0) return null;

  const primary = person.emailAddresses.find((e) => e.metadata?.primary);
  const email = primary || person.emailAddresses[0];

  return email.value ?? null;
}

function extractOrganization(
  person: GooglePerson,
): { company: string | null; title: string | null } | null {
  if (!person.organizations || person.organizations.length === 0) return null;

  const primary = person.organizations.find((o) => o.metadata?.primary);
  const org = primary || person.organizations[0];

  return {
    company: org.name ?? null,
    title: org.title ?? null,
  };
}

function extractBio(person: GooglePerson): string | null {
  if (!person.biographies || person.biographies.length === 0) return null;

  const primary = person.biographies.find((b) => b.metadata?.primary);
  const bio = primary || person.biographies[0];

  return bio.value ?? null;
}

function extractBirthday(person: GooglePerson): string | null {
  if (!person.birthdays || person.birthdays.length === 0) return null;

  const primary = person.birthdays.find((b) => b.metadata?.primary);
  const bday = primary || person.birthdays[0];

  if (!bday.date) return null;

  const { year, month, day } = bday.date;
  if (!month || !day) return null;

  // Format as ISO date. Year is optional in Google contacts.
  const y = year ? String(year).padStart(4, '0') : '0000';
  const m = String(month).padStart(2, '0');
  const d = String(day).padStart(2, '0');

  return `${y}-${m}-${d}`;
}

function extractLabels(person: GooglePerson): string[] {
  if (!person.memberships || person.memberships.length === 0) return [];

  return person.memberships
    .map((m) => m.contactGroupMembership?.contactGroupId)
    .filter((id): id is string => !!id);
}

/**
 * Suggest initial intent and contact kind based on Google labels.
 *
 * Label mapping:
 *   - "starred" → inner_circle or nurture
 *   - "family" / "all" (system family group) → inner_circle + kin
 *   - "friends" → nurture
 *   - "coworkers" → maintain
 *   - No recognizable label → new (user sorts via Bethany)
 */
function suggestIntentFromLabels(labels: string[]): {
  intent: IntentType;
  kind: ContactKind;
} {
  const lowerLabels = labels.map((l) => l.toLowerCase());

  // Check for family indicators
  if (lowerLabels.includes('family')) {
    return { intent: 'inner_circle', kind: 'kin' };
  }

  // Check for starred
  if (lowerLabels.includes('starred')) {
    return { intent: 'nurture', kind: 'non_kin' };
  }

  // Check for friends
  if (lowerLabels.includes('friends')) {
    return { intent: 'nurture', kind: 'non_kin' };
  }

  // Check for coworkers
  if (lowerLabels.includes('coworkers')) {
    return { intent: 'maintain', kind: 'non_kin' };
  }

  // Default — unsorted
  return { intent: 'new', kind: 'non_kin' };
}

// ===========================================================================
// 3. Import Google Contacts
// ===========================================================================

/**
 * Import contacts from Google into Network Manager.
 *
 * Pipeline:
 *   1. Fetch contacts from Google People API
 *   2. Map each to our model (skip unmappable)
 *   3. Filter by options (require phone, etc.)
 *   4. Check for duplicates by phone, then email
 *   5. Create new contacts or link existing ones
 *   6. Store sync token for incremental updates
 *
 * @param env     - Worker environment
 * @param db      - D1 database
 * @param userId  - User to import for
 * @param options - Import options
 * @returns Import statistics
 */
export async function importGoogleContacts(
  env: Env,
  db: D1Database,
  userId: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { requirePhone = true, dryRun = false } = options;

  // Fetch from Google
  const fetchResult = await fetchGoogleContacts(env, db, userId);

  // Map contacts
  const mapped: MappedContact[] = [];
  let skipped = 0;

  for (const person of fetchResult.contacts) {
    // Skip deleted contacts in incremental sync
    if (person.metadata?.deleted) {
      // Mark as dormant if we have them
      if (!dryRun) {
        await handleDeletedContact(db, userId, person.resourceName);
      }
      continue;
    }

    const contact = mapGoogleContact(person);

    if (!contact) {
      skipped++;
      continue;
    }

    // Apply phone filter
    if (requirePhone && !contact.phone) {
      skipped++;
      continue;
    }

    mapped.push(contact);
  }

  if (dryRun) {
    return {
      imported: 0,
      skipped,
      duplicates: 0,
      updated: 0,
      errors: 0,
      contacts: mapped,
    };
  }

  // Load existing contacts for dedup
  const existingByPhone = await buildPhoneIndex(db, userId);
  const existingByEmail = await buildEmailIndex(db, userId);
  const existingByResource = await buildResourceIndex(db, userId);

  let imported = 0;
  let duplicates = 0;
  let updated = 0;
  let errors = 0;

  for (const contact of mapped) {
    try {
      // Check if already linked by google resource name
      const byResource = existingByResource.get(contact.googleResourceName);
      if (byResource) {
        // Already imported — update if incremental sync brought changes
        if (fetchResult.isIncremental) {
          await updateExistingFromGoogle(db, byResource, contact);
          updated++;
        } else {
          duplicates++;
        }
        continue;
      }

      // Check for phone duplicate
      if (contact.phone) {
        const byPhone = existingByPhone.get(contact.phone);
        if (byPhone) {
          // Link existing contact to Google resource
          await linkGoogleResource(db, byPhone, contact.googleResourceName);
          duplicates++;
          continue;
        }
      }

      // Check for email duplicate
      if (contact.email) {
        const byEmail = existingByEmail.get(contact.email.toLowerCase());
        if (byEmail) {
          await linkGoogleResource(db, byEmail, contact.googleResourceName);
          duplicates++;
          continue;
        }
      }

      // New contact — create
      await createImportedContact(db, userId, contact);
      imported++;

      // Update dedup indexes for remaining contacts
      if (contact.phone) existingByPhone.set(contact.phone, contact.googleResourceName);
      if (contact.email) existingByEmail.set(contact.email.toLowerCase(), contact.googleResourceName);
      existingByResource.set(contact.googleResourceName, contact.googleResourceName);
    } catch (err) {
      console.error(`[google-import] Error importing ${contact.name}:`, err);
      errors++;
    }
  }

  // Store sync token for next incremental sync
  if (fetchResult.syncToken) {
    await storeSyncToken(db, userId, fetchResult.syncToken);
  }

  console.log(
    `[google-import] Import complete for user ${userId}: ` +
    `${imported} imported, ${duplicates} duplicates, ${updated} updated, ` +
    `${skipped} skipped, ${errors} errors`,
  );

  return { imported, skipped, duplicates, updated, errors, contacts: mapped };
}

// ===========================================================================
// Database Operations
// ===========================================================================

/**
 * Create a new contact from a Google import.
 */
async function createImportedContact(
  db: D1Database,
  userId: string,
  contact: MappedContact,
): Promise<void> {
  const id = crypto.randomUUID();
  const healthStatus = calculateHealthStatus(contact.suggestedIntent, null);

  // Build notes with org info if available
  const noteParts: string[] = [];
  if (contact.title && contact.company) {
    noteParts.push(`${contact.title} at ${contact.company}`);
  } else if (contact.company) {
    noteParts.push(`Works at ${contact.company}`);
  } else if (contact.title) {
    noteParts.push(contact.title);
  }
  if (contact.birthday && contact.birthday !== '0000-00-00') {
    noteParts.push(`Birthday: ${contact.birthday}`);
  }
  if (contact.notes) {
    noteParts.push(contact.notes);
  }

  const notes = noteParts.length > 0 ? noteParts.join('\n') : null;

  await db
    .prepare(
      `INSERT INTO contacts
         (id, user_id, name, phone, email, intent, custom_cadence_days,
          last_contact_date, health_status, contact_kind, preferred_method,
          notes, source, archived, google_resource_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, 'google', 0, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      userId,
      contact.name,
      contact.phone,
      contact.email,
      contact.suggestedIntent,
      healthStatus,
      contact.suggestedKind,
      notes,
      contact.googleResourceName,
    )
    .run();
}

/**
 * Link an existing contact to a Google resource name (dedup match).
 */
async function linkGoogleResource(
  db: D1Database,
  contactId: string,
  resourceName: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts
       SET google_resource_name = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(resourceName, contactId)
    .run();
}

/**
 * Update an existing contact with fresh data from Google (incremental sync).
 */
async function updateExistingFromGoogle(
  db: D1Database,
  contactId: string,
  contact: MappedContact,
): Promise<void> {
  // Only update fields that Google is source-of-truth for (contact info),
  // never overwrite relationship data (intent, health, interactions)
  await db
    .prepare(
      `UPDATE contacts
       SET name = ?, phone = COALESCE(?, phone), email = COALESCE(?, email),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(contact.name, contact.phone, contact.email, contactId)
    .run();
}

/**
 * Handle a contact deleted in Google (incremental sync).
 * Marks as dormant rather than deleting to preserve relationship history.
 */
async function handleDeletedContact(
  db: D1Database,
  userId: string,
  resourceName: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE contacts
       SET intent = 'dormant', health_status = 'green', updated_at = datetime('now')
       WHERE user_id = ? AND google_resource_name = ? AND intent != 'dormant'`,
    )
    .bind(userId, resourceName)
    .run();
}

// ===========================================================================
// Dedup Index Builders
// ===========================================================================

/**
 * Build a phone → contact ID index for duplicate detection.
 */
async function buildPhoneIndex(
  db: D1Database,
  userId: string,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      'SELECT id, phone FROM contacts WHERE user_id = ? AND phone IS NOT NULL AND archived = 0',
    )
    .bind(userId)
    .all<{ id: string; phone: string }>();

  const map = new Map<string, string>();
  for (const row of results) {
    const normalized = normalizePhone(row.phone);
    if (normalized) {
      map.set(normalized, row.id);
    }
  }
  return map;
}

/**
 * Build an email → contact ID index for duplicate detection.
 */
async function buildEmailIndex(
  db: D1Database,
  userId: string,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      'SELECT id, email FROM contacts WHERE user_id = ? AND email IS NOT NULL AND archived = 0',
    )
    .bind(userId)
    .all<{ id: string; email: string }>();

  const map = new Map<string, string>();
  for (const row of results) {
    map.set(row.email.toLowerCase(), row.id);
  }
  return map;
}

/**
 * Build a google_resource_name → contact ID index.
 */
async function buildResourceIndex(
  db: D1Database,
  userId: string,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(
      'SELECT id, google_resource_name FROM contacts WHERE user_id = ? AND google_resource_name IS NOT NULL',
    )
    .bind(userId)
    .all<{ id: string; google_resource_name: string }>();

  const map = new Map<string, string>();
  for (const row of results) {
    map.set(row.google_resource_name, row.id);
  }
  return map;
}

// ===========================================================================
// Phone Normalization
// ===========================================================================

/**
 * Normalize a phone number to E.164 format.
 * Returns null if the input can't be parsed.
 */
function normalizePhone(phone: string): string | null {
  // Strip everything except digits and leading +
  const cleaned = phone.replace(/[^\d+]/g, '');

  // Already E.164
  if (/^\+1\d{10}$/.test(cleaned)) return cleaned;

  // US number without country code
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;

  // US number with 1 prefix but no +
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;

  // International number with + prefix (pass through)
  if (/^\+\d{7,15}$/.test(cleaned)) return cleaned;

  return null;
}

// ===========================================================================
// Helpers
// ===========================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SyncTokenExpiredError extends Error {
  constructor() {
    super('Google sync token expired');
    this.name = 'SyncTokenExpiredError';
  }
}
