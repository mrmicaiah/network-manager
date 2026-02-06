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
  inner_circle: 'bg-violet-100 text-violet-700',
  nurture: 'bg-blue-100 text-blue-700',
  maintain: 'bg-cyan-100 text-cyan-700',
  transactional: 'bg-lime-100 text-lime-700',
  dormant: 'bg-gray-100 text-gray-600',
  new: 'bg-orange-100 text-orange-700',
};

const CONFIDENCE_STYLES: Record<string, string> = {
  high: 'border-l-green-400',
  medium: 'border-l-yellow-400',
  low: 'border-l-orange-400',
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
      // Create contacts one by one (could batch this if the API supports it)
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
            // Note: circle linking would need additional API support
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
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Braindump</h1>
        <p className="text-gray-500">
          Tell me about your contacts. Names, how you know them, what circle they belong to.
          I'll sort it out.
        </p>
      </div>

      {/* Input State */}
      {viewState === 'input' && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER_TEXT}
            className="w-full h-80 p-5 rounded-t-xl resize-none focus:outline-none text-gray-900 placeholder:text-gray-400"
            autoFocus
          />
          <div className="px-5 py-4 border-t border-gray-200 flex items-center justify-between bg-gray-50 rounded-b-xl">
            <p className="text-sm text-gray-500 flex items-center gap-2">
              <Brain className="w-4 h-4 text-bethany-500" />
              I'll extract contacts, relationships, and notes automatically
            </p>
            <button
              onClick={handleSubmit}
              disabled={!text.trim()}
              className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Process
            </button>
          </div>
        </div>
      )}

      {/* Loading State */}
      {viewState === 'loading' && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Processing your braindump...</h2>
          <p className="text-gray-500 max-w-sm mx-auto">
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
              className="text-gray-500 hover:text-gray-700 flex items-center gap-1 text-sm"
            >
              <ArrowLeft className="w-4 h-4" />
              Start over
            </button>
            <p className="text-sm text-gray-500">
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
            <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
              <p className="text-gray-500">
                I couldn't find any contacts in that text. Try adding more details like names
                and how you know them.
              </p>
            </div>
          )}

          {/* Unresolved items */}
          {result.unresolved.length > 0 && (
            <div className="bg-orange-50 rounded-xl border border-orange-200 p-4">
              <p className="text-sm font-medium text-orange-800 mb-2">
                Couldn't parse these parts:
              </p>
              <ul className="text-sm text-orange-700 space-y-1">
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
            <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-900">
                  Add {activeContacts.length} contact{activeContacts.length !== 1 ? 's' : ''}?
                </p>
                <p className="text-sm text-gray-500">
                  You can edit details later from the contacts page
                </p>
              </div>
              <button
                onClick={handleSaveAll}
                className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors flex items-center gap-2"
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
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Saving contacts...</h2>
          <p className="text-gray-500">Adding {activeContacts.length} contacts to your network</p>
        </div>
      )}

      {/* Success State */}
      {viewState === 'success' && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Check className="w-8 h-8 text-green-500" />
          </div>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Contacts added!</h2>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">
            Your contacts are now in the system. You can set up circles and adjust details
            from the contacts page.
          </p>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handleReset}
              className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors flex items-center gap-2"
            >
              <UserPlus className="w-4 h-4" />
              Add More
            </button>
            <a
              href="/contacts"
              className="px-5 py-2.5 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              View Contacts
            </a>
          </div>
        </div>
      )}

      {/* Error State */}
      {viewState === 'error' && (
        <div className="bg-white rounded-xl border border-red-200 p-12 text-center">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Something went wrong</h2>
          <p className="text-gray-500 max-w-sm mx-auto mb-6">
            {errorMessage || 'An unexpected error occurred. Please try again.'}
          </p>
          <button
            onClick={handleRetry}
            className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors"
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
      <div className="bg-gray-50 rounded-xl border border-gray-200 p-4 opacity-50">
        <div className="flex items-center justify-between">
          <p className="text-gray-500 line-through">{contact.name}</p>
          <span className="text-sm text-gray-400">Dismissed</span>
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
      className={`bg-white rounded-xl border border-gray-200 p-4 border-l-4 ${
        CONFIDENCE_STYLES[contact.confidence]
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Name and intent */}
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <h3 className="font-medium text-gray-900">{contact.name}</h3>
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
            <p className="text-sm text-gray-500 mb-2">
              {[contact.phone, contact.email].filter(Boolean).join(' • ')}
            </p>
          )}

          {/* Circles */}
          {contact.suggested_circles && contact.suggested_circles.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mb-2">
              {contact.suggested_circles.map((circle, i) => (
                <span
                  key={i}
                  className="px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full"
                >
                  {circle}
                </span>
              ))}
            </div>
          )}

          {/* Notes */}
          {contact.notes && (
            <p className="text-sm text-gray-600 mt-2 italic">"{contact.notes}"</p>
          )}

          {/* Confidence indicator */}
          <p className="text-xs text-gray-400 mt-2 capitalize">
            {contact.confidence} confidence
          </p>
        </div>

        {/* Dismiss button */}
        <button
          onClick={onDismiss}
          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0"
          title="Don't add this contact"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
