import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { ExportModal } from '../components/ExportModal';
import {
  Search,
  Filter,
  Download,
  ChevronDown,
  ChevronUp,
  Users,
  X,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  intent: IntentType;
  health_status: HealthStatus;
  last_contact_date: string | null;
  circles: Array<{ id: string; name: string }>;
}

interface ContactListResponse {
  contacts: Contact[];
  total: number;
  limit: number;
  offset: number;
}

interface Circle {
  id: string;
  name: string;
}

type IntentType = 'inner_circle' | 'nurture' | 'maintain' | 'transactional' | 'dormant' | 'new';
type HealthStatus = 'green' | 'yellow' | 'red';
type SortField = 'name' | 'last_contact_date' | 'health_status';
type SortDir = 'asc' | 'desc';

// ===========================================================================
// Constants
// ===========================================================================

const INTENT_LABELS: Record<IntentType, string> = {
  inner_circle: 'Inner Circle',
  nurture: 'Nurture',
  maintain: 'Maintain',
  transactional: 'Transactional',
  dormant: 'Dormant',
  new: 'New',
};

const INTENT_COLORS: Record<IntentType, string> = {
  inner_circle: 'bg-violet-100 text-violet-700',
  nurture: 'bg-blue-100 text-blue-700',
  maintain: 'bg-cyan-100 text-cyan-700',
  transactional: 'bg-lime-100 text-lime-700',
  dormant: 'bg-gray-100 text-gray-600',
  new: 'bg-orange-100 text-orange-700',
};

const HEALTH_COLORS: Record<HealthStatus, string> = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
};

const HEALTH_LABELS: Record<HealthStatus, string> = {
  green: 'Healthy',
  yellow: 'Needs attention',
  red: 'Overdue',
};

// ===========================================================================
// Component
// ===========================================================================

export function ContactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Filters from URL
  const search = searchParams.get('search') || '';
  const circleFilter = searchParams.get('circle_id') || '';
  const intentFilter = (searchParams.get('intent') || '') as IntentType | '';
  const healthFilter = (searchParams.get('health_status') || '') as HealthStatus | '';

  // Local state
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  // Build API URL with filters
  const apiUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (circleFilter) params.set('circle_id', circleFilter);
    if (intentFilter) params.set('intent', intentFilter);
    if (healthFilter) params.set('health_status', healthFilter);
    params.set('order_by', sortField);
    params.set('order_dir', sortDir);
    params.set('limit', '100');
    return `/api/contacts?${params.toString()}`;
  }, [search, circleFilter, intentFilter, healthFilter, sortField, sortDir]);

  const { data, isLoading, error } = useApi<ContactListResponse>(apiUrl);
  const { data: circles } = useApi<Circle[]>('/api/circles');

  const contacts = data?.contacts ?? [];
  const totalContacts = data?.total ?? 0;

  // Update URL params
  const updateFilter = (key: string, value: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    setSearchParams(newParams);
  };

  const clearFilters = () => {
    setSearchParams({});
  };

  const hasActiveFilters = circleFilter || intentFilter || healthFilter || search;

  // Sort handler
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  // Format date
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return date.toLocaleDateString();
  };

  // Current filters to pre-fill export modal
  const currentExportFilters = useMemo(() => {
    const filters: Record<string, string> = {};
    if (circleFilter) filters.circle_id = circleFilter;
    if (intentFilter) filters.intent = intentFilter;
    if (healthFilter) filters.health_status = healthFilter;
    return filters;
  }, [circleFilter, intentFilter, healthFilter]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Contacts</h1>
          <p className="text-gray-500 text-sm mt-1">
            {totalContacts} {totalContacts === 1 ? 'contact' : 'contacts'}
            {hasActiveFilters && ' (filtered)'}
          </p>
        </div>
        <button
          onClick={() => setShowExportModal(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Search and filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-col sm:flex-row gap-3">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => updateFilter('search', e.target.value)}
              placeholder="Search contacts..."
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
            />
          </div>

          {/* Filter toggle (mobile) */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="sm:hidden inline-flex items-center justify-center gap-2 px-4 py-2 border border-gray-300 rounded-lg text-gray-700"
          >
            <Filter className="w-4 h-4" />
            Filters
            {hasActiveFilters && (
              <span className="w-2 h-2 bg-bethany-500 rounded-full" />
            )}
          </button>

          {/* Filter dropdowns (desktop) */}
          <div className="hidden sm:flex items-center gap-2">
            <FilterDropdown
              label="Circle"
              value={circleFilter}
              options={[
                { value: '', label: 'All circles' },
                ...(circles ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(v) => updateFilter('circle_id', v)}
            />
            <FilterDropdown
              label="Intent"
              value={intentFilter}
              options={[
                { value: '', label: 'All intents' },
                ...Object.entries(INTENT_LABELS).map(([k, v]) => ({ value: k, label: v })),
              ]}
              onChange={(v) => updateFilter('intent', v)}
            />
            <FilterDropdown
              label="Health"
              value={healthFilter}
              options={[
                { value: '', label: 'All health' },
                ...Object.entries(HEALTH_LABELS).map(([k, v]) => ({ value: k, label: v })),
              ]}
              onChange={(v) => updateFilter('health_status', v)}
            />
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="p-2 text-gray-400 hover:text-gray-600"
                title="Clear filters"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Mobile filters */}
        {showFilters && (
          <div className="sm:hidden mt-3 pt-3 border-t border-gray-200 space-y-3">
            <FilterDropdown
              label="Circle"
              value={circleFilter}
              options={[
                { value: '', label: 'All circles' },
                ...(circles ?? []).map((c) => ({ value: c.id, label: c.name })),
              ]}
              onChange={(v) => updateFilter('circle_id', v)}
              fullWidth
            />
            <FilterDropdown
              label="Intent"
              value={intentFilter}
              options={[
                { value: '', label: 'All intents' },
                ...Object.entries(INTENT_LABELS).map(([k, v]) => ({ value: k, label: v })),
              ]}
              onChange={(v) => updateFilter('intent', v)}
              fullWidth
            />
            <FilterDropdown
              label="Health"
              value={healthFilter}
              options={[
                { value: '', label: 'All health' },
                ...Object.entries(HEALTH_LABELS).map(([k, v]) => ({ value: k, label: v })),
              ]}
              onChange={(v) => updateFilter('health_status', v)}
              fullWidth
            />
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="w-full py-2 text-sm text-gray-500 hover:text-gray-700"
              >
                Clear all filters
              </button>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-8 h-8 border-4 border-bethany-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-gray-500 mt-4">Loading contacts...</p>
        </div>
      ) : error ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-red-600">{error}</p>
        </div>
      ) : contacts.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <Users className="w-8 h-8 text-gray-400" />
          </div>
          <h2 className="text-lg font-medium text-gray-900 mb-2">
            {hasActiveFilters ? 'No contacts match your filters' : 'No contacts yet'}
          </h2>
          <p className="text-gray-500 max-w-sm mx-auto">
            {hasActiveFilters
              ? 'Try adjusting your filters or search term.'
              : 'Start by adding contacts or using braindump.'}
          </p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          {/* Table header */}
          <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 bg-gray-50 border-b border-gray-200 text-sm font-medium text-gray-500">
            <button
              onClick={() => handleSort('name')}
              className="col-span-4 flex items-center gap-1 text-left hover:text-gray-900"
            >
              Name
              <SortIcon field="name" current={sortField} dir={sortDir} />
            </button>
            <div className="col-span-2">Circles</div>
            <div className="col-span-2">Intent</div>
            <button
              onClick={() => handleSort('last_contact_date')}
              className="col-span-2 flex items-center gap-1 text-left hover:text-gray-900"
            >
              Last contact
              <SortIcon field="last_contact_date" current={sortField} dir={sortDir} />
            </button>
            <button
              onClick={() => handleSort('health_status')}
              className="col-span-2 flex items-center gap-1 text-left hover:text-gray-900"
            >
              Health
              <SortIcon field="health_status" current={sortField} dir={sortDir} />
            </button>
          </div>

          {/* Table rows */}
          <div className="divide-y divide-gray-200">
            {contacts.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                isExpanded={expandedId === contact.id}
                onToggle={() =>
                  setExpandedId(expandedId === contact.id ? null : contact.id)
                }
                formatDate={formatDate}
              />
            ))}
          </div>
        </div>
      )}

      {/* Export Modal */}
      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        currentFilters={currentExportFilters}
      />
    </div>
  );
}

// ===========================================================================
// Contact Row
// ===========================================================================

function ContactRow({
  contact,
  isExpanded,
  onToggle,
  formatDate,
}: {
  contact: Contact;
  isExpanded: boolean;
  onToggle: () => void;
  formatDate: (d: string | null) => string;
}) {
  return (
    <div>
      {/* Main row */}
      <button
        onClick={onToggle}
        className="w-full grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        {/* Name + mobile summary */}
        <div className="md:col-span-4 flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full flex-shrink-0 ${HEALTH_COLORS[contact.health_status]}`}
            title={HEALTH_LABELS[contact.health_status]}
          />
          <div className="min-w-0">
            <p className="font-medium text-gray-900 truncate">{contact.name}</p>
            <p className="md:hidden text-sm text-gray-500">
              {INTENT_LABELS[contact.intent]} · {formatDate(contact.last_contact_date)}
            </p>
          </div>
        </div>

        {/* Circles */}
        <div className="hidden md:flex md:col-span-2 items-center">
          {contact.circles.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {contact.circles.slice(0, 2).map((c) => (
                <span
                  key={c.id}
                  className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full"
                >
                  {c.name}
                </span>
              ))}
              {contact.circles.length > 2 && (
                <span className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded-full">
                  +{contact.circles.length - 2}
                </span>
              )}
            </div>
          ) : (
            <span className="text-gray-400 text-sm">—</span>
          )}
        </div>

        {/* Intent */}
        <div className="hidden md:flex md:col-span-2 items-center">
          <span
            className={`px-2 py-0.5 text-xs font-medium rounded-full ${INTENT_COLORS[contact.intent]}`}
          >
            {INTENT_LABELS[contact.intent]}
          </span>
        </div>

        {/* Last contact */}
        <div className="hidden md:flex md:col-span-2 items-center text-sm text-gray-600">
          {formatDate(contact.last_contact_date)}
        </div>

        {/* Health */}
        <div className="hidden md:flex md:col-span-2 items-center justify-between">
          <span className="text-sm text-gray-600">
            {HEALTH_LABELS[contact.health_status]}
          </span>
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>

        {/* Mobile expand indicator */}
        <div className="md:hidden absolute right-5 top-1/2 -translate-y-1/2">
          {isExpanded ? (
            <ChevronUp className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          )}
        </div>
      </button>

      {/* Expanded details */}
      {isExpanded && (
        <div className="px-5 pb-4 bg-gray-50 border-t border-gray-100">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 py-4">
            <div>
              <p className="text-xs text-gray-500 mb-1">Phone</p>
              <p className="text-sm text-gray-900">
                {contact.phone || <span className="text-gray-400">—</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Email</p>
              <p className="text-sm text-gray-900 truncate">
                {contact.email || <span className="text-gray-400">—</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Circles</p>
              <p className="text-sm text-gray-900">
                {contact.circles.length > 0
                  ? contact.circles.map((c) => c.name).join(', ')
                  : <span className="text-gray-400">None</span>}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 mb-1">Last contact</p>
              <p className="text-sm text-gray-900">
                {contact.last_contact_date
                  ? new Date(contact.last_contact_date).toLocaleDateString()
                  : <span className="text-gray-400">Never</span>}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Filter Dropdown
// ===========================================================================

function FilterDropdown({
  label,
  value,
  options,
  onChange,
  fullWidth = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  fullWidth?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none ${
        fullWidth ? 'w-full' : ''
      }`}
      aria-label={label}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

// ===========================================================================
// Sort Icon
// ===========================================================================

function SortIcon({
  field,
  current,
  dir,
}: {
  field: SortField;
  current: SortField;
  dir: SortDir;
}) {
  if (field !== current) {
    return <ChevronDown className="w-3 h-3 opacity-0 group-hover:opacity-50" />;
  }
  return dir === 'asc' ? (
    <ChevronUp className="w-3 h-3" />
  ) : (
    <ChevronDown className="w-3 h-3" />
  );
}
