# Dashboard Overview Page — Design Document

> Design specification for the Network Manager dashboard homepage. Transforms the basic stats view into an actionable, insight-rich command center that reflects Bethany's proactive personality.

---

## Current State

The Overview page currently displays:
- **Stats row:** Total contacts, Needs attention (yellow), Overdue (red)
- **Three donut charts:** Health breakdown, Intent breakdown, Circle breakdown
- **Empty state prompts:** For new users with no contacts
- **Overdue contacts section:** Placeholder, not implemented

**What's missing:**
- No gauges or progress indicators
- No actionable suggestions
- No recent activity feed
- No personalized insights
- Limited personality — feels like a generic dashboard

---

## Design Goals

1. **Actionable over informational** — Every widget should suggest or enable an action
2. **Bethany's voice** — Copy should feel like her (warm, direct, slightly opinionated)
3. **Progressive disclosure** — Essential info at a glance, details on demand
4. **Mobile-first** — Most users access via mobile after receiving Bethany's texts
5. **Performance** — Lazy load secondary widgets, cache expensive calculations

---

## Proposed Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  "Hey, [name] 👋"                                    [Braindump] ▲  │
│  [Contextual greeting based on time + network state]              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │   NETWORK        │  │   WEEKLY        │  │   STREAK       │     │
│  │   HEALTH         │  │   GOAL          │  │                │     │
│  │     78%          │  │   12/15         │  │   🔥 7 days    │     │
│  │   [Gauge]        │  │   [Progress]    │  │                │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────────────────────────────┐  ┌───────────────────┐ │
│  │  TODAY'S SUGGESTED ACTIONS             │  │  RECENT ACTIVITY  │ │
│  │                                        │  │                   │ │
│  │  🔴 Call your sister (12 days)        │  │  Today            │ │
│  │     [Draft message]  [Mark done]       │  │  ☎️ Called Mom    │ │
│  │                                        │  │  💬 Texted Jake   │ │
│  │  🟡 Check in with Marcus (9 days)     │  │                   │ │
│  │     [Draft message]  [Mark done]       │  │  Yesterday        │ │
│  │                                        │  │  ☕ Coffee w/ Sam │ │
│  │  🟢 Jake is due in 2 days             │  │                   │ │
│  │     (Just a heads up)                  │  │  [View all →]     │ │
│  │                                        │  │                   │ │
│  │  [View all nudges →]                   │  │                   │ │
│  └────────────────────────────────────────┘  └───────────────────┘ │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  💡 INSIGHTS                                                   │ │
│  │                                                                │ │
│  │  "3 people are drifting from Nurture → Maintain. That's      │ │
│  │   normal, but if any of them matter, now's the time."        │ │
│  │                                                                │ │
│  │  "You haven't talked to anyone in your Family circle this    │ │
│  │   week. Sunday night call with Mom?"                          │ │
│  │                                                                │ │
│  │  [Dismiss]                                  [Show me who →]   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │  HEALTH STATUS  │  │  BY INTENT      │  │  BY CIRCLE      │     │
│  │  [Donut Chart]  │  │  [Donut Chart]  │  │  [Donut Chart]  │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  DUNBAR LAYER FILL                                             │ │
│  │                                                                │ │
│  │  Inner Circle (5)    ████████░░  4/5                          │ │
│  │  Nurture (15)        ██████████  12/15                        │ │
│  │  Maintain (50)       ████░░░░░░  22/50                        │ │
│  │  Transactional (150) █░░░░░░░░░  18/150                       │ │
│  │                                                                │ │
│  │  "Your inner circle is almost full. That's healthy —         │ │
│  │   research says ~5 is the limit for truly close bonds."      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Widget Specifications

### 1. Header with Contextual Greeting

**Purpose:** Make the experience feel personal, not transactional.

**Data required:**
- `user.name` (already available)
- Current time (client-side)
- Network health summary (already fetched)

**Logic:**
```javascript
function getGreeting(name, hour, healthSummary) {
  const timeGreeting = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";
  
  if (healthSummary.byHealth.red > 5) {
    return `Good ${timeGreeting}, ${name}. You've got some catching up to do — but that's what I'm here for.`;
  } else if (healthSummary.byHealth.red === 0 && healthSummary.byHealth.yellow === 0) {
    return `Good ${timeGreeting}, ${name}. Your network looks healthy. Nice work.`;
  } else if (healthSummary.byHealth.yellow > 0) {
    return `Good ${timeGreeting}, ${name}. A few people could use some love this week.`;
  }
  return `Good ${timeGreeting}, ${name}. Here's how your network is doing.`;
}
```

**API:** None needed (use existing `/api/contacts/health`)

---

### 2. Network Health Gauge

**Purpose:** Single number that captures overall network health at a glance.

**Display:** Circular gauge, 0-100%, color-coded (green/yellow/red zones)

**Calculation:**
```javascript
function calculateNetworkHealth(healthCounts, intentCounts) {
  const total = healthCounts.green + healthCounts.yellow + healthCounts.red;
  if (total === 0) return 100; // Empty network is healthy
  
  // Weighted score: green = 100%, yellow = 50%, red = 0%
  const score = (healthCounts.green * 100 + healthCounts.yellow * 50) / total;
  
  // Bonus: reward having contacts in inner layers (active network)
  const activeContacts = intentCounts.inner_circle + intentCounts.nurture + intentCounts.maintain;
  const dormantPenalty = intentCounts.dormant > total * 0.3 ? 10 : 0; // Penalty if >30% dormant
  
  return Math.round(Math.max(0, Math.min(100, score - dormantPenalty)));
}
```

**API:** None needed (derive from existing health endpoint)

**Component:** New `<HealthGauge score={78} />`

---

### 3. Weekly Goal Progress

**Purpose:** Gamify connection behavior with weekly targets.

**Display:** Progress ring or bar showing X/Y contacts reached this week.

**Data required:**
- Interactions logged this week (count of unique contacts)
- Weekly goal setting (new user preference)

**Default goal:** 15 contacts/week (configurable in settings)

**API needed:** New endpoint or expand `/api/interactions`
```
GET /api/interactions/stats?days=7
Response: {
  totalThisPeriod: 12,
  uniqueContacts: 10,
  byMethod: { text: 5, call: 3, in_person: 2 },
  mostActiveContact: { id, name, count }
}
```

**Note:** `getInteractionStats()` already exists in `interaction-service.ts` — just needs API route.

---

### 4. Connection Streak

**Purpose:** Motivate consistent daily/weekly check-ins.

**Display:** Fire emoji + days count, or "No streak" with encouragement.

**Logic:**
```javascript
function calculateStreak(recentInteractions) {
  // Count consecutive days with at least 1 interaction, going backward from today
  let streak = 0;
  const today = new Date();
  
  for (let i = 0; i < 30; i++) { // Max 30 day streak display
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().slice(0, 10);
    
    const hasInteraction = recentInteractions.some(
      int => int.date.startsWith(dateStr)
    );
    
    if (hasInteraction) streak++;
    else if (i > 0) break; // Allow today to be empty
  }
  
  return streak;
}
```

**API needed:** Expand `/api/interactions` or new `/api/stats/streak`

---

### 5. Today's Suggested Actions

**Purpose:** The core "what should I do?" widget. Reduces decision fatigue.

**Display:** List of 3-5 contacts with:
- Health status indicator (colored dot)
- Contact name
- Days since last contact
- Quick actions: [Draft message] [Mark done]

**Priority logic:**
1. Red contacts (overdue) — sorted by days overdue, inner circle first
2. Yellow contacts (slipping) — sorted by days until red
3. Upcoming (green, due within 3 days) — heads up, not urgent

**API needed:** New endpoint
```
GET /api/nudges/today
Response: {
  suggested: [
    { contactId, name, intent, healthStatus, daysSince, daysUntilRed, reason },
    ...
  ]
}
```

**Actions:**
- "Draft message" → Opens message composer modal with AI-generated starter
- "Mark done" → Logs an interaction (asks for method: text/call/etc.)

---

### 6. Recent Activity Feed

**Purpose:** Show momentum, reinforce logging behavior.

**Display:** Grouped by date, showing:
- Interaction method icon
- Contact name
- Summary snippet (if available)

**Data:** Already available via `getRecentInteractionsGrouped()` in interaction-service.

**API:** Already exists: `GET /api/interactions?days=7`

**Component:** New `<ActivityFeed interactions={grouped} />`

---

### 7. Insights Panel

**Purpose:** Surface non-obvious patterns. This is where Bethany's intelligence shines.

**Display:** 1-3 insight cards with:
- Bethany's observation (conversational copy)
- Action button: [Show me who →] or [Dismiss]

**Insight types:**

| Insight | Trigger | Copy Template |
|---------|---------|---------------|
| Drift detection | 2+ contacts drifting | "{{count}} people are drifting from {{fromLayer}} → {{toLayer}}. That's normal, but if any of them matter, now's the time." |
| Circle neglect | 0 interactions with circle this week | "You haven't talked to anyone in {{circleName}} this week. {{suggestion}}" |
| New contacts unsorted | 5+ 'new' intent contacts | "You've got {{count}} contacts waiting to be sorted. Want me to help you go through them?" |
| Relationship at risk | Contact red for 2+ cycles | "{{name}} has been overdue for a while now. Is this relationship still active, or should we move them to dormant?" |
| Success celebration | All contacts green | "🎉 Everyone's in the green! Your network is thriving. That's rare — enjoy it." |

**API needed:** New endpoint
```
GET /api/insights
Response: {
  insights: [
    { type, message, action, actionLabel, contactIds, metadata },
    ...
  ]
}
```

**Priority:** Show max 2 insights. Rotate through available insights across sessions.

---

### 8. Dunbar Layer Fill Visualization

**Purpose:** Educate users about Dunbar's research while showing network structure.

**Display:** Horizontal bar chart showing fill rate for each layer:
- Inner Circle: 4/5 (80%)
- Nurture: 12/15 (80%)
- Maintain: 22/50 (44%)
- Transactional: 18/150 (12%)

**Includes:** Brief Bethany commentary when hovering or below:
- If inner circle is 5+: "Your inner circle is at capacity. That's healthy — research says ~5 is the limit for truly close bonds."
- If inner circle is 1-2: "Room in your inner circle. Who deserves to be closer?"

**API:** Derive from existing `/api/contacts/health` intent counts.

**Component:** New `<DunbarLayerBars counts={intentCounts} />`

---

## API Requirements Summary

### Existing APIs (no changes needed)
- `GET /api/contacts/health` — Health and intent counts
- `GET /api/circles` — Circle list with counts
- `GET /api/auth/me` — User info

### New APIs needed

#### 1. `GET /api/interactions/stats`
Already implemented in service layer (`getInteractionStats`), needs API route.

```typescript
// Add to worker/routes/api.ts
} else if (path === '/api/interactions/stats' && method === 'GET') {
  const days = parseInt(url.searchParams.get('days') ?? '7', 10);
  const stats = await getInteractionStats(db, user.id, days);
  return jsonResponse({ data: stats });
}
```

#### 2. `GET /api/nudges/today`
New endpoint for suggested actions.

```typescript
interface SuggestedAction {
  contactId: string;
  name: string;
  intent: IntentType;
  healthStatus: HealthStatus;
  daysSince: number;
  daysUntilRed: number | null;
  reason: string; // "12 days since last contact", "Due in 2 days"
  suggestedMessage?: string; // AI-generated starter
}

// Response
{ suggested: SuggestedAction[] }
```

**Implementation:** Query contacts where health_status IN ('red', 'yellow') OR days until next status change <= 3, sorted by priority.

#### 3. `GET /api/insights`
New endpoint for smart insights.

```typescript
interface Insight {
  type: 'drift' | 'circle_neglect' | 'unsorted' | 'at_risk' | 'celebration';
  message: string;
  action: 'view_contacts' | 'sort_contacts' | 'archive_contact' | 'dismiss';
  actionLabel: string;
  contactIds?: string[];
  metadata?: Record<string, any>;
}

// Response
{ insights: Insight[] }
```

**Implementation:**
1. Check for drift using `detectDrift()` from intent-config
2. Check for circles with 0 interactions this week
3. Check for unsorted 'new' contacts
4. Check for long-overdue contacts (red for 2+ cadence cycles)
5. Check if all contacts are green

#### 4. `GET /api/stats/streak`
Simple streak calculation.

```typescript
// Response
{ 
  currentStreak: number,
  longestStreak: number,
  lastActiveDate: string | null
}
```

---

## Implementation Priority

### Phase 1 — Core Value (Week 1)
1. **Contextual greeting** — Quick win, high impact on personality
2. **Network Health Gauge** — Derive from existing data
3. **Today's Suggested Actions** — Core actionability
4. **Recent Activity Feed** — Uses existing API with minor tweaks

### Phase 2 — Engagement (Week 2)
5. **Weekly Goal Progress** — New API route for existing service
6. **Connection Streak** — Simple calculation
7. **Dunbar Layer Fill** — Derive from existing data

### Phase 3 — Intelligence (Week 3)
8. **Insights Panel** — Complex logic, biggest differentiator
9. **AI-generated message starters** — Requires Claude API integration

---

## Component Checklist

| Component | Status | Priority | Dependencies |
|-----------|--------|----------|--------------|
| `HealthGauge` | To build | P1 | None |
| `WeeklyGoalRing` | To build | P2 | API: `/api/interactions/stats` |
| `StreakBadge` | To build | P2 | API: `/api/stats/streak` |
| `SuggestedActions` | To build | P1 | API: `/api/nudges/today` |
| `ActivityFeed` | To build | P1 | API: expand `/api/interactions` |
| `InsightCard` | To build | P3 | API: `/api/insights` |
| `DunbarLayerBars` | To build | P2 | None (existing data) |
| `MessageComposerModal` | To build | P3 | Claude API |

---

## Design Tokens

Use the existing Bethany color palette:

```css
--bethany-50: #fdf2f8;
--bethany-500: #ec4899;
--bethany-600: #db2777;

/* Health colors */
--health-green: #22c55e;
--health-yellow: #eab308;
--health-red: #ef4444;

/* Intent colors (existing) */
--intent-inner: #8b5cf6;
--intent-nurture: #3b82f6;
--intent-maintain: #06b6d4;
--intent-transactional: #84cc16;
--intent-dormant: #9ca3af;
--intent-new: #f97316;
```

---

## Mobile Considerations

- Stack widgets vertically on mobile
- Suggested Actions should be swipeable cards
- Gauge should be large and tap-friendly
- Activity feed should lazy-load on scroll
- Insights should be dismissible with swipe

---

## Open Questions

1. **Weekly goal customization** — Should this be a user preference? Default to 15?
2. **Streak definition** — Does it break if you miss one day? Grace period?
3. **Insight frequency** — How often should the same insight type show?
4. **Message drafts** — Store drafts or generate fresh each time?
5. **Notification tie-in** — Should suggested actions match SMS nudges?

---

## Success Metrics

- **Engagement:** DAU/WAU ratio improves
- **Action rate:** % of users who take an action from suggested list
- **Streak retention:** Average streak length increases over time
- **Network health:** Average health score trends upward
- **Feature discovery:** % of users who interact with insights panel

---

*Document created: February 2026*
*Author: Claude (Worker Mode)*
*For: Network Manager / Bethany Dashboard*
