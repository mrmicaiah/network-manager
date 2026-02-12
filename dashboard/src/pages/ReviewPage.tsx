import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  Sparkles,
  Loader2,
  CheckCircle2,
  ChevronRight,
  MessageCircle,
  Send,
  X,
  ArrowRight,
  Users,
  Zap,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

type SortableIntentType = 'inner_circle' | 'nurture' | 'maintain' | 'transactional' | 'dormant';
type AnalysisConfidence = 'high' | 'medium' | 'low';

interface ContactAnalysisSignals {
  family_name_match: boolean;
  work_email_domain: boolean;
  has_recent_interaction: boolean;
  google_starred: boolean;
  contact_frequency_tier: 'high' | 'medium' | 'low' | 'unknown';
  has_birthday: boolean;
  has_notes: boolean;
  shared_surname_contacts: string[];
}

interface ContactAnalysis {
  id: string;
  contact_id: string;
  suggested_intent: SortableIntentType | null;
  confidence: AnalysisConfidence | null;
  reasoning: string | null;
  signals: ContactAnalysisSignals | null;
  reviewed: number;
  reviewed_at: string | null;
  user_accepted_suggestion: number | null;
}

interface Contact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  intent: string;
  notes: string | null;
  created_at: string;
}

interface ContactWithAnalysis {
  contact: Contact;
  analysis: ContactAnalysis | null;
}

interface ReviewStatsResponse {
  contacts: {
    total_unsorted: number;
    reviewed: number;
    pending: number;
    accepted_suggestions: number;
    rejected_suggestions: number;
  };
  sessions: {
    total_sessions: number;
    completed_sessions: number;
    total_contacts_reviewed: number;
    avg_contacts_per_session: number;
  };
}

interface ReviewBatchResponse {
  contacts: ContactWithAnalysis[];
  hasMore: boolean;
}

interface ReviewSession {
  id: string;
  user_id: string;
  started_at: string;
  completed_at: string | null;
  contacts_reviewed: number;
}

// ===========================================================================
// Constants
// ===========================================================================

const INTENT_CONFIG: Record<SortableIntentType, { label: string; description: string; color: string }> = {
  inner_circle: {
    label: 'Inner Circle',
    description: 'Weekly contact — your closest people',
    color: 'bg-rose-100 text-rose-700 border-rose-200',
  },
  nurture: {
    label: 'Nurture',
    description: 'Bi-weekly — relationships you\'re growing',
    color: 'bg-amber-100 text-amber-700 border-amber-200',
  },
  maintain: {
    label: 'Maintain',
    description: 'Monthly — stable, warm connections',
    color: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  },
  transactional: {
    label: 'Transactional',
    description: 'Quarterly — professional or purpose-driven',
    color: 'bg-blue-100 text-blue-700 border-blue-200',
  },
  dormant: {
    label: 'Dormant',
    description: 'Paused — no active reminders',
    color: 'bg-gray-100 text-gray-600 border-gray-200',
  },
};

// ===========================================================================
// Main Component
// ===========================================================================

export function ReviewPage() {
  const [session, setSession] = useState<ReviewSession | null>(null);
  const [contacts, setContacts] = useState<ContactWithAnalysis[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [isStarting, setIsStarting] = useState(true);

  // API hooks
  const { data: stats, refetch: refetchStats } = useApi<ReviewStatsResponse>('/api/review/stats');
  const { execute: startSession } = useLazyApi<{ session: ReviewSession; isNew: boolean }>();
  const { execute: fetchBatch } = useLazyApi<ReviewBatchResponse>();
  const { execute: triggerAnalysis } = useLazyApi<{ analyzed: number; skipped: number }>();
  const { execute: completeSession } = useLazyApi<{ session: ReviewSession }>();

  // Initialize session and fetch first batch
  useEffect(() => {
    const init = async () => {
      try {
        // Start or resume session
        const sessionData = await startSession('/api/review/session/start', {
          method: 'POST',
        });
        setSession(sessionData.session);

        // Trigger analysis if needed (idempotent)
        await triggerAnalysis('/api/review/analyze', { method: 'POST' });

        // Fetch first batch
        const batchData = await fetchBatch('/api/review/batch?limit=5');
        setContacts(batchData.contacts);
        setHasMore(batchData.hasMore);
      } catch (err) {
        console.error('Failed to initialize review:', err);
      } finally {
        setIsStarting(false);
      }
    };

    init();
  }, []);

  // Handle contact review completion
  const handleReviewComplete = useCallback((contactId: string) => {
    setCompletedIds((prev) => new Set([...prev, contactId]));

    // After animation, remove from list and maybe fetch more
    setTimeout(async () => {
      setContacts((prev) => prev.filter((c) => c.contact.id !== contactId));

      // If running low, fetch more
      const remaining = contacts.filter((c) => c.contact.id !== contactId && !completedIds.has(c.contact.id));
      if (remaining.length < 3 && hasMore) {
        try {
          const batchData = await fetchBatch('/api/review/batch?limit=5');
          setContacts((prev) => {
            const existingIds = new Set(prev.map((c) => c.contact.id));
            const newContacts = batchData.contacts.filter((c) => !existingIds.has(c.contact.id));
            return [...prev.filter((c) => c.contact.id !== contactId), ...newContacts];
          });
          setHasMore(batchData.hasMore);
        } catch (err) {
          console.error('Failed to fetch more contacts:', err);
        }
      }

      refetchStats();
    }, 500);
  }, [contacts, completedIds, hasMore, fetchBatch, refetchStats]);

  // Handle session completion
  const handleFinish = async () => {
    if (session) {
      await completeSession('/api/review/session/complete', { method: 'POST' });
    }
  };

  // Loading state
  if (isStarting) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Loader2 className="w-8 h-8 text-terracotta animate-spin mb-4" />
        <p className="text-charcoal-light">Loading your contacts...</p>
      </div>
    );
  }

  const pendingCount = stats?.contacts.pending ?? 0;
  const reviewedCount = stats?.contacts.reviewed ?? 0;
  const totalCount = stats?.contacts.total_unsorted ?? 0;
  const visibleContacts = contacts.filter((c) => !completedIds.has(c.contact.id));

  // All done state
  if (pendingCount === 0 && visibleContacts.length === 0) {
    return <AllDoneState reviewedCount={reviewedCount} onFinish={handleFinish} />;
  }

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center">
        <h1 className="font-display text-2xl font-medium text-charcoal mb-2">
          Review Your Network
        </h1>
        <p className="text-charcoal-light">
          {pendingCount > 0 ? (
            <>I found <strong>{pendingCount}</strong> contact{pendingCount !== 1 ? 's' : ''} to sort. Let's go through them together.</>
          ) : (
            <>Let's get these last few sorted.</>
          )}
        </p>
      </div>

      {/* Progress bar */}
      {totalCount > 0 && (
        <ProgressBar reviewed={reviewedCount} total={totalCount} />
      )}

      {/* Contact cards */}
      <div className="space-y-4">
        {visibleContacts.map((item, index) => (
          <ReviewCard
            key={item.contact.id}
            contact={item.contact}
            analysis={item.analysis}
            sessionId={session?.id}
            onComplete={() => handleReviewComplete(item.contact.id)}
            isFirst={index === 0}
          />
        ))}
      </div>

      {/* Load more / Finish buttons */}
      <div className="flex items-center justify-center gap-3 pt-4">
        {hasMore && visibleContacts.length < 5 && (
          <button
            onClick={async () => {
              const batchData = await fetchBatch('/api/review/batch?limit=5');
              setContacts((prev) => {
                const existingIds = new Set(prev.map((c) => c.contact.id));
                const newContacts = batchData.contacts.filter((c) => !existingIds.has(c.contact.id));
                return [...prev, ...newContacts];
              });
              setHasMore(batchData.hasMore);
            }}
            className="btn-secondary"
          >
            Load more
          </button>
        )}
        <Link
          to="/overview"
          onClick={handleFinish}
          className="text-charcoal-light hover:text-charcoal text-sm"
        >
          That's enough for now
        </Link>
      </div>
    </div>
  );
}

// ===========================================================================
// Progress Bar
// ===========================================================================

function ProgressBar({ reviewed, total }: { reviewed: number; total: number }) {
  const percent = total > 0 ? Math.round((reviewed / total) * 100) : 0;

  return (
    <div className="bg-cream-dark rounded-full p-1">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-cream rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-terracotta to-terracotta-light rounded-full transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-sm text-charcoal-light whitespace-nowrap">
          {reviewed}/{total}
        </span>
      </div>
    </div>
  );
}

// ===========================================================================
// Review Card
// ===========================================================================

interface ReviewCardProps {
  contact: Contact;
  analysis: ContactAnalysis | null;
  sessionId?: string;
  onComplete: () => void;
  isFirst: boolean;
}

function ReviewCard({ contact, analysis, sessionId, onComplete, isFirst }: ReviewCardProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const { execute: submitResponse } = useLazyApi();

  const suggestedIntent = analysis?.suggested_intent;
  const confidence = analysis?.confidence ?? 'low';
  const reasoning = analysis?.reasoning ?? "I don't have much info on this person yet.";

  // Get quick response buttons based on confidence
  const getQuickResponses = (): Array<{ label: string; intent: SortableIntentType }> => {
    if (confidence === 'high' && suggestedIntent) {
      return [
        { label: 'Yes', intent: suggestedIntent },
        { label: 'No, skip', intent: 'dormant' },
      ];
    }

    if (confidence === 'medium') {
      // Offer the top 2 most likely intents
      if (suggestedIntent === 'inner_circle' || suggestedIntent === 'nurture') {
        return [
          { label: 'Close friend', intent: 'inner_circle' },
          { label: 'Growing friendship', intent: 'nurture' },
          { label: 'Skip', intent: 'dormant' },
        ];
      }
      if (suggestedIntent === 'transactional') {
        return [
          { label: 'Work contact', intent: 'transactional' },
          { label: 'Actually a friend', intent: 'maintain' },
          { label: 'Skip', intent: 'dormant' },
        ];
      }
      return [
        { label: 'Keep in touch', intent: 'maintain' },
        { label: 'Just work', intent: 'transactional' },
        { label: 'Skip', intent: 'dormant' },
      ];
    }

    // Low confidence - minimal buttons
    return [
      { label: 'Skip for now', intent: 'dormant' },
    ];
  };

  const handleSubmit = async (intent: SortableIntentType) => {
    setIsSubmitting(true);
    try {
      await submitResponse('/api/review/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: contact.id,
          chosen_intent: intent,
          session_id: sessionId,
        }),
      });
      setShowSuccess(true);
      setTimeout(onComplete, 400);
    } catch (err) {
      console.error('Failed to submit response:', err);
      setIsSubmitting(false);
    }
  };

  const handleTextSubmit = async () => {
    if (!inputValue.trim()) return;

    // Parse simple text responses
    const text = inputValue.toLowerCase().trim();
    let intent: SortableIntentType = 'maintain';

    if (text.includes('close') || text.includes('best') || text.includes('inner')) {
      intent = 'inner_circle';
    } else if (text.includes('friend') || text.includes('grow') || text.includes('nurture')) {
      intent = 'nurture';
    } else if (text.includes('work') || text.includes('professional') || text.includes('colleague')) {
      intent = 'transactional';
    } else if (text.includes('skip') || text.includes('dormant') || text.includes('pause')) {
      intent = 'dormant';
    }

    await handleSubmit(intent);
  };

  const quickResponses = getQuickResponses();

  return (
    <div
      className={`
        card transition-all duration-300
        ${showSuccess ? 'opacity-0 scale-95 -translate-y-2' : 'opacity-100'}
        ${isFirst ? 'ring-2 ring-terracotta/20' : ''}
      `}
    >
      {/* Contact header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-charcoal text-lg truncate">
            {contact.name}
          </h3>
          <div className="flex items-center gap-2 text-sm text-charcoal-light mt-0.5">
            {contact.email && <span className="truncate">{contact.email}</span>}
            {contact.email && contact.phone && <span>·</span>}
            {contact.phone && <span>{contact.phone}</span>}
          </div>
        </div>
        <ConfidenceBadge confidence={confidence} />
      </div>

      {/* Bethany's suggestion */}
      <div className="bg-cream rounded-xl p-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full bg-terracotta/10 flex items-center justify-center flex-shrink-0">
            <Sparkles className="w-4 h-4 text-terracotta" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-charcoal">
              {reasoning}
            </p>
            {suggestedIntent && confidence !== 'low' && (
              <p className="text-sm text-charcoal-light mt-2">
                Suggested: <span className="font-medium">{INTENT_CONFIG[suggestedIntent].label}</span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Text input */}
      <div className="relative mb-3">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleTextSubmit()}
          placeholder="Tell me about this person..."
          className="input-field pr-12"
          disabled={isSubmitting}
        />
        {inputValue.trim() && (
          <button
            onClick={handleTextSubmit}
            disabled={isSubmitting}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-terracotta hover:bg-terracotta/10 rounded-lg transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Quick response buttons */}
      <div className="flex flex-wrap gap-2">
        {quickResponses.map((response) => (
          <button
            key={response.intent}
            onClick={() => handleSubmit(response.intent)}
            disabled={isSubmitting}
            className={`
              px-4 py-2 rounded-xl text-sm font-medium border transition-all
              ${response.label === 'Skip' || response.label === 'Skip for now' || response.label === 'No, skip'
                ? 'border-gray-200 text-charcoal-light hover:bg-gray-50'
                : 'border-terracotta/30 text-terracotta hover:bg-terracotta/10'
              }
              disabled:opacity-50
            `}
          >
            {isSubmitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              response.label
            )}
          </button>
        ))}

        {/* More options dropdown */}
        <MoreOptionsButton
          onSelect={handleSubmit}
          disabled={isSubmitting}
          excludeIntents={quickResponses.map((r) => r.intent)}
        />
      </div>
    </div>
  );
}

// ===========================================================================
// Confidence Badge
// ===========================================================================

function ConfidenceBadge({ confidence }: { confidence: AnalysisConfidence }) {
  const config = {
    high: { label: 'High confidence', color: 'bg-emerald-100 text-emerald-700' },
    medium: { label: 'Some info', color: 'bg-amber-100 text-amber-700' },
    low: { label: 'Need your help', color: 'bg-gray-100 text-gray-600' },
  };

  const { label, color } = config[confidence];

  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${color}`}>
      {label}
    </span>
  );
}

// ===========================================================================
// More Options Button
// ===========================================================================

interface MoreOptionsButtonProps {
  onSelect: (intent: SortableIntentType) => void;
  disabled: boolean;
  excludeIntents: SortableIntentType[];
}

function MoreOptionsButton({ onSelect, disabled, excludeIntents }: MoreOptionsButtonProps) {
  const [isOpen, setIsOpen] = useState(false);

  const availableIntents = (Object.keys(INTENT_CONFIG) as SortableIntentType[])
    .filter((intent) => !excludeIntents.includes(intent));

  if (availableIntents.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="px-4 py-2 rounded-xl text-sm font-medium border border-gray-200 text-charcoal-light hover:bg-gray-50 disabled:opacity-50"
      >
        Other...
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute bottom-full left-0 mb-2 w-56 bg-warm-white border border-cream-dark rounded-xl shadow-lg z-20 py-1 overflow-hidden">
            {availableIntents.map((intent) => (
              <button
                key={intent}
                onClick={() => {
                  onSelect(intent);
                  setIsOpen(false);
                }}
                className="w-full px-4 py-3 text-left hover:bg-cream transition-colors"
              >
                <span className="font-medium text-charcoal block">
                  {INTENT_CONFIG[intent].label}
                </span>
                <span className="text-sm text-charcoal-light">
                  {INTENT_CONFIG[intent].description}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// All Done State
// ===========================================================================

function AllDoneState({ reviewedCount, onFinish }: { reviewedCount: number; onFinish: () => void }) {
  return (
    <div className="max-w-md mx-auto text-center py-12">
      <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6">
        <CheckCircle2 className="w-8 h-8 text-emerald-600" />
      </div>

      <h1 className="font-display text-2xl font-medium text-charcoal mb-3">
        All caught up! 🎉
      </h1>

      <p className="text-charcoal-light mb-6">
        {reviewedCount > 0 ? (
          <>You've reviewed <strong>{reviewedCount}</strong> contact{reviewedCount !== 1 ? 's' : ''}. Your network is organized.</>
        ) : (
          <>No contacts to review right now. I'll let you know when more arrive.</>
        )}
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          to="/overview"
          onClick={onFinish}
          className="btn-primary"
        >
          Back to Dashboard
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          to="/import"
          className="btn-secondary"
        >
          <Users className="w-4 h-4" />
          Import more contacts
        </Link>
      </div>
    </div>
  );
}

export default ReviewPage;
