-- =============================================================================
-- Migration 0010: Role-Based Access Control (RBAC) Tables
-- =============================================================================
-- Foundation for the admin dashboard. Creates roles, permissions,
-- role_permissions junction, user_roles assignment, and admin_audit_log.
--
-- Run:
--   wrangler d1 execute network-manager-db --remote --file=migrations/0010_rbac_tables.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ROLES
-- ---------------------------------------------------------------------------
-- Named roles that can be assigned to users.
-- Default roles (user, admin, superadmin) should be seeded after migration.
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
