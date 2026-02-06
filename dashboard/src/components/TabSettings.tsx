/**
 * TabSettings — Circle Tab Order & Default Tab Configuration
 *
 * Allows users to:
 *   - Drag-to-reorder circle tabs in the dashboard
 *   - Set which tab loads first (default tab)
 *
 * Uses PATCH /api/user/preferences to save changes.
 *
 * @see docs/dartboard-system-design.md
 */

import { useState, useCallback, useEffect } from 'react';
import {
  GripVertical,
  Star,
  Check,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { useLazyApi } from '../hooks/useApi';

// ===========================================================================
// Types
// ===========================================================================

interface Circle {
  id: string;
  name: string;
  type: 'default' | 'custom';
  contact_count?: number;
}

interface TabSettingsProps {
  /** List of user's circles */
  circles: Circle[];
  /** Current default tab ID (null = first tab) */
  defaultTabId: string | null;
  /** Current tab order (null = use default sort_order) */
  tabOrder: string[] | null;
  /** Callback when settings are saved successfully */
  onSave?: () => void;
}

// ===========================================================================
// Component
// ===========================================================================

export function TabSettings({
  circles,
  defaultTabId,
  tabOrder,
  onSave,
}: TabSettingsProps) {
  // Local state for drag-and-drop
  const [orderedCircles, setOrderedCircles] = useState<Circle[]>([]);
  const [selectedDefaultId, setSelectedDefaultId] = useState<string | null>(defaultTabId);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  // API state
  const { execute: savePreferences, isLoading: isSaving } = useLazyApi();
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [hasChanges, setHasChanges] = useState(false);

  // Initialize ordered circles from props
  useEffect(() => {
    if (tabOrder && tabOrder.length > 0) {
      // Sort circles by tabOrder
      const ordered = [...circles].sort((a, b) => {
        const aIndex = tabOrder.indexOf(a.id);
        const bIndex = tabOrder.indexOf(b.id);
        // Put circles not in tabOrder at the end
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      });
      setOrderedCircles(ordered);
    } else {
      // Use default sort order from circles
      setOrderedCircles([...circles]);
    }
  }, [circles, tabOrder]);

  // Sync selectedDefaultId when prop changes
  useEffect(() => {
    setSelectedDefaultId(defaultTabId);
  }, [defaultTabId]);

  // Check for changes
  useEffect(() => {
    const currentOrder = orderedCircles.map((c) => c.id);
    const originalOrder = tabOrder ?? circles.map((c) => c.id);
    
    const orderChanged = JSON.stringify(currentOrder) !== JSON.stringify(originalOrder);
    const defaultChanged = selectedDefaultId !== defaultTabId;
    
    setHasChanges(orderChanged || defaultChanged);
  }, [orderedCircles, selectedDefaultId, tabOrder, defaultTabId, circles]);

  // Drag handlers
  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (draggedIndex !== null && dragOverIndex !== null && draggedIndex !== dragOverIndex) {
      const newOrder = [...orderedCircles];
      const [dragged] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(dragOverIndex, 0, dragged);
      setOrderedCircles(newOrder);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, dragOverIndex, orderedCircles]);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  // Move item up/down with buttons (for accessibility)
  const moveItem = useCallback((index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= orderedCircles.length) return;

    const newOrder = [...orderedCircles];
    const [item] = newOrder.splice(index, 1);
    newOrder.splice(newIndex, 0, item);
    setOrderedCircles(newOrder);
  }, [orderedCircles]);

  // Set default tab
  const handleSetDefault = useCallback((circleId: string) => {
    setSelectedDefaultId(circleId === selectedDefaultId ? null : circleId);
  }, [selectedDefaultId]);

  // Save changes
  const handleSave = useCallback(async () => {
    setMessage(null);

    try {
      await savePreferences('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultCircleId: selectedDefaultId,
          circleTabOrder: orderedCircles.map((c) => c.id),
        }),
      });

      setMessage({ type: 'success', text: 'Tab settings saved' });
      setHasChanges(false);
      onSave?.();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save settings',
      });
    }
  }, [savePreferences, selectedDefaultId, orderedCircles, onSave]);

  // Reset to original order
  const handleReset = useCallback(() => {
    if (tabOrder && tabOrder.length > 0) {
      const ordered = [...circles].sort((a, b) => {
        const aIndex = tabOrder.indexOf(a.id);
        const bIndex = tabOrder.indexOf(b.id);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      });
      setOrderedCircles(ordered);
    } else {
      setOrderedCircles([...circles]);
    }
    setSelectedDefaultId(defaultTabId);
    setMessage(null);
  }, [circles, tabOrder, defaultTabId]);

  if (orderedCircles.length === 0) {
    return (
      <div className="text-center py-6 text-charcoal-light">
        No circles to configure
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-charcoal mb-1">
          Dashboard Tab Order
        </h4>
        <p className="text-xs text-charcoal-light mb-3">
          Drag to reorder. Star to set which tab loads first.
        </p>

        <div className="space-y-2">
          {orderedCircles.map((circle, index) => {
            const isDefault = selectedDefaultId === circle.id;
            const isDragging = draggedIndex === index;
            const isDragOver = dragOverIndex === index;

            return (
              <div
                key={circle.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragEnd={handleDragEnd}
                onDragLeave={handleDragLeave}
                className={`
                  flex items-center gap-3 p-3 rounded-xl transition-all cursor-grab active:cursor-grabbing
                  ${isDragging ? 'opacity-50 bg-cream-dark' : 'bg-cream hover:bg-cream-dark'}
                  ${isDragOver ? 'ring-2 ring-bethany-300' : ''}
                `}
              >
                {/* Drag handle */}
                <GripVertical className="w-4 h-4 text-charcoal-300 flex-shrink-0" />

                {/* Circle info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-charcoal truncate">
                      {circle.name}
                    </span>
                    {isDefault && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-golden-100 text-golden-600">
                        Default
                      </span>
                    )}
                  </div>
                  {circle.contact_count !== undefined && (
                    <span className="text-xs text-charcoal-light">
                      {circle.contact_count} contact{circle.contact_count !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Set as default button */}
                <button
                  type="button"
                  onClick={() => handleSetDefault(circle.id)}
                  className={`
                    p-2 rounded-lg transition-colors
                    ${isDefault
                      ? 'text-golden-500 bg-golden-50'
                      : 'text-charcoal-300 hover:text-golden-400 hover:bg-golden-50'
                    }
                  `}
                  title={isDefault ? 'Remove as default' : 'Set as default tab'}
                >
                  <Star
                    className="w-4 h-4"
                    fill={isDefault ? 'currentColor' : 'none'}
                  />
                </button>

                {/* Move up/down buttons (for accessibility) */}
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => moveItem(index, 'up')}
                    disabled={index === 0}
                    className="p-1 text-charcoal-300 hover:text-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move up"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveItem(index, 'down')}
                    disabled={index === orderedCircles.length - 1}
                    className="p-1 text-charcoal-300 hover:text-charcoal disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move down"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Status message */}
      {message && (
        <div
          className={`p-3 rounded-xl text-sm flex items-center gap-2 ${
            message.type === 'success'
              ? 'bg-sage-50 text-sage-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {message.type === 'success' ? (
            <Check className="w-4 h-4" />
          ) : (
            <AlertCircle className="w-4 h-4" />
          )}
          {message.text}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={handleReset}
          disabled={!hasChanges || isSaving}
          className="text-sm text-charcoal-light hover:text-charcoal disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Reset
        </button>

        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="btn-primary"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            'Save tab order'
          )}
        </button>
      </div>
    </div>
  );
}

export default TabSettings;
