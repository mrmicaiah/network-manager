import { Tooltip } from './Tooltip';

// ===========================================================================
// Types
// ===========================================================================

export interface CircleSummaryData {
  thriving: number;
  healthy: number;
  slipping: number;
  drifting: number;
}

export interface CircleSummaryProps extends CircleSummaryData {
  /** Display mode */
  variant?: 'inline' | 'compact' | 'tooltip' | 'detailed';
  /** Show labels alongside counts */
  showLabels?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Show zero counts (default: false for inline/compact, true for detailed) */
  showZeros?: boolean;
}

// ===========================================================================
// Constants
// ===========================================================================

const STATUS_CONFIG = {
  thriving: {
    color: 'bg-sage-500',
    textColor: 'text-sage-600',
    bgLight: 'bg-sage-50',
    label: 'Thriving',
    shortLabel: '✓',
  },
  healthy: {
    color: 'bg-bethany-500',
    textColor: 'text-bethany-600',
    bgLight: 'bg-bethany-50',
    label: 'Healthy',
    shortLabel: '○',
  },
  slipping: {
    color: 'bg-golden-400',
    textColor: 'text-golden-600',
    bgLight: 'bg-golden-50',
    label: 'Slipping',
    shortLabel: '!',
  },
  drifting: {
    color: 'bg-red-500',
    textColor: 'text-red-600',
    bgLight: 'bg-red-50',
    label: 'Drifting',
    shortLabel: '!!',
  },
} as const;

type StatusKey = keyof typeof STATUS_CONFIG;

// ===========================================================================
// Component
// ===========================================================================

/**
 * CircleSummary - Compact health distribution display
 * 
 * Shows the breakdown of contact health statuses in a circle.
 * Multiple variants for different use cases:
 * 
 * - inline: 🟢 12  🟡 8  🔴 3 (used in dartboard headers, tab bars)
 * - compact: Just dots and numbers, very small
 * - tooltip: For hover states, includes labels
 * - detailed: Full breakdown with labels and percentages
 * 
 * @example
 * // In dartboard header
 * <CircleSummary thriving={12} healthy={8} slipping={5} drifting={3} />
 * 
 * // In tab tooltip
 * <CircleSummary {...summary} variant="tooltip" />
 * 
 * // Detailed view
 * <CircleSummary {...summary} variant="detailed" showLabels />
 */
export function CircleSummary({
  thriving,
  healthy,
  slipping,
  drifting,
  variant = 'inline',
  showLabels = false,
  showZeros,
  className = '',
}: CircleSummaryProps) {
  const total = thriving + healthy + slipping + drifting;
  const shouldShowZeros = showZeros ?? (variant === 'detailed');
  
  // Build the status items to display
  const items: Array<{ key: StatusKey; count: number }> = [
    { key: 'thriving', count: thriving },
    { key: 'healthy', count: healthy },
    { key: 'slipping', count: slipping },
    { key: 'drifting', count: drifting },
  ].filter(item => shouldShowZeros || item.count > 0);

  if (total === 0 && !shouldShowZeros) {
    return (
      <span className={`text-sm text-charcoal-400 ${className}`}>
        No contacts
      </span>
    );
  }

  // Render based on variant
  switch (variant) {
    case 'compact':
      return (
        <div className={`inline-flex items-center gap-1.5 ${className}`}>
          {items.map(({ key, count }) => (
            <span key={key} className="inline-flex items-center gap-0.5">
              <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[key].color}`} />
              <span className="text-xs text-charcoal-light">{count}</span>
            </span>
          ))}
        </div>
      );

    case 'tooltip':
      return (
        <div className={`space-y-1.5 ${className}`}>
          <div className="text-xs font-medium text-charcoal mb-2">
            {total} contact{total !== 1 ? 's' : ''}
          </div>
          {items.map(({ key, count }) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${STATUS_CONFIG[key].color}`} />
                <span className="text-xs text-charcoal-light">{STATUS_CONFIG[key].label}</span>
              </span>
              <span className="text-xs font-medium text-charcoal">{count}</span>
            </div>
          ))}
        </div>
      );

    case 'detailed':
      return (
        <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 ${className}`}>
          {items.map(({ key, count }) => {
            const config = STATUS_CONFIG[key];
            const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
            
            return (
              <div
                key={key}
                className={`rounded-xl p-3 ${config.bgLight}`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className={`w-2 h-2 rounded-full ${config.color}`} />
                  <span className={`text-xs font-medium ${config.textColor}`}>
                    {showLabels ? config.label : ''}
                  </span>
                </div>
                <div className={`text-xl font-semibold ${config.textColor}`}>
                  {count}
                </div>
                {total > 0 && (
                  <div className="text-xs text-charcoal-400">
                    {percentage}%
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );

    case 'inline':
    default:
      return (
        <div className={`inline-flex items-center gap-2 text-sm text-charcoal-light ${className}`}>
          {items.map(({ key, count }) => (
            <span key={key} className="inline-flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${STATUS_CONFIG[key].color}`} />
              <span>{count}</span>
            </span>
          ))}
        </div>
      );
  }
}

// ===========================================================================
// CircleSummaryBadge - Self-contained badge with optional tooltip
// ===========================================================================

export interface CircleSummaryBadgeProps extends CircleSummaryData {
  /** Circle name for the tooltip */
  circleName?: string;
  /** Show tooltip on hover */
  showTooltip?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * CircleSummaryBadge - Compact badge with hover tooltip
 * 
 * Use this in tab bars or list items where space is tight but you want
 * to show details on hover.
 * 
 * @example
 * <CircleSummaryBadge 
 *   circleName="Family"
 *   thriving={5}
 *   healthy={3}
 *   slipping={2}
 *   drifting={1}
 *   showTooltip
 * />
 */
export function CircleSummaryBadge({
  circleName,
  showTooltip = true,
  className = '',
  ...summaryData
}: CircleSummaryBadgeProps) {
  const badge = (
    <CircleSummary {...summaryData} variant="compact" className={className} />
  );

  if (!showTooltip) {
    return badge;
  }

  return (
    <Tooltip
      content={
        <div className="p-2">
          {circleName && (
            <div className="font-medium text-charcoal text-sm mb-2">{circleName}</div>
          )}
          <CircleSummary {...summaryData} variant="tooltip" />
        </div>
      }
    >
      {badge}
    </Tooltip>
  );
}

// ===========================================================================
// Helper: Calculate summary from contacts array
// ===========================================================================

type ContactWithStatus = { status: 'thriving' | 'healthy' | 'slipping' | 'drifting' };

/**
 * Calculate CircleSummaryData from an array of contacts
 * 
 * @example
 * const summary = calculateCircleSummary(contacts);
 * <CircleSummary {...summary} />
 */
export function calculateCircleSummary(contacts: ContactWithStatus[]): CircleSummaryData {
  return contacts.reduce(
    (acc, contact) => {
      acc[contact.status]++;
      return acc;
    },
    { thriving: 0, healthy: 0, slipping: 0, drifting: 0 }
  );
}
