-- Migration: Add notification preferences to users table
-- Run after: initial schema

-- Nudge frequency preference: how often the user wants proactive nudges
-- 'daily' = daily nudges (premium default)
-- 'weekly' = weekly digest only (free default)
-- 'as_needed' = only when relationships are red/critical
ALTER TABLE users ADD COLUMN nudge_frequency TEXT DEFAULT 'daily'
  CHECK (nudge_frequency IN ('daily', 'weekly', 'as_needed'));

-- Quiet hours: time window when no SMS should be sent
-- Format: 'HH:MM' in 24-hour format (e.g., '22:00' for 10pm)
-- Both must be set together or both NULL
ALTER TABLE users ADD COLUMN quiet_hours_start TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN quiet_hours_end TEXT DEFAULT NULL;

-- User's timezone for scheduling nudges at appropriate local times
-- IANA timezone format (e.g., 'America/New_York', 'Europe/London')
-- This column may already exist from earlier migrations; this is idempotent
-- ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/New_York';

-- Preferred hour for nudge delivery (0-23, in user's local timezone)
-- Default 8 = 8am
-- This column may already exist from earlier migrations
-- ALTER TABLE users ADD COLUMN preferred_nudge_hour INTEGER DEFAULT 8;
