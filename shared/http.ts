/**
 * HTTP utilities — CORS headers, JSON response helpers.
 */

/**
 * Allowed origins for CORS.
 *
 * The dashboard is a separate Cloudflare Pages deployment that talks to
 * the worker API cross-origin, so correct origin matching is critical
 * for cookies (credentials: 'include') to work.
 *
 * Cloudflare Pages preview deployments get random subdomains like
 * `abc123.network-manager.pages.dev` — those are handled by the
 * wildcard check below.
 */
const ALLOWED_ORIGINS = [
  // Production dashboard (Cloudflare Pages)
  'https://network-manager.pages.dev',
  // Marketing / signup site
  'https://network-manager-site.pages.dev',
  // Local development
  'http://localhost:5173',
  'http://localhost:3000',
];

/**
 * Check if an origin is allowed, including Cloudflare Pages preview deploys.
 *
 * Preview URLs look like: https://<hash>.network-manager.pages.dev
 */
function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Allow Cloudflare Pages preview deployments
  if (/^https:\/\/[a-z0-9]+\.network-manager\.pages\.dev$/.test(origin)) return true;
  if (/^https:\/\/[a-z0-9]+\.network-manager-site\.pages\.dev$/.test(origin)) return true;

  return false;
}

/**
 * Get CORS headers for a specific origin.
 * Returns the request origin if allowed, otherwise the production dashboard origin.
 */
export function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const origin = requestOrigin && isAllowedOrigin(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * Default CORS headers — uses production dashboard origin.
 * Prefer getCorsHeaders(requestOrigin) when the request is available.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://network-manager.pages.dev',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  'Access-Control-Allow-Credentials': 'true',
};

export function jsonResponse(data: unknown, status = 200, origin?: string | null): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...(origin ? getCorsHeaders(origin) : corsHeaders),
      'Content-Type': 'application/json',
    },
  });
}

export function errorResponse(message: string, status = 400, code?: string, origin?: string | null): Response {
  const body = code ? { error: message, code } : { error: message };
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...(origin ? getCorsHeaders(origin) : corsHeaders),
      'Content-Type': 'application/json',
    },
  });
}

/**
 * Create a JSON response with a Set-Cookie header.
 * Useful for auth responses that need to set session cookies.
 */
export function jsonResponseWithCookie(
  data: unknown,
  cookie: string,
  status = 200,
  origin?: string | null,
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...(origin ? getCorsHeaders(origin) : corsHeaders),
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}
