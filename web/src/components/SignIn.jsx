import React from 'react';
import { Link } from 'react-router-dom';
import { AUTH_ERROR_MESSAGES } from './ProjectPicker';

// The pre-login landing page: one "Sign in with Microsoft" button, nothing
// else to decide. The server resolves (or auto-creates) the project for
// whatever tenant the account belongs to and provisions its engine app on
// first sign-in - see server/auth/routes.js. Switching to another tenant's
// project happens on /projects, which stays reachable without signing in.
export default function SignIn() {
  const authError = new URLSearchParams(window.location.search).get('authError');

  return (
    <div className="max-w-md mx-auto mt-24 bg-white border border-slate-200 rounded-xl p-8 shadow-sm text-center">
      <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xl font-bold shadow" aria-hidden>
        ⇥
      </div>
      <h1 className="text-lg font-semibold text-slate-800 mb-1">SharePoint Migration Tool</h1>
      <p className="text-sm text-slate-500 mb-6">
        Sign in with your Microsoft work account — you'll land in your organisation's project automatically.
      </p>

      {authError && AUTH_ERROR_MESSAGES[authError] && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3 mb-4 text-left">
          {AUTH_ERROR_MESSAGES[authError]}
        </div>
      )}

      <a
        href="/auth/login"
        className="inline-flex items-center justify-center gap-2.5 w-full rounded-md border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden>
          <rect x="1" y="1" width="9" height="9" fill="#f25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
          <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
          <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
        </svg>
        Sign in with Microsoft
      </a>

      <div className="mt-5 text-xs text-slate-400">
        Working across several client tenants?{' '}
        <Link to="/projects" className="text-blue-600 hover:underline">Pick a specific project →</Link>
      </div>
    </div>
  );
}
