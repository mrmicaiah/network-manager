/**
 * Web Signup Route — Direct user registration.
 *
 * This is the PRIMARY entry point for new users (TASK-7cfa060a-2).
 * No token required — users arrive directly at the signup page.
 *
 * POST /signup flow:
 *   1. Validate form input (name, email, phone, PIN, terms)
 *   2. Check for existing user with same phone or email
 *   3. Hash the PIN
 *   4. Create user record in D1 (with onboarding_stage = 'intro_sent')
 *   5. Initialize default circles (Family, Friends, Work, Community)
 *   6. Start 14-day trial
 *   7. Trigger Bethany's intro message via initializeOnboarding()
 *      (SendBlue send-first registers the contact for inbound routing)
 *   8. Return success — frontend shows "check your texts" screen
 *
 * GET /signup:
 *   Serves the static signup page (dashboard/signup.html).
 *
 * @see worker/services/onboarding-service.ts for initializeOnboarding()
 * @see worker/services/circle-service.ts for initializeDefaultCircles()
 * @see worker/services/subscription-service.ts for initializeTrial()
 */

import type { Env } from '../../shared/types';
import type { UserRow, OnboardingStage } from '../../shared/models';
import { jsonResponse, errorResponse, corsHeaders } from '../../shared/http';
import { getUserByPhone } from '../services/user-service';
import { initializeDefaultCircles } from '../services/circle-service';
import { initializeTrial } from '../services/subscription-service';
import { initializeOnboarding } from '../services/onboarding-service';

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
  const now = new Date().toISOString();
  const initialStage: OnboardingStage = 'intro_sent';

  try {
    await env.DB
      .prepare(
        `INSERT INTO users
           (id, phone, email, name, pin_hash, subscription_tier,
            onboarding_stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'trial', ?, ?, ?)`
      )
      .bind(userId, phone, email, name, pinHash, initialStage, now, now)
      .run();
  } catch (err) {
    console.error('[signup] User creation failed:', err);
    return jsonResponse(
      { success: false, error: 'Account creation failed. Please try again.' } as SignupError,
      500,
    );
  }

  console.log(`[signup] User created: ${name} (${phone}) → ${userId}`);

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

  // Return success immediately
  // The intro message sends in the background via ctx.waitUntil
  return jsonResponse(
    {
      success: true,
      userId,
      name,
      message: 'Account created! Check your texts — Bethany is reaching out.',
    } as SignupSuccess,
    201,
  );
}

// ---------------------------------------------------------------------------
// GET /signup Handler (static page)
// ---------------------------------------------------------------------------

/**
 * Serve the static signup HTML page.
 *
 * In production, this could be served from R2 or a CDN.
 * For now, it's inline to keep deployment simple.
 */
export function handleSignupPage(): Response {
  return new Response(SIGNUP_HTML, {
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

// ---------------------------------------------------------------------------
// Static HTML
// ---------------------------------------------------------------------------

const SIGNUP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meet Bethany</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #faf9f7;
      --surface: #ffffff;
      --text: #1a1a1a;
      --text-secondary: #6b6b6b;
      --accent: #2d2d2d;
      --accent-hover: #1a1a1a;
      --border: #e5e2dd;
      --error: #c53030;
      --error-bg: #fff5f5;
      --success: #276749;
      --success-bg: #f0fff4;
      --radius: 10px;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    .container {
      width: 100%;
      max-width: 420px;
    }

    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 40px 32px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }

    .header {
      text-align: center;
      margin-bottom: 32px;
    }

    .header h1 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }

    .header p {
      font-size: 15px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .form-group {
      margin-bottom: 20px;
    }

    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 6px;
      letter-spacing: 0.01em;
    }

    input[type="text"],
    input[type="email"],
    input[type="tel"],
    input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      font-size: 16px;
      font-family: var(--font);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg);
      color: var(--text);
      transition: border-color 0.15s, box-shadow 0.15s;
      outline: none;
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(45,45,45,0.08);
    }

    input.error {
      border-color: var(--error);
      box-shadow: 0 0 0 3px rgba(197,48,48,0.08);
    }

    .input-hint {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .field-error {
      font-size: 13px;
      color: var(--error);
      margin-top: 4px;
      display: none;
    }

    .field-error.visible {
      display: block;
    }

    .terms {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      margin-bottom: 24px;
      margin-top: 4px;
    }

    .terms input[type="checkbox"] {
      margin-top: 3px;
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      accent-color: var(--accent);
    }

    .terms label {
      font-size: 14px;
      color: var(--text);
      margin-bottom: 0;
      font-weight: 400;
      cursor: pointer;
    }

    button[type="submit"] {
      width: 100%;
      padding: 14px;
      font-size: 16px;
      font-weight: 500;
      font-family: var(--font);
      color: #ffffff;
      background: var(--accent);
      border: none;
      border-radius: var(--radius);
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      letter-spacing: -0.01em;
    }

    button[type="submit"]:hover {
      background: var(--accent-hover);
    }

    button[type="submit"]:active {
      transform: scale(0.99);
    }

    button[type="submit"]:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
    }

    .alert {
      padding: 12px 16px;
      border-radius: var(--radius);
      font-size: 14px;
      margin-bottom: 20px;
      display: none;
    }

    .alert.error {
      background: var(--error-bg);
      color: var(--error);
      border: 1px solid rgba(197,48,48,0.15);
    }

    .alert.visible {
      display: block;
    }

    /* Success state */
    .success-view {
      display: none;
      text-align: center;
      padding: 20px 0;
    }

    .success-view.visible {
      display: block;
    }

    .success-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .success-view h2 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 10px;
      letter-spacing: -0.02em;
    }

    .success-view p {
      font-size: 15px;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    .success-view .name-highlight {
      color: var(--text);
      font-weight: 500;
    }

    .success-nudge {
      margin-top: 24px;
      padding: 16px;
      background: var(--bg);
      border-radius: var(--radius);
      font-size: 14px;
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .spinner {
      display: inline-block;
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: #ffffff;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle;
      margin-right: 8px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .footer {
      text-align: center;
      margin-top: 20px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .footer a {
      color: var(--text);
      text-decoration: none;
      font-weight: 500;
    }

    .footer a:hover {
      text-decoration: underline;
    }

    @media (max-width: 480px) {
      .card {
        padding: 32px 24px;
        border-radius: 12px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <!-- Form View -->
      <div id="formView">
        <div class="header">
          <h1>Meet Bethany</h1>
          <p>She helps you stay connected to the people who matter. Sign up and she'll text you to get started.</p>
        </div>

        <div id="formAlert" class="alert error"></div>

        <form id="signupForm" novalidate>
          <div class="form-group">
            <label for="name">Your name</label>
            <input type="text" id="name" name="name" placeholder="First name is fine" autocomplete="given-name" required>
            <div class="field-error" id="nameError"></div>
          </div>

          <div class="form-group">
            <label for="email">Email</label>
            <input type="email" id="email" name="email" placeholder="you@example.com" autocomplete="email" required>
            <div class="field-error" id="emailError"></div>
          </div>

          <div class="form-group">
            <label for="phone">Phone number</label>
            <input type="tel" id="phone" name="phone" placeholder="(555) 123-4567" autocomplete="tel" required>
            <div class="field-error" id="phoneError"></div>
            <div class="input-hint">US numbers only. Bethany will text you here.</div>
          </div>

          <div class="form-group">
            <label for="pin">4-digit PIN</label>
            <input type="password" id="pin" name="pin" placeholder="••••" maxlength="4" inputmode="numeric" pattern="\\d{4}" autocomplete="new-password" required>
            <div class="field-error" id="pinError"></div>
            <div class="input-hint">You'll use this to verify your identity.</div>
          </div>

          <div class="terms">
            <input type="checkbox" id="terms" name="terms">
            <label for="terms">I agree to the <a href="/terms" target="_blank">terms of service</a> and <a href="/privacy" target="_blank">privacy policy</a></label>
          </div>
          <div class="field-error" id="termsError" style="margin-top: -16px; margin-bottom: 16px;"></div>

          <button type="submit" id="submitBtn">Sign up</button>
        </form>

        <div class="footer">
          Already have an account? <a href="/login">Log in</a>
        </div>
      </div>

      <!-- Success View -->
      <div id="successView" class="success-view">
        <div class="success-icon">📱</div>
        <h2>Check your texts</h2>
        <p>Bethany just sent you a message, <span id="successName" class="name-highlight"></span>. Open your texts and say hey — she'll take it from there.</p>
        <div class="success-nudge">
          She's going to ask about the people in your life — who matters, who you want to stay closer to. No pressure, just a conversation.
        </div>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById('signupForm');
    const formView = document.getElementById('formView');
    const successView = document.getElementById('successView');
    const formAlert = document.getElementById('formAlert');
    const submitBtn = document.getElementById('submitBtn');

    function clearErrors() {
      document.querySelectorAll('.field-error').forEach(el => {
        el.textContent = '';
        el.classList.remove('visible');
      });
      document.querySelectorAll('input.error').forEach(el => {
        el.classList.remove('error');
      });
      formAlert.classList.remove('visible');
    }

    function showFieldError(field, message) {
      const errorEl = document.getElementById(field + 'Error');
      const inputEl = document.getElementById(field);
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.classList.add('visible');
      }
      if (inputEl) {
        inputEl.classList.add('error');
      }
    }

    function showAlert(message) {
      formAlert.textContent = message;
      formAlert.classList.add('visible');
    }

    function setLoading(loading) {
      submitBtn.disabled = loading;
      submitBtn.innerHTML = loading
        ? '<span class="spinner"></span>Creating your account...'
        : 'Sign up';
    }

    // Format phone number as user types
    document.getElementById('phone').addEventListener('input', function(e) {
      let val = e.target.value.replace(/\\D/g, '');
      if (val.length > 10) val = val.slice(0, 10);
      if (val.length >= 7) {
        e.target.value = '(' + val.slice(0,3) + ') ' + val.slice(3,6) + '-' + val.slice(6);
      } else if (val.length >= 4) {
        e.target.value = '(' + val.slice(0,3) + ') ' + val.slice(3);
      } else if (val.length > 0) {
        e.target.value = '(' + val;
      }
    });

    // PIN: digits only
    document.getElementById('pin').addEventListener('input', function(e) {
      e.target.value = e.target.value.replace(/\\D/g, '').slice(0, 4);
    });

    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      clearErrors();

      const name = document.getElementById('name').value.trim();
      const email = document.getElementById('email').value.trim();
      const phone = document.getElementById('phone').value.replace(/\\D/g, '');
      const pin = document.getElementById('pin').value;
      const terms = document.getElementById('terms').checked;

      // Client-side validation
      let hasError = false;

      if (!name) {
        showFieldError('name', 'What should Bethany call you?');
        hasError = true;
      }

      if (!email || !email.includes('@')) {
        showFieldError('email', 'Enter a valid email address.');
        hasError = true;
      }

      if (phone.length !== 10) {
        showFieldError('phone', 'Enter a 10-digit US phone number.');
        hasError = true;
      }

      if (!/^\\d{4}$/.test(pin)) {
        showFieldError('pin', 'Enter a 4-digit PIN.');
        hasError = true;
      }

      if (!terms) {
        showFieldError('terms', 'You need to accept the terms.');
        hasError = true;
      }

      if (hasError) return;

      setLoading(true);

      try {
        const res = await fetch('/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            phone,
            pin,
            termsAccepted: terms,
          }),
        });

        const data = await res.json();

        if (!res.ok || !data.success) {
          if (data.field) {
            showFieldError(data.field, data.error);
          } else {
            showAlert(data.error || 'Something went wrong. Please try again.');
          }
          setLoading(false);
          return;
        }

        // Success — show the success screen
        document.getElementById('successName').textContent = name;
        formView.style.display = 'none';
        successView.classList.add('visible');

      } catch (err) {
        showAlert('Connection error. Please check your internet and try again.');
        setLoading(false);
      }
    });
  </script>
</body>
</html>`;
