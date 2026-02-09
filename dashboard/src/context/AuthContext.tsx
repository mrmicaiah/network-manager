import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';

// ===========================================================================
// Configuration
// ===========================================================================

/** API base URL — falls back to same-origin if not set */
const API_URL = import.meta.env.VITE_API_URL || '';

// ===========================================================================
// Types
// ===========================================================================

export interface User {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  subscriptionTier: 'free' | 'trial' | 'premium';
  roles: string[];
  permissions: string[];
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextValue extends AuthState {
  login: (phone: string, code: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  requestCode: (phone: string) => Promise<{ success: boolean; error?: string }>;
  refreshUser: () => Promise<void>;
}

// ===========================================================================
// Context
// ===========================================================================

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// ===========================================================================
// Provider
// ===========================================================================

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  });

  // Check session on mount
  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const res = await fetch(`${API_URL}/api/auth/me`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        setState({
          user: {
            id: data.user.id,
            name: data.user.name,
            phone: data.user.phone,
            email: data.user.email,
            subscriptionTier: data.user.subscriptionTier,
            roles: data.user.roles ?? [],
            permissions: data.user.permissions ?? [],
          },
          isLoading: false,
          isAuthenticated: true,
        });
      } else {
        setState({
          user: null,
          isLoading: false,
          isAuthenticated: false,
        });
      }
    } catch {
      setState({
        user: null,
        isLoading: false,
        isAuthenticated: false,
      });
    }
  };

  const requestCode = useCallback(async (phone: string) => {
    try {
      const res = await fetch(`${API_URL}/api/auth/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone }),
      });

      const data = await res.json();

      if (res.ok) {
        return { success: true };
      } else {
        return { success: false, error: data.error || 'Failed to send code' };
      }
    } catch {
      return { success: false, error: 'Network error' };
    }
  }, []);

  const login = useCallback(async (phone: string, code: string) => {
    try {
      const res = await fetch(`${API_URL}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone, code }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        // After login, fetch full user info including roles/permissions
        await checkSession();
        return { success: true };
      } else {
        return {
          success: false,
          error: data.error || 'Invalid code',
        };
      }
    } catch {
      return { success: false, error: 'Network error' };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch(`${API_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Ignore errors — clear local state anyway
    }

    setState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
    });
  }, []);

  const refreshUser = useCallback(async () => {
    await checkSession();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        logout,
        requestCode,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
