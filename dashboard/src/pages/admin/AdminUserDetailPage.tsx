import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useApi } from '../../hooks/useApi';
import {
  ArrowLeft,
  Mail,
  Phone,
  Calendar,
  Shield,
  Edit3,
  Send,
  Trash2,
  X,
  Check,
  AlertTriangle,
  RefreshCw,
  Users,
  Heart,
  MessageSquare,
  Layers,
  Copy,
  Loader2,
} from 'lucide-react';

// ===========================================================================
// Config & Types
// ===========================================================================

const API_URL = import.meta.env.VITE_API_URL || '';

interface UserDetail {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  gender: string | null;
  subscription_tier: string;
  onboarding_stage: string | null;
  trial_ends_at: string | null;
  stripe_customer_id: string | null;
  timezone: string;
  preferred_nudge_hour: number;
  nudge_frequency: string;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactSummary {
  id: string;
  name: string;
  intent: string;
  health_status: string;
  contact_kind: string;
  last_contact_date: string | null;
}

interface CircleSummary {
  id: string;
  name: string;
  type: string;
  sort_order: number;
  contact_count: number;
}

interface InteractionSummary {
  id: string;
  contact_id: string;
  date: string;
  method: string;
  summary: string | null;
  logged_via: string;
  contact_name: string;
}

interface UserDetailResponse {
  user: UserDetail;
  contacts: ContactSummary[];
  circles: CircleSummary[];
  recentInteractions: InteractionSummary[];
  roles: string[];
  subscription: {
    tier: string;
    isTrialActive: boolean;
    daysUntilTrialExpires: number | null;
    trialEndsAt: string | null;
    isPremium: boolean;
    hasStripe: boolean;
  };
}

const TIER_OPTIONS = ['free', 'trial', 'premium'];
const STAGE_OPTIONS = [
  { value: '', label: 'Complete (null)' },
  { value: 'intro_sent', label: 'Intro sent' },
  { value: 'user_replies', label: 'User replies' },
  { value: 'name_collected', label: 'Name collected' },
  { value: 'intent_sorting', label: 'Sorting' },
  { value: 'ready', label: 'Ready' },
];

// ===========================================================================
// Helpers
// ===========================================================================

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatShortDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function TierBadge({ tier }: { tier: string }) {
  const styles: Record<string, string> = { premium: 'badge-primary', trial: 'badge-warning', free: 'badge-neutral' };
  return <span className={styles[tier] ?? 'badge-neutral'}>{tier}</span>;
}

function StageBadge({ stage }: { stage: string | null }) {
  if (!stage) return <span className="badge-success">Complete</span>;
  if (stage === 'ready') return <span className="badge-success">Ready</span>;
  return <span className="badge-warning">{stage.replace(/_/g, ' ')}</span>;
}

function HealthDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    green: 'bg-sage-400',
    yellow: 'bg-golden-400',
    red: 'bg-bethany-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? 'bg-charcoal-300'}`} />;
}

function IntentLabel({ intent }: { intent: string }) {
  const labels: Record<string, string> = {
    inner_circle: 'Inner Circle',
    nurture: 'Nurture',
    maintain: 'Maintain',
    transactional: 'Transactional',
    dormant: 'Dormant',
    new: 'New',
  };
  return <span>{labels[intent] ?? intent}</span>;
}

function MethodIcon({ method }: { method: string }) {
  const labels: Record<string, string> = {
    text: '💬', call: '📞', in_person: '🤝', social: '📱', email: '📧', video: '🎥', other: '📌',
  };
  return <span title={method}>{labels[method] ?? '📌'}</span>;
}

/** Copy to clipboard */
async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); } catch { /* noop */ }
}

// ===========================================================================
// Inline Edit Component
// ===========================================================================

interface InlineEditProps {
  label: string;
  value: string;
  onSave: (value: string) => Promise<void>;
  type?: 'text' | 'select';
  options?: { value: string; label: string }[];
}

function InlineEdit({ label, value, onSave, type = 'text', options }: InlineEditProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (draft === value) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch { /* error handled by caller */ }
    setSaving(false);
  };

  const handleCancel = () => { setDraft(value); setEditing(false); };

  if (!editing) {
    return (
      <div className="flex items-center justify-between group">
        <div>
          <p className="text-xs text-charcoal-light">{label}</p>
          <p className="text-sm text-charcoal font-medium">{value || '—'}</p>
        </div>
        <button
          onClick={() => { setDraft(value); setEditing(true); }}
          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-cream-dark transition-all"
          title={`Edit ${label.toLowerCase()}`}
        >
          <Edit3 className="w-3.5 h-3.5 text-charcoal-light" />
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="text-xs text-charcoal-light mb-1">{label}</p>
      <div className="flex items-center gap-1.5">
        {type === 'select' && options ? (
          <select
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="input-field !py-1.5 text-sm flex-1"
            autoFocus
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="input-field !py-1.5 text-sm flex-1"
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
          />
        )}
        <button onClick={handleSave} disabled={saving} className="p-1.5 rounded-lg hover:bg-sage-100 text-sage-600 transition-colors">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
        </button>
        <button onClick={handleCancel} disabled={saving} className="p-1.5 rounded-lg hover:bg-cream-dark text-charcoal-light transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Confirmation Modal
// ===========================================================================

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor?: 'danger' | 'primary';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ open, title, message, confirmLabel, confirmColor = 'primary', loading, onConfirm, onCancel }: ConfirmModalProps) {
  if (!open) return null;
  const btnClass = confirmColor === 'danger'
    ? 'bg-red-600 hover:bg-red-700 text-white'
    : 'bg-bethany-500 hover:bg-bethany-600 text-white';

  return (
    <>
      <div className="modal-overlay" onClick={onCancel} />
      <div className="modal-container" onClick={onCancel}>
        <div className="modal-content !max-w-sm" onClick={(e) => e.stopPropagation()}>
          <div className="p-5">
            <h3 className="font-display text-lg text-charcoal mb-2">{title}</h3>
            <p className="text-sm text-charcoal-light">{message}</p>
          </div>
          <div className="flex items-center gap-2 px-5 pb-5">
            <button onClick={onCancel} disabled={loading} className="btn-ghost flex-1 text-sm">Cancel</button>
            <button onClick={onConfirm} disabled={loading} className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${btnClass} disabled:opacity-50 flex items-center justify-center gap-2`}>
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Page Component
// ===========================================================================

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data, isLoading, error, refetch } = useApi<UserDetailResponse>(
    id ? `${API_URL}/api/admin/users/${id}` : null,
  );

  // Action states
  const [resendModal, setResendModal] = useState(false);
  const [deleteModal, setDeleteModal] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  // Clear flash messages after 4s
  const flash = (msg: string) => {
    setActionSuccess(msg);
    setActionError(null);
    setTimeout(() => setActionSuccess(null), 4000);
  };
  const flashError = (msg: string) => {
    setActionError(msg);
    setActionSuccess(null);
    setTimeout(() => setActionError(null), 5000);
  };

  // ------ API Actions ------

  const handleUpdate = async (field: string, value: string) => {
    const body: Record<string, unknown> = {};
    if (field === 'name') body.name = value;
    if (field === 'subscription_tier') body.subscription_tier = value;
    if (field === 'onboarding_stage') body.onboarding_stage = value || null;

    const res = await fetch(`${API_URL}/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Update failed');
    }
    flash(`${field.replace(/_/g, ' ')} updated`);
    refetch();
  };

  const handleResendIntro = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${id}/resend-intro`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to resend');
      }
      flash('Bethany intro resent');
      setResendModal(false);
      refetch();
    } catch (err) {
      flashError(err instanceof Error ? err.message : 'Failed to resend intro');
    }
    setActionLoading(false);
  };

  const handleDelete = async () => {
    setActionLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Delete failed');
      }
      navigate('/admin/users', { replace: true });
    } catch (err) {
      flashError(err instanceof Error ? err.message : 'Failed to delete user');
      setDeleteModal(false);
    }
    setActionLoading(false);
  };

  // ------ Loading / Error ------

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-bethany-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-charcoal-light text-sm">Loading user...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card text-center py-12">
        <AlertTriangle className="w-8 h-8 text-golden-400 mx-auto mb-3" />
        <p className="text-charcoal font-medium mb-1">Failed to load user</p>
        <p className="text-charcoal-light text-sm mb-4">{error || 'User not found'}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/admin/users" className="btn-ghost text-sm">Back to users</Link>
          <button onClick={refetch} className="btn-secondary text-sm"><RefreshCw className="w-4 h-4" /> Retry</button>
        </div>
      </div>
    );
  }

  const { user, contacts, circles, recentInteractions, roles, subscription } = data;

  // Derived stats
  const intentCounts = contacts.reduce<Record<string, number>>((acc, c) => {
    acc[c.intent] = (acc[c.intent] || 0) + 1; return acc;
  }, {});
  const healthCounts = contacts.reduce<Record<string, number>>((acc, c) => {
    acc[c.health_status] = (acc[c.health_status] || 0) + 1; return acc;
  }, {});

  return (
    <div className="space-y-5">
      {/* Flash messages */}
      {actionSuccess && (
        <div className="bg-sage-100 text-sage-700 text-sm px-4 py-2.5 rounded-xl flex items-center gap-2 animate-fade-in">
          <Check className="w-4 h-4" /> {actionSuccess}
        </div>
      )}
      {actionError && (
        <div className="bg-red-50 text-red-700 text-sm px-4 py-2.5 rounded-xl flex items-center gap-2 animate-fade-in">
          <AlertTriangle className="w-4 h-4" /> {actionError}
        </div>
      )}

      {/* Back + Header */}
      <div>
        <Link to="/admin/users" className="text-sm text-charcoal-light hover:text-charcoal flex items-center gap-1 mb-3 transition-colors w-fit">
          <ArrowLeft className="w-4 h-4" /> Back to users
        </Link>

        <div className="card">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
            <div className="space-y-2">
              <h1 className="font-display text-2xl text-charcoal">{user.name}</h1>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-charcoal-light">
                {user.email && (
                  <span className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5" /> {user.email}</span>
                )}
                <span className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5" /> {user.phone}</span>
                <span className="flex items-center gap-1.5"><Calendar className="w-3.5 h-3.5" /> Joined {formatShortDate(user.created_at)}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <TierBadge tier={user.subscription_tier} />
                <StageBadge stage={user.onboarding_stage} />
                {roles.map((r) => (
                  <span key={r} className="badge flex items-center gap-1 bg-charcoal-100 text-charcoal-700">
                    <Shield className="w-3 h-3" /> {r}
                  </span>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              <button onClick={() => setResendModal(true)} className="btn-ghost text-sm flex items-center gap-1.5" title="Resend Bethany intro SMS">
                <Send className="w-4 h-4" /> Resend Intro
              </button>
              <button onClick={() => setDeleteModal(true)} className="btn-ghost text-sm flex items-center gap-1.5 text-red-500 hover:text-red-600 hover:bg-red-50" title="Delete user">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Two-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Account Info */}
        <div className="card space-y-4">
          <h2 className="font-display text-lg text-charcoal flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-charcoal-light" /> Account Info
          </h2>

          <InlineEdit label="Name" value={user.name} onSave={(v) => handleUpdate('name', v)} />

          <InlineEdit
            label="Subscription Tier"
            value={user.subscription_tier}
            type="select"
            options={TIER_OPTIONS.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            onSave={(v) => handleUpdate('subscription_tier', v)}
          />

          <InlineEdit
            label="Onboarding Stage"
            value={user.onboarding_stage ?? ''}
            type="select"
            options={STAGE_OPTIONS}
            onSave={(v) => handleUpdate('onboarding_stage', v)}
          />

          <div className="border-t border-cream-dark pt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-charcoal-light">User ID</span>
              <button onClick={() => copyText(user.id)} className="flex items-center gap-1 text-charcoal font-mono text-xs hover:text-bethany-500 transition-colors" title="Copy ID">
                {user.id.slice(0, 8)}… <Copy className="w-3 h-3" />
              </button>
            </div>
            {subscription.isTrialActive && subscription.trialEndsAt && (
              <div className="flex items-center justify-between">
                <span className="text-charcoal-light">Trial ends</span>
                <span className="text-charcoal">{formatShortDate(subscription.trialEndsAt)} ({subscription.daysUntilTrialExpires}d left)</span>
              </div>
            )}
            {user.stripe_customer_id && (
              <div className="flex items-center justify-between">
                <span className="text-charcoal-light">Stripe</span>
                <span className="text-charcoal font-mono text-xs">{user.stripe_customer_id.slice(0, 14)}…</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-charcoal-light">Timezone</span>
              <span className="text-charcoal">{user.timezone}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-charcoal-light">Nudge freq</span>
              <span className="text-charcoal">{user.nudge_frequency}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-charcoal-light">Updated</span>
              <span className="text-charcoal">{formatDate(user.updated_at)}</span>
            </div>
          </div>
        </div>

        {/* Contacts Summary */}
        <div className="card space-y-4">
          <h2 className="font-display text-lg text-charcoal flex items-center gap-2">
            <Users className="w-4 h-4 text-charcoal-light" /> Contacts
            <span className="text-sm font-body font-normal text-charcoal-light ml-auto">{contacts.length} total</span>
          </h2>

          {/* By intent */}
          <div>
            <p className="text-xs text-charcoal-light uppercase tracking-wide mb-2">By Layer</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {['inner_circle', 'nurture', 'maintain', 'transactional', 'dormant', 'new'].map((intent) => (
                <div key={intent} className="flex items-center justify-between bg-cream-dark/50 rounded-lg px-3 py-1.5 text-sm">
                  <IntentLabel intent={intent} />
                  <span className="font-medium text-charcoal">{intentCounts[intent] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>

          {/* By health */}
          <div>
            <p className="text-xs text-charcoal-light uppercase tracking-wide mb-2">By Health</p>
            <div className="flex items-center gap-4">
              {['green', 'yellow', 'red'].map((status) => (
                <div key={status} className="flex items-center gap-1.5 text-sm">
                  <HealthDot status={status} />
                  <span className="text-charcoal-light capitalize">{status}</span>
                  <span className="font-medium text-charcoal">{healthCounts[status] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Circles */}
        <div className="card space-y-3">
          <h2 className="font-display text-lg text-charcoal flex items-center gap-2">
            <Layers className="w-4 h-4 text-charcoal-light" /> Circles
            <span className="text-sm font-body font-normal text-charcoal-light ml-auto">{circles.length}</span>
          </h2>

          {circles.length > 0 ? (
            <div className="space-y-1.5">
              {circles.map((circle) => (
                <div key={circle.id} className="flex items-center justify-between bg-cream-dark/50 rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-charcoal font-medium">{circle.name}</span>
                    <span className="text-xs text-charcoal-light">({circle.type})</span>
                  </div>
                  <span className="text-charcoal-light">{circle.contact_count} contacts</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-charcoal-light">No circles created yet.</p>
          )}
        </div>

        {/* Recent Interactions */}
        <div className="card space-y-3">
          <h2 className="font-display text-lg text-charcoal flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-charcoal-light" /> Recent Interactions
          </h2>

          {recentInteractions.length > 0 ? (
            <div className="space-y-1.5">
              {recentInteractions.slice(0, 10).map((i) => (
                <div key={i.id} className="flex items-start gap-2.5 bg-cream-dark/50 rounded-lg px-3 py-2 text-sm">
                  <span className="text-base mt-0.5"><MethodIcon method={i.method} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-charcoal">{i.contact_name}</span>
                      <span className="text-xs text-charcoal-light whitespace-nowrap ml-2">{formatShortDate(i.date)}</span>
                    </div>
                    {i.summary && (
                      <p className="text-charcoal-light text-xs truncate mt-0.5">{i.summary}</p>
                    )}
                    <span className="text-xs text-charcoal-light/60">via {i.logged_via}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-charcoal-light">No interactions logged yet.</p>
          )}
        </div>

        {/* Onboarding Debug */}
        <div className="card space-y-3 lg:col-span-2">
          <h2 className="font-display text-lg text-charcoal flex items-center gap-2">
            <Heart className="w-4 h-4 text-charcoal-light" /> Onboarding State
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <p className="text-xs text-charcoal-light">Current Stage</p>
              <p className="font-medium text-charcoal mt-0.5">{user.onboarding_stage ?? 'Complete'}</p>
            </div>
            <div>
              <p className="text-xs text-charcoal-light">Gender</p>
              <p className="font-medium text-charcoal mt-0.5">{user.gender ?? 'Not set'}</p>
            </div>
            <div>
              <p className="text-xs text-charcoal-light">Nudge Hour</p>
              <p className="font-medium text-charcoal mt-0.5">{user.preferred_nudge_hour}:00 ({user.timezone})</p>
            </div>
            <div>
              <p className="text-xs text-charcoal-light">Quiet Hours</p>
              <p className="font-medium text-charcoal mt-0.5">
                {user.quiet_hours_start && user.quiet_hours_end
                  ? `${user.quiet_hours_start} – ${user.quiet_hours_end}`
                  : 'Not set'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <ConfirmModal
        open={resendModal}
        title="Resend Bethany Intro"
        message={`This will send Bethany's intro SMS to ${user.phone} and reset their onboarding stage to "intro_sent". Continue?`}
        confirmLabel="Send Intro"
        loading={actionLoading}
        onConfirm={handleResendIntro}
        onCancel={() => setResendModal(false)}
      />
      <ConfirmModal
        open={deleteModal}
        title="Delete User"
        message={`Permanently delete ${user.name} and all their data (${contacts.length} contacts, ${circles.length} circles, interactions, nudges)? This cannot be undone.`}
        confirmLabel="Delete User"
        confirmColor="danger"
        loading={actionLoading}
        onConfirm={handleDelete}
        onCancel={() => setDeleteModal(false)}
      />
    </div>
  );
}
