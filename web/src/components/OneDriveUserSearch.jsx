import React, { useEffect, useId, useRef, useState } from 'react';
import { api } from '../lib/api';

// Directory search for picking a person whose OneDrive is the source or the
// target of a mapping. Shared by OneDriveSourcePicker and OneDriveTargetPicker.
// A user is found by a debounced search rather than typed by hand - UPNs are
// easy to get subtly wrong (alias vs. primary SMTP, guest accounts, ...) and a
// wrong one only surfaces as a job failure hours later otherwise.
export default function OneDriveUserSearch({ label, chosenUser, onPick, onChange }) {
  const fieldId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
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

  function pick(user) {
    setResults([]);
    setQuery('');
    onPick(user);
  }

  if (chosenUser) {
    return (
      <div className="space-y-1">
        <div className="text-xs text-slate-500">{label}</div>
        <div className="flex items-center justify-between border border-slate-300 rounded-md px-2 py-1.5 text-sm bg-slate-50">
          <div className="min-w-0">
            <div className="font-medium text-slate-800 truncate">{chosenUser.displayName}</div>
            <div className="text-xs text-slate-500 truncate">{chosenUser.mail || chosenUser.userPrincipalName}</div>
          </div>
          <button onClick={onChange} className="text-xs text-blue-700 hover:underline shrink-0 ml-2">Change</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor={`${fieldId}-user`} className="text-xs text-slate-500">Find the {label.toLowerCase()}</label>
      <input
        id={`${fieldId}-user`}
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or email…"
        className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
      />
      {searching && <div className="text-xs text-slate-400">Searching…</div>}
      {searchError && <div role="alert" className="text-xs text-red-600">Search failed: {searchError}</div>}
      {!searching && !searchError && query.trim() && results.length === 0 && (
        <div className="text-xs text-slate-400">No matching user found.</div>
      )}
      {results.length > 0 && (
        <ul className="border border-slate-200 rounded-md divide-y divide-slate-100 max-h-48 overflow-y-auto">
          {results.map((u) => (
            <li key={u.id}>
              <button onClick={() => pick(u)} className="w-full text-left px-2 py-1.5 text-sm hover:bg-slate-50">
                <div className="font-medium text-slate-800">{u.displayName}</div>
                <div className="text-xs text-slate-500">{u.mail || u.userPrincipalName}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
