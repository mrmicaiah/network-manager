import { useState, useEffect, useCallback } from 'react';
import { API_URL } from '../config';

/**
 * Resolve a URL for API calls.
 *
 * In development, Vite's proxy handles /api/* → localhost:8787.
 * In production, we need to prefix with the full worker URL
 * because the dashboard (Pages) and worker are on different origins.
 *
 * Absolute URLs (https://...) are left unchanged.
 * Relative URLs (/api/...) get the API_URL prefix in production.
 */
function resolveUrl(url: string): string {
  // Already absolute
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // In dev, Vite proxy handles /api/* — use relative URL
  if (import.meta.env.DEV) {
    return url;
  }

  // In production, prefix with worker URL
  return `${API_URL}${url}`;
}

/**
 * Simple fetch wrapper with loading/error state.
 * 
 * Supports conditional fetching by passing null as the URL.
 * When URL is null, the hook returns { data: null, isLoading: false }
 * without making a request.
 *
 * Relative URLs (e.g. '/api/contacts') are automatically resolved
 * to the full worker URL in production.
 */
export function useApi<T>(url: string | null, options?: RequestInit) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);

  const resolvedUrl = url ? resolveUrl(url) : null;

  const fetchData = useCallback(async () => {
    if (!resolvedUrl) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(resolvedUrl, {
        credentials: 'include',
        ...options,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed: ${res.status}`);
      }

      const json = await res.json();
      setData(json.data ?? json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [resolvedUrl, JSON.stringify(options)]);

  useEffect(() => {
    if (resolvedUrl) {
      fetchData();
    } else {
      setData(null);
      setIsLoading(false);
    }
  }, [resolvedUrl, fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

/**
 * Lazy fetch — doesn't run on mount.
 *
 * Relative URLs are automatically resolved to the full worker URL
 * in production.
 */
export function useLazyApi<T>() {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (url: string, options?: RequestInit) => {
    const resolvedUrl = resolveUrl(url);

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(resolvedUrl, {
        credentials: 'include',
        ...options,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed: ${res.status}`);
      }

      const json = await res.json();
      setData(json.data ?? json);
      return json.data ?? json;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { data, isLoading, error, execute };
}
