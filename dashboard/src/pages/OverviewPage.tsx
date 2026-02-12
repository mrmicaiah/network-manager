import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../hooks/useApi';
import { Dartboard } from '../components/Dartboard';
import { UnsortedTab } from '../components/UnsortedTab';
import { CircleSummary, CircleSummaryBadge } from '../components/CircleSummary';
import { Inbox, Plus, Settings, ChevronRight, Sparkles, X } from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface DashboardTab {
  id: string;
  name: string;
  contactCount: number;
  // Summary data for tooltip (optional, may need backend update)
  summary?: {
    thriving: number;
    healthy: number;
    slipping: number;
    drifting: number;
  };
}

interface DashboardTabsResponse {
  tabs: DashboardTab[];
  unsortedCount: number;
  defaultTabId: string | null;
  tabOrder: string[];
}

interface DartboardContact {
  contactId: string;
  name: string;
  intent: string;
  score: number;
  status: 'thriving' | 'healthy' | 'slipping' | 'drifting';
  pointsEarned: number;
  pointsRequired: number;
  interactionCount: number;
  lastInteractionDate: string | null;
  position: {
    radius: number;
    angle: number;
  };
}

interface DartboardData {
  index: number;
  total: number;
  contacts: DartboardContact[];
}

interface DartboardResponse {
  circleId: string;
  circleName: string;
  totalContacts: number;
  dartboards: DartboardData[];
  summary: {
    thriving: number;
    healthy: number;
    slipping: number;
    drifting: number;
  };
}

interface ReviewStatsResponse {
  contacts: {
    total_unsorted: number;
    pending: number;
    reviewed: number;
  };
}

// ===========================================================================
// Local Storage Key for Banner Dismissal
// ===========================================================================

const BANNER_DISMISS_KEY = 'bethany_review_banner_dismissed';
const BANNER_DISMISS_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function isBannerDismissed(): boolean {
  try {
    const dismissed = localStorage.getItem(BANNER_DISMISS_KEY);
    if (!dismissed) return false;
    const timestamp = parseInt(dismissed, 10);
    return Date.now() - timestamp < BANNER_DISMISS_DURATION;
  } catch {
    return false;
  }
}

function dismissBanner(): void {
  try {
    localStorage.setItem(BANNER_DISMISS_KEY, Date.now().toString());
  } catch {
    // Ignore storage errors
  }
}

// ===========================================================================
// Component
// ===========================================================================

export function OverviewPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [unsortedCount, setUnsortedCount] = useState(0);
  const [bannerDismissed, setBannerDismissed] = useState(() => isBannerDismissed());

  // Fetch tabs
  const { data: tabsData, isLoading: tabsLoading, refetch: refetchTabs } = useApi<DashboardTabsResponse>(
    '/api/dashboard/tabs'
  );

  // Fetch review stats for banner
  const { data: reviewStats } = useApi<ReviewStatsResponse>('/api/review/stats');
  const pendingReviewCount = reviewStats?.contacts?.pending ?? 0;

  // Set initial active tab
  useEffect(() => {
    if (tabsData && !activeTab) {
      setActiveTab(tabsData.defaultTabId || tabsData.tabs[0]?.id || 'unsorted');
    }
  }, [tabsData, activeTab]);

  // Update unsorted count from tabs data
  useEffect(() => {
    if (tabsData) {
      setUnsortedCount(tabsData.unsortedCount);
    }
  }, [tabsData]);

  // Fetch dartboard data for active circle
  const { data: dartboardData, isLoading: dartboardLoading } = useApi<DartboardResponse>(
    activeTab && activeTab !== 'unsorted'
      ? `/api/dashboard/dartboard/${activeTab}`
      : null
  );

  const firstName = user?.name?.split(' ')[0] || 'there';
  const tabs = tabsData?.tabs ?? [];

  // Greeting based on time and network state
  const getGreeting = () => {
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
    
    if (activeTab === 'unsorted') {
      if (unsortedCount === 0) {
        return `Good ${timeGreeting}, ${firstName}. Your network is organized.`;
      }
      return `Good ${timeGreeting}, ${firstName}. Let's get these contacts sorted.`;
    }

    if (!dartboardData) {
      return `Good ${timeGreeting}, ${firstName}. Here's your network.`;
    }

    const { summary } = dartboardData;
    const total = summary.thriving + summary.healthy + summary.slipping + summary.drifting;
    
    if (total === 0) {
      return `Good ${timeGreeting}, ${firstName}. Let's add some people to this circle.`;
    }
    if (summary.drifting > 5) {
      return `Good ${timeGreeting}, ${firstName}. You've got some catching up to do.`;
    }
    if (summary.drifting === 0 && summary.slipping === 0) {
      return `Good ${timeGreeting}, ${firstName}. Your network looks healthy. Nice work.`;
    }
    return `Good ${timeGreeting}, ${firstName}. A few people could use some love.`;
  };

  // Handle unsorted count updates from UnsortedTab
  const handleUnsortedCountChange = useCallback((count: number) => {
    setUnsortedCount((prev) => {
      if (count !== prev) {
        refetchTabs();
      }
      return count;
    });
  }, [refetchTabs]);

  // Handle banner dismissal
  const handleDismissBanner = () => {
    dismissBanner();
    setBannerDismissed(true);
  };

  // Show review banner if there are pending contacts and not dismissed
  const showReviewBanner = pendingReviewCount >= 5 && !bannerDismissed;

  return (
    <div className="space-y-6">
      {/* Review Banner */}
      {showReviewBanner && (
        <ReviewBanner
          count={pendingReviewCount}
          onDismiss={handleDismissBanner}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-medium text-charcoal">
            {getGreeting()}
          </h1>
        </div>
        <Link
          to="/settings"
          className="inline-flex items-center gap-2 px-3 py-2 text-sm text-charcoal-light hover:text-charcoal transition-colors"
        >
          <Settings className="w-4 h-4" />
          Settings
        </Link>
      </div>

      {/* Tab bar */}
      <div className="border-b border-cream-dark">
        <nav className="flex gap-1 overflow-x-auto pb-px scrollbar-hide">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
                flex items-center gap-2
                ${activeTab === tab.id
                  ? 'border-bethany-500 text-bethany-500'
                  : 'border-transparent text-charcoal-light hover:text-charcoal hover:border-charcoal-300'
                }
              `}
            >
              {tab.name}
              {/* Show summary badge if available, otherwise just count */}
              {tab.summary ? (
                <CircleSummaryBadge
                  circleName={tab.name}
                  {...tab.summary}
                  showTooltip
                  className="ml-1"
                />
              ) : tab.contactCount > 0 ? (
                <span className="text-xs text-charcoal-light">
                  {tab.contactCount}
                </span>
              ) : null}
            </button>
          ))}

          {/* Unsorted tab */}
          <button
            onClick={() => setActiveTab('unsorted')}
            className={`
              px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
              flex items-center gap-2
              ${activeTab === 'unsorted'
                ? 'border-bethany-500 text-bethany-500'
                : 'border-transparent text-charcoal-light hover:text-charcoal hover:border-charcoal-300'
              }
            `}
          >
            <Inbox className="w-4 h-4" />
            Unsorted
            {unsortedCount > 0 && (
              <span className="px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-600 rounded-full">
                {unsortedCount}
              </span>
            )}
          </button>

          {/* Add circle button */}
          <Link
            to="/settings#circles"
            className="px-3 py-2 text-sm text-charcoal-300 hover:text-charcoal-light flex items-center gap-1 transition-colors"
          >
            <Plus className="w-4 h-4" />
          </Link>
        </nav>
      </div>

      {/* Content */}
      {tabsLoading ? (
        <LoadingState />
      ) : activeTab === 'unsorted' ? (
        <UnsortedTab onCountChange={handleUnsortedCountChange} />
      ) : dartboardLoading ? (
        <LoadingState />
      ) : dartboardData ? (
        <DartboardView data={dartboardData} />
      ) : tabs.length === 0 ? (
        <EmptyState />
      ) : null}
    </div>
  );
}

// ===========================================================================
// Review Banner
// ===========================================================================

function ReviewBanner({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  return (
    <div className="relative bg-gradient-to-r from-terracotta/10 via-blush/30 to-terracotta/10 rounded-2xl border border-terracotta/20 p-4 sm:p-5">
      {/* Dismiss button */}
      <button
        onClick={onDismiss}
        className="absolute top-3 right-3 p-1.5 text-charcoal-light hover:text-charcoal rounded-lg hover:bg-warm-white/50 transition-colors"
        title="Dismiss for 24 hours"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex flex-col sm:flex-row sm:items-center gap-4">
        {/* Icon */}
        <div className="w-12 h-12 bg-warm-white rounded-xl flex items-center justify-center shadow-soft flex-shrink-0">
          <Sparkles className="w-6 h-6 text-terracotta" />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3 className="font-display font-medium text-charcoal mb-1">
            You have {count} contacts to sort
          </h3>
          <p className="text-sm text-charcoal-light">
            I've analyzed your network and have some suggestions. Let's organize them together!
          </p>
        </div>

        {/* CTA */}
        <Link
          to="/review"
          className="btn-primary flex-shrink-0 self-start sm:self-center"
        >
          Review contacts
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
    </div>
  );
}

// ===========================================================================
// Dartboard View
// ===========================================================================

function DartboardView({ data }: { data: DartboardResponse }) {
  if (data.totalContacts === 0) {
    return (
      <div className="card text-center">
        <h3 className="font-medium text-charcoal mb-2">No contacts in {data.circleName}</h3>
        <p className="text-charcoal-light mb-4">
          Add contacts to this circle to see them on the dartboard.
        </p>
        <Link
          to="/contacts"
          className="btn-primary inline-flex"
        >
          Add contacts
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary stats - using CircleSummary detailed variant */}
      <CircleSummary
        {...data.summary}
        variant="detailed"
        showLabels
      />

      {/* Dartboards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {data.dartboards.map((dartboard) => (
          <Dartboard
            key={dartboard.index}
            contacts={dartboard.contacts}
            circleName={data.circleName}
            index={dartboard.index}
            total={dartboard.total}
          />
        ))}
      </div>
    </div>
  );
}

// ===========================================================================
// Helper Components
// ===========================================================================

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin w-8 h-8 border-2 border-bethany-500 border-t-transparent rounded-full" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-gradient-to-r from-bethany-50 to-blush rounded-2xl border border-bethany-100 p-8 text-center">
      <h3 className="font-display font-medium text-charcoal mb-2">Create your first circle</h3>
      <p className="text-charcoal-light mb-4">
        Circles help you organize your network by context — Family, Work, Friends, etc.
      </p>
      <Link
        to="/settings#circles"
        className="btn-primary inline-flex"
      >
        <Plus className="w-4 h-4" />
        Create circle
      </Link>
    </div>
  );
}
