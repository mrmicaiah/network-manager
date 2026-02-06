# Relationship Dartboard System — Design Document

> A point-based relationship visualization system that transforms the dashboard into context-specific views with dartboard visualizations showing relationship health at a glance.

---

## Overview

The dashboard becomes **tag-driven** rather than a single monolithic view. Each circle (Family, Work, Gym Friends, etc.) gets its own tab with dartboard visualizations. Contacts appear as dots on the dartboard — distance from center indicates relationship health based on a point system derived from the existing Dunbar cadence model.

**Core concepts:**

1. **Tabs = Circles** — Each circle is a separate view/context
2. **Dartboards = Visual health** — Contacts positioned by relationship score
3. **Points = Interaction quality** — Different contact methods score differently based on preference
4. **Two hats** — Same person can exist in multiple circles with different requirements
5. **Unsorted = Inbox** — Contacts without circles live in the Unsorted tab until processed

---

## Point System

### Philosophy

The Dunbar system already defines HOW OFTEN to reach out (intent cadence). The point system adds HOW WELL by weighting interaction methods based on the contact's preference.

A phone call to someone who prefers calls is worth more than a text. But enough texts can still keep you in the circle.

### Point Calculation

**Base formula:**
```
points_required_per_period = 100 (constant)
preferred_method = 50 points
other_methods = 25 points
```

**Example — Mom:**
```
Intent: inner_circle (weekly cadence)
Preferred method: phone_call
Points required: 100 points/week

To stay in circle:
- 2 phone calls (2 × 50 = 100) ✓
- 4 texts (4 × 25 = 100) ✓
- 1 call + 2 texts (50 + 50 = 100) ✓
- 1 text (25 points) ✗ — drifting out
```

**Example — Work contact:**
```
Intent: transactional (quarterly cadence)
Preferred method: email
Points required: 100 points/quarter

To stay in circle:
- 2 emails (2 × 50 = 100) ✓
- 1 email + 2 texts (50 + 50 = 100) ✓
```

### Special Cases

**In-person always scores high:**
In-person interactions represent significant investment. They score 50 points regardless of preference (matches preferred method value).

```
Method point values:
- Preferred method: 50 points
- In-person: 50 points (always)
- Other methods: 25 points
```

**Video calls:**
Treated as a middle ground — 35 points if not preferred, 50 if preferred.

### Point Decay

Points don't accumulate forever. They're calculated over the **current cadence period**.

```
inner_circle: rolling 7-day window
nurture: rolling 14-day window
maintain: rolling 30-day window
transactional: rolling 90-day window
```

At any moment, the system looks back over the cadence window and sums points from interactions in that period.

### Score Calculation

```typescript
interface CircleScore {
  contactId: string;
  circleId: string;
  pointsEarned: number;      // Sum of interaction points in current window
  pointsRequired: number;    // Always 100
  score: number;             // 0.0 to 1.0+ (can exceed 1.0 if over-performing)
  status: 'thriving' | 'healthy' | 'slipping' | 'drifting';
}

function calculateScore(pointsEarned: number, pointsRequired: number): number {
  return pointsEarned / pointsRequired;
}

function getStatus(score: number): string {
  if (score >= 1.0) return 'thriving';     // 100%+ of required
  if (score >= 0.7) return 'healthy';      // 70-99%
  if (score >= 0.4) return 'slipping';     // 40-69%
  return 'drifting';                        // 0-39%
}
```

---

## Dartboard Visualization

### Concept

Each circle displays as a dartboard with concentric rings. Contacts appear as dots positioned based on their score:

- **Center (score ≥ 1.0):** Thriving — you're exceeding expectations
- **Inner ring (0.7–0.99):** Healthy — on track
- **Outer ring (0.4–0.69):** Slipping — needs attention soon
- **Outside circle (< 0.4):** Drifting — relationship at risk

### Visual Layout

```
                    FAMILY
                    
              ╭─────────────────╮
            ╱    ╭─────────╮     ╲
          ╱    ╱   ╭─────╮  ╲     ╲
         │    │   │  ●●  │   │    │
         │    │   │ Dad  │   │    │
         │    │   ╰──●───╯   │    │     ● = contact dot
         │    ╲    Mom  ╱    │    │
          ╲    ╰───●───╯    ╱
            ╲    Sister   ╱
              ╰─────●─────╯
                    
           ●                    ●
        Brother              Cousin
       (drifting)           (drifting)
```

### Positioning Algorithm

Contacts are positioned using polar coordinates:

```typescript
interface DartboardPosition {
  contactId: string;
  radius: number;    // 0 = center, 1 = edge, >1 = outside
  angle: number;     // 0-360 degrees, distributed evenly
}

function calculatePosition(score: number, index: number, totalContacts: number): DartboardPosition {
  // Radius: inverse of score (high score = closer to center)
  // Score 1.0+ = radius 0 (center)
  // Score 0.5 = radius 0.5 (middle)
  // Score 0 = radius 1.0 (edge)
  // Score < 0.4 = radius > 1.0 (outside)
  
  let radius: number;
  if (score >= 1.0) {
    radius = 0.1 + (Math.random() * 0.15); // Cluster near center with slight spread
  } else if (score >= 0.4) {
    radius = 1.0 - score; // Linear mapping
  } else {
    radius = 1.0 + ((0.4 - score) * 0.5); // Push outside, max ~1.2
  }
  
  // Angle: distribute evenly with slight randomization to avoid perfect circles
  const baseAngle = (index / totalContacts) * 360;
  const jitter = (Math.random() - 0.5) * 20; // ±10 degrees
  const angle = (baseAngle + jitter) % 360;
  
  return { contactId, radius, angle };
}
```

### Contacts Per Dartboard

Too many dots becomes unreadable. Limit per dartboard:

- **Recommended:** 50 contacts per dartboard
- **Maximum:** 75 contacts per dartboard
- **If exceeded:** Create additional dartboards stacked vertically

```
FAMILY (1 of 3)
[dartboard with 50 contacts]

FAMILY (2 of 3)
[dartboard with 50 contacts]

FAMILY (3 of 3)
[dartboard with 27 contacts]
```

**Sorting into dartboards:**
Contacts sorted by score descending. First dartboard gets the healthiest relationships, making it easy to see "who's doing well" vs "who needs work."

Or alternatively: sort by intent (inner_circle first, then nurture, etc.) so the most important relationships are on the first dartboard.

### Interaction

- **Tap/click a dot:** Popover shows contact name, score, last interaction, quick actions
- **Hover (desktop):** Tooltip with name and status
- **Tap outside dartboard:** Contacts who are drifting, shown as dots outside the ring

---

## Two Hats: Multi-Circle Contacts

### The Problem

Your brother might be in both Family and Work circles. The relationship maintenance requirements differ:

- **Family context:** Weekly calls about life, kids, parents
- **Work context:** Monthly check-ins about referrals, business

### Solution: Context-Tagged Interactions

When logging an interaction, it can be tagged to one or more circles:

```typescript
interface Interaction {
  id: string;
  contactId: string;
  method: InteractionMethod;
  summary: string;
  date: string;
  
  // NEW: Which circles does this interaction count toward?
  circleIds: string[];  // Can be multiple, or empty (counts for all)
}
```

**Logging flow:**

1. User logs: "Called brother, talked about Dad's birthday and the Johnson lead"
2. Bethany parses or asks: "Was this personal, business, or both?"
3. User indicates: Both
4. Interaction scores points for both Family AND Work circles

**If not specified:**
Interaction counts toward ALL circles the contact belongs to. This is the simple default — most people won't want to micromanage.

**For power users:**
Option to specify context. Bethany can learn patterns: "Emails with brother are usually business, calls are usually family."

### Separate Scores Per Circle

Each contact has a score calculated **per circle**:

```typescript
// Brother's scores
{
  contact: "Brother",
  circles: [
    { circleId: "family", score: 0.85, status: "healthy" },
    { circleId: "work", score: 0.45, status: "slipping" }
  ]
}
```

Brother appears on both dartboards at different positions.

---

## Tab Structure

### Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│ [Family]  [Work]  [Gym Friends]  [Book Club]       [Unsorted 🔴 12]    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│                         (Dartboard content)                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Tab Behavior

- **Circle tabs:** One per circle the user has created
- **Unsorted tab:** Always present, shows count badge when contacts need sorting
- **Tab order:** User-configurable in settings (drag to reorder)
- **Default tab:** User picks which tab loads first

### Unsorted Tab

The Unsorted tab replaces the Braindump page as the "inbox" for contacts:

- Shows contacts with no circle assigned
- Badge shows count: `[Unsorted 🔴 12]`
- No dartboard — just a list or card view
- Quick actions: Assign to circle, set intent, add notes
- Braindump text input for natural language processing

```
┌─────────────────────────────────────────────────────────────────────────┐
│ UNSORTED (12 contacts)                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ Tell me about these people and I'll sort them for you...           │ │
│ │                                                                     │ │
│ │ "Jake is my gym buddy, we work out together twice a week.          │ │
│ │  Sarah is from book club, we meet monthly..."                      │ │
│ │                                                                     │ │
│ │                                              [Sort them →]          │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ Or sort manually:                                                       │
│                                                                         │
│ ┌──────────────────────────────────────────────────────────┐           │
│ │ Jake Thompson          [Family ▼]  [inner_circle ▼]  [✓] │           │
│ │ Added 3 days ago                                         │           │
│ └──────────────────────────────────────────────────────────┘           │
│ ┌──────────────────────────────────────────────────────────┐           │
│ │ Sarah Chen             [Book Club ▼]  [maintain ▼]   [✓] │           │
│ │ Added 1 week ago                                         │           │
│ └──────────────────────────────────────────────────────────┘           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Model Changes

### Contact Record

Add preferred contact method:

```sql
-- Add to contacts table
preferred_method TEXT NULL  -- 'text', 'call', 'email', 'in_person', 'video', 'social'
```

```typescript
// In shared/models.ts
export interface ContactRow {
  // ... existing fields ...
  
  preferred_method: InteractionMethod | null;
}
```

### Interaction Record

Add circle context:

```sql
-- Add to interactions table
circle_context TEXT NULL  -- JSON array of circle IDs, null = counts for all
```

```typescript
// In shared/models.ts
export interface InteractionRow {
  // ... existing fields ...
  
  // Which circles this interaction counts toward
  // null = all circles the contact belongs to
  // [] = no circles (shouldn't happen normally)
  // ['circle-id-1', 'circle-id-2'] = specific circles
  circle_context: string | null;  // JSON array stored as TEXT
}
```

### User Preferences

Add dashboard tab settings:

```sql
-- Add to users table
default_circle_id TEXT NULL,      -- Which tab loads first
circle_tab_order TEXT NULL        -- JSON array of circle IDs in display order
```

```typescript
// In shared/models.ts
export interface UserRow {
  // ... existing fields ...
  
  default_circle_id: string | null;
  circle_tab_order: string | null;  // JSON array
}
```

### Circle Score Cache (Optional)

For performance, cache calculated scores:

```sql
-- New table
CREATE TABLE circle_scores (
  contact_id TEXT NOT NULL,
  circle_id TEXT NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'drifting',
  calculated_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, circle_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE CASCADE
);

CREATE INDEX idx_circle_scores_circle ON circle_scores(circle_id);
CREATE INDEX idx_circle_scores_status ON circle_scores(circle_id, status);
```

Recalculated:
- On interaction log
- On contact/circle update
- Daily cron job for decay

---

## Point Configuration

### Config Structure

```typescript
// New file: shared/point-config.ts

export const POINT_CONFIG = {
  // Points required per cadence period (constant)
  pointsRequired: 100,
  
  // Base points by method
  methodPoints: {
    text: 25,
    call: 25,
    email: 25,
    in_person: 50,  // Always high value
    video: 35,
    social: 20,
    other: 20,
  },
  
  // Preferred method bonus (replaces base points)
  preferredMethodPoints: 50,
  
  // Score thresholds for status
  thresholds: {
    thriving: 1.0,   // ≥ 100%
    healthy: 0.7,    // 70-99%
    slipping: 0.4,   // 40-69%
    drifting: 0,     // 0-39%
  },
  
  // Dartboard limits
  contactsPerDartboard: 50,
  maxContactsPerDartboard: 75,
} as const;
```

### Calculation Service

```typescript
// New file: worker/services/score-service.ts

import { POINT_CONFIG } from '../../shared/point-config';
import { INTENT_CONFIGS } from '../../shared/intent-config';

export interface CircleScoreResult {
  contactId: string;
  circleId: string;
  pointsEarned: number;
  pointsRequired: number;
  score: number;
  status: 'thriving' | 'healthy' | 'slipping' | 'drifting';
  interactions: number;  // Count in current window
}

/**
 * Calculate a contact's score for a specific circle.
 */
export async function calculateCircleScore(
  db: D1Database,
  contactId: string,
  circleId: string,
): Promise<CircleScoreResult> {
  // Get contact details
  const contact = await db.prepare(
    'SELECT intent, preferred_method FROM contacts WHERE id = ?'
  ).bind(contactId).first<{ intent: string; preferred_method: string | null }>();
  
  if (!contact) throw new Error('Contact not found');
  
  // Get cadence window based on intent
  const intentConfig = INTENT_CONFIGS[contact.intent as IntentType];
  const windowDays = intentConfig.defaultCadenceDays ?? 30;
  
  // Get interactions in the window that count for this circle
  const { results: interactions } = await db.prepare(`
    SELECT method FROM interactions
    WHERE contact_id = ?
      AND date >= date('now', '-' || ? || ' days')
      AND (circle_context IS NULL OR circle_context LIKE ?)
  `).bind(contactId, windowDays, `%${circleId}%`).all<{ method: string }>();
  
  // Calculate points
  let pointsEarned = 0;
  for (const interaction of interactions) {
    if (interaction.method === contact.preferred_method) {
      pointsEarned += POINT_CONFIG.preferredMethodPoints;
    } else if (interaction.method === 'in_person') {
      pointsEarned += POINT_CONFIG.methodPoints.in_person;
    } else {
      pointsEarned += POINT_CONFIG.methodPoints[interaction.method] ?? 20;
    }
  }
  
  const score = pointsEarned / POINT_CONFIG.pointsRequired;
  
  let status: CircleScoreResult['status'];
  if (score >= POINT_CONFIG.thresholds.thriving) status = 'thriving';
  else if (score >= POINT_CONFIG.thresholds.healthy) status = 'healthy';
  else if (score >= POINT_CONFIG.thresholds.slipping) status = 'slipping';
  else status = 'drifting';
  
  return {
    contactId,
    circleId,
    pointsEarned,
    pointsRequired: POINT_CONFIG.pointsRequired,
    score,
    status,
    interactions: interactions.length,
  };
}

/**
 * Calculate scores for all contacts in a circle.
 * Returns positioned data ready for dartboard rendering.
 */
export async function calculateDartboardData(
  db: D1Database,
  userId: string,
  circleId: string,
): Promise<DartboardData> {
  // Get all contacts in this circle
  const { results: contacts } = await db.prepare(`
    SELECT c.id, c.name, c.intent, c.preferred_method
    FROM contacts c
    INNER JOIN contact_circles cc ON c.id = cc.contact_id
    WHERE c.user_id = ? AND cc.circle_id = ? AND c.archived = 0
  `).bind(userId, circleId).all();
  
  // Calculate score for each
  const scores: CircleScoreResult[] = [];
  for (const contact of contacts) {
    const score = await calculateCircleScore(db, contact.id, circleId);
    scores.push(score);
  }
  
  // Sort by score descending (healthiest first)
  scores.sort((a, b) => b.score - a.score);
  
  // Split into dartboards
  const dartboards: DartboardContacts[] = [];
  const limit = POINT_CONFIG.contactsPerDartboard;
  
  for (let i = 0; i < scores.length; i += limit) {
    const batch = scores.slice(i, i + limit);
    dartboards.push({
      index: Math.floor(i / limit) + 1,
      total: Math.ceil(scores.length / limit),
      contacts: batch.map((score, idx) => ({
        ...score,
        name: contacts.find(c => c.id === score.contactId)?.name ?? '',
        position: calculatePosition(score.score, idx, batch.length),
      })),
    });
  }
  
  return {
    circleId,
    totalContacts: scores.length,
    dartboards,
    summary: {
      thriving: scores.filter(s => s.status === 'thriving').length,
      healthy: scores.filter(s => s.status === 'healthy').length,
      slipping: scores.filter(s => s.status === 'slipping').length,
      drifting: scores.filter(s => s.status === 'drifting').length,
    },
  };
}

function calculatePosition(score: number, index: number, total: number): Position {
  let radius: number;
  
  if (score >= 1.0) {
    radius = 0.1 + (Math.random() * 0.15);
  } else if (score >= 0.4) {
    radius = 1.0 - score;
  } else {
    radius = 1.0 + ((0.4 - score) * 0.5);
  }
  
  const baseAngle = (index / total) * 360;
  const jitter = (Math.random() - 0.5) * 20;
  const angle = (baseAngle + jitter) % 360;
  
  return { radius, angle };
}
```

---

## API Endpoints

### New Endpoints

```
GET /api/dashboard/tabs
Returns circle tabs with unsorted count.

Response:
{
  tabs: [
    { id: 'family', name: 'Family', contactCount: 23 },
    { id: 'work', name: 'Work', contactCount: 45 },
    ...
  ],
  unsortedCount: 12,
  defaultTabId: 'family',
  tabOrder: ['family', 'work', 'gym']
}
```

```
GET /api/dashboard/dartboard/:circleId
Returns dartboard data for a circle.

Response:
{
  circleId: 'family',
  totalContacts: 127,
  dartboards: [
    {
      index: 1,
      total: 3,
      contacts: [
        {
          contactId: 'xxx',
          name: 'Mom',
          score: 0.85,
          status: 'healthy',
          pointsEarned: 85,
          position: { radius: 0.15, angle: 45 }
        },
        ...
      ]
    },
    ...
  ],
  summary: {
    thriving: 12,
    healthy: 45,
    slipping: 8,
    drifting: 3
  }
}
```

```
PATCH /api/user/preferences
Update dashboard preferences.

Body:
{
  defaultCircleId: 'family',
  circleTabOrder: ['family', 'work', 'gym']
}
```

```
GET /api/contacts/unsorted
Returns contacts without any circle assignment.

Response:
{
  contacts: [
    { id: 'xxx', name: 'Jake', createdAt: '...', intent: 'new' },
    ...
  ],
  count: 12
}
```

---

## Migration Plan

### Database Migration

```sql
-- Migration: Add point system fields

-- 1. Add preferred_method to contacts
ALTER TABLE contacts ADD COLUMN preferred_method TEXT NULL;

-- 2. Add circle_context to interactions
ALTER TABLE interactions ADD COLUMN circle_context TEXT NULL;

-- 3. Add dashboard preferences to users
ALTER TABLE users ADD COLUMN default_circle_id TEXT NULL;
ALTER TABLE users ADD COLUMN circle_tab_order TEXT NULL;

-- 4. Create circle_scores cache table
CREATE TABLE IF NOT EXISTS circle_scores (
  contact_id TEXT NOT NULL,
  circle_id TEXT NOT NULL,
  points_earned INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'drifting',
  calculated_at TEXT NOT NULL,
  PRIMARY KEY (contact_id, circle_id),
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (circle_id) REFERENCES circles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_circle_scores_circle ON circle_scores(circle_id);
CREATE INDEX IF NOT EXISTS idx_circle_scores_status ON circle_scores(circle_id, status);
```

### Onboarding Updates

During onboarding, Bethany should ask about preferred contact method:

> "One more thing — when someone wants to reach you, what works best? Text, call, email?"

This sets the user's own preference, which can inform defaults for contacts they add.

For individual contacts, Bethany can ask when they're added:

> "How does [Name] prefer to be contacted? Or should I just use your default?"

---

## Component Checklist

| Component | Status | Priority | Description |
|-----------|--------|----------|-------------|
| `DashboardTabs` | To build | P1 | Tab bar with circle tabs + unsorted |
| `Dartboard` | To build | P1 | SVG/Canvas dartboard with positioned dots |
| `DartboardDot` | To build | P1 | Interactive contact dot with popover |
| `UnsortedTab` | To build | P1 | Rename braindump page, add to tab structure |
| `TabSettings` | To build | P2 | Drag-to-reorder tabs, set default |
| `CircleScoreBadge` | To build | P2 | Shows score/status on contact cards |
| `MethodPicker` | To build | P2 | Preferred method selection for contacts |

---

## Open Questions

1. **Contacts in no circles** — Do they appear anywhere besides Unsorted? Overview page?

2. **New contacts during establishment** — Do they start with bonus points or zero?

3. **Dormant contacts** — Do they appear on dartboards? Probably not.

4. **Circle-specific cadence** — Could a contact have different intents per circle? (Brother is inner_circle for Family but transactional for Work)

5. **Bethany's awareness** — Should Bethany reference scores/points in nudges? Or keep it hidden?

---

## Success Metrics

- **Engagement:** Time spent on dartboard views
- **Sorting rate:** % of unsorted contacts that get placed within 7 days
- **Score improvement:** Average score trends upward over time
- **Multi-circle usage:** % of users with contacts in 2+ circles
- **Preferred method completion:** % of contacts with preferred method set

---

*Document created: February 2026*
*Author: Claude (Worker Mode)*
*For: Network Manager / Bethany Dashboard*
