/**
 * Web Dashboard Authentication Service
 *
 * Provides phone-based SMS verification login for the web dashboard.
 * No passwords — the user's phone number IS their identity (verified via SMS).
 *
 * Login flow:
 *
 *   1. User enters phone number on login page
 *   2. Server generates a 6-digit code, stores hashed in D1, sends via SendBlue
 *   3. User enters code on web
 *   4. Server verifies code, creates a JWT session token
 *   5. JWT stored in HttpOnly cookie (7-day expiry, refreshed on activity)
 *   6. Protected routes use requireAuth() middleware to validate session
 *
 * Security measures:
 *
 *   - Codes are 6-digit numeric, hashed with HMAC-SHA256 before storage
 *   - Codes expire in 10 minutes
 *   - Max 3 verification attempts per code
 *   - Max 5 code requests per phone per hour (rate limiting)
 *   - JWT signed with HMAC-SHA256, includes userId and phone
 *   - Sessions refresh on activity (sliding 7-day window)
 *   - HttpOnly, Secure, SameSite=Lax cookies
 *
 * Schema requirement:
 *
 *   This service requires a `verification_codes` table in D1.
 *   See the migration SQL in the file header or run:
 *
 *   ```sql
 *   CREATE TABLE IF NOT EXISTS verification_codes (
 *     id            TEXT PRIMARY KEY,
 *     phone         TEXT NOT NULL,
 *     code_hash     TEXT NOT NULL,
 *     attempts      INTEGER NOT NULL DEFAULT 0,
 *     status        TEXT NOT NULL DEFAULT 'pending'
 *       CHECK (status IN ('pending', 'verified', 'expired')),
 *     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
 *     expires_at    TEXT NOT NULL
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_verification_codes_phone
 *     ON verification_codes(phone, status, created_at DESC);
 *   ```
 *
 * @see shared/types.ts for Env bindings
 * @see worker/services/user-service.ts for getUserByPhone()
 * @see worker/services/trust-service.ts for HMAC utilities
 */

import type { Env } from '../../shared/types';
import type { UserRow } from '../../shared/models';
import { getUserByPhone } from './user-service';

// ===========================================================================
// Configuration
// ===========================================================================

/** Verification code length (digits) */
const CODE_LENGTH = 6;

/** Code expiry in minutes */
const CODE_EXPIRY_MINUTES = 10;

/** Max verification attempts per code */
const MAX_CODE_ATTEMPTS = 3;

/** Max code requests per phone per hour */
const MAX_CODES_PER_HOUR = 5;

/** JWT session duration in days */
const SESSION_DURATION_DAYS = 7;

/** How often to refresh the session (in days remaining) */
const SESSION_REFRESH_THRESHOLD_DAYS = 3;

/** Cookie name for the session JWT */
const SESSION_COOKIE_NAME = 'bnm_session';

// ===========================================================================
// Types
// ===========================================================================

/**
 * JWT payload stored in the session token.
 */
export interface SessionPayload {
  /** User ID (UUID) */
  sub: string;
  /** Phone number (E.164) */
  phone: string;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** Expiry (Unix timestamp) */
  exp: number;
}

/**
 * Authenticated request context — attached by requireAuth() middleware.
 */
export interface AuthContext {
  user: UserRow;
  session: SessionPayload;
  /** Whether the session was refreshed on this request */
  sessionRefreshed: boolean;
}

/**
 * Result of a code send request.
 */
export type SendCodeResult =
  | { success: true; expiresInMinutes: number }
  | { success: false; reason: 'rate_limited' | 'send_failed' | 'not_registered'; message: string };

/**
 * Result of a code verification.
 */
export type VerifyCodeResult =
  | { success: true; token: string; cookie: string; user: UserRow }
  | { success: false; reason: 'invalid_code' | 'expired' | 'too_many_attempts' | 'not_found'; message: string; attemptsRemaining?: number };

/**
 * Result of session validation.
 */
export type SessionValidation =
  | { valid: true; auth: AuthContext; refreshedCookie?: string }
  | { valid: false; reason: 'missing' | 'invalid' | 'expired' | 'user_not_found'; message: string };

// ===========================================================================
// Code Generation & Sending
// ===========================================================================

/**
 * Generate and send a verification code to a phone number.
 *
 * Steps:
 *   1. Check the phone belongs to a registered user
 *   2. Rate limit: max 5 codes per phone per hour
 *   3. Expire any pending codes for this phone
 *   4. Generate a 6-digit code
 *   5. Store hashed code in D1
 *   6. Send code via SendBlue SMS
 *
 * @param db    - D1 database binding
 * @param env   - Worker environment (for SendBlue credentials)
 * @param phone - E.164 phone number
 * @param now   - Override current time (for testing)
 */
export async function sendVerificationCode(
  db: D1Database,
  env: Env,
  phone: string,
  now?: Date,
): Promise<SendCodeResult> {
  const currentTime = now ?? new Date();

  // Step 1: Verify user exists
  const lookup = await getUserByPhone(db, phone);
  if (!lookup.found) {
    return {
      success: false,
      reason: 'not_registered',
      message: "I don't have an account with that number. Text me to get started!",
    };
  }

  // Step 2: Rate limit
  const recentCount = await countRecentCodes(db, phone, currentTime);
  if (recentCount >= MAX_CODES_PER_HOUR) {
    return {
      success: false,
      reason: 'rate_limited',
      message: "You've requested too many codes. Please wait a bit and try again.",
    };
  }

  // Step 3: Expire pending codes
  await expirePendingCodes(db, phone);

  // Step 4: Generate code
  const code = generateNumericCode(CODE_LENGTH);

  // Step 5: Store hashed
  const codeHash = await hmacHash(code, env.PIN_SIGNING_SECRET);
  const id = crypto.randomUUID();
  const expiresAt = new Date(currentTime);
  expiresAt.setMinutes(expiresAt.getMinutes() + CODE_EXPIRY_MINUTES);

  await db
    .prepare(
      `INSERT INTO verification_codes
         (id, phone, code_hash, attempts, status, created_at, expires_at)
       VALUES (?, ?, ?, 0, 'pending', ?, ?)`
    )
    .bind(id, phone, codeHash, currentTime.toISOString(), expiresAt.toISOString())
    .run();

  // Step 6: Send via SendBlue
  const sent = await sendSms(
    env,
    phone,
    `Your Bethany login code is: ${code}\n\nThis code expires in ${CODE_EXPIRY_MINUTES} minutes. Don't share it with anyone.`,
  );

  if (!sent) {
    // Clean up the stored code if send failed
    await db
      .prepare(`UPDATE verification_codes SET status = 'expired' WHERE id = ?`)
      .bind(id)
      .run();

    return {
      success: false,
      reason: 'send_failed',
      message: 'Failed to send the verification code. Please try again.',
    };
  }

  return { success: true, expiresInMinutes: CODE_EXPIRY_MINUTES };
}

/**
 * Verify a code submitted by the user.
 *
 * Steps:
 *   1. Find the most recent pending code for this phone
 *   2. Check expiry
 *   3. Check attempt count
 *   4. Compare code hash
 *   5. On success: create JWT, build cookie, refresh trust window
 *   6. On failure: increment attempts
 *
 * @param db    - D1 database binding
 * @param env   - Worker environment (for JWT signing)
 * @param phone - E.164 phone number
 * @param code  - The 6-digit code the user entered
 * @param now   - Override current time (for testing)
 */
export async function verifyCode(
  db: D1Database,
  env: Env,
  phone: string,
  code: string,
  now?: Date,
): Promise<VerifyCodeResult> {
  const currentTime = now ?? new Date();

  // Find the pending code
  const pending = await db
    .prepare(
      `SELECT * FROM verification_codes
       WHERE phone = ? AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .bind(phone)
    .first<{
      id: string;
      phone: string;
      code_hash: string;
      attempts: number;
      status: string;
      created_at: string;
      expires_at: string;
    }>();

  if (!pending) {
    return {
      success: false,
      reason: 'not_found',
      message: "No pending verification code found. Please request a new one.",
    };
  }

  // Check expiry
  if (new Date(pending.expires_at) <= currentTime) {
    await db
      .prepare(`UPDATE verification_codes SET status = 'expired' WHERE id = ?`)
      .bind(pending.id)
      .run();

    return {
      success: false,
      reason: 'expired',
      message: 'That code has expired. Please request a new one.',
    };
  }

  // Check attempts
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    await db
      .prepare(`UPDATE verification_codes SET status = 'expired' WHERE id = ?`)
      .bind(pending.id)
      .run();

    return {
      success: false,
      reason: 'too_many_attempts',
      message: "Too many incorrect attempts. Please request a new code.",
    };
  }

  // Compare hash
  const codeHash = await hmacHash(code, env.PIN_SIGNING_SECRET);
  const isValid = constantTimeEqual(codeHash, pending.code_hash);

  if (!isValid) {
    const newAttempts = pending.attempts + 1;
    await db
      .prepare(
        `UPDATE verification_codes SET attempts = ? WHERE id = ?`
      )
      .bind(newAttempts, pending.id)
      .run();

    const remaining = MAX_CODE_ATTEMPTS - newAttempts;
    return {
      success: false,
      reason: 'invalid_code',
      message: remaining > 0
        ? `Incorrect code. ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`
        : 'Too many incorrect attempts. Please request a new code.',
      attemptsRemaining: remaining,
    };
  }

  // Success — mark code as verified
  await db
    .prepare(
      `UPDATE verification_codes SET status = 'verified' WHERE id = ?`
    )
    .bind(pending.id)
    .run();

  // Look up the user
  const lookup = await getUserByPhone(db, phone);
  if (!lookup.found) {
    return {
      success: false,
      reason: 'not_found',
      message: 'Account not found. Please contact support.',
    };
  }

  const user = lookup.user;

  // Refresh the trust window (web login counts as PIN-level verification)
  await db
    .prepare(
      `UPDATE users
       SET last_pin_verified = datetime('now'),
           failed_pin_attempts = 0,
           account_locked = 0,
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(user.id)
    .run();

  // Create JWT
  const token = await createSessionToken(user, env.PIN_SIGNING_SECRET, currentTime);
  const cookie = buildSessionCookie(token, currentTime);

  return { success: true, token, cookie, user };
}

// ===========================================================================
// JWT Session Management
// ===========================================================================

/**
 * Create a signed JWT session token.
 */
export async function createSessionToken(
  user: UserRow,
  secret: string,
  now?: Date,
): Promise<string> {
  const currentTime = now ?? new Date();
  const expiresAt = new Date(currentTime);
  expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

  const payload: SessionPayload = {
    sub: user.id,
    phone: user.phone,
    iat: Math.floor(currentTime.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  };

  return signJwt(payload, secret);
}

/**
 * Validate a session token and return the auth context.
 *
 * If the session is within the refresh threshold (< 3 days remaining),
 * a refreshed cookie is included in the result so the caller can
 * set it on the response.
 *
 * @param db      - D1 database binding
 * @param token   - The JWT string (from cookie or Authorization header)
 * @param secret  - Signing secret
 * @param now     - Override current time (for testing)
 */
export async function validateSession(
  db: D1Database,
  token: string,
  secret: string,
  now?: Date,
): Promise<SessionValidation> {
  const currentTime = now ?? new Date();

  // Verify JWT signature and decode
  const payload = await verifyJwt(token, secret);
  if (!payload) {
    return {
      valid: false,
      reason: 'invalid',
      message: 'Invalid session. Please log in again.',
    };
  }

  // Check expiry
  const expiry = new Date(payload.exp * 1000);
  if (expiry <= currentTime) {
    return {
      valid: false,
      reason: 'expired',
      message: 'Your session has expired. Please log in again.',
    };
  }

  // Look up user (they may have been deleted or locked)
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ? AND phone = ?')
    .bind(payload.sub, payload.phone)
    .first<UserRow>();

  if (!user) {
    return {
      valid: false,
      reason: 'user_not_found',
      message: 'Account not found. Please log in again.',
    };
  }

  if (user.account_locked === 1) {
    return {
      valid: false,
      reason: 'invalid',
      message: 'Your account is locked. Please contact support.',
    };
  }

  // Check if session needs refresh
  const msRemaining = expiry.getTime() - currentTime.getTime();
  const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);
  const needsRefresh = daysRemaining < SESSION_REFRESH_THRESHOLD_DAYS;

  let refreshedCookie: string | undefined;
  if (needsRefresh) {
    const newToken = await createSessionToken(user, secret, currentTime);
    refreshedCookie = buildSessionCookie(newToken, currentTime);
  }

  return {
    valid: true,
    auth: {
      user,
      session: payload,
      sessionRefreshed: needsRefresh,
    },
    refreshedCookie,
  };
}

/**
 * Build an HttpOnly session cookie string.
 */
export function buildSessionCookie(token: string, now?: Date): string {
  const currentTime = now ?? new Date();
  const expires = new Date(currentTime);
  expires.setDate(expires.getDate() + SESSION_DURATION_DAYS);

  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    `Expires=${expires.toUTCString()}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/**
 * Build a cookie that clears the session (for logout).
 */
export function buildLogoutCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

// ===========================================================================
// Route Protection Middleware
// ===========================================================================

/**
 * Extract the session token from a request.
 *
 * Checks (in order):
 *   1. Cookie: bnm_session=<token>
 *   2. Authorization: Bearer <token>
 *
 * Returns null if no token found.
 */
export function extractToken(request: Request): string | null {
  // Check cookie first
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const match = cookieHeader
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));

    if (match) {
      const token = match.split('=')[1];
      if (token) return token;
    }
  }

  // Fall back to Authorization header
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Require authentication for a request.
 *
 * Use this as the first call in protected route handlers:
 *
 *   const auth = await requireAuth(request, env);
 *   if (!auth.valid) {
 *     return auth.response;
 *   }
 *   const { user, session, sessionRefreshed } = auth.auth;
 *
 * If the session was refreshed, the response should include
 * the Set-Cookie header from auth.refreshedCookie.
 */
export async function requireAuth(
  request: Request,
  env: Env,
): Promise<
  | { valid: true; auth: AuthContext; refreshedCookie?: string }
  | { valid: false; response: Response }
> {
  const token = extractToken(request);

  if (!token) {
    return {
      valid: false,
      response: buildAuthErrorResponse('missing', 'No session found. Please log in.'),
    };
  }

  const result = await validateSession(env.DB, token, env.PIN_SIGNING_SECRET);

  if (!result.valid) {
    return {
      valid: false,
      response: buildAuthErrorResponse(result.reason, result.message),
    };
  }

  return {
    valid: true,
    auth: result.auth,
    refreshedCookie: result.refreshedCookie,
  };
}

/**
 * Build a standardized auth error response.
 *
 * Returns 401 with a JSON body and a clear-session cookie
 * so the browser doesn't keep sending an invalid token.
 */
function buildAuthErrorResponse(reason: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: message,
      code: 'auth_required',
      reason,
      loginUrl: '/login',
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': buildLogoutCookie(),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Credentials': 'true',
      },
    },
  );
}

/**
 * Helper to attach a refreshed session cookie to a response.
 *
 * Call this after building your response if auth.sessionRefreshed is true:
 *
 *   let response = jsonResponse(data);
 *   if (refreshedCookie) {
 *     response = withRefreshedSession(response, refreshedCookie);
 *   }
 */
export function withRefreshedSession(response: Response, cookie: string): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Set-Cookie', cookie);
  return newResponse;
}

// ===========================================================================
// Route Handlers
// ===========================================================================

/**
 * Handle POST /api/auth/send-code
 *
 * Body: { phone: "+1XXXXXXXXXX" }
 * Response: { success: true, expiresInMinutes: 10 }
 */
export async function handleSendCode(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<{ phone?: string }>();
  if (!body.phone) {
    return new Response(
      JSON.stringify({ error: 'Phone number is required.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const phone = normalizePhone(body.phone);
  if (!phone) {
    return new Response(
      JSON.stringify({ error: 'Invalid phone number format.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const result = await sendVerificationCode(env.DB, env, phone);

  if (!result.success) {
    const statusCode = result.reason === 'rate_limited' ? 429 : 400;
    return new Response(
      JSON.stringify({ error: result.message, reason: result.reason }),
      { status: statusCode, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({ success: true, expiresInMinutes: result.expiresInMinutes }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/**
 * Handle POST /api/auth/verify
 *
 * Body: { phone: "+1XXXXXXXXXX", code: "123456" }
 * Response: { success: true, user: {...} } + Set-Cookie
 */
export async function handleVerifyCode(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<{ phone?: string; code?: string }>();
  if (!body.phone || !body.code) {
    return new Response(
      JSON.stringify({ error: 'Phone number and code are required.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const phone = normalizePhone(body.phone);
  if (!phone) {
    return new Response(
      JSON.stringify({ error: 'Invalid phone number format.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const result = await verifyCode(env.DB, env, phone, body.code.trim());

  if (!result.success) {
    return new Response(
      JSON.stringify({
        error: result.message,
        reason: result.reason,
        attemptsRemaining: 'attemptsRemaining' in result ? result.attemptsRemaining : undefined,
      }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Return user info with Set-Cookie
  return new Response(
    JSON.stringify({
      success: true,
      user: {
        id: result.user.id,
        name: result.user.name,
        phone: result.user.phone,
        email: result.user.email,
        subscriptionTier: result.user.subscription_tier,
      },
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': result.cookie,
        'Access-Control-Allow-Credentials': 'true',
      },
    },
  );
}

/**
 * Handle POST /api/auth/logout
 *
 * Clears the session cookie. No body needed.
 */
export async function handleLogout(): Promise<Response> {
  return new Response(
    JSON.stringify({ success: true, message: 'Logged out.' }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': buildLogoutCookie(),
      },
    },
  );
}

/**
 * Handle GET /api/auth/me
 *
 * Returns the current user's info if authenticated.
 * Used by the dashboard to check session state on load.
 */
export async function handleGetMe(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (!auth.valid) return auth.response;

  let response = new Response(
    JSON.stringify({
      user: {
        id: auth.auth.user.id,
        name: auth.auth.user.name,
        phone: auth.auth.user.phone,
        email: auth.auth.user.email,
        subscriptionTier: auth.auth.user.subscription_tier,
      },
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  if (auth.refreshedCookie) {
    response = withRefreshedSession(response, auth.refreshedCookie);
  }

  return response;
}

// ===========================================================================
// JWT Implementation (HMAC-SHA256, Workers-compatible)
// ===========================================================================

/**
 * Sign a JWT with HMAC-SHA256.
 * Compact serialization: header.payload.signature
 */
async function signJwt(payload: SessionPayload, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await hmacSign(signingInput, secret);
  const signatureB64 = base64UrlEncodeBuffer(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Verify a JWT and return the payload, or null if invalid.
 */
async function verifyJwt(token: string, secret: string): Promise<SessionPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  // Verify signature
  const expectedSig = await hmacSign(signingInput, secret);
  const expectedB64 = base64UrlEncodeBuffer(expectedSig);

  if (!constantTimeEqual(signatureB64, expectedB64)) {
    return null;
  }

  // Decode payload
  try {
    const payloadJson = base64UrlDecode(payloadB64);
    return JSON.parse(payloadJson) as SessionPayload;
  } catch {
    return null;
  }
}

// ===========================================================================
// Crypto Helpers
// ===========================================================================

/**
 * HMAC-SHA256 hash a string (for code storage).
 */
async function hmacHash(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return bufferToHex(signature);
}

/**
 * HMAC-SHA256 sign a string (for JWT signatures).
 * Returns the raw ArrayBuffer.
 */
async function hmacSign(data: string, secret: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return crypto.subtle.sign('HMAC', key, encoder.encode(data));
}

/**
 * Constant-time string comparison.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a cryptographically random numeric code.
 */
function generateNumericCode(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => (b % 10).toString())
    .join('');
}

// ===========================================================================
// Base64URL Encoding (for JWT)
// ===========================================================================

function base64UrlEncode(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  return base64UrlEncodeBuffer(bytes.buffer as ArrayBuffer);
}

function base64UrlEncodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// ===========================================================================
// Phone Normalization
// ===========================================================================

/**
 * Normalize a phone number to E.164 format.
 * Returns null if the input can't be parsed.
 */
function normalizePhone(phone: string): string | null {
  // Strip everything except digits and leading +
  const cleaned = phone.replace(/[^\d+]/g, '');

  // Already E.164
  if (/^\+1\d{10}$/.test(cleaned)) return cleaned;

  // US number without country code
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;

  // US number with 1 prefix but no +
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;

  return null;
}

// ===========================================================================
// SendBlue SMS (minimal inline — avoids circular dependency)
// ===========================================================================

/**
 * Send an SMS via SendBlue API.
 * Returns true if the API accepted the message.
 */
async function sendSms(
  env: Env,
  to: string,
  message: string,
): Promise<boolean> {
  try {
    const response = await fetch('https://api.sendblue.co/api/send-message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'sb-api-key-id': env.SENDBLUE_API_KEY,
        'sb-api-secret-key': env.SENDBLUE_API_SECRET,
      },
      body: JSON.stringify({
        number: to,
        content: message,
        send_style: 'invisible',
      }),
    });

    return response.ok;
  } catch (err) {
    console.error('[auth] SendBlue SMS failed:', err);
    return false;
  }
}

// ===========================================================================
// D1 Helpers
// ===========================================================================

/**
 * Count codes requested for a phone in the last hour.
 */
async function countRecentCodes(
  db: D1Database,
  phone: string,
  now: Date,
): Promise<number> {
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(
      `SELECT COUNT(*) as count FROM verification_codes
       WHERE phone = ? AND created_at > ?`
    )
    .bind(phone, oneHourAgo)
    .first<{ count: number }>();

  return result?.count ?? 0;
}

/**
 * Expire all pending codes for a phone.
 */
async function expirePendingCodes(
  db: D1Database,
  phone: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE verification_codes SET status = 'expired'
       WHERE phone = ? AND status = 'pending'`
    )
    .bind(phone)
    .run();
}

// ===========================================================================
// Cron: Cleanup
// ===========================================================================

/**
 * Purge old verification codes.
 * Run daily — removes codes older than 24 hours.
 *
 * @param db - D1 database binding
 * @returns Number of rows deleted
 */
export async function purgeExpiredCodes(
  db: D1Database,
): Promise<{ purged: number }> {
  const result = await db
    .prepare(
      `DELETE FROM verification_codes
       WHERE created_at < datetime('now', '-1 day')`
    )
    .run();

  return { purged: result.meta.changes ?? 0 };
}
