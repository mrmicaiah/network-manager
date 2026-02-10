/**
 * Network Manager — Cloudflare Worker Entry Point
 *
 * Handles:
 *   - Web signup (GET = page, POST = create account)
 *   - SMS webhook routing (inbound messages from SendBlue)
 *   - Dashboard API endpoints
 *   - Google OAuth callback (unauthenticated redirect from Google)
 *   - Cron triggers for nudges and health checks
 *   - Internal API for service communication
 *
 * The assistant personality is named Bethany — she handles all SMS
 * conversations with users.
 *
 * IMPORTANT: All Durable Object classes MUST be re-exported from this
 * entry point for Wrangler to register them.
 */

import { Env } from '../shared/types';
import { getCorsHeaders, jsonResponse, errorResponse } from '../shared/http';
import { handleSmsWebhook } from './routes/sms';
import { handleSignupPost, handleSignupPage, handleSignupComplete } from './routes/signup';
import { handleApiRoute } from './routes/api';
import { handleScheduled } from './cron/scheduled';
import { handleGoogleCallback } from './routes/google-auth';

// Re-export Durable Object classes — Wrangler requires these at the entry point
export { OnboardingDO } from './services/onboarding-service';
export { UserDiscoveryDO } from './services/user-discovery-service';
export { NudgeContextDO } from './services/nudge-conversation-flow';
// Rename IntentContextDO -> IntentSortingDO for wrangler.toml compatibility
export { IntentContextDO as IntentSortingDO } from './services/intent-assignment-flow';

const VERSION = {
  version: '0.13.0',
  updated: '2026-02-10',
  codename: 'network-manager',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        status: 204,
        headers: getCorsHeaders(origin),
      });
    }

    try {
      // ===========================================
      // Health & Version
      // ===========================================
      if (url.pathname === '/health') {
        return jsonResponse({
          status: 'ok',
          ...VERSION,
          timestamp: new Date().toISOString(),
        }, 200, origin);
      }

      if (url.pathname === '/version') {
        return new Response(
          `Network Manager v${VERSION.version} (${VERSION.codename})`,
          { headers: { ...getCorsHeaders(origin), 'Content-Type': 'text/plain' } }
        );
      }

      // ===========================================
      // Web Signup
      // ===========================================
      if (url.pathname === '/signup') {
        if (request.method === 'GET') {
          return handleSignupPage();
        }
        if (request.method === 'POST') {
          return handleSignupPost(request, env, ctx);
        }
        return errorResponse('Method not allowed', 405, undefined, origin);
      }

      // Token exchange for post-signup redirect
      if (url.pathname === '/auth/callback' && request.method === 'GET') {
        return handleSignupComplete(request, env);
      }

      // ===========================================
      // Google OAuth Callback (unauthenticated)
      //
      // This MUST be before the /api/ check because the callback
      // doesn't use session auth — it verifies via HMAC state param.
      // Google redirects here after user consents/denies.
      // ===========================================
      if (url.pathname === '/api/auth/google/callback' && request.method === 'GET') {
        return handleGoogleCallback(request, env, ctx);
      }

      // ===========================================
      // SMS Webhook (SendBlue inbound)
      // Accepts both /webhook/sms and /webhook/sendblue
      // ===========================================
      if ((url.pathname === '/webhook/sms' || url.pathname === '/webhook/sendblue') && request.method === 'POST') {
        return handleSmsWebhook(request, env, ctx);
      }

      // ===========================================
      // Dashboard API
      // ===========================================
      if (url.pathname.startsWith('/api/')) {
        return handleApiRoute(request, env, ctx);
      }

      // ===========================================
      // Internal API
      // ===========================================
      if (url.pathname.startsWith('/internal/')) {
        const apiKey = request.headers.get('X-API-Key');
        if (apiKey !== env.INTERNAL_API_KEY) {
          return errorResponse('Unauthorized', 401, undefined, origin);
        }
        // TODO: Internal API routes
        return errorResponse('Not implemented', 501, undefined, origin);
      }

      return errorResponse('Not found', 404, undefined, origin);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse('Internal server error', 500, undefined, origin);
    }
  },

  /**
   * Scheduled event handler for Cloudflare Cron Triggers.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env, ctx));
  },
};
