import { useState, useCallback, useEffect } from 'react';
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
  Upload,
  Trash2,
  Plus,
  GripVertical,
  Pencil,
  X,
  Calendar,
  Moon,
  Bell,
  Link as LinkIcon,
  Globe,
  User,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { TabSettings } from '../components/TabSettings';

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

interface CircleData {
  id: string;
  name: string;
  type: 'default' | 'custom';
  default_cadence_days: number | null;
  sort_order: number;
  contact_count?: number;
}

// ===========================================================================
// Constants
// ===========================================================================

const FREE_TIER_LIMITS = {
  max_contacts: 15,
  max_messages_per_day: 10,
  max_braindumps_per_day: 1,
};

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Anchorage', label: 'Alaska Time (AKT)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time (HT)' },
  { value: 'Europe/London', label: 'London (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central European (CET)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
];

const HOURS = Array.from({ length: 24 }, (_, i) => {
  const hour = i % 12 || 12;
  const ampm = i < 12 ? 'AM' : 'PM';
  return { value: i, label: `${hour}:00 ${ampm}` };
});

// ===========================================================================
// Feature Comparison Data
// ===========================================================================

const FEATURE_COMPARISON = [
  { feature: 'Contacts', free: '15', premium: 'Unlimited' },
  { feature: 'Messages per day', free: '10', premium: 'Unlimited' },
  { feature: 'Braindumps per day', free: '1', premium: 'Unlimited' },
  { feature: 'Nudge frequency', free: 'Weekly', premium: 'Daily' },
  { feature: 'Contact sorting', free: '5/week', premium: 'Unlimited' },
  { feature: 'Custom circles', free: '✓', premium: '✓' },
  { feature: 'CSV export', free: '✓', premium: '✓' },
  { feature: 'CSV import', free: '—', premium: '✓' },
  { feature: 'Dunbar insights', free: '—', premium: '✓' },
  { feature: 'Priority support', free: '—', premium: '✓' },
];

// ===========================================================================
// Component
// ===========================================================================

export function SettingsPage() {
  const { user, logout, refreshUser } = useAuth();
  const { data: subscription, refetch: refetchSubscription } = useApi<SubscriptionData>('/api/subscription');
  const { data: healthData } = useApi<{ total: number }>('/api/contacts/health');
  const { data: circles, refetch: refetchCircles } = useApi<CircleData[]>('/api/circles');

  // Profile edit state
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [gender, setGender] = useState<'male' | 'female' | null>(user?.gender || null);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Notification preferences state
  const [quietHoursStart, setQuietHoursStart] = useState(22); // 10 PM
  const [quietHoursEnd, setQuietHoursEnd] = useState(8); // 8 AM
  const [timezone, setTimezone] = useState('America/New_York');
  const [nudgeFrequency, setNudgeFrequency] = useState<'daily' | 'weekly'>('daily');

  // PIN change state
  const [showPinModal, setShowPinModal] = useState(false);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showCurrentPin, setShowCurrentPin] = useState(false);
  const [showNewPin, setShowNewPin] = useState(false);
  const [isChangingPin, setIsChangingPin] = useState(false);
  const [pinMessage, setPinMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Circle management state
  const [showCircleModal, setShowCircleModal] = useState(false);
  const [editingCircle, setEditingCircle] = useState<CircleData | null>(null);
  const [newCircleName, setNewCircleName] = useState('');
  const [isSavingCircle, setIsSavingCircle] = useState(false);
  const [circleMessage, setCircleMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Delete account state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Section collapse state
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['subscription', 'profile']));

  // Logout state
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const { execute: updateUser } = useLazyApi();
  const { execute: changePin } = useLazyApi();
  const { execute: createCheckout } = useLazyApi();
  const { execute: createPortal } = useLazyApi();
  const { execute: circleApi } = useLazyApi();

  // Sync user data
  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setEmail(user.email || '');
      setGender(user.gender || null);
    }
  }, [user]);

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

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
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
          gender,
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
  }, [name, email, gender, updateUser, refreshUser]);

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

  // Circle operations
  const handleSaveCircle = useCallback(async () => {
    if (!newCircleName.trim()) return;
    
    setIsSavingCircle(true);
    setCircleMessage(null);

    try {
      if (editingCircle) {
        await circleApi(`/api/circles/${editingCircle.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newCircleName.trim() }),
        });
        setCircleMessage({ type: 'success', text: 'Circle renamed' });
      } else {
        await circleApi('/api/circles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newCircleName.trim() }),
        });
        setCircleMessage({ type: 'success', text: 'Circle created' });
      }

      await refetchCircles();
      setTimeout(() => {
        setShowCircleModal(false);
        setEditingCircle(null);
        setNewCircleName('');
        setCircleMessage(null);
      }, 1000);
    } catch (err) {
      setCircleMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'Failed to save circle',
      });
    } finally {
      setIsSavingCircle(false);
    }
  }, [newCircleName, editingCircle, circleApi, refetchCircles]);

  const handleDeleteCircle = useCallback(async (circle: CircleData) => {
    if (circle.type === 'default') {
      alert("Default circles can't be deleted, but you can rename them.");
      return;
    }
    
    if (!confirm(`Delete "${circle.name}"? Contacts won't be deleted, just unlinked from this circle.`)) {
      return;
    }

    try {
      await circleApi(`/api/circles/${circle.id}`, { method: 'DELETE' });
      await refetchCircles();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete circle');
    }
  }, [circleApi, refetchCircles]);

  // Subscription actions
  const handleUpgrade = useCallback(async () => {
    try {
      const result = await createCheckout('/api/subscription/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (result?.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to start checkout');
    }
  }, [createCheckout]);

  const handleManageSubscription = useCallback(async () => {
    try {
      const result = await createPortal('/api/subscription/portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (result?.portalUrl) {
        window.location.href = result.portalUrl;
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to open subscription portal');
    }
  }, [createPortal]);

  // Logout
  const handleLogout = useCallback(async () => {
    setIsLoggingOut(true);
    await logout();
  }, [logout]);

  // Export contacts
  const handleExport = useCallback(() => {
    window.location.href = '/api/export';
  }, []);

  // Delete account
  const handleDeleteAccount = useCallback(async () => {
    if (deleteConfirmText !== 'DELETE') return;
    
    setIsDeletingAccount(true);
    setDeleteError(null);
    
    try {
      const response = await fetch('/api/user', {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to delete account');
      }

      // Account deleted successfully, logout
      await logout();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete account. Please contact support.');
    } finally {
      setIsDeletingAccount(false);
    }
  }, [deleteConfirmText, logout]);

  const isFreeOrTrial = subscription?.tier === 'free' || subscription?.tier === 'trial';

  return (
    <div className="max-w-2xl mx-auto space-y-4 pb-8">
      <h1 className="font-display text-2xl font-medium text-charcoal">Settings</h1>

      {/* Subscription Card */}
      <CollapsibleSection
        title="Subscription"
        icon={<Crown className="w-5 h-5" />}
        isExpanded={expandedSections.has('subscription')}
        onToggle={() => toggleSection('subscription')}
        badge={subscription?.isPremium ? (
          <span className="badge-primary flex items-center gap-1">
            <Crown className="w-3 h-3" />
            Premium
          </span>
        ) : undefined}
      >
        <div className="p-5">
          {/* Status display */}
          {subscription?.isPremium ? (
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-bethany-100 rounded-xl flex items-center justify-center">
                <Crown className="w-6 h-6 text-bethany-600" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-charcoal">Premium Plan</p>
                <p className="text-sm text-charcoal-light mt-1">
                  Unlimited contacts, messages, and all premium features
                </p>
                <button
                  onClick={handleManageSubscription}
                  className="mt-3 text-sm text-bethany-500 hover:text-bethany-600 font-medium transition-colors"
                >
                  Manage subscription →
                </button>
              </div>
            </div>
          ) : subscription?.isTrialActive ? (
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-golden-100 rounded-xl flex items-center justify-center">
                <Clock className="w-6 h-6 text-golden-500" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-charcoal">Trial</p>
                  <span className="badge-warning">
                    {trialDaysLeft} days left
                  </span>
                </div>
                <p className="text-sm text-charcoal-light mt-1">
                  Full access to all features during your trial
                </p>
                <div className="mt-3">
                  <div className="h-2 bg-cream-dark rounded-full overflow-hidden">
                    <div
                      className="h-full bg-golden-400 transition-all"
                      style={{ width: `${Math.max(0, 100 - (trialDaysLeft ?? 0) * (100 / 14))}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 bg-cream-dark rounded-xl flex items-center justify-center">
                <Zap className="w-6 h-6 text-charcoal-light" />
              </div>
              <div>
                <p className="font-medium text-charcoal">Free Plan</p>
                <p className="text-sm text-charcoal-light mt-1">
                  Limited to {FREE_TIER_LIMITS.max_contacts} contacts and {FREE_TIER_LIMITS.max_messages_per_day} messages/day
                </p>
              </div>
            </div>
          )}

          {/* Upgrade CTA */}
          {!subscription?.isPremium && (
            <button
              onClick={handleUpgrade}
              className="mt-4 w-full btn-primary"
            >
              <Sparkles className="w-4 h-4" />
              Upgrade to Premium
            </button>
          )}

          {/* Feature Comparison */}
          {!subscription?.isPremium && (
            <div className="mt-6 border-t border-cream-dark pt-4">
              <p className="text-sm font-medium text-charcoal mb-3">Compare plans</p>
              <div className="space-y-2">
                {FEATURE_COMPARISON.map(({ feature, free, premium }) => (
                  <div key={feature} className="flex items-center justify-between text-sm">
                    <span className="text-charcoal-light">{feature}</span>
                    <div className="flex gap-8">
                      <span className="w-16 text-right text-charcoal-light">{free}</span>
                      <span className="w-16 text-right text-bethany-500 font-medium">{premium}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </CollapsibleSection>

      {/* Usage Stats (Free/Trial only) */}
      {isFreeOrTrial && (
        <CollapsibleSection
          title="Usage"
          icon={<MessageSquare className="w-5 h-5" />}
          isExpanded={expandedSections.has('usage')}
          onToggle={() => toggleSection('usage')}
        >
          <div className="p-5 space-y-4">
            <UsageBar
              icon={<Users className="w-4 h-4" />}
              label="Contacts"
              used={usageData.contactsCount}
              limit={usageData.contactsLimit}
            />
            <UsageBar
              icon={<MessageSquare className="w-4 h-4" />}
              label="Messages today"
              used={usageData.messagesUsedToday}
              limit={usageData.messagesLimit}
            />
            <UsageBar
              icon={<Brain className="w-4 h-4" />}
              label="Braindumps today"
              used={usageData.braindumpsUsedToday}
              limit={usageData.braindumpsLimit}
            />
          </div>
        </CollapsibleSection>
      )}

      {/* Profile Card */}
      <CollapsibleSection
        title="Profile"
        icon={<User className="w-5 h-5" />}
        isExpanded={expandedSections.has('profile')}
        onToggle={() => toggleSection('profile')}
      >
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input-field"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="input-field"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={user?.phone || ''}
              disabled
              className="input-field"
            />
            <p className="text-xs text-charcoal-light mt-1">
              Phone number cannot be changed
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-charcoal mb-1">
              Gender preference
            </label>
            <p className="text-xs text-charcoal-light mb-2">
              Research shows women prefer conversation-based nudges while men prefer activity-based ones
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setGender(null)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  gender === null
                    ? 'bg-bethany-100 text-bethany-600 border-2 border-bethany-500'
                    : 'bg-cream-dark text-charcoal-light border-2 border-transparent hover:bg-cream'
                }`}
              >
                Not set
              </button>
              <button
                type="button"
                onClick={() => setGender('female')}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  gender === 'female'
                    ? 'bg-bethany-100 text-bethany-600 border-2 border-bethany-500'
                    : 'bg-cream-dark text-charcoal-light border-2 border-transparent hover:bg-cream'
                }`}
              >
                Female
              </button>
              <button
                type="button"
                onClick={() => setGender('male')}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  gender === 'male'
                    ? 'bg-bethany-100 text-bethany-600 border-2 border-bethany-500'
                    : 'bg-cream-dark text-charcoal-light border-2 border-transparent hover:bg-cream'
                }`}
              >
                Male
              </button>
            </div>
          </div>

          {profileMessage && (
            <div
              className={`p-3 rounded-xl text-sm flex items-center gap-2 ${
                profileMessage.type === 'success'
                  ? 'bg-sage-50 text-sage-700'
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
            className="btn-primary"
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
      </CollapsibleSection>

      {/* Notification Preferences */}
      <CollapsibleSection
        title="Notifications"
        icon={<Bell className="w-5 h-5" />}
        isExpanded={expandedSections.has('notifications')}
        onToggle={() => toggleSection('notifications')}
      >
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-charcoal mb-1">
              Nudge frequency
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setNudgeFrequency('daily')}
                disabled={subscription?.tier === 'free'}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  nudgeFrequency === 'daily'
                    ? 'bg-bethany-100 text-bethany-600 border-2 border-bethany-500'
                    : 'bg-cream-dark text-charcoal-light border-2 border-transparent hover:bg-cream'
                } ${subscription?.tier === 'free' ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                Daily {subscription?.tier === 'free' && '(Premium)'}
              </button>
              <button
                type="button"
                onClick={() => setNudgeFrequency('weekly')}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${
                  nudgeFrequency === 'weekly'
                    ? 'bg-bethany-100 text-bethany-600 border-2 border-bethany-500'
                    : 'bg-cream-dark text-charcoal-light border-2 border-transparent hover:bg-cream'
                }`}
              >
                Weekly
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-charcoal mb-1 flex items-center gap-2">
              <Moon className="w-4 h-4 text-charcoal-light" />
              Quiet hours
            </label>
            <p className="text-xs text-charcoal-light mb-2">
              Bethany won't text you during these hours
            </p>
            <div className="flex items-center gap-3">
              <select
                value={quietHoursStart}
                onChange={(e) => setQuietHoursStart(Number(e.target.value))}
                className="input-field !w-auto"
              >
                {HOURS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <span className="text-charcoal-light">to</span>
              <select
                value={quietHoursEnd}
                onChange={(e) => setQuietHoursEnd(Number(e.target.value))}
                className="input-field !w-auto"
              >
                {HOURS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-charcoal mb-1 flex items-center gap-2">
              <Globe className="w-4 h-4 text-charcoal-light" />
              Timezone
            </label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="input-field"
            >
              {TIMEZONES.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <button
            disabled
            className="btn-primary opacity-50 cursor-not-allowed"
          >
            Save preferences (coming soon)
          </button>
        </div>
      </CollapsibleSection>

      {/* Circles Management */}
      <CollapsibleSection
        title="Circles"
        icon={<Users className="w-5 h-5" />}
        isExpanded={expandedSections.has('circles')}
        onToggle={() => toggleSection('circles')}
        badge={
          <span className="text-sm text-charcoal-light">
            {circles?.length ?? 0} circles
          </span>
        }
      >
        <div className="divide-y divide-cream-dark">
          {circles?.map((circle) => (
            <div
              key={circle.id}
              className="px-5 py-3 flex items-center justify-between hover:bg-cream transition-colors"
            >
              <div className="flex items-center gap-3">
                <GripVertical className="w-4 h-4 text-charcoal-300" />
                <div>
                  <p className="font-medium text-charcoal">{circle.name}</p>
                  <p className="text-xs text-charcoal-light">
                    {circle.contact_count ?? 0} contacts
                    {circle.type === 'default' && ' · Default'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setEditingCircle(circle);
                    setNewCircleName(circle.name);
                    setShowCircleModal(true);
                  }}
                  className="p-2 text-charcoal-light hover:text-charcoal hover:bg-cream-dark rounded-xl transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {circle.type === 'custom' && (
                  <button
                    onClick={() => handleDeleteCircle(circle)}
                    className="p-2 text-charcoal-light hover:text-red-600 hover:bg-red-50 rounded-xl transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className="p-4">
            <button
              onClick={() => {
                setEditingCircle(null);
                setNewCircleName('');
                setShowCircleModal(true);
              }}
              className="w-full px-4 py-2 border-2 border-dashed border-charcoal-300 text-charcoal-light font-medium rounded-xl hover:border-bethany-400 hover:text-bethany-500 transition-colors flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Add circle
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Dashboard Tab Order */}
      <CollapsibleSection
        title="Dashboard Tabs"
        icon={<LayoutGrid className="w-5 h-5" />}
        isExpanded={expandedSections.has('tabs')}
        onToggle={() => toggleSection('tabs')}
      >
        <div className="p-5">
          {circles && circles.length > 0 ? (
            <TabSettings
              circles={circles.map((c) => ({
                id: c.id,
                name: c.name,
                type: c.type,
                contact_count: c.contact_count,
              }))}
              defaultTabId={user?.defaultCircleId ?? null}
              tabOrder={user?.circleTabOrder ?? null}
              onSave={() => {
                // Refresh user to get updated preferences
                refreshUser();
              }}
            />
          ) : (
            <p className="text-sm text-charcoal-light text-center py-4">
              No circles to configure. Create circles first.
            </p>
          )}
        </div>
      </CollapsibleSection>

      {/* Security Card */}
      <CollapsibleSection
        title="Security"
        icon={<Shield className="w-5 h-5" />}
        isExpanded={expandedSections.has('security')}
        onToggle={() => toggleSection('security')}
      >
        <div className="divide-y divide-cream-dark">
          <button
            onClick={() => setShowPinModal(true)}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-cream transition-colors"
          >
            <div className="flex items-center gap-3">
              <Shield className="w-5 h-5 text-charcoal-light" />
              <div className="text-left">
                <p className="font-medium text-charcoal">Change PIN</p>
                <p className="text-sm text-charcoal-light">Update your 4-digit login PIN</p>
              </div>
            </div>
            <ChevronRight className="w-5 h-5 text-charcoal-light" />
          </button>
        </div>
      </CollapsibleSection>

      {/* Data Card */}
      <CollapsibleSection
        title="Data"
        icon={<Download className="w-5 h-5" />}
        isExpanded={expandedSections.has('data')}
        onToggle={() => toggleSection('data')}
      >
        <div className="p-5 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              onClick={handleExport}
              className="btn-secondary"
            >
              <Download className="w-4 h-4" />
              Export contacts (CSV)
            </button>
            <Link
              to="/import"
              className="btn-secondary"
            >
              <Upload className="w-4 h-4" />
              Import contacts
            </Link>
          </div>
          
          <div className="pt-4 border-t border-cream-dark">
            <button
              onClick={() => setShowDeleteModal(true)}
              className="text-red-600 hover:text-red-700 text-sm font-medium flex items-center gap-2 transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              Delete my account
            </button>
          </div>
        </div>
      </CollapsibleSection>

      {/* Integrations Card */}
      <CollapsibleSection
        title="Integrations"
        icon={<LinkIcon className="w-5 h-5" />}
        isExpanded={expandedSections.has('integrations')}
        onToggle={() => toggleSection('integrations')}
      >
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between p-3 bg-cream rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-warm-white rounded-xl flex items-center justify-center border border-cream-dark">
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none">
                  <path d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.99 3.657 9.128 8.438 9.878v-6.988h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.99 22 12z" fill="#1877F2"/>
                </svg>
              </div>
              <div>
                <p className="font-medium text-charcoal">Google Contacts</p>
                <p className="text-sm text-charcoal-light">Sync your contacts automatically</p>
              </div>
            </div>
            <span className="badge-neutral">Coming soon</span>
          </div>

          <div className="flex items-center justify-between p-3 bg-cream rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-warm-white rounded-xl flex items-center justify-center border border-cream-dark">
                <Calendar className="w-5 h-5 text-charcoal-light" />
              </div>
              <div>
                <p className="font-medium text-charcoal">Calendar</p>
                <p className="text-sm text-charcoal-light">Schedule meetups with contacts</p>
              </div>
            </div>
            <span className="badge-neutral">Coming soon</span>
          </div>
        </div>
      </CollapsibleSection>

      {/* Logout */}
      <button
        onClick={handleLogout}
        disabled={isLoggingOut}
        className="w-full card flex items-center justify-center gap-2 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
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
        <Modal
          title="Change PIN"
          onClose={() => {
            setShowPinModal(false);
            setCurrentPin('');
            setNewPin('');
            setConfirmPin('');
            setPinMessage(null);
          }}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-charcoal mb-1">
                Current PIN
              </label>
              <div className="relative">
                <input
                  type={showCurrentPin ? 'text' : 'password'}
                  value={currentPin}
                  onChange={(e) => setCurrentPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  maxLength={4}
                  className="input-field pr-10 font-mono text-lg tracking-widest"
                />
                <button
                  type="button"
                  onClick={() => setShowCurrentPin(!showCurrentPin)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-charcoal-light hover:text-charcoal transition-colors"
                >
                  {showCurrentPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-charcoal mb-1">
                New PIN
              </label>
              <div className="relative">
                <input
                  type={showNewPin ? 'text' : 'password'}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="••••"
                  maxLength={4}
                  className="input-field pr-10 font-mono text-lg tracking-widest"
                />
                <button
                  type="button"
                  onClick={() => setShowNewPin(!showNewPin)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-charcoal-light hover:text-charcoal transition-colors"
                >
                  {showNewPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-charcoal mb-1">
                Confirm new PIN
              </label>
              <input
                type="password"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="••••"
                maxLength={4}
                className="input-field font-mono text-lg tracking-widest"
              />
            </div>

            {pinMessage && (
              <div
                className={`p-3 rounded-xl text-sm flex items-center gap-2 ${
                  pinMessage.type === 'success'
                    ? 'bg-sage-50 text-sage-700'
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
              className="btn-primary w-full"
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
        </Modal>
      )}

      {/* Circle Modal */}
      {showCircleModal && (
        <Modal
          title={editingCircle ? 'Rename Circle' : 'Add Circle'}
          onClose={() => {
            setShowCircleModal(false);
            setEditingCircle(null);
            setNewCircleName('');
            setCircleMessage(null);
          }}
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-charcoal mb-1">
                Circle name
              </label>
              <input
                type="text"
                value={newCircleName}
                onChange={(e) => setNewCircleName(e.target.value)}
                placeholder="e.g., Book Club, Neighbors"
                className="input-field"
                autoFocus
              />
            </div>

            {circleMessage && (
              <div
                className={`p-3 rounded-xl text-sm flex items-center gap-2 ${
                  circleMessage.type === 'success'
                    ? 'bg-sage-50 text-sage-700'
                    : 'bg-red-50 text-red-700'
                }`}
              >
                {circleMessage.type === 'success' ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <AlertCircle className="w-4 h-4" />
                )}
                {circleMessage.text}
              </div>
            )}

            <button
              onClick={handleSaveCircle}
              disabled={isSavingCircle || !newCircleName.trim()}
              className="btn-primary w-full"
            >
              {isSavingCircle ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving...
                </>
              ) : editingCircle ? (
                'Rename'
              ) : (
                'Create'
              )}
            </button>
          </div>
        </Modal>
      )}

      {/* Delete Account Modal */}
      {showDeleteModal && (
        <Modal
          title="Delete Account"
          onClose={() => {
            setShowDeleteModal(false);
            setDeleteConfirmText('');
            setDeleteError(null);
          }}
        >
          <div className="space-y-4">
            <div className="p-4 bg-red-50 rounded-xl">
              <p className="text-sm text-red-700">
                <strong>Warning:</strong> This action cannot be undone. All your contacts, 
                interactions, and settings will be permanently deleted.
                {subscription?.isPremium && (
                  <> Your premium subscription will also be canceled.</>
                )}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-charcoal mb-1">
                Type <strong>DELETE</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                className="input-field"
              />
            </div>

            {deleteError && (
              <div className="p-3 rounded-xl text-sm flex items-center gap-2 bg-red-50 text-red-700">
                <AlertCircle className="w-4 h-4" />
                {deleteError}
              </div>
            )}

            <button
              onClick={handleDeleteAccount}
              disabled={isDeletingAccount || deleteConfirmText !== 'DELETE'}
              className="w-full px-6 py-3 bg-red-600 text-white font-medium rounded-xl hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isDeletingAccount ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  Delete my account
                </>
              )}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ===========================================================================
// Collapsible Section Component
// ===========================================================================

function CollapsibleSection({
  title,
  icon,
  isExpanded,
  onToggle,
  badge,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card !p-0 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-cream transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-charcoal-light">{icon}</span>
          <h2 className="font-medium text-charcoal">{title}</h2>
        </div>
        <div className="flex items-center gap-3">
          {badge}
          {isExpanded ? (
            <ChevronUp className="w-5 h-5 text-charcoal-light" />
          ) : (
            <ChevronDown className="w-5 h-5 text-charcoal-light" />
          )}
        </div>
      </button>
      {isExpanded && (
        <div className="border-t border-cream-dark">
          {children}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Modal Component
// ===========================================================================

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-charcoal/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-fade-in">
      <div className="card w-full max-w-md !p-0">
        <div className="px-5 py-4 border-b border-cream-dark flex items-center justify-between">
          <h2 className="font-display font-medium text-charcoal">{title}</h2>
          <button
            onClick={onClose}
            className="p-1 text-charcoal-light hover:text-charcoal rounded-xl hover:bg-cream-dark transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">
          {children}
        </div>
      </div>
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
        <div className="flex items-center gap-2 text-sm text-charcoal-light">
          {icon}
          {label}
        </div>
        <span className={`text-sm font-medium ${isAtLimit ? 'text-red-600' : isNearLimit ? 'text-golden-500' : 'text-charcoal'}`}>
          {used} / {limit}
        </span>
      </div>
      <div className="h-2 bg-cream-dark rounded-full overflow-hidden">
        <div
          className={`h-full transition-all ${
            isAtLimit ? 'bg-red-500' : isNearLimit ? 'bg-golden-400' : 'bg-bethany-500'
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
