-- =============================================================================
-- Bethany Network Manager — D1 Database Schema
-- =============================================================================
-- Maps 1:1 to TypeScript interfaces in shared/models.ts.
--
-- Conventions:
--   - All IDs are UUIDs stored as TEXT
--   - All timestamps are ISO 8601 TEXT
--   - Booleans stored as INTEGER (0/1) since D1/SQLite has no BOOLEAN
--   - CHECK constraints enforce enum-like values at the DB level
--   - Foreign keys use ON DELETE CASCADE where parent deletion should
--     propagate; ON DELETE RESTRICT where orphans would be a data bug
--
-- Run:
--   Local:  npm run db:migrate:local
--   Remote: npm run db:migrate
-- =============================================================================

-- Enable foreign key enforcement (SQLite has it off by default)
PRAGMA foreign_keys = ON;


-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
-- A registered person using the Network Manager.
-- Created when a PendingSignup is converted via web signup.
-- gender is optional (NULL = not set, no gender modifiers applied).
-- When set, enables gender-aware cadence adjustments and nudge style
-- preferences via GENDER_MODIFIERS in shared/intent-config.ts.
-- onboarding_stage tracks SMS onboarding flow (NULL = complete).
-- last_sorting_offer tracks when we last offered to sort unsorted contacts.
-- last_trial_reminder and trial_reminder_stage track trial lifecycle messaging.
-- default_circle_id is the dashboard tab that loads first.
-- circle_tab_order is a JSON array of circle IDs in display order.
-- timezone is the user's IANA timezone for scheduling nudges.
-- preferred_nudge_hour is the hour (0-23) when nudges should be delivered.
-- nudge_frequency controls how often proactive nudges are sent.
-- quiet_hours_start/end define a window when no SMS should be sent.
-- @see Roberts & Dunbar (2011, 2015) for gender maintenance patterns.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  phone               TEXT NOT NULL UNIQUE,
  email               TEXT,
  name                TEXT NOT NULL,
  pin_hash            TEXT,
  passphrase          TEXT,
  last_pin_verified   TEXT,
  account_locked      INTEGER NOT NULL DEFAULT 0,
  failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
  subscription_tier   TEXT NOT NULL DEFAULT 'trial'
    CHECK (subscription_tier IN ('free', 'trial', 'premium')),
  trial_ends_at       TEXT,
  stripe_customer_id  TEXT,
  gender              TEXT DEFAULT NULL
    CHECK (gender IS NULL OR gender IN ('male', 'female')),
  onboarding_stage    TEXT DEFAULT NULL,
  last_sorting_offer  TEXT DEFAULT NULL,
  last_trial_reminder TEXT DEFAULT NULL,
  trial_reminder_stage TEXT DEFAULT NULL,
  default_circle_id   TEXT DEFAULT NULL,
  circle_tab_order    TEXT DEFAULT NULL,
  timezone            TEXT DEFAULT 'America/Chicago',
  preferred_nudge_hour INTEGER DEFAULT 8,
  nudge_frequency     TEXT DEFAULT 'daily'
    CHECK (nudge_frequency IN ('daily', 'weekly', 'as_needed')),
  quiet_hours_start   TEXT DEFAULT NULL,
  quiet_hours_end     TEXT DEFAULT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_subscription ON users(subscription_tier);


-- ---------------------------------------------------------------------------
-- CONTACTS
-- ---------------------------------------------------------------------------
-- A person in a user's network. Circles linked via contact_circles junction.
-- health_status is denormalized — recalculated by weekly cron and on
-- interaction logging.
-- contact_kind distinguishes kin (family) from non-kin contacts.
-- Kin contacts get relaxed cadence thresholds per Roberts & Dunbar (2011).
-- preferred_method is the contact's preferred communication method.
-- When set, this method scores higher points in the dartboard system.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  phone               TEXT,
  email               TEXT,
  intent              TEXT NOT NULL DEFAULT 'new'
    CHECK (intent IN ('inner_circle', 'nurture', 'maintain', 'transactional', 'dormant', 'new')),
  custom_cadence_days INTEGER,
  last_contact_date   TEXT,
  health_status       TEXT NOT NULL DEFAULT 'yellow'
    CHECK (health_status IN ('green', 'yellow', 'red')),
  contact_kind        TEXT NOT NULL DEFAULT 'non_kin'
    CHECK (contact_kind IN ('kin', 'non_kin')),
  preferred_method    TEXT DEFAULT NULL
    CHECK (preferred_method IS NULL OR preferred_method IN ('text', 'call', 'in_person', 'email', 'video', 'social', 'other')),
  notes               TEXT,
  source              TEXT,
  archived            INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Primary query: all active contacts for a user
CREATE INDEX IF NOT EXISTS idx_contacts_user_active
  ON contacts(user_id, archived) WHERE archived = 0;

-- Dashboard filters
CREATE INDEX IF NOT EXISTS idx_contacts_user_intent
  ON contacts(user_id, intent) WHERE archived = 0;

CREATE INDEX IF NOT EXISTS idx_contacts_user_health
  ON contacts(user_id, health_status) WHERE archived = 0;

-- Filter by contact kind (kin vs non-kin)
CREATE INDEX IF NOT EXISTS idx_contacts_user_kind
  ON contacts(user_id, contact_kind) WHERE archived = 0;

-- Nudge generation: find contacts due for check-in
CREATE INDEX IF NOT EXISTS idx_contacts_health_cadence
  ON contacts(health_status, intent, last_contact_date)
  WHERE archived = 0 AND intent NOT IN ('dormant', 'new');

-- Name search
CREATE INDEX IF NOT EXISTS idx_contacts_user_name
  ON contacts(user_id, name COLLATE NOCASE);


-- ---------------------------------------------------------------------------
-- CIRCLES
-- ---------------------------------------------------------------------------
-- Named groups for organizing contacts. Default circles created on signup;
-- users can add custom ones.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS circles (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'custom'
    CHECK (type IN ('default', 'custom')),
  default_cadence_days INTEGER,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),

  -- Prevent duplicate circle names per user
  UNIQUE(user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_circles_user ON circles(user_id, sort_order);


-- ---------------------------------------------------------------------------
-- CONTACT_CIRCLES (junction)
-- ---------------------------------------------------------------------------
-- Many-to-many: a contact can belong to multiple circles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_circles (
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  circle_id           TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  added_at            TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (contact_id, circle_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_circles_circle ON contact_circles(circle_id);


-- ---------------------------------------------------------------------------
-- INTERACTIONS
-- ---------------------------------------------------------------------------
-- A logged touchpoint between user and contact. user_id denormalized for
-- fast per-user queries without joining through contacts.
-- circle_context is a JSON array of circle IDs this interaction counts for.
-- NULL means it counts for all circles the contact belongs to.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interactions (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  date                TEXT NOT NULL,
  method              TEXT NOT NULL DEFAULT 'other'
    CHECK (method IN ('text', 'call', 'in_person', 'email', 'video', 'social', 'other')),
  summary             TEXT,
  logged_via          TEXT NOT NULL DEFAULT 'dashboard',
  circle_context      TEXT DEFAULT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Timeline view: recent interactions for a contact
CREATE INDEX IF NOT EXISTS idx_interactions_contact_date
  ON interactions(contact_id, date DESC);

-- User-level activity feed
CREATE INDEX IF NOT EXISTS idx_interactions_user_date
  ON interactions(user_id, date DESC);


-- ---------------------------------------------------------------------------
-- PENDING_SIGNUPS
-- ---------------------------------------------------------------------------
-- Temporary records created during SMS onboarding. Converted to a real
-- User record on web signup completion.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_signups (
  id                  TEXT PRIMARY KEY,
  token               TEXT NOT NULL UNIQUE,
  phone               TEXT NOT NULL,
  name                TEXT,
  circles_discussed   TEXT NOT NULL DEFAULT '[]',
  onboarding_context  TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'used', 'expired')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at          TEXT NOT NULL,
  used_at             TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_signups_token ON pending_signups(token);
CREATE INDEX IF NOT EXISTS idx_pending_signups_phone ON pending_signups(phone);
CREATE INDEX IF NOT EXISTS idx_pending_signups_status ON pending_signups(status)
  WHERE status = 'pending';


-- ---------------------------------------------------------------------------
-- USAGE_TRACKING
-- ---------------------------------------------------------------------------
-- Daily usage counters per user. One row per user per day.
-- Used to enforce free tier limits and track engagement.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_tracking (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date                  TEXT NOT NULL,
  messages_sent         INTEGER NOT NULL DEFAULT 0,
  nudges_generated      INTEGER NOT NULL DEFAULT 0,
  contacts_added        INTEGER NOT NULL DEFAULT 0,
  braindumps_processed  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),

  -- One row per user per day
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_tracking(user_id, date DESC);


-- ---------------------------------------------------------------------------
-- NUDGES
-- ---------------------------------------------------------------------------
-- Bethany-generated reminders to reach out to a contact.
-- Created by the daily nudge generation cron, delivered during the
-- morning SMS window.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nudges (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message             TEXT NOT NULL,
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'delivered', 'dismissed', 'acted_on')),
  scheduled_for       TEXT NOT NULL,
  delivered_at        TEXT,
  dismissed_at        TEXT,
  acted_on_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Delivery cron: find pending nudges ready to send
CREATE INDEX IF NOT EXISTS idx_nudges_pending_delivery
  ON nudges(status, scheduled_for)
  WHERE status = 'pending';

-- User's nudge history
CREATE INDEX IF NOT EXISTS idx_nudges_user_date
  ON nudges(user_id, created_at DESC);

-- Prevent duplicate nudges for same contact on same day
CREATE INDEX IF NOT EXISTS idx_nudges_user_contact_date
  ON nudges(user_id, contact_id, scheduled_for);


-- ---------------------------------------------------------------------------
-- CIRCLE_SCORES
-- ---------------------------------------------------------------------------
-- Cached relationship scores for dartboard visualization.
-- Recalculated on interaction log and daily cron.
-- score is the ratio of points_earned / 100 (required).
-- status is derived from score thresholds.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS circle_scores (
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  circle_id           TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
  points_earned       INTEGER NOT NULL DEFAULT 0,
  score               REAL NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'drifting'
    CHECK (status IN ('thriving', 'healthy', 'slipping', 'drifting')),
  calculated_at       TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (contact_id, circle_id)
);

-- Dartboard rendering: all contacts in a circle
CREATE INDEX IF NOT EXISTS idx_circle_scores_circle ON circle_scores(circle_id);

-- Filter by status (e.g., "show drifting contacts")
CREATE INDEX IF NOT EXISTS idx_circle_scores_status ON circle_scores(circle_id, status);

-- Recalculation cron: find stale scores
CREATE INDEX IF NOT EXISTS idx_circle_scores_calculated ON circle_scores(calculated_at);


-- =============================================================================
-- RBAC — Role-Based Access Control
-- =============================================================================
-- Foundation for the admin dashboard. Supports roles, granular permissions,
-- role assignment, and an immutable audit trail.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- ROLES
-- ---------------------------------------------------------------------------
-- Named roles that can be assigned to users.
-- Default roles (user, admin, superadmin) should be seeded on first deploy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------
-- Granular permission definitions using resource:action pattern.
-- e.g., name='users:read', resource='users', action='read'
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  resource    TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ---------------------------------------------------------------------------
-- ROLE_PERMISSIONS (junction)
-- ---------------------------------------------------------------------------
-- Maps permissions to roles. A role can have many permissions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (role_id, permission_id)
);


-- ---------------------------------------------------------------------------
-- USER_ROLES (junction)
-- ---------------------------------------------------------------------------
-- Assigns roles to users. A user can have multiple roles.
-- granted_by tracks who performed the assignment (null for system-assigned).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by  TEXT REFERENCES users(id) ON DELETE SET NULL,

  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id);


-- ---------------------------------------------------------------------------
-- ADMIN_AUDIT_LOG
-- ---------------------------------------------------------------------------
-- Immutable log of all admin actions for accountability and debugging.
-- details is a JSON blob capturing what changed (before/after state).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  details       TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_user_date
  ON admin_audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_resource
  ON admin_audit_log(resource_type, resource_id);
