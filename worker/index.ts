/**
 * Network Manager — Cloudflare Worker Entry Point
 */

import { Env } from '../shared/types';
import { getCorsHeaders, jsonResponse, errorResponse } from '../shared/http';
import { handleSmsWebhook } from './routes/sms';
import { handleSignupPost, handleSignupPage, handleSignupComplete } from './routes/signup';
import { handleApiRoute } from './routes/api';
import { handleScheduled } from './cron/scheduled';
import { handleGoogleCallback } from './routes/google-auth';

export { OnboardingDO } from './services/onboarding-service';
export { UserDiscoveryDO } from './services/user-discovery-service';
export { NudgeContextDO } from './services/nudge-conversation-flow';
export { IntentContextDO as IntentSortingDO } from './services/intent-assignment-flow';

const VERSION = {
  version: '0.14.0',
  updated: '2026-02-11',
  codename: 'network-manager',
};

/**
 * Force correct CORS headers on every response.
 * 
 * Cloudflare's workers.dev proxy may inject Access-Control-Allow-Origin: *
 * which conflicts with credentials: 'include'. This wrapper deletes any
 * existing CORS headers and re-sets them from our getCorsHeaders() function.
 */
function enforceCors(response: Response, origin: string | null): Response {
  const newResponse = new Response(response.body, response);
  
  // Delete any CORS headers that Cloudflare or sub-handlers may have set
  newResponse.headers.delete('Access-Control-Allow-Origin');
  newResponse.headers.delete('Access-Control-Allow-Methods');
  newResponse.headers.delete('Access-Control-Allow-Headers');
  newResponse.headers.delete('Access-Control-Allow-Credentials');
  
  // Re-set with our correct values
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newResponse.headers.set(key, value);
  }
  
  return newResponse;
}

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

    let response: Response;

    try {
      if (url.pathname === '/health') {
        response = jsonResponse({
          status: 'ok',
          ...VERSION,
          timestamp: new Date().toISOString(),
        }, 200, origin);
      } else if (url.pathname === '/version') {
        response = new Response(
          `Network Manager v${VERSION.version} (${VERSION.codename})`,
          { headers: { ...getCorsHeaders(origin), 'Content-Type': 'text/plain' } }
        );
      } else if (url.pathname === '/signup' && request.method === 'GET') {
        response = handleSignupPage();
      } else if (url.pathname === '/signup' && request.method === 'POST') {
        response = await handleSignupPost(request, env, ctx);
      } else if (url.pathname === '/auth/callback' && request.method === 'GET') {
        response = await handleSignupComplete(request, env);
      } else if (url.pathname === '/api/auth/google/callback' && request.method === 'GET') {
        response = await handleGoogleCallback(request, env, ctx);
      } else if ((url.pathname === '/webhook/sms' || url.pathname === '/webhook/sendblue') && request.method === 'POST') {
        // SMS webhooks don't need CORS — return directly
        return handleSmsWebhook(request, env, ctx);
      } else if (url.pathname.startsWith('/api/')) {
        response = await handleApiRoute(request, env, ctx);
      } else if (url.pathname.startsWith('/internal/')) {
        const apiKey = request.headers.get('X-API-Key');
        if (apiKey !== env.INTERNAL_API_KEY) {
          response = errorResponse('Unauthorized', 401, undefined, origin);
        } else {
          response = errorResponse('Not implemented', 501, undefined, origin);
        }
      } else {
        response = errorResponse('Not found', 404, undefined, origin);
      }
    } catch (err) {
      console.error('Unhandled error:', err);
      response = errorResponse('Internal server error', 500, undefined, origin);
    }

    // Force correct CORS on every response — overrides any Cloudflare injection
    return enforceCors(response, origin);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(event, env, ctx));
  },
};
