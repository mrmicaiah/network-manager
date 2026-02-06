import { useState, useMemo, useCallback, useEffect, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi, useLazyApi } from '../hooks/useApi';
import { ExportModal } from '../components/ExportModal';
import {
  Search,
  Filter,
  Download,
  ChevronDown,
  ChevronUp,
  Users,
  X,
  Plus,
  Pencil,
  Archive,
  RotateCcw,
  Trash2,
  MessageSquare,
  CheckSquare,
  Square,
  Minus,
  Loader2,
  Check,
  Phone,
  Mail,
  AlertTriangle,
  UserPlus,
  FileUp,
  SlidersHorizontal,
  Clock,
  Heart,
  Briefcase,
  Home,
  Sparkles,
  ChevronRight,
  MoreHorizontal,
} from 'lucide-react';

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
  last_contact_date: string | null;
  notes: string | null;
  archived: number;
  created_at: string;
  circles: Circle[];
}

interface ContactListResponse {
  contacts: Contact[];
  total: number;
  hasMore: boolean;
}

type SortField = 'name' | 'last_contact_date' | 'health_status' | 'created_at';
type SortDirection = 'asc' | 'desc';

// ===========================================================================
// Constants
// ===========================================================================

const INTENT_OPTIONS: Array<{ value: IntentType; label: string; color: string }> = [
  { value: 'inner_circle', label: 'Inner Circle', color: 'bg-bethany-100 text-bethany-700' },
  { value: 'nurture', label: 'Nurture', color: 'bg-purple-100 text-purple-700' },
  { value: 'maintain', label: 'Maintain', color: 'bg-blue-100 text-blue-700' },
  { value: 'transactional', label: 'Transactional', color: 'bg-charcoal-100 text-charcoal-600' },
  { value: 'dormant', label: 'Dormant', color: 'bg-charcoal-100 text-charcoal-500' },
  { value: 'new', label: 'New', color: 'bg-golden-100 text-golden-600' },
];

const HEALTH_OPTIONS: Array<{ value: HealthStatus; label: string; dot: string; bg: string }> = [
  { value: 'green', label: 'Healthy', dot: 'bg-sage-500', bg: 'bg-sage-50' },
  { value: 'yellow', label: 'Needs attention', dot: 'bg-golden-400', bg: 'bg-golden-50' },
  { value: 'red', label: 'Overdue', dot: 'bg-red-500', bg: 'bg-red-50' },
];

const METHOD_OPTIONS: Array<{ value: InteractionMethod; label: string }> = [
  { value: 'text', label: 'Text/SMS' },
  { value: 'call', label: 'Phone call' },
  { value: 'in_person', label: 'In person' },
  { value: 'email', label: 'Email' },
  { value: 'video', label: 'Video call' },
  { value: 'social', label: 'Social media' },
  { value: 'other', label: 'Other' },
];

const SORT_OPTIONS: Array<{ value: SortField; label: string }> = [
  { value: 'name', label: 'Name' },
  { value: 'last_contact_date', label: 'Last contact' },
  { value: 'health_status', label: 'Health status' },
  { value: 'created_at', label: 'Date added' },
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

function getIntentConfig(intent: IntentType) {
  return INTENT_OPTIONS.find((o) => o.value === intent) ?? INTENT_OPTIONS[0];
}

function getHealthConfig(status: HealthStatus) {
  return HEALTH_OPTIONS.find((o) => o.value === status) ?? HEALTH_OPTIONS[0];
}

// ===========================================================================
// Subcomponents
// ===========================================================================

interface HealthDotProps {
  status: HealthStatus;
  size?: 'sm' | 'md';
}

function HealthDot({ status, size = 'md' }: HealthDotProps) {
  const config = getHealthConfig(status);
  const sizeClass = size === 'sm' ? 'w-2 h-2' : 'w-2.5 h-2.5';
  return (
    <span
      className={`inline-block rounded-full ${config.dot} ${sizeClass}`}
      title={config.label}
    />
  );
}

interface IntentBadgeProps {
  intent: IntentType;
  size?: 'sm' | 'md';
}

function IntentBadge({ intent, size = 'md' }: IntentBadgeProps) {
  const config = getIntentConfig(intent);
  const sizeClass = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-xs';
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${config.color} ${sizeClass}`}>
      {config.label}
    </span>
  );
}

interface CircleTagProps {
  circle: Circle;
}

function CircleTag({ circle }: CircleTagProps) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-cream-dark text-charcoal-light">
      {circle.name}
    </span>
  );
}

// ===========================================================================
// Contact Card Component
// ===========================================================================

interface ContactCardProps {
  contact: Contact;
  selected: boolean;
  onSelect: (id: string) => void;
  onEdit: (contact: Contact) => void;
  onArchive: (contact: Contact) => void;
  onRestore: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
  onLogInteraction: (contact: Contact) => void;
}

function ContactCard({
  contact,
  selected,
  onSelect,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onLogInteraction,
}: ContactCardProps) {
  const [showActions, setShowActions] = useState(false);
  const isArchived = contact.archived === 1;

  return (
    <div
      className={`
        relative bg-warm-white rounded-2xl border transition-all duration-200 shadow-soft
        ${selected ? 'border-bethany-500 ring-2 ring-bethany-100' : 'border-cream-dark hover:border-charcoal-300'}
        ${isArchived ? 'opacity-60' : ''}
      `}
    >
      {/* Selection checkbox */}
      <button
        onClick={() => onSelect(contact.id)}
        className="absolute top-4 left-4 z-10"
      >
        {selected ? (
          <CheckSquare className="w-5 h-5 text-bethany-600" />
        ) : (
          <Square className="w-5 h-5 text-charcoal-300 hover:text-charcoal-400" />
        )}
      </button>

      {/* Main content */}
      <div className="p-4 pl-12">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <HealthDot status={contact.health_status} />
              <h3 className="font-semibold text-charcoal truncate">{contact.name}</h3>
              {isArchived && (
                <span className="text-xs text-charcoal-400 bg-cream-dark px-1.5 py-0.5 rounded">
                  Archived
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1">
              <IntentBadge intent={contact.intent} size="sm" />
              {contact.contact_kind === 'kin' && (
                <span className="text-xs text-pink-600 bg-pink-50 px-1.5 py-0.5 rounded-full flex items-center gap-1">
                  <Heart className="w-3 h-3" />
                  Family
                </span>
              )}
            </div>
          </div>

          {/* Actions menu */}
          <div className="relative">
            <button
              onClick={() => setShowActions(!showActions)}
              className="p-1.5 text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-dark rounded-xl transition-colors"
            >
              <MoreHorizontal className="w-5 h-5" />
            </button>

            {showActions && (
              <>
                <div
                  className="fixed inset-0 z-20"
                  onClick={() => setShowActions(false)}
                />
                <div className="absolute right-0 top-full mt-1 z-30 w-48 bg-warm-white rounded-xl shadow-medium border border-cream-dark py-1">
                  <button
                    onClick={() => {
                      onEdit(contact);
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-charcoal hover:bg-cream-dark flex items-center gap-2"
                  >
                    <Pencil className="w-4 h-4" />
                    Edit details
                  </button>
                  <button
                    onClick={() => {
                      onLogInteraction(contact);
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-charcoal hover:bg-cream-dark flex items-center gap-2"
                  >
                    <MessageSquare className="w-4 h-4" />
                    Log interaction
                  </button>
                  <hr className="my-1 border-cream-dark" />
                  {isArchived ? (
                    <button
                      onClick={() => {
                        onRestore(contact);
                        setShowActions(false);
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-blue-600 hover:bg-blue-50 flex items-center gap-2"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Restore
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        onArchive(contact);
                        setShowActions(false);
                      }}
                      className="w-full px-4 py-2 text-left text-sm text-charcoal hover:bg-cream-dark flex items-center gap-2"
                    >
                      <Archive className="w-4 h-4" />
                      Archive
                    </button>
                  )}
                  <button
                    onClick={() => {
                      onDelete(contact);
                      setShowActions(false);
                    }}
                    className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete permanently
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Contact info */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-charcoal-light">
          {contact.phone && (
            <span className="flex items-center gap-1">
              <Phone className="w-3.5 h-3.5" />
              {contact.phone}
            </span>
          )}
          {contact.email && (
            <span className="flex items-center gap-1 truncate max-w-[200px]">
              <Mail className="w-3.5 h-3.5" />
              {contact.email}
            </span>
          )}
        </div>

        {/* Last contact */}
        <div className="mt-3 flex items-center gap-1.5 text-sm">
          <Clock className="w-3.5 h-3.5 text-charcoal-400" />
          <span className="text-charcoal-light">Last contact:</span>
          <span
            className={`font-medium ${
              contact.health_status === 'red'
                ? 'text-red-600'
                : contact.health_status === 'yellow'
                ? 'text-golden-500'
                : 'text-charcoal'
            }`}
          >
            {formatDate(contact.last_contact_date)}
          </span>
        </div>

        {/* Circles */}
        {contact.circles.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {contact.circles.map((circle) => (
              <CircleTag key={circle.id} circle={circle} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Filter Panel Component
// ===========================================================================

interface FilterPanelProps {
  isOpen: boolean;
  onClose: () => void;
  circles: Circle[];
  filters: {
    intent: string;
    health: string;
    circle: string;
    archived: boolean;
  };
  onFiltersChange: (filters: FilterPanelProps['filters']) => void;
  onClearFilters: () => void;
}

function FilterPanel({
  isOpen,
  onClose,
  circles,
  filters,
  onFiltersChange,
  onClearFilters,
}: FilterPanelProps) {
  const hasFilters = filters.intent || filters.health || filters.circle || filters.archived;

  if (!isOpen) return null;

  return (
    <>
      {/* Mobile overlay */}
      <div
        className="fixed inset-0 bg-charcoal/30 z-40 lg:hidden backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`
          fixed inset-y-0 right-0 w-80 bg-warm-white shadow-xl z-50 transform transition-transform duration-300
          lg:static lg:w-72 lg:shadow-none lg:border-l lg:border-cream-dark lg:transform-none
          ${isOpen ? 'translate-x-0' : 'translate-x-full lg:translate-x-0'}
        `}
      >
        <div className="h-full flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-cream-dark">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-5 h-5 text-charcoal-light" />
              <h3 className="font-semibold text-charcoal">Filters</h3>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-charcoal-400 hover:text-charcoal-600 hover:bg-cream-dark rounded-xl lg:hidden"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Filter options */}
          <div className="flex-1 overflow-y-auto p-5 space-y-6">
            {/* Health Status */}
            <div>
              <label className="block text-sm font-medium text-charcoal mb-2">
                Health Status
              </label>
              <div className="space-y-2">
                {HEALTH_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className={`
                      flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors
                      ${filters.health === opt.value ? opt.bg : 'hover:bg-cream-dark'}
                    `}
                  >
                    <input
                      type="radio"
                      name="health"
                      value={opt.value}
                      checked={filters.health === opt.value}
                      onChange={(e) =>
                        onFiltersChange({ ...filters, health: e.target.value })
                      }
                      className="sr-only"
                    />
                    <span className={`w-3 h-3 rounded-full ${opt.dot}`} />
                    <span className="text-sm text-charcoal">{opt.label}</span>
                    {filters.health === opt.value && (
                      <Check className="w-4 h-4 text-charcoal-600 ml-auto" />
                    )}
                  </label>
                ))}
                {filters.health && (
                  <button
                    onClick={() => onFiltersChange({ ...filters, health: '' })}
                    className="text-xs text-charcoal-light hover:text-charcoal mt-1"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* Intent */}
            <div>
              <label className="block text-sm font-medium text-charcoal mb-2">
                Relationship Layer
              </label>
              <select
                value={filters.intent}
                onChange={(e) =>
                  onFiltersChange({ ...filters, intent: e.target.value })
                }
                className="input-field"
              >
                <option value="">All layers</option>
                {INTENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Circle */}
            <div>
              <label className="block text-sm font-medium text-charcoal mb-2">
                Circle
              </label>
              <select
                value={filters.circle}
                onChange={(e) =>
                  onFiltersChange({ ...filters, circle: e.target.value })
                }
                className="input-field"
              >
                <option value="">All circles</option>
                {circles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Show archived */}
            <div>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filters.archived}
                  onChange={(e) =>
                    onFiltersChange({ ...filters, archived: e.target.checked })
                  }
                  className="w-4 h-4 rounded border-charcoal-300 text-bethany-600 focus:ring-bethany-500"
                />
                <span className="text-sm text-charcoal">Show archived contacts</span>
              </label>
            </div>
          </div>

          {/* Footer */}
          {hasFilters && (
            <div className="px-5 py-4 border-t border-cream-dark">
              <button
                onClick={onClearFilters}
                className="w-full px-4 py-2 text-sm font-medium text-charcoal hover:text-charcoal hover:bg-cream-dark rounded-xl transition-colors"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Add/Edit Contact Modal
// ===========================================================================

interface ContactModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: Contact | null;
  circles: Circle[];
  onSave: (data: ContactFormData) => Promise<void>;
  isSaving: boolean;
}

interface ContactFormData {
  name: string;
  phone: string;
  email: string;
  intent: IntentType;
  contact_kind: ContactKind;
  notes: string;
  circle_ids: string[];
}

function ContactModal({
  isOpen,
  onClose,
  contact,
  circles,
  onSave,
  isSaving,
}: ContactModalProps) {
  const isEdit = contact !== null;
  const [form, setForm] = useState<ContactFormData>({
    name: '',
    phone: '',
    email: '',
    intent: 'new',
    contact_kind: 'non_kin',
    notes: '',
    circle_ids: [],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      if (contact) {
        setForm({
          name: contact.name,
          phone: contact.phone ?? '',
          email: contact.email ?? '',
          intent: contact.intent,
          contact_kind: contact.contact_kind,
          notes: contact.notes ?? '',
          circle_ids: contact.circles.map((c) => c.id),
        });
      } else {
        setForm({
          name: '',
          phone: '',
          email: '',
          intent: 'new',
          contact_kind: 'non_kin',
          notes: '',
          circle_ids: [],
        });
      }
      setErrors({});
    }
  }, [isOpen, contact]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    if (!form.name.trim()) {
      newErrors.name = 'Name is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    await onSave(form);
  };

  const toggleCircle = (circleId: string) => {
    setForm((prev) => ({
      ...prev,
      circle_ids: prev.circle_ids.includes(circleId)
        ? prev.circle_ids.filter((id) => id !== circleId)
        : [...prev.circle_ids, circleId],
    }));
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-charcoal/50 z-50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-warm-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-cream-dark">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-bethany-50 rounded-xl flex items-center justify-center">
                {isEdit ? (
                  <Pencil className="w-5 h-5 text-bethany-600" />
                ) : (
                  <UserPlus className="w-5 h-5 text-bethany-600" />
                )}
              </div>
              <div>
                <h2 className="text-lg font-semibold text-charcoal">
                  {isEdit ? 'Edit Contact' : 'Add Contact'}
                </h2>
                <p className="text-sm text-charcoal-light">
                  {isEdit ? 'Update contact details' : 'Add someone to your network'}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-charcoal-400 hover:text-charcoal-600 rounded-xl hover:bg-cream-dark"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
            <div className="px-6 py-5 space-y-5">
              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  Name *
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="John Doe"
                  className={`input-field ${errors.name ? 'border-red-300' : ''}`}
                />
                {errors.name && (
                  <p className="mt-1 text-sm text-red-600">{errors.name}</p>
                )}
              </div>

              {/* Phone & Email */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1.5">
                    Phone
                  </label>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+1 555-555-5555"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-charcoal mb-1.5">
                    Email
                  </label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="john@example.com"
                    className="input-field"
                  />
                </div>
              </div>

              {/* Intent */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  Relationship Layer
                </label>
                <select
                  value={form.intent}
                  onChange={(e) =>
                    setForm({ ...form, intent: e.target.value as IntentType })
                  }
                  className="input-field"
                >
                  {INTENT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Contact Kind */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  Relationship Type
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="contact_kind"
                      value="non_kin"
                      checked={form.contact_kind === 'non_kin'}
                      onChange={() => setForm({ ...form, contact_kind: 'non_kin' })}
                      className="w-4 h-4 text-bethany-600 focus:ring-bethany-500"
                    />
                    <span className="text-sm text-charcoal">Friend/Other</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="contact_kind"
                      value="kin"
                      checked={form.contact_kind === 'kin'}
                      onChange={() => setForm({ ...form, contact_kind: 'kin' })}
                      className="w-4 h-4 text-bethany-600 focus:ring-bethany-500"
                    />
                    <span className="text-sm text-charcoal flex items-center gap-1">
                      <Heart className="w-4 h-4 text-pink-500" />
                      Family
                    </span>
                  </label>
                </div>
                <p className="mt-1 text-xs text-charcoal-light">
                  Family members get relaxed health thresholds (research shows family ties resist decay)
                </p>
              </div>

              {/* Circles */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  Circles
                </label>
                <div className="flex flex-wrap gap-2">
                  {circles.map((circle) => (
                    <button
                      key={circle.id}
                      type="button"
                      onClick={() => toggleCircle(circle.id)}
                      className={`
                        px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                        ${
                          form.circle_ids.includes(circle.id)
                            ? 'bg-bethany-100 text-bethany-700 border-2 border-bethany-300'
                            : 'bg-cream-dark text-charcoal-600 border-2 border-transparent hover:bg-cream'
                        }
                      `}
                    >
                      {circle.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  Notes
                </label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Add any notes about this person..."
                  rows={3}
                  className="input-field resize-none"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-dark bg-cream">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-charcoal-light hover:text-charcoal"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="btn-primary"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : isEdit ? (
                  'Save Changes'
                ) : (
                  'Add Contact'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

// ===========================================================================
// Log Interaction Modal
// ===========================================================================

interface LogInteractionModalProps {
  isOpen: boolean;
  onClose: () => void;
  contact: Contact | null;
  onSave: (data: { method: InteractionMethod; date: string; summary: string }) => Promise<void>;
  isSaving: boolean;
}

function LogInteractionModal({
  isOpen,
  onClose,
  contact,
  onSave,
  isSaving,
}: LogInteractionModalProps) {
  const [method, setMethod] = useState<InteractionMethod>('text');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState('');

  useEffect(() => {
    if (isOpen) {
      setMethod('text');
      setDate(new Date().toISOString().slice(0, 10));
      setSummary('');
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave({ method, date, summary });
  };

  if (!isOpen || !contact) return null;

  return (
    <>
      <div className="fixed inset-0 bg-charcoal/50 z-50 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-warm-white rounded-2xl shadow-xl w-full max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-cream-dark">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-sage-50 rounded-xl flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-sage-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-charcoal">Log Interaction</h2>
                <p className="text-sm text-charcoal-light">with {contact.name}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-charcoal-400 hover:text-charcoal-600 rounded-xl hover:bg-cream-dark"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit}>
            <div className="px-6 py-5 space-y-4">
              {/* Method */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  How did you connect?
                </label>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as InteractionMethod)}
                  className="input-field"
                >
                  {METHOD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Date */}
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  When?
                </label>
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
                <label className="block text-sm font-medium text-charcoal mb-1.5">
                  Quick note (optional)
                </label>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="What did you talk about?"
                  rows={3}
                  className="input-field resize-none"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-cream-dark bg-cream rounded-b-2xl">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-charcoal-light hover:text-charcoal"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-sage-600 text-white rounded-xl text-sm font-medium hover:bg-sage-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-soft"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    Log Interaction
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
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
// Bulk Actions Bar
// ===========================================================================

interface BulkActionsBarProps {
  selectedCount: number;
  onClearSelection: () => void;
  onBulkArchive: () => void;
  onBulkChangeIntent: (intent: IntentType) => void;
  onBulkAssignCircle: (circleId: string) => void;
  circles: Circle[];
}

function BulkActionsBar({
  selectedCount,
  onClearSelection,
  onBulkArchive,
  onBulkChangeIntent,
  onBulkAssignCircle,
  circles,
}: BulkActionsBarProps) {
  const [showIntentMenu, setShowIntentMenu] = useState(false);
  const [showCircleMenu, setShowCircleMenu] = useState(false);

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 bg-charcoal text-warm-white rounded-2xl shadow-2xl px-5 py-3 flex items-center gap-4">
      <div className="flex items-center gap-2">
        <span className="bg-bethany-500 text-warm-white text-sm font-bold w-6 h-6 rounded-full flex items-center justify-center">
          {selectedCount}
        </span>
        <span className="text-sm">selected</span>
      </div>

      <div className="w-px h-6 bg-charcoal-700" />

      {/* Change intent */}
      <div className="relative">
        <button
          onClick={() => setShowIntentMenu(!showIntentMenu)}
          className="px-3 py-1.5 text-sm bg-charcoal-800 hover:bg-charcoal-700 rounded-xl flex items-center gap-1.5"
        >
          Change layer
          <ChevronDown className="w-4 h-4" />
        </button>
        {showIntentMenu && (
          <>
            <div className="fixed inset-0" onClick={() => setShowIntentMenu(false)} />
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-warm-white rounded-xl shadow-lg border border-cream-dark py-1">
              {INTENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => {
                    onBulkChangeIntent(opt.value);
                    setShowIntentMenu(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-charcoal hover:bg-cream-dark"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Assign circle */}
      <div className="relative">
        <button
          onClick={() => setShowCircleMenu(!showCircleMenu)}
          className="px-3 py-1.5 text-sm bg-charcoal-800 hover:bg-charcoal-700 rounded-xl flex items-center gap-1.5"
        >
          Add to circle
          <ChevronDown className="w-4 h-4" />
        </button>
        {showCircleMenu && (
          <>
            <div className="fixed inset-0" onClick={() => setShowCircleMenu(false)} />
            <div className="absolute bottom-full left-0 mb-2 w-48 bg-warm-white rounded-xl shadow-lg border border-cream-dark py-1">
              {circles.map((circle) => (
                <button
                  key={circle.id}
                  onClick={() => {
                    onBulkAssignCircle(circle.id);
                    setShowCircleMenu(false);
                  }}
                  className="w-full px-4 py-2 text-left text-sm text-charcoal hover:bg-cream-dark"
                >
                  {circle.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Archive */}
      <button
        onClick={onBulkArchive}
        className="px-3 py-1.5 text-sm bg-charcoal-800 hover:bg-charcoal-700 rounded-xl flex items-center gap-1.5"
      >
        <Archive className="w-4 h-4" />
        Archive
      </button>

      <div className="w-px h-6 bg-charcoal-700" />

      <button
        onClick={onClearSelection}
        className="p-1.5 hover:bg-charcoal-700 rounded-xl"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ===========================================================================
// Empty States
// ===========================================================================

interface EmptyStateProps {
  type: 'no-contacts' | 'no-results';
  onAddContact: () => void;
  onImport: () => void;
  onClearFilters?: () => void;
}

function EmptyState({ type, onAddContact, onImport, onClearFilters }: EmptyStateProps) {
  if (type === 'no-results') {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <div className="w-16 h-16 bg-cream-dark rounded-full flex items-center justify-center mb-4">
          <Search className="w-8 h-8 text-charcoal-400" />
        </div>
        <h3 className="text-lg font-semibold text-charcoal mb-2">No contacts found</h3>
        <p className="text-charcoal-light text-center max-w-md mb-6">
          We couldn't find any contacts matching your current filters. Try adjusting
          your search or clearing the filters.
        </p>
        {onClearFilters && (
          <button
            onClick={onClearFilters}
            className="px-4 py-2 text-sm font-medium text-bethany-600 hover:text-bethany-700 hover:bg-bethany-50 rounded-xl transition-colors"
          >
            Clear all filters
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-20 h-20 bg-bethany-50 rounded-full flex items-center justify-center mb-6">
        <Users className="w-10 h-10 text-bethany-500" />
      </div>
      <h3 className="text-xl font-semibold text-charcoal mb-2">Start building your network</h3>
      <p className="text-charcoal-light text-center max-w-md mb-8">
        Add your first contacts to start maintaining your relationships with Bethany's help.
        She'll remind you when it's time to reach out.
      </p>
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={onAddContact}
          className="btn-primary"
        >
          <UserPlus className="w-4 h-4" />
          Add your first contact
        </button>
        <button
          onClick={onImport}
          className="btn-secondary"
        >
          <FileUp className="w-4 h-4" />
          Import from CSV
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Main ContactsPage Component
// ===========================================================================

export default function ContactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  const [sortField, setSortField] = useState<SortField>(
    (searchParams.get('sort') as SortField) ?? 'name'
  );
  const [sortDir, setSortDir] = useState<SortDirection>(
    (searchParams.get('dir') as SortDirection) ?? 'asc'
  );
  const [filters, setFilters] = useState({
    intent: searchParams.get('intent') ?? '',
    health: searchParams.get('health') ?? '',
    circle: searchParams.get('circle') ?? '',
    archived: searchParams.get('archived') === 'true',
  });
  const [showFilters, setShowFilters] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Modals
  const [showExport, setShowExport] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loggingContact, setLoggingContact] = useState<Contact | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'archive' | 'delete' | 'bulk-archive';
    contact?: Contact;
  } | null>(null);

  // API hooks
  const { data: circles = [], refetch: refetchCircles } = useApi<Circle[]>('/api/circles');

  // Build contacts URL with filters
  const contactsUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (filters.intent) params.set('intent', filters.intent);
    if (filters.health) params.set('health_status', filters.health);
    if (filters.circle) params.set('circle_id', filters.circle);
    if (filters.archived) params.set('archived', 'true');
    params.set('order_by', sortField);
    params.set('order_dir', sortDir);
    params.set('limit', '100');
    return `/api/contacts?${params.toString()}`;
  }, [debouncedSearch, filters, sortField, sortDir]);

  const {
    data: contactsData,
    isLoading,
    error,
    refetch: refetchContacts,
  } = useApi<ContactListResponse>(contactsUrl);

  const contacts = contactsData?.contacts ?? [];

  // Lazy API for mutations
  const { execute: executeApi, isLoading: isMutating } = useLazyApi();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Sync URL with state
  useEffect(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (filters.intent) params.set('intent', filters.intent);
    if (filters.health) params.set('health', filters.health);
    if (filters.circle) params.set('circle', filters.circle);
    if (filters.archived) params.set('archived', 'true');
    if (sortField !== 'name') params.set('sort', sortField);
    if (sortDir !== 'asc') params.set('dir', sortDir);
    setSearchParams(params, { replace: true });
  }, [search, filters, sortField, sortDir, setSearchParams]);

  // Handlers
  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(contacts.map((c) => c.id)));
    }
  };

  const handleClearSelection = () => setSelectedIds(new Set());

  const handleClearFilters = () => {
    setFilters({ intent: '', health: '', circle: '', archived: false });
    setSearch('');
  };

  const handleSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  // Contact CRUD
  const handleSaveContact = async (data: ContactFormData) => {
    const isEdit = editingContact !== null;
    const url = isEdit ? `/api/contacts/${editingContact.id}` : '/api/contacts';
    const method = isEdit ? 'PATCH' : 'POST';

    await executeApi(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setEditingContact(null);
    setShowAddModal(false);
    refetchContacts();
  };

  const handleArchiveContact = async (contact: Contact) => {
    await executeApi(`/api/contacts/${contact.id}/archive`, { method: 'POST' });
    setConfirmAction(null);
    refetchContacts();
  };

  const handleRestoreContact = async (contact: Contact) => {
    await executeApi(`/api/contacts/${contact.id}/restore`, { method: 'POST' });
    refetchContacts();
  };

  const handleDeleteContact = async (contact: Contact) => {
    await executeApi(`/api/contacts/${contact.id}?hard=true`, { method: 'DELETE' });
    setConfirmAction(null);
    refetchContacts();
  };

  const handleLogInteraction = async (data: {
    method: InteractionMethod;
    date: string;
    summary: string;
  }) => {
    if (!loggingContact) return;
    await executeApi('/api/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact_id: loggingContact.id,
        ...data,
      }),
    });
    setLoggingContact(null);
    refetchContacts();
  };

  // Bulk actions
  const handleBulkArchive = async () => {
    const promises = Array.from(selectedIds).map((id) =>
      executeApi(`/api/contacts/${id}/archive`, { method: 'POST' })
    );
    await Promise.all(promises);
    setSelectedIds(new Set());
    setConfirmAction(null);
    refetchContacts();
  };

  const handleBulkChangeIntent = async (intent: IntentType) => {
    const promises = Array.from(selectedIds).map((id) =>
      executeApi(`/api/contacts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent }),
      })
    );
    await Promise.all(promises);
    setSelectedIds(new Set());
    refetchContacts();
  };

  const handleBulkAssignCircle = async (circleId: string) => {
    for (const id of selectedIds) {
      const contact = contacts.find((c) => c.id === id);
      if (!contact) continue;
      const currentCircleIds = contact.circles.map((c) => c.id);
      if (!currentCircleIds.includes(circleId)) {
        await executeApi(`/api/contacts/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ circle_ids: [...currentCircleIds, circleId] }),
        });
      }
    }
    setSelectedIds(new Set());
    refetchContacts();
  };

  const hasFilters = filters.intent || filters.health || filters.circle || filters.archived || search;
  const hasContacts = contacts.length > 0;
  const isEmpty = !isLoading && contacts.length === 0;

  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <div className="bg-warm-white border-b border-cream-dark sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="py-4">
            {/* Title row */}
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="font-display text-2xl font-medium text-charcoal">Contacts</h1>
                <p className="text-sm text-charcoal-light mt-0.5">
                  {contactsData?.total ?? 0} people in your network
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowExport(true)}
                  className="p-2 text-charcoal-light hover:text-charcoal hover:bg-cream-dark rounded-xl"
                  title="Export contacts"
                >
                  <Download className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="btn-primary"
                >
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Add Contact</span>
                </button>
              </div>
            </div>

            {/* Search and filters row */}
            <div className="flex flex-col sm:flex-row gap-3">
              {/* Search */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-charcoal-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search contacts..."
                  className="input-field pl-10 pr-10"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-charcoal-400 hover:text-charcoal-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Sort dropdown */}
              <div className="flex items-center gap-2">
                <select
                  value={sortField}
                  onChange={(e) => handleSort(e.target.value as SortField)}
                  className="input-field !w-auto"
                >
                  {SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      Sort by {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
                  className="p-2.5 border-2 border-cream-dark rounded-xl hover:bg-cream-dark"
                  title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                >
                  {sortDir === 'asc' ? (
                    <ChevronUp className="w-5 h-5 text-charcoal-600" />
                  ) : (
                    <ChevronDown className="w-5 h-5 text-charcoal-600" />
                  )}
                </button>

                {/* Filter toggle */}
                <button
                  onClick={() => setShowFilters(!showFilters)}
                  className={`
                    inline-flex items-center gap-2 px-3 py-2.5 border-2 rounded-xl text-sm font-medium transition-colors
                    ${
                      hasFilters
                        ? 'bg-bethany-50 border-bethany-200 text-bethany-700'
                        : 'bg-warm-white border-cream-dark text-charcoal hover:bg-cream-dark'
                    }
                  `}
                >
                  <Filter className="w-4 h-4" />
                  <span className="hidden sm:inline">Filters</span>
                  {hasFilters && (
                    <span className="w-5 h-5 bg-bethany-600 text-warm-white text-xs rounded-full flex items-center justify-center">
                      {[filters.intent, filters.health, filters.circle, filters.archived]
                        .filter(Boolean).length}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex gap-6">
          {/* Contacts grid */}
          <div className="flex-1 min-w-0">
            {/* Select all row */}
            {hasContacts && (
              <div className="flex items-center justify-between mb-4">
                <button
                  onClick={handleSelectAll}
                  className="flex items-center gap-2 text-sm text-charcoal-light hover:text-charcoal"
                >
                  {selectedIds.size === contacts.length ? (
                    <CheckSquare className="w-5 h-5 text-bethany-600" />
                  ) : selectedIds.size > 0 ? (
                    <Minus className="w-5 h-5 text-bethany-600" />
                  ) : (
                    <Square className="w-5 h-5 text-charcoal-400" />
                  )}
                  {selectedIds.size === contacts.length
                    ? 'Deselect all'
                    : selectedIds.size > 0
                    ? `${selectedIds.size} selected`
                    : 'Select all'}
                </button>
                {hasFilters && (
                  <button
                    onClick={handleClearFilters}
                    className="text-sm text-charcoal-light hover:text-charcoal"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            )}

            {/* Loading state */}
            {isLoading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
              </div>
            )}

            {/* Error state */}
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-red-700">
                {error}
              </div>
            )}

            {/* Empty states */}
            {isEmpty && !hasFilters && (
              <EmptyState
                type="no-contacts"
                onAddContact={() => setShowAddModal(true)}
                onImport={() => {
                  window.location.href = '/import';
                }}
              />
            )}

            {isEmpty && hasFilters && (
              <EmptyState
                type="no-results"
                onAddContact={() => setShowAddModal(true)}
                onImport={() => {}}
                onClearFilters={handleClearFilters}
              />
            )}

            {/* Contacts grid */}
            {hasContacts && (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {contacts.map((contact) => (
                  <ContactCard
                    key={contact.id}
                    contact={contact}
                    selected={selectedIds.has(contact.id)}
                    onSelect={handleToggleSelect}
                    onEdit={(c) => setEditingContact(c)}
                    onArchive={(c) => setConfirmAction({ type: 'archive', contact: c })}
                    onRestore={handleRestoreContact}
                    onDelete={(c) => setConfirmAction({ type: 'delete', contact: c })}
                    onLogInteraction={(c) => setLoggingContact(c)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Filter panel - desktop */}
          <div className="hidden lg:block">
            <FilterPanel
              isOpen={showFilters}
              onClose={() => setShowFilters(false)}
              circles={circles}
              filters={filters}
              onFiltersChange={setFilters}
              onClearFilters={handleClearFilters}
            />
          </div>
        </div>
      </div>

      {/* Mobile filter panel */}
      <div className="lg:hidden">
        <FilterPanel
          isOpen={showFilters}
          onClose={() => setShowFilters(false)}
          circles={circles}
          filters={filters}
          onFiltersChange={setFilters}
          onClearFilters={handleClearFilters}
        />
      </div>

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <BulkActionsBar
          selectedCount={selectedIds.size}
          onClearSelection={handleClearSelection}
          onBulkArchive={() => setConfirmAction({ type: 'bulk-archive' })}
          onBulkChangeIntent={handleBulkChangeIntent}
          onBulkAssignCircle={handleBulkAssignCircle}
          circles={circles}
        />
      )}

      {/* Modals */}
      <ExportModal
        isOpen={showExport}
        onClose={() => setShowExport(false)}
        currentFilters={{
          circle_id: filters.circle,
          intent: filters.intent as IntentType | undefined,
          health_status: filters.health as HealthStatus | undefined,
        }}
      />

      <ContactModal
        isOpen={showAddModal || editingContact !== null}
        onClose={() => {
          setShowAddModal(false);
          setEditingContact(null);
        }}
        contact={editingContact}
        circles={circles}
        onSave={handleSaveContact}
        isSaving={isMutating}
      />

      <LogInteractionModal
        isOpen={loggingContact !== null}
        onClose={() => setLoggingContact(null)}
        contact={loggingContact}
        onSave={handleLogInteraction}
        isSaving={isMutating}
      />

      <ConfirmModal
        isOpen={confirmAction?.type === 'archive'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction?.contact && handleArchiveContact(confirmAction.contact)}
        title="Archive contact?"
        message={`${confirmAction?.contact?.name} will be hidden from your active contacts. You can restore them anytime.`}
        confirmLabel="Archive"
        isLoading={isMutating}
      />

      <ConfirmModal
        isOpen={confirmAction?.type === 'delete'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction?.contact && handleDeleteContact(confirmAction.contact)}
        title="Delete permanently?"
        message={`This will permanently delete ${confirmAction?.contact?.name} and all their interaction history. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="danger"
        isLoading={isMutating}
      />

      <ConfirmModal
        isOpen={confirmAction?.type === 'bulk-archive'}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleBulkArchive}
        title={`Archive ${selectedIds.size} contacts?`}
        message="These contacts will be hidden from your active list. You can restore them anytime."
        confirmLabel="Archive all"
        isLoading={isMutating}
      />
    </div>
  );
}
