/**
 * Permission Middleware — route-level permission enforcement
 *
 * Factory function that creates a permission check for API routes.
 * Works with the existing requireAuth() pattern from auth-service.ts.
 *
 * Usage in route handlers:
 *
 *   // Single permission check
 *   const permCheck = await requirePermission(env.DB, user.id, 'users:read', request);
 *   if (!permCheck.allowed) return permCheck.response;
 *
 *   // Multiple permissions (any)
 *   const permCheck = await requireAnyPermission(env.DB, user.id, ['users:read', 'stats:read'], request);
 *   if (!permCheck.allowed) return permCheck.response;
 *
 * Full route handler pattern:
 *
 *   // 1. Auth check
 *   const auth = await requireAuth(request, env);
 *   if (!auth.valid) return auth.response;
 *
 *   // 2. Permission check
 *   const perm = await requirePermission(env.DB, auth.auth.user.id, 'users:read', request);
 *   if (!perm.allowed) return perm.response;
 *
 *   // 3. Handle request...
 *
 * @see worker/services/permission-service.ts for the underlying checks
 * @see worker/services/audit-service.ts for access denied logging
 */

import { hasPermission, hasAnyPermission } from '../services/permission-service';
import { logAdminAction } from '../services/audit-service';
import { errorResponse } from '../../shared/http';

// ===========================================================================
// Types
// ===========================================================================

export type PermissionCheckResult =
  | { allowed: true }
  | { allowed: false; response: Response };

// ===========================================================================
// Single Permission
// ===========================================================================

/**
 * Check that a user has a specific permission.
 * Returns a 403 Forbidden response if denied.
 * Logs denied attempts to the audit log.
 *
 * @param db             - D1 database binding
 * @param userId         - The authenticated user's ID
 * @param permissionName - Required permission (e.g., 'users:read')
 * @param request        - The incoming request (for IP/UA logging)
 * @param origin         - Request origin for CORS headers
 * @returns PermissionCheckResult
 */
export async function requirePermission(
  db: D1Database,
  userId: string,
  permissionName: string,
  request: Request,
  origin?: string | null,
): Promise<PermissionCheckResult> {
  const allowed = await hasPermission(db, userId, permissionName);

  if (!allowed) {
    // Log the denied attempt (fire-and-forget — don't block the response)
    logAdminAction(db, {
      userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: permissionName,
      details: {
        required: permissionName,
        path: new URL(request.url).pathname,
        method: request.method,
      },
      request,
    }).catch((err) => console.error('[permission] Failed to log denied access:', err));

    return {
      allowed: false,
      response: errorResponse(
        'You do not have permission to perform this action.',
        403,
        'forbidden',
        origin,
      ),
    };
  }

  return { allowed: true };
}

// ===========================================================================
// Any Permission (OR)
// ===========================================================================

/**
 * Check that a user has at least one of the specified permissions.
 * Returns a 403 Forbidden response if denied.
 *
 * @param db              - D1 database binding
 * @param userId          - The authenticated user's ID
 * @param permissionNames - Any of these permissions grants access
 * @param request         - The incoming request (for IP/UA logging)
 * @param origin          - Request origin for CORS headers
 * @returns PermissionCheckResult
 */
export async function requireAnyPermission(
  db: D1Database,
  userId: string,
  permissionNames: string[],
  request: Request,
  origin?: string | null,
): Promise<PermissionCheckResult> {
  const allowed = await hasAnyPermission(db, userId, permissionNames);

  if (!allowed) {
    logAdminAction(db, {
      userId,
      action: 'permission.denied',
      resourceType: 'permission',
      resourceId: permissionNames.join(','),
      details: {
        required_any: permissionNames,
        path: new URL(request.url).pathname,
        method: request.method,
      },
      request,
    }).catch((err) => console.error('[permission] Failed to log denied access:', err));

    return {
      allowed: false,
      response: errorResponse(
        'You do not have permission to perform this action.',
        403,
        'forbidden',
        origin,
      ),
    };
  }

  return { allowed: true };
}
