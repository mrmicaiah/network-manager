import { useState, useEffect, useCallback } from 'react';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  Check,
  AlertCircle,
  Loader2,
  RefreshCw,
  Unlink,
  ExternalLink,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface GoogleStatus {
  connected: boolean;
  scopes: string[] | null;
  lastSync: string | null;
  hasSyncToken: boolean;
}

interface SyncResult {
  imported: number;
  duplicates: number;
  updated: number;
  skipped: number;
  errors: number;
}

// ===========================================================================
// Google Contacts Integration Card
// ===========================================================================

/**
 * Displays Google Contacts connection status and provides connect/disconnect/
 * re-sync controls. Shown inside the Integrations section of SettingsPage.
 *
 * Handles the ?google=success|error URL params set by the OAuth callback
 * redirect (worker/routes/google-auth.ts → redirectToDashboard).
 */
export function GoogleContactsCard() {
  const { data: status, isLoading, refetch } = useApi<GoogleStatus>('/api/auth/google/status');
  const { execute: apiCall } = useLazyApi();

  const [isConnecting, setIsConnecting] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  // Handle OAuth redirect params (?google=success|error)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const googleParam = params.get('google');
    const reason = params.get('reason');

    if (googleParam === 'success') {
      setMessage({
        type: 'info',
        text: 'Google Contacts connected! Bethany is importing your contacts in the background — she\'ll text you when it\'s done.',
      });
      // Refresh status to show connected state
      refetch();
    } else if (googleParam === 'error') {
      const errorMessages: Record<string, string> = {
        denied: 'You declined the Google Contacts permission. No worries — you can connect anytime.',
        missing_params: 'Something went wrong with the Google sign-in. Please try again.',
        exchange_failed: 'Failed to complete Google sign-in. Please try again.',
      };
      setMessage({
        type: 'error',
        text: errorMessages[reason || ''] || 'Something went wrong connecting Google Contacts. Please try again.',
      });
    }

    // Clean up URL params
    if (googleParam) {
      const url = new URL(window.location.href);
      url.searchParams.delete('google');
      url.searchParams.delete('reason');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
  }, [refetch]);

  // Connect — opens Google OAuth in same window
  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setMessage(null);

    try {
      const result = await apiCall('/api/auth/google/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (result?.authUrl) {
        // Redirect to Google OAuth consent screen
        window.location.href = result.authUrl;
      }
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to start Google connection',
      });
      setIsConnecting(false);
    }
  }, [apiCall]);

  // Disconnect
  const handleDisconnect = useCallback(async () => {
    if (!confirm('Disconnect Google Contacts? Your imported contacts will stay, but automatic sync will stop.')) {
      return;
    }

    setIsDisconnecting(true);
    setMessage(null);

    try {
      await apiCall('/api/auth/google/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      setMessage({ type: 'success', text: 'Google Contacts disconnected' });
      setSyncResult(null);
      await refetch();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to disconnect',
      });
    } finally {
      setIsDisconnecting(false);
    }
  }, [apiCall, refetch]);

  // Re-sync
  const handleSync = useCallback(async () => {
    setIsSyncing(true);
    setMessage(null);
    setSyncResult(null);

    try {
      const result = await apiCall('/api/auth/google/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      setSyncResult(result as SyncResult);
      setMessage({
        type: 'success',
        text: formatSyncResult(result as SyncResult),
      });
      await refetch();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Sync failed',
      });
    } finally {
      setIsSyncing(false);
    }
  }, [apiCall, refetch]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-between p-3 bg-cream rounded-xl">
        <div className="flex items-center gap-3">
          <GoogleIcon />
          <div>
            <p className="font-medium text-charcoal">Google Contacts</p>
            <p className="text-sm text-charcoal-light">Checking connection...</p>
          </div>
        </div>
        <Loader2 className="w-5 h-5 text-charcoal-light animate-spin" />
      </div>
    );
  }

  const isConnected = status?.connected ?? false;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between p-3 bg-cream rounded-xl">
        <div className="flex items-center gap-3">
          <GoogleIcon />
          <div>
            <p className="font-medium text-charcoal">Google Contacts</p>
            <p className="text-sm text-charcoal-light">
              {isConnected
                ? status?.lastSync
                  ? `Last synced ${formatRelativeTime(status.lastSync)}`
                  : 'Connected'
                : 'Import contacts from your Google account'}
            </p>
          </div>
        </div>

        {isConnected ? (
          <span className="badge-success flex items-center gap-1">
            <Check className="w-3 h-3" />
            Connected
          </span>
        ) : null}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        {isConnected ? (
          <>
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="btn-secondary text-sm flex-1"
            >
              {isSyncing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Syncing...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4" />
                  Re-sync contacts
                </>
              )}
            </button>
            <button
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="px-4 py-2 text-sm text-red-600 hover:bg-red-50 rounded-xl transition-colors flex items-center gap-2"
            >
              {isDisconnecting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Unlink className="w-4 h-4" />
              )}
              Disconnect
            </button>
          </>
        ) : (
          <button
            onClick={handleConnect}
            disabled={isConnecting}
            className="btn-primary text-sm w-full"
          >
            {isConnecting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Connecting...
              </>
            ) : (
              <>
                <ExternalLink className="w-4 h-4" />
                Connect Google Contacts
              </>
            )}
          </button>
        )}
      </div>

      {/* Status message */}
      {message && (
        <div
          className={`p-3 rounded-xl text-sm flex items-start gap-2 ${
            message.type === 'success'
              ? 'bg-sage-50 text-sage-700'
              : message.type === 'info'
              ? 'bg-bethany-50 text-bethany-700'
              : 'bg-red-50 text-red-700'
          }`}
        >
          {message.type === 'success' ? (
            <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : message.type === 'info' ? (
            <Check className="w-4 h-4 mt-0.5 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          )}
          {message.text}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

function GoogleIcon() {
  return (
    <div className="w-10 h-10 bg-warm-white rounded-xl flex items-center justify-center border border-cream-dark">
      <svg className="w-5 h-5" viewBox="0 0 24 24">
        <path
          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
          fill="#4285F4"
        />
        <path
          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          fill="#34A853"
        />
        <path
          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          fill="#FBBC05"
        />
        <path
          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          fill="#EA4335"
        />
      </svg>
    </div>
  );
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(isoDate).toLocaleDateString();
}

function formatSyncResult(result: SyncResult): string {
  const parts: string[] = [];
  if (result.imported > 0) parts.push(`${result.imported} imported`);
  if (result.updated > 0) parts.push(`${result.updated} updated`);
  if (result.duplicates > 0) parts.push(`${result.duplicates} duplicates skipped`);
  if (result.errors > 0) parts.push(`${result.errors} errors`);

  if (parts.length === 0) {
    return 'Everything is up to date — no new contacts found.';
  }
  return `Sync complete: ${parts.join(', ')}.`;
}
