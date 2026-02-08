-- Migration: Add notification preferences to users table
-- Run after: 006_add_timezone.sql

-- Nudge frequency preference: how often the user wants proactive nudges
-- 'daily' = daily nudges (premium default)
-- 'weekly' = weekly digest only (free default)
-- 'as_needed' = only when relationships are red/critical
ALTER TABLE users ADD COLUMN nudge_frequency TEXT DEFAULT 'daily';

-- Quiet hours: time window when no SMS should be sent
-- Format: 'HH:MM' in 24-hour format (e.g., '22:00' for 10pm)
-- Both must be set together or both NULL
ALTER TABLE users ADD COLUMN quiet_hours_start TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN quiet_hours_end TEXT DEFAULT NULL;
