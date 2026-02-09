import { useMemo } from 'react';
import { useAuth } from '../context/AuthContext';

/**
 * Hook to check user permissions from the AuthContext.
 *
 * Permissions and roles are fetched once on session check (/api/auth/me)
 * and cached in AuthContext for the duration of the session.
 *
 * @example
 * const { isAdmin, hasPermission, isLoading } = usePermissions();
 * if (isAdmin) showAdminLink();
 * if (hasPermission('users:write')) showEditButton();
 */
export function usePermissions() {
  const { user, isLoading } = useAuth();

  const permissions = useMemo(() => user?.permissions ?? [], [user?.permissions]);
  const roles = useMemo(() => user?.roles ?? [], [user?.roles]);

  const isAdmin = useMemo(
    () => roles.includes('admin') || roles.includes('superadmin'),
    [roles],
  );

  const isSuperAdmin = useMemo(
    () => roles.includes('superadmin'),
    [roles],
  );

  const hasPermission = useMemo(
    () => (permission: string) => permissions.includes(permission),
    [permissions],
  );

  const hasAnyPermission = useMemo(
    () => (perms: string[]) => perms.some((p) => permissions.includes(p)),
    [permissions],
  );

  return {
    permissions,
    roles,
    isAdmin,
    isSuperAdmin,
    hasPermission,
    hasAnyPermission,
    isLoading,
  };
}
