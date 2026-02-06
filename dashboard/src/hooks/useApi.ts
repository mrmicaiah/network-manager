import { useState, useEffect, useCallback } from 'react';

/**
 * Simple fetch wrapper with loading/error state.
 * 
 * Supports conditional fetching by passing null as the URL.
 * When URL is null, the hook returns { data: null, isLoading: false }
 * without making a request.
 */
export function useApi<T>(url: string | null, options?: RequestInit) {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!url) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(url, {
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
  }, [url, JSON.stringify(options)]);

  useEffect(() => {
    if (url) {
      fetchData();
    } else {
      setData(null);
      setIsLoading(false);
    }
  }, [url, fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

/**
 * Lazy fetch — doesn't run on mount.
 */
export function useLazyApi<T>() {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async (url: string, options?: RequestInit) => {
    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(url, {
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
