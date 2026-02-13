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
  X,
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

interface BraindumpAction {
  type: 'create_contact' | 'log_interaction' | 'update_contact' | 'unknown';
  contact_name?: string;
  data?: Record<string, unknown>;
  original_text?: string;
}

interface BraindumpParseResult {
  actions: BraindumpAction[];
  summary: string;
}

interface BraindumpExecuteResult {
  executed: number;
  failed: number;
  results: Array<{
    action: BraindumpAction;
    success: boolean;
    error?: string;
    result?: unknown;
  }>;
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
// Braindump Section - AI-powered text parsing
// ===========================================================================

type BraindumpStep = 'input' | 'parsing' | 'review' | 'executing' | 'done';

function BraindumpSection({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<BraindumpStep>('input');
  const [text, setText] = useState('');
  const [parseResult, setParseResult] = useState<BraindumpParseResult | null>(null);
  const [executeResult, setExecuteResult] = useState<BraindumpExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { execute: parse } = useLazyApi();
  const { execute: execute } = useLazyApi();

  // Step 1: Parse the text
  const handleParse = async () => {
    if (!text.trim()) return;

    setStep('parsing');
    setError(null);

    try {
      const data = await parse('/api/braindump/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });

      setParseResult(data);
      setStep('review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to parse');
      setStep('input');
    }
  };

  // Step 2: Execute the actions
  const handleExecute = async () => {
    if (!parseResult?.actions.length) return;

    setStep('executing');
    setError(null);

    try {
      const data = await execute('/api/braindump/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: parseResult.actions }),
      });

      setExecuteResult(data);
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to execute');
      setStep('review');
    }
  };

  // Reset and start over
  const handleReset = () => {
    setText('');
    setParseResult(null);
    setExecuteResult(null);
    setError(null);
    setStep('input');
  };

  // Close and refresh
  const handleDone = () => {
    onComplete();
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-bethany-500" />
          <h3 className="font-medium text-gray-900">Quick add with AI</h3>
        </div>
        {step !== 'input' && step !== 'done' && (
          <button
            onClick={handleReset}
            className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <X className="w-4 h-4" />
            Start over
          </button>
        )}
      </div>

      {/* Step: Input */}
      {step === 'input' && (
        <>
          <p className="text-sm text-gray-500">
            Tell me about your contacts and I'll add them for you. Include names, how you know them, and any notes.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleParse();
              }
            }}
            placeholder="Jake is my gym buddy, we work out together twice a week. Sarah is from book club, we meet monthly. Called mom yesterday to catch up..."
            className="w-full h-32 px-3 py-2 border border-gray-300 rounded-lg resize-none focus:ring-2 focus:ring-bethany-500 focus:border-transparent"
          />
          {error && (
            <p className="text-sm text-red-600 flex items-center gap-1">
              <AlertCircle className="w-4 h-4" />
              {error}
            </p>
          )}
          <div className="flex justify-between items-center">
            <p className="text-xs text-gray-400">
              Press ⌘+Enter to process
            </p>
            <button
              onClick={handleParse}
              disabled={!text.trim()}
              className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Process
            </button>
          </div>
        </>
      )}

      {/* Step: Parsing */}
      {step === 'parsing' && (
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="w-8 h-8 text-bethany-500 animate-spin mb-3" />
          <p className="text-gray-600">Reading your notes...</p>
        </div>
      )}

      {/* Step: Review */}
      {step === 'review' && parseResult && (
        <>
          <div className="bg-bethany-50 border border-bethany-100 rounded-lg p-3">
            <p className="text-sm text-bethany-800">{parseResult.summary}</p>
          </div>

          {parseResult.actions.length === 0 ? (
            <div className="text-center py-4">
              <p className="text-gray-500">No actions found. Try being more specific about names and relationships.</p>
              <button
                onClick={handleReset}
                className="mt-3 px-4 py-2 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">
                  I found {parseResult.actions.length} action{parseResult.actions.length !== 1 ? 's' : ''}:
                </p>
                <ul className="space-y-2">
                  {parseResult.actions.map((action, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm">
                      <span className="flex-shrink-0 w-5 h-5 bg-bethany-100 text-bethany-600 rounded-full flex items-center justify-center text-xs font-medium">
                        {i + 1}
                      </span>
                      <span className="text-gray-700">
                        {formatActionDescription(action)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {error && (
                <p className="text-sm text-red-600 flex items-center gap-1">
                  <AlertCircle className="w-4 h-4" />
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-3">
                <button
                  onClick={handleReset}
                  className="px-4 py-2 bg-gray-100 text-gray-700 font-medium rounded-lg hover:bg-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExecute}
                  className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Looks good, do it
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* Step: Executing */}
      {step === 'executing' && (
        <div className="flex flex-col items-center justify-center py-8">
          <Loader2 className="w-8 h-8 text-bethany-500 animate-spin mb-3" />
          <p className="text-gray-600">Updating your network...</p>
        </div>
      )}

      {/* Step: Done */}
      {step === 'done' && executeResult && (
        <>
          <div className="bg-green-50 border border-green-100 rounded-lg p-4 text-center">
            <CheckCircle2 className="w-8 h-8 text-green-600 mx-auto mb-2" />
            <p className="font-medium text-green-800">
              Done! {executeResult.executed} action{executeResult.executed !== 1 ? 's' : ''} completed.
            </p>
            {executeResult.failed > 0 && (
              <p className="text-sm text-orange-600 mt-1">
                {executeResult.failed} action{executeResult.failed !== 1 ? 's' : ''} failed.
              </p>
            )}
          </div>

          {/* Show results */}
          <div className="space-y-2">
            {executeResult.results.map((r, i) => (
              <div
                key={i}
                className={`flex items-center gap-2 text-sm p-2 rounded-lg ${
                  r.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                }`}
              >
                {r.success ? (
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                )}
                <span>{formatActionDescription(r.action)}</span>
                {!r.success && r.error && (
                  <span className="text-xs">— {r.error}</span>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleDone}
              className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600"
            >
              Done
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Format a braindump action into a human-readable description
 */
function formatActionDescription(action: BraindumpAction): string {
  switch (action.type) {
    case 'create_contact':
      return `Create contact: ${action.contact_name || 'Unknown'}`;
    case 'log_interaction':
      return `Log interaction with ${action.contact_name || 'Unknown'}`;
    case 'update_contact':
      return `Update ${action.contact_name || 'Unknown'}`;
    default:
      return action.original_text || 'Unknown action';
  }
}
