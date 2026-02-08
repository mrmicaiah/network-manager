import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Auth Callback Page
 * 
 * Handles the redirect from signup with a one-time login token.
 * The worker's /auth/callback endpoint sets the session cookie and redirects here.
 * 
 * This page just checks if we're authenticated and redirects accordingly.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading, refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      setError(getErrorMessage(errorParam));
      return;
    }

    // If we have a token, we need to exchange it via the API
    // The API will set the cookie and we'll redirect
    if (token) {
      exchangeToken(token);
      return;
    }

    // No token - check if we're already authenticated
    if (!isLoading) {
      if (isAuthenticated) {
        navigate('/welcome', { replace: true });
      } else {
        navigate('/login?welcome=true', { replace: true });
      }
    }
  }, [searchParams, isAuthenticated, isLoading, navigate]);

  const exchangeToken = async (token: string) => {
    try {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://network-manager.micaiah-tasks.workers.dev';
      
      // Call the auth callback endpoint which will set the cookie
      const response = await fetch(`${apiUrl}/auth/callback?token=${token}`, {
        method: 'GET',
        credentials: 'include',
        redirect: 'manual', // Don't follow redirects automatically
      });

      // The API returns a redirect, but we want to handle it ourselves
      // to properly refresh the auth state
      if (response.type === 'opaqueredirect' || response.status === 302) {
        // Cookie should be set, refresh auth and redirect
        await refreshUser();
        navigate('/welcome', { replace: true });
      } else if (!response.ok) {
        setError('Failed to complete login. Please try logging in manually.');
      }
    } catch (err) {
      console.error('Token exchange failed:', err);
      setError('Something went wrong. Please try logging in manually.');
    }
  };

  const getErrorMessage = (code: string): string => {
    switch (code) {
      case 'missing_token':
        return 'Login link is invalid. Please try logging in manually.';
      case 'invalid_token':
        return 'Login link has expired. Please try logging in manually.';
      case 'user_not_found':
        return 'Account not found. Please try signing up again.';
      default:
        return 'Something went wrong. Please try logging in manually.';
    }
  };

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream px-4">
        <div className="w-full max-w-sm">
          <div className="card text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">😕</span>
            </div>
            <h1 className="font-display text-2xl font-medium text-charcoal mb-3">
              Oops!
            </h1>
            <p className="text-charcoal-light mb-6">{error}</p>
            <button
              onClick={() => navigate('/login?welcome=true', { replace: true })}
              className="btn-primary w-full"
            >
              Go to Login
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-cream">
      <div className="text-center">
        <div className="w-12 h-12 border-4 border-bethany-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p className="text-charcoal-light">Setting up your account...</p>
      </div>
    </div>
  );
}
