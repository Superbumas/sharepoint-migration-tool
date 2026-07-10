import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Renders the non-secret analysis of a connection string (form, account,
// SAS expiry) - used both for the currently-saved string and live while
// pasting a new one, so a portal SAS with a short baked-in expiry is
// visible up front instead of failing with 403s hours into a job.
function ConnectionStringInfo({ info, label }) {
  if (!info) return null;
  const rows = [];
  if (info.form === 'account_key') {
    rows.push(
      <span key="form" className="inline-flex items-center gap-1 text-xs font-medium text-green-800 bg-green-50 border border-green-200 rounded-full px-2 py-0.5">
        ✓ Access-keys form — engine creates its own 48h tokens, never expires mid-job (recommended)
      </span>
    );
  } else if (info.form === 'sas') {
    const exp = info.sasExpiresAt ? new Date(info.sasExpiresAt) : null;
    const hoursLeft = exp ? (exp - Date.now()) / 36e5 : null;
    const expired = info.sasExpired || (hoursLeft !== null && hoursLeft <= 0);
    const cls = expired
      ? 'text-red-700 bg-red-50 border-red-200'
      : hoursLeft !== null && hoursLeft < 12
        ? 'text-amber-800 bg-amber-50 border-amber-200'
        : 'text-slate-600 bg-slate-50 border-slate-200';
    rows.push(
      <span key="form" className={`inline-flex items-center gap-1 text-xs font-medium border rounded-full px-2 py-0.5 ${cls}`}>
        {expired ? '✗ SAS EXPIRED' : '⚠ SAS form'}
        {exp && <> — {expired ? 'expired' : 'expires'} {exp.toLocaleString('en-GB')}{!expired && hoursLeft !== null && ` (in ${hoursLeft < 48 ? `${hoursLeft.toFixed(1)}h` : `${(hoursLeft / 24).toFixed(1)}d`})`}</>}
        {!exp && ' — no expiry found'}
      </span>
    );
    if (info.sasPermissions) {
      rows.push(<span key="perms" className="text-xs text-slate-400">permissions: {info.sasPermissions}</span>);
    }
    rows.push(
      <span key="hint" className="text-xs text-slate-400">
        SAS tokens can't be renewed by the engine — a long job can outlive one. Prefer the Access-keys connection string.
      </span>
    );
  } else if (info.form === 'unknown') {
    rows.push(
      <span key="form" className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">
        ✗ Not recognized — needs AccountName+AccountKey or a SharedAccessSignature
      </span>
    );
  }
  return (
    <div className="flex items-center gap-2 flex-wrap mt-1.5">
      {label && <span className="text-xs text-slate-500">{label}</span>}
      {info.accountName && <span className="text-xs font-medium text-slate-600 bg-slate-100 rounded px-1.5 py-0.5">account: {info.accountName}</span>}
      {rows}
    </div>
  );
}

// Editor for the project's file-share (DFS) source roots - the allowlist the
// Mappings picker, the browse API and the engine are all confined to. Saving
// reports live whether the SERVER's account can actually read each root, so
// a wrong path or missing share permission is visible here immediately
// instead of as an empty picker.
function FsSourceRootsEditor({ settings, onSaved }) {
  const [roots, setRoots] = useState(settings.fsSourceRoots || []);
  const [newRoot, setNewRoot] = useState('');
  const [status, setStatus] = useState(null); // save response: [{path, ok, error}]
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [dirty, setDirty] = useState(false);

  function addRoot() {
    const p = newRoot.trim();
    if (!p) return;
    if (roots.some((r) => r.toLowerCase() === p.toLowerCase())) { setNewRoot(''); return; }
    setRoots([...roots, p]);
    setNewRoot('');
    setDirty(true);
  }

  function removeRoot(p) {
    setRoots(roots.filter((r) => r !== p));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const r = await api.post('/api/settings/fs-source-roots', { roots });
      setStatus(r.status);
      setRoots(r.roots);
      setDirty(false);
      const bad = r.status.filter((s) => !s.ok);
      setMessage(bad.length > 0
        ? { type: 'error', text: `Saved, but the server cannot read ${bad.length} of ${r.status.length} share(s) - see below. The account running the migration server needs read access.` }
        : { type: 'success', text: r.roots.length ? 'Saved - all shares readable by the server. The "File share (DFS)" source on the Mappings page is ready.' : 'Saved - no shares configured, the file-share source is disabled for this project.' });
      onSaved();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  const statusFor = (p) => status?.find((s) => s.path.toLowerCase() === p.toLowerCase());

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-slate-700 mb-2">File share (DFS) migration source (this project)</h2>
      <p className="text-xs text-slate-500 mb-3">
        UNC paths of the file shares this project may browse and migrate into SharePoint. The migration server's own
        account reads them (not you), and everyone signed into this project can browse everything under these roots —
        so list the folders actually being migrated, not a whole drive.
      </p>
      <ul className="space-y-1 mb-2">
        {roots.map((p) => {
          const st = statusFor(p);
          return (
            <li key={p} className="flex items-center gap-2 text-sm bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5">
              <span className="shrink-0">🗄️</span>
              <span className="font-mono text-xs text-slate-700 truncate flex-1 min-w-0" title={p}>{p}</span>
              {st && (st.ok
                ? <span className="text-xs font-medium text-green-700 bg-green-50 border border-green-200 rounded-full px-2 py-0.5 shrink-0">✓ readable</span>
                : <span className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-full px-2 py-0.5 shrink-0" title={st.error}>✗ unreadable</span>)}
              <button onClick={() => removeRoot(p)} className="text-xs text-slate-400 hover:text-red-600 shrink-0" title="Remove">remove</button>
            </li>
          );
        })}
        {roots.length === 0 && <li className="text-xs text-slate-400 px-1 py-1">No shares yet — add the first one below.</li>}
      </ul>
      <div className="flex items-center gap-2 mb-2">
        <input
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRoot())}
          placeholder="\\server\share\folder  or  D:\Data\Departments"
          className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm font-mono"
        />
        <button type="button" onClick={addRoot} disabled={!newRoot.trim()} className="btn-secondary disabled:opacity-40">Add</button>
        <button type="button" onClick={save} disabled={saving || !dirty} className="btn-primary disabled:opacity-40">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {message && (
        <div className={`text-xs rounded-md p-2 ${message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
          {message.text}
        </div>
      )}
      {status?.some((s) => !s.ok) && (
        <ul className="mt-2 space-y-1">
          {status.filter((s) => !s.ok).map((s) => (
            <li key={s.path} className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-md px-2 py-1.5">
              <span className="font-mono">{s.path}</span>: {s.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [connectionString, setConnectionString] = useState('');
  const [pasteInfo, setPasteInfo] = useState(null);
  const analyzeDebounce = useRef(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  function onConnectionStringChange(value) {
    setConnectionString(value);
    if (analyzeDebounce.current) clearTimeout(analyzeDebounce.current);
    if (!value.trim()) { setPasteInfo(null); return; }
    analyzeDebounce.current = setTimeout(() => {
      api.post('/api/settings/blob-connection-string/analyze', { connectionString: value.trim() })
        .then((r) => setPasteInfo(r.info))
        .catch(() => setPasteInfo(null));
    }, 350);
  }

  function refresh() {
    api.get('/api/settings').then(setSettings);
  }
  useEffect(refresh, []);

  async function saveBlobConnectionString(e) {
    e.preventDefault();
    if (!connectionString.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.post('/api/settings/blob-connection-string', { connectionString: connectionString.trim() });
      setConnectionString('');
      setPasteInfo(null);
      setMessage({ type: 'success', text: 'Saved for this project.' });
      refresh();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function clearBlobConnectionString() {
    setSaving(true);
    setMessage(null);
    try {
      await api.del('/api/settings/blob-connection-string');
      setMessage({ type: 'success', text: 'Cleared for this project.' });
      refresh();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return <div className="text-slate-500">Loading settings...</div>;

  const rows = [
    ['Tenant', settings.tenantName || '—'],
    ['Default per-job concurrency', settings.defaultJobConcurrency],
    ['Global max concurrency (all jobs combined)', settings.globalMaxConcurrency],
    ['Adaptive throttle trigger (retry rate)', `${(settings.retryRateBackoffThreshold * 100).toFixed(0)}%`],
    ['Slow-transfer threshold', `${settings.slowTransferThresholdMs / 1000}s`],
    ['Engine permission mode', settings.enginePermissionMode],
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Per-project configuration and audit exports.</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">Azure Blob archiving (this project)</h2>
        <p className="text-xs text-slate-500 mb-1.5">
          Storage account connection string used when this project archives to an Azure Blob container instead of
          another SharePoint site. Set per-project here - never leaves this project's own data.{' '}
          {settings.blobArchivingEnabled ? (
            <span className="text-green-700 font-medium">Currently configured.</span>
          ) : (
            <span className="text-slate-500">Not configured yet - the Azure Blob target option is hidden on the Mappings page until it is.</span>
          )}
        </p>
        {settings.blobConnectionInfo && <div className="mb-3"><ConnectionStringInfo info={settings.blobConnectionInfo} label="Saved:" /></div>}
        <form onSubmit={saveBlobConnectionString} className="flex items-center gap-2 mb-2">
          <input
            type="password"
            value={connectionString}
            onChange={(e) => onConnectionStringChange(e.target.value)}
            placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;"
            className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm font-mono"
          />
          <button type="submit" disabled={saving || !connectionString.trim()} className="btn-primary disabled:opacity-40">
            Save
          </button>
          {settings.blobArchivingEnabled && (
            <button type="button" onClick={clearBlobConnectionString} disabled={saving} className="btn-secondary disabled:opacity-40">
              Clear
            </button>
          )}
        </form>
        {pasteInfo && <ConnectionStringInfo info={pasteInfo} label="Pasted:" />}
        {message && (
          <div className={`text-xs rounded-md p-2 ${message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
            {message.text}
          </div>
        )}
      </div>

      <FsSourceRootsEditor settings={settings} onSaved={refresh} />

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <p className="text-xs text-slate-500 mb-4">
          These throttling/concurrency defaults are configured via environment variables (.env) - they govern the
          shared tenant throttle budget across every running job and are not meant to be changed casually at runtime.
        </p>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="py-2 text-slate-500">{label}</td>
                <td className="py-2 text-slate-800 font-medium text-right">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-2">Master audit export</h2>
        <p className="text-xs text-slate-500 mb-3">
          Every file/folder operation and every lifecycle action (approve/run/pause/cancel/delete) across every job
          - including jobs deleted from the active queue - is kept in the audit log and can be exported at any time.
        </p>
        <div className="space-x-3 text-sm">
          <a className="text-blue-600 hover:underline" href="/api/export/audit?format=csv">Export all-time audit log (CSV)</a>
          <a className="text-blue-600 hover:underline" href="/api/export/audit?format=json">Export all-time audit log (JSON)</a>
        </div>
      </div>
    </div>
  );
}
