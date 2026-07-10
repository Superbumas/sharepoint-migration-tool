import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Target-only picker for the "archive to Azure Blob" option (see
// SharePointPicker.jsx for the SharePoint equivalent, used for both Source
// and Target - this one only ever appears as the Target). A container may
// not exist yet - the engine creates it on first run (see
// engine/lib/BlobTarget.psm1's Confirm-BlobContainerExists) - so the
// container name accepts either a pick from the live dropdown or free text.
export default function BlobTargetPicker({ onSelect }) {
  const [containers, setContainers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [container, setContainer] = useState('');
  const [blobPrefix, setBlobPrefix] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.get('/api/blob/containers')
      .then((r) => setContainers(r.items || []))
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  }, []);

  function choose() {
    if (!container.trim()) return;
    const selection = {
      type: 'folder',
      provider: 'azure_blob',
      container: container.trim(),
      blobPrefix: blobPrefix.trim(),
    };
    setSelected(selection);
    onSelect(selection);
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-700">Target (Azure Blob container)</h3>

      <div className="space-y-1">
        <label className="text-xs text-slate-500">Container</label>
        <input
          list="blob-container-options"
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          placeholder="Pick or type a container name..."
          className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
        />
        <datalist id="blob-container-options">
          {containers.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {loading && <div className="text-xs text-slate-400">Loading containers...</div>}
        {loadError && <div className="text-xs text-red-600">Could not list containers: {loadError}</div>}
        {!loading && !loadError && containers.length === 0 && (
          <div className="text-xs text-slate-400">No existing containers found - type a new name and the engine will create it.</div>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs text-slate-500">Path prefix (optional)</label>
        <input
          value={blobPrefix}
          onChange={(e) => setBlobPrefix(e.target.value)}
          placeholder="e.g. Archive/2024"
          className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
        />
      </div>

      <button onClick={choose} disabled={!container.trim()} className="w-full text-left text-xs font-medium text-blue-700 bg-blue-50 rounded-md px-2 py-1.5 hover:bg-blue-100 disabled:opacity-40">
        Use this container
      </button>

      {selected && (
        <div className="text-xs bg-green-50 border border-green-200 text-green-800 rounded-md px-2 py-1.5">
          Selected: azure-blob://{selected.container}/{selected.blobPrefix || ''}
        </div>
      )}
    </div>
  );
}
