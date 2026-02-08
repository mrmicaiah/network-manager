# Decision: Score References in Nudges

**Date:** 2026-02-08  
**Status:** Decided  
**Decision:** Option C — SMS stays natural, dashboard shows points

## Context

The dartboard system introduces a point-based scoring model for relationship health. The question was whether Bethany should reference these scores/points in her SMS nudges.

## Options Considered

### Option A: Hide scores entirely
Keep nudges simple and natural.

**Example:** "Hey! You haven't talked to Mom in a while. Give her a call?"

**Pros:**
- Simple, warm, human
- Matches Bethany's personality
- No gamification feel

**Cons:**
- User doesn't know WHY they're getting nudged
- No actionable guidance on what "enough" looks like

### Option B: Subtle score references in SMS
Reference interaction counts in nudges.

**Example:** "You're slipping with Mom — just 2 calls this week to stay close. Give her a ring?"

**Pros:**
- Actionable ("2 calls")
- Tied to the system's logic
- User understands the goal

**Cons:**
- Feels gamified
- Conflicts with Bethany's "friend, not robot" personality
- Could create anxiety/pressure around numbers

### Option C: Dashboard only (CHOSEN)
SMS stays natural and warm. Dashboard shows the full scoring system.

**SMS:** "Been about three weeks since you and Mom connected. Even a quick check-in would mean a lot."

**Dashboard:** Shows dartboard visualization with score, status, and "You need 2 more calls this week to stay connected" guidance.

**Pros:**
- Best of both worlds
- SMS feels like a thoughtful friend
- Dashboard satisfies users who want to understand the system
- Clear channel differentiation

**Cons:**
- Slight disconnect between channels
- Some users may wonder why dashboard shows more detail

## Rationale

Bethany's personality is built around being "warm + sharp + real" — a friend who nudges, not a productivity app that nags. Her nudging style explicitly avoids feeling like "an alarm clock."

From the personality config:
> "You're not managing a CRM. You're helping people not lose the relationships that make their lives better."

Introducing point counts in SMS would undermine this. When a friend reminds you to call your mom, they don't say "2 more calls required to maintain relationship health score." They say "Hey, you should call your mom."

However, the dashboard is explicitly an analytical tool. Users who open the dashboard are in "management mode" — they expect to see metrics, progress, and actionable guidance. The `getPointsNeededSummary()` function is perfect for this context.

## Implementation

### SMS Nudges (No Change)
Current nudge templates in `nudge-service.ts` remain as-is:
- "Hey, it's been a while since you connected with {name}."
- "Been about {days} since you and {name} connected."

No references to points, scores, or required interaction counts.

### Dashboard (Use Point Helpers)
The dartboard UI and contact detail pages can use:

```typescript
import { getPointsNeededSummary, interactionsNeeded } from 'shared/point-config';

// In contact detail or dartboard tooltip:
const guidance = getPointsNeededSummary(contact.pointsEarned, contact.preferredMethod);
// → "2 calls or 4 texts"

// For specific method:
const callsNeeded = interactionsNeeded('call', contact.preferredMethod, contact.pointsEarned);
// → 2
```

### UI Copy Examples

**Dartboard contact tooltip:**
> "Sarah is slipping. 2 more calls this week to stay in your inner circle."

**Contact detail page:**
> "To maintain your connection with Sarah, try: 2 calls or 4 texts this week."

**Overview stat card:**
> "3 contacts need attention. A few quick texts would turn things around."

## Future Considerations

1. **User Preference**: Could add a setting for "detailed nudges" for users who want numbers
2. **Power Users**: Some users may request score visibility in SMS — evaluate based on feedback
3. **Onboarding**: Dashboard should explain the point system so SMS nudges make sense in context

## Related Files

- `shared/point-config.ts` — Point calculation and `getPointsNeededSummary()`
- `shared/intent-config.ts` — Nudge templates and health thresholds
- `worker/services/nudge-service.ts` — Nudge generation (no changes needed)
- `shared/bethany-personality.ts` — Personality guidelines (supports this decision)
- `dashboard/src/components/Dartboard.tsx` — Should use point helpers for tooltips
