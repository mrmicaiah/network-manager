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
  MessageSquare,
  ArrowRightLeft,
  CircleDot,
  Pencil,
  Phone,
  Mail,
  Video,
  Globe,
  Users,
} from 'lucide-react';

// ===========================================================================
// Types (mirrors backend BraindumpAction types)
// ===========================================================================

type IntentType = 'inner_circle' | 'nurture' | 'maintain' | 'transactional' | 'dormant' | 'new';
type InteractionMethod = 'text' | 'call' | 'in_person' | 'email' | 'video' | 'social' | 'other';

interface BraindumpAction {
  type: 'add_contact' | 'log_interaction' | 'update_layer' | 'assign_circle' | 'edit_contact';
  data: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
}

interface BraindumpParseResult {
  actions: BraindumpAction[];
  summary: string;
  unresolved: string[];
}

interface ExecuteResult {
  results: Array<{
    action: BraindumpAction;
    success: boolean;
    message: string;
    resourceId?: string;
  }>;
  summary: string;
}

type ViewState = 'input' | 'loading' | 'confirm' | 'executing' | 'done' | 'error';

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

const CONFIDENCE_BORDERS: Record<string, string> = {
  high: 'border-l-sage-400',
  medium: 'border-l-golden-400',
  low: 'border-l-bethany-400',
};

const ACTION_CONFIG: Record<string, { icon: typeof UserPlus; label: string; color: string }> = {
  add_contact: { icon: UserPlus, label: 'Add Contact', color: 'text-sage-600 bg-sage-50' },
  log_interaction: { icon: MessageSquare, label: 'Log Interaction', color: 'text-blue-600 bg-blue-50' },
  update_layer: { icon: ArrowRightLeft, label: 'Change Layer', color: 'text-bethany-600 bg-bethany-50' },
  assign_circle: { icon: CircleDot, label: 'Assign Circle', color: 'text-purple-600 bg-purple-50' },
  edit_contact: { icon: Pencil, label: 'Edit Contact', color: 'text-golden-600 bg-golden-50' },
};

const METHOD_ICONS: Record<InteractionMethod, typeof Phone> = {
  text: MessageSquare,
  call: Phone,
  in_person: Users,
  email: Mail,
  video: Video,
  social: Globe,
  other: MessageSquare,
};

const PLACEHOLDER_TEXT = `Had coffee with Sarah Chen yesterday — she's doing great at Google. Inner circle for sure.

Mom called Sunday like usual. She wants to visit in March. Remind me to follow up.

Met a guy named Jake at the startup meetup Friday. Works in AI, could be a good work contact. Add him to my Work circle.

I should move Lisa to nurture — we've been hanging out more lately.

Mike's new email is mike.johnson@gmail.com`;

// ===========================================================================
// Component
// ===========================================================================

export function BraindumpPage() {
  const [text, setText] = useState('');
  const [viewState, setViewState] = useState<ViewState>('input');
  const [parseResult, setParseResult] = useState<BraindumpParseResult | null>(null);
  const [executeResult, setExecuteResult] = useState<ExecuteResult | null>(null);
  const [dismissedIndices, setDismissedIndices] = useState<Set<number>>(new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { execute: callParse } = useLazyApi<BraindumpParseResult>();
  const { execute: callExecute } = useLazyApi<ExecuteResult>();

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setViewState('loading');
    setErrorMessage(null);

    try {
      const data = await callParse('/api/braindump/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
      });
      setParseResult(data);
      setDismissedIndices(new Set());
      setViewState('confirm');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to process');
      setViewState('error');
    }
  };

  const handleDismiss = (index: number) => {
    setDismissedIndices((prev) => new Set([...prev, index]));
  };

  const activeActions = parseResult?.actions.filter((_, i) => !dismissedIndices.has(i)) ?? [];

  const handleExecute = async () => {
    if (activeActions.length === 0) return;
    setViewState('executing');

    try {
      const data = await callExecute('/api/braindump/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: activeActions }),
      });
      setExecuteResult(data);
      setViewState('done');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to execute actions');
      setViewState('error');
    }
  };

  const handleReset = () => {
    setText('');
    setParseResult(null);
    setExecuteResult(null);
    setDismissedIndices(new Set());
    setErrorMessage(null);
    setViewState('input');
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-display text-2xl font-medium text-charcoal mb-2">Braindump</h1>
        <p className="text-charcoal-light">
          Tell me what's going on with your people. I'll figure out the rest.
        </p>
      </div>

      {/* Input */}
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
              Contacts, interactions, circles, layers — I'll sort it all out
            </p>
            <button onClick={handleSubmit} disabled={!text.trim()} className="btn-primary">
              <Sparkles className="w-4 h-4" />
              Process
            </button>
          </div>
        </div>
      )}

      {/* Loading */}
      {viewState === 'loading' && (
        <div className="card text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Processing...</h2>
          <p className="text-charcoal-light max-w-sm mx-auto">
            Reading through everything and figuring out what needs to happen.
          </p>
        </div>
      )}

      {/* Confirmation */}
      {viewState === 'confirm' && parseResult && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <button onClick={handleReset} className="text-charcoal-light hover:text-charcoal flex items-center gap-1 text-sm">
              <ArrowLeft className="w-4 h-4" /> Start over
            </button>
            <p className="text-sm text-charcoal-light">
              {parseResult.actions.length} action{parseResult.actions.length !== 1 ? 's' : ''}
              {dismissedIndices.size > 0 && ` (${activeActions.length} selected)`}
            </p>
          </div>

          {/* Summary */}
          {parseResult.summary && (
            <div className="bg-bethany-50 rounded-2xl border border-bethany-100 px-4 py-3">
              <p className="text-sm text-bethany-800">{parseResult.summary}</p>
            </div>
          )}

          {/* Action cards */}
          {parseResult.actions.length > 0 ? (
            <div className="space-y-3">
              {parseResult.actions.map((action, index) => (
                <ActionCard
                  key={index}
                  action={action}
                  isDismissed={dismissedIndices.has(index)}
                  onDismiss={() => handleDismiss(index)}
                />
              ))}
            </div>
          ) : (
            <div className="card text-center">
              <p className="text-charcoal-light">
                I couldn't figure out any actions from that. Try being more specific about
                names, interactions, or relationship changes.
              </p>
            </div>
          )}

          {/* Unresolved */}
          {parseResult.unresolved.length > 0 && (
            <div className="bg-golden-50 rounded-2xl border border-golden-200 p-4">
              <p className="text-sm font-medium text-golden-800 mb-2">Couldn't parse:</p>
              <ul className="text-sm text-golden-700 space-y-1">
                {parseResult.unresolved.map((item, i) => (
                  <li key={i} className="truncate">• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Execute */}
          {activeActions.length > 0 && (
            <div className="card flex items-center justify-between">
              <div>
                <p className="font-medium text-charcoal">
                  Run {activeActions.length} action{activeActions.length !== 1 ? 's' : ''}?
                </p>
                <p className="text-sm text-charcoal-light">Review above, dismiss anything that's wrong</p>
              </div>
              <button onClick={handleExecute} className="btn-primary">
                <Check className="w-4 h-4" /> Execute
              </button>
            </div>
          )}
        </div>
      )}

      {/* Executing */}
      {viewState === 'executing' && (
        <div className="card text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Executing actions...</h2>
          <p className="text-charcoal-light">Running {activeActions.length} actions</p>
        </div>
      )}

      {/* Done */}
      {viewState === 'done' && executeResult && (
        <div className="space-y-4">
          <div className="card text-center">
            <div className="w-16 h-16 bg-sage-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-sage-500" />
            </div>
            <h2 className="text-lg font-medium text-charcoal mb-2">Done!</h2>
            <p className="text-charcoal-light max-w-sm mx-auto mb-4">
              {executeResult.summary}
            </p>
          </div>

          {/* Results breakdown */}
          <div className="space-y-2">
            {executeResult.results.map((r, i) => {
              const config = ACTION_CONFIG[r.action.type] || ACTION_CONFIG.edit_contact;
              const Icon = config.icon;
              return (
                <div key={i} className={`flex items-center gap-3 px-4 py-3 rounded-xl ${r.success ? 'bg-sage-50' : 'bg-red-50'}`}>
                  <Icon className={`w-4 h-4 flex-shrink-0 ${r.success ? 'text-sage-600' : 'text-red-500'}`} />
                  <span className={`text-sm flex-1 ${r.success ? 'text-sage-800' : 'text-red-800'}`}>
                    {r.message}
                  </span>
                  {r.success ? (
                    <Check className="w-4 h-4 text-sage-500 flex-shrink-0" />
                  ) : (
                    <X className="w-4 h-4 text-red-400 flex-shrink-0" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-center gap-3 pt-2">
            <button onClick={handleReset} className="btn-primary">
              <Brain className="w-4 h-4" /> Dump More
            </button>
            <a href="/contacts" className="btn-secondary">View Contacts</a>
          </div>
        </div>
      )}

      {/* Error */}
      {viewState === 'error' && (
        <div className="card border-red-200 text-center">
          <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-500" />
          </div>
          <h2 className="text-lg font-medium text-charcoal mb-2">Something went wrong</h2>
          <p className="text-charcoal-light max-w-sm mx-auto mb-6">
            {errorMessage || 'An unexpected error occurred.'}
          </p>
          <button onClick={() => { setErrorMessage(null); setViewState('input'); }} className="btn-primary">
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Action Card
// ===========================================================================

function ActionCard({
  action,
  isDismissed,
  onDismiss,
}: {
  action: BraindumpAction;
  isDismissed: boolean;
  onDismiss: () => void;
}) {
  if (isDismissed) {
    return (
      <div className="bg-cream-dark rounded-2xl border border-cream-dark p-4 opacity-50">
        <div className="flex items-center justify-between">
          <p className="text-charcoal-light line-through text-sm">{getActionSummary(action)}</p>
          <span className="text-xs text-charcoal-400">Dismissed</span>
        </div>
      </div>
    );
  }

  const config = ACTION_CONFIG[action.type] || ACTION_CONFIG.edit_contact;
  const Icon = config.icon;

  return (
    <div className={`bg-warm-white rounded-2xl border border-cream-dark p-4 border-l-4 shadow-soft ${CONFIDENCE_BORDERS[action.confidence]}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Type badge + name */}
          <div className="flex items-center gap-2 flex-wrap mb-2">
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${config.color}`}>
              <Icon className="w-3 h-3" />
              {config.label}
            </span>
            <h3 className="font-medium text-charcoal">{getActionTitle(action)}</h3>
          </div>

          {/* Action-specific details */}
          <ActionDetails action={action} />

          {/* Reasoning */}
          <p className="text-xs text-charcoal-400 mt-2 italic">"{action.reasoning}"</p>
        </div>

        <button
          onClick={onDismiss}
          className="p-1.5 text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-dark rounded-xl transition-colors flex-shrink-0"
          title="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Action Details (type-specific content)
// ===========================================================================

function ActionDetails({ action }: { action: BraindumpAction }) {
  const d = action.data;

  switch (action.type) {
    case 'add_contact': {
      const intent = d.suggested_intent as IntentType | undefined;
      const circles = d.suggested_circles as string[] | undefined;
      return (
        <div className="space-y-1.5">
          {intent && (
            <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${INTENT_COLORS[intent]}`}>
              {INTENT_LABELS[intent]}
            </span>
          )}
          {(d.phone || d.email) && (
            <p className="text-sm text-charcoal-light">
              {[d.phone, d.email].filter(Boolean).join(' • ')}
            </p>
          )}
          {circles && circles.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {circles.map((c, i) => (
                <span key={i} className="px-2 py-0.5 bg-cream-dark text-charcoal-600 text-xs rounded-full">{c as string}</span>
              ))}
            </div>
          )}
          {d.notes && <p className="text-sm text-charcoal-light italic">"{d.notes as string}"</p>}
          {d.contact_kind === 'kin' && (
            <span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-bethany-50 text-bethany-600">Family</span>
          )}
        </div>
      );
    }

    case 'log_interaction': {
      const method = d.method as InteractionMethod;
      const MethodIcon = METHOD_ICONS[method] || MessageSquare;
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-sm text-charcoal-light">
            <MethodIcon className="w-3.5 h-3.5" />
            <span className="capitalize">{(method || '').replace('_', ' ')}</span>
            {d.date && <span>• {d.date as string}</span>}
          </div>
          {d.summary && <p className="text-sm text-charcoal-light">"{d.summary as string}"</p>}
          {d.contact_id && <p className="text-xs text-sage-600">Matched to existing contact</p>}
        </div>
      );
    }

    case 'update_layer': {
      const current = d.current_intent as IntentType | undefined;
      const newIntent = d.new_intent as IntentType;
      return (
        <div className="flex items-center gap-2 flex-wrap">
          {current && (
            <>
              <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${INTENT_COLORS[current]}`}>
                {INTENT_LABELS[current]}
              </span>
              <ArrowRightLeft className="w-3.5 h-3.5 text-charcoal-400" />
            </>
          )}
          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${INTENT_COLORS[newIntent]}`}>
            {INTENT_LABELS[newIntent]}
          </span>
        </div>
      );
    }

    case 'assign_circle': {
      return (
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 bg-cream-dark text-charcoal-600 text-xs rounded-full">
            {d.circle_name as string}
          </span>
          {d.create_circle && (
            <span className="text-xs text-golden-600">(new circle)</span>
          )}
        </div>
      );
    }

    case 'edit_contact': {
      const updates = d.updates as Record<string, unknown> | undefined;
      if (!updates) return null;
      const fields = Object.entries(updates).filter(([, v]) => v !== undefined);
      return (
        <div className="space-y-1">
          {fields.map(([key, value]) => (
            <p key={key} className="text-sm text-charcoal-light">
              <span className="capitalize text-charcoal-500">{key.replace('_', ' ')}:</span> {String(value)}
            </p>
          ))}
        </div>
      );
    }

    default:
      return null;
  }
}

// ===========================================================================
// Helpers
// ===========================================================================

function getActionTitle(action: BraindumpAction): string {
  const d = action.data;
  switch (action.type) {
    case 'add_contact': return d.name as string;
    case 'log_interaction': return d.contact_name as string;
    case 'update_layer': return d.contact_name as string;
    case 'assign_circle': return d.contact_name as string;
    case 'edit_contact': return d.contact_name as string;
    default: return 'Unknown';
  }
}

function getActionSummary(action: BraindumpAction): string {
  const d = action.data;
  switch (action.type) {
    case 'add_contact': return `Add ${d.name}`;
    case 'log_interaction': return `Log ${d.method} with ${d.contact_name}`;
    case 'update_layer': return `Move ${d.contact_name} to ${d.new_intent}`;
    case 'assign_circle': return `Add ${d.contact_name} to ${d.circle_name}`;
    case 'edit_contact': return `Edit ${d.contact_name}`;
    default: return 'Unknown action';
  }
}
