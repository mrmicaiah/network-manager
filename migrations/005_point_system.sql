-- Migration: Add point system and dartboard support
-- Run: wrangler d1 execute network-manager-db --remote --file=migrations/005_point_system.sql
--
-- This migration adds:
-- 1. contacts.preferred_method — contact's preferred communication method
-- 2. interactions.circle_context — which circles an interaction counts for
-- 3. users.default_circle_id — dashboard tab that loads first
-- 4. users.circle_tab_order — custom tab ordering (JSON array)
-- 5. circle_scores table — cached scores for dartboard rendering
--
-- NOTE: SQLite doesn't support CHECK constraints in ALTER TABLE ADD COLUMN,
-- but the constraint is enforced in schema.sql for fresh installs.
-- The application layer validates values before insert/update.

-- 1. Add preferred_method to contacts
-- The contact's preferred communication method (affects point scoring)
-- Valid values: text, call, in_person, email, video, social, other
ALTER TABLE contacts ADD COLUMN preferred_method TEXT DEFAULT NULL;

-- 2. Add circle_context to interactions
-- Which circles this interaction counts toward (JSON array of circle IDs)
-- NULL means it counts for all circles the contact belongs to
ALTER TABLE interactions ADD COLUMN circle_context TEXT DEFAULT NULL;

-- 3. Add dashboard preferences to users
-- default_circle_id: Which tab loads first (FK to circles, not enforced)
ALTER TABLE users ADD COLUMN default_circle_id TEXT DEFAULT NULL;

-- circle_tab_order: JSON array of circle IDs in display order
ALTER TABLE users ADD COLUMN circle_tab_order TEXT DEFAULT NULL;

-- 4. Create circle_scores cache table
-- Cached scores for fast dartboard rendering
-- Recalculated on interaction log and daily cron
CREATE TABLE IF NOT EXISTS circle_scores (
  contact_id TEXT NOT NULL,
  circle_id TEXT NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'drifting'
    CHECK (status IN ('thriving', 'healthy', 'slipping', 'drifting')),
  calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contact_id, circle_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE CASCADE
);

-- Index for fetching all scores for a circle (dartboard rendering)
CREATE INDEX IF NOT EXISTS idx_circle_scores_circle ON circle_scores(circle_id);

-- Index for filtering by status (e.g., "show me all drifting contacts")
CREATE INDEX IF NOT EXISTS idx_circle_scores_status ON circle_scores(circle_id, status);

-- Index for recalculation jobs (find stale scores)
CREATE INDEX IF NOT EXISTS idx_circle_scores_calculated ON circle_scores(calculated_at);
