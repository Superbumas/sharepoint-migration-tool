import React, { useState } from 'react';
import { api } from '../lib/api';
import OneDriveUserSearch from './OneDriveUserSearch';
import SharePointPicker from './SharePointPicker';

// Source picker for "migrate out of a specific user's OneDrive". A OneDrive is
// a personal SharePoint site (…-my.sharepoint.com/personal/<alias>) whose
// default library is the drive, so once the person is chosen this resolves
// that site and hands it to the normal SharePoint browser, locked to it. The
// selection it produces is an ordinary SharePoint source (siteUrl + library +
// paths), which the engine already knows how to read - no separate OneDrive
// read path is needed.
export default function OneDriveSourcePicker({ label, onSelect, multi = false, clearSignal = 0 }) {
  const [chosenUser, setChosenUser] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(null); // { site, driveId }
  const [error, setError] = useState(null);

  async function pickUser(user) {
    setChosenUser(user);
    setResolved(null);
    setError(null);
    onSelect(null);
    setResolving(true);
    try {
      const r = await api.get(`/api/onedrive/site?upn=${encodeURIComponent(user.userPrincipalName)}`);
      if (!r.ok) { setError(r.error || 'Could not open this OneDrive.'); return; }
      setResolved({
        // Shown as the mapping's source site name, so the list says whose
        // OneDrive it is rather than the bare personal-site title.
        site: { ...r.site, displayName: `OneDrive - ${user.displayName}` },
        driveId: r.driveId,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setResolving(false);
    }
  }

  function changeUser() {
    setChosenUser(null);
    setResolved(null);
    setError(null);
    onSelect(null);
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-700">{label}</h3>
      <OneDriveUserSearch label="Source user" chosenUser={chosenUser} onPick={pickUser} onChange={changeUser} />
      {resolving && <div className="text-xs text-slate-400">Opening their OneDrive…</div>}
      {error && (
        <div role="alert" className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-md px-2 py-1.5">{error}</div>
      )}
      {resolved && (
        <SharePointPicker
          key={resolved.site.id}
          label=""
          embedded
          fixedSite={resolved.site}
          preferredDriveId={resolved.driveId}
          onSelect={onSelect}
          multi={multi}
          clearSignal={clearSignal}
        />
      )}
    </div>
  );
}
