import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { API_URL } from '../../config';
import {
  Search,
  Filter,
  X,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronLeft,
  AlertTriangle,
  RefreshCw,
  Activity,
  Download,
  Shield,
  Trash2,
  Edit3,
  UserPlus,
  Send,
  Lock,
  Eye,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface AuditEntry {
  id: string;
  userId: string;
  userName: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

interface ActivityResponse {
  entries: AuditEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
}

const ACTION_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'user.update', label: 'User updated' },
  { value: 'user.delete', label: 'User deleted' },
  { value: 'role.assign', label: 'Role assigned' },
  { value: 'role.revoke', label: 'Role revoked' },
  { value: 'permission.denied', label: 'Permission denied' },
];

const RESOURCE_OPTIONS = [
  { value: '', label: 'All resources' },
  { value: 'user', label: 'User' },
  { value: 'role', label: 'Role' },
  { value: 'permission', label: 'Permission' },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100];

// ===========================================================================
// Helpers
// ===========================================================================

function formatTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${date}, ${time}`;
}

function ActionIcon({ action }: { action: string }) {
  const iconClass = 'w-4 h-4';
  if (action.includes('delete')) return <Trash2 className={`${iconClass} text-red-400`} />;
  if (action.includes('update')) return <Edit3 className={`${iconClass} text-bethany-500`} />;
  if (action.includes('create')) return <UserPlus className={`${iconClass} text-sage-500`} />;
  if (action.includes('assign') || action.includes('role')) return <Shield className={`${iconClass} text-golden-400`} />;
  if (action.includes('denied')) return <Lock className={`${iconClass} text-red-400`} />;
  if (action.includes('resend')) return <Send className={`${iconClass} text-bethany-500`} />;
  if (action.includes('view') || action.includes('read')) return <Eye className={`${iconClass} text-charcoal-light`} />;
  return <Activity className={`${iconClass} text-charcoal-light`} />;
}

function humanizeEntry(entry: AuditEntry): string {
  const { action, details } = entry;
  const d = details as Record<string, unknown> | null;
  if (action === 'user.update' && d?.changes) {
    const changes = d.changes as Record<string, { before: unknown; after: unknown }>;
    const parts = Object.entries(changes).filter(([key]) => key !== 'updated_at').map(([key, { before, after }]) => {
      const field = key.replace(/_/g, ' ');
      if (before === null || before === undefined) return `set ${field} to "${after}"`;
      return `changed ${field} from "${before}" to "${after}"`;
    });
    if (parts.length > 0) return parts.join(', ');
    return 'updated user';
  }
  if (action === 'user.update' && d?.action === 'resend_intro') return `resent Bethany intro (was: ${d.previousOnboardingStage ?? 'unknown'})`;
  if (action === 'user.delete' && d?.deletedUser) { const du = d.deletedUser as Record<string, unknown>; return `deleted user ${du.name ?? ''} (${du.contactsDeleted ?? 0} contacts removed)`; }
  if (action === 'permission.denied' && d?.required) return `access denied: needed "${d.required}" for ${d.method ?? ''} ${d.path ?? ''}`;
  if (action === 'role.assign') return `assigned role${d?.role ? ` "${d.role}"` : ''}`;
  if (action === 'role.revoke') return `revoked role${d?.role ? ` "${d.role}"` : ''}`;
  return action.replace(/\./g, ' ');
}

function actionBadgeClass(action: string): string {
  if (action.includes('delete')) return 'bg-red-50 text-red-700';
  if (action.includes('denied')) return 'bg-red-50 text-red-600';
  if (action.includes('update')) return 'bg-bethany-100 text-bethany-700';
  if (action.includes('create')) return 'bg-sage-100 text-sage-700';
  if (action.includes('assign') || action.includes('role')) return 'bg-golden-100 text-golden-700';
  return 'bg-cream-dark text-charcoal-light';
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = setTimeout(() => setDebounced(value), delayMs); return () => clearTimeout(t); }, [value, delayMs]);
  return debounced;
}

// ===========================================================================
// Expandable Row
// ===========================================================================

function EntryRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr className="border-b border-cream-dark/60 last:border-0 hover:bg-cream-dark/40 cursor-pointer transition-colors" onClick={() => setExpanded(!expanded)}>
        <td className="py-3 px-4 sm:px-5 w-8">
          {entry.details ? (expanded ? <ChevronDown className="w-4 h-4 text-charcoal-light" /> : <ChevronRight className="w-4 h-4 text-charcoal-light" />) : <span className="w-4" />}
        </td>
        <td className="py-3 px-4 sm:px-5 text-sm text-charcoal-light whitespace-nowrap">{formatTimestamp(entry.createdAt)}</td>
        <td className="py-3 px-4 sm:px-5 text-sm">
          <Link to={`/admin/users/${entry.userId}`} onClick={(e) => e.stopPropagation()} className="font-medium text-charcoal hover:text-bethany-500 transition-colors">{entry.userName}</Link>
        </td>
        <td className="py-3 px-4 sm:px-5">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${actionBadgeClass(entry.action)}`}>
            <ActionIcon action={entry.action} /> {entry.action}
          </span>
        </td>
        <td className="py-3 px-4 sm:px-5 text-sm text-charcoal-light hidden md:table-cell">
          {entry.resourceType ? (
            <span>{entry.resourceType}{entry.resourceId && (entry.resourceType === 'user' ? (
              <Link to={`/admin/users/${entry.resourceId}`} onClick={(e) => e.stopPropagation()} className="ml-1 text-bethany-500 hover:text-bethany-600 font-mono text-xs transition-colors">{entry.resourceId.slice(0, 8)}\u2026</Link>
            ) : <span className="ml-1 font-mono text-xs">{entry.resourceId.slice(0, 8)}\u2026</span>)}</span>
          ) : '\u2014'}
        </td>
        <td className="py-3 px-4 sm:px-5 text-sm text-charcoal-light hidden lg:table-cell max-w-[300px] truncate">{humanizeEntry(entry)}</td>
      </tr>
      {expanded && entry.details && (
        <tr className="bg-cream/60">
          <td colSpan={6} className="px-4 sm:px-5 py-3">
            <div className="ml-8 space-y-2">
              <p className="text-sm text-charcoal lg:hidden"><span className="font-medium">{entry.userName}</span> {humanizeEntry(entry)}</p>
              <details className="group">
                <summary className="text-xs text-charcoal-light cursor-pointer hover:text-charcoal transition-colors select-none">Raw details</summary>
                <pre className="mt-2 text-xs bg-charcoal text-sage-300 rounded-lg p-3 overflow-x-auto max-h-48">{JSON.stringify(entry.details, null, 2)}</pre>
              </details>
              {entry.ipAddress && <p className="text-xs text-charcoal-light">IP: <span className="font-mono">{entry.ipAddress}</span></p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ===========================================================================
// Page Component
// ===========================================================================

export default function AdminActivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchInput, setSearchInput] = useState(searchParams.get('search') ?? '');
  const [action, setAction] = useState(searchParams.get('action') ?? '');
  const [resourceType, setResourceType] = useState(searchParams.get('resource_type') ?? '');
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') ?? '');
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') ?? '');
  const [page, setPage] = useState(parseInt(searchParams.get('page') ?? '1', 10));
  const [limit, setLimit] = useState(parseInt(searchParams.get('limit') ?? '50', 10));
  const [showFilters, setShowFilters] = useState(!!action || !!resourceType || !!dateFrom || !!dateTo);

  const [data, setData] = useState<ActivityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const debouncedSearch = useDebounce(searchInput, 300);

  const fetchActivity = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('limit', String(limit));
    if (action) params.set('action', action);
    if (resourceType) params.set('resource_type', resourceType);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    try {
      const res = await fetch(`${API_URL}/api/admin/activity?${params.toString()}`, { credentials: 'include' });
      if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || `Request failed: ${res.status}`); }
      const json = await res.json();
      setData(json.data);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unknown error'); } finally { setIsLoading(false); }
  }, [page, limit, action, resourceType, dateFrom, dateTo]);

  useEffect(() => { fetchActivity(); }, [fetchActivity]);

  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (action) params.set('action', action);
    if (resourceType) params.set('resource_type', resourceType);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (page > 1) params.set('page', String(page));
    if (limit !== 50) params.set('limit', String(limit));
    setSearchParams(params, { replace: true });
  }, [debouncedSearch, action, resourceType, dateFrom, dateTo, page, limit, setSearchParams]);

  useEffect(() => { setPage(1); }, [action, resourceType, dateFrom, dateTo, limit]);

  const clearFilters = () => { setSearchInput(''); setAction(''); setResourceType(''); setDateFrom(''); setDateTo(''); setPage(1); };
  const hasActiveFilters = !!debouncedSearch || !!action || !!resourceType || !!dateFrom || !!dateTo;

  const filteredEntries = data?.entries
    ? (debouncedSearch ? data.entries.filter((e) => e.userName.toLowerCase().includes(debouncedSearch.toLowerCase())) : data.entries)
    : [];

  const total = data?.pagination?.total ?? 0;
  const totalPages = data?.pagination?.totalPages ?? 1;
  const startItem = total === 0 ? 0 : (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-charcoal">Activity Log</h1>
          <p className="text-charcoal-light text-sm mt-1">Admin actions and audit trail</p>
        </div>
        <button disabled className="btn-ghost text-sm flex items-center gap-1.5 opacity-40 cursor-not-allowed" title="CSV export coming soon">
          <Download className="w-4 h-4" /><span className="hidden sm:inline">Export</span>
        </button>
      </div>

      <div className="card !p-3 sm:!p-4 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-charcoal-light" />
            <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Filter by admin name..." className="input-field !pl-9 !py-2 text-sm" />
            {searchInput && <button onClick={() => setSearchInput('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-charcoal-light hover:text-charcoal transition-colors"><X className="w-4 h-4" /></button>}
          </div>
          <button onClick={() => setShowFilters(!showFilters)} className={`btn-ghost text-sm flex items-center gap-1.5 shrink-0 ${hasActiveFilters ? 'text-bethany-500' : ''}`}>
            <Filter className="w-4 h-4" /><span className="hidden sm:inline">Filters</span>
            {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-bethany-500" />}
          </button>
        </div>
        {showFilters && (
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <div><label className="text-xs text-charcoal-light block mb-1">Action</label><select value={action} onChange={(e) => setAction(e.target.value)} className="input-field !w-auto !py-2 text-sm !pr-8">{ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            <div><label className="text-xs text-charcoal-light block mb-1">Resource</label><select value={resourceType} onChange={(e) => setResourceType(e.target.value)} className="input-field !w-auto !py-2 text-sm !pr-8">{RESOURCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
            <div><label className="text-xs text-charcoal-light block mb-1">From</label><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input-field !py-2 text-sm !w-auto" /></div>
            <div><label className="text-xs text-charcoal-light block mb-1">To</label><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input-field !py-2 text-sm !w-auto" /></div>
            {hasActiveFilters && <button onClick={clearFilters} className="text-xs text-charcoal-light hover:text-charcoal flex items-center gap-1 transition-colors pb-2.5"><X className="w-3 h-3" /> Clear all</button>}
          </div>
        )}
      </div>

      {error && (
        <div className="card text-center py-8">
          <AlertTriangle className="w-7 h-7 text-golden-400 mx-auto mb-2" />
          <p className="text-charcoal font-medium mb-1">Failed to load activity</p>
          <p className="text-charcoal-light text-sm mb-3">{error}</p>
          <button onClick={fetchActivity} className="btn-secondary text-sm"><RefreshCw className="w-4 h-4" /> Retry</button>
        </div>
      )}

      {!error && (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-cream-dark bg-cream/50">
                  <th className="w-8 py-2.5 px-4 sm:px-5" />
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light whitespace-nowrap">Time</th>
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light">Admin</th>
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light">Action</th>
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light hidden md:table-cell">Resource</th>
                  <th className="text-left py-2.5 px-4 sm:px-5 font-medium text-charcoal-light hidden lg:table-cell">Details</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && !data ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-cream-dark/60 animate-pulse">
                      <td className="py-3.5 px-4 sm:px-5"><div className="w-4 h-4" /></td>
                      <td className="py-3.5 px-4 sm:px-5"><div className="w-16 h-4 bg-cream-dark rounded" /></td>
                      <td className="py-3.5 px-4 sm:px-5"><div className="w-24 h-4 bg-cream-dark rounded" /></td>
                      <td className="py-3.5 px-4 sm:px-5"><div className="w-20 h-5 bg-cream-dark rounded-full" /></td>
                      <td className="py-3.5 px-4 sm:px-5 hidden md:table-cell"><div className="w-28 h-4 bg-cream-dark rounded" /></td>
                      <td className="py-3.5 px-4 sm:px-5 hidden lg:table-cell"><div className="w-40 h-4 bg-cream-dark rounded" /></td>
                    </tr>
                  ))
                ) : filteredEntries.length > 0 ? (
                  filteredEntries.map((entry) => <EntryRow key={entry.id} entry={entry} />)
                ) : (
                  <tr>
                    <td colSpan={6} className="py-16 text-center">
                      <Activity className="w-8 h-8 text-charcoal-light/40 mx-auto mb-3" />
                      <p className="text-charcoal font-medium mb-1">{hasActiveFilters ? 'No matching activity found' : 'No activity recorded yet'}</p>
                      {hasActiveFilters && <button onClick={clearFilters} className="text-sm text-bethany-500 hover:text-bethany-600 transition-colors">Clear filters</button>}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {data && total > 0 && (
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 sm:px-5 py-3 border-t border-cream-dark bg-cream/30">
              <div className="text-sm text-charcoal-light">
                Showing <span className="font-medium text-charcoal">{startItem}\u2013{endItem}</span> of <span className="font-medium text-charcoal">{total}</span> entries
              </div>
              <div className="flex items-center gap-2">
                <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="input-field !w-auto !py-1.5 !px-2 text-xs !min-h-0">
                  {PAGE_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s} / page</option>)}
                </select>
                <div className="flex items-center gap-0.5">
                  <button onClick={() => setPage(1)} disabled={page <= 1} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="First page"><ChevronsLeft className="w-4 h-4" /></button>
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="Previous"><ChevronLeft className="w-4 h-4" /></button>
                  <span className="text-sm text-charcoal px-2 font-medium">{page} <span className="text-charcoal-light font-normal">/ {totalPages}</span></span>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="icon-btn !min-w-[36px] !min-h-[36px] disabled:opacity-30" title="Next"><ChevronRight className="w-4 h-4" /></button>
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
