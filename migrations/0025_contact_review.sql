-- =============================================================================
-- Migration: 0025_contact_review.sql
-- Purpose: Add tables for the contact review system
-- =============================================================================
-- contact_analysis: Stores Bethany's analysis of each contact (suggestions,
--                   confidence, signals) for the review flow
-- review_sessions:  Tracks user progress through review sessions
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CONTACT_ANALYSIS
-- ---------------------------------------------------------------------------
-- Bethany's analysis of a contact — suggested intent, confidence, and
-- supporting signals. One analysis per contact (unique constraint).
-- Populated during contact import or when user triggers analysis.
-- reviewed = TRUE once user has seen and acted on the suggestion.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_analysis (
  id                      TEXT PRIMARY KEY,
  contact_id              TEXT NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
  suggested_intent        TEXT
    CHECK (suggested_intent IS NULL OR suggested_intent IN (
      'inner_circle', 'nurture', 'maintain', 'transactional', 'dormant'
    )),
  confidence              TEXT
    CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
  reasoning               TEXT,              -- Human-readable explanation for UI
  signals                 TEXT,              -- JSON blob of ContactAnalysisSignals
  reviewed                INTEGER NOT NULL DEFAULT 0,  -- 0 = pending, 1 = reviewed
  reviewed_at             TEXT,              -- ISO timestamp when user reviewed
  user_accepted_suggestion INTEGER,          -- NULL = not reviewed, 0 = rejected, 1 = accepted
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Find analysis by contact (fast lookup for review flow)
CREATE INDEX IF NOT EXISTS idx_contact_analysis_contact
  ON contact_analysis(contact_id);

-- Find unreviewed analyses (for review queue)
CREATE INDEX IF NOT EXISTS idx_contact_analysis_reviewed
  ON contact_analysis(reviewed)
  WHERE reviewed = 0;


-- ---------------------------------------------------------------------------
-- REVIEW_SESSIONS
-- ---------------------------------------------------------------------------
-- Tracks a user's contact review session. Created when user starts
-- reviewing contacts, completed when they finish or abandon.
-- Used for analytics and resuming interrupted sessions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_sessions (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at              TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at            TEXT,              -- NULL = in progress
  contacts_reviewed       INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Find sessions by user (for resume functionality)
CREATE INDEX IF NOT EXISTS idx_review_sessions_user
  ON review_sessions(user_id);

-- Find in-progress sessions
CREATE INDEX IF NOT EXISTS idx_review_sessions_active
  ON review_sessions(user_id, completed_at)
  WHERE completed_at IS NULL;
