-- =============================================================================
-- Migration 0011: Seed Default RBAC Roles & Permissions
-- =============================================================================
-- Inserts the three default roles (user, admin, superadmin), eight default
-- permissions, and the role→permission mappings.
--
-- Uses deterministic UUIDs so they can be referenced reliably in code.
-- INSERT OR IGNORE ensures this migration is idempotent.
--
-- Depends on: 0010_rbac_tables.sql
--
-- Run:
--   wrangler d1 execute network-manager-db --remote --file=migrations/0011_rbac_seed_data.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ROLES
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO roles (id, name, description, created_at, updated_at) VALUES
  ('role-user-00000000-0000-0000-0001', 'user', 'Standard user — no admin access', datetime('now'), datetime('now')),
  ('role-admin-0000000-0000-0000-0002', 'admin', 'Admin — can view dashboard, manage users, view stats', datetime('now'), datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'superadmin', 'Super admin — full access including role management', datetime('now'), datetime('now'));


-- ---------------------------------------------------------------------------
-- PERMISSIONS
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO permissions (id, name, resource, action, description, created_at) VALUES
  -- Users
  ('perm-users-read-0000-0000-0001', 'users:read', 'users', 'read', 'View user list and details', datetime('now')),
  ('perm-users-write-000-0000-0002', 'users:write', 'users', 'write', 'Edit user details, change subscription tier', datetime('now')),
  ('perm-users-delete-00-0000-0003', 'users:delete', 'users', 'delete', 'Delete user accounts', datetime('now')),
  -- Stats
  ('perm-stats-read-0000-0000-0004', 'stats:read', 'stats', 'read', 'View admin dashboard stats', datetime('now')),
  -- Activity
  ('perm-activity-read-00-0000-0005', 'activity:read', 'activity', 'read', 'View audit log and activity feed', datetime('now')),
  -- Roles
  ('perm-roles-read-0000-0000-0006', 'roles:read', 'roles', 'read', 'View roles and permissions', datetime('now')),
  ('perm-roles-write-000-0000-0007', 'roles:write', 'roles', 'write', 'Assign and remove roles from users', datetime('now')),
  ('perm-roles-manage-00-0000-0008', 'roles:manage', 'roles', 'manage', 'Create, edit, and delete roles and permissions', datetime('now'));


-- ---------------------------------------------------------------------------
-- ROLE → PERMISSION MAPPINGS
-- ---------------------------------------------------------------------------

-- admin: users:read, users:write, stats:read, activity:read, roles:read
INSERT OR IGNORE INTO role_permissions (role_id, permission_id, granted_at) VALUES
  ('role-admin-0000000-0000-0000-0002', 'perm-users-read-0000-0000-0001', datetime('now')),
  ('role-admin-0000000-0000-0000-0002', 'perm-users-write-000-0000-0002', datetime('now')),
  ('role-admin-0000000-0000-0000-0002', 'perm-stats-read-0000-0000-0004', datetime('now')),
  ('role-admin-0000000-0000-0000-0002', 'perm-activity-read-00-0000-0005', datetime('now')),
  ('role-admin-0000000-0000-0000-0002', 'perm-roles-read-0000-0000-0006', datetime('now'));

-- superadmin: ALL permissions
INSERT OR IGNORE INTO role_permissions (role_id, permission_id, granted_at) VALUES
  ('role-superadmin-000-0000-0000-0003', 'perm-users-read-0000-0000-0001', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-users-write-000-0000-0002', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-users-delete-00-0000-0003', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-stats-read-0000-0000-0004', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-activity-read-00-0000-0005', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-roles-read-0000-0000-0006', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-roles-write-000-0000-0007', datetime('now')),
  ('role-superadmin-000-0000-0000-0003', 'perm-roles-manage-00-0000-0008', datetime('now'));

-- Note: 'user' role has NO permissions in role_permissions.
-- Regular users access their own data via the standard auth flow,
-- not through the RBAC permission system.
