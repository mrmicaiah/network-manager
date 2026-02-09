import { useState } from 'react';
import { Outlet, NavLink, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
  LayoutDashboard,
  Users,
  Activity,
  ArrowLeft,
  Menu,
  X,
  LogOut,
  ChevronDown,
  Shield,
} from 'lucide-react';

// ===========================================================================
// Navigation Items
// ===========================================================================

const adminNavItems = [
  { to: '/admin', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/activity', label: 'Activity', icon: Activity },
];

// ===========================================================================
// Admin Layout Component
// ===========================================================================

export function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
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
            <div className="w-9 h-9 bg-charcoal rounded-xl flex items-center justify-center shadow-warm">
              <Shield className="w-5 h-5 text-warm-white" />
            </div>
            <span className="font-display font-medium text-charcoal text-lg">Admin</span>
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
          {adminNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={() => setSidebarOpen(false)}
              className={({ isActive }) =>
                `nav-item ${isActive ? 'active' : ''}`
              }
            >
              <item.icon className="w-5 h-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Sidebar footer — back to dashboard */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-cream-dark">
          <Link
            to="/overview"
            className="flex items-center gap-2 text-sm text-charcoal-light hover:text-charcoal transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
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

          {/* Admin badge */}
          <div className="hidden lg:flex items-center gap-2">
            <span className="badge-neutral flex items-center gap-1">
              <Shield className="w-3 h-3" />
              Admin Panel
            </span>
          </div>

          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 p-2 rounded-xl hover:bg-cream-dark transition-colors"
            >
              <div className="w-8 h-8 bg-charcoal-200 rounded-xl flex items-center justify-center">
                <span className="text-charcoal font-medium text-sm">
                  {user?.name?.charAt(0)?.toUpperCase() || '?'}
                </span>
              </div>
              <span className="hidden sm:block text-sm font-medium text-charcoal">
                {user?.name || 'Admin'}
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
                  <Link
                    to="/overview"
                    onClick={() => setUserMenuOpen(false)}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-charcoal-light hover:text-charcoal hover:bg-cream-dark transition-colors"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Dashboard
                  </Link>
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
