/**
 * Point System Configuration — Relationship Scoring
 *
 * Translates the Dunbar cadence model into a point-based system for
 * dartboard visualization. Different contact methods score differently
 * based on the contact's preferred communication style.
 *
 * Core concept:
 *   - Each cadence period requires 100 points to stay "in the circle"
 *   - Preferred contact method scores 50 points
 *   - Other methods score 25 points
 *   - In-person always scores 50 (high investment)
 *
 * Example — Mom with inner_circle intent (weekly) who prefers calls:
 *   - 2 calls = 100 points = in the circle
 *   - 4 texts = 100 points = in the circle
 *   - 1 call + 2 texts = 100 points = in the circle
 *   - 1 text = 25 points = drifting out
 *
 * @see docs/dartboard-system-design.md for full system design
 * @see shared/intent-config.ts for cadence periods per intent
 */

import type { InteractionMethod } from './models';

// ===========================================================================
// Point Values
// ===========================================================================

/**
 * Points required per cadence period to maintain "in circle" status.
 * This is constant — the period length varies by intent.
 */
export const POINTS_REQUIRED = 100;

/**
 * Points awarded for the contact's preferred method.
 * When the contact has a preferred_method set and you use it,
 * you get this value instead of the base method value.
 */
export const PREFERRED_METHOD_POINTS = 50;

/**
 * Base points by interaction method.
 * Used when the method is NOT the contact's preferred method.
 *
 * In-person is always 50 regardless of preference — showing up matters.
 * Video calls are slightly higher than text/call (more investment than text, less than in-person).
 */
export const METHOD_POINTS: Record<InteractionMethod, number> = {
  text: 25,
  call: 25,
  email: 25,
  in_person: 50,  // Always high value — physical presence
  video: 35,      // More than text, less than in-person
  social: 20,     // Low investment
  other: 20,
};

// ===========================================================================
// Score Thresholds
// ===========================================================================

/**
 * Score thresholds for dartboard positioning and status.
 *
 * Score = pointsEarned / POINTS_REQUIRED
 *
 * Status mapping:
 *   - thriving: score >= 1.0 (100%+ of required points)
 *   - healthy: score >= 0.7 (70-99%)
 *   - slipping: score >= 0.4 (40-69%)
 *   - drifting: score < 0.4 (0-39%)
 */
export const SCORE_THRESHOLDS = {
  thriving: 1.0,
  healthy: 0.7,
  slipping: 0.4,
  drifting: 0,
} as const;

export type ScoreStatus = 'thriving' | 'healthy' | 'slipping' | 'drifting';

/**
 * Get the status label for a given score.
 */
export function getScoreStatus(score: number): ScoreStatus {
  if (score >= SCORE_THRESHOLDS.thriving) return 'thriving';
  if (score >= SCORE_THRESHOLDS.healthy) return 'healthy';
  if (score >= SCORE_THRESHOLDS.slipping) return 'slipping';
  return 'drifting';
}

// ===========================================================================
// Dartboard Configuration
// ===========================================================================

/**
 * Maximum contacts per dartboard visualization.
 * When a circle exceeds this, it splits into multiple dartboards.
 */
export const CONTACTS_PER_DARTBOARD = 50;

/**
 * Absolute maximum before forcing a split.
 * Between 50-75 is acceptable if the user prefers fewer dartboards.
 */
export const MAX_CONTACTS_PER_DARTBOARD = 75;

// ===========================================================================
// Point Calculation
// ===========================================================================

/**
 * Calculate points for a single interaction.
 *
 * @param method - The interaction method used
 * @param preferredMethod - The contact's preferred method (if set)
 * @returns Points earned for this interaction
 */
export function calculateInteractionPoints(
  method: InteractionMethod,
  preferredMethod: InteractionMethod | null,
): number {
  // In-person always gets full points
  if (method === 'in_person') {
    return METHOD_POINTS.in_person;
  }

  // Preferred method gets bonus points
  if (preferredMethod && method === preferredMethod) {
    return PREFERRED_METHOD_POINTS;
  }

  // Otherwise use base method points
  return METHOD_POINTS[method] ?? METHOD_POINTS.other;
}

/**
 * Calculate total points from a list of interactions.
 *
 * @param interactions - Array of interaction methods
 * @param preferredMethod - The contact's preferred method (if set)
 * @returns Total points earned
 */
export function calculateTotalPoints(
  interactions: InteractionMethod[],
  preferredMethod: InteractionMethod | null,
): number {
  return interactions.reduce(
    (total, method) => total + calculateInteractionPoints(method, preferredMethod),
    0,
  );
}

/**
 * Calculate score and status from points.
 *
 * @param pointsEarned - Total points earned in the cadence period
 * @returns Score (0-1+) and status
 */
export function calculateScore(pointsEarned: number): {
  score: number;
  status: ScoreStatus;
} {
  const score = pointsEarned / POINTS_REQUIRED;
  const status = getScoreStatus(score);
  return { score, status };
}

// ===========================================================================
// Dartboard Positioning
// ===========================================================================

export interface DartboardPosition {
  radius: number;  // 0 = center, 1 = edge, >1 = outside circle
  angle: number;   // 0-360 degrees
}

/**
 * Calculate dartboard position for a contact based on their score.
 *
 * Higher scores = closer to center.
 * Contacts are distributed around the circle with slight randomization
 * to avoid perfect geometric patterns.
 *
 * @param score - The contact's score (0 to 1+)
 * @param index - Contact's index in the list (for angle distribution)
 * @param totalContacts - Total contacts in this dartboard
 * @param seed - Optional seed for consistent randomization
 * @returns Position with radius and angle
 */
export function calculateDartboardPosition(
  score: number,
  index: number,
  totalContacts: number,
  seed?: number,
): DartboardPosition {
  // Use seeded random for consistent positioning across renders
  const random = seed !== undefined
    ? seededRandom(seed + index)
    : Math.random;

  let radius: number;

  if (score >= SCORE_THRESHOLDS.thriving) {
    // Thriving: cluster near center with slight spread
    radius = 0.1 + (random() * 0.15);
  } else if (score >= SCORE_THRESHOLDS.slipping) {
    // Healthy to slipping: linear mapping from center to edge
    // Score 1.0 = radius ~0.25, Score 0.4 = radius ~0.85
    radius = 0.25 + ((1.0 - score) * 0.6);
  } else {
    // Drifting: push outside the circle
    // Score 0.4 = radius 1.0, Score 0 = radius ~1.2
    radius = 1.0 + ((SCORE_THRESHOLDS.slipping - score) * 0.5);
  }

  // Distribute angles evenly with jitter to avoid perfect circles
  const baseAngle = (index / totalContacts) * 360;
  const jitter = (random() - 0.5) * 20; // ±10 degrees
  const angle = (baseAngle + jitter + 360) % 360;

  return { radius, angle };
}

/**
 * Simple seeded random number generator for consistent positioning.
 */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Estimate how many interactions of a given method are needed to stay in circle.
 * Useful for "You need X more calls this week" messaging.
 *
 * @param method - The interaction method
 * @param preferredMethod - The contact's preferred method
 * @param currentPoints - Points already earned this period
 * @returns Number of interactions needed
 */
export function interactionsNeeded(
  method: InteractionMethod,
  preferredMethod: InteractionMethod | null,
  currentPoints: number = 0,
): number {
  const pointsNeeded = Math.max(0, POINTS_REQUIRED - currentPoints);
  const pointsPerInteraction = calculateInteractionPoints(method, preferredMethod);
  return Math.ceil(pointsNeeded / pointsPerInteraction);
}

/**
 * Get a human-readable summary of what's needed to stay in circle.
 *
 * @param currentPoints - Points already earned
 * @param preferredMethod - The contact's preferred method
 * @returns Summary string like "2 calls" or "1 call or 2 texts"
 */
export function getPointsNeededSummary(
  currentPoints: number,
  preferredMethod: InteractionMethod | null,
): string {
  const remaining = POINTS_REQUIRED - currentPoints;

  if (remaining <= 0) {
    return "You're all set!";
  }

  const preferred = preferredMethod ?? 'call';
  const preferredNeeded = interactionsNeeded(preferred, preferredMethod, currentPoints);

  // If preferred method alone can cover it
  if (preferredNeeded === 1) {
    return `1 ${formatMethod(preferred)}`;
  }

  // Offer alternative with texts
  const textsNeeded = interactionsNeeded('text', preferredMethod, currentPoints);

  if (preferred === 'text') {
    return `${textsNeeded} texts`;
  }

  return `${preferredNeeded} ${formatMethod(preferred)}s or ${textsNeeded} texts`;
}

function formatMethod(method: InteractionMethod): string {
  switch (method) {
    case 'call': return 'call';
    case 'text': return 'text';
    case 'email': return 'email';
    case 'in_person': return 'visit';
    case 'video': return 'video call';
    case 'social': return 'social interaction';
    default: return 'interaction';
  }
}
