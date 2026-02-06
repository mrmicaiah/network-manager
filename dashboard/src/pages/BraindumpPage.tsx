import { useState } from 'react';
import { useLazyApi } from '../hooks/useApi';
import {
  Brain,
  Loader2,
  Check,
  X,
  AlertCircle,
  Sparkles,
  UserPlus,
  ArrowLeft,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface ParsedContact {
  name: string;
  phone?: string;
  email?: string;
  suggested_intent?: IntentType;
  suggested_circles?: string[];
  notes?: string;
  confidence: 'high' | 'medium' | 'low';
}

interface ParsedInteraction {
  contact_name: string;
  date?: string;
  method?: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
}

interface BraindumpResult {
  contacts: ParsedContact[];
  interactions: ParsedInteraction[];
  unresolved: string[];
}

type IntentType =
  | 'inner_circle'
  | 'nurture'
  | 'maintain'
  | 'transactional'
  | 'dormant'
  | 'new';

type ViewState = 'input' | 'loading' | 'confirm' | 'saving' | 'success' | 'error';

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
  inner_circle: 'bg-bethany-100 text-bethany-700',
  nurture: 'bg-blue-100 text-blue-700',
  maintain: 'bg-sage-100 text-sage-700',
  transactional: 'bg-charcoal-100 text-charcoal-600',
  dormant: 'bg-charcoal-100 text-charcoal-500',
  new: 'bg-golden-100 text-golden-600',
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'border-l-sage-400',
  medium: 'border-l-golden-400',
  low: 'border-l-bethany-400',
};

const PLACEHOLDER_TEXT = `Sarah Chen - college roommate, lives in Denver now, works at Google. We should catch up monthly. Last talked about 3 weeks ago about her new job.

Mom - call every Sunday. She mentioned wanting to visit in March. Family circle.

Jake from work - grab lunch sometime, he knows a lot about the startup scene. Work circle, maybe transactional.

My therapist Dr. Martinez - appointments every two weeks. Professional, don't need to track socially.

Best friend Mike - inner circle for sure. We've been friends since middle school. His birthday is in April.`;

// ===========================================================================
// Component
// ===========================================================================

export function BraindumpPage() {
  const [text, setText] = useState('');
  const [viewState, setViewState] = useState<ViewState>('input');
  const [result, setResult] = useState<BraindumpResult | null>(null);
  const [dismissedIndices, setDismissedIndices] = useState<Set<number>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { execute: parse } = useLazyApi<BraindumpResult>();
  const { execute: saveContacts } = useLazyApi<{ created: number }>();

  // Handle form submission
  const handleSubmit = async () => {
    if (!text.trim()) return;

    setViewState('loading');
    setErrorMessage(null);

    try {
      const data = await parse('/api/braindump/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });

      setResult(data);
      setDismissedIndices(new Set());
      setViewState('confirm');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to parse contacts');
      setViewState('error');
    }
  };

  // Dismiss a single contact
  const handleDismiss = (index: number) => {
    setDismissedIndices((prev) => new Set([...prev, index]));
  };

  // Get contacts that haven't been dismissed
  const activeContacts = result?.contacts.filter((_, i) => !dismissedIndices.has(i)) ?? [];

  // Save all accepted contacts
  const handleSaveAll = async () => {
    if (activeContacts.length === 0) return;

    setViewState('saving');

    try {
      for (const contact of activeContacts) {
        await saveContacts('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            intent: contact.suggested_intent ?? 'new',
            notes: contact.notes,
            source: 'braindump',
          }),
        });
      }

      setViewState('success');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save contacts');
      setViewState('error');
    }
  };

  // Reset to input state
  const handleReset = () => {
    setText('');
    setResult(null);
    setDismissedIndices(new Set());
    setErrorMessage(null);
    setViewState('input');
  };

  // Start over with same text
  const handleRetry = () => {
    setErrorMessage(null);
    setViewState('input');
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-medium text-charcoal mb-2">Braindump</h1>
        <p className="text-charcoal-light">
          Tell me about your contacts. Names, how you know them, what circle they belong to.
          I'll sort it out.
        </p>
      </div>

      {/* Input State */}
      {viewState === 'input' && (
        <div className="card !p-0 overflow-hidden">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER_TEXT}
            className="w-full h-80 p-5 rounded-t-2xl resize-none focus:outline-none text-charcoal placeholder:text-charcoal-400 bg-warm-white"
            autoFocus
          />
          <div className="px-5 py-4 border-t border-cream-dark flex items-center justify-between bg-cream rounded-b-2xl">
            <p className="text-sm text-charcoal-light flex items-center gap-2">
              <Brain className="w-4 h-4 text-bethany-500" />
              I'll extract contacts, relationships, and notes automatically
            </p>
            <button
              onClick={handleSubmit}
              disabled={!text.trim()}
              className="btn-primary"
            >
              <Sparkles className="w-4 h-4" />
              Process
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {viewState === 'loading' && (
        <div className="card text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Processing your braindump...</h2>
          <p className="text-charcoal-light max-w-sm mx-auto">
            I'm reading through everything and extracting the contacts, circles, and notes.
          </p>
        </div>
      )}

      {/* Confirmation State */}
      {viewState === 'confirm' && result && (
        <div className="space-y-4">
          {/* Back button and count */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleReset}
              className="text-charcoal-light hover:text-charcoal flex items-center gap-1 text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Start over
            </button>
            <p className="text-sm text-charcoal-light">
              Found {result.contacts.length} contact{result.contacts.length !== 1 ? 's' : ''}
              {dismissedIndices.size > 0 && ` (${activeContacts.length} selected)`}
            </p>
          </div>

          {/* Contact cards */}
          {result.contacts.length > 0 ? (
            <div className="space-y-3">
              {result.contacts.map((contact, index) => (
                <ContactCard
                  key={index}
                  contact={contact}
                  isDismissed={dismissedIndices.has(index)}
                  onDismiss={() => handleDismiss(index)}
                />
              ))}
            </div>
          ) : (
            <div className="card text-center">
              <p className="text-charcoal-light">
                I couldn't find any contacts in that text. Try adding more details like names
                and how you know them.
              </p>
            </div>
          )}

          {/* Unresolved items */}
          {result.unresolved.length > 0 && (
            <div className="bg-golden-50 rounded-2xl border border-golden-200 p-4">
              <p className="text-sm font-medium text-golden-800 mb-2">
                Couldn't parse these parts:
              </p>
              <ul className="text-sm text-golden-700 space-y-1">
                {result.unresolved.map((item, i) => (
                  <li key={i} className="truncate">
                    • {item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Save action */}
          {activeContacts.length > 0 && (
            <div className="card flex items-center justify-between">
              <div>
                <p className="font-medium text-charcoal">
                  Add {activeContacts.length} contact{activeContacts.length !== 1 ? 's' : ''}?
                </p>
                <p className="text-sm text-charcoal-light">
                  You can edit details later from the contacts page
                </p>
              </div>
              <button
                onClick={handleSaveAll}
                className="btn-primary"
              >
                <Check className="w-4 h-4" />
                Save All
              </button>
            </div>
          )}
        </div>
      )}

      {/* Saving State */}
      {viewState === 'saving' && (
        <div className="card text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Saving contacts...</h2>
          <p className="text-charcoal-light">Adding {activeContacts.length} contacts to your network</p>
        </div>
      )}

      {/* Success State */}
      {viewState === 'success' && (
        <div className="card text-center">
          <div className="w-16 h-16 bg-sage-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check className="w-8 h-8 text-sage-500" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Contacts added!</h2>
          <p className="text-charcoal-light max-w-sm mx-auto mb-6">
            Your contacts are now in the system. You can set up circles and adjust details
            from the contacts page.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleReset}
              className="btn-primary"
            >
              <UserPlus className="w-4 h-4" />
              Add More
            </button>
            <a
              href="/contacts"
              className="btn-secondary"
            >
              View Contacts
            </a>
          </div>
        </div>
      )}

      {/* Error State */}
      {viewState === 'error' && (
        <div className="card border-red-200 text-center">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Something went wrong</h2>
          <p className="text-charcoal-light max-w-sm mx-auto mb-6">
            {errorMessage || 'An unexpected error occurred. Please try again.'}
          </p>
          <button
            onClick={handleRetry}
            className="btn-primary"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Contact Card Component
// ===========================================================================

function ContactCard({
  contact,
  isDismissed,
  onDismiss,
}: {
  contact: ParsedContact;
  isDismissed: boolean;
  onDismiss: () => void;
}) {
  if (isDismissed) {
    return (
      <div className="bg-cream-dark rounded-2xl border border-cream-dark p-4 opacity-50">
        <div className="flex items-center justify-between">
          <p className="text-charcoal-light line-through">{contact.name}</p>
          <span className="text-sm text-charcoal-400">Dismissed</span>
        </div>
      </div>
    );
  }

  const intentLabel = contact.suggested_intent
    ? INTENT_LABELS[contact.suggested_intent]
    : null;
  const intentColor = contact.suggested_intent
    ? INTENT_COLORS[contact.suggested_intent]
    : '';

  return (
    <div
      className={`bg-warm-white rounded-2xl border border-cream-dark p-4 border-l-4 shadow-soft ${
        CONFIDENCE_STYLES[contact.confidence]
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Name and intent */}
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <h3 className="font-medium text-charcoal">{contact.name}</h3>
            {intentLabel && (
              <span
                className={`px-2 py-0.5 text-xs font-medium rounded-full ${intentColor}`}
              >
                {intentLabel}
              </span>
            )}
          </div>

          {/* Contact info */}
          {(contact.phone || contact.email) && (
            <p className="text-sm text-charcoal-light mb-2">
              {[contact.phone, contact.email].filter(Boolean).join(' • ')}
            </p>
          )}

          {/* Circles */}
          {contact.suggested_circles && contact.suggested_circles.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mb-2">
              {contact.suggested_circles.map((circle, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 bg-cream-dark text-charcoal-600 text-xs rounded-full"
                >
                  {circle}
                </span>
              ))}
            </div>
          )}

          {/* Notes */}
          {contact.notes && (
            <p className="text-sm text-charcoal-light mt-2 italic">"{contact.notes}"</p>
          )}

          {/* Confidence indicator */}
          <p className="text-xs text-charcoal-400 mt-2 capitalize">
            {contact.confidence} confidence
          </p>
        </div>

        {/* Dismiss button */}
        <button
          onClick={onDismiss}
          className="p-1.5 text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-dark rounded-xl transition-colors flex-shrink-0"
          title="Don't add this contact"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
