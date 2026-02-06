import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

type Step = 'phone' | 'code';

/** Resend cooldown in seconds */
const RESEND_COOLDOWN = 60;

export function LoginPage() {
  const { requestCode, login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Resend timer state
  const [canResend, setCanResend] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(RESEND_COOLDOWN);

  // Check for welcome query param (from signup redirect)
  const searchParams = new URLSearchParams(location.search);
  const isWelcome = searchParams.get('welcome') === 'true';

  // Redirect if already authenticated
  if (isAuthenticated) {
    const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
    navigate(from, { replace: true });
    return null;
  }

  // Resend countdown timer
  useEffect(() => {
    if (step === 'code') {
      setCanResend(false);
      setResendCountdown(RESEND_COOLDOWN);

      const timer = setInterval(() => {
        setResendCountdown((prev) => {
          if (prev <= 1) {
            setCanResend(true);
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [step]);

  /**
   * Format phone number as user types: (555) 123-4567
   */
  const handlePhoneChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let value = e.target.value.replace(/\D/g, '');
    if (value.length > 10) value = value.slice(0, 10);

    if (value.length >= 6) {
      value = '(' + value.slice(0, 3) + ') ' + value.slice(3, 6) + '-' + value.slice(6);
    } else if (value.length >= 3) {
      value = '(' + value.slice(0, 3) + ') ' + value.slice(3);
    }

    setPhone(value);
  };

  /**
   * Extract raw digits from formatted phone for API calls.
   */
  const getRawPhone = () => phone.replace(/\D/g, '');

  const handlePhoneSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const rawPhone = getRawPhone();
    if (rawPhone.length !== 10) {
      setError('Please enter a valid 10-digit phone number');
      return;
    }

    setIsLoading(true);
    const result = await requestCode(rawPhone);
    setIsLoading(false);

    if (result.success) {
      setStep('code');
    } else {
      setError(result.error || 'Failed to send code');
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    const rawPhone = getRawPhone();
    const result = await login(rawPhone, code);

    setIsLoading(false);

    if (result.success) {
      const from = (location.state as { from?: { pathname: string } })?.from?.pathname || '/';
      navigate(from, { replace: true });
    } else {
      setError(result.error || 'Invalid code');
    }
  };

  const handleResend = async () => {
    if (!canResend) return;

    setError('');
    setCanResend(false);
    setResendCountdown(RESEND_COOLDOWN);

    const rawPhone = getRawPhone();
    const result = await requestCode(rawPhone);

    if (!result.success) {
      setError(result.error || 'Failed to resend code');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-bethany-500 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-white font-bold text-2xl">B</span>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900">Bethany</h1>
          <p className="text-gray-500 mt-1">Network Manager</p>
        </div>

        {/* Welcome message for new signups */}
        {isWelcome && step === 'phone' && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-xl text-sm mb-4">
            🎉 Account created! Enter your phone number to log in.
          </div>
        )}

        {/* Form */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          {step === 'phone' ? (
            <form onSubmit={handlePhoneSubmit}>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Phone number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={handlePhoneChange}
                placeholder="(555) 123-4567"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
                autoFocus
                required
              />
              <p className="text-xs text-gray-500 mt-2">
                We'll text you a code to verify it's you.
              </p>

              {error && (
                <p className="text-sm text-red-600 mt-3">{error}</p>
              )}

              <button
                type="submit"
                disabled={isLoading || getRawPhone().length !== 10}
                className="w-full mt-4 px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? 'Sending...' : 'Send code'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit}>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Verification code
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none text-center text-2xl tracking-widest"
                autoFocus
                required
                maxLength={6}
              />
              <p className="text-xs text-gray-500 mt-2">
                Enter the 6-digit code we sent to {phone}
              </p>

              {error && (
                <p className="text-sm text-red-600 mt-3">{error}</p>
              )}

              <button
                type="submit"
                disabled={isLoading || code.length !== 6}
                className="w-full mt-4 px-4 py-2 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isLoading ? 'Verifying...' : 'Verify'}
              </button>

              {/* Resend code */}
              <div className="mt-4 text-center">
                {canResend ? (
                  <button
                    type="button"
                    onClick={handleResend}
                    className="text-sm text-bethany-600 hover:text-bethany-700 font-medium"
                  >
                    Resend code
                  </button>
                ) : (
                  <p className="text-sm text-gray-500">
                    Resend code in {resendCountdown}s
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setStep('phone');
                  setCode('');
                  setError('');
                }}
                className="w-full mt-2 px-4 py-2 text-gray-600 text-sm hover:text-gray-900"
              >
                Use a different number
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-xs text-gray-500 mt-6">
          Don't have an account?{' '}
          <a href="/signup" className="text-bethany-600 hover:underline">
            Sign up
          </a>
        </p>
      </div>
    </div>
  );
}
