import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import SharePointPicker from './SharePointPicker';
import BlobTargetPicker from './BlobTargetPicker';
import OneDriveTargetPicker from './OneDriveTargetPicker';
import OneDriveSourcePicker from './OneDriveSourcePicker';
import FileSharePicker from './FileSharePicker';
import BulkAddSites from './mappings/BulkAddSites';
import MappingsGrid from './mappings/MappingsGrid';

const ADD_MODES = [
  { id: 'hand', label: 'Pick by hand' },
  { id: 'sites', label: 'Many sites at once' },
  { id: 'sheet', label: 'From a spreadsheet' },
];

// The project (a named group of mappings) new mappings go into. Remembered
// between visits: a big migration is built over several sittings.
const PROJECT_KEY = 'mappings.currentProject';
function rememberedProject() {
  try { return localStorage.getItem(PROJECT_KEY) || ''; } catch { return ''; }
}

export default function MappingsPage() {
  const [mappings, setMappings] = useState([]);
  const [source, setSource] = useState(null);
  const [target, setTarget] = useState(null);
  const [sourceKind, setSourceKind] = useState('sharepoint'); // 'sharepoint' | 'onedrive' | 'filesystem'
  const [targetKind, setTargetKind] = useState('sharepoint'); // 'sharepoint' | 'azure_blob' | 'onedrive'
  const [blobArchivingEnabled, setBlobArchivingEnabled] = useState(false);
  const [onedriveTargetEnabled, setOnedriveTargetEnabled] = useState(false);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [addMode, setAddMode] = useState('hand');
  // Tabs are mounted the first time they are opened and then kept (hidden),
  // so switching tabs doesn't throw away where a picker had got to.
  const [openedModes, setOpenedModes] = useState(new Set(['hand']));
  const [project, setProject] = useState(rememberedProject);
  const [sourceClear, setSourceClear] = useState(0);

  function refresh() {
    return api.get('/api/mappings').then((r) => setMappings(r.items))
      .catch((err) => setMessage({ type: 'error', text: `Couldn't load mappings: ${err.message}` }));
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    try { localStorage.setItem(PROJECT_KEY, project); } catch { /* private window: just not remembered */ }
  }, [project]);

  const groupNames = useMemo(
    () => [...new Set(mappings.map((m) => m.group).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [mappings]
  );
  const projectName = project.replace(/\s+/g, ' ').trim();
  useEffect(() => {
    api.get('/api/settings').then((r) => {
      setBlobArchivingEnabled(!!r.blobArchivingEnabled);
      setOnedriveTargetEnabled(!!r.onedriveTargetEnabled);
    }).catch(() => {});
  }, []);

  function switchTargetKind(kind) {
    setTargetKind(kind);
    setTarget(null);
  }

  function switchSourceKind(kind) {
    setSourceKind(kind);
    setSource(null);
    // A file-share source can only migrate into SharePoint or a OneDrive (no
    // share-to-blob path in the engine) - snap the target back if blob was
    // selected.
    if (kind === 'filesystem' && targetKind === 'azure_blob') switchTargetKind('sharepoint');
  }

  async function saveMapping() {
    setMessage(null);
    if (!source || !target) { setMessage({ type: 'error', text: 'Pick both a source and a target first.' }); return; }
    // A multi-selection (several ticked folders/files) becomes one mapping
    // per ticked item, all sharing the same target. A file-share source is
    // always a folder (a single directory the engine walks), whether one or
    // many are ticked.
    const isFsSource = source.provider === 'filesystem';
    const sourceItems = isFsSource
      ? (source.multi
        ? source.items.map((it) => ({ sourceType: 'folder', sourcePath: it.path }))
        : [{ sourceType: 'folder', sourcePath: source.path }])
      : (source.multi
        ? source.items.map((it) => ({ sourceType: it.type, sourcePath: it.path }))
        : [{ sourceType: source.type, sourcePath: source.path }]);
    if (sourceItems.length === 0) { setMessage({ type: 'error', text: 'Tick at least one folder or file on the source side.' }); return; }
    try {
      const targetFields = target.provider === 'azure_blob'
        ? { targetProvider: 'azure_blob', targetContainer: target.container, targetBlobPrefix: target.blobPrefix }
        : target.provider === 'onedrive'
        ? { targetProvider: 'onedrive', targetOnedriveUpn: target.upn, targetOnedrivePath: target.path }
        : { targetType: target.type, targetSiteUrl: target.siteUrl, targetSiteName: target.siteName, targetLibrary: target.library, targetPath: target.path };
      const sourceFields = isFsSource
        ? { sourceProvider: 'filesystem' }
        : { sourceSiteUrl: source.siteUrl, sourceSiteName: source.siteName, sourceLibrary: source.library };

      // One request for the whole batch, so engine access is checked once
      // per site and not once per ticked folder.
      const saved = await api.post('/api/mappings/bulk', {
        items: sourceItems.map((item) => ({
          ...item,
          ...sourceFields,
          ...targetFields,
          action: 'Migrate', notes, group: projectName || undefined,
        })),
      });
      if (saved.items.length === 0) throw new Error(saved.failed[0]?.message || 'Nothing was saved.');
      const allGrants = saved.engineAccess || [];

      const failed = allGrants.filter((g) => !g.ok);
      const madeNew = allGrants.filter((g) => g.ok && g.action !== 'already-granted');
      let text = saved.items.length > 1 ? `${saved.items.length} mappings saved.` : 'Mapping saved.';
      if (saved.failed.length > 0) text += ` ${saved.failed.length} could not be saved: ${saved.failed[0].message}`;
      text += ' The target is kept, so you can tick the next source straight away.';
      if (failed.length > 0) {
        const failedSites = [...new Set(failed.map((g) => g.siteUrl))];
        text += ` ⚠ Could not auto-grant engine access on ${failedSites.join(', ')} (${failed[0].error}) - grant manually in the site picker.`;
      } else if (madeNew.length > 0) {
        text += ' Engine access granted automatically.';
      } else if (allGrants.length > 0) {
        text += ' Engine already had access to all sites.';
      }
      setMessage({ type: failed.length > 0 || saved.failed.length > 0 ? 'error' : 'success', text });
      // Only the source is cleared: consolidations send source after source
      // to the same place, and re-picking the target each time was most of
      // the clicking. The pickers stay where they are.
      setSource(null); setNotes('');
      setSourceClear((n) => n + 1);
      refresh();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function uploadCrosswalk(e) {
    e.preventDefault();
    const file = e.target.elements.crosswalkFile.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api.postForm('/api/mappings/import', form);
      setImportResult(result);
      refresh();
    } catch (err) {
      setImportResult({ error: err.message });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-800">Mappings</h1>

      <div className="bg-white border border-slate-200 rounded-lg">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 pt-3 border-b border-slate-200">
          <div className="flex gap-1" role="tablist" aria-label="How to add mappings">
            {ADD_MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={addMode === m.id}
                onClick={() => { setAddMode(m.id); setOpenedModes((prev) => new Set(prev).add(m.id)); }}
                className={`text-sm px-3 py-2 -mb-px border-b-2 ${addMode === m.id ? 'border-blue-600 text-blue-700 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto pb-2">
            <label htmlFor="add-project" className="text-xs text-slate-500">Add to project</label>
            <input
              id="add-project"
              list="add-project-names"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="None (type a name to group them)"
              autoComplete="off"
              className="w-64 max-w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
            />
            <datalist id="add-project-names">{groupNames.map((g) => <option key={g} value={g} />)}</datalist>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {openedModes.has('sites') && (
            <div className={addMode === 'sites' ? '' : 'hidden'}>
              <BulkAddSites existingMappings={mappings} group={projectName} onSaved={refresh} />
            </div>
          )}

          {addMode === 'sheet' && (
            <div>
              <p className="text-sm text-slate-600">
                Fill in the <a href="/api/mappings/crosswalk-template" className="text-blue-600 hover:underline">crosswalk template</a> and upload it. One row is one mapping, and a Project column groups them.
              </p>
            <form onSubmit={uploadCrosswalk} className="flex items-center gap-2 mt-3">
              <input type="file" name="crosswalkFile" accept=".xlsx,.xls" aria-label="Crosswalk spreadsheet" className="text-sm min-w-0" />
              <button type="submit" className="btn-primary">Import</button>
            </form>
            {importResult?.error && (
              <div role="alert" className="text-xs bg-red-50 border border-red-200 text-red-700 rounded-md p-2 mt-2">Import failed: {importResult.error}</div>
            )}
            {importResult && !importResult.error && (
              <div className="text-xs bg-slate-50 border border-slate-200 rounded-md p-2 mt-2">
                Imported {importResult.importedCount} of {importResult.totalRows} rows from sheet "{importResult.sheetUsed}"
                {importResult.skippedCount > 0 && <span className="text-amber-600"> - {importResult.skippedCount} skipped</span>}.
              </div>
            )}
            </div>
          )}

          <div className={addMode === 'hand' ? 'space-y-4' : 'hidden'}>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Source:</span>
              <button
                onClick={() => switchSourceKind('sharepoint')}
                className={`rounded-full px-2 py-0.5 ${sourceKind === 'sharepoint' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
              >
                SharePoint site
              </button>
              <button
                onClick={() => switchSourceKind('filesystem')}
                className={`rounded-full px-2 py-0.5 ${sourceKind === 'filesystem' ? 'bg-violet-100 text-violet-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
              >
                File share (DFS)
              </button>
              <button
                onClick={() => switchSourceKind('onedrive')}
                className={`rounded-full px-2 py-0.5 ${sourceKind === 'onedrive' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
              >
                A user's OneDrive
              </button>
            </div>
            {((blobArchivingEnabled && sourceKind !== 'filesystem') || onedriveTargetEnabled) && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-slate-500">Target destination:</span>
                <button
                  onClick={() => switchTargetKind('sharepoint')}
                  className={`rounded-full px-2 py-0.5 ${targetKind === 'sharepoint' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                >
                  SharePoint site
                </button>
                {blobArchivingEnabled && sourceKind !== 'filesystem' && (
                  <button
                    onClick={() => switchTargetKind('azure_blob')}
                    className={`rounded-full px-2 py-0.5 ${targetKind === 'azure_blob' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  >
                    Azure Blob container (archive)
                  </button>
                )}
                {onedriveTargetEnabled && (
                  <button
                    onClick={() => switchTargetKind('onedrive')}
                    className={`rounded-full px-2 py-0.5 ${targetKind === 'onedrive' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  >
                    A user's OneDrive
                  </button>
                )}
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-4 [&>*]:min-w-0">
              {sourceKind === 'filesystem'
                ? <FileSharePicker label="Source (tick one or more folders on a file share)" onSelect={setSource} multi />
                : sourceKind === 'onedrive'
                ? <OneDriveSourcePicker label="Source (a user's OneDrive - tick one or more folders/files)" onSelect={setSource} multi clearSignal={sourceClear} />
                : <SharePointPicker label="Source (tick one or more folders/files)" onSelect={setSource} multi clearSignal={sourceClear} />}
              {targetKind === 'azure_blob'
                ? <BlobTargetPicker onSelect={setTarget} />
                : targetKind === 'onedrive'
                ? <OneDriveTargetPicker onSelect={setTarget} />
                : <SharePointPicker label="Target folder" onSelect={setTarget} allowCreateFolder />}
            </div>
            <div className="flex items-center gap-3">
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)…" aria-label="Mapping notes" autoComplete="off" className="flex-1 min-w-0 border border-slate-300 rounded-md px-2 py-1 text-sm" />
              <button onClick={saveMapping} className="btn-primary">{source?.multi && source.items.length > 1 ? `Save ${source.items.length} mappings` : 'Save mapping'}</button>
            </div>
            {message && (
              <div role={message.type === 'error' ? 'alert' : 'status'} className={`text-sm rounded-md p-2 ${message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
                {message.text}
              </div>
            )}
          </div>
        </div>
      </div>

      <MappingsGrid mappings={mappings} groupNames={groupNames} refresh={refresh} />
    </div>
  );
}
