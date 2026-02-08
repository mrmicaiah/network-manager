/**
 * Web Signup Route — Direct user registration.
 *
 * POST /signup:
 *   API endpoint for user registration. Called by the landing page form.
 *   1. Validate form input (name, email, phone, PIN, terms)
 *   2. Check for existing user with same phone or email
 *   3. Hash the PIN
 *   4. Create user record in D1 (with onboarding_stage = 'intro_sent')
 *   5. Initialize default circles (Family, Friends, Work, Community)
 *   6. Start 14-day trial
 *   7. Create a one-time login token for auto-login redirect
 *   8. Trigger Bethany's intro message via initializeOnboarding()
 *      (SendBlue send-first registers the contact for inbound routing)
 *   9. Return success JSON with redirect URL to worker's /auth/callback
 *
 * GET /signup:
 *   Redirects to the landing page
 *
 * GET /auth/callback?token=xxx:
 *   Exchanges the one-time token for a session cookie and redirects to welcome page
 *   Cookie is set for the worker domain, so dashboard API calls will include it.
 *
 * @see worker/services/onboarding-service.ts for initializeOnboarding()
 * @see worker/services/circle-service.ts for initializeDefaultCircles()
 * @see worker/services/subscription-service.ts for initializeTrial()
 * @see worker/services/auth-service.ts for session creation
 */

import type { Env } from '../../shared/types';
import type { UserRow, OnboardingStage } from '../../shared/models';
import { jsonResponse, errorResponse, getCorsHeaders } from '../../shared/http';
import { getUserByPhone } from '../services/user-service';
import { initializeDefaultCircles } from '../services/circle-service';
import { initializeTrial } from '../services/subscription-service';
import { initializeOnboarding } from '../services/onboarding-service';
import { createSessionToken, buildSessionCookie } from '../services/auth-service';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The landing page URL where users sign up */
const LANDING_PAGE_URL = 'https://network-manager-site.pages.dev/signup';

/** One-time token expiry in minutes */
const LOGIN_TOKEN_EXPIRY_MINUTES = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SignupFormInput {
  name: string;
  email: string;
  phone: string;
  pin: string;
  termsAccepted: boolean;
}

export interface SignupSuccess {
  success: true;
  userId: string;
  name: string;
  message: string;
  redirectUrl: string;
}

export interface SignupError {
  success: false;
  error: string;
  field?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Normalize phone to E.164 format. Returns null if unparseable. */
function normalizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (/^\+1\d{10}$/.test(cleaned)) return cleaned;
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  return null;
}

/** Validate the signup form input. Returns an error or null if valid. */
function validateInput(input: Partial<SignupFormInput>): SignupError | null {
  if (!input.name || input.name.trim().length < 1) {
    return { success: false, error: 'Name is required.', field: 'name' };
  }
  if (input.name.trim().length > 100) {
    return { success: false, error: 'Name is too long.', field: 'name' };
  }

  if (!input.email || !input.email.includes('@') || !input.email.includes('.')) {
    return { success: false, error: 'A valid email is required.', field: 'email' };
  }

  if (!input.phone) {
    return { success: false, error: 'Phone number is required.', field: 'phone' };
  }
  if (!normalizePhone(input.phone)) {
    return { success: false, error: 'Enter a valid US phone number.', field: 'phone' };
  }

  if (!input.pin || !/^\d{4}$/.test(input.pin)) {
    return { success: false, error: 'PIN must be exactly 4 digits.', field: 'pin' };
  }

  if (!input.termsAccepted) {
    return { success: false, error: 'You must accept the terms to continue.', field: 'terms' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// PIN Hashing (HMAC-SHA256, Workers-compatible)
// ---------------------------------------------------------------------------

async function hashPin(pin: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(pin));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// One-Time Login Token
// ---------------------------------------------------------------------------

/**
 * Generate a one-time login token for post-signup redirect.
 * Token is stored in D1 and can only be used once.
 */
async function createLoginToken(
  db: D1Database,
  userId: string,
  secret: string,
): Promise<string> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + LOGIN_TOKEN_EXPIRY_MINUTES);
  
  // Store token hash (not the token itself)
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  const tokenHash = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  await db
    .prepare(
      `INSERT INTO login_tokens (id, user_id, token_hash, expires_at, used)
       VALUES (?, ?, ?, ?, 0)`
    )
    .bind(crypto.randomUUID(), userId, tokenHash, expiresAt.toISOString())
    .run();
  
  return token;
}

/**
 * Validate and consume a one-time login token.
 * Returns the user ID if valid, null otherwise.
 */
async function consumeLoginToken(
  db: D1Database,
  token: string,
  secret: string,
): Promise<string | null> {
  // Hash the provided token
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(token));
  const tokenHash = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // Find and validate token
  const record = await db
    .prepare(
      `SELECT user_id, expires_at, used FROM login_tokens
       WHERE token_hash = ?`
    )
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: string; used: number }>();
  
  if (!record) return null;
  if (record.used === 1) return null;
  if (new Date(record.expires_at) < new Date()) return null;
  
  // Mark as used
  await db
    .prepare(`UPDATE login_tokens SET used = 1 WHERE token_hash = ?`)
    .bind(tokenHash)
    .run();
  
  return record.user_id;
}

// ---------------------------------------------------------------------------
// POST /signup Handler
// ---------------------------------------------------------------------------

/**
 * Handle the signup form submission.
 *
 * This is the critical path for new user acquisition. Every step is
 * logged so failures can be diagnosed quickly.
 */
export async function handleSignupPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const workerUrl = new URL(request.url).origin; // e.g. https://network-manager.micaiah-tasks.workers.dev
  
  // Parse body
  let input: Partial<SignupFormInput>;
  try {
    input = await request.json<Partial<SignupFormInput>>();
  } catch {
    return errorResponse('Invalid request body.', 400, undefined, origin);
  }

  // Validate
  const validationError = validateInput(input);
  if (validationError) {
    return jsonResponse(validationError, 400, origin);
  }

  const name = input.name!.trim();
  const email = input.email!.trim().toLowerCase();
  const phone = normalizePhone(input.phone!)!;
  const pin = input.pin!;

  // Check for existing user with same phone
  const existing = await getUserByPhone(env.DB, phone);
  if (existing.found) {
    return jsonResponse(
      {
        success: false,
        error: 'An account with this phone number already exists. Try logging in instead.',
        field: 'phone',
      } as SignupError,
      409,
      origin,
    );
  }

  // Check for existing email
  const emailCheck = await env.DB
    .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
    .bind(email)
    .first();
  if (emailCheck) {
    return jsonResponse(
      {
        success: false,
        error: 'An account with this email already exists.',
        field: 'email',
      } as SignupError,
      409,
      origin,
    );
  }

  // Hash PIN
  const pinHash = await hashPin(pin, env.PIN_SIGNING_SECRET);

  // Create user
  const userId = crypto.randomUUID();
  const now = new Date();
  const nowIso = now.toISOString();
  const initialStage: OnboardingStage = 'intro_sent';

  try {
    await env.DB
      .prepare(
        `INSERT INTO users
           (id, phone, email, name, pin_hash, subscription_tier,
            onboarding_stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'trial', ?, ?, ?)`
      )
      .bind(userId, phone, email, name, pinHash, initialStage, nowIso, nowIso)
      .run();
  } catch (err) {
    console.error('[signup] User creation failed:', err);
    return jsonResponse(
      { success: false, error: 'Account creation failed. Please try again.' } as SignupError,
      500,
      origin,
    );
  }

  console.log(`[signup] User created: ${name} (${phone}) -> ${userId}`);

  // Initialize default circles
  try {
    await initializeDefaultCircles(env.DB, userId);
    console.log(`[signup] Default circles created for ${userId}`);
  } catch (err) {
    console.error('[signup] Circle initialization failed:', err);
    // Non-fatal — circles can be created later
  }

  // Start trial
  try {
    await initializeTrial(env.DB, userId);
    console.log(`[signup] Trial started for ${userId}`);
  } catch (err) {
    console.error('[signup] Trial initialization failed:', err);
    // Non-fatal — defaults to trial tier from schema
  }

  // Create one-time login token for redirect
  let loginToken: string;
  try {
    loginToken = await createLoginToken(env.DB, userId, env.PIN_SIGNING_SECRET);
  } catch (err) {
    console.error('[signup] Login token creation failed:', err);
    // Fall back to manual login
    loginToken = '';
  }

  // Trigger Bethany's intro message (non-blocking)
  // This is critical — SendBlue requires send-first to register
  // the contact for inbound webhook routing.
  ctx.waitUntil(
    (async () => {
      try {
        const result = await initializeOnboarding(env, userId, phone, name, email);
        console.log(
          `[signup] Bethany intro sent to ${phone}. ` +
          `Message ID: ${result.messageId}`
        );
      } catch (err) {
        console.error(`[signup] Onboarding initialization failed for ${phone}:`, err);
        // This is a problem — without the intro send, inbound routing
        // won't work. Log for manual follow-up.
        // TODO: Add to a retry queue or alert system
      }
    })()
  );

  // Determine redirect URL - go to WORKER's auth/callback so cookie is set for worker domain
  // The worker will then redirect to the dashboard
  const dashboardUrl = env.DASHBOARD_URL || 'https://network-manager.pages.dev';
  const redirectUrl = loginToken
    ? `${workerUrl}/auth/callback?token=${loginToken}`
    : `${dashboardUrl}/login?welcome=true`;

  // Return success
  return jsonResponse(
    {
      success: true,
      userId,
      name,
      message: 'Account created! Check your texts - Bethany is reaching out.',
      redirectUrl,
    } as SignupSuccess,
    201,
    origin,
  );
}

// ---------------------------------------------------------------------------
// GET /auth/callback Handler (Token Exchange)
// ---------------------------------------------------------------------------

/**
 * Exchange a one-time login token for a session cookie.
 * Redirects to the welcome page on success, login page on failure.
 * 
 * Cookie is set for the worker domain. When the dashboard makes API
 * calls to the worker with credentials:include, the cookie is sent.
 */
export async function handleSignupComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const dashboardUrl = env.DASHBOARD_URL || 'https://network-manager.pages.dev';
  
  if (!token) {
    return Response.redirect(`${dashboardUrl}/login?error=missing_token`, 302);
  }
  
  // Validate and consume token
  const userId = await consumeLoginToken(env.DB, token, env.PIN_SIGNING_SECRET);
  
  if (!userId) {
    return Response.redirect(`${dashboardUrl}/login?error=invalid_token&welcome=true`, 302);
  }
  
  // Get user
  const user = await env.DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<UserRow>();
  
  if (!user) {
    return Response.redirect(`${dashboardUrl}/login?error=user_not_found`, 302);
  }
  
  // Create session
  const sessionToken = await createSessionToken(user, env.PIN_SIGNING_SECRET);
  const sessionCookie = buildSessionCookie(sessionToken);
  
  // Redirect to welcome page with session cookie
  // Cookie is for the worker domain, dashboard will send it with API calls
  return new Response(null, {
    status: 302,
    headers: {
      'Location': `${dashboardUrl}/welcome`,
      'Set-Cookie': sessionCookie,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /signup Handler (redirect to landing page)
// ---------------------------------------------------------------------------

/**
 * Redirect to the Bethany landing page.
 *
 * The landing page is hosted separately on Cloudflare Pages and provides
 * the full marketing experience with the signup form.
 */
export function handleSignupPage(): Response {
  return Response.redirect(LANDING_PAGE_URL, 302);
}
