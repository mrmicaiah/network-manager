-- =============================================================================
-- Migration: Add verification_codes table for web dashboard SMS auth
-- =============================================================================
-- Required by: worker/services/auth-service.ts
-- Run after: schema.sql (base schema)
--
-- This table stores short-lived SMS verification codes for the web dashboard
-- login flow. Codes are hashed with HMAC-SHA256 before storage.
--
-- Lifecycle:
--   pending  → Code sent, awaiting user input
--   verified → Code matched, session created
--   expired  → TTL reached or too many attempts
--
-- Cleanup: purgeExpiredCodes() deletes rows older than 24 hours.
-- =============================================================================

CREATE TABLE IF NOT EXISTS verification_codes (
  id            TEXT PRIMARY KEY,
  phone         TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL
);

-- Primary lookup: find pending codes for a phone
CREATE INDEX IF NOT EXISTS idx_verification_codes_phone
  ON verification_codes(phone, status, created_at DESC);

-- Cleanup cron: find old codes to purge
CREATE INDEX IF NOT EXISTS idx_verification_codes_created
  ON verification_codes(created_at)
  WHERE status IN ('verified', 'expired');
