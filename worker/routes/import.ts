/**
 * Import API Routes — CSV Upload and Bulk Import Flow Management
 *
 * Handles:
 *   - CSV file upload and parsing
 *   - Bulk contact creation from CSV
 *   - Triggering the guided import flow (via bulk-import-flow.ts)
 *   - Batch operations for imported contacts
 *
 * Entry points:
 *
 *   POST /api/import/csv              — Upload and parse CSV
 *   POST /api/import/start-flow       — Trigger Bethany's guided organization
 *   GET  /api/import/status           — Get current import flow state
 *   POST /api/import/batch-assign     — Assign multiple contacts to circle
 *
 * CSV Format Expected:
 *   name (required), phone, email, notes
 *   Flexible headers — will match common variations
 *
 * @see worker/services/bulk-import-flow.ts for conversation flow
 */

import type { Env } from '../../shared/types';
import type { UserRow, CreateContactInput } from '../../shared/models';
import { jsonResponse, errorResponse } from '../../shared/http';
import { createContact, searchContacts } from '../services/contact-service';
import {
  startBulkImportFlow,
  hasActiveBulkImport,
  getBulkImportContext,
  notifyBulkUploadComplete,
  batchAssignToCircle,
  countUnsortedImports,
} from '../services/bulk-import-flow';

// ===========================================================================
// Types
// ===========================================================================

interface ParsedContact {
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
}

interface CsvParseResult {
  valid: ParsedContact[];
  invalid: Array<{ row: number; reason: string; data: Record<string, string> }>;
  duplicates: Array<{ name: string; existingId: string }>;
}

interface ImportResult {
  imported: number;
  duplicatesSkipped: number;
  invalidRows: number;
  contactIds: string[];
}

// ===========================================================================
// Main Handler
// ===========================================================================

/**
 * Handle /api/import/* routes.
 */
export async function handleImportRoute(
  request: Request,
  env: Env,
  user: UserRow,
  path: string,
): Promise<Response> {
  const method = request.method;

  try {
    // POST /api/import/csv — Upload and process CSV
    if (path === '/api/import/csv' && method === 'POST') {
      return handleCsvUpload(request, env, user);
    }

    // POST /api/import/start-flow — Start the guided import flow
    if (path === '/api/import/start-flow' && method === 'POST') {
      return handleStartFlow(request, env, user);
    }

    // GET /api/import/status — Get import flow status
    if (path === '/api/import/status' && method === 'GET') {
      return handleGetStatus(env, user);
    }

    // POST /api/import/batch-assign — Batch assign contacts to circle
    if (path === '/api/import/batch-assign' && method === 'POST') {
      return handleBatchAssign(request, env, user);
    }

    // GET /api/import/unsorted — Get unsorted contact count
    if (path === '/api/import/unsorted' && method === 'GET') {
      return handleGetUnsorted(env, user);
    }

    return errorResponse('Not found', 404);
  } catch (err) {
    console.error(`[import] ${method} ${path} error:`, err);
    return errorResponse('Import operation failed', 500);
  }
}

// ===========================================================================
// CSV Upload Handler
// ===========================================================================

/**
 * Handle CSV file upload.
 *
 * Accepts multipart form data with a 'file' field containing the CSV.
 * Parses, validates, deduplicates, and creates contacts.
 */
async function handleCsvUpload(
  request: Request,
  env: Env,
  user: UserRow,
): Promise<Response> {
  const contentType = request.headers.get('content-type') || '';

  // Handle multipart form data
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return errorResponse('No file uploaded', 400);
    }

    const csvText = await file.text();
    return processCsvText(csvText, env, user, formData.get('sendSms') === 'true');
  }

  // Handle raw CSV text
  if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
    const csvText = await request.text();
    return processCsvText(csvText, env, user, false);
  }

  // Handle JSON with CSV content
  if (contentType.includes('application/json')) {
    const body = await request.json<{ csv: string; sendSms?: boolean }>();
    if (!body.csv) {
      return errorResponse('Missing csv field', 400);
    }
    return processCsvText(body.csv, env, user, body.sendSms ?? false);
  }

  return errorResponse('Unsupported content type. Use multipart/form-data, text/csv, or application/json', 400);
}

/**
 * Process CSV text and create contacts.
 */
async function processCsvText(
  csvText: string,
  env: Env,
  user: UserRow,
  sendSms: boolean,
): Promise<Response> {
  // Parse CSV
  const parseResult = parseCsv(csvText);

  if (parseResult.valid.length === 0) {
    return jsonResponse({
      data: {
        imported: 0,
        duplicatesSkipped: 0,
        invalidRows: parseResult.invalid.length,
        errors: parseResult.invalid.slice(0, 10), // First 10 errors
        message: 'No valid contacts found in CSV',
      },
    }, 400);
  }

  // Check for existing contacts (dedupe)
  const existingContacts = await findExistingContacts(env.DB, user.id, parseResult.valid);

  // Filter out duplicates
  const existingNames = new Set(existingContacts.map(c => c.name.toLowerCase()));
  const toCreate = parseResult.valid.filter(
    c => !existingNames.has(c.name.toLowerCase())
  );

  // Create contacts
  const contactIds: string[] = [];
  for (const parsed of toCreate) {
    try {
      const contact = await createContact(env.DB, user.id, {
        name: parsed.name,
        phone: parsed.phone || undefined,
        email: parsed.email || undefined,
        notes: parsed.notes || undefined,
        source: 'import',
      });
      contactIds.push(contact.id);
    } catch (err) {
      console.error(`[import] Failed to create contact ${parsed.name}:`, err);
    }
  }

  const result: ImportResult = {
    imported: contactIds.length,
    duplicatesSkipped: existingContacts.length,
    invalidRows: parseResult.invalid.length,
    contactIds,
  };

  // Optionally trigger the guided flow with SMS
  let flowMessage: string | null = null;
  if (sendSms && contactIds.length > 0) {
    const flowResult = await notifyBulkUploadComplete(env, user, {
      imported: result.imported,
      duplicatesSkipped: result.duplicatesSkipped,
    }, true);
    flowMessage = flowResult.message;
  }

  return jsonResponse({
    data: {
      ...result,
      flowMessage,
      errors: parseResult.invalid.slice(0, 10),
    },
  }, 201);
}

// ===========================================================================
// Flow Management Handlers
// ===========================================================================

/**
 * Start the guided import flow (triggered from dashboard).
 */
async function handleStartFlow(
  request: Request,
  env: Env,
  user: UserRow,
): Promise<Response> {
  const body = await request.json<{
    imported: number;
    duplicatesSkipped: number;
    sendSms?: boolean;
  }>();

  const result = await notifyBulkUploadComplete(
    env,
    user,
    {
      imported: body.imported || 0,
      duplicatesSkipped: body.duplicatesSkipped || 0,
    },
    body.sendSms ?? true,
  );

  return jsonResponse({ data: result });
}

/**
 * Get current import flow status.
 */
async function handleGetStatus(
  env: Env,
  user: UserRow,
): Promise<Response> {
  const hasActive = await hasActiveBulkImport(env, user.id);
  const context = hasActive ? await getBulkImportContext(env, user.id) : null;
  const unsortedCount = await countUnsortedImports(env.DB, user.id);

  return jsonResponse({
    data: {
      hasActiveFlow: hasActive,
      context,
      unsortedCount,
    },
  });
}

/**
 * Get unsorted contact count.
 */
async function handleGetUnsorted(
  env: Env,
  user: UserRow,
): Promise<Response> {
  const count = await countUnsortedImports(env.DB, user.id);

  return jsonResponse({
    data: { unsortedCount: count },
  });
}

/**
 * Batch assign contacts to a circle.
 */
async function handleBatchAssign(
  request: Request,
  env: Env,
  user: UserRow,
): Promise<Response> {
  const body = await request.json<{
    contactIds: string[];
    circleId: string;
    intent?: string;
  }>();

  if (!body.contactIds || body.contactIds.length === 0) {
    return errorResponse('contactIds array is required', 400);
  }
  if (!body.circleId) {
    return errorResponse('circleId is required', 400);
  }

  const result = await batchAssignToCircle(
    env,
    user.id,
    body.contactIds,
    body.circleId,
    body.intent as any,
  );

  return jsonResponse({ data: result });
}

// ===========================================================================
// CSV Parsing
// ===========================================================================

/**
 * Parse CSV text into contact objects.
 *
 * Handles:
 * - Various header formats (Name, name, NAME, Full Name, etc.)
 * - Quoted fields with commas
 * - Empty rows
 * - Missing required fields
 */
function parseCsv(csvText: string): CsvParseResult {
  const lines = csvText.split(/\r?\n/).filter(line => line.trim());
  
  if (lines.length < 2) {
    return { valid: [], invalid: [], duplicates: [] };
  }

  // Parse header row
  const headers = parseRow(lines[0]).map(h => normalizeHeader(h));
  
  // Find column indices
  const nameCol = findColumn(headers, ['name', 'full name', 'fullname', 'contact', 'person']);
  const phoneCol = findColumn(headers, ['phone', 'mobile', 'cell', 'telephone', 'phone number']);
  const emailCol = findColumn(headers, ['email', 'e-mail', 'mail', 'email address']);
  const notesCol = findColumn(headers, ['notes', 'note', 'comments', 'comment', 'description']);

  if (nameCol === -1) {
    return {
      valid: [],
      invalid: [{ row: 1, reason: 'No name column found in header', data: { header: lines[0] } }],
      duplicates: [],
    };
  }

  const valid: ParsedContact[] = [];
  const invalid: CsvParseResult['invalid'] = [];

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(lines[i]);
    const rowData: Record<string, string> = {};
    headers.forEach((h, idx) => { rowData[h] = row[idx] || ''; });

    const name = row[nameCol]?.trim();
    if (!name) {
      invalid.push({ row: i + 1, reason: 'Missing name', data: rowData });
      continue;
    }

    valid.push({
      name,
      phone: phoneCol >= 0 ? normalizePhone(row[phoneCol]) : undefined,
      email: emailCol >= 0 ? row[emailCol]?.trim() || undefined : undefined,
      notes: notesCol >= 0 ? row[notesCol]?.trim() || undefined : undefined,
    });
  }

  return { valid, invalid, duplicates: [] };
}

/**
 * Parse a CSV row, handling quoted fields.
 */
function parseRow(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Normalize a header string for matching.
 */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, ' ').trim();
}

/**
 * Find a column index by matching against multiple possible names.
 */
function findColumn(headers: string[], names: string[]): number {
  for (const name of names) {
    const idx = headers.findIndex(h => h.includes(name));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Normalize a phone number (basic cleanup).
 */
function normalizePhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  
  // Strip non-digits except leading +
  let cleaned = phone.trim();
  const hasPlus = cleaned.startsWith('+');
  cleaned = cleaned.replace(/[^\d]/g, '');
  
  if (!cleaned) return undefined;
  
  // Add country code if needed
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
    return '+' + cleaned;
  } else if (hasPlus) {
    return '+' + cleaned;
  }
  
  return cleaned;
}

// ===========================================================================
// Deduplication
// ===========================================================================

/**
 * Find contacts that already exist (by name match).
 */
async function findExistingContacts(
  db: D1Database,
  userId: string,
  contacts: ParsedContact[],
): Promise<Array<{ name: string; id: string }>> {
  if (contacts.length === 0) return [];

  // Get all existing contact names (case-insensitive)
  const { results } = await db
    .prepare(
      `SELECT id, name FROM contacts
       WHERE user_id = ? AND archived = 0`
    )
    .bind(userId)
    .all<{ id: string; name: string }>();

  const existingByName = new Map<string, string>();
  for (const r of results) {
    existingByName.set(r.name.toLowerCase(), r.id);
  }

  // Find matches
  const duplicates: Array<{ name: string; id: string }> = [];
  for (const c of contacts) {
    const existing = existingByName.get(c.name.toLowerCase());
    if (existing) {
      duplicates.push({ name: c.name, id: existing });
    }
  }

  return duplicates;
}
