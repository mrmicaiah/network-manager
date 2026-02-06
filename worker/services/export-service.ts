/**
 * Contact Export Service — CSV export with filtering.
 *
 * Exports a user's contacts to CSV format with support for filtering by
 * circle, intent, health status, contact kind, and archived state.
 *
 * All fields from the contact row are included plus resolved circle names.
 * The CSV uses RFC 4180 formatting (double-quote escaping, CRLF line endings).
 *
 * Security:
 *   - All queries are scoped by userId. No cross-user data access.
 *   - Requires authenticated session (enforced by caller/route handler).
 *
 * Usage:
 *
 *   const csv = await exportContacts(db, userId, {
 *     intent: 'inner_circle',
 *     health_status: 'red',
 *   });
 *
 *   return new Response(csv, {
 *     headers: {
 *       'Content-Type': 'text/csv; charset=utf-8',
 *       'Content-Disposition': 'attachment; filename="contacts.csv"',
 *     },
 *   });
 *
 * @see shared/models.ts for ContactRow, ContactListFilters
 * @see worker/services/contact-service.ts for the underlying contact queries
 */

import type {
  ContactRow,
  ContactListFilters,
  IntentType,
  HealthStatus,
  ContactKind,
} from '../../shared/models';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Export filters — same shape as ContactListFilters with an added
 * contact_kind option for kin/non-kin filtering.
 */
export interface ExportFilters {
  circle_id?: string;
  intent?: IntentType;
  health_status?: HealthStatus;
  contact_kind?: ContactKind;
  archived?: boolean;
  search?: string;
}

/**
 * Raw row returned from the export query — contact fields + circle names.
 */
interface ExportRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  intent: IntentType;
  custom_cadence_days: number | null;
  last_contact_date: string | null;
  health_status: HealthStatus;
  contact_kind: ContactKind;
  notes: string | null;
  source: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  circle_names: string | null; // Comma-separated from GROUP_CONCAT
}

// ===========================================================================
// CSV Column Definitions
// ===========================================================================

const CSV_COLUMNS: Array<{ header: string; key: keyof ExportRow | '_circles' }> = [
  { header: 'Name', key: 'name' },
  { header: 'Phone', key: 'phone' },
  { header: 'Email', key: 'email' },
  { header: 'Intent', key: 'intent' },
  { header: 'Health Status', key: 'health_status' },
  { header: 'Contact Kind', key: 'contact_kind' },
  { header: 'Custom Cadence (Days)', key: 'custom_cadence_days' },
  { header: 'Last Contact Date', key: 'last_contact_date' },
  { header: 'Circles', key: '_circles' },
  { header: 'Notes', key: 'notes' },
  { header: 'Source', key: 'source' },
  { header: 'Archived', key: 'archived' },
  { header: 'Created', key: 'created_at' },
  { header: 'Updated', key: 'updated_at' },
  { header: 'ID', key: 'id' },
];

// ===========================================================================
// Main Export Function
// ===========================================================================

/**
 * Export contacts as a CSV string.
 *
 * Runs a single query with a LEFT JOIN to contact_circles and circles,
 * using GROUP_CONCAT to roll up circle names into a comma-separated
 * string per contact. This avoids N+1 queries.
 *
 * @param db      - D1 database binding
 * @param userId  - The owning user's ID
 * @param filters - Optional filters to narrow the export
 * @returns CSV string (RFC 4180 — CRLF line endings, double-quote escaping)
 */
export async function exportContacts(
  db: D1Database,
  userId: string,
  filters?: ExportFilters,
): Promise<string> {
  // Build WHERE clause
  const conditions: string[] = ['c.user_id = ?'];
  const binds: unknown[] = [userId];

  // Archived filter — default to non-archived only
  const showArchived = filters?.archived ?? false;
  conditions.push('c.archived = ?');
  binds.push(showArchived ? 1 : 0);

  if (filters?.intent) {
    conditions.push('c.intent = ?');
    binds.push(filters.intent);
  }

  if (filters?.health_status) {
    conditions.push('c.health_status = ?');
    binds.push(filters.health_status);
  }

  if (filters?.contact_kind) {
    conditions.push('c.contact_kind = ?');
    binds.push(filters.contact_kind);
  }

  if (filters?.search) {
    conditions.push('c.name LIKE ?');
    binds.push(`%${filters.search}%`);
  }

  // Circle filter — uses HAVING with GROUP_CONCAT or a subquery
  let circleFilter = '';
  if (filters?.circle_id) {
    circleFilter = `AND c.id IN (
      SELECT contact_id FROM contact_circles WHERE circle_id = ?
    )`;
    binds.push(filters.circle_id);
  }

  const whereClause = conditions.join(' AND ');

  const { results } = await db
    .prepare(
      `SELECT
         c.id,
         c.name,
         c.phone,
         c.email,
         c.intent,
         c.custom_cadence_days,
         c.last_contact_date,
         c.health_status,
         c.contact_kind,
         c.notes,
         c.source,
         c.archived,
         c.created_at,
         c.updated_at,
         GROUP_CONCAT(ci.name, ', ') as circle_names
       FROM contacts c
       LEFT JOIN contact_circles cc ON c.id = cc.contact_id
       LEFT JOIN circles ci ON cc.circle_id = ci.id
       WHERE ${whereClause} ${circleFilter}
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE ASC`
    )
    .bind(...binds)
    .all<ExportRow>();

  return buildCsv(results);
}

// ===========================================================================
// CSV Building
// ===========================================================================

/**
 * Build a CSV string from export rows.
 *
 * Follows RFC 4180:
 *   - Fields containing commas, quotes, or newlines are double-quoted
 *   - Double quotes within fields are escaped as ""
 *   - Lines terminated with CRLF
 *   - UTF-8 BOM prepended for Excel compatibility
 */
function buildCsv(rows: ExportRow[]): string {
  const lines: string[] = [];

  // Header row
  lines.push(CSV_COLUMNS.map((col) => escapeField(col.header)).join(','));

  // Data rows
  for (const row of rows) {
    const fields = CSV_COLUMNS.map((col) => {
      if (col.key === '_circles') {
        return escapeField(row.circle_names ?? '');
      }

      const value = row[col.key as keyof ExportRow];

      if (value === null || value === undefined) {
        return '';
      }

      // Convert archived from 0/1 to readable
      if (col.key === 'archived') {
        return escapeField(value === 1 ? 'Yes' : 'No');
      }

      return escapeField(String(value));
    });

    lines.push(fields.join(','));
  }

  // UTF-8 BOM + CRLF line endings
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/**
 * Escape a CSV field per RFC 4180.
 *
 * Wraps the field in double quotes if it contains commas, double quotes,
 * or newlines. Double quotes within the field are escaped as "".
 */
function escapeField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}
