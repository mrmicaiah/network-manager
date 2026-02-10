// Admin Overview — v4 fix lucide icon
import { useNavigate, Link } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import { API_URL } from '../../config';
import {
  Users,
  UserPlus,
  CreditCard,
  Clock,
  TrendingUp,
  Contact,
  AlertTriangle,
  ArrowRight,
  Activity,
  RefreshCw,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface AdminStats {
  totalUsers: number;
  usersByTier: Record<string, number>;
  usersByOnboardingStage: Record<string, number>;
  totalContacts: number;
  avgContactsPerUser: number;
  signupsToday: number;
  signupsThisWeek: number;
  signupsThisMonth: number;
  activeTrials: number;
  trialsExpiringSoon: number;
}

interface RecentUser {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  subscription_tier: string;
  onboarding_stage: string | null;
  created_at: string;
  contact_count: number;
}

interface UsersResponse {
  users: RecentUser[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

// ===========================================================================
// Helpers
// ===========================================================================

function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return phone.slice(0, 2) + '\u2022\u2022\u2022\u2022\u2022\u2022' + phone.slice(-4);
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = {
    premium: 'badge-primary',
    trial: 'badge-warning',
    free: 'badge-neutral',
  };
  return <span className={styles[tier] ?? 'badge-neutral'}>{tier}</span>;
}

function StageBadge({ stage }: { stage: string | null }) {
  if (!stage) return <span className="badge-success">Complete</span>;
  const label = stage.replace(/_/g, ' ');
  return <span className="badge-warning">{label}</span>;
}

function countOnboardingStuck(stages: Record<string, number>): number {
  let stuck = 0;
  for (const [stage, count] of Object.entries(stages)) {
    if (stage !== 'complete') {
      stuck += count;
    }
  }
  return stuck;
}

// ===========================================================================
// Stat Card Component
// ===========================================================================

interface StatCardProps {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  subtitle?: string;
  subtitleColor?: 'default' | 'warning' | 'success';
}

function StatCard({ label, value, icon, subtitle, subtitleColor = 'default' }: StatCardProps) {
  const subtitleColors = {
    default: 'text-charcoal-light',
    warning: 'text-golden-600',
    success: 'text-sage-600',
  };

  return (
    <div className="card flex items-start gap-4">
      <div className="w-10 h-10 rounded-xl bg-cream-dark flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-charcoal-light">{label}</p>
        <p className="text-2xl font-display font-medium text-charcoal">{value}</p>
        {subtitle && (
          <p className={`text-xs mt-0.5 ${subtitleColors[subtitleColor]}`}>{subtitle}</p>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Page Component
// ===========================================================================

export default function AdminOverviewPage() {
  const navigate = useNavigate();

  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useApi<AdminStats>(`${API_URL}/api/admin/stats`);

  const {
    data: recentUsers,
    isLoading: usersLoading,
    error: usersError,
  } = useApi<UsersResponse>(
    `${API_URL}/api/admin/users?limit=10&sort_by=created_at&sort_dir=desc`,
  );

  const isLoading = statsLoading || usersLoading;

  if (isLoading && !stats && !recentUsers) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-bethany-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-charcoal-light text-sm">Loading admin dashboard...</p>
        </div>
      </div>
    );
  }

  if (statsError || usersError) {
    return (
      <div className="card text-center py-12">
        <AlertTriangle className="w-8 h-8 text-golden-400 mx-auto mb-3" />
        <p className="text-charcoal font-medium mb-1">Failed to load dashboard</p>
        <p className="text-charcoal-light text-sm mb-4">{statsError || usersError}</p>
        <button onClick={refetchStats} className="btn-secondary text-sm">
          <RefreshCw className="w-4 h-4" />
          Retry
        </button>
      </div>
    );
  }

  const stuckInOnboarding = stats ? countOnboardingStuck(stats.usersByOnboardingStage) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-charcoal">Overview</h1>
          <p className="text-charcoal-light text-sm mt-1">System health at a glance</p>
        </div>
        <button
          onClick={refetchStats}
          className="btn-ghost text-sm flex items-center gap-1.5"
          title="Refresh stats"
        >
          <RefreshCw className="w-4 h-4" />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      </div>

      <div>
        <h2 className="text-sm font-medium text-charcoal-light uppercase tracking-wide mb-3">Users</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          <StatCard
            label="Total Users"
            value={stats?.totalUsers ?? 0}
            icon={<Users className="w-5 h-5 text-charcoal-light" />}
          />
          <StatCard
            label="Active Trials"
            value={stats?.activeTrials ?? 0}
            icon={<Clock className="w-5 h-5 text-golden-400" />}
            subtitle={
              stats?.trialsExpiringSoon
                ? `${stats.trialsExpiringSoon} expiring soon`
                : undefined
            }
            subtitleColor="warning"
          />
          <StatCard
            label="Premium"
            value={stats?.usersByTier?.premium ?? 0}
            icon={<CreditCard className="w-5 h-5 text-bethany-500" />}
          />
          <StatCard
            label="Free Tier"
            value={stats?.usersByTier?.free ?? 0}
            icon={<Users className="w-5 h-5 text-charcoal-light" />}
          />
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-charcoal-light uppercase tracking-wide mb-3">Growth</h2>
        <div className="grid grid-cols-3 gap-3 lg:gap-4">
          <StatCard
            label="Today"
            value={stats?.signupsToday ?? 0}
            icon={<UserPlus className="w-5 h-5 text-sage-400" />}
          />
          <StatCard
            label="This Week"
            value={stats?.signupsThisWeek ?? 0}
            icon={<TrendingUp className="w-5 h-5 text-sage-400" />}
          />
          <StatCard
            label="This Month"
            value={stats?.signupsThisMonth ?? 0}
            icon={<TrendingUp className="w-5 h-5 text-sage-400" />}
          />
        </div>
      </div>

      <div>
        <h2 className="text-sm font-medium text-charcoal-light uppercase tracking-wide mb-3">Engagement</h2>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 lg:gap-4">
          <StatCard
            label="Total Contacts"
            value={stats?.totalContacts?.toLocaleString() ?? 0}
            icon={<Contact className="w-5 h-5 text-charcoal-light" />}
          />
          <StatCard
            label="Avg per User"
            value={stats?.avgContactsPerUser ?? 0}
            icon={<Contact className="w-5 h-5 text-charcoal-light" />}
          />
          <StatCard
            label="Stuck in Onboarding"
            value={stuckInOnboarding}
            icon={<AlertTriangle className="w-5 h-5 text-golden-400" />}
            subtitle={stuckInOnboarding > 0 ? 'Users not yet ready' : 'All clear'}
            subtitleColor={stuckInOnboarding > 0 ? 'warning' : 'success'}
          />
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg text-charcoal">Recent Signups</h2>
          <Link
            to="/admin/users"
            className="text-sm text-bethany-500 hover:text-bethany-600 flex items-center gap-1 transition-colors"
          >
            View all
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {usersLoading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 border-3 border-bethany-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : recentUsers?.users && recentUsers.users.length > 0 ? (
          <div className="overflow-x-auto -mx-4 sm:-mx-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cream-dark">
                  <th className="text-left py-2.5 px-4 sm:px-6 font-medium text-charcoal-light">Name</th>
                  <th className="text-left py-2.5 px-4 sm:px-6 font-medium text-charcoal-light hidden md:table-cell">Email</th>
                  <th className="text-left py-2.5 px-4 sm:px-6 font-medium text-charcoal-light hidden lg:table-cell">Phone</th>
                  <th className="text-left py-2.5 px-4 sm:px-6 font-medium text-charcoal-light">Tier</th>
                  <th className="text-left py-2.5 px-4 sm:px-6 font-medium text-charcoal-light hidden sm:table-cell">Onboarding</th>
                  <th className="text-right py-2.5 px-4 sm:px-6 font-medium text-charcoal-light">Joined</th>
                </tr>
              </thead>
              <tbody>
                {recentUsers.users.map((user) => (
                  <tr
                    key={user.id}
                    onClick={() => navigate(`/admin/users/${user.id}`)}
                    className="border-b border-cream-dark/60 last:border-0 hover:bg-cream-dark/40 cursor-pointer transition-colors"
                  >
                    <td className="py-3 px-4 sm:px-6">
                      <span className="font-medium text-charcoal">{user.name}</span>
                    </td>
                    <td className="py-3 px-4 sm:px-6 text-charcoal-light hidden md:table-cell truncate max-w-[200px]">
                      {user.email || '\u2014'}
                    </td>
                    <td className="py-3 px-4 sm:px-6 text-charcoal-light hidden lg:table-cell font-mono text-xs">
                      {maskPhone(user.phone)}
                    </td>
                    <td className="py-3 px-4 sm:px-6">
                      <TierBadge tier={user.subscription_tier} />
                    </td>
                    <td className="py-3 px-4 sm:px-6 hidden sm:table-cell">
                      <StageBadge stage={user.onboarding_stage} />
                    </td>
                    <td className="py-3 px-4 sm:px-6 text-right text-charcoal-light whitespace-nowrap">
                      {timeAgo(user.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-charcoal-light text-center py-8">No users yet.</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 lg:gap-4">
        <Link
          to="/admin/users"
          className="card flex items-center gap-4 hover:shadow-medium transition-shadow group"
        >
          <div className="w-10 h-10 rounded-xl bg-bethany-100 flex items-center justify-center shrink-0 group-hover:bg-bethany-200 transition-colors">
            <Users className="w-5 h-5 text-bethany-600" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-charcoal">Manage Users</p>
            <p className="text-sm text-charcoal-light">Search, filter, and manage user accounts</p>
          </div>
          <ArrowRight className="w-4 h-4 text-charcoal-light shrink-0 ml-auto" />
        </Link>

        <Link
          to="/admin/activity"
          className="card flex items-center gap-4 hover:shadow-medium transition-shadow group"
        >
          <div className="w-10 h-10 rounded-xl bg-sage-100 flex items-center justify-center shrink-0 group-hover:bg-sage-200 transition-colors">
            <Activity className="w-5 h-5 text-sage-600" />
          </div>
          <div className="min-w-0">
            <p className="font-medium text-charcoal">Activity Log</p>
            <p className="text-sm text-charcoal-light">View admin actions and audit trail</p>
          </div>
          <ArrowRight className="w-4 h-4 text-charcoal-light shrink-0 ml-auto" />
        </Link>
      </div>
    </div>
  );
}
