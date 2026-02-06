import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  Inbox,
  Check,
  ChevronRight,
  Brain,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Users,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface UnsortedContact {
  id: string;
  name: string;
  intent: IntentType;
  createdAt: string;
}

interface UnsortedResponse {
  contacts: UnsortedContact[];
  count: number;
}

interface Circle {
  id: string;
  name: string;
}

type IntentType =
  | 'inner_circle'
  | 'nurture'
  | 'maintain'
  | 'transactional'
  | 'dormant'
  | 'new';

interface ContactSortState {
  circleIds: string[];
  intent: IntentType;
  isSaving: boolean;
  isSaved: boolean;
  error: string | null;
}

// ===========================================================================
// Constants
// ===========================================================================

const INTENT_LABELS: Record<IntentType, string> = {
  inner_circle: 'Inner Circle',
  nurture: 'Nurture',
  maintain: 'Maintain',
  transactional: 'Transactional',
  dormant: 'Dormant',
  new: 'Unsorted',
};

const INTENT_OPTIONS: Array<{ value: IntentType; label: string; description: string }> = [
  { value: 'inner_circle', label: 'Inner Circle', description: 'Weekly contact' },
  { value: 'nurture', label: 'Nurture', description: 'Bi-weekly contact' },
  { value: 'maintain', label: 'Maintain', description: 'Monthly contact' },
  { value: 'transactional', label: 'Transactional', description: 'Quarterly contact' },
  { value: 'dormant', label: 'Dormant', description: 'No active cadence' },
];

// ===========================================================================
// Component
// ===========================================================================

interface UnsortedTabProps {
  onCountChange?: (count: number) => void;
}

export function UnsortedTab({ onCountChange }: UnsortedTabProps) {
  const [showBraindump, setShowBraindump] = useState(false);

  // Fetch unsorted contacts
  const { data, isLoading, refetch } = useApi<UnsortedResponse>('/api/dashboard/unsorted?limit=100');

  // Fetch circles for dropdown
  const { data: circles } = useApi<Circle[]>('/api/circles');

  const contacts = data?.contacts ?? [];
  const count = data?.count ?? 0;

  // Notify parent of count changes
  useEffect(() => {
    onCountChange?.(count);
  }, [count, onCountChange]);

  // Track sorting state per contact
  const [sortStates, setSortStates] = useState<Record<string, ContactSortState>>({});

  // Initialize sort states when contacts load
  useEffect(() => {
    if (contacts.length > 0) {
      const initial: Record<string, ContactSortState> = {};
      for (const contact of contacts) {
        if (!sortStates[contact.id]) {
          initial[contact.id] = {
            circleIds: [],
            intent: contact.intent,
            isSaving: false,
            isSaved: false,
            error: null,
          };
        }
      }
      if (Object.keys(initial).length > 0) {
        setSortStates((prev) => ({ ...prev, ...initial }));
      }
    }
  }, [contacts]);

  // Update a contact's sort state
  const updateSortState = (contactId: string, updates: Partial<ContactSortState>) => {
    setSortStates((prev) => ({
      ...prev,
      [contactId]: { ...prev[contactId], ...updates },
    }));
  };

  // Save a contact's circle/intent assignment
  const { execute: saveContact } = useLazyApi();

  const handleSave = async (contact: UnsortedContact) => {
    const state = sortStates[contact.id];
    if (!state || state.circleIds.length === 0) return;

    updateSortState(contact.id, { isSaving: true, error: null });

    try {
      await saveContact(`/api/contacts/${contact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: state.intent,
          circle_ids: state.circleIds,
        }),
      });

      updateSortState(contact.id, { isSaving: false, isSaved: true });

      // Refresh the list after a short delay to show the checkmark
      setTimeout(() => {
        refetch();
      }, 800);
    } catch (err) {
      updateSortState(contact.id, {
        isSaving: false,
        error: err instanceof Error ? err.message : 'Failed to save',
      });
    }
  };

  // Format relative date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Added today';
    if (diffDays === 1) return 'Added yesterday';
    if (diffDays < 7) return `Added ${diffDays} days ago`;
    if (diffDays < 30) return `Added ${Math.floor(diffDays / 7)} weeks ago`;
    return `Added ${date.toLocaleDateString()}`;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
      </div>
    );
  }

  // Empty state
  if (count === 0) {
    return (
      <div className="bg-gradient-to-r from-green-50 to-emerald-50 rounded-xl border border-green-100 p-8 text-center">
        <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <CheckCircle2 className="w-6 h-6 text-green-600" />
        </div>
        <h3 className="font-medium text-gray-900 mb-2">All caught up!</h3>
        <p className="text-gray-500 mb-4">
          Every contact has been sorted into a circle. Your network is organized.
        </p>
        <div className="flex items-center justify-center gap-3">
          <Link
            to="/contacts"
            className="px-4 py-2 bg-white border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50"
          >
            View contacts
          </Link>
          <button
            onClick={() => setShowBraindump(true)}
            className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 flex items-center gap-2"
          >
            <Brain className="w-4 h-4" />
            Add more
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-gray-900">
            {count} contact{count !== 1 ? 's' : ''} to sort
          </h2>
          <p className="text-sm text-gray-500">
            Assign circles and relationship levels to see them on your dartboards
          </p>
        </div>
        <button
          onClick={() => setShowBraindump(!showBraindump)}
          className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 flex items-center gap-2"
        >
          <Sparkles className="w-4 h-4" />
          AI Sort
        </button>
      </div>

      {/* Braindump section (collapsible) */}
      {showBraindump && (
        <BraindumpSection onComplete={() => {
          setShowBraindump(false);
          refetch();
        }} />
      )}

      {/* Contact list */}
      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {contacts.map((contact) => {
          const state = sortStates[contact.id] ?? {
            circleIds: [],
            intent: contact.intent,
            isSaving: false,
            isSaved: false,
            error: null,
          };

          const canSave = state.circleIds.length > 0 && !state.isSaving && !state.isSaved;

          return (
            <div key={contact.id} className="p-4">
              <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                {/* Contact info */}
                <div className="flex-1 min-w-0">
                  <Link
                    to={`/contacts/${contact.id}`}
                    className="font-medium text-gray-900 hover:text-bethany-600"
                  >
                    {contact.name}
                  </Link>
                  <p className="text-sm text-gray-500">{formatDate(contact.createdAt)}</p>
                </div>

                {/* Circle select */}
                <div className="flex-shrink-0">
                  <CircleMultiSelect
                    circles={circles ?? []}
                    selected={state.circleIds}
                    onChange={(ids) => updateSortState(contact.id, { circleIds: ids, isSaved: false })}
                    disabled={state.isSaving || state.isSaved}
                  />
                </div>

                {/* Intent select */}
                <div className="flex-shrink-0">
                  <select
                    value={state.intent}
                    onChange={(e) => updateSortState(contact.id, { 
                      intent: e.target.value as IntentType,
                      isSaved: false 
                    })}
                    disabled={state.isSaving || state.isSaved}
                    className="px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-bethany-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-500"
                  >
                    {INTENT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Save button */}
                <button
                  onClick={() => handleSave(contact)}
                  disabled={!canSave}
                  className={`
                    flex-shrink-0 p-2 rounded-lg transition-colors
                    ${state.isSaved
                      ? 'bg-green-100 text-green-600'
                      : canSave
                        ? 'bg-bethany-500 text-white hover:bg-bethany-600'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }
                  `}
                  title={state.isSaved ? 'Saved!' : canSave ? 'Save' : 'Select a circle first'}
                >
                  {state.isSaving ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : state.isSaved ? (
                    <CheckCircle2 className="w-5 h-5" />
                  ) : (
                    <Check className="w-5 h-5" />
                  )}
                </button>
              </div>

              {/* Error message */}
              {state.error && (
                <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                  <AlertCircle className="w-4 h-4" />
                  {state.error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Quick tip */}
      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4">
        <p className="text-sm text-blue-800">
          <strong>Tip:</strong> Contacts need at least one circle to appear on dartboards.
          You can add the same person to multiple circles (like Work and Friends).
        </p>
      </div>
    </div>
  );
}

// ===========================================================================
// Circle Multi-Select
// ===========================================================================

function CircleMultiSelect({
  circles,
  selected,
  onChange,
  disabled,
}: {
  circles: Circle[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  const selectedNames = circles
    .filter((c) => selected.includes(c.id))
    .map((c) => c.name);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={`
          min-w-[140px] px-3 py-2 border border-gray-300 rounded-lg text-sm text-left bg-white
          flex items-center justify-between gap-2
          ${disabled ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : 'hover:border-gray-400'}
        `}
      >
        <span className="truncate">
          {selectedNames.length === 0
            ? 'Select circles...'
            : selectedNames.length === 1
              ? selectedNames[0]
              : `${selectedNames.length} circles`}
        </span>
        <ChevronRight className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute z-20 mt-1 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
            {circles.length === 0 ? (
              <div className="px-3 py-2 text-sm text-gray-500">
                No circles yet.{' '}
                <Link to="/settings#circles" className="text-bethany-600 hover:underline">
                  Create one
                </Link>
              </div>
            ) : (
              circles.map((circle) => (
                <button
                  key={circle.id}
                  onClick={() => toggle(circle.id)}
                  className="w-full px-3 py-2 text-sm text-left hover:bg-gray-50 flex items-center gap-2"
                >
                  <div
                    className={`w-4 h-4 border rounded flex items-center justify-center ${
                      selected.includes(circle.id)
                        ? 'bg-bethany-500 border-bethany-500'
                        : 'border-gray-300'
                    }`}
                  >
                    {selected.includes(circle.id) && (
                      <Check className="w-3 h-3 text-white" />
                    )}
                  </div>
                  {circle.name}
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ===========================================================================
// Braindump Section
// ===========================================================================

function BraindumpSection({ onComplete }: { onComplete: () => void }) {
  const [text, setText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [result, setResult] = useState<{ contacts: any[]; unresolved: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { execute: parse } = useLazyApi();
  const { execute: saveContact } = useLazyApi();

  const handleProcess = async () => {
    if (!text.trim()) return;

    setIsProcessing(true);
    setError(null);

    try {
      const data = await parse('/api/braindump/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });

      setResult(data);

      // Auto-save all parsed contacts
      for (const contact of data.contacts) {
        await saveContact('/api/contacts', {
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

      setText('');
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to process');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-5 h-5 text-bethany-500" />
        <h3 className="font-medium text-gray-900">Quick add with AI</h3>
      </div>
      <p className="text-sm text-gray-500 mb-3">
        Tell me about your contacts and I'll add them for you. Include names, how you know them, and any notes.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Jake is my gym buddy, we work out together twice a week. Sarah is from book club..."
        className="w-full h-32 px-3 py-2 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-bethany-500 focus:border-transparent"
        disabled={isProcessing}
      />
      {error && (
        <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
          <AlertCircle className="w-4 h-4" />
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <button
          onClick={handleProcess}
          disabled={!text.trim() || isProcessing}
          className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Add contacts
            </>
          )}
        </button>
      </div>
    </div>
  );
}
