import { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { useApi } from '../hooks/useApi';
import {
  LayoutDashboard,
  Users,
  Brain,
  Upload,
  Settings,
  Menu,
  X,
  LogOut,
  ChevronDown,
  Sparkles,
  Shield,
  ClipboardCheck,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface ReviewStats {
  contacts: {
    total_unsorted: number;
    pending: number;
  };
}

// ===========================================================================
// Navigation Items
// ===========================================================================

const navItems = [
  { to: '/overview', label: 'Overview', icon: LayoutDashboard },
  { to: '/contacts', label: 'Contacts', icon: Users },
  { to: '/braindump', label: 'Braindump', icon: Brain },
  { to: '/import', label: 'Import', icon: Upload },
  { to: '/settings', label: 'Settings', icon: Settings },
];

// ===========================================================================
// Layout Component
// ===========================================================================

export function DashboardLayout() {
  const { user, logout } = useAuth();
  const { isAdmin } = usePermissions();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Fetch review stats for badge
  const { data: reviewStats } = useApi<ReviewStats>('/api/review/stats');
  const pendingReviewCount = reviewStats?.contacts?.pending ?? 0;

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const subscriptionBadge = () => {
    if (user?.subscriptionTier === 'premium') {
      return (
        <span className="badge-primary flex items-center gap-1">
          <Sparkles className="w-3 h-3" />
          Premium
        </span>
      );
    }
    if (user?.subscriptionTier === 'trial') {
      return <span className="badge-warning">Trial</span>;
    }
    return <span className="badge-neutral">Free</span>;
  };

  return (
    <div className="min-h-screen bg-cream">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-charcoal/40 z-40 lg:hidden backdrop-blur-sm"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-full w-64 bg-warm-white border-r border-cream-dark
          transform transition-transform duration-200 ease-in-out
          lg:translate-x-0 lg:static lg:z-auto
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {/* Sidebar header */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-cream-dark">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-bethany-500 rounded-xl flex items-center justify-center shadow-warm">
              <span className="text-warm-white font-display font-semibold text-lg">B</span>
            </div>
            <span className="font-display font-medium text-charcoal text-lg">Bethany</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-2 text-charcoal-light hover:text-charcoal rounded-lg hover:bg-cream-dark transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="p-3 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `nav-item ${isActive ? 'active' : ''}`
              }
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </NavLink>
          ))}

          {/* Review link with badge */}
          <NavLink
            to="/review"
            onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              `nav-item ${isActive ? 'active' : ''}`
            }
          >
            <ClipboardCheck className="w-5 h-5" />
            <span className="flex-1">Review</span>
            {pendingReviewCount > 0 && (
              <span className="px-1.5 py-0.5 text-xs font-medium bg-terracotta/15 text-terracotta rounded-full min-w-[20px] text-center">
                {pendingReviewCount > 99 ? '99+' : pendingReviewCount}
              </span>
            )}
          </NavLink>

          {/* Admin link — only visible to admins */}
          {isAdmin && (
            <>
              <div className="border-t border-cream-dark my-2" />
              <NavLink
                to="/admin"
                onClick={() => setSidebarOpen(false)}
                className={({ isActive }) =>
                  `nav-item ${isActive ? 'active' : ''}`
                }
              >
                <Shield className="w-5 h-5" />
                Admin
              </NavLink>
            </>
          )}
        </nav>

        {/* Sidebar footer — subscription badge */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-cream-dark">
          <div className="flex items-center justify-between text-sm">
            <span className="text-charcoal-light">Plan</span>
            {subscriptionBadge()}
          </div>
        </div>
      </aside>

      {/* Main content area */}
      <div className="lg:ml-64">
        {/* Top header */}
        <header className="sticky top-0 z-30 h-16 bg-warm-white/95 backdrop-blur-sm border-b border-cream-dark flex items-center justify-between px-4 lg:px-6">
          {/* Mobile menu button */}
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 -ml-2 text-charcoal-light hover:text-charcoal rounded-lg hover:bg-cream-dark transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Page title placeholder — pages can override via document.title */}
          <div className="hidden lg:block" />

          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 p-2 rounded-xl hover:bg-cream-dark transition-colors"
            >
              <div className="w-8 h-8 bg-blush rounded-xl flex items-center justify-center">
                <span className="text-bethany-600 font-medium text-sm">
                  {user?.name?.charAt(0)?.toUpperCase() || '?'}
                </span>
              </div>
              <span className="hidden sm:block text-sm font-medium text-charcoal">
                {user?.name || 'User'}
              </span>
              <ChevronDown className="w-4 h-4 text-charcoal-light" />
            </button>

            {/* Dropdown */}
            {userMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setUserMenuOpen(false)}
                />
                <div className="absolute right-0 mt-2 w-52 bg-warm-white rounded-xl shadow-medium border border-cream-dark py-1 z-50 animate-fade-in">
                  <div className="px-4 py-3 border-b border-cream-dark">
                    <p className="text-sm font-medium text-charcoal">{user?.name}</p>
                    <p className="text-xs text-charcoal-light truncate">{user?.phone}</p>
                  </div>
                  <button
                    onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-charcoal-light hover:text-charcoal hover:bg-cream-dark transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Page content */}
        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
