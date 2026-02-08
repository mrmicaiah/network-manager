import { useState, useRef, useEffect, ReactNode } from 'react';
import { createPortal } from 'react-dom';

// ===========================================================================
// Types
// ===========================================================================

export interface TooltipProps {
  /** The content to display in the tooltip */
  content: ReactNode;
  /** The element that triggers the tooltip */
  children: ReactNode;
  /** Position of the tooltip relative to the trigger */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /** Delay before showing tooltip (ms) */
  delay?: number;
  /** Additional CSS classes for the tooltip container */
  className?: string;
  /** Whether the tooltip is disabled */
  disabled?: boolean;
}

// ===========================================================================
// Component
// ===========================================================================

/**
 * Tooltip - Hover tooltip component
 * 
 * Shows content in a floating tooltip when hovering over the trigger element.
 * Uses a portal to render outside the normal DOM hierarchy, avoiding
 * overflow issues.
 * 
 * @example
 * <Tooltip content="This is a tooltip">
 *   <button>Hover me</button>
 * </Tooltip>
 * 
 * @example
 * <Tooltip 
 *   content={<div>Rich content</div>}
 *   position="bottom"
 *   delay={200}
 * >
 *   <span>Trigger</span>
 * </Tooltip>
 */
export function Tooltip({
  content,
  children,
  position = 'top',
  delay = 100,
  className = '',
  disabled = false,
}: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Calculate position when showing
  useEffect(() => {
    if (isVisible && triggerRef.current && tooltipRef.current) {
      const triggerRect = triggerRef.current.getBoundingClientRect();
      const tooltipRect = tooltipRef.current.getBoundingClientRect();
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      let x = 0;
      let y = 0;

      switch (position) {
        case 'top':
          x = triggerRect.left + scrollX + (triggerRect.width - tooltipRect.width) / 2;
          y = triggerRect.top + scrollY - tooltipRect.height - 8;
          break;
        case 'bottom':
          x = triggerRect.left + scrollX + (triggerRect.width - tooltipRect.width) / 2;
          y = triggerRect.bottom + scrollY + 8;
          break;
        case 'left':
          x = triggerRect.left + scrollX - tooltipRect.width - 8;
          y = triggerRect.top + scrollY + (triggerRect.height - tooltipRect.height) / 2;
          break;
        case 'right':
          x = triggerRect.right + scrollX + 8;
          y = triggerRect.top + scrollY + (triggerRect.height - tooltipRect.height) / 2;
          break;
      }

      // Keep tooltip within viewport
      const padding = 8;
      x = Math.max(padding, Math.min(x, window.innerWidth - tooltipRect.width - padding));
      y = Math.max(padding, Math.min(y, window.innerHeight - tooltipRect.height - padding));

      setCoords({ x, y });
    }
  }, [isVisible, position]);

  const handleMouseEnter = () => {
    if (disabled) return;
    
    timeoutRef.current = setTimeout(() => {
      setIsVisible(true);
    }, delay);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      <div
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className="inline-block"
      >
        {children}
      </div>

      {isVisible &&
        createPortal(
          <div
            ref={tooltipRef}
            className={`
              fixed z-[100] px-3 py-2 
              bg-charcoal text-warm-white text-sm
              rounded-xl shadow-medium
              animate-fade-in
              pointer-events-none
              ${className}
            `}
            style={{
              left: coords.x,
              top: coords.y,
            }}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}

// ===========================================================================
// Simple Tooltip - For text-only tooltips
// ===========================================================================

export interface SimpleTooltipProps {
  /** Text to display */
  text: string;
  /** The element that triggers the tooltip */
  children: ReactNode;
  /** Position of the tooltip */
  position?: 'top' | 'bottom' | 'left' | 'right';
}

/**
 * SimpleTooltip - Text-only tooltip with simpler API
 * 
 * @example
 * <SimpleTooltip text="Delete this item">
 *   <button><TrashIcon /></button>
 * </SimpleTooltip>
 */
export function SimpleTooltip({ text, children, position = 'top' }: SimpleTooltipProps) {
  return (
    <Tooltip content={text} position={position}>
      {children}
    </Tooltip>
  );
}
