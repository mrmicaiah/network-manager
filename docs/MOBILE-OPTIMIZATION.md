# Mobile Optimization Guide

## Overview

The Bethany dashboard is optimized for mobile devices since SMS is the primary interface and users frequently access the dashboard from their phones.

## Responsive Breakpoints

Using Tailwind's default breakpoints:

| Breakpoint | Width | Usage |
|------------|-------|-------|
| Default | 0-639px | Mobile phones (primary) |
| `sm` | 640px+ | Large phones, small tablets |
| `md` | 768px+ | Tablets |
| `lg` | 1024px+ | Desktop |
| `xl` | 1280px+ | Large desktop |

## Mobile-First Design Patterns

### Navigation
- **Desktop**: Fixed sidebar (264px wide)
- **Mobile**: Hamburger menu in header, full-height slide-out panel
- Sidebar closes automatically when navigating to a new page

### Cards
- Full width on mobile with reduced padding (16px vs 24px)
- Stack vertically below `lg` breakpoint

### Modals
- **Mobile**: Slide up from bottom, full width, rounded top corners
- **Desktop**: Centered, max-width 512px
- Support safe area insets for notched devices

### Tab Bars
- Horizontally scrollable with momentum scrolling
- Edge fade indicators show more content available
- Touch-friendly tap targets (44px minimum)

### Bulk Actions
- **Mobile**: Fixed bar spanning full width at bottom
- **Desktop**: Centered floating bar
- Respects safe area insets

## Touch Target Requirements

All interactive elements meet the 44x44px minimum touch target:

- **Buttons**: `min-height: 44px; min-width: 44px`
- **Nav items**: `min-height: 44px`
- **Icon buttons**: `.icon-btn` class provides proper sizing
- **Checkboxes**: Wrapped in labels with adequate padding
- **Form inputs**: `min-height: 48px`

## iOS-Specific Fixes

### Viewport
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no" />
```

### Input Zoom Prevention
All form inputs use `font-size: 16px` to prevent iOS Safari from zooming on focus.

### Safe Areas (Notched Devices)
```css
:root {
  --safe-area-top: env(safe-area-inset-top, 0px);
  --safe-area-bottom: env(safe-area-inset-bottom, 0px);
}
```

Utility classes available:
- `.pb-safe` - padding-bottom with safe area
- `.pt-safe` - padding-top with safe area
- `.mb-safe` - margin-bottom with safe area

### Bounce/Overscroll
Disabled on html element: `overscroll-behavior: none`

### Tap Highlight
Removed: `-webkit-tap-highlight-color: transparent`

### Text Size Adjustment
Prevented: `-webkit-text-size-adjust: 100%`

## Android-Specific Considerations

### Theme Color
Browser chrome color matches app:
```html
<meta name="theme-color" content="#faf8f5" />
```

### Date Inputs
Custom styled to ensure consistent appearance across browsers.

## Performance Optimizations

### Images
- Lazy loading via `loading="lazy"`
- WebP format when available
- Cloudinary for dynamic resizing

### Bundle
- Code splitting by route
- Tree shaking for unused components
- Vite's built-in optimizations

### Fonts
- Google Fonts with `display=swap`
- Only load required weights

## Testing Checklist

### Devices to Test
- [ ] iPhone SE (375px width) - smallest modern iPhone
- [ ] iPhone 14/15 (390px) - common size
- [ ] iPhone 14/15 Pro Max (430px) - largest iPhone
- [ ] Samsung Galaxy S series
- [ ] iPad (768px+)

### Browsers to Test
- [ ] Safari iOS
- [ ] Chrome iOS
- [ ] Chrome Android
- [ ] Samsung Internet

### Test Scenarios
1. **Navigation**
   - [ ] Hamburger menu opens/closes
   - [ ] Menu items navigate correctly
   - [ ] Menu closes after navigation
   
2. **Forms**
   - [ ] Inputs don't cause zoom
   - [ ] Keyboard doesn't cover inputs
   - [ ] Date picker works
   - [ ] Phone input is usable
   
3. **Modals**
   - [ ] Slide up animation works
   - [ ] Can scroll long content
   - [ ] Close button accessible
   - [ ] Outside tap closes modal
   
4. **Lists/Tables**
   - [ ] Horizontal scroll works on tables
   - [ ] Contact cards stack properly
   - [ ] Pagination/load more works
   
5. **Actions**
   - [ ] Bulk selection works
   - [ ] Action bar appears correctly
   - [ ] Swipe gestures (if applicable)

## CSS Utilities

### New Classes Added

```css
/* Hide scrollbar but keep functionality */
.scrollbar-hide

/* Touch target size (44x44px min) */
.touch-target

/* Prevent text selection */
.no-select

/* Safe area utilities */
.pb-safe
.pt-safe
.mb-safe

/* Mobile button stacking */
.btn-stack-mobile

/* Icon button with proper touch target */
.icon-btn

/* Action bar with safe area */
.action-bar

/* Mobile-first modal */
.modal-overlay
.modal-container  
.modal-content

/* Horizontal scrolling tabs */
.tab-bar
```

## Accessibility

- Focus states visible on all interactive elements
- Color contrast meets WCAG 2.1 AA
- Touch targets meet 44px minimum
- Screen reader compatible navigation
- Proper heading hierarchy

## Known Limitations

1. **iOS Safari**: Date inputs may look different than Chrome
2. **Android WebView**: Some older versions may not support `dvh` units
3. **PWA**: Not yet configured (future enhancement)
