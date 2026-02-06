-- Migration: Add magic_tokens table for dashboard magic links
-- Used by dashboard-awareness.ts to generate pre-authenticated URLs
-- that Bethany can send via SMS for one-click dashboard access.

CREATE TABLE IF NOT EXISTS magic_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  redirect    TEXT NOT NULL DEFAULT '/overview',
  status      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  consumed_at TEXT
);

-- Index for token lookup (verify flow)
CREATE INDEX IF NOT EXISTS idx_magic_tokens_hash
  ON magic_tokens(token_hash, status);

-- Index for rate limiting (count recent tokens per user)
CREATE INDEX IF NOT EXISTS idx_magic_tokens_user_recent
  ON magic_tokens(user_id, created_at DESC);

-- Index for cleanup cron (purge old tokens)
CREATE INDEX IF NOT EXISTS idx_magic_tokens_created
  ON magic_tokens(created_at);