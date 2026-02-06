/**
 * Simple SVG donut chart component.
 * No external dependencies — pure SVG.
 */

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function DonutChart({
  segments,
  size = 120,
  strokeWidth = 24,
  className = '',
}: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  // Calculate stroke-dasharray and stroke-dashoffset for each segment
  let currentOffset = 0;
  const paths = segments
    .filter((s) => s.value > 0)
    .map((segment) => {
      const percentage = segment.value / total;
      const dashLength = percentage * circumference;
      const gapLength = circumference - dashLength;
      const offset = currentOffset;

      currentOffset += dashLength;

      return {
        ...segment,
        dashArray: `${dashLength} ${gapLength}`,
        dashOffset: -offset,
      };
    });

  if (total === 0) {
    return (
      <svg width={size} height={size} className={className}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={strokeWidth}
        />
      </svg>
    );
  }

  return (
    <svg width={size} height={size} className={className}>
      {/* Background circle */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="#f3f4f6"
        strokeWidth={strokeWidth}
      />

      {/* Segments */}
      {paths.map((path, i) => (
        <circle
          key={i}
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={path.color}
          strokeWidth={strokeWidth}
          strokeDasharray={path.dashArray}
          strokeDashoffset={path.dashOffset}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
          className="transition-all duration-500"
        />
      ))}
    </svg>
  );
}

/**
 * Donut chart with legend.
 */
export function DonutChartWithLegend({
  segments,
  title,
  size = 100,
  strokeWidth = 20,
}: DonutChartProps & { title?: string }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="flex items-center gap-6">
      <div className="relative">
        <DonutChart segments={segments} size={size} strokeWidth={strokeWidth} />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xl font-semibold text-gray-900">{total}</span>
        </div>
      </div>
      <div className="flex-1">
        {title && (
          <p className="text-sm font-medium text-gray-900 mb-2">{title}</p>
        )}
        <div className="space-y-1">
          {segments.map((segment, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: segment.color }}
                />
                <span className="text-gray-600">{segment.label}</span>
              </div>
              <span className="font-medium text-gray-900">{segment.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
