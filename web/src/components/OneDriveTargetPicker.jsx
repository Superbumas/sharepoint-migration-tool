import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

// Target-only picker for the "migrate into a specific user's OneDrive" option
// (see BlobTargetPicker.jsx for the Azure Blob equivalent this mirrors). A
// user is found by a debounced directory search rather than typed by hand -
// UPNs are easy to get subtly wrong (alias vs. primary SMTP, guest accounts,
// ...) and a wrong one only surfaces as a job failure hours later otherwise.
// The chosen user is then verified to actually have a provisioned OneDrive
// before "Use this" is enabled - /api/mappings re-checks this authoritatively
// at save time regardless, this is just fast feedback.
export default function OneDriveTargetPicker({ onSelect }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [chosenUser, setChosenUser] = useState(null);
  const [path, setPath] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState(null);
  const [selected, setSelected] = useState(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (chosenUser || !query.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setSearchError(null);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      api.get(`/api/onedrive/users?q=${encodeURIComponent(query.trim())}`)
        .then((r) => setResults(r.items || []))
        .catch((err) => setSearchError(err.message))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, chosenUser]);

  function pickUser(user) {
    setChosenUser(user);
    setResults([]);
    setQuery('');
    setVerifyError(null);
    setSelected(null);
  }

  function changeUser() {
    setChosenUser(null);
    setVerifyError(null);
    setSelected(null);
  }

  async function choose() {
    if (!chosenUser) return;
    const upn = chosenUser.userPrincipalName;
    setVerifying(true);
    setVerifyError(null);
    try {
      const check = await api.get(`/api/onedrive/verify?upn=${encodeURIComponent(upn)}`);
      if (!check.ok) {
        setVerifyError(check.error || `No OneDrive found for ${upn}.`);
        return;
      }
      const selection = { type: 'folder', provider: 'onedrive', upn, path: path.trim() };
      setSelected(selection);
      onSelect(selection);
    } catch (err) {
      setVerifyError(err.message);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-700">Target (a user's OneDrive)</h3>

      {!chosenUser ? (
        <div className="space-y-1">
          <label className="text-xs text-slate-500">Find the destination user</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email..."
            className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
          />
          {searching && <div className="text-xs text-slate-400">Searching...</div>}
          {searchError && <div className="text-xs text-red-600">Search failed: {searchError}</div>}
          {!searching && !searchError && query.trim() && results.length === 0 && (
            <div className="text-xs text-slate-400">No matching user found.</div>
          )}
          {results.length > 0 && (
            <ul className="border border-slate-200 rounded-md divide-y divide-slate-100 max-h-48 overflow-y-auto">
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    onClick={() => pickUser(u)}
                    className="w-full text-left px-2 py-1.5 text-sm hover:bg-slate-50"
                  >
                    <div className="font-medium text-slate-800">{u.displayName}</div>
                    <div className="text-xs text-slate-500">{u.mail || u.userPrincipalName}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <label className="text-xs text-slate-500">Destination user</label>
          <div className="flex items-center justify-between border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-slate-50">
            <div>
              <div className="font-medium text-slate-800">{chosenUser.displayName}</div>
              <div className="text-xs text-slate-500">{chosenUser.mail || chosenUser.userPrincipalName}</div>
            </div>
            <button onClick={changeUser} className="text-xs text-blue-700 hover:underline">Change</button>
          </div>
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs text-slate-500">Folder path in their OneDrive (optional)</label>
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="e.g. Migrated/Finance"
          className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
        />
      </div>

      {verifyError && (
        <div className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-md px-2 py-1.5">{verifyError}</div>
      )}

      <button
        onClick={choose}
        disabled={!chosenUser || verifying}
        className="w-full text-left text-xs font-medium text-blue-700 bg-blue-50 rounded-md px-2 py-1.5 hover:bg-blue-100 disabled:opacity-40"
      >
        {verifying ? 'Checking...' : 'Use this OneDrive'}
      </button>

      {selected && (
        <div className="text-xs bg-green-50 border border-green-200 text-green-800 rounded-md px-2 py-1.5">
          Selected: onedrive://{selected.upn}/{selected.path || ''}
        </div>
      )}
    </div>
  );
}
