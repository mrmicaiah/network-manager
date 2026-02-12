/**
 * Review Session Service — Track user progress through contact review flow.
 *
 * Manages review_sessions table: creates sessions when users start reviewing,
 * updates progress as they go, and marks sessions complete when done.
 *
 * @see shared/models.ts for ReviewSessionRow
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { ReviewSessionRow } from '../../shared/models';

// ===========================================================================
// Session Management
// ===========================================================================

/**
 * Start a new review session for a user.
 * If there's already an active (incomplete) session, returns that instead.
 */
export async function startReviewSession(
  db: D1Database,
  userId: string,
): Promise<ReviewSessionRow> {
  // Check for existing active session
  const existing = await db.prepare(`
    SELECT * FROM review_sessions
    WHERE user_id = ? AND completed_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).bind(userId).first<ReviewSessionRow>();

  if (existing) {
    return existing;
  }

  // Create new session
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO review_sessions (id, user_id, started_at, contacts_reviewed)
    VALUES (?, ?, ?, 0)
  `).bind(id, userId, now).run();

  const session = await db.prepare(`
    SELECT * FROM review_sessions WHERE id = ?
  `).bind(id).first<ReviewSessionRow>();

  return session!;
}

/**
 * Get the active (incomplete) review session for a user.
 * Returns null if no active session exists.
 */
export async function getActiveSession(
  db: D1Database,
  userId: string,
): Promise<ReviewSessionRow | null> {
  return db.prepare(`
    SELECT * FROM review_sessions
    WHERE user_id = ? AND completed_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1
  `).bind(userId).first<ReviewSessionRow>();
}

/**
 * Increment the contacts_reviewed counter for a session.
 * Called each time a user reviews a contact.
 */
export async function incrementReviewCount(
  db: D1Database,
  sessionId: string,
): Promise<void> {
  await db.prepare(`
    UPDATE review_sessions
    SET contacts_reviewed = contacts_reviewed + 1
    WHERE id = ?
  `).bind(sessionId).run();
}

/**
 * Mark a review session as complete.
 */
export async function completeSession(
  db: D1Database,
  sessionId: string,
): Promise<ReviewSessionRow | null> {
  const now = new Date().toISOString();

  await db.prepare(`
    UPDATE review_sessions
    SET completed_at = ?
    WHERE id = ?
  `).bind(now, sessionId).run();

  return db.prepare(`
    SELECT * FROM review_sessions WHERE id = ?
  `).bind(sessionId).first<ReviewSessionRow>();
}

/**
 * Get a specific session by ID.
 */
export async function getSession(
  db: D1Database,
  sessionId: string,
): Promise<ReviewSessionRow | null> {
  return db.prepare(`
    SELECT * FROM review_sessions WHERE id = ?
  `).bind(sessionId).first<ReviewSessionRow>();
}

/**
 * Get session history for a user.
 */
export async function getUserSessionHistory(
  db: D1Database,
  userId: string,
  limit: number = 10,
): Promise<ReviewSessionRow[]> {
  const { results } = await db.prepare(`
    SELECT * FROM review_sessions
    WHERE user_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).bind(userId, limit).all<ReviewSessionRow>();

  return results;
}

/**
 * Get aggregate stats for a user's review sessions.
 */
export async function getUserSessionStats(
  db: D1Database,
  userId: string,
): Promise<{
  total_sessions: number;
  completed_sessions: number;
  total_contacts_reviewed: number;
  avg_contacts_per_session: number;
}> {
  const result = await db.prepare(`
    SELECT
      COUNT(*) as total_sessions,
      SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) as completed_sessions,
      SUM(contacts_reviewed) as total_contacts_reviewed
    FROM review_sessions
    WHERE user_id = ?
  `).bind(userId).first<{
    total_sessions: number;
    completed_sessions: number;
    total_contacts_reviewed: number;
  }>();

  const totalSessions = result?.total_sessions ?? 0;
  const completedSessions = result?.completed_sessions ?? 0;
  const totalReviewed = result?.total_contacts_reviewed ?? 0;

  return {
    total_sessions: totalSessions,
    completed_sessions: completedSessions,
    total_contacts_reviewed: totalReviewed,
    avg_contacts_per_session: totalSessions > 0 ? totalReviewed / totalSessions : 0,
  };
}
