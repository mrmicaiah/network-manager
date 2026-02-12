/**
 * Contact Review API Routes — Endpoints for the guided review flow.
 *
 * Routes:
 *   GET  /api/review/stats     — Review progress stats
 *   GET  /api/review/batch     — Next batch of contacts to review
 *   POST /api/review/analyze   — Trigger analysis for user's contacts
 *   POST /api/review/respond   — Submit review decision for a contact
 *   POST /api/review/session/start    — Start a review session
 *   POST /api/review/session/complete — Complete the current session
 *   GET  /api/review/session   — Get current session info
 *
 * @see worker/services/contact-analysis-service.ts
 * @see worker/services/review-session-service.ts
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Env } from '../../shared/types';
import type { UserRow, SortableIntentType } from '../../shared/models';
import { jsonResponse, errorResponse } from '../../shared/http';
import {
  analyzeUserContacts,
  getNextReviewBatch,
  markReviewed,
  getUserReviewStats,
  getContactAnalysis,
} from '../services/contact-analysis-service';
import {
  startReviewSession,
  getActiveSession,
  incrementReviewCount,
  completeSession,
  getUserSessionStats,
} from '../services/review-session-service';
import { updateContactScores } from '../services/score-service';

// ===========================================================================
// Route Handler
// ===========================================================================

export async function handleReviewRoute(
  request: Request,
  env: Env,
  user: UserRow,
  path: string,
  method: string,
): Promise<Response> {
  const db = env.DB;

  try {
    // GET /api/review/stats
    if (path === '/api/review/stats' && method === 'GET') {
      return handleGetStats(db, user.id);
    }

    // GET /api/review/batch
    if (path === '/api/review/batch' && method === 'GET') {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '5', 10), 20);
      return handleGetBatch(db, user.id, limit);
    }

    // POST /api/review/analyze
    if (path === '/api/review/analyze' && method === 'POST') {
      return handleAnalyze(db, user.id);
    }

    // POST /api/review/respond
    if (path === '/api/review/respond' && method === 'POST') {
      return handleRespond(request, db, user.id);
    }

    // POST /api/review/session/start
    if (path === '/api/review/session/start' && method === 'POST') {
      return handleStartSession(db, user.id);
    }

    // POST /api/review/session/complete
    if (path === '/api/review/session/complete' && method === 'POST') {
      return handleCompleteSession(db, user.id);
    }

    // GET /api/review/session
    if (path === '/api/review/session' && method === 'GET') {
      return handleGetSession(db, user.id);
    }

    return errorResponse('Not found', 404);
  } catch (err) {
    console.error(`[review] ${method} ${path} error:`, err);
    return errorResponse('Internal server error', 500);
  }
}

// ===========================================================================
// Handlers
// ===========================================================================

/**
 * GET /api/review/stats
 * Returns review progress stats for the user.
 */
async function handleGetStats(db: D1Database, userId: string): Promise<Response> {
  const [reviewStats, sessionStats] = await Promise.all([
    getUserReviewStats(db, userId),
    getUserSessionStats(db, userId),
  ]);

  return jsonResponse({
    data: {
      contacts: reviewStats,
      sessions: sessionStats,
    },
  });
}

/**
 * GET /api/review/batch
 * Returns the next batch of contacts to review.
 */
async function handleGetBatch(
  db: D1Database,
  userId: string,
  limit: number,
): Promise<Response> {
  const batch = await getNextReviewBatch(db, userId, limit);

  return jsonResponse({
    data: {
      contacts: batch,
      hasMore: batch.length === limit,
    },
  });
}

/**
 * POST /api/review/analyze
 * Triggers analysis for all unsorted contacts.
 */
async function handleAnalyze(db: D1Database, userId: string): Promise<Response> {
  const result = await analyzeUserContacts(db, userId);

  return jsonResponse({
    data: {
      analyzed: result.analyzed,
      skipped: result.skipped,
      message: result.analyzed > 0
        ? `Analyzed ${result.analyzed} contacts`
        : 'No new contacts to analyze',
    },
  });
}

/**
 * POST /api/review/respond
 * Submit a review decision for a contact.
 *
 * Body: {
 *   contact_id: string,
 *   chosen_intent: SortableIntentType,
 *   session_id?: string  // Optional, for tracking
 * }
 */
async function handleRespond(
  request: Request,
  db: D1Database,
  userId: string,
): Promise<Response> {
  const body = await request.json<{
    contact_id: string;
    chosen_intent: SortableIntentType;
    session_id?: string;
  }>();

  if (!body.contact_id) {
    return errorResponse('contact_id is required', 400);
  }
  if (!body.chosen_intent) {
    return errorResponse('chosen_intent is required', 400);
  }

  const validIntents: SortableIntentType[] = [
    'inner_circle', 'nurture', 'maintain', 'transactional', 'dormant',
  ];
  if (!validIntents.includes(body.chosen_intent)) {
    return errorResponse('Invalid chosen_intent', 400);
  }

  // Verify contact belongs to user
  const contact = await db.prepare(`
    SELECT id, intent FROM contacts WHERE id = ? AND user_id = ?
  `).bind(body.contact_id, userId).first<{ id: string; intent: string }>();

  if (!contact) {
    return errorResponse('Contact not found', 404);
  }

  // Get the analysis to determine if user accepted suggestion
  const analysis = await getContactAnalysis(db, body.contact_id);
  const acceptedSuggestion = analysis?.suggested_intent === body.chosen_intent;

  // Mark as reviewed and update contact intent
  await markReviewed(db, body.contact_id, acceptedSuggestion, body.chosen_intent);

  // Update dartboard scores
  await updateContactScores(db, body.contact_id);

  // Increment session counter if session provided
  if (body.session_id) {
    await incrementReviewCount(db, body.session_id);
  }

  return jsonResponse({
    data: {
      success: true,
      contact_id: body.contact_id,
      new_intent: body.chosen_intent,
      accepted_suggestion: acceptedSuggestion,
    },
  });
}

/**
 * POST /api/review/session/start
 * Start a new review session (or return existing active session).
 */
async function handleStartSession(db: D1Database, userId: string): Promise<Response> {
  const session = await startReviewSession(db, userId);

  return jsonResponse({
    data: {
      session,
      isNew: session.contacts_reviewed === 0,
    },
  });
}

/**
 * POST /api/review/session/complete
 * Mark the current session as complete.
 */
async function handleCompleteSession(db: D1Database, userId: string): Promise<Response> {
  const active = await getActiveSession(db, userId);

  if (!active) {
    return errorResponse('No active session to complete', 400);
  }

  const completed = await completeSession(db, active.id);

  return jsonResponse({
    data: {
      session: completed,
      message: `Session complete! Reviewed ${completed?.contacts_reviewed ?? 0} contacts.`,
    },
  });
}

/**
 * GET /api/review/session
 * Get the current active session info.
 */
async function handleGetSession(db: D1Database, userId: string): Promise<Response> {
  const session = await getActiveSession(db, userId);

  return jsonResponse({
    data: {
      session,
      hasActiveSession: !!session,
    },
  });
}
