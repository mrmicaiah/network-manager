# Bethany's Onboarding Knowledge Base

> Reference document for intelligent onboarding routing. Parse during onboarding conversations to guide users to the right import path based on their situation.

---

## 1. User Scenario Recognition

Identify which type of user you're talking to early in the conversation. Listen for signals in how they describe their network.

### Network Size Signals

| Size | Signals to Listen For | Likely Path |
|------|----------------------|-------------|
| **Big (500+ contacts)** | "I have thousands of contacts", "my whole phone", "years of networking", "I'm in sales/recruiting" | CSV Upload or vCard export — manual is impossible |
| **Medium (50-200)** | "I have a decent network", "between work and personal", "maybe a hundred people" | Flexible — could do import or start with key people |
| **Small/Intentional (10-50)** | "Just the people who matter", "my close circle", "not that many", "quality over quantity" | Manual via text — lowest friction, most personal |
| **Starting Fresh** | "I don't really track this stuff", "I've been bad about staying in touch", "I need help figuring out who" | Discovery conversation — help them identify who to track |

### Tech Comfort Signals

| Level | Signals | Adjust Approach |
|-------|---------|-----------------|
| **Tech-savvy** | Uses specific terms, asks about file formats, mentions other apps they've used | Give direct instructions, skip hand-holding |
| **Tech-comfortable** | Can follow instructions, doesn't ask for clarification on every step | Standard instructions, offer to help if stuck |
| **Needs guidance** | "I'm not great with this stuff", asks what something means, seems hesitant | Step-by-step, reassure them, offer alternatives |

### Organization Signals

| State | Signals | Import Implications |
|-------|---------|---------------------|
| **Organized** | "I have a spreadsheet", "I keep lists", "they're in groups in my phone" | CSV likely works well, may have existing categories |
| **Scattered** | "They're all over the place", "some in my phone, some in email", "I'd have to think about it" | Braindump might be easier than organized export |
| **Chaotic** | "Total mess", "I don't even know who's in there", "years of accumulated junk" | Start small with key people, don't try to import everything |

### Goal Signals

| Focus | Signals | Tailor Response |
|-------|---------|-----------------|
| **Personal/Family** | "Stay close to family", "my parents", "old friends", "people I care about" | Emphasize inner circle, kin features, emotional language |
| **Professional** | "Networking", "industry contacts", "clients", "professional relationships" | Emphasize transactional layer, quarterly check-ins, practical language |
| **Both** | "Mix of personal and work", "colleagues who became friends" | Acknowledge the blend, mention circles for organization |

---

## 2. Available Tools & When to Recommend Each

### CSV Upload (Dashboard)
**Best for:** 50+ contacts, organized users, people with existing spreadsheets

**Recommend when:**
- User mentions having "a lot" of contacts
- User already has a spreadsheet or CRM export
- User is tech-comfortable and wants efficiency

**How to pitch it:**
> "Since you've got a bigger network, the fastest path is to upload a CSV file. I've got a simple template on the dashboard — just name, phone, email, and any notes. Upload it, and I'll help you sort everyone into the right circles."

**Link:** `{{DASHBOARD_URL}}/import`

---

### vCard Export (iPhone)
**Best for:** iPhone users with contacts in the phone app

**Recommend when:**
- User mentions iPhone/Apple
- User's contacts are in the phone (not scattered)
- User wants to import phone contacts

**How to pitch it:**
> "If your people are in your iPhone contacts, you can export them as a vCard and upload that. It takes about 2 minutes — I'll walk you through it if you want."

---

### Google Contacts OAuth
**Best for:** Android users, Gmail-centric users

**Recommend when:**
- User mentions Android or Gmail
- User's contacts are in Google Contacts

**How to pitch it:**
> "Since your contacts are in Google, you can connect your Google Contacts directly. One-click sync, and I'll pull in everyone."

**Status:** Coming soon — not yet built

---

### Manual Add via Text
**Best for:** Small networks, intentional relationship builders, starting fresh

**Recommend when:**
- User has fewer than 20 key people
- User prefers low-friction over completeness
- User is starting fresh and needs discovery help

**How to pitch it:**
> "Let's start simple. Just tell me about the people who matter most — their names, how you know them, how often you want to stay in touch. We'll build from there."

---

### Braindump Page
**Best for:** Scattered contacts, people who think in prose, "just let me dump it all" types

**Recommend when:**
- User seems overwhelmed by structure
- User says things like "can I just tell you about them?"
- User's contacts are in their head more than in a system

**How to pitch it:**
> "You don't have to organize anything. Just brain-dump everything you know about your people — names, relationships, notes, whatever comes to mind. I'll sort it out."

**Link:** `{{DASHBOARD_URL}}/braindump`

---

### Hybrid Approach
**Best for:** Medium networks, users who want to start quickly but import more later

**Recommend when:**
- User has a medium-sized network
- User seems torn between options
- User wants quick wins now, completeness later

**How to pitch it:**
> "Here's what I'd suggest: let's start with your most important people right now — the 10-15 you'd hate to lose touch with. Get those set up, get a feel for how this works. Then whenever you're ready, you can upload the rest from a CSV or your phone."

---

## 3. Platform-Specific Export Instructions

### iPhone: vCard Export

**Step-by-step:**
1. Open the **Contacts** app
2. Tap **Lists** in the top left
3. Tap **All Contacts** (or a specific group)
4. Tap the **three dots** (•••) in the top right
5. Tap **Export**
6. Choose **vCard** format
7. Save to Files or share directly to the dashboard upload

**Simplified version for text:**
> "Open Contacts, tap Lists, then the three dots, then Export. Choose vCard and save it. Then upload it on the import page."

---

### Android: Google Contacts Export

**Step-by-step:**
1. Go to **contacts.google.com** on a computer (easier than phone)
2. Click the **hamburger menu** (☰) on the left
3. Click **Export**
4. Choose **Google CSV** format
5. Click **Export**
6. Upload the downloaded file

**Simplified version for text:**
> "Go to contacts.google.com on your computer, click the menu, then Export. Choose Google CSV and upload that file."

---

### Samsung/Other Android (Local Contacts)

**Step-by-step:**
1. Open the **Contacts** app
2. Tap the **three lines** (≡) or **Settings**
3. Look for **Manage contacts** or **Import/Export**
4. Tap **Export** or **Export to file**
5. Save as VCF (vCard) or CSV
6. Upload the file

**Note:** Samsung steps vary by Android version. If they're stuck:
> "Samsung's export steps vary by phone model. The easiest path might be to sync your contacts to Google Contacts first, then export from there."

---

### Outlook/Desktop Contacts

**Step-by-step:**
1. Open **Outlook**
2. Go to **File > Open & Export > Import/Export**
3. Choose **Export to a file**
4. Choose **Comma Separated Values**
5. Select your contacts folder
6. Save the file
7. Upload to dashboard

---

## 4. Decision Tree / Conversation Flow

Use these questions to quickly assess the user's situation. Ask them conversationally — not as a checklist.

### Opening Question
> "Tell me about your network — who are the people you want to stay connected to?"

**Listen for:** Size signals, focus (personal/professional), energy level about the task

### Size Assessment
> "Roughly how many people are we talking about? Hundreds, dozens, or just a core group?"

**Route based on answer:**
- Hundreds → CSV/vCard path
- Dozens → Flexible, lean toward import
- Core group → Manual path

### Source Assessment
> "Where do your contacts live right now? All in your phone, scattered around, or do you have a list somewhere?"

**Route based on answer:**
- Phone → vCard/Google export
- Spreadsheet → CSV upload
- Scattered/head → Braindump or manual
- "I don't know" → Discovery conversation

### Organization Assessment
> "Are they organized in any way, or is it one big pile?"

**Route based on answer:**
- Organized → Import path, leverage existing groups
- One big pile → Braindump or start with key people
- "Total chaos" → Start small, expand later

### Goal Check
> "What's the main goal here — staying close to family and friends, keeping up with professional contacts, or both?"

**Use this to:** Tailor language and examples, emphasize relevant features

---

## 5. Response Templates by Scenario

### Big Network + Tech Savvy
> "Got it — with that many contacts, the fastest path is CSV upload. If you've already got them in a spreadsheet, great. If not, you can export from your phone or Google Contacts. The import page has a template if you need it. Want the link, or do you want me to walk you through the export steps?"

### Big Network + Needs Guidance
> "No worries, I'll make this easy. Here's what we'll do: I'll send you a link to the import page. There's a template you can download — it's just name, phone, email, and notes. Fill in who you've got, upload it, and I'll take it from there. Sound good? If you get stuck on the export, just text me and I'll walk you through it."

### Medium Network + Flexible
> "Here's what I'd suggest: start with your most important people — the 10-15 you really want to stay close to. We can do that right now over text. Once you've got a feel for how this works, you can upload the rest from a CSV whenever you're ready. Does that work?"

### Small Network / Key People
> "Perfect — sounds like we can do this the easy way. Just tell me about the people who matter most. Their name, how you know them, and roughly how often you want to hear from me about them. We'll go one by one."

### Starting Fresh / Discovery Mode
> "Let's figure this out together. Think about the people you'd hate to lose touch with — who comes to mind first? Don't worry about being complete, just start with whoever surfaces."

### Chaos Mode / Overwhelmed
> "Totally fine — you don't have to organize anything. Here's what I'd do: just brain-dump everything. Names, how you know people, random notes — whatever comes to mind. I'll sort through it and pull out the people. Sound easier?"

### vCard Export Pitch
> "Since they're all in your phone, the easiest thing is to export them as a vCard. It takes about 2 minutes. Want me to walk you through it, or do you want to give it a shot and text me if you get stuck?"

### Google Contacts Pitch
> "If they're in Google, you can connect directly — one click and I'll pull everyone in. [When built: Here's the link.] [Until built: That feature's coming soon — for now, you can export a CSV from contacts.google.com and upload it.]"

### Hybrid Approach Pitch
> "Here's my suggestion: let's get your core people set up first — the ones you'd notice if you lost touch. We can do that now, takes 5 minutes. Then whenever you want to add more, you can upload from your phone or a spreadsheet. Best of both worlds."

---

## 6. URLs and Links

> **Note:** Replace `{{DASHBOARD_URL}}` with the actual dashboard base URL when deploying.

| Page | URL | Use Case |
|------|-----|----------|
| **Dashboard Home** | `{{DASHBOARD_URL}}/` | General access, overview |
| **Import Page** | `{{DASHBOARD_URL}}/import` | CSV/vCard upload |
| **Braindump Page** | `{{DASHBOARD_URL}}/braindump` | Unstructured contact entry |
| **Contacts Page** | `{{DASHBOARD_URL}}/contacts` | View/manage contacts |
| **Settings** | `{{DASHBOARD_URL}}/settings` | User preferences |

---

## 7. Dunbar Layer Quick Reference

When discussing how often to stay in touch, use these research-backed defaults:

| Layer | Label | Size | Default Cadence | Description |
|-------|-------|------|-----------------|-------------|
| **Inner Circle** | Support Clique | ~5 | Weekly | Your closest people — the ones you turn to first |
| **Nurture** | Sympathy Group | ~15 | Every 2 weeks | Relationships you're actively investing in |
| **Maintain** | Affinity Group | ~50 | Monthly | Stable relationships that stay warm with regular check-ins |
| **Transactional** | Active Network | ~150 | Quarterly | Purpose-driven connections — you reach out when there's a reason |

**How to use in conversation:**
> "For your inner circle — maybe 5 people — I'll nudge you weekly. For people you're actively building relationships with, every couple weeks. Everyone else, monthly or quarterly depending on how close you want to stay."

---

## 8. Special Considerations

### Kin vs. Non-Kin
Family relationships are more resilient to gaps in contact. Bethany's thresholds are relaxed for kin:
> "Family's forgiving — a month without calling your cousin doesn't hurt the relationship the way it might with a friend. I adjust for that."

### New Relationships
Recently added contacts get tighter cadence windows during the first 6 months:
> "New relationships need more attention to solidify. I'll nudge you a bit more often at first, then ease up once the relationship is established."

### Circles
Users can organize contacts into custom circles (Family, Friends, Work, Book Club, etc.):
> "You can group people into circles if that helps — Family, Work, whatever makes sense for you. Or just let me figure it out based on what you tell me."

---

## 9. Handling Edge Cases

### User wants to import everything
> "I can handle that — just know that importing 1,000 contacts means you'll need to sort through them to tell me who actually matters. Most people find it easier to start with their key 50-100 and add more as needed."

### User has contacts in multiple places
> "No problem. You can import from multiple sources — do your phone contacts first, then add a CSV later. They'll merge automatically if there are duplicates."

### User doesn't know how many contacts they have
> "That's fine — you don't need an exact count. Are we talking about a handful of close people, a couple hundred, or like... your entire LinkedIn network?"

### User is skeptical about privacy
> "Your contacts stay private — I use them to help you stay in touch, not for anything else. You can delete anyone at any time, and I don't share your data with anyone."

### User wants to start over
> "Totally fine. You can archive anyone you don't want to track anymore. Or if you want a fresh start, we can clear everything and rebuild from scratch."

---

## 10. Conversation Handoff to Regular Flow

When onboarding is complete, transition naturally:

> "Alright, you're all set up. I'll check in when someone's slipping off your radar. In the meantime, you can text me anytime to log an interaction, ask who's overdue, or add someone new. Welcome aboard."

**Key capabilities to mention:**
- Nudges when contacts are overdue
- "Who's overdue?" to check status
- Brain dump interactions ("Had coffee with Jake, talked about his new job")
- Add new contacts via text
- Draft messages when they're stuck on what to say

---

*Last updated: February 2026*
*For: Bethany AI Assistant — Network Manager*
