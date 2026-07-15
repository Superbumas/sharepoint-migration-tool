import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

// One place to see and fix the three permission layers that otherwise each
// fail separately and cryptically:
//   A) the signed-in user's delegated scopes (browsing, user search),
//   B) this project's own engine app's app-only roles (what the engine writes
//      with - the OneDrive blocker for projects provisioned before that
//      permission existed),
//   C) per-site Sites.Selected access grants.
// Repairs that grant permissions can only be *performed* by a tenant admin -
// a non-admin gets a clear diagnosis and an "ask your admin" message when an
// action comes back denied, rather than a dead-end 403.
export default function PermissionsPanel() {
  const [health, setHealth] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [granting, setGranting] = useState(false);
  const [grantResults, setGrantResults] = useState(null);
  const [repairBanner, setRepairBanner] = useState(null);

  function loadHealth() {
    setLoadError(null);
    api.get('/api/permissions/health')
      .then(setHealth)
      .catch((err) => setLoadError(err.message));
  }

  useEffect(() => {
    loadHealth();
    // Coming back from the engine-app re-sync login leg (/auth/repair-engine
    // redirects here with ?repair=engine) - fetch and show what it changed.
    const params = new URLSearchParams(window.location.search);
    if (params.get('repair') === 'engine') {
      api.get('/api/permissions/last-repair')
        .then((r) => setRepairBanner(r.repair))
        .catch(() => {});
      // Drop the query param so a refresh doesn't look like a fresh repair.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function grantAllSites() {
    setGranting(true);
    setGrantResults(null);
    try {
      const r = await api.post('/api/permissions/grant-sites');
      setGrantResults(r.results || []);
      loadHealth();
    } catch (err) {
      setGrantResults([{ siteUrl: '(request)', ok: false, error: err.message }]);
    } finally {
      setGranting(false);
    }
  }

  const Chip = ({ ok, children }) => (
    <span className={`inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 ${
      ok === true ? 'bg-green-50 text-green-800 border border-green-200'
      : ok === false ? 'bg-red-50 text-red-700 border border-red-200'
      : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
      {ok === true ? '✓' : ok === false ? '✗' : '?'} {children}
    </span>
  );

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-slate-700">Permissions</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Check and repair the access this tool needs. Granting permissions requires a signed-in
          tenant admin — if an action is denied, an admin needs to run it.
        </p>
      </div>

      {loadError && <div className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-md p-2">Couldn’t load permission status: {loadError}</div>}

      {repairBanner && (
        <div className={`text-xs rounded-md p-2 border ${repairBanner.ok === false ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-800'}`}>
          {repairBanner.ok === false
            ? <>Engine app re-sync failed: {repairBanner.error}{' '}(you may need to be a tenant admin).</>
            : repairBanner.skipped
            ? <>Engine app: {repairBanner.reason}</>
            : <>Engine app re-synced. {repairBanner.added?.length ? `Added: ${repairBanner.added.join(', ')}.` : 'Everything was already in place.'}</>}
        </div>
      )}

      {!health && !loadError && <div className="text-xs text-slate-400">Loading permission status…</div>}

      {health && (
        <div className="space-y-4">
          {/* A) Delegated scopes */}
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold text-slate-600">Your access (sign-in)</h3>
            <p className="text-xs text-slate-500">Lets you browse sites and search for users. Consented once per tenant by an admin.</p>
            <div className="flex flex-wrap gap-1.5">
              {health.delegated.present === null
                ? <span className="text-xs text-slate-400">Couldn’t read your current permissions.</span>
                : health.delegated.required.map((s) => (
                    <Chip key={s} ok={health.delegated.present.includes(s)}>{s}</Chip>
                  ))}
            </div>
            {health.delegated.missing && health.delegated.missing.length > 0 && (
              <div className="pt-1">
                <button onClick={() => { window.location.href = '/auth/admin-consent'; }} className="text-xs font-medium text-blue-700 bg-blue-50 rounded-md px-2 py-1 hover:bg-blue-100">
                  Re-consent app permissions (admin)
                </button>
                <span className="text-xs text-slate-400 ml-2">Missing: {health.delegated.missing.join(', ')}</span>
              </div>
            )}
          </div>

          {/* B) Engine app roles */}
          <div className="space-y-1.5 border-t border-slate-100 pt-3">
            <h3 className="text-xs font-semibold text-slate-600">Engine app permissions</h3>
            {health.engineApp.dedicated ? (
              <>
                <p className="text-xs text-slate-500">
                  This project’s own engine app (<span className="font-mono">{health.engineApp.clientId}</span>) is what
                  actually reads and writes content. Re-sync it after enabling a feature like the OneDrive target so it
                  gains the new permission{health.engineApp.onedriveTargetEnabled ? ' (Files.ReadWrite.All)' : ''}.
                </p>
                <button onClick={() => { window.location.href = '/auth/repair-engine'; }} className="text-xs font-medium text-blue-700 bg-blue-50 rounded-md px-2 py-1 hover:bg-blue-100">
                  Re-sync engine app permissions
                </button>
                <span className="text-xs text-slate-400 ml-2">Signs you in again briefly to apply the change.</span>
              </>
            ) : (
              <p className="text-xs text-slate-500">
                This project uses the shared engine app — change its permissions by re-running
                <span className="font-mono"> setup/New-AppRegistration.ps1</span> on the server.
              </p>
            )}
          </div>

          {/* C) Site access */}
          <div className="space-y-1.5 border-t border-slate-100 pt-3">
            <h3 className="text-xs font-semibold text-slate-600">Site access</h3>
            {health.sites.length === 0 ? (
              <p className="text-xs text-slate-500">No SharePoint sites are used by this project’s mappings yet.</p>
            ) : (
              <>
                <div className="space-y-1">
                  {health.sites.map((s) => (
                    <div key={s.siteUrl} className="flex items-center gap-2 text-xs">
                      <Chip ok={s.granted}>{s.granted === true ? 'granted' : s.granted === false ? 'not granted' : 'unknown'}</Chip>
                      <span className="text-slate-600 truncate" title={s.siteUrl}>{s.siteUrl}</span>
                    </div>
                  ))}
                </div>
                {health.sites.some((s) => s.granted === false) && (
                  <button onClick={grantAllSites} disabled={granting} className="text-xs font-medium text-blue-700 bg-blue-50 rounded-md px-2 py-1 hover:bg-blue-100 disabled:opacity-40">
                    {granting ? 'Granting…' : 'Grant engine access to all sites'}
                  </button>
                )}
              </>
            )}
            {grantResults && (
              <div className="text-xs text-slate-500 space-y-0.5 pt-1">
                {grantResults.map((r, i) => (
                  <div key={i} className={r.ok === false ? 'text-red-600' : 'text-green-700'}>
                    {r.ok === false ? `✗ ${r.siteUrl}: ${r.error}` : `✓ ${r.siteUrl} (${r.action || 'granted'})`}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
