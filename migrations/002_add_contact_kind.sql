-- =============================================================================
-- Migration 002: Add contact_kind to contacts table
-- =============================================================================
-- Adds kin/non_kin distinction for Dunbar decay modifiers.
--
-- Research basis: Roberts & Dunbar (2011, 2015) found kin relationships
-- resist decay even with reduced contact frequency, while friendships
-- require active maintenance. This field allows the health calculation
-- to apply relaxed thresholds for family contacts.
--
-- Default: 'non_kin' — conservative default, user opts into kin status.
-- The dashboard/Bethany can auto-suggest 'kin' when adding to Family circle.
-- =============================================================================

ALTER TABLE contacts
  ADD COLUMN contact_kind TEXT NOT NULL DEFAULT 'non_kin'
    CHECK (contact_kind IN ('kin', 'non_kin'));

-- Index for filtering by contact kind (e.g., "show me all family contacts")
CREATE INDEX IF NOT EXISTS idx_contacts_user_kind
  ON contacts(user_id, contact_kind) WHERE archived = 0;
