/**
 * Magic Link Route Handler — Dashboard auto-login via SMS links
 *
 * Handles GET /api/auth/magic?token=xxx
 *
 * When Bethany sends a dashboard link via SMS, it contains a signed
 * magic token. This route:
 *
 *   1. Verifies the token (valid, not expired, not already used)
 *   2. Creates a session cookie (same as normal login)
 *   3. Redirects to the target dashboard page
 *
 * The token is consumed on first use (single-use for security).
 *
 * @see worker/services/dashboard-awareness.ts for token generation
 * @see worker/services/auth-service.ts for session creation
 */

import type { Env } from '../../shared/types';
import { verifyMagicLink } from '../services/dashboard-awareness';

/**
 * Handle GET /api/auth/magic?token=xxx
 *
 * Verifies the magic link token and redirects to the dashboard
 * with a session cookie set.
 */
export async function handleMagicLink(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return buildErrorPage('Missing token', 'This link appears to be incomplete. Text Bethany for a new dashboard link.');
  }

  const result = await verifyMagicLink(env, token);

  if (!result.valid) {
    const titles: Record<string, string> = {
      invalid: 'Invalid Link',
      expired: 'Link Expired',
      consumed: 'Link Already Used',
    };

    return buildErrorPage(
      titles[result.reason] ?? 'Invalid Link',
      result.message,
    );
  }

  // Success — redirect to the target page with session cookie set
  const dashboardUrl = env.DASHBOARD_URL || 'https://app.bethany.network';
  const redirectUrl = `${dashboardUrl}${result.redirect}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl,
      'Set-Cookie': result.cookie,
    },
  });
}

/**
 * Build a simple error page for invalid magic links.
 *
 * Keeps Bethany's friendly tone even in error states.
 */
function buildErrorPage(title: string, message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Bethany Network Manager</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f8fafc;
      color: #1e293b;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 2rem;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      text-align: center;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #64748b; line-height: 1.6; margin-bottom: 1.5rem; }
    .hint {
      font-size: 0.875rem;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
      padding-top: 1rem;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔗</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <p class="hint">Just text Bethany and ask for a new dashboard link!</p>
  </div>
</body>
</html>`;

  return new Response(html, {
    status: 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}