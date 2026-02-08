/**
 * HTTP utilities — CORS headers, JSON response helpers.
 */

/** Allowed origins for CORS */
const ALLOWED_ORIGINS = [
  'https://bethany-dashboard.pages.dev',
  'https://network-manager-site.pages.dev',
  'https://network-manager.pages.dev',
  'http://localhost:5173',
  'http://localhost:3000',
];

/**
 * Get CORS headers for a specific origin.
 * Returns the origin if it's in the allowed list, otherwise the first allowed origin.
 */
export function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const origin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
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
 * Default CORS headers - uses first allowed origin.
 * For backwards compatibility, but prefer getCorsHeaders() with the request origin.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': 'https://bethany-dashboard.pages.dev',
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
