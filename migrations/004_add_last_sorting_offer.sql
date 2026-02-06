-- Migration: Add last_sorting_offer to users table
-- Part of TASK-eaeac267-0 (weekly sorting check-in trigger)
--
-- Tracks when we last offered to help the user sort unsorted contacts.
-- Used to prevent spamming — only offer once per week maximum.
-- NULL = never offered yet.

ALTER TABLE users ADD COLUMN last_sorting_offer TEXT DEFAULT NULL;
