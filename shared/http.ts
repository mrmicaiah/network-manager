/**
 * HTTP utilities — CORS headers, JSON response helpers.
 */

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
  'Access-Control-Allow-Credentials': 'true',
};

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

export function errorResponse(message: string, status = 400, code?: string): Response {
  const body = code ? { error: message, code } : { error: message };
  return jsonResponse(body, status);
}

/**
 * Create a JSON response with a Set-Cookie header.
 * Useful for auth responses that need to set session cookies.
 */
export function jsonResponseWithCookie(
  data: unknown,
  cookie: string,
  status = 200,
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    },
  });
}
