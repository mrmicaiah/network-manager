-- Migration: Add pending_context column to users table
-- Purpose: Store multi-turn conversation state for SMS routing
--
-- The pending context is a JSON blob that holds state between messages
-- when Bethany asks a clarifying question or presents options.
-- It expires after 5 minutes (enforced in application code).
--
-- Example value:
-- {
--   "type": "clarify_intent",
--   "originalIntent": "unknown",
--   "data": { "rawMessage": "Sarah" },
--   "createdAt": "2026-02-11T15:30:00.000Z"
-- }

ALTER TABLE users ADD COLUMN pending_context TEXT DEFAULT NULL;
