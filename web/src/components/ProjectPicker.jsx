import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

const AUTH_ERROR_MESSAGES = {
  // Set by the server (server/auth/routes.js) when Azure AD couldn't
  // complete sign-in because this client tenant hasn't consented to the app
  // yet - most Global Admins won't ever see this (an ordinary sign-in
  // auto-offers "consent on behalf of your organization"), it's only the
  // fallback for tenants whose consent policy blocks that.
  consent_required: (
    <>Your organization hasn't approved this tool yet. A Global Admin needs to grant consent once -{' '}
      <a href="/auth/admin-consent" className="font-medium underline">click here to do that</a>, then sign in normally.</>
  ),
  // Set when someone opened a specific Project's "sign in" link but
  // authenticated with a different tenant's account than that project is
  // already bound to.
  wrong_tenant_for_project: 'That project is connected to a different Microsoft 365 tenant - sign in with the Global Admin account for the tenant this project belongs to.',
};

// Lists every Project (server/api/projects.js) and lets you sign into one or
// start a new one. Used both as the pre-login landing page (Gate, in
// App.jsx) and as the always-reachable /projects page once signed in -
// switching projects means signing into a different one, so this same UI
// works in both places without needing to sign out first to reach it.
export default function ProjectPicker() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/projects').then((r) => setProjects(r.items || [])).finally(() => setLoading(false));
  }, []);

  async function createProject(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const project = await api.post('/api/projects', { name: newName.trim() });
      window.location.href = `/auth/login?project=${project.id}`;
    } catch (err) {
      setError(err.message);
      setCreating(false);
    }
  }

  const authError = new URLSearchParams(window.location.search).get('authError');

  return (
    <div className="max-w-md mx-auto mt-16 bg-white border border-slate-200 rounded-xl p-8 shadow-sm">
      <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xl font-bold shadow" aria-hidden>
        ⇥
      </div>
      <h1 className="text-lg font-semibold text-slate-800 mb-1 text-center">Projects</h1>
      <p className="text-sm text-slate-500 mb-6 text-center">Pick a project to sign into, or start a new one.</p>

      {authError && AUTH_ERROR_MESSAGES[authError] && (
        <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-3 mb-4 text-left">
          {AUTH_ERROR_MESSAGES[authError]}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400 text-center">Loading projects...</div>
      ) : projects.length > 0 ? (
        <ul className="space-y-1.5 mb-6">
          {projects.map((p) => (
            <li key={p.id}>
              <a
                href={`/auth/login?project=${p.id}`}
                className="group flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2.5 hover:border-blue-300 hover:bg-blue-50/50 transition-colors"
              >
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-semibold shrink-0 ${p.status === 'pending' ? 'bg-slate-100 text-slate-400' : 'bg-indigo-100 text-indigo-700'}`}>
                  {(p.name || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-800 truncate">{p.name}</div>
                  <div className="text-xs text-slate-400 truncate">
                    {p.status === 'pending' ? 'not yet signed in' : p.lastLoginAt ? `last used ${p.lastLoginAt}` : 'active'}
                  </div>
                </div>
                <span className="text-xs font-medium text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  Sign in →
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-slate-400 text-center mb-6">No projects yet - create the first one below.</div>
      )}

      <form onSubmit={createProject} className="flex items-center gap-2 border-t border-slate-100 pt-4">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New project name (e.g. Contoso Ltd)"
          className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm"
        />
        <button type="submit" disabled={creating || !newName.trim()} className="btn-primary disabled:opacity-40">
          {creating ? 'Creating...' : '+ New project'}
        </button>
      </form>
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </div>
  );
}
