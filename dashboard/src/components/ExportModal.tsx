import { useState, useEffect, useCallback, useRef } from 'react';
import { useApi } from '../hooks/useApi';
import { X, Download, Check, Loader2 } from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

type IntentType = 'inner_circle' | 'nurture' | 'maintain' | 'transactional' | 'dormant' | 'new';
type HealthStatus = 'green' | 'yellow' | 'red';

interface Circle {
  id: string;
  name: string;
}

interface ExportFilters {
  circle_id?: string;
  intent?: IntentType;
  health_status?: HealthStatus;
}

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Pre-fill filters from the current page state */
  currentFilters?: ExportFilters;
}

// ===========================================================================
// Constants
// ===========================================================================

const INTENT_OPTIONS: Array<{ value: IntentType; label: string }> = [
  { value: 'inner_circle', label: 'Inner Circle' },
  { value: 'nurture', label: 'Nurture' },
  { value: 'maintain', label: 'Maintain' },
  { value: 'transactional', label: 'Transactional' },
  { value: 'dormant', label: 'Dormant' },
  { value: 'new', label: 'New' },
];

const HEALTH_OPTIONS: Array<{ value: HealthStatus; label: string; dot: string }> = [
  { value: 'green', label: 'Healthy', dot: 'bg-green-500' },
  { value: 'yellow', label: 'Needs attention', dot: 'bg-yellow-500' },
  { value: 'red', label: 'Overdue', dot: 'bg-red-500' },
];

// ===========================================================================
// Component
// ===========================================================================

/**
 * Export Modal — lets users choose filters before downloading a CSV.
 *
 * Flow:
 *   1. Opens with optional pre-filled filters from the contacts page
 *   2. User can adjust circle, intent, health filters or choose "All"
 *   3. Click "Export" triggers a fetch to /api/export with credentials
 *   4. Response is a CSV blob — downloaded as a file
 *   5. Shows success state briefly, then closes
 */
export function ExportModal({ isOpen, onClose, currentFilters }: ExportModalProps) {
  // Filter state
  const [circleId, setCircleId] = useState<string>('');
  const [intent, setIntent] = useState<string>('');
  const [healthStatus, setHealthStatus] = useState<string>('');

  // Export state
  const [isExporting, setIsExporting] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Fetch circles for the dropdown
  const { data: circles } = useApi<Circle[]>('/api/circles');

  // Ref for focus trap
  const modalRef = useRef<HTMLDivElement>(null);

  // Pre-fill filters when modal opens
  useEffect(() => {
    if (isOpen) {
      setCircleId(currentFilters?.circle_id ?? '');
      setIntent(currentFilters?.intent ?? '');
      setHealthStatus(currentFilters?.health_status ?? '');
      setExportDone(false);
      setExportError(null);
    }
  }, [isOpen, currentFilters]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Focus trap — focus modal on open
  useEffect(() => {
    if (isOpen && modalRef.current) {
      modalRef.current.focus();
    }
  }, [isOpen]);

  const hasFilters = circleId || intent || healthStatus;

  // Build filter description for display
  const filterDescription = useCallback(() => {
    const parts: string[] = [];
    if (circleId && circles) {
      const circle = circles.find((c) => c.id === circleId);
      if (circle) parts.push(circle.name);
    }
    if (intent) {
      const opt = INTENT_OPTIONS.find((o) => o.value === intent);
      if (opt) parts.push(opt.label);
    }
    if (healthStatus) {
      const opt = HEALTH_OPTIONS.find((o) => o.value === healthStatus);
      if (opt) parts.push(opt.label);
    }
    return parts.length > 0 ? parts.join(' · ') : 'All contacts';
  }, [circleId, intent, healthStatus, circles]);

  // Export handler — fetches CSV and triggers download
  const handleExport = async () => {
    setIsExporting(true);
    setExportError(null);

    try {
      const params = new URLSearchParams();
      if (circleId) params.set('circle_id', circleId);
      if (intent) params.set('intent', intent);
      if (healthStatus) params.set('health_status', healthStatus);

      const response = await fetch(`/api/export?${params.toString()}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Export failed: ${response.status}`);
      }

      // Get the CSV content
      const blob = await response.blob();

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bethany-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);

      // Show success
      setExportDone(true);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setIsExporting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          ref={modalRef}
          tabIndex={-1}
          className="bg-white rounded-xl shadow-xl w-full max-w-md outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-bethany-50 rounded-lg flex items-center justify-center">
                <Download className="w-5 h-5 text-bethany-600" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-gray-900">Export Contacts</h2>
                <p className="text-sm text-gray-500">Download as CSV</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-6 py-5 space-y-4">
            {/* Circle filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Circle
              </label>
              <select
                value={circleId}
                onChange={(e) => setCircleId(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
              >
                <option value="">All circles</option>
                {(circles ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Intent filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Relationship Layer
              </label>
              <select
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
              >
                <option value="">All layers</option>
                {INTENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Health status filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">
                Health Status
              </label>
              <select
                value={healthStatus}
                onChange={(e) => setHealthStatus(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm text-gray-700 bg-white focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
              >
                <option value="">All statuses</option>
                {HEALTH_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Filter summary */}
            <div className="bg-gray-50 rounded-lg px-4 py-3">
              <p className="text-sm text-gray-600">
                Exporting: <span className="font-medium text-gray-900">{filterDescription()}</span>
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Columns: name, phone, email, circles, layer, last contact, notes
              </p>
            </div>

            {/* Error */}
            {exportError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                <p className="text-sm text-red-700">{exportError}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200 bg-gray-50 rounded-b-xl">
            {hasFilters ? (
              <button
                onClick={() => {
                  setCircleId('');
                  setIntent('');
                  setHealthStatus('');
                }}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                Clear filters
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:text-gray-900"
              >
                Cancel
              </button>

              {exportDone ? (
                <div className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium">
                  <Check className="w-4 h-4" />
                  Downloaded
                </div>
              ) : (
                <button
                  onClick={handleExport}
                  disabled={isExporting}
                  className="inline-flex items-center gap-2 px-5 py-2.5 bg-bethany-600 text-white rounded-lg text-sm font-medium hover:bg-bethany-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isExporting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Exporting...
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      Export CSV
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
