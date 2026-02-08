import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Auth Callback Page
 * 
 * Handles the redirect from signup with a one-time login token.
 * 
 * Flow:
 * 1. User signs up on marketing site
 * 2. Marketing site redirects to: /auth/callback?token=xxx
 * 3. This page redirects to the worker: /auth/callback?token=xxx
 * 4. Worker validates token, sets session cookie, redirects to /welcome
 * 5. /welcome page loads with valid session
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      setError(getErrorMessage(errorParam));
      return;
    }

    // If we have a token, redirect to the worker to exchange it
    // The worker will set the cookie and redirect back to /welcome
    if (token) {
      const apiUrl = import.meta.env.VITE_API_URL || 'https://network-manager.micaiah-tasks.workers.dev';
      // Full page redirect - this allows the cookie to be set properly
      window.location.href = `${apiUrl}/auth/callback?token=${token}`;
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
