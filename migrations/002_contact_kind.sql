-- =============================================================================
-- Migration 002: Add contact_kind column for kin vs non-kin decay modifiers
-- =============================================================================
-- Roberts & Dunbar (2011, 2015) showed kin relationships are resistant to
-- decay — they maintain closeness even with reduced contact. This column
-- lets the health calculation apply relaxed thresholds for family contacts.
--
-- All existing contacts default to 'non_kin' (no behavior change).
-- Users can mark contacts as 'kin' to get more forgiving cadence windows.
-- =============================================================================

ALTER TABLE contacts
  ADD COLUMN contact_kind TEXT NOT NULL DEFAULT 'non_kin'
  CHECK (contact_kind IN ('kin', 'non_kin'));

-- Index for filtering by kin status
CREATE INDEX IF NOT EXISTS idx_contacts_user_kind
  ON contacts(user_id, contact_kind) WHERE archived = 0;
