-- Migration: Add onboarding_stage to users table
-- Part of TASK-36776bae-4 (post-signup SMS onboarding state machine)
--
-- Tracks where each user is in the onboarding conversation flow.
-- NULL = onboarding complete (or user signed up before this feature).
-- Values: intro_sent, user_replies, learn_circles, explain_features, ready
--
-- New users get 'intro_sent' set during web signup completion.
-- The SMS handler updates this as the conversation progresses.
-- Set to NULL when onboarding reaches 'ready' stage.

ALTER TABLE users ADD COLUMN onboarding_stage TEXT DEFAULT NULL;
