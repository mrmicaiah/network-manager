-- Migration: Add point system and dartboard support
-- Run: wrangler d1 execute network-manager-db --remote --file=migrations/005_point_system.sql

-- 1. Add preferred_method to contacts
-- The contact's preferred communication method (affects point scoring)
ALTER TABLE contacts ADD COLUMN preferred_method TEXT NULL;

-- 2. Add circle_context to interactions
-- Which circles this interaction counts toward (JSON array, null = all)
ALTER TABLE interactions ADD COLUMN circle_context TEXT NULL;

-- 3. Add dashboard preferences to users
-- default_circle_id: Which tab loads first
-- circle_tab_order: JSON array of circle IDs in display order
ALTER TABLE users ADD COLUMN default_circle_id TEXT NULL;
ALTER TABLE users ADD COLUMN circle_tab_order TEXT NULL;

-- 4. Create circle_scores cache table
-- Cached scores for fast dartboard rendering
-- Recalculated on interaction log and daily cron
CREATE TABLE IF NOT EXISTS circle_scores (
  contact_id TEXT NOT NULL,
  circle_id TEXT NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'drifting',
  calculated_at TEXT NOT NULL,
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
