import React, { useId, useState } from 'react';
import { api } from '../lib/api';
import OneDriveUserSearch from './OneDriveUserSearch';

// Target-only picker for the "migrate into a specific user's OneDrive" option
// (see BlobTargetPicker.jsx for the Azure Blob equivalent this mirrors, and
// OneDriveSourcePicker.jsx for the source side). The person is found with
// OneDriveUserSearch. The chosen user is then verified to actually have a provisioned OneDrive
// before "Use this" is enabled - /api/mappings re-checks this authoritatively
// at save time regardless, this is just fast feedback.
export default function OneDriveTargetPicker({ onSelect }) {
  const fieldId = useId();
  const [chosenUser, setChosenUser] = useState(null);
  const [path, setPath] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState(null);
  const [selected, setSelected] = useState(null);

  function pickUser(user) {
    setChosenUser(user);
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

      <OneDriveUserSearch label="Destination user" chosenUser={chosenUser} onPick={pickUser} onChange={changeUser} />

      <div className="space-y-1">
        <label htmlFor={`${fieldId}-path`} className="text-xs text-slate-500">Folder path in their OneDrive (optional)</label>
        <input
          id={`${fieldId}-path`}
          autoComplete="off"
          spellCheck={false}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="e.g. Migrated/Finance…"
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
        {verifying ? 'Checking…' : 'Use this OneDrive'}
      </button>

      {selected && (
        <div className="text-xs bg-green-50 border border-green-200 text-green-800 rounded-md px-2 py-1.5">
          Selected: onedrive://{selected.upn}/{selected.path || ''}
        </div>
      )}
    </div>
  );
}
