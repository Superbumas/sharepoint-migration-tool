import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import SharePointPicker from './SharePointPicker';
import BlobTargetPicker from './BlobTargetPicker';
import FileSharePicker from './FileSharePicker';

// Status badge for a mapping's most recent job. Completed jobs distinguish
// verified-clean from completed-with-issues so "done" actually means done.
function MappingStatus({ job }) {
  if (!job) return <span className="inline-block text-xs rounded-full px-2 py-0.5 bg-slate-100 text-slate-500">not migrated</span>;
  const label = (text, cls) => (
    <Link to={`/jobs/${job.id}`} className={`inline-block text-xs rounded-full px-2 py-0.5 hover:opacity-80 ${cls}`} title={job.completedAt ? `Last run finished ${job.completedAt}` : 'Open latest job'}>
      {text}
    </Link>
  );
  switch (job.status) {
    case 'completed':
      if (job.itemsFailed > 0 || job.verificationOk === false) {
        return label(`⚠ completed, ${job.itemsFailed || 'verify'} issue(s)`, 'bg-amber-100 text-amber-800');
      }
      return label(job.verificationOk ? '✓ migrated & verified' : '✓ migrated', 'bg-green-100 text-green-800');
    case 'running':
      return label(`▶ running ${job.itemsDone ?? 0}/${job.totalItems ?? '?'}`, 'bg-blue-100 text-blue-800');
    case 'failed':
      return label('✗ failed', 'bg-red-100 text-red-700');
    case 'paused':
      return label('⏸ paused', 'bg-amber-100 text-amber-800');
    case 'cancelled':
      return label('cancelled', 'bg-slate-200 text-slate-600');
    default:
      return label(job.status, 'bg-slate-100 text-slate-600');
  }
}

export default function MappingsPage() {
  const [mappings, setMappings] = useState([]);
  const [source, setSource] = useState(null);
  const [target, setTarget] = useState(null);
  const [sourceKind, setSourceKind] = useState('sharepoint'); // 'sharepoint' | 'filesystem'
  const [targetKind, setTargetKind] = useState('sharepoint'); // 'sharepoint' | 'azure_blob'
  const [blobArchivingEnabled, setBlobArchivingEnabled] = useState(false);
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const navigate = useNavigate();

  function refresh() {
    api.get('/api/mappings').then((r) => setMappings(r.items));
  }
  useEffect(refresh, []);
  useEffect(() => {
    api.get('/api/settings').then((r) => setBlobArchivingEnabled(!!r.blobArchivingEnabled));
  }, []);

  function switchTargetKind(kind) {
    setTargetKind(kind);
    setTarget(null);
  }

  function switchSourceKind(kind) {
    setSourceKind(kind);
    setSource(null);
    // A file-share source can only migrate into SharePoint (no share-to-blob
    // path in the engine) - snap the target back if blob was selected.
    if (kind === 'filesystem' && targetKind !== 'sharepoint') switchTargetKind('sharepoint');
  }

  async function saveMapping() {
    setMessage(null);
    if (!source || !target) { setMessage({ type: 'error', text: 'Pick both a source and a target first.' }); return; }
    // A multi-selection (several ticked folders/files) becomes one mapping
    // per ticked item, all sharing the same target. A file-share source is
    // always a single folder.
    const isFsSource = source.provider === 'filesystem';
    const sourceItems = isFsSource
      ? [{ sourceType: 'folder', sourcePath: source.path }]
      : (source.multi
        ? source.items.map((it) => ({ sourceType: it.type, sourcePath: it.path }))
        : [{ sourceType: source.type, sourcePath: source.path }]);
    if (sourceItems.length === 0) { setMessage({ type: 'error', text: 'Tick at least one folder or file on the source side.' }); return; }
    try {
      const targetFields = target.provider === 'azure_blob'
        ? { targetProvider: 'azure_blob', targetContainer: target.container, targetBlobPrefix: target.blobPrefix }
        : { targetType: target.type, targetSiteUrl: target.siteUrl, targetSiteName: target.siteName, targetLibrary: target.library, targetPath: target.path };
      const sourceFields = isFsSource
        ? { sourceProvider: 'filesystem' }
        : { sourceSiteUrl: source.siteUrl, sourceSiteName: source.siteName, sourceLibrary: source.library };

      const allGrants = [];
      for (const item of sourceItems) {
        const saved = await api.post('/api/mappings', {
          ...item,
          ...sourceFields,
          ...targetFields,
          action: 'Migrate', notes,
        });
        allGrants.push(...(saved.engineAccess || []));
      }

      const failed = allGrants.filter((g) => !g.ok);
      const madeNew = allGrants.filter((g) => g.ok && g.action !== 'already-granted');
      let text = sourceItems.length > 1 ? `${sourceItems.length} mappings saved.` : 'Mapping saved.';
      if (failed.length > 0) {
        const failedSites = [...new Set(failed.map((g) => g.siteUrl))];
        text += ` ⚠ Could not auto-grant engine access on ${failedSites.join(', ')} (${failed[0].error}) - grant manually in the site picker.`;
      } else if (madeNew.length > 0) {
        text += ' Engine access granted automatically.';
      } else if (allGrants.length > 0) {
        text += ' Engine already had access to all sites.';
      }
      setMessage({ type: failed.length > 0 ? 'error' : 'success', text });
      setSource(null); setTarget(null); setNotes('');
      refresh();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    }
  }

  async function createJob(mappingId) {
    const job = await api.post(`/api/mappings/${mappingId}/jobs`);
    navigate(`/jobs/${job.id}`);
  }

  async function bulkCreateJobs() {
    if (selectedIds.size === 0) return;
    await api.post('/api/jobs/bulk-create', { mappingIds: [...selectedIds] });
    setSelectedIds(new Set());
    navigate('/jobs');
  }

  async function uploadCrosswalk(e) {
    e.preventDefault();
    const file = e.target.elements.crosswalkFile.files[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    const result = await api.postForm('/api/mappings/import', form);
    setImportResult(result);
    refresh();
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-800">Mappings</h1>

      <details className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 group">
        <summary className="text-sm text-slate-600 cursor-pointer select-none list-none flex items-center gap-2">
          <span className="text-slate-400 transition-transform group-open:rotate-90">▸</span>
          <span className="font-medium">Bulk import from crosswalk spreadsheet</span>
          <a href="/api/mappings/crosswalk-template" onClick={(e) => e.stopPropagation()} className="text-xs text-blue-600 hover:underline ml-auto">template</a>
        </summary>
        <form onSubmit={uploadCrosswalk} className="flex items-center gap-2 mt-3">
          <input type="file" name="crosswalkFile" accept=".xlsx,.xls" className="text-sm" />
          <button type="submit" className="btn-primary">Import</button>
        </form>
        {importResult && (
          <div className="text-xs bg-slate-50 border border-slate-200 rounded-md p-2 mt-2">
            Imported {importResult.importedCount} of {importResult.totalRows} rows from sheet "{importResult.sheetUsed}"
            {importResult.skippedCount > 0 && <span className="text-amber-600"> - {importResult.skippedCount} skipped</span>}.
          </div>
        )}
      </details>

      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-semibold text-slate-700">Or pick source and target by hand</h2>
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
        </div>
        {blobArchivingEnabled && sourceKind === 'sharepoint' && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-500">Target destination:</span>
            <button
              onClick={() => switchTargetKind('sharepoint')}
              className={`rounded-full px-2 py-0.5 ${targetKind === 'sharepoint' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              SharePoint site
            </button>
            <button
              onClick={() => switchTargetKind('azure_blob')}
              className={`rounded-full px-2 py-0.5 ${targetKind === 'azure_blob' ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              Azure Blob container (archive)
            </button>
          </div>
        )}
        <div className="grid md:grid-cols-2 gap-4">
          {sourceKind === 'filesystem'
            ? <FileSharePicker label="Source folder on a file share" onSelect={setSource} />
            : <SharePointPicker label="Source (tick one or more folders/files)" onSelect={setSource} multi />}
          {targetKind === 'azure_blob'
            ? <BlobTargetPicker onSelect={setTarget} />
            : <SharePointPicker label="Target folder" onSelect={setTarget} />}
        </div>
        <div className="flex items-center gap-3">
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm" />
          <button onClick={saveMapping} className="btn-primary">Save mapping</button>
        </div>
        {message && (
          <div className={`text-sm rounded-md p-2 ${message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>
            {message.text}
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
          <h2 className="text-sm font-semibold text-slate-700">All mappings ({mappings.length})</h2>
          <button onClick={bulkCreateJobs} disabled={selectedIds.size === 0} className="btn-secondary disabled:opacity-40">
            Create jobs for {selectedIds.size} selected
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="px-4 py-2"></th>
              <th className="text-left px-4 py-2">Source</th>
              <th className="text-left px-4 py-2">Target</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Origin</th>
              <th className="text-right px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {mappings.map((m) => (
              <tr key={m.id} className="hover:bg-slate-50">
                <td className="px-4 py-2"><input type="checkbox" checked={selectedIds.has(m.id)} onChange={() => toggleSelected(m.id)} /></td>
                <td className="px-4 py-2 text-slate-700">
                  {m.sourceProvider === 'filesystem'
                    ? <span className="inline-flex items-center gap-1"><span className="text-xs rounded bg-violet-100 text-violet-700 px-1.5 py-0.5 font-medium">share</span>{m.sourcePath}</span>
                    : <>{m.sourceLibrary}/{m.sourcePath}</>}
                </td>
                <td className="px-4 py-2 text-slate-700">
                  <span className="text-slate-300 mr-1.5">→</span>
                  {m.targetProvider === 'azure_blob'
                    ? <span className="inline-flex items-center gap-1"><span className="text-xs rounded bg-sky-100 text-sky-700 px-1.5 py-0.5 font-medium">blob</span>{m.targetContainer}/{m.targetBlobPrefix || ''}</span>
                    : `${m.targetLibrary}/${m.targetPath}`}
                </td>
                <td className="px-4 py-2"><MappingStatus job={m.latestJob} /></td>
                <td className="px-4 py-2 text-slate-400 text-xs">{m.origin}{m.confidence ? ` (${m.confidence})` : ''}</td>
                <td className="px-4 py-2 text-right">
                  <button onClick={() => createJob(m.id)} className="text-xs font-medium rounded-md px-2.5 py-1 bg-blue-600 text-white hover:bg-blue-700 transition-colors">Create job</button>
                </td>
              </tr>
            ))}
            {mappings.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">No mappings yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
