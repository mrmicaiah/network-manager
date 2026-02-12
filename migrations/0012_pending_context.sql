-- Migration: Add pending_context column to users table
-- Purpose: Store multi-turn conversation state for SMS interactions
--
-- When Bethany asks a clarifying question, we need to remember what
-- she asked so the next message can be interpreted in context.
-- Without this, follow-up messages like "yes" or "the first one"
-- get classified as unknown/ambiguous.
--
-- The column stores JSON-serialized PendingContext from conversation-router.ts
-- It's cleared when the conversation completes (expectsReply = false)

ALTER TABLE users ADD COLUMN pending_context TEXT DEFAULT NULL;
