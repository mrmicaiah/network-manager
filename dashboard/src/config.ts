/**
 * Dashboard configuration.
 *
 * VITE_API_URL should be set in Cloudflare Pages environment variables.
 * Falls back to the workers.dev subdomain if not set.
 */
export const API_URL =
  import.meta.env.VITE_API_URL ||
  'https://network-manager.micaiah-tasks.workers.dev';
