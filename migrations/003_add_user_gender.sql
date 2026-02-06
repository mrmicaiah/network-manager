-- =============================================================================
-- Migration 003: Add gender column to users table
-- =============================================================================
-- Adds an optional gender field for gender-aware network maintenance.
--
-- Research basis: Roberts & Dunbar (2011, 2015) found gender differences
-- in relationship maintenance patterns:
--   - Women maintain closeness primarily through conversation frequency
--   - Men maintain closeness primarily through shared activities
--
-- This field is opt-in (nullable, defaults to NULL = no modifiers applied).
-- When set, it enables soft cadence adjustments and nudge style preferences
-- via GENDER_MODIFIERS in shared/intent-config.ts.
--
-- Valid values: 'male', 'female', NULL
-- NULL means the user hasn't set a gender preference — system defaults apply.
--
-- @see shared/models.ts UserGender type
-- @see shared/intent-config.ts GENDER_MODIFIERS config
-- @see TASK-7281a01b-f
-- =============================================================================

ALTER TABLE users ADD COLUMN gender TEXT DEFAULT NULL
  CHECK (gender IS NULL OR gender IN ('male', 'female'));
