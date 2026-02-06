import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../hooks/useApi';
import { Dartboard } from '../components/Dartboard';
import { UnsortedTab } from '../components/UnsortedTab';
import { Inbox, Plus, Settings, ChevronRight } from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface DashboardTab {
  id: string;
  name: string;
  contactCount: number;
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

// ===========================================================================
// Component
// ===========================================================================

export function OverviewPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [unsortedCount, setUnsortedCount] = useState(0);

  // Fetch tabs
  const { data: tabsData, isLoading: tabsLoading, refetch: refetchTabs } = useApi<DashboardTabsResponse>(
    '/api/dashboard/tabs'
  );

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
  const handleUnsortedCountChange = (count: number) => {
    setUnsortedCount(count);
    // Also refetch tabs to keep everything in sync
    if (count !== unsortedCount) {
      refetchTabs();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            {getGreeting()}
          </h1>
        </div>
        <Link
          to="/settings"
          className="inline-flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
        >
          <Settings className="w-4 h-4" />
          Settings
        </Link>
      </div>

      {/* Tab bar */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-1 overflow-x-auto pb-px scrollbar-hide">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
                ${activeTab === tab.id
                  ? 'border-bethany-500 text-bethany-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }
              `}
            >
              {tab.name}
              {tab.contactCount > 0 && (
                <span className="ml-2 text-xs text-gray-400">
                  {tab.contactCount}
                </span>
              )}
            </button>
          ))}

          {/* Unsorted tab */}
          <button
            onClick={() => setActiveTab('unsorted')}
            className={`
              px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors
              flex items-center gap-2
              ${activeTab === 'unsorted'
                ? 'border-bethany-500 text-bethany-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
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
            className="px-3 py-2 text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1"
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
// Dartboard View
// ===========================================================================

function DartboardView({ data }: { data: DartboardResponse }) {
  if (data.totalContacts === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
        <h3 className="font-medium text-gray-900 mb-2">No contacts in {data.circleName}</h3>
        <p className="text-gray-500 mb-4">
          Add contacts to this circle to see them on the dartboard.
        </p>
        <Link
          to="/contacts"
          className="inline-flex items-center gap-2 px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600"
        >
          Add contacts
          <ChevronRight className="w-4 h-4" />
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard
          label="Thriving"
          value={data.summary.thriving}
          color="green"
        />
        <StatCard
          label="Healthy"
          value={data.summary.healthy}
          color="blue"
        />
        <StatCard
          label="Slipping"
          value={data.summary.slipping}
          color="yellow"
        />
        <StatCard
          label="Drifting"
          value={data.summary.drifting}
          color="red"
        />
      </div>

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

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'green' | 'blue' | 'yellow' | 'red';
}) {
  const colors = {
    green: 'bg-green-50 text-green-600',
    blue: 'bg-blue-50 text-blue-600',
    yellow: 'bg-yellow-50 text-yellow-600',
    red: 'bg-red-50 text-red-600',
  };

  return (
    <div className={`rounded-lg p-4 ${colors[color]}`}>
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-sm opacity-80">{label}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="animate-spin w-8 h-8 border-2 border-bethany-500 border-t-transparent rounded-full" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="bg-gradient-to-r from-bethany-50 to-pink-50 rounded-xl border border-bethany-100 p-8 text-center">
      <h3 className="font-medium text-gray-900 mb-2">Create your first circle</h3>
      <p className="text-gray-500 mb-4">
        Circles help you organize your network by context — Family, Work, Friends, etc.
      </p>
      <Link
        to="/settings#circles"
        className="inline-flex items-center gap-2 px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600"
      >
        <Plus className="w-4 h-4" />
        Create circle
      </Link>
    </div>
  );
}
