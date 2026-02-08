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
 *   7. Create session token and cookie (auto-login)
 *   8. Trigger Bethany's intro message via initializeOnboarding()
 *      (SendBlue send-first registers the contact for inbound routing)
 *   9. Return success JSON with Set-Cookie header
 *
 * GET /signup:
 *   Redirects to the landing page at bethany.untitledpublishers.com/signup
 *
 * @see worker/services/onboarding-service.ts for initializeOnboarding()
 * @see worker/services/circle-service.ts for initializeDefaultCircles()
 * @see worker/services/subscription-service.ts for initializeTrial()
 * @see worker/services/auth-service.ts for session creation
 */

import type { Env } from '../../shared/types';
import type { UserRow, OnboardingStage } from '../../shared/models';
import { jsonResponse, errorResponse, corsHeaders } from '../../shared/http';
import { getUserByPhone } from '../services/user-service';
import { initializeDefaultCircles } from '../services/circle-service';
import { initializeTrial } from '../services/subscription-service';
import { initializeOnboarding } from '../services/onboarding-service';
import { createSessionToken, buildSessionCookie } from '../services/auth-service';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The landing page URL where users sign up */
const LANDING_PAGE_URL = 'https://bethany.untitledpublishers.com/signup';

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
  // Parse body
  let input: Partial<SignupFormInput>;
  try {
    input = await request.json<Partial<SignupFormInput>>();
  } catch {
    return jsonResponse({ success: false, error: 'Invalid request body.' } as SignupError, 400);
  }

  // Validate
  const validationError = validateInput(input);
  if (validationError) {
    return jsonResponse(validationError, 400);
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

  // Create session token for auto-login
  // Build a minimal UserRow for token creation
  const userForSession: UserRow = {
    id: userId,
    phone,
    email,
    name,
    pin_hash: pinHash,
    subscription_tier: 'trial',
    onboarding_stage: initialStage,
    created_at: nowIso,
    updated_at: nowIso,
    // Default values for other fields
    gender: null,
    trial_ends_at: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    default_circle_id: null,
    circle_tab_order: null,
    timezone: 'America/New_York',
    preferred_nudge_hour: 9,
    nudge_frequency: 'daily',
    quiet_hours_start: null,
    quiet_hours_end: null,
    last_pin_verified: null,
    failed_pin_attempts: 0,
    account_locked: 0,
  };

  const sessionToken = await createSessionToken(userForSession, env.PIN_SIGNING_SECRET, now);
  const sessionCookie = buildSessionCookie(sessionToken, now);

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

  // Determine redirect URL (dashboard with onboarding flag)
  const dashboardUrl = env.DASHBOARD_URL || 'https://network-manager.pages.dev';
  const redirectUrl = `${dashboardUrl}/welcome`;

  // Return success with session cookie
  const response = new Response(
    JSON.stringify({
      success: true,
      userId,
      name,
      message: 'Account created! Check your texts - Bethany is reaching out.',
      redirectUrl,
    } as SignupSuccess),
    {
      status: 201,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Set-Cookie': sessionCookie,
      },
    },
  );

  return response;
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
