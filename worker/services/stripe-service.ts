/**
 * Stripe Integration Service
 *
 * Handles subscription management via Stripe:
 *   - Checkout session creation for upgrades
 *   - Webhook processing for payment events
 *   - Customer portal access for subscription management
 *
 * Stripe event flow:
 *
 *   1. User clicks "Upgrade" → createCheckoutSession() → redirect to Stripe
 *   2. User completes payment → Stripe fires checkout.session.completed webhook
 *   3. handleWebhook() receives event → upgradeToPremium() updates user tier
 *   4. User can manage subscription via createPortalSession() → Stripe portal
 *   5. If user cancels → customer.subscription.deleted webhook → schedule downgrade
 *
 * Security:
 *
 *   - Webhooks are verified using STRIPE_WEBHOOK_SECRET
 *   - Customer IDs are stored on user records for lookup
 *   - All Stripe API calls use the secret key from env
 *
 * Configuration (wrangler.toml secrets):
 *
 *   STRIPE_SECRET_KEY      - Stripe API secret key
 *   STRIPE_WEBHOOK_SECRET  - Webhook endpoint signing secret
 *   STRIPE_PRICE_ID        - Price ID for the monthly subscription
 *
 * @see worker/services/subscription-service.ts for tier management
 * @see worker/routes/api.ts for webhook route mounting
 */

import type { Env } from '../../shared/types';
import { upgradeToPremium, downgradeToFree } from './subscription-service';

// ===========================================================================
// Types
// ===========================================================================

/**
 * Stripe API base URL
 */
const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Result of creating a checkout session
 */
export interface CheckoutSessionResult {
  sessionId: string;
  url: string;
}

/**
 * Result of creating a portal session
 */
export interface PortalSessionResult {
  url: string;
}

/**
 * Stripe webhook event (simplified)
 */
interface StripeEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
}

/**
 * Webhook processing result
 */
export interface WebhookResult {
  success: boolean;
  eventType: string;
  message: string;
}

// ===========================================================================
// Checkout Session
// ===========================================================================

/**
 * Create a Stripe Checkout session for upgrading to premium.
 *
 * The user is redirected to Stripe's hosted checkout page. After payment,
 * they're redirected back to success_url with the session ID.
 *
 * @param env          - Worker environment with Stripe secrets
 * @param userId       - The user's ID (stored as client_reference_id)
 * @param userEmail    - User's email for Stripe receipt
 * @param userPhone    - User's phone (optional, for Stripe customer record)
 * @param successUrl   - URL to redirect after successful payment
 * @param cancelUrl    - URL to redirect if user cancels
 * @param existingCustomerId - If user already has a Stripe customer ID, reuse it
 */
export async function createCheckoutSession(
  env: Env,
  userId: string,
  userEmail: string | null,
  userPhone: string | null,
  successUrl: string,
  cancelUrl: string,
  existingCustomerId?: string | null,
): Promise<CheckoutSessionResult> {
  const params = new URLSearchParams();

  // Payment mode for subscriptions
  params.append('mode', 'subscription');

  // Line items - the subscription price
  params.append('line_items[0][price]', env.STRIPE_PRICE_ID);
  params.append('line_items[0][quantity]', '1');

  // Redirect URLs
  params.append('success_url', `${successUrl}?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', cancelUrl);

  // Store user ID for webhook lookup
  params.append('client_reference_id', userId);

  // Customer handling
  if (existingCustomerId) {
    // Reuse existing customer (they're resubscribing)
    params.append('customer', existingCustomerId);
  } else {
    // Create new customer - let Stripe collect email
    params.append('customer_creation', 'always');
    if (userEmail) {
      params.append('customer_email', userEmail);
    }
  }

  // Collect phone number for better customer records
  params.append('phone_number_collection[enabled]', 'true');

  // Allow promotion codes for marketing
  params.append('allow_promotion_codes', 'true');

  // Billing address collection (required for some payment methods)
  params.append('billing_address_collection', 'auto');

  // Subscription metadata
  params.append('subscription_data[metadata][user_id]', userId);
  if (userPhone) {
    params.append('subscription_data[metadata][user_phone]', userPhone);
  }

  const response = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.json() as { error?: { message?: string } };
    throw new Error(error.error?.message || 'Failed to create checkout session');
  }

  const session = await response.json() as { id: string; url: string };

  return {
    sessionId: session.id,
    url: session.url,
  };
}

// ===========================================================================
// Customer Portal
// ===========================================================================

/**
 * Create a Stripe Customer Portal session.
 *
 * The portal allows customers to:
 *   - View billing history
 *   - Update payment method
 *   - Cancel subscription
 *   - Download invoices
 *
 * @param env              - Worker environment with Stripe secrets
 * @param stripeCustomerId - The customer's Stripe ID (from user record)
 * @param returnUrl        - URL to redirect when they exit the portal
 */
export async function createPortalSession(
  env: Env,
  stripeCustomerId: string,
  returnUrl: string,
): Promise<PortalSessionResult> {
  const params = new URLSearchParams();
  params.append('customer', stripeCustomerId);
  params.append('return_url', returnUrl);

  const response = await fetch(`${STRIPE_API_BASE}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const error = await response.json() as { error?: { message?: string } };
    throw new Error(error.error?.message || 'Failed to create portal session');
  }

  const session = await response.json() as { url: string };

  return { url: session.url };
}

// ===========================================================================
// Webhook Handling
// ===========================================================================

/**
 * Verify and process a Stripe webhook event.
 *
 * Stripe signs webhooks with a signature header. We verify this using
 * STRIPE_WEBHOOK_SECRET to ensure the event is authentic.
 *
 * Handled events:
 *   - checkout.session.completed → Upgrade user to premium
 *   - customer.subscription.deleted → Downgrade user to free
 *   - customer.subscription.updated → Handle plan changes (future)
 *
 * @param env       - Worker environment with Stripe secrets
 * @param db        - D1 database for user updates
 * @param payload   - Raw request body (string)
 * @param signature - Stripe-Signature header value
 */
export async function handleWebhook(
  env: Env,
  db: D1Database,
  payload: string,
  signature: string,
): Promise<WebhookResult> {
  // Verify webhook signature
  const isValid = await verifyWebhookSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    return {
      success: false,
      eventType: 'unknown',
      message: 'Invalid webhook signature',
    };
  }

  // Parse the event
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return {
      success: false,
      eventType: 'unknown',
      message: 'Invalid JSON payload',
    };
  }

  console.log(`[stripe] Processing webhook: ${event.type}`);

  // Route to handler based on event type
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(db, event);

    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(db, event);

    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(db, event);

    case 'invoice.payment_failed':
      return handlePaymentFailed(db, event);

    default:
      // Acknowledge unhandled events (Stripe expects 200 for all events)
      return {
        success: true,
        eventType: event.type,
        message: 'Event acknowledged but not processed',
      };
  }
}

/**
 * Handle checkout.session.completed event.
 *
 * This fires when a user successfully completes checkout.
 * We upgrade them to premium and store their Stripe customer ID.
 */
async function handleCheckoutCompleted(
  db: D1Database,
  event: StripeEvent,
): Promise<WebhookResult> {
  const session = event.data.object as {
    client_reference_id?: string;
    customer?: string;
    subscription?: string;
    mode?: string;
  };

  // Only process subscription checkouts
  if (session.mode !== 'subscription') {
    return {
      success: true,
      eventType: event.type,
      message: 'Non-subscription checkout, skipping',
    };
  }

  const userId = session.client_reference_id;
  const customerId = session.customer;

  if (!userId) {
    console.error('[stripe] checkout.session.completed missing client_reference_id');
    return {
      success: false,
      eventType: event.type,
      message: 'Missing client_reference_id',
    };
  }

  if (!customerId || typeof customerId !== 'string') {
    console.error('[stripe] checkout.session.completed missing customer');
    return {
      success: false,
      eventType: event.type,
      message: 'Missing customer ID',
    };
  }

  // Upgrade the user
  try {
    await upgradeToPremium(db, userId, customerId);
    console.log(`[stripe] Upgraded user ${userId} to premium (customer: ${customerId})`);

    return {
      success: true,
      eventType: event.type,
      message: `User ${userId} upgraded to premium`,
    };
  } catch (err) {
    console.error('[stripe] Failed to upgrade user:', err);
    return {
      success: false,
      eventType: event.type,
      message: `Failed to upgrade user: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Handle customer.subscription.deleted event.
 *
 * This fires when a subscription is canceled (either immediately or at period end).
 * We downgrade the user to free tier.
 */
async function handleSubscriptionDeleted(
  db: D1Database,
  event: StripeEvent,
): Promise<WebhookResult> {
  const subscription = event.data.object as {
    customer?: string;
    metadata?: { user_id?: string };
  };

  // Try to get user ID from metadata first
  let userId = subscription.metadata?.user_id;

  // If not in metadata, look up by customer ID
  if (!userId && subscription.customer) {
    const user = await db
      .prepare('SELECT id FROM users WHERE stripe_customer_id = ?')
      .bind(subscription.customer)
      .first<{ id: string }>();

    userId = user?.id;
  }

  if (!userId) {
    console.error('[stripe] customer.subscription.deleted: could not find user');
    return {
      success: false,
      eventType: event.type,
      message: 'Could not find user for subscription',
    };
  }

  try {
    await downgradeToFree(db, userId);
    console.log(`[stripe] Downgraded user ${userId} to free`);

    return {
      success: true,
      eventType: event.type,
      message: `User ${userId} downgraded to free`,
    };
  } catch (err) {
    console.error('[stripe] Failed to downgrade user:', err);
    return {
      success: false,
      eventType: event.type,
      message: `Failed to downgrade user: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Handle customer.subscription.updated event.
 *
 * This fires on plan changes, cancellations scheduled for period end, etc.
 * For now, we just log it. In the future, we might handle:
 *   - cancel_at_period_end: true → show "canceling" status in dashboard
 *   - plan changes → update to different tier
 */
async function handleSubscriptionUpdated(
  db: D1Database,
  event: StripeEvent,
): Promise<WebhookResult> {
  const subscription = event.data.object as {
    customer?: string;
    cancel_at_period_end?: boolean;
    status?: string;
    metadata?: { user_id?: string };
  };

  console.log('[stripe] Subscription updated:', {
    customer: subscription.customer,
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });

  // If canceling at period end, we could mark the user in DB
  // For now, just acknowledge
  return {
    success: true,
    eventType: event.type,
    message: 'Subscription update acknowledged',
  };
}

/**
 * Handle invoice.payment_failed event.
 *
 * This fires when a subscription payment fails. Stripe will retry
 * automatically based on your retry settings. After all retries fail,
 * the subscription is canceled (customer.subscription.deleted fires).
 *
 * For now, we just log it. In the future, we might:
 *   - Send user an email/SMS about the failed payment
 *   - Show a warning in the dashboard
 */
async function handlePaymentFailed(
  db: D1Database,
  event: StripeEvent,
): Promise<WebhookResult> {
  const invoice = event.data.object as {
    customer?: string;
    attempt_count?: number;
  };

  console.warn('[stripe] Payment failed:', {
    customer: invoice.customer,
    attemptCount: invoice.attempt_count,
  });

  return {
    success: true,
    eventType: event.type,
    message: 'Payment failure logged',
  };
}

// ===========================================================================
// Webhook Signature Verification
// ===========================================================================

/**
 * Verify Stripe webhook signature.
 *
 * Stripe uses HMAC-SHA256 to sign webhooks. The signature header contains
 * a timestamp and signature: "t=timestamp,v1=signature"
 *
 * We compute our own signature and compare. Also validates timestamp
 * to prevent replay attacks (must be within 5 minutes).
 */
async function verifyWebhookSignature(
  payload: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    // Parse the signature header
    const elements = signatureHeader.split(',');
    const signatures: Record<string, string> = {};

    for (const element of elements) {
      const [key, value] = element.split('=');
      if (key && value) {
        signatures[key] = value;
      }
    }

    const timestamp = signatures['t'];
    const expectedSignature = signatures['v1'];

    if (!timestamp || !expectedSignature) {
      console.error('[stripe] Missing timestamp or signature in header');
      return false;
    }

    // Check timestamp is recent (within 5 minutes)
    const timestampSeconds = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    const tolerance = 300; // 5 minutes

    if (Math.abs(now - timestampSeconds) > tolerance) {
      console.error('[stripe] Webhook timestamp too old');
      return false;
    }

    // Compute expected signature
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const signatureBytes = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(signedPayload),
    );

    const computedSignature = Array.from(new Uint8Array(signatureBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Constant-time comparison
    return timingSafeEqual(computedSignature, expectedSignature);
  } catch (err) {
    console.error('[stripe] Signature verification error:', err);
    return false;
  }
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Get a Stripe customer by ID.
 * Useful for checking subscription status or retrieving customer details.
 */
export async function getStripeCustomer(
  env: Env,
  customerId: string,
): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${STRIPE_API_BASE}/customers/${customerId}`, {
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    },
  });

  if (!response.ok) {
    if (response.status === 404) {
      return null;
    }
    throw new Error('Failed to fetch customer');
  }

  return response.json() as Promise<Record<string, unknown>>;
}

/**
 * List active subscriptions for a customer.
 * Returns the first active subscription, or null if none.
 */
export async function getActiveSubscription(
  env: Env,
  customerId: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams();
  params.append('customer', customerId);
  params.append('status', 'active');
  params.append('limit', '1');

  const response = await fetch(`${STRIPE_API_BASE}/subscriptions?${params}`, {
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error('Failed to fetch subscriptions');
  }

  const result = await response.json() as { data: Record<string, unknown>[] };
  return result.data[0] || null;
}
