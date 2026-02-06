import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { CheckCircle } from 'lucide-react';

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
    <div className="min-h-screen flex items-center justify-center bg-cream px-4">
      {/* Decorative background blobs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 -left-32 w-96 h-96 bg-blush rounded-full opacity-30 blur-3xl" />
        <div className="absolute bottom-20 -right-32 w-80 h-80 bg-sage-200 rounded-full opacity-20 blur-3xl" />
      </div>

      <div className="w-full max-w-sm relative z-10">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-bethany-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-warm">
            <span className="text-warm-white font-display font-bold text-3xl">B</span>
          </div>
          <h1 className="font-display text-2xl font-medium text-charcoal">Welcome back</h1>
          <p className="text-charcoal-light mt-1">Sign in to your account</p>
        </div>

        {/* Welcome message for new signups */}
        {isWelcome && step === 'phone' && (
          <div className="bg-sage-50 border border-sage-200 text-sage-700 px-4 py-3 rounded-xl text-sm mb-4 flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-sage-500 flex-shrink-0" />
            Account created! Enter your phone number to log in.
          </div>
        )}

        {/* Form Card */}
        <div className="card">
          {step === 'phone' ? (
            <form onSubmit={handlePhoneSubmit}>
              <label className="block text-sm font-medium text-charcoal mb-2">
                Phone number
              </label>
              <input
                type="tel"
                value={phone}
                onChange={handlePhoneChange}
                placeholder="(555) 123-4567"
                className="input-field"
                autoFocus
                required
              />
              <p className="text-xs text-charcoal-light mt-2">
                We'll text you a code to verify it's you.
              </p>

              {error && (
                <p className="error-message">{error}</p>
              )}

              <button
                type="submit"
                disabled={isLoading || getRawPhone().length !== 10}
                className="btn-primary w-full mt-5"
              >
                {isLoading ? 'Sending...' : 'Send code'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleCodeSubmit}>
              <label className="block text-sm font-medium text-charcoal mb-2">
                Verification code
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="input-field text-center text-2xl tracking-widest font-mono"
                autoFocus
                required
                maxLength={6}
              />
              <p className="text-xs text-charcoal-light mt-2">
                Enter the 6-digit code we sent to {phone}
              </p>

              {error && (
                <p className="error-message">{error}</p>
              )}

              <button
                type="submit"
                disabled={isLoading || code.length !== 6}
                className="btn-primary w-full mt-5"
              >
                {isLoading ? 'Verifying...' : 'Verify'}
              </button>

              {/* Resend code */}
              <div className="mt-4 text-center">
                {canResend ? (
                  <button
                    type="button"
                    onClick={handleResend}
                    className="text-sm text-bethany-500 hover:text-bethany-600 font-medium transition-colors"
                  >
                    Resend code
                  </button>
                ) : (
                  <p className="text-sm text-charcoal-light">
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
                className="btn-ghost w-full mt-2"
              >
                Use a different number
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-sm text-charcoal-light mt-6">
          Don't have an account?{' '}
          <a href="/signup" className="text-bethany-500 hover:text-bethany-600 font-medium transition-colors">
            Sign up
          </a>
        </p>
      </div>
    </div>
  );
}
