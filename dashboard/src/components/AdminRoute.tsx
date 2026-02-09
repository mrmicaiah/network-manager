import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import type { ReactNode } from 'react';

interface AdminRouteProps {
  children: ReactNode;
}

/**
 * Route guard for admin pages.
 *
 * Checks authentication first (redirects to /login if not authed),
 * then checks for any admin-level permission. Shows a 403 page
 * if the user is authenticated but lacks admin access.
 */
export function AdminRoute({ children }: AdminRouteProps) {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { isAdmin, isLoading: permLoading } = usePermissions();
  const location = useLocation();

  const isLoading = authLoading || permLoading;

  // Show loading state while checking auth + permissions
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-bethany-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-charcoal-light text-sm">Checking access...</p>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Show forbidden page if not admin
  if (!isAdmin) {
    return <Navigate to="/forbidden" replace />;
  }

  return <>{children}</>;
}
