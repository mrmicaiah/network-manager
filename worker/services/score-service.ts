/**
 * Circle Score Service — Dartboard Scoring Engine
 *
 * This service calculates relationship health scores for contacts within circles.
 * The dartboard visualization uses a points-based system where contacts earn
 * points through interactions and lose standing through inactivity.
 *
 * Scoring Model:
 *
 *   - Each circle has a scoring window (default: 30 days)
 *   - Contacts earn points for interactions within the window
 *   - Points vary by interaction method (in-person > call > text > other)
 *   - Preferred method gets a bonus multiplier
 *   - Score = points earned / points required (capped at 1.0)
 *
 * Point Values:
 *
 *   in_person: 4 points (high effort, high value)
 *   call:      3 points (synchronous, personal)
 *   text:      2 points (async but direct)
 *   email:     2 points (async, formal)
 *   social:    1 point  (low effort, public)
 *   other:     2 points (catch-all)
 *
 *   Preferred method bonus: 1.5x multiplier
 *
 * Health Thresholds:
 *
 *   green:  score >= 0.7 (70%+ of required points)
 *   yellow: score >= 0.3 (30-69% of required points)
 *   red:    score < 0.3  (< 30% of required points)
 *
 * Dartboard Layout:
 *
 *   - 12 contacts per dartboard (like clock positions)
 *   - Position determined by score (higher = closer to center)
 *   - Angle spread evenly with slight randomization for visual interest
 *   - Multiple dartboards created if circle has > 12 contacts
 *
 * @see shared/intent-config.ts for layer-based cadence (separate system)
 * @see worker/services/interaction-service.ts for logging interactions
 */

import type { IntentType, InteractionMethod, HealthStatus } from '../../shared/models';

// ===========================================================================
// Configuration
// ===========================================================================

/** Points required for a "full" score (100%) */
const POINTS_REQUIRED = 10;

/** How far back to look for interactions (days) */
const SCORING_WINDOW_DAYS = 30;

/** Maximum contacts per dartboard ring */
const CONTACTS_PER_DARTBOARD = 12;

/** Base points for each interaction method */
const METHOD_POINTS: Record<InteractionMethod, number> = {
  in_person: 4,
  call: 3,
  text: 2,
  email: 2,
  social: 1,
  other: 2,
};

/** Bonus multiplier when using contact's preferred method */
const PREFERRED_METHOD_MULTIPLIER = 1.5;

// ===========================================================================
// Types
// ===========================================================================

export interface CircleScore {
  contactId: string;
  circleId: string;
  pointsEarned: number;
  pointsRequired: number;
  score: number; // 0.0 to 1.0
  status: HealthStatus;
  interactionCount: number;
  lastInteractionDate: string | null;
}

export interface DartboardContact extends CircleScore {
  name: string;
  intent: IntentType;
  position: {
    angle: number;  // Degrees from 12 o'clock
    radius: number; // 0 = center, 1 = edge
  };
}

export interface Dartboard {
  index: number;
  contacts: DartboardContact[];
}

export interface DartboardData {
  circleId: string;
  circleName: string;
  dartboards: Dartboard[];
  summary: {
    total: number;
    green: number;
    yellow: number;
    red: number;
    averageScore: number;
  };
}

export interface DashboardTab {
  id: string;
  name: string;
  contactCount: number;
}

// ===========================================================================
// Score Calculation
// ===========================================================================

/**
 * Calculate points earned for a single interaction.
 */
function calculateInteractionPoints(
  method: InteractionMethod,
  preferredMethod: InteractionMethod | null,
): number {
  const basePoints = METHOD_POINTS[method] ?? 2;
  if (preferredMethod && method === preferredMethod) {
    return Math.round(basePoints * PREFERRED_METHOD_MULTIPLIER);
  }
  return basePoints;
}

/**
 * Convert points to a 0-1 score and health status.
 */
function calculateScore(pointsEarned: number): {
  score: number;
  status: HealthStatus;
} {
  const score = Math.min(pointsEarned / POINTS_REQUIRED, 1.0);

  let status: HealthStatus;
  if (score >= 0.7) {
    status = 'green';
  } else if (score >= 0.3) {
    status = 'yellow';
  } else {
    status = 'red';
  }

  return { score, status };
}

/**
 * Calculate the score for a single contact in a specific circle.
 */
async function calculateCircleScore(
  db: D1Database,
  contactId: string,
  circleId: string,
  windowDays: number = SCORING_WINDOW_DAYS,
): Promise<CircleScore> {
  // Get contact's preferred method
  const contact = await db.prepare(`
    SELECT preferred_method FROM contacts WHERE id = ?
  `).bind(contactId).first<{ preferred_method: InteractionMethod | null }>();

  // Get interactions within the window that include this circle context
  const { results: interactions } = await db.prepare(`
    SELECT method, date
    FROM interactions
    WHERE contact_id = ?
      AND date >= date('now', '-' || ? || ' days')
      AND (circle_context IS NULL OR circle_context LIKE ?)
    ORDER BY date DESC
  `).bind(contactId, windowDays, `%"${circleId}"%`).all<{
    method: InteractionMethod;
    date: string;
  }>();

  // Calculate points
  let pointsEarned = 0;
  for (const interaction of interactions) {
    pointsEarned += calculateInteractionPoints(
      interaction.method,
      contact?.preferred_method ?? null,
    );
  }

  const { score, status } = calculateScore(pointsEarned);

  return {
    contactId,
    circleId,
    pointsEarned,
    pointsRequired: POINTS_REQUIRED,
    score,
    status,
    interactionCount: interactions.length,
    lastInteractionDate: interactions[0]?.date ?? null,
  };
}

/**
 * Calculate scores for all contacts in a circle.
 * Returns complete dartboard data ready for rendering.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param circleId - The circle to calculate for
 * @returns Dartboard data with positioned contacts
 */
export async function calculateDartboardData(
  db: D1Database,
  userId: string,
  circleId: string,
): Promise<DartboardData> {
  // Get circle info
  const circle = await db.prepare(`
    SELECT name FROM circles WHERE id = ? AND user_id = ?
  `).bind(circleId, userId).first<{ name: string }>();

  if (!circle) {
    throw new Error(`Circle not found: ${circleId}`);
  }

  // Get all non-archived contacts in this circle
  const { results: contacts } = await db.prepare(`
    SELECT c.id, c.name, c.intent, c.preferred_method
    FROM contacts c
    INNER JOIN contact_circles cc ON c.id = cc.contact_id
    WHERE c.user_id = ? AND cc.circle_id = ? AND c.archived = 0
    ORDER BY c.name
  `).bind(userId, circleId).all<{
    id: string;
    name: string;
    intent: IntentType;
    preferred_method: InteractionMethod | null;
  }>();

  // Calculate score for each contact
  const scoredContacts: Array<CircleScore & { name: string; intent: IntentType }> = [];

  for (const contact of contacts) {
    const score = await calculateCircleScore(db, contact.id, circleId);
    scoredContacts.push({
      ...score,
      name: contact.name,
      intent: contact.intent,
    });
  }

  // Sort by score descending (healthiest first for first dartboard)
  scoredContacts.sort((a, b) => b.score - a.score);

  // Split into dartboards
  const dartboards: Dartboard[] = [];
  const totalDartboards = Math.ceil(scoredContacts.length / CONTACTS_PER_DARTBOARD);

  for (let i = 0; i < scoredContacts.length; i += CONTACTS_PER_DARTBOARD) {
    const batch = scoredContacts.slice(i, i + CONTACTS_PER_DARTBOARD);
    const dartboardIndex = Math.floor(i / CONTACTS_PER_DARTBOARD);

    // Use a consistent seed based on circle ID for stable positioning
    const seedBase = hashString(circleId) + dartboardIndex * 1000;

    const dartboardContacts: DartboardContact[] = batch.map((contact, idx) => ({
      ...contact,
      position: calculateDartboardPosition(
        contact.score,
        idx,
        batch.length,
        seedBase + idx,
      ),
    }));

    dartboards.push({
      index: dartboardIndex,
      contacts: dartboardContacts,
    });
  }

  // Calculate summary
  const summary = {
    total: scoredContacts.length,
    green: scoredContacts.filter(c => c.status === 'green').length,
    yellow: scoredContacts.filter(c => c.status === 'yellow').length,
    red: scoredContacts.filter(c => c.status === 'red').length,
    averageScore: scoredContacts.length > 0
      ? scoredContacts.reduce((sum, c) => sum + c.score, 0) / scoredContacts.length
      : 0,
  };

  return {
    circleId,
    circleName: circle.name,
    dartboards,
    summary,
  };
}

// ===========================================================================
// Dartboard Positioning
// ===========================================================================

/**
 * Calculate position for a contact on the dartboard.
 *
 * - Score determines radius (higher score = closer to center)
 * - Index determines base angle (spread evenly around the circle)
 * - Seed adds deterministic variation for visual interest
 */
function calculateDartboardPosition(
  score: number,
  index: number,
  totalContacts: number,
  seed: number,
): { angle: number; radius: number } {
  // Radius: score 1.0 = center (0.1), score 0.0 = edge (0.9)
  // We use 0.1-0.9 to leave padding at center and edge
  const radius = 0.9 - (score * 0.8);

  // Base angle: spread evenly, starting from 12 o'clock
  const baseAngle = (360 / totalContacts) * index;

  // Add some deterministic variation based on seed
  const angleVariation = (seededRandom(seed) - 0.5) * (360 / totalContacts) * 0.3;
  const angle = (baseAngle + angleVariation + 360) % 360;

  return { angle, radius };
}

/**
 * Simple seeded random for deterministic positioning.
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
}

/**
 * Simple string hash for generating consistent seeds.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// ===========================================================================
// Dashboard Tabs
// ===========================================================================

/**
 * Get dashboard tabs with contact counts.
 * Respects user's tab order preference.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @returns Dashboard tabs and unsorted count
 */
export async function getDashboardTabs(
  db: D1Database,
  userId: string,
): Promise<{
  tabs: DashboardTab[];
  unsortedCount: number;
  defaultTabId: string | null;
  tabOrder: string[];
}> {
  // Get user preferences
  const user = await db.prepare(`
    SELECT circle_tab_order, default_circle_id
    FROM users WHERE id = ?
  `).bind(userId).first<{
    circle_tab_order: string | null;
    default_circle_id: string | null;
  }>();

  // Get circles with contact counts (only counting non-archived contacts)
  const { results: circles } = await db.prepare(`
    SELECT
      c.id,
      c.name,
      c.sort_order,
      COUNT(ct.id) as contact_count
    FROM circles c
    LEFT JOIN contact_circles cc ON c.id = cc.circle_id
    LEFT JOIN contacts ct ON cc.contact_id = ct.id AND ct.archived = 0
    WHERE c.user_id = ?
    GROUP BY c.id
    ORDER BY c.sort_order ASC
  `).bind(userId).all<{
    id: string;
    name: string;
    sort_order: number;
    contact_count: number;
  }>();

  // Count unsorted contacts (no circle assignment)
  const unsortedResult = await db.prepare(`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE c.user_id = ?
      AND c.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM contact_circles cc WHERE cc.contact_id = c.id
      )
  `).bind(userId).first<{ count: number }>();

  const unsortedCount = unsortedResult?.count ?? 0;

  // Build tab order
  let tabOrder: string[];
  if (user?.circle_tab_order) {
    try {
      tabOrder = JSON.parse(user.circle_tab_order);
    } catch {
      tabOrder = circles.map(c => c.id);
    }
  } else {
    tabOrder = circles.map(c => c.id);
  }

  // Sort circles by tab order
  const orderedCircles = [...circles].sort((a, b) => {
    const aIndex = tabOrder.indexOf(a.id);
    const bIndex = tabOrder.indexOf(b.id);
    if (aIndex === -1 && bIndex === -1) return a.sort_order - b.sort_order;
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  const tabs: DashboardTab[] = orderedCircles.map(c => ({
    id: c.id,
    name: c.name,
    contactCount: c.contact_count,
  }));

  return {
    tabs,
    unsortedCount,
    defaultTabId: user?.default_circle_id ?? tabs[0]?.id ?? null,
    tabOrder,
  };
}

/**
 * Get unsorted contacts (contacts with no circle assignment).
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @param limit - Maximum contacts to return
 * @returns Unsorted contacts
 */
export async function getUnsortedContacts(
  db: D1Database,
  userId: string,
  limit: number = 50,
): Promise<{
  contacts: Array<{
    id: string;
    name: string;
    intent: IntentType;
    createdAt: string;
  }>;
  count: number;
}> {
  // Count total
  const countResult = await db.prepare(`
    SELECT COUNT(*) as count
    FROM contacts c
    WHERE c.user_id = ?
      AND c.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM contact_circles cc WHERE cc.contact_id = c.id
      )
  `).bind(userId).first<{ count: number }>();

  const count = countResult?.count ?? 0;

  // Get contacts
  const { results } = await db.prepare(`
    SELECT id, name, intent, created_at
    FROM contacts c
    WHERE c.user_id = ?
      AND c.archived = 0
      AND NOT EXISTS (
        SELECT 1 FROM contact_circles cc WHERE cc.contact_id = c.id
      )
    ORDER BY created_at DESC
    LIMIT ?
  `).bind(userId, limit).all<{
    id: string;
    name: string;
    intent: IntentType;
    created_at: string;
  }>();

  return {
    contacts: results.map(c => ({
      id: c.id,
      name: c.name,
      intent: c.intent,
      createdAt: c.created_at,
    })),
    count,
  };
}

// ===========================================================================
// Cache Management (Optional)
// ===========================================================================

/**
 * Update cached scores for a contact across all their circles.
 * Call this after logging an interaction.
 *
 * @param db - D1 database
 * @param contactId - The contact whose scores to update
 */
export async function updateContactScores(
  db: D1Database,
  contactId: string,
): Promise<void> {
  // Get all circles this contact belongs to
  const { results: circleIds } = await db.prepare(`
    SELECT circle_id FROM contact_circles WHERE contact_id = ?
  `).bind(contactId).all<{ circle_id: string }>();

  // Update cached score for each circle
  for (const { circle_id } of circleIds) {
    const score = await calculateCircleScore(db, contactId, circle_id);

    // Upsert into circle_scores cache table
    await db.prepare(`
      INSERT INTO circle_scores (contact_id, circle_id, score, status, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(contact_id, circle_id) DO UPDATE SET
        score = excluded.score,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(contactId, circle_id, score.score, score.status).run();
  }
}

/**
 * Batch update scores for all contacts in a circle.
 * Useful after bulk operations.
 *
 * @param db - D1 database
 * @param circleId - The circle to update
 */
export async function updateCircleScores(
  db: D1Database,
  circleId: string,
): Promise<void> {
  // Get all contacts in this circle
  const { results: contacts } = await db.prepare(`
    SELECT contact_id FROM contact_circles WHERE circle_id = ?
  `).bind(circleId).all<{ contact_id: string }>();

  // Update each contact's score for this circle
  for (const { contact_id } of contacts) {
    const score = await calculateCircleScore(db, contact_id, circleId);

    await db.prepare(`
      INSERT INTO circle_scores (contact_id, circle_id, score, status, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(contact_id, circle_id) DO UPDATE SET
        score = excluded.score,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).bind(contact_id, circleId, score.score, score.status).run();
  }
}
