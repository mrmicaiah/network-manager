import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { API_URL } from '../../config';
import {
  Search,
  ChevronUp,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  AlertTriangle,
  RefreshCw,
  Users,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface UserRow {
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
  users: UserRow[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

type SortField = 'name' | 'created_at' | 'subscription_tier' | 'email' | 'phone';
type SortDir = 'asc' | 'desc';

const TIER_OPTIONS = [
  { value: '', label: 'All tiers' },
  { value: 'free', label: 'Free' },
  { value: 'trial', label: 'Trial' },
  { value: 'premium', label: 'Premium' },
];

const STAGE_OPTIONS = [
  { value: '', label: 'All stages' },
  { value: 'intro_sent', label: 'Intro sent' },
  { value: 'user_replies', label: 'User replies' },
  { value: 'name_collected', label: 'Name collected' },
  { value: 'intent_sorting', label: 'Sorting' },
  { value: 'ready', label: 'Ready' },
  { value: 'complete', label: 'Complete' },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50];

// ===========================================================================
// Helpers
// ===========================================================================

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') {
    const area = digits.slice(1, 4);
    const last4 = digits.slice(-4);
    return `(${area}) ***-${last4}`;
  }
  if (digits.length === 10) {
    const area = digits.slice(0, 3);
    const last4 = digits.slice(-4);
    return `(${area}) ***-${last4}`;
  }
  if (phone.length > 7) {
    return phone.slice(0, 3) + '\u2022\u2022\u2022\u2022' + phone.slice(-4);
  }
  return phone;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  if (!stage) return <span className="badge-neutral">\u2014</span>;
  if (stage === 'complete') return <span className="badge-success">Complete</span>;
  if (stage === 'ready') return <span className="badge-success">Ready</span>;
  const label = stage.replace(/_/g, ' ');
  return <span className="badge-warning">{label}</span>;
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// ===========================================================================
// Sort Header Component
// ===========================================================================

interface SortHeaderProps {
  field: SortField;
  label: string;
  currentSort: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  className?: string;
}

function SortHeader({ field, label, currentSort, currentDir, onSort, className = '' }: SortHeaderProps) {
  const isActive = currentSort === field;
  return (
    <th
      className={`text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light cursor-pointer select-none hover:text-charcoal transition-colors ${className}`}
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          currentDir === 'asc' ? (
            <ChevronUp className="w-3.5 h-3.5 text-bethany-500" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-bethany-500" />
          )
        ) : (
          <ChevronDown className="w-3.5 h-3.5 opacity-0 group-hover:opacity-30" />
        )}
      </span>
    </th>
  );
}

// ===========================================================================
// Skeleton Row
// ===========================================================================

function SkeletonRow() {
  return (
    <tr className="border-b border-cream-dark/60 animate-pulse">
      <td className="py-3.5 px-4 sm:px-5"><div className="w-4 h-4 bg-cream-dark rounded" /></td>
      <td className="py-3.5 px-4 sm:px-5"><div className="w-28 h-4 bg-cream-dark rounded" /></td>
      <td className="py-3.5 px-4 sm:px-5 hidden md:table-cell"><div className="w-36 h-4 bg-cream-dark rounded" /></td>
      <td className="py-3.5 px-4 sm:px-5 hidden lg:table-cell"><div className="w-28 h-4 bg-cream-dark rounded" /></td>
      <td className="py-3.5 px-4 sm:px-5"><div className="w-14 h-5 bg-cream-dark rounded-full" /></td>
      <td className="py-3.5 px-4 sm:px-5 hidden sm:table-cell"><div className="w-16 h-5 bg-cream-dark rounded-full" /></td>
      <td className="py-3.5 px-4 sm:px-5 hidden lg:table-cell"><div className="w-8 h-4 bg-cream-dark rounded" /></td>
      <td className="py-3.5 px-4 sm:px-5 text-right"><div className="w-20 h-4 bg-cream-dark rounded ml-auto" /></td>
    </tr>
  );
}

// ===========================================================================
// Page Component
// ===========================================================================

export default function AdminUsersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [tier, setTier] = useState(searchParams.get('tier') ?? '');
  const [stage, setStage] = useState(searchParams.get('stage') ?? '');
  const [page, setPage] = useState(parseInt(searchParams.get('page') ?? '1', 10));
  const [limit, setLimit] = useState(parseInt(searchParams.get('limit') ?? '25', 10));
  const [sortBy, setSortBy] = useState<SortField>((searchParams.get('sort_by') as SortField) || 'created_at');
  const [sortDir, setSortDir] = useState<SortDir>((searchParams.get('sort_dir') as SortDir) || 'desc');
  const [showFilters, setShowFilters] = useState(!!tier || !!stage);

  const [data, setData] = useState<UsersResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const debouncedSearch = useDebounce(searchInput, 300);

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    params.set('sort_by', sortBy);
    params.set('sort_dir', sortDir);
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (tier) params.set('tier', tier);
    if (stage) params.set('onboarding_stage', stage);

    try {
      const res = await fetch(`${API_URL}/api/admin/users?${params.toString()}`, {
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed: ${res.status}`);
      }
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [page, limit, sortBy, sortDir, debouncedSearch, tier, stage]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (tier) params.set('tier', tier);
    if (stage) params.set('stage', stage);
    if (page > 1) params.set('page', String(page));
    if (limit !== 25) params.set('limit', String(limit));
    if (sortBy !== 'created_at') params.set('sort_by', sortBy);
    if (sortDir !== 'desc') params.set('sort_dir', sortDir);
    setSearchParams(params, { replace: true });
  }, [debouncedSearch, tier, stage, page, limit, sortBy, sortDir, setSearchParams]);

  useEffect(() => { setPage(1); }, [debouncedSearch, tier, stage, limit]);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(field);
      setSortDir('asc');
    }
  };

  const clearFilters = () => { setSearchInput(''); setTier(''); setStage(''); setPage(1); };

  const hasActiveFilters = !!debouncedSearch || !!tier || !!stage;
  const totalPages = data?.pagination?.totalPages ?? 1;
  const total = data?.pagination?.total ?? 0;
  const startItem = total === 0 ? 0 : (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-2xl text-charcoal">Users</h1>
        <p className="text-charcoal-light text-sm mt-1">
          {total > 0 ? `${total} user${total === 1 ? '' : 's'}` : 'Manage user accounts'}
        </p>
      </div>

      <div className="card !p-3 sm:!p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-light" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, email, or phone..."
              className="input-field !pl-9 !py-2 text-sm"
            />
            {searchInput && (
              <button
                onClick={() => setSearchInput('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-charcoal-light hover:text-charcoal transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`btn-ghost text-sm flex items-center gap-1.5 shrink-0 ${hasActiveFilters ? 'text-bethany-500' : ''}`}
          >
            <Filter className="w-4 h-4" />
            <span className="hidden sm:inline">Filters</span>
            {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-bethany-500" />}
          </button>
        </div>

        {showFilters && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <select value={tier} onChange={(e) => setTier(e.target.value)} className="input-field !w-auto !py-2 text-sm !pr-8">
              {TIER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            <select value={stage} onChange={(e) => setStage(e.target.value)} className="input-field !w-auto !py-2 text-sm !pr-8">
              {STAGE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>
            {hasActiveFilters && (
              <button onClick={clearFilters} className="text-xs text-charcoal-light hover:text-charcoal flex items-center gap-1 transition-colors">
                <X className="w-3 h-3" /> Clear all
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="card text-center py-8">
          <AlertTriangle className="w-7 h-7 text-golden-400 mx-auto mb-2" />
          <p className="text-charcoal font-medium mb-1">Failed to load users</p>
          <p className="text-charcoal-light text-sm mb-3">{error}</p>
          <button onClick={fetchUsers} className="btn-secondary text-sm"><RefreshCw className="w-4 h-4" /> Retry</button>
        </div>
      )}

      {!error && (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cream-dark bg-cream/50">
                  <th className="w-10 py-2.5 px-4 sm:px-5">
                    <input type="checkbox" disabled className="opacity-30" title="Bulk actions coming soon" />
                  </th>
                  <SortHeader field="name" label="Name" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
                  <SortHeader field="email" label="Email" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="hidden md:table-cell" />
                  <SortHeader field="phone" label="Phone" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="hidden lg:table-cell" />
                  <SortHeader field="subscription_tier" label="Tier" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} />
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light hidden sm:table-cell">Stage</th>
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light hidden lg:table-cell">Contacts</th>
                  <SortHeader field="created_at" label="Created" currentSort={sortBy} currentDir={sortDir} onSort={handleSort} className="!text-right" />
                </tr>
              </thead>
              <tbody>
                {isLoading && !data ? (
                  Array.from({ length: limit > 10 ? 10 : limit }).map((_, i) => <SkeletonRow key={i} />)
                ) : data?.users && data.users.length > 0 ? (
                  data.users.map((user) => (
                    <tr
                      key={user.id}
                      onClick={() => navigate(`/admin/users/${user.id}`)}
                      className="border-b border-cream-dark/60 last:border-0 hover:bg-cream-dark/40 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-4 sm:px-5" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" disabled className="opacity-30" title="Bulk actions coming soon" />
                      </td>
                      <td className="py-3 px-4 sm:px-5"><span className="font-medium text-charcoal">{user.name}</span></td>
                      <td className="py-3 px-4 sm:px-5 text-charcoal-light hidden md:table-cell truncate max-w-[200px]">{user.email || '\u2014'}</td>
                      <td className="py-3 px-4 sm:px-5 text-charcoal-light hidden lg:table-cell font-mono text-xs">{maskPhone(user.phone)}</td>
                      <td className="py-3 px-4 sm:px-5"><TierBadge tier={user.subscription_tier} /></td>
                      <td className="py-3 px-4 sm:px-5 hidden sm:table-cell"><StageBadge stage={user.onboarding_stage} /></td>
                      <td className="py-3 px-4 sm:px-5 text-charcoal-light hidden lg:table-cell">{user.contact_count}</td>
                      <td className="py-3 px-4 sm:px-5 text-right text-charcoal-light whitespace-nowrap">{formatDate(user.created_at)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={8} className="py-16 text-center">
                      <Users className="w-8 h-8 text-charcoal-light/40 mx-auto mb-3" />
                      <p className="text-charcoal font-medium mb-1">
                        {hasActiveFilters ? 'No users match your filters' : 'No users yet'}
                      </p>
                      {hasActiveFilters && (
                        <button onClick={clearFilters} className="text-sm text-bethany-500 hover:text-bethany-600 transition-colors">Clear filters</button>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data && total > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t border-cream-dark bg-cream/30">
              <div className="text-sm text-charcoal-light">
                Showing <span className="font-medium text-charcoal">{startItem}\u2013{endItem}</span> of{' '}
                <span className="font-medium text-charcoal">{total}</span> users
              </div>
              <div className="flex items-center gap-2">
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="input-field !w-auto !py-1.5 !px-2 text-xs !min-h-0">
                  {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} / page</option>)}
                </select>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => setPage(1)} disabled={page <= 1} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="First page"><ChevronsLeft className="w-4 h-4" /></button>
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="Previous page"><ChevronLeft className="w-4 h-4" /></button>
                  <span className="text-sm text-charcoal px-2 font-medium">{page} <span className="text-charcoal-light font-normal">/ {totalPages}</span></span>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="Next page"><ChevronRight className="w-4 h-4" /></button>
                  <button onClick={() => setPage(totalPages)} disabled={page >= totalPages} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="Last page"><ChevronsRight className="w-4 h-4" /></button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
