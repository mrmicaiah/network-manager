import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useApi } from '../hooks/useApi';
import { DonutChartWithLegend } from '../components/DonutChart';
import { Users, Brain, ArrowRight, TrendingUp, AlertCircle } from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface HealthSummary {
  total: number;
  byHealth: {
    green: number;
    yellow: number;
    red: number;
  };
  byIntent: {
    inner_circle: number;
    nurture: number;
    maintain: number;
    transactional: number;
    dormant: number;
    new: number;
  };
}

interface CircleSummary {
  id: string;
  name: string;
  contactCount: number;
}

// ===========================================================================
// Component
// ===========================================================================

export function OverviewPage() {
  const { user } = useAuth();
  const { data: health, isLoading: healthLoading } = useApi<HealthSummary>('/api/contacts/health');
  const { data: circles } = useApi<CircleSummary[]>('/api/circles');

  const firstName = user?.name?.split(' ')[0] || 'there';

  // Health status colors
  const healthSegments = [
    { label: 'Healthy', value: health?.byHealth.green ?? 0, color: '#22c55e' },
    { label: 'Needs attention', value: health?.byHealth.yellow ?? 0, color: '#eab308' },
    { label: 'Overdue', value: health?.byHealth.red ?? 0, color: '#ef4444' },
  ];

  // Intent breakdown colors
  const intentSegments = [
    { label: 'Inner Circle', value: health?.byIntent.inner_circle ?? 0, color: '#8b5cf6' },
    { label: 'Nurture', value: health?.byIntent.nurture ?? 0, color: '#3b82f6' },
    { label: 'Maintain', value: health?.byIntent.maintain ?? 0, color: '#06b6d4' },
    { label: 'Transactional', value: health?.byIntent.transactional ?? 0, color: '#84cc16' },
    { label: 'Dormant', value: health?.byIntent.dormant ?? 0, color: '#9ca3af' },
    { label: 'New', value: health?.byIntent.new ?? 0, color: '#f97316' },
  ];

  // Circle breakdown colors
  const circleColors = ['#ec4899', '#8b5cf6', '#3b82f6', '#14b8a6', '#f59e0b', '#6b7280'];
  const circleSegments = (circles ?? []).map((c, i) => ({
    label: c.name,
    value: c.contactCount,
    color: circleColors[i % circleColors.length],
  }));

  const totalContacts = health?.total ?? 0;
  const overdueCount = health?.byHealth.red ?? 0;
  const needsAttentionCount = health?.byHealth.yellow ?? 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">
            Hey, {firstName} 👋
          </h1>
          <p className="text-gray-500 mt-1">
            Here's how your network is doing today.
          </p>
        </div>
        <div className="flex gap-3">
          <Link
            to="/contacts"
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
          >
            <Users className="w-4 h-4" />
            View contacts
          </Link>
          <Link
            to="/braindump"
            className="inline-flex items-center gap-2 px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors"
          >
            <Brain className="w-4 h-4" />
            Braindump
          </Link>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-bethany-50 rounded-lg flex items-center justify-center">
              <Users className="w-5 h-5 text-bethany-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-900">
                {healthLoading ? '—' : totalContacts}
              </p>
              <p className="text-sm text-gray-500">Total contacts</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-yellow-50 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-yellow-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-900">
                {healthLoading ? '—' : needsAttentionCount}
              </p>
              <p className="text-sm text-gray-500">Needs attention</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-50 rounded-lg flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <p className="text-2xl font-semibold text-gray-900">
                {healthLoading ? '—' : overdueCount}
              </p>
              <p className="text-sm text-gray-500">Overdue</p>
            </div>
          </div>
        </div>
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Health breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-medium text-gray-900 mb-4">Health status</h2>
          {totalContacts === 0 ? (
            <EmptyChartState message="Add contacts to see health stats" />
          ) : (
            <DonutChartWithLegend segments={healthSegments} />
          )}
        </div>

        {/* Intent breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-medium text-gray-900 mb-4">By intent</h2>
          {totalContacts === 0 ? (
            <EmptyChartState message="Add contacts to see breakdown" />
          ) : (
            <DonutChartWithLegend
              segments={intentSegments.filter((s) => s.value > 0)}
            />
          )}
        </div>

        {/* Circle breakdown */}
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h2 className="font-medium text-gray-900 mb-4">By circle</h2>
          {circleSegments.length === 0 || circleSegments.every((s) => s.value === 0) ? (
            <EmptyChartState message="Organize contacts into circles" />
          ) : (
            <DonutChartWithLegend
              segments={circleSegments.filter((s) => s.value > 0)}
            />
          )}
        </div>
      </div>

      {/* Action prompts */}
      {totalContacts === 0 && (
        <div className="bg-gradient-to-r from-bethany-50 to-pink-50 rounded-xl border border-bethany-100 p-6">
          <h2 className="font-medium text-gray-900 mb-2">Get started</h2>
          <p className="text-gray-600 mb-4">
            Your network is empty! Start by adding the people you want to stay connected with.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/contacts"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Add a contact
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/braindump"
              className="inline-flex items-center gap-2 px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors"
            >
              Try braindump
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              to="/import"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Import contacts
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      )}

      {/* Overdue contacts list */}
      {overdueCount > 0 && (
        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <h2 className="font-medium text-gray-900">
              Overdue contacts
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({overdueCount})
              </span>
            </h2>
            <Link
              to="/contacts?health_status=red"
              className="text-sm text-bethany-600 hover:text-bethany-700 font-medium"
            >
              View all
            </Link>
          </div>
          <div className="p-5">
            <p className="text-gray-500 text-sm">
              These people haven't heard from you in a while. A quick text goes a long way.
            </p>
            {/* TODO: List overdue contacts here */}
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Empty State
// ===========================================================================

function EmptyChartState({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-4">
      <div className="w-[100px] h-[100px] rounded-full border-[20px] border-gray-100 flex items-center justify-center">
        <span className="text-xl font-semibold text-gray-300">0</span>
      </div>
      <p className="text-sm text-gray-400">{message}</p>
    </div>
  );
}
