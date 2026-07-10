import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

function formatBytes(n) {
  if (!n && n !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const FILE_ICONS = {
  docx: '📝', doc: '📝', odt: '📝', rtf: '📝', txt: '📝',
  xlsx: '📊', xls: '📊', csv: '📊',
  pptx: '📽️', ppt: '📽️',
  pdf: '📕',
  jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', bmp: '🖼️', webp: '🖼️',
  mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', wmv: '🎬',
  mp3: '🎵', wav: '🎵', m4a: '🎵',
  zip: '🗜️', rar: '🗜️', '7z': '🗜️',
  msg: '✉️', eml: '✉️',
};
function fileIcon(name) {
  const ext = (name || '').split('.').pop()?.toLowerCase();
  return FILE_ICONS[ext] || '📄';
}

// Source picker for file-share (DFS/UNC) migrations - the filesystem
// counterpart of SharePointPicker, deliberately styled to feel like it
// (root cards ~ site list, breadcrumb bar, filter, hover Select). Browsing
// happens server-side (the server process account reads the share, not the
// signed-in user) and is confined to the project's allowlist managed on the
// Settings page; this component can only ever see what /api/fs/browse is
// willing to show it.
//
// Selection shape handed to onSelect: { provider: 'filesystem', path, name } -
// always a single folder (migrating a folder recreates the folder itself at
// the target, same semantics as the SharePoint picker).
export default function FileSharePicker({ label, onSelect }) {
  const [rootsInfo, setRootsInfo] = useState(null); // null = loading
  const [root, setRoot] = useState(null);
  // Breadcrumb segments under the root: [{name, path}]
  const [pathStack, setPathStack] = useState([]);
  const [listing, setListing] = useState({ folders: [], files: [], fileCount: 0, fileListTruncated: false });
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    api.get('/api/fs/roots').then(setRootsInfo).catch(() => setRootsInfo({ enabled: false, roots: [] }));
  }, []);

  const currentPath = pathStack.length > 0 ? pathStack[pathStack.length - 1].path : root?.path;
  const currentName = pathStack.length > 0 ? pathStack[pathStack.length - 1].name : root?.name;

  useEffect(() => {
    if (!currentPath) return;
    setLoading(true);
    setError(null);
    setFilter('');
    api.get(`/api/fs/browse?path=${encodeURIComponent(currentPath)}`)
      .then((r) => setListing(r))
      .catch((err) => { setListing({ folders: [], files: [], fileCount: 0 }); setError(err.message); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const shownFolders = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? listing.folders.filter((f) => f.name.toLowerCase().includes(q)) : listing.folders;
  }, [listing, filter]);
  const shownFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? listing.files.filter((f) => f.name.toLowerCase().includes(q)) : listing.files;
  }, [listing, filter]);

  function choose(path, name) {
    const selection = { provider: 'filesystem', path, name };
    setSelected(selection);
    onSelect(selection);
  }

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-700">{label}</h3>

      {/* ---- Empty state: no roots configured yet -------------------------- */}
      {rootsInfo && !root && rootsInfo.roots.length === 0 && (
        <div className="text-center py-6 space-y-2">
          <div className="text-3xl">🗄️</div>
          <div className="text-sm font-medium text-slate-700">No file shares configured yet</div>
          <p className="text-xs text-slate-500 max-w-xs mx-auto">
            Add the UNC paths of the shares this project may migrate from (e.g. <span className="font-mono">\\corp\dfs\Departments</span>) — takes a few seconds.
          </p>
          <Link to="/settings" className="inline-block text-xs font-medium text-white bg-violet-600 hover:bg-violet-700 rounded-md px-3 py-1.5 transition-colors">
            Add shares in Settings →
          </Link>
        </div>
      )}

      {/* ---- Root list ------------------------------------------------------ */}
      {rootsInfo && !root && rootsInfo.roots.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-slate-400 flex items-center justify-between">
            <span>{rootsInfo.roots.length} share{rootsInfo.roots.length === 1 ? '' : 's'} available to this project</span>
            <Link to="/settings" className="text-violet-600 hover:underline">manage</Link>
          </div>
          <ul className="max-h-72 overflow-y-auto space-y-1 text-sm pr-0.5">
            {rootsInfo.roots.map((r) => (
              <li key={r.path}>
                <button
                  onClick={() => { setRoot(r); setPathStack([]); }}
                  className="w-full text-left rounded-lg border border-slate-100 px-2.5 py-2 hover:border-violet-300 hover:bg-violet-50/40 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-7 h-7 rounded-md bg-violet-100 text-violet-700 flex items-center justify-center text-xs font-semibold shrink-0">
                      {(r.name || '?').slice(0, 1).toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-800 truncate">{r.name}</div>
                      <div className="text-xs text-slate-400 truncate font-mono">{r.path}</div>
                    </div>
                    <span className="text-slate-300 group-hover:text-violet-400 shrink-0">›</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---- Directory browser ---------------------------------------------- */}
      {root && (
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs flex-wrap bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5">
            <button onClick={() => { setRoot(null); setPathStack([]); }} className="text-slate-500 hover:text-slate-800" title="Back to shares">🗄️</button>
            <span className="text-slate-300">/</span>
            <button onClick={() => setPathStack([])} className="text-violet-700 hover:underline font-medium" title={root.path}>{root.name}</button>
            {pathStack.map((p, i) => (
              <React.Fragment key={p.path}>
                <span className="text-slate-300">/</span>
                <button onClick={() => setPathStack(pathStack.slice(0, i + 1))} className="text-violet-700 hover:underline">{p.name}</button>
              </React.Fragment>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter this folder…"
              className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm"
            />
            {filter && <button onClick={() => setFilter('')} className="text-xs text-slate-500 hover:underline">clear</button>}
          </div>

          <button
            onClick={() => choose(currentPath, currentName)}
            className="w-full text-left text-xs font-medium text-violet-700 bg-violet-50 rounded-md px-2 py-1.5 hover:bg-violet-100"
          >
            ⤷ Migrate this folder — <span className="font-mono">{currentPath}</span>
          </button>

          {error && <div className="text-xs rounded-md px-2 py-1.5 bg-red-50 border border-red-200 text-red-700">{error}</div>}

          <ul className="max-h-64 overflow-y-auto text-sm pr-0.5">
            {shownFolders.map((f) => (
              <li key={f.path} className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50">
                <button
                  onClick={() => setPathStack([...pathStack, { name: f.name, path: f.path }])}
                  className="flex-1 min-w-0 text-left flex items-center gap-2 font-medium text-slate-700"
                  title={f.path}
                >
                  <span className="shrink-0">📁</span>
                  <span className="truncate">{f.name}</span>
                  {f.childCount != null && <span className="text-slate-400 text-xs shrink-0">({f.childCount})</span>}
                </button>
                <button onClick={() => choose(f.path, f.name)} className="text-xs font-medium text-violet-700 opacity-0 group-hover:opacity-100 hover:underline shrink-0">
                  Select
                </button>
              </li>
            ))}
            {shownFiles.map((f) => (
              <li key={f.name} className="flex items-center gap-2 px-2 py-1.5 text-slate-500">
                <span className="shrink-0">{fileIcon(f.name)}</span>
                <span className="truncate flex-1 min-w-0">{f.name}</span>
                <span className="text-xs text-slate-400 tabular-nums shrink-0 w-16 text-right">{formatBytes(f.size)}</span>
                <span className="text-xs text-slate-400 tabular-nums shrink-0 w-20 text-right hidden md:inline">{formatDate(f.modified)}</span>
              </li>
            ))}
            {listing.fileListTruncated && !filter && (
              <li className="text-xs text-slate-400 px-2 py-1">
                …{(listing.fileCount - listing.files.length).toLocaleString()} more file(s) not shown — all are migrated, folders above are complete
              </li>
            )}
            {shownFolders.length === 0 && shownFiles.length === 0 && !loading && !error && (
              <li className="text-slate-400 text-xs px-2 py-3">{filter ? 'No matches in this folder.' : 'Empty folder.'}</li>
            )}
          </ul>
          {loading && <div className="text-xs text-slate-400">Loading…</div>}
        </div>
      )}

      {rootsInfo === null && <div className="text-xs text-slate-400">Loading shares…</div>}

      {selected && (
        <div className="text-xs bg-green-50 border border-green-200 text-green-800 rounded-md px-2 py-1.5">
          Selected folder: <span className="font-mono">{selected.path}</span>
        </div>
      )}
    </div>
  );
}
