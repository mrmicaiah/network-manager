/**
 * Permission Service — RBAC permission checking
 *
 * Server-side enforcement layer for the admin dashboard.
 * Resolves a user's roles and permissions from the RBAC tables
 * and provides boolean check functions.
 *
 * All permission functions accept a `db` parameter (not env) to
 * match the existing service convention.
 *
 * Permissions are cached per-request using a module-level Map
 * keyed by userId. Call `clearPermissionCache()` at the start of
 * each request or rely on Workers' isolate lifecycle (each request
 * gets a fresh module instantiation in production).
 *
 * @see shared/models.ts for RoleName, ROLE_IDS, DEFAULT_PERMISSIONS
 * @see migrations/0010_rbac_tables.sql for schema
 * @see migrations/0011_rbac_seed_data.sql for seed data
 */

import { ROLE_IDS } from '../../shared/models';
import type { RoleRow, PermissionRow } from '../../shared/models';

// ===========================================================================
// Per-Request Cache
// ===========================================================================

/**
 * In-memory cache for the current request.
 * Workers execute each request in a fresh context, so this is
 * effectively per-request without manual clearing.
 *
 * For extra safety in long-lived dev servers, call
 * clearPermissionCache() at the top of your request handler.
 */
interface CachedPermissions {
  roles: string[];       // Role names (e.g., ['admin'])
  permissions: string[]; // Permission names (e.g., ['users:read', 'stats:read'])
}

const permissionCache = new Map<string, CachedPermissions>();

/**
 * Clear the permission cache. Call at request start if needed
 * (not required in production Workers where each request is isolated).
 */
export function clearPermissionCache(): void {
  permissionCache.clear();
}

// ===========================================================================
// Core Resolution
// ===========================================================================

/**
 * Resolve a user's roles and permissions from the database.
 * Results are cached for the duration of the request.
 *
 * @param db     - D1 database binding
 * @param userId - The user's UUID
 * @returns Cached permission set
 */
async function resolvePermissions(
  db: D1Database,
  userId: string,
): Promise<CachedPermissions> {
  // Return cached if available
  const cached = permissionCache.get(userId);
  if (cached) return cached;

  // Query roles for this user
  const roleRows = await db
    .prepare(
      `SELECT r.id, r.name, r.description
       FROM user_roles ur
       JOIN roles r ON ur.role_id = r.id
       WHERE ur.user_id = ?`
    )
    .bind(userId)
    .all<RoleRow>();

  const roles = (roleRows.results ?? []).map((r) => r.name);

  // If user has no roles, short-circuit
  if (roles.length === 0) {
    const empty: CachedPermissions = { roles: [], permissions: [] };
    permissionCache.set(userId, empty);
    return empty;
  }

  // Query permissions for all of the user's roles
  // Build placeholders for the IN clause
  const roleIds = (roleRows.results ?? []).map((r) => r.id);
  const placeholders = roleIds.map(() => '?').join(', ');

  const permRows = await db
    .prepare(
      `SELECT DISTINCT p.name
       FROM role_permissions rp
       JOIN permissions p ON rp.permission_id = p.id
       WHERE rp.role_id IN (${placeholders})`
    )
    .bind(...roleIds)
    .all<{ name: string }>();

  const permissions = (permRows.results ?? []).map((p) => p.name);

  const result: CachedPermissions = { roles, permissions };
  permissionCache.set(userId, result);
  return result;
}

// ===========================================================================
// Public API
// ===========================================================================

/**
 * Get the role names assigned to a user.
 *
 * @param db     - D1 database binding
 * @param userId - The user's UUID
 * @returns Array of role name strings (e.g., ['admin'])
 *
 * @example
 * const roles = await getUserRoles(env.DB, user.id);
 * // ['admin']
 */
export async function getUserRoles(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { roles } = await resolvePermissions(db, userId);
  return roles;
}

/**
 * Get all permission names for a user (union of all role permissions).
 *
 * @param db     - D1 database binding
 * @param userId - The user's UUID
 * @returns Array of permission name strings (e.g., ['users:read', 'stats:read'])
 *
 * @example
 * const perms = await getUserPermissions(env.DB, user.id);
 * // ['users:read', 'users:write', 'stats:read', 'activity:read', 'roles:read']
 */
export async function getUserPermissions(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { permissions } = await resolvePermissions(db, userId);
  return permissions;
}

/**
 * Check if a user has a specific permission.
 *
 * @param db             - D1 database binding
 * @param userId         - The user's UUID
 * @param permissionName - Permission to check (e.g., 'users:read')
 * @returns true if the user has the permission
 *
 * @example
 * if (await hasPermission(env.DB, user.id, 'users:read')) {
 *   // show user list
 * }
 */
export async function hasPermission(
  db: D1Database,
  userId: string,
  permissionName: string,
): Promise<boolean> {
  const { permissions } = await resolvePermissions(db, userId);
  return permissions.includes(permissionName);
}

/**
 * Check if a user has at least one of the specified permissions.
 *
 * @param db              - D1 database binding
 * @param userId          - The user's UUID
 * @param permissionNames - Permissions to check (OR logic)
 * @returns true if the user has any of the permissions
 *
 * @example
 * if (await hasAnyPermission(env.DB, user.id, ['users:read', 'stats:read'])) {
 *   // allow access to admin dashboard
 * }
 */
export async function hasAnyPermission(
  db: D1Database,
  userId: string,
  permissionNames: string[],
): Promise<boolean> {
  const { permissions } = await resolvePermissions(db, userId);
  return permissionNames.some((p) => permissions.includes(p));
}

/**
 * Check if a user has all of the specified permissions.
 *
 * @param db              - D1 database binding
 * @param userId          - The user's UUID
 * @param permissionNames - Permissions to check (AND logic)
 * @returns true if the user has every permission
 *
 * @example
 * if (await hasAllPermissions(env.DB, user.id, ['users:read', 'users:write'])) {
 *   // allow user editing
 * }
 */
export async function hasAllPermissions(
  db: D1Database,
  userId: string,
  permissionNames: string[],
): Promise<boolean> {
  const { permissions } = await resolvePermissions(db, userId);
  return permissionNames.every((p) => permissions.includes(p));
}

/**
 * Check if a user has any admin-level role (admin or superadmin).
 *
 * This is a convenience shorthand. For granular checks, prefer
 * hasPermission() with a specific permission name.
 *
 * @param db     - D1 database binding
 * @param userId - The user's UUID
 * @returns true if the user is an admin or superadmin
 *
 * @example
 * if (await isAdmin(env.DB, user.id)) {
 *   // show admin nav link
 * }
 */
export async function isAdmin(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const { roles } = await resolvePermissions(db, userId);
  return roles.includes('admin') || roles.includes('superadmin');
}

/**
 * Check if a user is a superadmin.
 *
 * @param db     - D1 database binding
 * @param userId - The user's UUID
 * @returns true if the user is a superadmin
 */
export async function isSuperAdmin(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  const { roles } = await resolvePermissions(db, userId);
  return roles.includes('superadmin');
}
