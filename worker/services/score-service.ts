/**
 * Score Service — Circle-Based Relationship Scoring
 *
 * Calculates relationship scores for contacts within circles using the
 * point system. Each contact can have different scores in different
 * circles (the "two hats" problem — your brother in Family vs Work).
 *
 * The score determines dartboard position:
 *   - Score >= 1.0: Center (thriving)
 *   - Score 0.7-0.99: Inner ring (healthy)
 *   - Score 0.4-0.69: Outer ring (slipping)
 *   - Score < 0.4: Outside circle (drifting)
 *
 * @see shared/point-config.ts for point values and thresholds
 * @see shared/intent-config.ts for cadence periods
 * @see docs/dartboard-system-design.md for full system design
 */

import type { Env } from '../../shared/types';
import type { IntentType, InteractionMethod } from '../../shared/models';
import { INTENT_CONFIGS } from '../../shared/intent-config';
import {
  POINTS_REQUIRED,
  calculateInteractionPoints,
  calculateScore,
  calculateDartboardPosition,
  CONTACTS_PER_DARTBOARD,
  type ScoreStatus,
  type DartboardPosition,
} from '../../shared/point-config';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Score result for a single contact in a single circle.
 */
export interface CircleScore {
  contactId: string;
  circleId: string;
  pointsEarned: number;
  pointsRequired: number;
  score: number;
  status: ScoreStatus;
  interactionCount: number;
  lastInteractionDate: string | null;
}

/**
 * Contact with score and dartboard position.
 */
export interface DartboardContact extends CircleScore {
  name: string;
  intent: IntentType;
  position: DartboardPosition;
}

/**
 * A single dartboard (subset of contacts when circle is large).
 */
export interface Dartboard {
  index: number;
  total: number;
  contacts: DartboardContact[];
}

/**
 * Complete dartboard data for a circle.
 */
export interface DartboardData {
  circleId: string;
  circleName: string;
  totalContacts: number;
  dartboards: Dartboard[];
  summary: {
    thriving: number;
    healthy: number;
    slipping: number;
    drifting: number;
  };
}

/**
 * Tab data for the dashboard.
 */
export interface DashboardTab {
  id: string;
  name: string;
  contactCount: number;
}

/**
 * Dashboard tabs response.
 */
export interface DashboardTabsData {
  tabs: DashboardTab[];
  unsortedCount: number;
  defaultTabId: string | null;
  tabOrder: string[];
}

// ===========================================================================
// Score Calculation
// ===========================================================================

/**
 * Calculate a contact's score for a specific circle.
 *
 * Looks at interactions within the cadence window that count toward
 * this circle. If the interaction has no circle_context, it counts
 * for all circles the contact belongs to.
 *
 * @param db - D1 database
 * @param contactId - The contact's ID
 * @param circleId - The circle to calculate score for
 * @returns Score result
 */
export async function calculateCircleScore(
  db: D1Database,
  contactId: string,
  circleId: string,
): Promise<CircleScore> {
  // Get contact details
  const contact = await db.prepare(`
    SELECT intent, preferred_method
    FROM contacts
    WHERE id = ?
  `).bind(contactId).first<{
    intent: IntentType;
    preferred_method: InteractionMethod | null;
  }>();

  if (!contact) {
    throw new Error(`Contact not found: ${contactId}`);
  }

  // Get cadence window based on intent
  const intentConfig = INTENT_CONFIGS[contact.intent];
  const windowDays = intentConfig.defaultCadenceDays ?? 30;

  // Get interactions in the window that count for this circle
  // circle_context is NULL (counts for all) OR contains this circle ID
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
      contact.preferred_method,
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
      index: dartboardIndex + 1,
      total: totalDartboards,
      contacts: dartboardContacts,
    });
  }

  // Calculate summary
  const summary = {
    thriving: scoredContacts.filter(c => c.status === 'thriving').length,
    healthy: scoredContacts.filter(c => c.status === 'healthy').length,
    slipping: scoredContacts.filter(c => c.status === 'slipping').length,
    drifting: scoredContacts.filter(c => c.status === 'drifting').length,
  };

  return {
    circleId,
    circleName: circle.name,
    totalContacts: scoredContacts.length,
    dartboards,
    summary,
  };
}

// ===========================================================================
// Dashboard Tabs
// ===========================================================================

/**
 * Get dashboard tab data for a user.
 * Returns all circles as tabs plus unsorted contact count.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @returns Tab data
 */
export async function getDashboardTabs(
  db: D1Database,
  userId: string,
): Promise<DashboardTabsData> {
  // Get user preferences
  const user = await db.prepare(`
    SELECT default_circle_id, circle_tab_order
    FROM users
    WHERE id = ?
  `).bind(userId).first<{
    default_circle_id: string | null;
    circle_tab_order: string | null;
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

  const now = new Date().toISOString();

  for (const { circle_id: circleId } of circleIds) {
    const score = await calculateCircleScore(db, contactId, circleId);

    // Upsert into cache table
    await db.prepare(`
      INSERT INTO circle_scores (contact_id, circle_id, points_earned, score, status, calculated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (contact_id, circle_id) DO UPDATE SET
        points_earned = excluded.points_earned,
        score = excluded.score,
        status = excluded.status,
        calculated_at = excluded.calculated_at
    `).bind(
      contactId,
      circleId,
      score.pointsEarned,
      score.score,
      score.status,
      now,
    ).run();
  }
}

/**
 * Recalculate all scores for a user.
 * Run as a daily cron job to handle point decay.
 *
 * @param db - D1 database
 * @param userId - The user's ID
 * @returns Count of scores updated
 */
export async function recalculateAllScores(
  db: D1Database,
  userId: string,
): Promise<{ updated: number }> {
  // Get all contact-circle pairs for this user
  const { results: pairs } = await db.prepare(`
    SELECT DISTINCT c.id as contact_id, cc.circle_id
    FROM contacts c
    INNER JOIN contact_circles cc ON c.id = cc.contact_id
    WHERE c.user_id = ? AND c.archived = 0
  `).bind(userId).all<{ contact_id: string; circle_id: string }>();

  let updated = 0;

  for (const { contact_id, circle_id } of pairs) {
    try {
      await updateContactScores(db, contact_id);
      updated++;
    } catch (err) {
      console.error(`[score] Failed to update ${contact_id}/${circle_id}:`, err);
    }
  }

  return { updated };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Simple string hash for consistent random seeding.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}
