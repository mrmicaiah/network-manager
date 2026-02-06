import { useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  Crown,
  Clock,
  Zap,
  Users,
  MessageSquare,
  Brain,
  Shield,
  LogOut,
  Check,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  ChevronRight,
  Sparkles,
  Download,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface SubscriptionData {
  tier: 'free' | 'trial' | 'premium';
  isTrialActive: boolean;
  trialEndsAt: string | null;
  isPremium: boolean;
  hasStripe: boolean;
}

interface UsageData {
  messagesUsedToday: number;
  messagesLimit: number;
  contactsCount: number;
  contactsLimit: number;
  braindumpsUsedToday: number;
  braindumpsLimit: number;
}

// ===========================================================================
// Constants
// ===========================================================================

const FREE_TIER_LIMITS = {
  max_contacts: 15,
  max_messages_per_day: 10,
  max_braindumps_per_day: 1,
};

// ===========================================================================
// Component
// ===========================================================================

export function SettingsPage() {
  const { user, logout, refreshUser } = useAuth();
  const { data: subscription } = useApi<SubscriptionData>('/api/subscription');
  const { data: healthData } = useApi<{ total: number }>('/api/contacts/health');

  // Profile edit state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // PIN change state
  const [showPinModal, setShowPinModal] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showCurrentPin, setShowCurrentPin] = useState(false);
  const [showNewPin, setShowNewPin] = useState(false);
  const [isChangingPin, setIsChangingPin] = useState(false);
  const [pinMessage, setPinMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Logout state
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const { execute: updateUser } = useLazyApi();
  const { execute: changePin } = useLazyApi();

  // Calculate trial days remaining
  const trialDaysLeft = subscription?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(subscription.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
    : null;

  // Mock usage data (would come from API in real implementation)
  const usageData: UsageData = {
    messagesUsedToday: 3,
    messagesLimit: FREE_TIER_LIMITS.max_messages_per_day,
    contactsCount: healthData?.total ?? 0,
    contactsLimit: FREE_TIER_LIMITS.max_contacts,
    braindumpsUsedToday: 0,
    braindumpsLimit: FREE_TIER_LIMITS.max_braindumps_per_day,
  };

  // Save profile changes
  const handleSaveProfile = useCallback(async () => {
    setIsSavingProfile(true);
    setProfileMessage(null);

    try {
      await updateUser('/api/user', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim() || null,
        }),
      });

      await refreshUser();
      setProfileMessage({ type: 'success', text: 'Profile updated' });
    } catch (err) {
      setProfileMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to update profile',
      });
    } finally {
      setIsSavingProfile(false);
    }
  }, [name, email, updateUser, refreshUser]);

  // Change PIN
  const handleChangePin = useCallback(async () => {
    setPinMessage(null);

    if (newPin.length !== 4 || !/^\d{4}$/.test(newPin)) {
      setPinMessage({ type: 'error', text: 'PIN must be 4 digits' });
      return;
    }

    if (newPin !== confirmPin) {
      setPinMessage({ type: 'error', text: 'PINs do not match' });
      return;
    }

    setIsChangingPin(true);

    try {
      await changePin('/api/user/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          current_pin: currentPin,
          new_pin: newPin,
        }),
      });

      setPinMessage({ type: 'success', text: 'PIN changed successfully' });
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      
      // Close modal after success
      setTimeout(() => {
        setShowPinModal(false);
        setPinMessage(null);
      }, 1500);
    } catch (err) {
      setPinMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to change PIN',
      });
    } finally {
      setIsChangingPin(false);
    }
  }, [currentPin, newPin, confirmPin, changePin]);

  // Logout
  const handleLogout = useCallback(async () => {
    setIsLoggingOut(true);
    await logout();
  }, [logout]);

  // Export contacts
  const handleExport = useCallback(() => {
    window.location.href = '/api/export';
  }, []);

  const isFreeOrTrial = subscription?.tier === 'free' || subscription?.tier === 'trial';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900">Settings</h1>

      {/* Subscription Card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="font-medium text-gray-900">Subscription</h2>
          {subscription?.isPremium && (
            <span className="px-2 py-1 bg-violet-100 text-violet-700 text-xs font-medium rounded-full flex items-center gap-1">
              <Crown className="w-3 h-3" />
              Premium
            </span>
          )}
        </div>
        <div className="p-5">
          {/* Status display */}
          {subscription?.isPremium ? (
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-violet-100 rounded-xl flex items-center justify-center">
                <Crown className="w-6 h-6 text-violet-600" />
              </div>
              <div>
                <p className="font-medium text-gray-900">Premium Plan</p>
                <p className="text-sm text-gray-500 mt-1">
                  Unlimited contacts, messages, and all premium features
                </p>
              </div>
            </div>
          ) : subscription?.isTrialActive ? (
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center">
                <Clock className="w-6 h-6 text-blue-600" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-900">Trial</p>
                  <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">
                    {trialDaysLeft} days left
                  </span>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                  Full access to all features during your trial
                </p>
                {/* Trial progress bar */}
                <div className="mt-3">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500"
                      style={{ width: `${Math.max(0, 100 - (trialDaysLeft ?? 0) * (100 / 14))}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center">
                <Zap className="w-6 h-6 text-gray-600" />
              </div>
              <div>
                <p className="font-medium text-gray-900">Free Plan</p>
                <p className="text-sm text-gray-500 mt-1">
                  Limited to {FREE_TIER_LIMITS.max_contacts} contacts and {FREE_TIER_LIMITS.max_messages_per_day} messages/day
                </p>
              </div>
            </div>
          )}

          {/* Upgrade CTA */}
          {!subscription?.isPremium && (
            <button
              onClick={() => window.location.href = '/api/subscription/checkout'}
              className="mt-4 w-full px-4 py-3 bg-gradient-to-r from-bethany-500 to-violet-500 text-white font-medium rounded-lg hover:from-bethany-600 hover:to-violet-600 transition-all flex items-center justify-center gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Upgrade to Premium
            </button>
          )}
        </div>
      </div>

      {/* Usage Stats (Free/Trial only) */}
      {isFreeOrTrial && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-200">
            <h2 className="font-medium text-gray-900">Usage</h2>
          </div>
          <div className="p-5 space-y-4">
            {/* Contacts usage */}
            <UsageBar
              icon={<Users className="w-4 h-4" />}
              label="Contacts"
              used={usageData.contactsCount}
              limit={usageData.contactsLimit}
            />
            {/* Messages usage */}
            <UsageBar
              icon={<MessageSquare className="w-4 h-4" />}
              label="Messages today"
              used={usageData.messagesUsedToday}
              limit={usageData.messagesLimit}
            />
            {/* Braindumps usage */}
            <UsageBar
              icon={<Brain className="w-4 h-4" />}
              label="Braindumps today"
              used={usageData.braindumpsUsedToday}
              limit={usageData.braindumpsLimit}
            />
          </div>
        </div>
      )}

      {/* Profile Card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="font-medium text-gray-900">Profile</h2>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={user?.phone || ''}
              disabled
              className="w-full px-4 py-2 border border-gray-200 rounded-lg bg-gray-50 text-gray-500"
            />
            <p className="text-xs text-gray-500 mt-1">
              Phone number cannot be changed
            </p>
          </div>

          {profileMessage && (
            <div
              className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                profileMessage.type === 'success'
                  ? 'bg-green-50 text-green-700'
                  : 'bg-red-50 text-red-700'
              }`}
            >
              {profileMessage.type === 'success' ? (
                <Check className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {profileMessage.text}
            </div>
          )}

          <button
            onClick={handleSaveProfile}
            disabled={isSavingProfile || (!name.trim())}
            className="px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {isSavingProfile ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Save changes'
            )}
          </button>
        </div>
      </div>

      {/* Security Card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="font-medium text-gray-900">Security</h2>
        </div>
        <div className="divide-y divide-gray-200">
          <button
            onClick={() => setShowPinModal(true)}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <Shield className="w-5 h-5 text-gray-400" />
              <div className="text-left">
                <p className="font-medium text-gray-900">Change PIN</p>
                <p className="text-sm text-gray-500">Update your 4-digit login PIN</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-gray-400" />
          </button>
        </div>
      </div>

      {/* Data Card */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200">
          <h2 className="font-medium text-gray-900">Data</h2>
        </div>
        <div className="p-5">
          <button
            onClick={handleExport}
            className="px-4 py-2 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export all contacts (CSV)
          </button>
          <p className="text-xs text-gray-500 mt-2">
            Download a copy of all your contacts and their details
          </p>
        </div>
      </div>

      {/* Logout */}
      <button
        onClick={handleLogout}
        disabled={isLoggingOut}
        className="w-full px-5 py-4 bg-white rounded-xl border border-gray-200 flex items-center justify-center gap-2 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
      >
        {isLoggingOut ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Logging out...
          </>
        ) : (
          <>
            <LogOut className="w-5 h-5" />
            Log out
          </>
        )}
      </button>

      {/* PIN Change Modal */}
      {showPinModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl w-full max-w-md">
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
              <h2 className="font-medium text-gray-900">Change PIN</h2>
              <button
                onClick={() => {
                  setShowPinModal(false);
                  setCurrentPin('');
                  setNewPin('');
                  setConfirmPin('');
                  setPinMessage(null);
                }}
                className="p-1 text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Current PIN */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Current PIN
                </label>
                <div className="relative">
                  <input
                    type={showCurrentPin ? 'text' : 'password'}
                    value={currentPin}
                    onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="••••"
                    maxLength={4}
                    className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none font-mono text-lg tracking-widest"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPin(!showCurrentPin)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showCurrentPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* New PIN */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  New PIN
                </label>
                <div className="relative">
                  <input
                    type={showNewPin ? 'text' : 'password'}
                    value={newPin}
                    onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="••••"
                    maxLength={4}
                    className="w-full px-4 py-2 pr-10 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none font-mono text-lg tracking-widest"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPin(!showNewPin)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showNewPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm PIN */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm new PIN
                </label>
                <input
                  type="password"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  maxLength={4}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none font-mono text-lg tracking-widest"
                />
              </div>

              {pinMessage && (
                <div
                  className={`p-3 rounded-lg text-sm flex items-center gap-2 ${
                    pinMessage.type === 'success'
                      ? 'bg-green-50 text-green-700'
                      : 'bg-red-50 text-red-700'
                  }`}
                >
                  {pinMessage.type === 'success' ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <AlertCircle className="w-4 h-4" />
                  )}
                  {pinMessage.text}
                </div>
              )}

              <button
                onClick={handleChangePin}
                disabled={isChangingPin || currentPin.length !== 4 || newPin.length !== 4 || confirmPin.length !== 4}
                className="w-full px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {isChangingPin ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Changing...
                  </>
                ) : (
                  'Change PIN'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Usage Bar Component
// ===========================================================================

function UsageBar({
  icon,
  label,
  used,
  limit,
}: {
  icon: React.ReactNode;
  label: string;
  used: number;
  limit: number;
}) {
  const percentage = Math.min(100, (used / limit) * 100);
  const isNearLimit = percentage >= 80;
  const isAtLimit = percentage >= 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 text-sm text-gray-600">
          {icon}
          {label}
        </div>
        <span className={`text-sm font-medium ${isAtLimit ? 'text-red-600' : isNearLimit ? 'text-yellow-600' : 'text-gray-900'}`}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all ${
            isAtLimit ? 'bg-red-500' : isNearLimit ? 'bg-yellow-500' : 'bg-bethany-500'
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
