/**
 * Audit Service — admin action logging
 *
 * Writes immutable records to the admin_audit_log table for
 * accountability and debugging. Every admin action should be
 * logged through this service.
 *
 * The service extracts IP address and user agent from the request
 * object automatically. The `details` field stores a JSON blob
 * of what changed (before/after state, parameters, etc.).
 *
 * @see shared/models.ts for AdminAuditLogRow, CreateAuditLogInput
 * @see migrations/0010_rbac_tables.sql for the audit log table
 */

import type { AdminAuditLogRow } from '../../shared/models';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Input for logging an admin action.
 * Accepts either a raw Request for IP/UA extraction, or explicit strings.
 */
export interface LogActionInput {
  /** Who performed the action (user UUID) */
  userId: string;
  /** Action identifier (e.g., 'user.update', 'role.assign') */
  action: string;
  /** Type of resource affected (e.g., 'user', 'role') */
  resourceType?: string;
  /** ID of the affected resource */
  resourceId?: string;
  /** Structured details — what changed, parameters, before/after */
  details?: Record<string, unknown>;
  /** Raw request (for automatic IP/UA extraction) */
  request?: Request;
  /** Explicit IP address (overrides request extraction) */
  ipAddress?: string;
  /** Explicit user agent (overrides request extraction) */
  userAgent?: string;
}

/**
 * An audit log entry as returned by query functions.
 */
export interface AuditLogEntry extends AdminAuditLogRow {
  /** Parsed details object (convenience — raw is JSON string) */
  parsed_details: Record<string, unknown> | null;
}

// ===========================================================================
// Write
// ===========================================================================

/**
 * Log an admin action to the audit trail.
 *
 * This is fire-and-forget safe — callers can `.catch()` without
 * blocking the response. The audit log is append-only; entries
 * are never updated or deleted.
 *
 * @param db    - D1 database binding
 * @param input - Action details
 * @returns The created audit log entry ID
 *
 * @example
 * await logAdminAction(env.DB, {
 *   userId: admin.id,
 *   action: 'user.update',
 *   resourceType: 'user',
 *   resourceId: targetUser.id,
 *   details: {
 *     field: 'subscription_tier',
 *     before: 'free',
 *     after: 'premium',
 *   },
 *   request,
 * });
 */
export async function logAdminAction(
  db: D1Database,
  input: LogActionInput,
): Promise<string> {
  const id = crypto.randomUUID();

  // Extract IP and user agent from request if not explicitly provided
  const ipAddress = input.ipAddress ?? extractIpAddress(input.request);
  const userAgent = input.userAgent ?? input.request?.headers.get('User-Agent') ?? null;

  // Serialize details to JSON string
  const detailsJson = input.details ? JSON.stringify(input.details) : null;

  await db
    .prepare(
      `INSERT INTO admin_audit_log
         (id, user_id, action, resource_type, resource_id, details, ip_address, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      id,
      input.userId,
      input.action,
      input.resourceType ?? null,
      input.resourceId ?? null,
      detailsJson,
      ipAddress,
      userAgent,
    )
    .run();

  return id;
}

// ===========================================================================
// Read
// ===========================================================================

/**
 * Query audit log entries with optional filters.
 *
 * @param db      - D1 database binding
 * @param filters - Optional filters
 * @returns Array of audit log entries, newest first
 *
 * @example
 * // All actions by a specific admin
 * const entries = await getAuditLog(env.DB, { userId: admin.id, limit: 50 });
 *
 * // All actions on a specific user
 * const entries = await getAuditLog(env.DB, { resourceType: 'user', resourceId: targetId });
 */
export async function getAuditLog(
  db: D1Database,
  filters?: {
    userId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    limit?: number;
    offset?: number;
  },
): Promise<AuditLogEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.userId) {
    conditions.push('user_id = ?');
    params.push(filters.userId);
  }

  if (filters?.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }

  if (filters?.resourceType) {
    conditions.push('resource_type = ?');
    params.push(filters.resourceType);
  }

  if (filters?.resourceId) {
    conditions.push('resource_id = ?');
    params.push(filters.resourceId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const rows = await db
    .prepare(
      `SELECT * FROM admin_audit_log
       ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all<AdminAuditLogRow>();

  return (rows.results ?? []).map((row) => ({
    ...row,
    parsed_details: row.details ? safeJsonParse(row.details) : null,
  }));
}

/**
 * Count audit log entries matching filters.
 * Useful for pagination.
 */
export async function countAuditLog(
  db: D1Database,
  filters?: {
    userId?: string;
    action?: string;
    resourceType?: string;
    resourceId?: string;
  },
): Promise<number> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.userId) {
    conditions.push('user_id = ?');
    params.push(filters.userId);
  }

  if (filters?.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }

  if (filters?.resourceType) {
    conditions.push('resource_type = ?');
    params.push(filters.resourceType);
  }

  if (filters?.resourceId) {
    conditions.push('resource_id = ?');
    params.push(filters.resourceId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await db
    .prepare(`SELECT COUNT(*) as count FROM admin_audit_log ${where}`)
    .bind(...params)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Extract the client IP address from a Cloudflare Workers request.
 *
 * Checks headers in order:
 *   1. CF-Connecting-IP (Cloudflare's real client IP)
 *   2. X-Forwarded-For (first entry)
 *   3. X-Real-IP
 *
 * Returns null if no IP can be determined.
 */
function extractIpAddress(request?: Request): string | null {
  if (!request) return null;

  // Cloudflare's own header — most reliable
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp;

  // X-Forwarded-For (may be comma-separated, first is the client)
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) {
    const firstIp = xff.split(',')[0]?.trim();
    if (firstIp) return firstIp;
  }

  // X-Real-IP fallback
  const realIp = request.headers.get('X-Real-IP');
  if (realIp) return realIp;

  return null;
}

/**
 * Safely parse a JSON string, returning null on failure.
 */
function safeJsonParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
