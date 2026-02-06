/**
 * Bethany Network Manager — Cloudflare Worker Entry Point
 *
 * Handles:
 *   - Web signup (GET = page, POST = create account)
 *   - SMS webhook routing (inbound messages from SendBlue)
 *   - Dashboard API endpoints
 *   - Cron triggers for nudges and health checks
 *   - Internal API for Bethany worker communication
 *
 * IMPORTANT: All Durable Object classes MUST be re-exported from this
 * entry point for Wrangler to register them.
 */

import { Env } from '../shared/types';
import { corsHeaders, jsonResponse, errorResponse } from '../shared/http';
import { handleSmsWebhook } from './routes/sms';
import { handleSignupPost, handleSignupPage } from './routes/signup';
import { handleApiRoute } from './routes/api';
import { handleScheduled } from './cron/scheduled';

// Re-export Durable Object classes — Wrangler requires these at the entry point
export { OnboardingDO } from './services/onboarding-service';
export { UserDiscoveryDO } from './services/user-discovery-service';
export { NudgeContextDO } from './services/nudge-conversation-flow';
export { IntentSortingDO } from './services/intent-assignment-flow';

const VERSION = {
  version: '0.10.0',
  updated: '2026-02-05',
  codename: 'intent-sorting',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
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
        });
      }

      if (url.pathname === '/version') {
        return new Response(
          `Bethany Network Manager v${VERSION.version} (${VERSION.codename})`,
          { headers: { ...corsHeaders, 'Content-Type': 'text/plain' } }
        );
      }

      // ===========================================
      // Web Signup (TASK-7cfa060a-2)
      // ===========================================
      if (url.pathname === '/signup') {
        if (request.method === 'GET') {
          return handleSignupPage();
        }
        if (request.method === 'POST') {
          return handleSignupPost(request, env, ctx);
        }
        return errorResponse('Method not allowed', 405);
      }

      // ===========================================
      // SMS Webhook (SendBlue inbound)
      // ===========================================
      if (url.pathname === '/webhook/sms' && request.method === 'POST') {
        return handleSmsWebhook(request, env, ctx);
      }

      // ===========================================
      // Dashboard API (TASK-c3d31ee9-3)
      // ===========================================
      if (url.pathname.startsWith('/api/')) {
        return handleApiRoute(request, env, ctx);
      }

      // ===========================================
      // Internal API (Bethany worker → Network Manager)
      // ===========================================
      if (url.pathname.startsWith('/internal/')) {
        const apiKey = request.headers.get('X-API-Key');
        if (apiKey !== env.INTERNAL_API_KEY) {
          return errorResponse('Unauthorized', 401);
        }
        // TODO: TASK — Internal API routes
        return errorResponse('Not implemented', 501);
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return errorResponse('Internal server error', 500);
    }
  },

  /**
   * Scheduled event handler for Cloudflare Cron Triggers.
   *
   * Routes all cron events to the scheduled jobs module which dispatches
   * to individual job handlers based on the cron expression.
   *
   * Cron jobs:
   *   - Daily nudge generation (3am Central) — premium/trial users
   *   - Weekly nudge digest (Monday 3am Central) — free tier users
   *   - Nudge delivery (8am Central) — sends pending nudges via SendBlue
   *   - Trial expiration check (midnight) — downgrades expired trials
   *   - Usage data cleanup (midnight) — purges old usage rows
   *   - Health recalculation (Sunday midnight) — refreshes contact health
   *
   * @see worker/cron/scheduled.ts for job implementations
   * @see wrangler.toml [triggers] for cron expressions
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env, ctx));
  },
};
