/**
 * Contact Analysis Service — Bethany's suggestions for contact review.
 *
 * Analyzes contacts to generate suggested intents with confidence levels
 * and human-readable reasoning. Used by the guided contact review flow
 * where Bethany presents unsorted contacts with recommendations.
 *
 * Signals evaluated:
 *   - Family name matching (shared surnames)
 *   - Work email domain detection
 *   - Recent interaction history
 *   - Google starred contacts (if imported)
 *   - Contact frequency tier
 *   - Birthday presence
 *   - Notes presence
 *
 * @see shared/models.ts for ContactAnalysisRow, ContactAnalysisSignals
 * @see shared/intent-config.ts for IntentType definitions
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
  ContactRow,
  ContactAnalysisRow,
  ContactAnalysisSignals,
  ContactAnalysisWithSignals,
  ContactWithAnalysis,
  SortableIntentType,
  AnalysisConfidence,
  ContactFrequencyTier,
} from '../../shared/models';

// ===========================================================================
// Constants
// ===========================================================================

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me',
  'live.com', 'msn.com', 'mail.com', 'ymail.com', 'zoho.com',
  'fastmail.com', 'tutanota.com',
]);

const FAMILY_KEYWORDS = new Set([
  'mom', 'mother', 'mama', 'ma', 'dad', 'father', 'papa', 'pa', 'pop',
  'sister', 'sis', 'brother', 'bro', 'grandma', 'grandmother', 'granny',
  'nana', 'grandpa', 'grandfather', 'gramps', 'aunt', 'auntie', 'uncle',
  'cousin', 'wife', 'husband', 'spouse', 'son', 'daughter', 'nephew', 'niece',
]);

const RECENT_INTERACTION_DAYS = 30;

const FREQUENCY_THRESHOLDS = {
  high: 6,
  medium: 2,
  low: 1,
} as const;

/** Max bind parameters for D1 queries (leaving margin for safety) */
const MAX_BIND_PARAMS = 90;

// ===========================================================================
// Signal Detection
// ===========================================================================

function extractSurname(name: string): string | null {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return parts[parts.length - 1].toLowerCase();
}

function hasFamilyKeyword(name: string): boolean {
  const nameLower = name.toLowerCase();
  const words = nameLower.split(/\s+/);
  return words.some(word => FAMILY_KEYWORDS.has(word));
}

function isWorkEmail(email: string | null): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return !PERSONAL_EMAIL_DOMAINS.has(domain);
}

function findSharedSurnameContacts(
  contact: ContactRow,
  allContacts: ContactRow[],
): string[] {
  const surname = extractSurname(contact.name);
  if (!surname) return [];

  return allContacts
    .filter(c => c.id !== contact.id)
    .filter(c => {
      const otherSurname = extractSurname(c.name);
      return otherSurname === surname;
    })
    .map(c => c.id);
}

function calculateFrequencyTier(interactionCount: number): ContactFrequencyTier {
  if (interactionCount >= FREQUENCY_THRESHOLDS.high) return 'high';
  if (interactionCount >= FREQUENCY_THRESHOLDS.medium) return 'medium';
  if (interactionCount >= FREQUENCY_THRESHOLDS.low) return 'low';
  return 'unknown';
}

// ===========================================================================
// Analysis Logic
// ===========================================================================

export function analyzeContactSignals(
  contact: ContactRow,
  allContacts: ContactRow[],
  interactionCount: number,
  hasRecentInteraction: boolean,
  googleStarred: boolean = false,
  hasBirthday: boolean = false,
): ContactAnalysisSignals {
  const sharedSurnameContacts = findSharedSurnameContacts(contact, allContacts);

  return {
    family_name_match: sharedSurnameContacts.length >= 2 || hasFamilyKeyword(contact.name),
    work_email_domain: isWorkEmail(contact.email),
    has_recent_interaction: hasRecentInteraction,
    google_starred: googleStarred,
    contact_frequency_tier: calculateFrequencyTier(interactionCount),
    has_birthday: hasBirthday,
    has_notes: !!contact.notes && contact.notes.trim().length > 0,
    shared_surname_contacts: sharedSurnameContacts,
  };
}

export function suggestIntent(signals: ContactAnalysisSignals): SortableIntentType {
  if (signals.family_name_match) {
    if (signals.contact_frequency_tier === 'high') return 'inner_circle';
    if (signals.contact_frequency_tier !== 'unknown') return 'nurture';
    return 'maintain';
  }

  if (signals.work_email_domain) {
    if (!signals.google_starred && !signals.has_birthday && signals.contact_frequency_tier !== 'high') {
      return 'transactional';
    }
  }

  if (signals.contact_frequency_tier === 'high') {
    if (signals.google_starred || signals.has_birthday) return 'inner_circle';
    return 'nurture';
  }

  if (signals.contact_frequency_tier === 'medium') {
    if (signals.google_starred || signals.has_notes) return 'nurture';
    return 'maintain';
  }

  if (signals.contact_frequency_tier === 'low') {
    if (signals.work_email_domain) return 'transactional';
    return 'maintain';
  }

  if (signals.google_starred || signals.has_birthday) return 'nurture';
  if (signals.has_notes) return 'maintain';

  return 'dormant';
}

export function calculateConfidence(signals: ContactAnalysisSignals): AnalysisConfidence {
  let strongSignals = 0;
  let weakSignals = 0;

  if (signals.family_name_match) strongSignals++;
  if (signals.google_starred) strongSignals++;
  if (signals.contact_frequency_tier === 'high') strongSignals++;
  if (signals.has_birthday) strongSignals++;

  if (signals.work_email_domain) weakSignals++;
  if (signals.has_recent_interaction) weakSignals++;
  if (signals.has_notes) weakSignals++;
  if (signals.contact_frequency_tier === 'medium') weakSignals++;

  if (strongSignals >= 3 || (strongSignals >= 2 && weakSignals >= 2)) return 'high';
  if (strongSignals >= 1 || weakSignals >= 3) return 'medium';
  return 'low';
}

export function generateReasoning(
  signals: ContactAnalysisSignals,
  suggestedIntent: SortableIntentType,
): string {
  const reasons: string[] = [];

  if (signals.family_name_match) {
    if (signals.shared_surname_contacts.length >= 2) {
      reasons.push("Shares your last name with other contacts—family member?");
    } else {
      reasons.push("Name suggests a family relationship.");
    }
  }

  if (signals.contact_frequency_tier === 'high') {
    reasons.push("You've been in frequent contact—close relationship.");
  } else if (signals.contact_frequency_tier === 'medium') {
    reasons.push("You connect regularly—keeping this one warm.");
  } else if (signals.contact_frequency_tier === 'low') {
    reasons.push("Occasional contact—stable but not frequent.");
  }

  if (signals.work_email_domain && suggestedIntent === 'transactional') {
    reasons.push("Work email domain—professional contact?");
  }

  if (signals.google_starred) {
    reasons.push("You starred this contact—important to you.");
  }

  if (signals.has_birthday) {
    reasons.push("Birthday saved—you're keeping track of them.");
  }

  if (signals.has_notes && reasons.length < 2) {
    reasons.push("You've added notes—intentional relationship.");
  }

  if (signals.has_recent_interaction && reasons.length < 2) {
    reasons.push("Recent interaction logged—fresh connection.");
  }

  if (reasons.length === 0) {
    return "Not much info yet—tell me about them.";
  }

  return reasons.slice(0, 2).join(" ");
}

export interface ContactAnalysisResult {
  suggested_intent: SortableIntentType;
  confidence: AnalysisConfidence;
  reasoning: string;
  signals: ContactAnalysisSignals;
}

export function analyzeContact(
  contact: ContactRow,
  allContacts: ContactRow[],
  interactionCount: number,
  hasRecentInteraction: boolean,
  googleStarred: boolean = false,
  hasBirthday: boolean = false,
): ContactAnalysisResult {
  const signals = analyzeContactSignals(
    contact, allContacts, interactionCount, hasRecentInteraction, googleStarred, hasBirthday,
  );
  const suggested_intent = suggestIntent(signals);
  const confidence = calculateConfidence(signals);
  const reasoning = generateReasoning(signals, suggested_intent);

  return { suggested_intent, confidence, reasoning, signals };
}

// ===========================================================================
// Database Operations
// ===========================================================================

async function getInteractionStats(
  db: D1Database,
  contactId: string,
): Promise<{ count: number; hasRecent: boolean }> {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - RECENT_INTERACTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.prepare(`
    SELECT 
      COUNT(*) as count,
      MAX(CASE WHEN date >= ? THEN 1 ELSE 0 END) as has_recent
    FROM interactions
    WHERE contact_id = ? AND date >= ?
  `).bind(thirtyDaysAgo, contactId, ninetyDaysAgo).first<{
    count: number;
    has_recent: number;
  }>();

  return {
    count: result?.count ?? 0,
    hasRecent: (result?.has_recent ?? 0) === 1,
  };
}

export async function saveContactAnalysis(
  db: D1Database,
  contactId: string,
  analysis: ContactAnalysisResult,
): Promise<ContactAnalysisRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.prepare(`
    INSERT INTO contact_analysis (
      id, contact_id, suggested_intent, confidence, reasoning, signals,
      reviewed, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT (contact_id) DO UPDATE SET
      suggested_intent = excluded.suggested_intent,
      confidence = excluded.confidence,
      reasoning = excluded.reasoning,
      signals = excluded.signals,
      updated_at = excluded.updated_at
  `).bind(
    id, contactId, analysis.suggested_intent, analysis.confidence,
    analysis.reasoning, JSON.stringify(analysis.signals), now, now,
  ).run();

  const row = await db.prepare(`
    SELECT * FROM contact_analysis WHERE contact_id = ?
  `).bind(contactId).first<ContactAnalysisRow>();

  return row!;
}

/**
 * Query existing analyses in batches to avoid D1 bind parameter limits.
 * D1 has a limit of ~100 bind parameters per query.
 */
async function getExistingAnalysisIds(
  db: D1Database,
  contactIds: string[],
): Promise<Set<string>> {
  const analyzedIds = new Set<string>();

  // Process in batches to avoid D1 bind parameter limits
  for (let i = 0; i < contactIds.length; i += MAX_BIND_PARAMS) {
    const batch = contactIds.slice(i, i + MAX_BIND_PARAMS);
    const placeholders = batch.map(() => '?').join(',');
    
    const { results } = await db.prepare(`
      SELECT contact_id FROM contact_analysis WHERE contact_id IN (${placeholders})
    `).bind(...batch).all<{ contact_id: string }>();

    for (const row of results) {
      analyzedIds.add(row.contact_id);
    }
  }

  return analyzedIds;
}

export async function analyzeUserContacts(
  db: D1Database,
  userId: string,
): Promise<{ analyzed: number; skipped: number }> {
  const { results: contacts } = await db.prepare(`
    SELECT * FROM contacts
    WHERE user_id = ? AND intent = 'new' AND archived = 0
  `).bind(userId).all<ContactRow>();

  if (contacts.length === 0) return { analyzed: 0, skipped: 0 };

  const { results: allContacts } = await db.prepare(`
    SELECT * FROM contacts WHERE user_id = ? AND archived = 0
  `).bind(userId).all<ContactRow>();

  // Get existing analyses in batches (handles >100 contacts)
  const contactIds = contacts.map(c => c.id);
  const analyzedIds = await getExistingAnalysisIds(db, contactIds);

  let analyzed = 0;
  let skipped = 0;

  for (const contact of contacts) {
    if (analyzedIds.has(contact.id)) {
      skipped++;
      continue;
    }

    const stats = await getInteractionStats(db, contact.id);
    const analysis = analyzeContact(contact, allContacts, stats.count, stats.hasRecent);
    await saveContactAnalysis(db, contact.id, analysis);
    analyzed++;
  }

  return { analyzed, skipped };
}

export async function getNextReviewBatch(
  db: D1Database,
  userId: string,
  limit: number = 5,
): Promise<ContactWithAnalysis[]> {
  const { results } = await db.prepare(`
    SELECT 
      c.*,
      ca.id as analysis_id,
      ca.suggested_intent,
      ca.confidence,
      ca.reasoning,
      ca.signals,
      ca.reviewed,
      ca.reviewed_at,
      ca.user_accepted_suggestion,
      ca.created_at as analysis_created_at,
      ca.updated_at as analysis_updated_at
    FROM contacts c
    LEFT JOIN contact_analysis ca ON c.id = ca.contact_id
    WHERE c.user_id = ? 
      AND c.intent = 'new' 
      AND c.archived = 0
      AND (ca.reviewed IS NULL OR ca.reviewed = 0)
    ORDER BY
      CASE ca.confidence
        WHEN 'high' THEN 1
        WHEN 'medium' THEN 2
        WHEN 'low' THEN 3
        ELSE 4
      END,
      c.last_contact_date DESC NULLS LAST,
      c.created_at DESC
    LIMIT ?
  `).bind(userId, limit).all();

  return results.map((row: any) => {
    const contact: ContactRow = {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      intent: row.intent,
      custom_cadence_days: row.custom_cadence_days,
      last_contact_date: row.last_contact_date,
      health_status: row.health_status,
      contact_kind: row.contact_kind,
      preferred_method: row.preferred_method,
      notes: row.notes,
      source: row.source,
      archived: row.archived,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    let analysis: ContactAnalysisWithSignals | null = null;
    if (row.analysis_id) {
      analysis = {
        id: row.analysis_id,
        contact_id: row.id,
        suggested_intent: row.suggested_intent,
        confidence: row.confidence,
        reasoning: row.reasoning,
        signals: row.signals ? JSON.parse(row.signals) : null,
        reviewed: row.reviewed ?? 0,
        reviewed_at: row.reviewed_at,
        user_accepted_suggestion: row.user_accepted_suggestion,
        created_at: row.analysis_created_at,
        updated_at: row.analysis_updated_at,
      };
    }

    return { contact, analysis };
  });
}

export async function markReviewed(
  db: D1Database,
  contactId: string,
  acceptedSuggestion: boolean,
  chosenIntent: SortableIntentType,
): Promise<void> {
  const now = new Date().toISOString();

  await db.prepare(`
    UPDATE contact_analysis
    SET reviewed = 1, reviewed_at = ?, user_accepted_suggestion = ?, updated_at = ?
    WHERE contact_id = ?
  `).bind(now, acceptedSuggestion ? 1 : 0, now, contactId).run();

  await db.prepare(`
    UPDATE contacts SET intent = ?, updated_at = ? WHERE id = ?
  `).bind(chosenIntent, now, contactId).run();
}

export async function getContactAnalysis(
  db: D1Database,
  contactId: string,
): Promise<ContactAnalysisWithSignals | null> {
  const row = await db.prepare(`
    SELECT * FROM contact_analysis WHERE contact_id = ?
  `).bind(contactId).first<ContactAnalysisRow>();

  if (!row) return null;

  return { ...row, signals: row.signals ? JSON.parse(row.signals) : null };
}

export async function getUserReviewStats(
  db: D1Database,
  userId: string,
): Promise<{
  total_unsorted: number;
  reviewed: number;
  pending: number;
  accepted_suggestions: number;
  rejected_suggestions: number;
}> {
  const result = await db.prepare(`
    SELECT
      COUNT(*) as total_unsorted,
      SUM(CASE WHEN ca.reviewed = 1 THEN 1 ELSE 0 END) as reviewed,
      SUM(CASE WHEN ca.reviewed = 0 OR ca.reviewed IS NULL THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN ca.user_accepted_suggestion = 1 THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN ca.user_accepted_suggestion = 0 THEN 1 ELSE 0 END) as rejected
    FROM contacts c
    LEFT JOIN contact_analysis ca ON c.id = ca.contact_id
    WHERE c.user_id = ? AND c.intent = 'new' AND c.archived = 0
  `).bind(userId).first<{
    total_unsorted: number;
    reviewed: number;
    pending: number;
    accepted: number;
    rejected: number;
  }>();

  return {
    total_unsorted: result?.total_unsorted ?? 0,
    reviewed: result?.reviewed ?? 0,
    pending: result?.pending ?? 0,
    accepted_suggestions: result?.accepted ?? 0,
    rejected_suggestions: result?.rejected ?? 0,
  };
}
