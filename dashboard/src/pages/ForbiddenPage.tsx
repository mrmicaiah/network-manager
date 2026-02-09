import { Link } from 'react-router-dom';
import { ShieldOff } from 'lucide-react';

/**
 * 403 Forbidden page — shown when an authenticated user
 * tries to access a resource they don't have permission for.
 */
export function ForbiddenPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-cream px-4">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 bg-cream-dark rounded-2xl flex items-center justify-center mx-auto mb-6">
          <ShieldOff className="w-8 h-8 text-charcoal-light" />
        </div>

        <h1 className="font-display text-2xl text-charcoal mb-3">
          Access Denied
        </h1>

        <p className="text-charcoal-light mb-8">
          You don't have permission to view this page.
          If you think this is a mistake, reach out to your admin.
        </p>

        <Link to="/overview" className="btn-primary">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
