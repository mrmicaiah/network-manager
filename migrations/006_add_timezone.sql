-- Add timezone and preferred nudge hour to users table
-- Default to America/Chicago (Central Time) and 8am delivery

ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'America/Chicago';
ALTER TABLE users ADD COLUMN preferred_nudge_hour INTEGER DEFAULT 8;
