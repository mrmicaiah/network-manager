import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { MessageCircle, Upload, Users, ArrowRight, CheckCircle, Sparkles } from 'lucide-react';

type WizardStep = 'welcome' | 'text-sent' | 'import' | 'ready';

export function WelcomePage() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<WizardStep>('welcome');
  const [showConfetti, setShowConfetti] = useState(true);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate('/login', { replace: true });
    }
  }, [isAuthenticated, isLoading, navigate]);

  // Hide confetti after animation
  useEffect(() => {
    const timer = setTimeout(() => setShowConfetti(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream">
        <div className="animate-pulse text-charcoal-light">Loading...</div>
      </div>
    );
  }

  if (!user) return null;

  const firstName = user.name?.split(' ')[0] || 'Friend';

  const handleSkipImport = () => {
    setStep('ready');
  };

  const handleGoToImport = () => {
    navigate('/import');
  };

  const handleGoToDashboard = () => {
    navigate('/overview');
  };

  return (
    <div className="min-h-screen bg-cream px-4 py-8 relative overflow-hidden">
      {/* Decorative background */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 -left-32 w-96 h-96 bg-blush rounded-full opacity-30 blur-3xl" />
        <div className="absolute bottom-20 -right-32 w-80 h-80 bg-sage-200 rounded-full opacity-20 blur-3xl" />
      </div>

      {/* Confetti effect */}
      {showConfetti && (
        <div className="fixed inset-0 pointer-events-none z-50">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="absolute animate-confetti"
              style={{
                left: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 0.5}s`,
                backgroundColor: ['#E8B4B8', '#B8C4B8', '#D4A574', '#8B7355'][Math.floor(Math.random() * 4)],
              }}
            />
          ))}
        </div>
      )}

      <div className="max-w-lg mx-auto relative z-10">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-bethany-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-warm">
            <span className="text-warm-white font-display font-bold text-3xl">B</span>
          </div>
        </div>

        {/* Step: Welcome */}
        {step === 'welcome' && (
          <div className="card text-center animate-fade-in">
            <div className="w-20 h-20 bg-sage-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <Sparkles className="w-10 h-10 text-sage-600" />
            </div>
            
            <h1 className="font-display text-3xl font-medium text-charcoal mb-3">
              Welcome, {firstName}! 🎉
            </h1>
            
            <p className="text-charcoal-light text-lg mb-8">
              Your account is all set up. Let me show you around.
            </p>

            <button
              onClick={() => setStep('text-sent')}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              Let's go
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Step: Text Sent */}
        {step === 'text-sent' && (
          <div className="card text-center animate-fade-in">
            <div className="w-20 h-20 bg-bethany-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <MessageCircle className="w-10 h-10 text-bethany-600" />
            </div>
            
            <h2 className="font-display text-2xl font-medium text-charcoal mb-3">
              Check your texts! 📱
            </h2>
            
            <p className="text-charcoal-light mb-6">
              I just sent you a welcome message. That's how we'll stay in touch — 
              I'll text you when it's time to reach out to someone important in your life.
            </p>

            <div className="bg-sage-50 border border-sage-200 rounded-xl p-4 mb-8 text-left">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-bethany-500 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-warm-white font-display font-bold text-lg">B</span>
                </div>
                <div>
                  <p className="text-sm font-medium text-charcoal">Bethany</p>
                  <p className="text-sm text-charcoal-light mt-1">
                    Hey {firstName}! It's Bethany. I'll help you stay connected with the people who matter most...
                  </p>
                </div>
              </div>
            </div>

            <button
              onClick={() => setStep('import')}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              Got it, what's next?
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Step: Import */}
        {step === 'import' && (
          <div className="card text-center animate-fade-in">
            <div className="w-20 h-20 bg-blush/30 rounded-full flex items-center justify-center mx-auto mb-6">
              <Upload className="w-10 h-10 text-bethany-600" />
            </div>
            
            <h2 className="font-display text-2xl font-medium text-charcoal mb-3">
              Import your contacts
            </h2>
            
            <p className="text-charcoal-light mb-6">
              The fastest way to get started is to import contacts from your phone or a CSV file. 
              I'll help you organize them into circles.
            </p>

            <div className="space-y-3 mb-8">
              <div className="flex items-center gap-3 text-left p-3 bg-cream rounded-lg">
                <CheckCircle className="w-5 h-5 text-sage-500 flex-shrink-0" />
                <span className="text-sm text-charcoal">Upload a CSV or vCard file</span>
              </div>
              <div className="flex items-center gap-3 text-left p-3 bg-cream rounded-lg">
                <CheckCircle className="w-5 h-5 text-sage-500 flex-shrink-0" />
                <span className="text-sm text-charcoal">Preview and select which contacts to import</span>
              </div>
              <div className="flex items-center gap-3 text-left p-3 bg-cream rounded-lg">
                <CheckCircle className="w-5 h-5 text-sage-500 flex-shrink-0" />
                <span className="text-sm text-charcoal">Organize into circles (Family, Friends, Work...)</span>
              </div>
            </div>

            <div className="space-y-3">
              <button
                onClick={handleGoToImport}
                className="btn-primary w-full flex items-center justify-center gap-2"
              >
                <Upload className="w-5 h-5" />
                Import contacts
              </button>
              
              <button
                onClick={handleSkipImport}
                className="btn-ghost w-full"
              >
                Skip for now
              </button>
            </div>
          </div>
        )}

        {/* Step: Ready */}
        {step === 'ready' && (
          <div className="card text-center animate-fade-in">
            <div className="w-20 h-20 bg-sage-100 rounded-full flex items-center justify-center mx-auto mb-6">
              <Users className="w-10 h-10 text-sage-600" />
            </div>
            
            <h2 className="font-display text-2xl font-medium text-charcoal mb-3">
              You're all set! 🌟
            </h2>
            
            <p className="text-charcoal-light mb-8">
              Your dashboard is ready. You can add contacts manually, import them later, 
              or just wait for my texts to help you stay connected.
            </p>

            <div className="bg-bethany-50 border border-bethany-200 rounded-xl p-4 mb-8 text-left">
              <h3 className="font-medium text-charcoal mb-2">What happens next?</h3>
              <ul className="text-sm text-charcoal-light space-y-2">
                <li>• I'll text you when someone's due for a check-in</li>
                <li>• You can add contacts anytime from the dashboard</li>
                <li>• Organize people into circles based on how close you are</li>
                <li>• Track your relationship health at a glance</li>
              </ul>
            </div>

            <button
              onClick={handleGoToDashboard}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              Go to dashboard
              <ArrowRight className="w-5 h-5" />
            </button>
          </div>
        )}

        {/* Progress dots */}
        <div className="flex justify-center gap-2 mt-8">
          {(['welcome', 'text-sent', 'import', 'ready'] as WizardStep[]).map((s) => (
            <div
              key={s}
              className={`w-2 h-2 rounded-full transition-colors ${
                s === step ? 'bg-bethany-500' : 'bg-charcoal/20'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Add confetti animation styles */}
      <style>{`
        @keyframes confetti {
          0% {
            transform: translateY(-100vh) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100vh) rotate(720deg);
            opacity: 0;
          }
        }
        .animate-confetti {
          width: 10px;
          height: 10px;
          animation: confetti 3s ease-out forwards;
        }
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fade-in {
          animation: fade-in 0.3s ease-out;
        }
      `}</style>
    </div>
  );
}
