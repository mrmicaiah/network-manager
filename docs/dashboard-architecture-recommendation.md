# Dashboard Architecture Recommendation

## Executive Summary

**Recommendation: Deploy React dashboard separately on Cloudflare Pages at `app.bethany.untitledpublishers.com`**

The React dashboard is already built with complex interactive features that would require significant vanilla JS rewrites in Eleventy. The separation of concerns (marketing site vs. app) is a clean architectural pattern, and Cloudflare Pages deployment is straightforward with the existing Vite build.

---

## Analysis

### What Already Exists

**React Dashboard (network-manager/dashboard):**
- Full authentication flow with AuthContext (PIN-based SMS verification)
- Protected route pattern with session persistence
- 5 complete pages: Overview, Contacts, Braindump, Import, Settings
- Complex components: drag-drop file upload, CSV parsing, preview tables
- Claude API integration for Braindump parsing (async operations with loading states)
- Tailwind CSS styling (different color system from Eleventy site)
- Vite build, ready for production

**Eleventy Site (network-manager-site):**
- Marketing pages: home, signup, terms, privacy
- Cohesive design language (terracotta, sage, warm-white, custom fonts)
- Signup form that POSTs to the Worker API
- Currently shows success modal, sends user home

### Why React Wins

| Criterion | React Dashboard | Eleventy Rebuild |
|-----------|-----------------|------------------|
| **Time to deploy** | Hours (already built) | Weeks (rewrite 5 pages) |
| **Braindump page** | Built with async state management | Needs complex vanilla JS |
| **Import page** | Drag-drop, file parsing, preview table | Significant vanilla JS complexity |
| **Contacts page** | Interactive list, inline editing, filters | Possible but verbose |
| **Auth flow** | React context, protected routes | Custom vanilla JS auth wrapper |
| **Maintainability** | Component-based, typed | Script tags, harder to test |

### Page-by-Page Feasibility if Eleventy

| Page | Eleventy Feasibility | Notes |
|------|---------------------|-------|
| **Login** | ✅ Simple | Form submit, redirect on success |
| **Overview** | ✅ Moderate | Stats cards, could be static-ish |
| **Contacts** | ⚠️ Complex | List with search, filters, inline edit, pagination |
| **Settings** | ✅ Simple | Form fields, save button |
| **Import** | ❌ Very Complex | Drag-drop, file read, CSV parse, preview table, row removal |
| **Braindump** | ❌ Very Complex | Textarea → Claude API → parsed results → confirm/dismiss cards → save |

The Import and Braindump pages alone would require 500+ lines of vanilla JS each to replicate the React functionality. This isn't impossible, but it's a significant investment for marginal benefit.

### Design System Considerations

The Eleventy site uses:
- Colors: `terracotta`, `sage`, `warm-white`, `charcoal`
- Font: Display font for headings
- Cards: `rounded-3xl`, soft shadows

The React dashboard uses:
- Colors: `bethany-500` (a purple/violet), standard grays
- Font: System sans-serif
- Cards: `rounded-xl`, standard shadows

**If keeping React:** The dashboard should be restyled to match the Eleventy site's warm aesthetic. This is a styling task, not a rebuild — update the Tailwind config and component classes.

---

## Recommendation: React on Cloudflare Pages

### URL Structure

**Recommended:** `app.bethany.untitledpublishers.com`

| Option | URL | Pros | Cons |
|--------|-----|------|------|
| Subdomain | `app.bethany.untitledpublishers.com` | Clean separation, clear mental model, easy CORS setup | Extra DNS record |
| Path (app) | `bethany.untitledpublishers.com/app` | Single domain | Routing complexity, can't use different build |
| Path (dashboard) | `bethany.untitledpublishers.com/dashboard` | Single domain | Same routing issues |

**Subdomain is cleanest.** Users understand "go to app.bethany..." and it keeps the marketing site simple.

### Deployment Strategy

**Cloudflare Pages** is the natural fit since the API is already on Cloudflare Workers.

**Setup steps:**
1. Create Cloudflare Pages project linked to `mrmicaiah/network-manager`
2. Configure build:
   - Root directory: `dashboard`
   - Build command: `npm run build`
   - Output directory: `dist`
3. Add custom domain: `app.bethany.untitledpublishers.com`
4. Configure environment variable for API URL (or proxy through Pages Functions)

**API URL handling:**

Option A: Direct API calls
- Dashboard calls `https://network-manager.micaiah-tasks.workers.dev/api/*`
- Requires CORS headers on the Worker (already there or easy to add)
- Simpler setup

Option B: Pages Functions proxy
- Dashboard calls `/api/*` (same origin)
- Pages Functions forward to Worker
- No CORS needed, cleaner URLs
- Slightly more complex setup

**Recommendation:** Start with Option A (direct calls). Add proxy later if CORS becomes annoying.

### Signup Flow Redirect

Currently, the Eleventy signup page shows a success modal and sends users home. 

**Updated flow:**
1. User completes signup on `bethany.untitledpublishers.com/signup`
2. API creates user, sends welcome SMS
3. Instead of modal → home, redirect to: `app.bethany.untitledpublishers.com/login?welcome=true`
4. Login page detects `welcome=true` query param, shows personalized message
5. User enters phone + PIN (they just created), logs in
6. Lands on Overview page, onboarding continues via SMS

**Code change needed:**
```javascript
// In signup.njk success handler
window.location.href = 'https://app.bethany.untitledpublishers.com/login?welcome=true';
```

### Styling Alignment

Before launch, update React dashboard to match Eleventy site's visual language:

1. **Tailwind config updates:**
```javascript
// tailwind.config.js
colors: {
  terracotta: {
    DEFAULT: '#C17F59',
    light: '#D4A384',
    dark: '#A66B47',
  },
  sage: {
    DEFAULT: '#87A878',
    light: '#A3BF96',
    dark: '#6B8C5C',
  },
  'warm-white': '#FAF7F2',
  charcoal: {
    DEFAULT: '#2D3436',
    light: '#636E72',
  },
  // Keep bethany-500 as accent or replace with terracotta
}
```

2. **Component updates:**
   - Update `bg-bethany-*` classes to `bg-terracotta` or `bg-sage`
   - Update card radius from `rounded-xl` to `rounded-2xl` or `rounded-3xl`
   - Add the gradient blob decorations from marketing site (optional)
   - Update fonts if using custom display font

3. **Sidebar/header:**
   - Update logo/branding to match marketing site
   - Warm up the gray tones

This is a focused styling pass, not a rebuild. Estimate: 2-4 hours.

---

## Implementation Checklist

### Phase 1: Deploy React Dashboard (1-2 hours)
- [ ] Create Cloudflare Pages project
- [ ] Configure build settings
- [ ] Add custom domain `app.bethany.untitledpublishers.com`
- [ ] Verify API calls work (add CORS if needed)
- [ ] Test auth flow end-to-end

### Phase 2: Connect Signup Flow (30 min)
- [ ] Update `signup.njk` to redirect to dashboard login on success
- [ ] Add `?welcome=true` handling to login page
- [ ] Test full signup → login → overview flow

### Phase 3: Style Alignment (2-4 hours)
- [ ] Update Tailwind config with Eleventy site colors
- [ ] Update component classes
- [ ] Update sidebar branding
- [ ] Visual QA pass

### Phase 4: Polish (optional)
- [ ] Add Pages Functions proxy for cleaner API URLs
- [ ] Add loading skeletons matching site aesthetic
- [ ] Add empty states with personality

---

## Decision: React Dashboard, Separately Deployed

**Why:**
1. Dashboard already built and functional
2. Complex pages (Import, Braindump) would require significant vanilla JS
3. Subdomain separation is clean architecture
4. Cloudflare Pages deployment is trivial
5. Style alignment is a focused task, not a rebuild

**Trade-off accepted:** Two codebases with different build systems. This is the normal pattern for marketing site + app, and is worth it for the productivity gain of keeping React.

---

*Analysis completed: February 2026*
*For: Bethany / Network Manager*
