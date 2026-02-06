-- Migration: Add trial messaging tracking columns to users table
-- Part of TASK-35e55da8-a (trial expiration messaging flow)
--
-- Tracks which trial messaging touchpoints have been sent.
-- last_trial_reminder: ISO timestamp of last trial-related message
-- trial_reminder_stage: Which reminder stage was last sent
--   - 'signup': Initial "14 days full access" message
--   - 'usage_highlight': Day 10-12 soft mention of usage stats
--   - 'upgrade_prompt': Day 12-13 upgrade CTA with stats
--   - 'expired': Day 14 downgrade notification

ALTER TABLE users ADD COLUMN last_trial_reminder TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN trial_reminder_stage TEXT DEFAULT NULL;
