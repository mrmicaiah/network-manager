import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  ArrowLeft,
  Phone,
  Mail,
  Pencil,
  Archive,
  RotateCcw,
  Trash2,
  MessageSquare,
  Clock,
  Heart,
  Check,
  X,
  Loader2,
  AlertTriangle,
  Calendar,
  TrendingUp,
  TrendingDown,
  Minus,
  PhoneCall,
  Video,
  Users,
  Globe,
  MoreHorizontal,
  Save,
  Plus,
  ChevronDown,
  Sparkles,
  Activity,
  Star,
} from 'lucide-react';
import { MethodPicker, MethodBadge, type InteractionMethod as MethodType } from '../components/MethodPicker';

// ===========================================================================
// Types
// ===========================================================================

type IntentType = 'inner_circle' | 'nurture' | 'maintain' | 'transactional' | 'dormant' | 'new';
type HealthStatus = 'green' | 'yellow' | 'red';
type ContactKind = 'kin' | 'non_kin';
type InteractionMethod = 'text' | 'call' | 'in_person' | 'email' | 'video' | 'social' | 'other';

interface Circle {
  id: string;
  name: string;
  type: 'default' | 'custom';
}

interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  intent: IntentType;
  health_status: HealthStatus;
  contact_kind: ContactKind;
  custom_cadence_days: number | null;
  preferred_method: InteractionMethod | null;
  last_contact_date: string | null;
  notes: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  circles: Circle[];
}

interface Interaction {
  id: string;
  contact_id: string;
  date: string;
  method: InteractionMethod;
  summary: string | null;
  logged_via: string;
  created_at: string;
}

// ===========================================================================
// Constants
// ===========================================================================

const INTENT_OPTIONS: Array<{ value: IntentType; label: string; color: string; cadence: number }> = [
  { value: 'inner_circle', label: 'Inner Circle', color: 'bg-bethany-100 text-bethany-700', cadence: 7 },
  { value: 'nurture', label: 'Nurture', color: 'bg-purple-100 text-purple-700', cadence: 14 },
  { value: 'maintain', label: 'Maintain', color: 'bg-blue-100 text-blue-700', cadence: 30 },
  { value: 'transactional', label: 'Transactional', color: 'bg-charcoal-100 text-charcoal-600', cadence: 90 },
  { value: 'dormant', label: 'Dormant', color: 'bg-charcoal-100 text-charcoal-500', cadence: 0 },
  { value: 'new', label: 'New', color: 'bg-golden-100 text-golden-600', cadence: 0 },
];

const HEALTH_OPTIONS: Array<{ value: HealthStatus; label: string; dot: string; bg: string; text: string }> = [
  { value: 'green', label: 'Healthy', dot: 'bg-sage-500', bg: 'bg-sage-50', text: 'text-sage-700' },
  { value: 'yellow', label: 'Needs attention', dot: 'bg-golden-400', bg: 'bg-golden-50', text: 'text-golden-700' },
  { value: 'red', label: 'Overdue', dot: 'bg-red-500', bg: 'bg-red-50', text: 'text-red-700' },
];

const METHOD_OPTIONS: Array<{ value: InteractionMethod; label: string; icon: typeof Phone }> = [
  { value: 'text', label: 'Text/SMS', icon: MessageSquare },
  { value: 'call', label: 'Phone call', icon: PhoneCall },
  { value: 'in_person', label: 'In person', icon: Users },
  { value: 'email', label: 'Email', icon: Mail },
  { value: 'video', label: 'Video call', icon: Video },
  { value: 'social', label: 'Social media', icon: Globe },
  { value: 'other', label: 'Other', icon: MoreHorizontal },
];

// ===========================================================================
// Helpers
// ===========================================================================

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

function formatFullDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function getDaysSince(dateStr: string | null): number {
  if (!dateStr) return Infinity;
  const date = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function getIntentConfig(intent: IntentType) {
  return INTENT_OPTIONS.find((o) => o.value === intent) ?? INTENT_OPTIONS[0];
}

function getHealthConfig(status: HealthStatus) {
  return HEALTH_OPTIONS.find((o) => o.value === status) ?? HEALTH_OPTIONS[0];
}

function getMethodConfig(method: InteractionMethod) {
  return METHOD_OPTIONS.find((o) => o.value === method) ?? METHOD_OPTIONS[6];
}

// ===========================================================================
// Subcomponents
// ===========================================================================

interface HealthBadgeProps {
  status: HealthStatus;
  daysSince: number;
}

function HealthBadge({ status, daysSince }: HealthBadgeProps) {
  const config = getHealthConfig(status);
  return (
    <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full ${config.bg}`}>
      <span className={`w-2.5 h-2.5 rounded-full ${config.dot}`} />
      <span className={`text-sm font-medium ${config.text}`}>
        {daysSince === Infinity ? 'Never contacted' : `${daysSince} days since last contact`}
      </span>
    </div>
  );
}

interface IntentBadgeProps {
  intent: IntentType;
  size?: 'sm' | 'md';
}

function IntentBadge({ intent, size = 'md' }: IntentBadgeProps) {
  const config = getIntentConfig(intent);
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${config.color} ${sizeClass}`}>
      {config.label}
    </span>
  );
}

// ===========================================================================
// Log Interaction Card
// ===========================================================================

interface LogInteractionCardProps {
  onSave: (data: { method: InteractionMethod; date: string; summary: string }) => Promise<void>;
  isSaving: boolean;
}

function LogInteractionCard({ onSave, isSaving }: LogInteractionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [method, setMethod] = useState<InteractionMethod>('text');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({ method, date, summary });
    // Reset form
    setMethod('text');
    setDate(new Date().toISOString().slice(0, 10));
    setSummary('');
    setIsExpanded(false);
  };

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-sage-50 hover:bg-sage-100 text-sage-700 rounded-xl font-medium transition-colors"
      >
        <Plus className="w-5 h-5" />
        Log an interaction
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-warm-white rounded-xl border border-cream-dark p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="font-medium text-charcoal">Log Interaction</h4>
        <button
          type="button"
          onClick={() => setIsExpanded(false)}
          className="p-1 text-charcoal-400 hover:text-charcoal-600 rounded"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Method selector */}
      <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
        {METHOD_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isSelected = method === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setMethod(opt.value)}
              className={`
                flex flex-col items-center gap-1 p-2 rounded-xl text-xs transition-colors
                ${isSelected
                  ? 'bg-bethany-100 text-bethany-700 ring-2 ring-bethany-300'
                  : 'bg-cream-dark text-charcoal-600 hover:bg-cream'
                }
              `}
            >
              <Icon className="w-5 h-5" />
              <span className="hidden sm:block">{opt.label.split('/')[0]}</span>
            </button>
          );
        })}
      </div>

      {/* Date */}
      <div>
        <label className="block text-sm font-medium text-charcoal mb-1">When?</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          max={new Date().toISOString().slice(0, 10)}
          className="input-field"
        />
      </div>

      {/* Summary */}
      <div>
        <label className="block text-sm font-medium text-charcoal mb-1">Quick note (optional)</label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="What did you talk about?"
          rows={2}
          className="input-field resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setIsExpanded(false)}
          className="px-4 py-2 text-sm text-charcoal-light hover:text-charcoal"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSaving}
          className="inline-flex items-center gap-2 px-4 py-2 bg-sage-600 text-white rounded-xl text-sm font-medium hover:bg-sage-700 disabled:opacity-50 transition-colors"
        >
          {isSaving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          Save
        </button>
      </div>
    </form>
  );
}

// ===========================================================================
// Interaction Timeline
// ===========================================================================

interface InteractionTimelineProps {
  interactions: Interaction[];
  isLoading: boolean;
}

function InteractionTimeline({ interactions, isLoading }: InteractionTimelineProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-6 h-6 text-bethany-500 animate-spin" />
      </div>
    );
  }

  if (interactions.length === 0) {
    return (
      <div className="text-center py-8">
        <div className="w-12 h-12 bg-cream-dark rounded-full flex items-center justify-center mx-auto mb-3">
          <Clock className="w-6 h-6 text-charcoal-400" />
        </div>
        <p className="text-charcoal-light">No interactions logged yet</p>
        <p className="text-sm text-charcoal-400 mt-1">Log your first interaction above</p>
      </div>
    );
  }

  // Group interactions by date
  const grouped = interactions.reduce((acc, interaction) => {
    const dateKey = interaction.date.split('T')[0];
    if (!acc[dateKey]) acc[dateKey] = [];
    acc[dateKey].push(interaction);
    return acc;
  }, {} as Record<string, Interaction[]>);

  return (
    <div className="space-y-4">
      {Object.entries(grouped).map(([dateKey, dayInteractions]) => (
        <div key={dateKey}>
          <div className="text-xs font-medium text-charcoal-400 uppercase tracking-wider mb-2">
            {formatFullDate(dateKey)}
          </div>
          <div className="space-y-2">
            {dayInteractions.map((interaction) => {
              const methodConfig = getMethodConfig(interaction.method);
              const Icon = methodConfig.icon;
              return (
                <div
                  key={interaction.id}
                  className="flex items-start gap-3 p-3 bg-cream rounded-xl"
                >
                  <div className="w-8 h-8 bg-bethany-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Icon className="w-4 h-4 text-bethany-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-charcoal text-sm">
                        {methodConfig.label}
                      </span>
                      <span className="text-xs text-charcoal-400">
                        via {interaction.logged_via}
                      </span>
                    </div>
                    {interaction.summary && (
                      <p className="text-sm text-charcoal-light mt-1">{interaction.summary}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// Relationship Insights
// ===========================================================================

interface RelationshipInsightsProps {
  contact: Contact;
  interactions: Interaction[];
}

function RelationshipInsights({ contact, interactions }: RelationshipInsightsProps) {
  const insights = useMemo(() => {
    const intentConfig = getIntentConfig(contact.intent);
    const cadenceDays = contact.custom_cadence_days ?? intentConfig.cadence;
    const daysSince = getDaysSince(contact.last_contact_date);

    // Calculate average interval
    let avgInterval = 0;
    if (interactions.length >= 2) {
      const sortedDates = interactions
        .map((i) => new Date(i.date).getTime())
        .sort((a, b) => b - a);
      
      let totalInterval = 0;
      for (let i = 0; i < sortedDates.length - 1; i++) {
        totalInterval += (sortedDates[i] - sortedDates[i + 1]) / (1000 * 60 * 60 * 24);
      }
      avgInterval = Math.round(totalInterval / (sortedDates.length - 1));
    }

    // Method breakdown
    const methodCounts = interactions.reduce((acc, i) => {
      acc[i.method] = (acc[i.method] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const preferredMethod = Object.entries(methodCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] as InteractionMethod | undefined;

    // Suggested next contact
    const suggestedNext = contact.last_contact_date
      ? new Date(new Date(contact.last_contact_date).getTime() + cadenceDays * 24 * 60 * 60 * 1000)
      : new Date();

    // Relationship trend
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    if (interactions.length >= 4) {
      const recentHalf = interactions.slice(0, Math.floor(interactions.length / 2));
      const olderHalf = interactions.slice(Math.floor(interactions.length / 2));
      
      const recentAvg = recentHalf.length > 1
        ? recentHalf.reduce((sum, i, idx, arr) => {
            if (idx === 0) return 0;
            return sum + (new Date(arr[idx - 1].date).getTime() - new Date(i.date).getTime()) / (1000 * 60 * 60 * 24);
          }, 0) / (recentHalf.length - 1)
        : 0;
      
      const olderAvg = olderHalf.length > 1
        ? olderHalf.reduce((sum, i, idx, arr) => {
            if (idx === 0) return 0;
            return sum + (new Date(arr[idx - 1].date).getTime() - new Date(i.date).getTime()) / (1000 * 60 * 60 * 24);
          }, 0) / (olderHalf.length - 1)
        : 0;

      if (recentAvg > 0 && olderAvg > 0) {
        if (recentAvg < olderAvg * 0.8) trend = 'improving';
        else if (recentAvg > olderAvg * 1.2) trend = 'declining';
      }
    }

    return {
      cadenceDays,
      avgInterval,
      preferredMethod,
      suggestedNext,
      trend,
      isOnTrack: daysSince <= cadenceDays * 1.0,
      isDrifting: daysSince > cadenceDays * 1.5,
    };
  }, [contact, interactions]);

  if (contact.intent === 'dormant' || contact.intent === 'new') {
    return null;
  }

  return (
    <div className="space-y-3">
      {/* Average contact frequency */}
      {insights.avgInterval > 0 && (
        <div className="flex items-center gap-3 p-3 bg-cream rounded-xl">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
            <Activity className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <div className="text-sm font-medium text-charcoal">
              You typically connect every {insights.avgInterval} days
            </div>
            <div className="text-xs text-charcoal-light">
              Target: {insights.cadenceDays} days
            </div>
          </div>
        </div>
      )}

      {/* Relationship status */}
      <div className={`flex items-center gap-3 p-3 rounded-xl ${
        insights.isOnTrack ? 'bg-sage-50' : insights.isDrifting ? 'bg-red-50' : 'bg-golden-50'
      }`}>
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
          insights.isOnTrack ? 'bg-sage-100' : insights.isDrifting ? 'bg-red-100' : 'bg-golden-100'
        }`}>
          {insights.isOnTrack ? (
            <Check className={`w-4 h-4 text-sage-600`} />
          ) : insights.isDrifting ? (
            <AlertTriangle className={`w-4 h-4 text-red-600`} />
          ) : (
            <Clock className={`w-4 h-4 text-golden-600`} />
          )}
        </div>
        <div>
          <div className={`text-sm font-medium ${
            insights.isOnTrack ? 'text-sage-700' : insights.isDrifting ? 'text-red-700' : 'text-golden-700'
          }`}>
            {insights.isOnTrack
              ? 'Relationship is on track'
              : insights.isDrifting
              ? 'This relationship is drifting'
              : 'Time to reconnect soon'}
          </div>
        </div>
      </div>

      {/* Suggested next contact */}
      <div className="flex items-center gap-3 p-3 bg-cream rounded-xl">
        <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center">
          <Calendar className="w-4 h-4 text-purple-600" />
        </div>
        <div>
          <div className="text-sm font-medium text-charcoal">
            Suggested next contact
          </div>
          <div className="text-xs text-charcoal-light">
            {insights.suggestedNext <= new Date()
              ? 'As soon as possible'
              : formatFullDate(insights.suggestedNext.toISOString())}
          </div>
        </div>
      </div>

      {/* Trend indicator */}
      {interactions.length >= 4 && (
        <div className="flex items-center gap-3 p-3 bg-cream rounded-xl">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            insights.trend === 'improving' ? 'bg-sage-100' : insights.trend === 'declining' ? 'bg-red-100' : 'bg-charcoal-100'
          }`}>
            {insights.trend === 'improving' ? (
              <TrendingUp className="w-4 h-4 text-sage-600" />
            ) : insights.trend === 'declining' ? (
              <TrendingDown className="w-4 h-4 text-red-600" />
            ) : (
              <Minus className="w-4 h-4 text-charcoal-500" />
            )}
          </div>
          <div>
            <div className="text-sm font-medium text-charcoal">
              {insights.trend === 'improving'
                ? 'Connection frequency improving'
                : insights.trend === 'declining'
                ? 'Connection frequency declining'
                : 'Connection frequency stable'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Confirm Modal
// ===========================================================================

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: 'danger' | 'primary';
  isLoading?: boolean;
}

function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  confirmVariant = 'primary',
  isLoading,
}: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-charcoal/50 z-50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-warm-white rounded-2xl shadow-xl w-full max-w-sm"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-6">
            <div
              className={`w-12 h-12 rounded-full flex items-center justify-center mb-4 ${
                confirmVariant === 'danger' ? 'bg-red-100' : 'bg-bethany-100'
              }`}
            >
              <AlertTriangle
                className={`w-6 h-6 ${
                  confirmVariant === 'danger' ? 'text-red-600' : 'text-bethany-600'
                }`}
              />
            </div>
            <h3 className="text-lg font-semibold text-charcoal mb-2">{title}</h3>
            <p className="text-sm text-charcoal-light">{message}</p>
          </div>
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-dark bg-cream rounded-b-2xl">
            <button
              onClick={onClose}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium text-charcoal-light hover:text-charcoal"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              disabled={isLoading}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-50 transition-colors shadow-soft ${
                confirmVariant === 'danger'
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-bethany-600 hover:bg-bethany-700'
              }`}
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Main ContactDetailPage Component
// ===========================================================================

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // API hooks
  const { data: contact, isLoading: contactLoading, error: contactError, refetch: refetchContact } = useApi<Contact>(
    id ? `/api/contacts/${id}` : null
  );
  const { data: circles = [] } = useApi<Circle[]>('/api/circles');
  const { data: interactions = [], isLoading: interactionsLoading, refetch: refetchInteractions } = useApi<Interaction[]>(
    id ? `/api/interactions?contact_id=${id}&limit=50` : null
  );
  const { execute: executeApi, isLoading: isMutating } = useLazyApi();

  // Local state
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<{
    intent: IntentType;
    contact_kind: ContactKind;
    preferred_method: InteractionMethod | null;
    notes: string;
    circle_ids: string[];
  } | null>(null);
  const [confirmAction, setConfirmAction] = useState<'archive' | 'delete' | null>(null);

  // Initialize edit form when contact loads
  useEffect(() => {
    if (contact && !editForm) {
      setEditForm({
        intent: contact.intent,
        contact_kind: contact.contact_kind,
        preferred_method: contact.preferred_method,
        notes: contact.notes ?? '',
        circle_ids: contact.circles.map((c) => c.id),
      });
    }
  }, [contact, editForm]);

  // Handlers
  const handleSaveChanges = async () => {
    if (!contact || !editForm) return;

    await executeApi(`/api/contacts/${contact.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editForm),
    });

    setIsEditing(false);
    refetchContact();
  };

  const handleLogInteraction = async (data: { method: InteractionMethod; date: string; summary: string }) => {
    if (!contact) return;

    await executeApi('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: contact.id,
        ...data,
      }),
    });

    refetchContact();
    refetchInteractions();
  };

  const handleArchive = async () => {
    if (!contact) return;
    await executeApi(`/api/contacts/${contact.id}/archive`, { method: 'POST' });
    setConfirmAction(null);
    refetchContact();
  };

  const handleRestore = async () => {
    if (!contact) return;
    await executeApi(`/api/contacts/${contact.id}/restore`, { method: 'POST' });
    refetchContact();
  };

  const handleDelete = async () => {
    if (!contact) return;
    await executeApi(`/api/contacts/${contact.id}?hard=true`, { method: 'DELETE' });
    setConfirmAction(null);
    navigate('/contacts');
  };

  const toggleCircle = (circleId: string) => {
    if (!editForm) return;
    setEditForm({
      ...editForm,
      circle_ids: editForm.circle_ids.includes(circleId)
        ? editForm.circle_ids.filter((id) => id !== circleId)
        : [...editForm.circle_ids, circleId],
    });
  };

  // Loading state
  if (contactLoading) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
      </div>
    );
  }

  // Error state
  if (contactError || !contact) {
    return (
      <div className="min-h-screen bg-cream flex flex-col items-center justify-center p-4">
        <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mb-4">
          <AlertTriangle className="w-8 h-8 text-red-600" />
        </div>
        <h1 className="text-xl font-semibold text-charcoal mb-2">Contact not found</h1>
        <p className="text-charcoal-light mb-6">This contact may have been deleted.</p>
        <Link
          to="/contacts"
          className="inline-flex items-center gap-2 px-4 py-2 bg-bethany-600 text-white rounded-xl font-medium hover:bg-bethany-700 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to contacts
        </Link>
      </div>
    );
  }

  const isArchived = contact.archived === 1;
  const daysSince = getDaysSince(contact.last_contact_date);
  const healthConfig = getHealthConfig(contact.health_status);
  const intentConfig = getIntentConfig(contact.intent);

  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <div className="bg-warm-white border-b border-cream-dark sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-4">
            {/* Back link */}
            <Link
              to="/contacts"
              className="inline-flex items-center gap-1.5 text-sm text-charcoal-light hover:text-charcoal mb-4"
            >
              <ArrowLeft className="w-4 h-4" />
              All contacts
            </Link>

            {/* Name and badges */}
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="font-display text-2xl font-medium text-charcoal">
                    {contact.name}
                  </h1>
                  {isArchived && (
                    <span className="text-xs text-charcoal-400 bg-cream-dark px-2 py-1 rounded">
                      Archived
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-2">
                  <HealthBadge status={contact.health_status} daysSince={daysSince} />
                  <IntentBadge intent={contact.intent} />
                  {contact.contact_kind === 'kin' && (
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-pink-50 text-pink-600">
                      <Heart className="w-3 h-3" />
                      Family
                    </span>
                  )}
                  {contact.preferred_method && (
                    <MethodBadge method={contact.preferred_method as MethodType} size="sm" />
                  )}
                </div>
              </div>

              {/* Quick actions */}
              <div className="flex items-center gap-2">
                {!isEditing && (
                  <button
                    onClick={() => setIsEditing(true)}
                    className="inline-flex items-center gap-2 px-4 py-2 border-2 border-cream-dark rounded-xl text-sm font-medium text-charcoal hover:bg-cream-dark transition-colors"
                  >
                    <Pencil className="w-4 h-4" />
                    Edit
                  </button>
                )}
                {isArchived ? (
                  <button
                    onClick={handleRestore}
                    disabled={isMutating}
                    className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 transition-colors"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Restore
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmAction('archive')}
                    className="inline-flex items-center gap-2 px-4 py-2 border-2 border-cream-dark rounded-xl text-sm font-medium text-charcoal hover:bg-cream-dark transition-colors"
                  >
                    <Archive className="w-4 h-4" />
                    Archive
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left column: Contact info & settings */}
          <div className="lg:col-span-1 space-y-6">
            {/* Contact info */}
            <section className="bg-warm-white rounded-2xl border border-cream-dark p-5">
              <h3 className="font-medium text-charcoal mb-4">Contact Info</h3>
              <div className="space-y-3">
                {contact.phone && (
                  <a
                    href={`tel:${contact.phone}`}
                    className="flex items-center gap-3 p-3 bg-cream rounded-xl hover:bg-cream-dark transition-colors"
                  >
                    <Phone className="w-5 h-5 text-bethany-600" />
                    <span className="text-charcoal">{contact.phone}</span>
                  </a>
                )}
                {contact.email && (
                  <a
                    href={`mailto:${contact.email}`}
                    className="flex items-center gap-3 p-3 bg-cream rounded-xl hover:bg-cream-dark transition-colors"
                  >
                    <Mail className="w-5 h-5 text-bethany-600" />
                    <span className="text-charcoal truncate">{contact.email}</span>
                  </a>
                )}
                {!contact.phone && !contact.email && (
                  <p className="text-sm text-charcoal-light">No contact info added</p>
                )}
              </div>
            </section>

            {/* Relationship settings */}
            <section className="bg-warm-white rounded-2xl border border-cream-dark p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-medium text-charcoal">Relationship</h3>
                {isEditing && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setIsEditing(false);
                        setEditForm({
                          intent: contact.intent,
                          contact_kind: contact.contact_kind,
                          preferred_method: contact.preferred_method,
                          notes: contact.notes ?? '',
                          circle_ids: contact.circles.map((c) => c.id),
                        });
                      }}
                      className="text-sm text-charcoal-light hover:text-charcoal"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveChanges}
                      disabled={isMutating}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-bethany-600 text-white rounded-lg text-sm font-medium hover:bg-bethany-700 transition-colors"
                    >
                      {isMutating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                      Save
                    </button>
                  </div>
                )}
              </div>

              <div className="space-y-4">
                {/* Intent layer */}
                <div>
                  <label className="block text-sm text-charcoal-light mb-1.5">Layer</label>
                  {isEditing && editForm ? (
                    <select
                      value={editForm.intent}
                      onChange={(e) => setEditForm({ ...editForm, intent: e.target.value as IntentType })}
                      className="input-field"
                    >
                      {INTENT_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label} ({opt.cadence > 0 ? `${opt.cadence} days` : 'No cadence'})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex items-center gap-2">
                      <IntentBadge intent={contact.intent} />
                      {intentConfig.cadence > 0 && (
                        <span className="text-sm text-charcoal-light">
                          ({intentConfig.cadence}-day cadence)
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Contact kind */}
                <div>
                  <label className="block text-sm text-charcoal-light mb-1.5">Type</label>
                  {isEditing && editForm ? (
                    <div className="flex gap-4">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="contact_kind"
                          value="non_kin"
                          checked={editForm.contact_kind === 'non_kin'}
                          onChange={() => setEditForm({ ...editForm, contact_kind: 'non_kin' })}
                          className="w-4 h-4 text-bethany-600 focus:ring-bethany-500"
                        />
                        <span className="text-sm text-charcoal">Friend/Other</span>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="contact_kind"
                          value="kin"
                          checked={editForm.contact_kind === 'kin'}
                          onChange={() => setEditForm({ ...editForm, contact_kind: 'kin' })}
                          className="w-4 h-4 text-bethany-600 focus:ring-bethany-500"
                        />
                        <span className="text-sm text-charcoal flex items-center gap-1">
                          <Heart className="w-4 h-4 text-pink-500" />
                          Family
                        </span>
                      </label>
                    </div>
                  ) : (
                    <span className="text-charcoal">
                      {contact.contact_kind === 'kin' ? (
                        <span className="flex items-center gap-1">
                          <Heart className="w-4 h-4 text-pink-500" />
                          Family
                        </span>
                      ) : (
                        'Friend/Other'
                      )}
                    </span>
                  )}
                </div>

                {/* Preferred contact method */}
                <div>
                  <label className="block text-sm text-charcoal-light mb-1.5">
                    Preferred Method
                    {isEditing && (
                      <span className="ml-1 text-xs text-charcoal-400">
                        (earns bonus points)
                      </span>
                    )}
                  </label>
                  {isEditing && editForm ? (
                    <MethodPicker
                      value={editForm.preferred_method as MethodType | null}
                      onChange={(method) => setEditForm({ ...editForm, preferred_method: method as InteractionMethod | null })}
                      variant="inline"
                      showNoPreference={true}
                      helpText="Interactions using this method earn 50 points instead of the default 25."
                    />
                  ) : (
                    <div>
                      {contact.preferred_method ? (
                        <MethodBadge method={contact.preferred_method as MethodType} />
                      ) : (
                        <span className="text-sm text-charcoal-light">No preference set</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Circles */}
                <div>
                  <label className="block text-sm text-charcoal-light mb-1.5">Circles</label>
                  {isEditing && editForm ? (
                    <div className="flex flex-wrap gap-2">
                      {circles.map((circle) => (
                        <button
                          key={circle.id}
                          type="button"
                          onClick={() => toggleCircle(circle.id)}
                          className={`
                            px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                            ${
                              editForm.circle_ids.includes(circle.id)
                                ? 'bg-bethany-100 text-bethany-700 ring-2 ring-bethany-300'
                                : 'bg-cream-dark text-charcoal-600 hover:bg-cream'
                            }
                          `}
                        >
                          {circle.name}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {contact.circles.length > 0 ? (
                        contact.circles.map((circle) => (
                          <span
                            key={circle.id}
                            className="px-2 py-0.5 rounded-full text-xs bg-cream-dark text-charcoal-light"
                          >
                            {circle.name}
                          </span>
                        ))
                      ) : (
                        <span className="text-sm text-charcoal-light">No circles assigned</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Notes */}
                <div>
                  <label className="block text-sm text-charcoal-light mb-1.5">Notes</label>
                  {isEditing && editForm ? (
                    <textarea
                      value={editForm.notes}
                      onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                      placeholder="Add notes about this person..."
                      rows={3}
                      className="input-field resize-none"
                    />
                  ) : (
                    <p className="text-charcoal">
                      {contact.notes || <span className="text-charcoal-light">No notes</span>}
                    </p>
                  )}
                </div>
              </div>
            </section>

            {/* Insights */}
            <section className="bg-warm-white rounded-2xl border border-cream-dark p-5">
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="w-5 h-5 text-bethany-500" />
                <h3 className="font-medium text-charcoal">Insights</h3>
              </div>
              <RelationshipInsights contact={contact} interactions={interactions} />
            </section>

            {/* Danger zone */}
            <section className="bg-warm-white rounded-2xl border border-red-200 p-5">
              <h3 className="font-medium text-red-700 mb-3">Danger Zone</h3>
              <button
                onClick={() => setConfirmAction('delete')}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 border-2 border-red-200 text-red-600 rounded-xl text-sm font-medium hover:bg-red-50 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                Delete permanently
              </button>
            </section>
          </div>

          {/* Right column: Interaction history */}
          <div className="lg:col-span-2 space-y-6">
            <section className="bg-warm-white rounded-2xl border border-cream-dark p-5">
              <h3 className="font-medium text-charcoal mb-4">Interaction History</h3>
              
              {/* Log interaction card */}
              <div className="mb-6">
                <LogInteractionCard onSave={handleLogInteraction} isSaving={isMutating} />
              </div>

              {/* Timeline */}
              <InteractionTimeline interactions={interactions} isLoading={interactionsLoading} />
            </section>
          </div>
        </div>
      </div>

      {/* Confirm modals */}
      <ConfirmModal
        isOpen={confirmAction === 'archive'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleArchive}
        title="Archive contact?"
        message={`${contact.name} will be hidden from your active contacts. You can restore them anytime.`}
        confirmLabel="Archive"
        isLoading={isMutating}
      />

      <ConfirmModal
        isOpen={confirmAction === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleDelete}
        title="Delete permanently?"
        message={`This will permanently delete ${contact.name} and all their interaction history. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={isMutating}
      />
    </div>
  );
}
