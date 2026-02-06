-- =============================================================================
-- Bethany Network Manager — Seed Data (Local Development)
-- =============================================================================
-- Populates a realistic test dataset for local development.
-- Run: npm run db:seed:local
--
-- Creates:
--   1 test user (Micaiah)
--   4 default circles + 1 custom
--   8 contacts across intent types
--   Junction table links
--   Sample interactions
--   1 pending signup
--   1 usage tracking row
--   2 sample nudges
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Test User
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO users (id, phone, email, name, pin_hash, subscription_tier, trial_ends_at, created_at, updated_at)
VALUES (
  'usr-test-micaiah-001',
  '+15551234567',
  'test@example.com',
  'Micaiah',
  NULL,
  'trial',
  datetime('now', '+14 days'),
  datetime('now'),
  datetime('now')
);

-- ---------------------------------------------------------------------------
-- Default Circles
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO circles (id, user_id, name, type, sort_order, created_at, updated_at)
VALUES
  ('cir-family-001',    'usr-test-micaiah-001', 'Family',    'default', 1, datetime('now'), datetime('now')),
  ('cir-friends-001',   'usr-test-micaiah-001', 'Friends',   'default', 2, datetime('now'), datetime('now')),
  ('cir-work-001',      'usr-test-micaiah-001', 'Work',      'default', 3, datetime('now'), datetime('now')),
  ('cir-community-001', 'usr-test-micaiah-001', 'Community', 'default', 4, datetime('now'), datetime('now')),
  ('cir-church-001',    'usr-test-micaiah-001', 'Church',    'custom',  5, datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------------
-- Contacts (across intent types)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO contacts (id, user_id, name, phone, intent, last_contact_date, health_status, notes, source, archived, created_at, updated_at)
VALUES
  -- Inner Circle (2)
  ('con-mom-001',      'usr-test-micaiah-001', 'Mom',           '+15559001001', 'inner_circle', datetime('now', '-3 days'),  'green',  'Call every Sunday',              'manual',     0, datetime('now'), datetime('now')),
  ('con-jordan-001',   'usr-test-micaiah-001', 'Jordan',        '+15559001002', 'inner_circle', datetime('now', '-9 days'),  'yellow', 'Best friend since college',      'manual',     0, datetime('now'), datetime('now')),

  -- Nurture (2)
  ('con-sarah-001',    'usr-test-micaiah-001', 'Sarah Chen',    '+15559002001', 'nurture',      datetime('now', '-11 days'), 'green',  'Met at conference last year',    'braindump',  0, datetime('now'), datetime('now')),
  ('con-marcus-001',   'usr-test-micaiah-001', 'Marcus Wright', '+15559002002', 'nurture',      datetime('now', '-20 days'), 'red',    'College roommate',              'onboarding', 0, datetime('now'), datetime('now')),

  -- Maintain (2)
  ('con-lisa-001',     'usr-test-micaiah-001', 'Lisa Park',     NULL,           'maintain',     datetime('now', '-25 days'), 'green',  'Former coworker at Acme',       'import',     0, datetime('now'), datetime('now')),
  ('con-dave-001',     'usr-test-micaiah-001', 'Dave Miller',   '+15559003001', 'maintain',     datetime('now', '-45 days'), 'red',    'Neighbor, good guy',            'manual',     0, datetime('now'), datetime('now')),

  -- Transactional (1)
  ('con-recruiter-001','usr-test-micaiah-001', 'Alex Recruiter',NULL,           'transactional',datetime('now', '-60 days'), 'green',  'LinkedIn recruiter, good leads', 'manual',     0, datetime('now'), datetime('now')),

  -- New / unsorted (1)
  ('con-new-001',      'usr-test-micaiah-001', 'Taylor Kim',    '+15559004001', 'new',          NULL,                        'yellow', NULL,                            'braindump',  0, datetime('now'), datetime('now'));

-- ---------------------------------------------------------------------------
-- Contact ↔ Circle Links
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO contact_circles (contact_id, circle_id, added_at)
VALUES
  ('con-mom-001',       'cir-family-001',    datetime('now')),
  ('con-mom-001',       'cir-church-001',    datetime('now')),
  ('con-jordan-001',    'cir-friends-001',   datetime('now')),
  ('con-sarah-001',     'cir-work-001',      datetime('now')),
  ('con-marcus-001',    'cir-friends-001',   datetime('now')),
  ('con-lisa-001',      'cir-work-001',      datetime('now')),
  ('con-dave-001',      'cir-community-001', datetime('now')),
  ('con-recruiter-001', 'cir-work-001',      datetime('now'));

-- ---------------------------------------------------------------------------
-- Sample Interactions
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO interactions (id, user_id, contact_id, date, method, summary, logged_via, created_at)
VALUES
  ('int-001', 'usr-test-micaiah-001', 'con-mom-001',    datetime('now', '-3 days'),  'call',      'Sunday call — talked about Thanksgiving plans', 'sms',       datetime('now')),
  ('int-002', 'usr-test-micaiah-001', 'con-mom-001',    datetime('now', '-10 days'), 'call',      'Quick check-in',                                'sms',       datetime('now')),
  ('int-003', 'usr-test-micaiah-001', 'con-jordan-001', datetime('now', '-9 days'),  'text',      'Texted about the game',                         'auto',      datetime('now')),
  ('int-004', 'usr-test-micaiah-001', 'con-sarah-001',  datetime('now', '-11 days'), 'in_person', 'Coffee downtown',                               'dashboard', datetime('now')),
  ('int-005', 'usr-test-micaiah-001', 'con-marcus-001', datetime('now', '-20 days'), 'text',      'Birthday text',                                 'sms',       datetime('now')),
  ('int-006', 'usr-test-micaiah-001', 'con-lisa-001',   datetime('now', '-25 days'), 'email',     'Forwarded article about ML',                    'dashboard', datetime('now')),
  ('int-007', 'usr-test-micaiah-001', 'con-dave-001',   datetime('now', '-45 days'), 'in_person', 'Waved over the fence',                          'sms',       datetime('now'));

-- ---------------------------------------------------------------------------
-- Pending Signup (for testing the signup flow)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO pending_signups (id, token, phone, name, circles_discussed, status, created_at, expires_at)
VALUES (
  'ps-test-001',
  'test-token-abc123def456ghi789',
  '+15559999999',
  'Test User',
  '["Friends", "Work"]',
  'pending',
  datetime('now'),
  datetime('now', '+24 hours')
);

-- ---------------------------------------------------------------------------
-- Usage Tracking (today)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO usage_tracking (id, user_id, date, messages_sent, nudges_generated, contacts_added, braindumps_processed, created_at)
VALUES (
  'ut-today-001',
  'usr-test-micaiah-001',
  date('now'),
  3,
  2,
  0,
  0,
  datetime('now')
);

-- ---------------------------------------------------------------------------
-- Sample Nudges
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO nudges (id, user_id, contact_id, message, reason, status, scheduled_for, created_at)
VALUES
  ('nud-001', 'usr-test-micaiah-001', 'con-jordan-001',
   'Jordan is one of your closest people — when''s the last time you just checked in? A 2-minute text can carry a lot of weight.',
   'inner_circle contact at yellow health (9 days since last contact)',
   'pending', datetime('now', '+2 hours'), datetime('now')),

  ('nud-002', 'usr-test-micaiah-001', 'con-marcus-001',
   'Marcus might be wondering where you went. It''s been a while — even a quick "how are things?" can reignite the connection.',
   'nurture contact at red health (20 days since last contact)',
   'pending', datetime('now', '+2 hours'), datetime('now'));
