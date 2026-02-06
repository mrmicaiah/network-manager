/**
 * MethodPicker — Preferred Contact Method Selector
 *
 * A button group for selecting a contact's preferred communication method.
 * Used in:
 *   - Contact detail page (set per-contact preference)
 *   - Quick-edit popover on dartboard dots
 *   - Contact create/edit forms
 *
 * When the contact has a preferred_method set, that method scores higher
 * points in the dartboard scoring system.
 *
 * @see shared/point-config.ts for point values
 * @see docs/dartboard-system-design.md
 */

import {
  Phone,
  MessageSquare,
  Mail,
  Video,
  Users,
  Globe,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

export type InteractionMethod =
  | 'text'
  | 'call'
  | 'email'
  | 'video'
  | 'in_person'
  | 'social'
  | 'other';

interface MethodOption {
  value: InteractionMethod;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

interface MethodPickerProps {
  /** Currently selected method, null means no preference */
  value: InteractionMethod | null;
  /** Callback when selection changes */
  onChange: (method: InteractionMethod | null) => void;
  /** Display mode - inline for forms, compact for popovers */
  variant?: 'inline' | 'compact';
  /** Whether to show "No preference" option */
  showNoPreference?: boolean;
  /** Whether the picker is disabled */
  disabled?: boolean;
  /** Optional label above the picker */
  label?: string;
  /** Optional help text below the picker */
  helpText?: string;
}

// ===========================================================================
// Constants
// ===========================================================================

export const METHOD_OPTIONS: MethodOption[] = [
  { value: 'call', label: 'Phone call', shortLabel: 'Call', icon: Phone },
  { value: 'text', label: 'Text/SMS', shortLabel: 'Text', icon: MessageSquare },
  { value: 'email', label: 'Email', shortLabel: 'Email', icon: Mail },
  { value: 'video', label: 'Video call', shortLabel: 'Video', icon: Video },
  { value: 'in_person', label: 'In person', shortLabel: 'In-Person', icon: Users },
  { value: 'social', label: 'Social media', shortLabel: 'Social', icon: Globe },
];

// ===========================================================================
// Component
// ===========================================================================

export function MethodPicker({
  value,
  onChange,
  variant = 'inline',
  showNoPreference = true,
  disabled = false,
  label,
  helpText,
}: MethodPickerProps) {
  const isCompact = variant === 'compact';

  return (
    <div className={isCompact ? '' : 'space-y-2'}>
      {label && (
        <label className="block text-sm font-medium text-charcoal">
          {label}
        </label>
      )}

      <div
        className={`
          flex flex-wrap gap-2
          ${isCompact ? 'gap-1' : ''}
        `}
      >
        {/* No preference option */}
        {showNoPreference && (
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className={`
              flex items-center gap-1.5 rounded-xl transition-all
              ${isCompact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'}
              ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
              ${
                value === null
                  ? 'bg-bethany-100 text-bethany-700 ring-2 ring-bethany-300'
                  : 'bg-cream-dark text-charcoal-light hover:bg-cream hover:text-charcoal'
              }
            `}
            title="No preference - all methods score equally"
          >
            <HelpCircle className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
            <span className={isCompact ? 'hidden sm:inline' : ''}>
              {isCompact ? 'None' : 'No preference'}
            </span>
          </button>
        )}

        {/* Method options */}
        {METHOD_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isSelected = value === option.value;

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              disabled={disabled}
              className={`
                flex items-center gap-1.5 rounded-xl transition-all
                ${isCompact ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm'}
                ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
                ${
                  isSelected
                    ? 'bg-bethany-100 text-bethany-700 ring-2 ring-bethany-300'
                    : 'bg-cream-dark text-charcoal-light hover:bg-cream hover:text-charcoal'
                }
              `}
              title={option.label}
            >
              <Icon className={isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
              <span className={isCompact ? 'hidden sm:inline' : ''}>
                {isCompact ? option.shortLabel : option.label}
              </span>
            </button>
          );
        })}
      </div>

      {helpText && (
        <p className="text-xs text-charcoal-light">
          {helpText}
        </p>
      )}
    </div>
  );
}

// ===========================================================================
// Dropdown Variant (for forms with less space)
// ===========================================================================

interface MethodSelectProps {
  value: InteractionMethod | null;
  onChange: (method: InteractionMethod | null) => void;
  disabled?: boolean;
  label?: string;
  helpText?: string;
}

export function MethodSelect({
  value,
  onChange,
  disabled = false,
  label,
  helpText,
}: MethodSelectProps) {
  return (
    <div className="space-y-1">
      {label && (
        <label className="block text-sm font-medium text-charcoal">
          {label}
        </label>
      )}

      <div className="relative">
        <select
          value={value ?? ''}
          onChange={(e) => {
            const val = e.target.value;
            onChange(val ? (val as InteractionMethod) : null);
          }}
          disabled={disabled}
          className="input-field pr-10 appearance-none"
        >
          <option value="">No preference</option>
          {METHOD_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {/* Custom dropdown arrow */}
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
          <svg
            className="w-4 h-4 text-charcoal-light"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </div>
      </div>

      {helpText && (
        <p className="text-xs text-charcoal-light">
          {helpText}
        </p>
      )}
    </div>
  );
}

// ===========================================================================
// Helper for displaying the current method
// ===========================================================================

interface MethodBadgeProps {
  method: InteractionMethod | null;
  size?: 'sm' | 'md';
}

export function MethodBadge({ method, size = 'md' }: MethodBadgeProps) {
  if (!method) {
    return null;
  }

  const option = METHOD_OPTIONS.find((o) => o.value === method);
  if (!option) return null;

  const Icon = option.icon;
  const sizeClass = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm';

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full
        bg-bethany-50 text-bethany-600
        ${sizeClass}
      `}
    >
      <Icon className={size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'} />
      {option.shortLabel}
    </span>
  );
}

export default MethodPicker;
