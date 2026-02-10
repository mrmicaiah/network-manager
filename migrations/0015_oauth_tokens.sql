-- Migration: Add oauth_tokens table for Google Contacts (and future OAuth providers)
-- Run: wrangler d1 execute network-manager-db --remote --file=migrations/0015_oauth_tokens.sql

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'google',
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TEXT NOT NULL,
  scopes          TEXT NOT NULL,
  sync_token      TEXT,
  last_sync       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_provider
  ON oauth_tokens(user_id, provider);

-- Store Google resource name on contacts for sync matching
ALTER TABLE contacts ADD COLUMN google_resource_name TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_google_resource
  ON contacts(user_id, google_resource_name);
