import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

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

// Parses Graph's parentReference.path (e.g. "/drives/{id}/root:/Contracts/2023")
// into breadcrumb path segments, so a search result can be "jumped to" without
// re-walking the tree click by click.
function segmentsFromParentPath(path) {
  if (!path) return [];
  const marker = 'root:';
  const idx = path.indexOf(marker);
  if (idx === -1) return [];
  const rest = path.substring(idx + marker.length);
  return rest.split('/').filter(Boolean);
}

// A drive's display name (e.g. "Documents") is frequently NOT its real
// server-relative folder name (e.g. "Shared Documents") - SharePoint shows a
// friendly display name while the actual URL segment can differ per site
// template/language/history. The engine needs the real path: pulling it from
// drive.webUrl (relative to the site's own webUrl) instead of drive.name is
// what makes Get-PnPFolderItem/Resolve-PnPFolder/Copy-PnPFile hit the folder
// that actually exists, instead of silently enumerating nothing and then
// failing to create a rogue top-level folder with the display name.
function libraryRelativePathFromDrive(site, drive) {
  try {
    const sitePath = new URL(site.webUrl).pathname.replace(/\/+$/, '');
    const drivePath = new URL(drive.webUrl).pathname.replace(/\/+$/, '');
    const rel = drivePath.startsWith(sitePath) ? drivePath.slice(sitePath.length) : drivePath;
    return decodeURIComponent(rel.replace(/^\/+/, ''));
  } catch {
    return drive.name;
  }
}

// One instance is used for the source picker and, separately, for the target
// picker. `multi` (source only) enables ticking several folders/files at once
// - the parent receives { multi: true, items: [...] } and creates one mapping
// per item.
export default function SharePointPicker({ label, onSelect, multi = false }) {
  const { user } = useAuth();
  const [siteQuery, setSiteQuery] = useState('');
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState(null);
  const [drives, setDrives] = useState([]);
  const [drive, setDrive] = useState(null);
  const [pathStack, setPathStack] = useState([]); // [{id, name}]
  const [items, setItems] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchResults, setIsSearchResults] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [ticked, setTicked] = useState(new Map()); // id -> {type, path, name}
  const [grantStatus, setGrantStatus] = useState(null); // null | 'granting' | { ok, message }
  // 'checking' | { level: 'full' | 'partial' | 'none' | 'unknown', roles? }
  const [engineAccess, setEngineAccess] = useState(null);

  // Auto-detect sites immediately - no need to search first.
  useEffect(() => { loadSites(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!site) return;
    api.get(`/api/sharepoint/sites/${site.id}/drives`).then((r) => setDrives(r.items));
    checkEngineAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  useEffect(() => {
    if (!drive) return;
    loadFolder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive, pathStack]);

  // Answers "do I need to click Grant for this site?" by reading the site's
  // actual permission grants and looking for this project's engine identity
  // (exposed by /api/me). Grants are one-time per site+app; mappings and job
  // runs also auto-grant now, so this chip is informational.
  function checkEngineAccess() {
    const engineClientId = user?.project?.engine?.clientId;
    if (!engineClientId) { setEngineAccess({ level: 'unknown' }); return; }
    setEngineAccess('checking');
    api.get(`/api/sharepoint/sites/${site.id}/permissions`)
      .then((perms) => {
        const grant = (perms.value || []).find((p) =>
          (p.grantedToIdentitiesV2 || p.grantedToIdentities || []).some((g) => g.application?.id === engineClientId)
        );
        if (!grant) return setEngineAccess({ level: 'none' });
        const roles = grant.roles || [];
        setEngineAccess(roles.includes('fullcontrol') ? { level: 'full' } : { level: 'partial', roles });
      })
      .catch(() => setEngineAccess({ level: 'unknown' }));
  }

  async function grantEngineAccess() {
    setGrantStatus('granting');
    try {
      await api.post(`/api/sharepoint/sites/${site.id}/grant-engine-access`);
      setGrantStatus({ ok: true, message: 'Granted - the migration engine can now read/write this site.' });
      setEngineAccess({ level: 'full' });
    } catch (err) {
      setGrantStatus({ ok: false, message: err.message });
    }
  }

  function loadSites(q) {
    setLoading(true);
    api.get(`/api/sharepoint/sites${q ? `?search=${encodeURIComponent(q)}` : ''}`)
      .then((r) => setSites(r.items))
      .finally(() => setLoading(false));
  }

  function loadFolder() {
    setLoading(true);
    setIsSearchResults(false);
    const req = pathStack.length === 0
      ? api.get(`/api/sharepoint/drives/${drive.id}/root-children`)
      : api.get(`/api/sharepoint/drives/${drive.id}/items/${pathStack[pathStack.length - 1].id}/children`);
    req.then((r) => setItems(r.items)).finally(() => setLoading(false));
  }

  function runSearch() {
    if (!searchQuery.trim()) return loadFolder();
    setLoading(true);
    api.get(`/api/sharepoint/drives/${drive.id}/search?q=${encodeURIComponent(searchQuery)}`)
      .then((r) => { setItems(r.items); setIsSearchResults(true); })
      .finally(() => setLoading(false));
  }

  function jumpToSearchResult(item) {
    const segments = segmentsFromParentPath(item.parentReference?.path);
    // We don't have ids for intermediate segments from search alone, so we
    // jump straight to the item's own folder (or its parent, for a file) by id.
    if (item.folder) {
      setPathStack([...segments.map((name) => ({ id: null, name })), { id: item.id, name: item.name }]);
    } else {
      setPathStack(segments.map((name) => ({ id: null, name })));
    }
    setSearchQuery('');
  }

  function currentRelativePath() {
    return pathStack.map((p) => p.name).join('/');
  }

  function itemRelativePath(item) {
    // For search results the current breadcrumb doesn't apply - derive the
    // real path from the item's own parentReference instead.
    if (isSearchResults) {
      return [...segmentsFromParentPath(item.parentReference?.path), item.name].join('/');
    }
    return [...pathStack.map((p) => p.name), item.name].filter(Boolean).join('/');
  }

  function baseSelection() {
    return {
      siteUrl: site.webUrl,
      siteName: site.displayName || site.name,
      library: libraryRelativePathFromDrive(site, drive),
    };
  }

  function chooseSingle(type, item) {
    const selection = {
      ...baseSelection(),
      type,
      path: item ? itemRelativePath(item) : currentRelativePath(),
      name: item?.name || pathStack[pathStack.length - 1]?.name || drive.name,
    };
    setSelected(selection);
    setTicked(new Map());
    onSelect(selection);
  }

  function toggleTick(item) {
    setTicked((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, { type: item.folder ? 'folder' : 'file', path: itemRelativePath(item), name: item.name });
      return next;
    });
  }

  function confirmTicked() {
    const selection = { ...baseSelection(), multi: true, items: [...ticked.values()] };
    setSelected(selection);
    onSelect(selection);
  }

  const maxStorage = Math.max(1, ...sites.map((s) => s.storageUsed || 0));

  return (
    <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700">{label}</h3>
        {multi && ticked.size > 0 && (
          <span className="text-xs font-medium text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{ticked.size} ticked</span>
        )}
      </div>

      {/* ---- Site browser -------------------------------------------------- */}
      {!site && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              value={siteQuery}
              onChange={(e) => setSiteQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && loadSites(siteQuery)}
              placeholder="Filter sites…"
              className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm"
            />
            <button onClick={() => loadSites(siteQuery)} className="btn-secondary">Search</button>
          </div>
          <div className="text-xs text-slate-400">{loading ? 'Detecting sites…' : `${sites.length} site(s), largest first`}</div>
          <ul className="max-h-72 overflow-y-auto space-y-1 text-sm pr-0.5">
            {sites.map((s) => (
              <li key={s.id}>
                <button
                  onClick={() => setSite(s)}
                  className="w-full text-left rounded-lg border border-slate-100 px-2.5 py-2 hover:border-blue-300 hover:bg-blue-50/40 transition-colors"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="w-7 h-7 rounded-md bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold shrink-0">
                      {(s.displayName || s.name || '?').slice(0, 1).toUpperCase()}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-800 truncate">{s.displayName || s.name}</div>
                      <div className="text-xs text-slate-400 truncate">{s.webUrl?.replace(/^https?:\/\//, '')}</div>
                    </div>
                    <div className="text-right shrink-0 w-24">
                      {s.storageUsed != null ? (
                        <>
                          <div className="text-xs font-medium text-slate-600 tabular-nums">{formatBytes(s.storageUsed)}</div>
                          <div className="h-1 mt-1 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-blue-400 to-indigo-500 rounded-full" style={{ width: `${Math.max(3, (s.storageUsed / maxStorage) * 100)}%` }} />
                          </div>
                        </>
                      ) : (
                        <span className="text-xs text-slate-300">{s.inaccessible ? 'locked' : '—'}</span>
                      )}
                      {s.lastActivity && <div className="text-[10px] text-slate-400 mt-0.5">{formatDate(s.lastActivity)}</div>}
                    </div>
                  </div>
                </button>
              </li>
            ))}
            {sites.length === 0 && !loading && <li className="text-slate-400 text-xs px-2 py-3">No sites found.</li>}
          </ul>
        </div>
      )}

      {/* ---- Library list --------------------------------------------------- */}
      {site && !drive && (
        <div className="space-y-2">
          <div className="text-xs text-slate-500">
            Site: <span className="font-medium text-slate-700">{site.displayName || site.name}</span>{' '}
            <button onClick={() => { setSite(null); setDrives([]); setGrantStatus(null); setEngineAccess(null); }} className="text-blue-600 hover:underline">change</button>
          </div>
          {engineAccess === 'checking' && (
            <div className="inline-flex items-center gap-1.5 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-2 py-1">
              <span className="w-2 h-2 rounded-full bg-slate-300 animate-pulse" /> Checking engine access…
            </div>
          )}
          {engineAccess?.level === 'full' && (
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-green-800 bg-green-50 border border-green-200 rounded-md px-2 py-1">
              ✓ Migration engine has full access to this site.
            </div>
          )}
          {(engineAccess?.level === 'none' || engineAccess?.level === 'partial') && (
            <div className="inline-flex items-center gap-2 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
              ⚠ {engineAccess.level === 'none' ? 'Engine not granted here yet' : `Engine only has "${engineAccess.roles.join(', ')}"`} — auto-granted on save/run, or{' '}
              <button onClick={grantEngineAccess} disabled={grantStatus === 'granting'} className="underline font-semibold disabled:opacity-50">
                {grantStatus === 'granting' ? 'granting…' : 'grant now'}
              </button>
            </div>
          )}
          {grantStatus && grantStatus !== 'granting' && !grantStatus.ok && (
            <div className="text-xs rounded-md px-2 py-1.5 bg-red-50 border border-red-200 text-red-700">{grantStatus.message}</div>
          )}
          <ul className="divide-y divide-slate-100 text-sm">
            {drives.map((d) => {
              const isPHL = /preservation hold/i.test(d.name);
              return (
                <li key={d.id}>
                  <button onClick={() => { setDrive(d); setPathStack([]); }} className="w-full text-left px-2 py-2 hover:bg-slate-50 rounded flex items-center gap-2">
                    <span>{isPHL ? '🔒' : '🗂️'}</span>
                    <span className={`font-medium ${isPHL ? 'text-amber-700' : 'text-slate-700'}`}>{d.name}</span>
                    {d.sizeBytes != null && <span className="text-xs text-slate-400 tabular-nums ml-auto shrink-0">{formatBytes(d.sizeBytes)}</span>}
                  </button>
                  {isPHL && d.sizeBytes > 0 && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5 mb-1.5 mx-1">
                      ⚠ This library holds retention-policy copies of deleted/changed files — <span className="font-medium">deleting files elsewhere does not shrink it, and no tool can delete from it while the policy applies</span>. To reclaim this space, a compliance admin must exclude this site from its retention policy in Microsoft Purview (Data Lifecycle Management → Policies); Microsoft then clears it automatically within ~30 days.
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* ---- File explorer --------------------------------------------------- */}
      {site && drive && (
        <div className="space-y-2">
          <div className="flex items-center gap-1 text-xs flex-wrap bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5">
            <button onClick={() => { setDrive(null); setItems([]); setPathStack([]); }} className="text-slate-500 hover:text-slate-800" title="Back to libraries">🗂️</button>
            <span className="text-slate-300">/</span>
            <button onClick={() => setPathStack([])} className="text-blue-600 hover:underline font-medium">{drive.name}</button>
            {pathStack.map((p, i) => (
              <React.Fragment key={i}>
                <span className="text-slate-300">/</span>
                <button onClick={() => setPathStack(pathStack.slice(0, i + 1))} className="text-blue-600 hover:underline">{p.name}</button>
              </React.Fragment>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runSearch()}
              placeholder="Search this library…"
              className="flex-1 border border-slate-300 rounded-md px-2 py-1 text-sm"
            />
            <button onClick={runSearch} className="btn-secondary">Search</button>
            {isSearchResults && <button onClick={() => { setSearchQuery(''); loadFolder(); }} className="text-xs text-slate-500 hover:underline">clear</button>}
          </div>

          {!isSearchResults && (
            <button onClick={() => chooseSingle('folder', null)} className="w-full text-left text-xs font-medium text-blue-700 bg-blue-50 rounded-md px-2 py-1.5 hover:bg-blue-100">
              ⤷ Use current folder ({currentRelativePath() || 'library root'})
            </button>
          )}

          <ul className="max-h-64 overflow-y-auto text-sm pr-0.5">
            {items.map((item) => (
              <li key={item.id} className={`group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 ${ticked.has(item.id) ? 'bg-blue-50/60' : ''}`}>
                {multi && (
                  <input
                    type="checkbox"
                    checked={ticked.has(item.id)}
                    onChange={() => toggleTick(item)}
                    className="shrink-0 accent-blue-600"
                  />
                )}
                <button
                  onClick={() => (item.folder ? (isSearchResults ? jumpToSearchResult(item) : setPathStack([...pathStack, { id: item.id, name: item.name }])) : multi ? toggleTick(item) : null)}
                  className={`flex-1 min-w-0 text-left flex items-center gap-2 ${item.folder ? 'font-medium text-slate-700' : 'text-slate-600'}`}
                  title={item.name}
                >
                  <span className="shrink-0">{item.folder ? '📁' : fileIcon(item.name)}</span>
                  <span className="truncate">{item.name}</span>
                  {item.folder?.childCount != null && <span className="text-slate-400 text-xs shrink-0">({item.folder.childCount})</span>}
                </button>
                <span className="text-xs text-slate-400 tabular-nums shrink-0 w-16 text-right">{item.folder ? '' : formatBytes(item.size)}</span>
                <span className="text-xs text-slate-400 tabular-nums shrink-0 w-20 text-right hidden md:inline">{formatDate(item.lastModifiedDateTime)}</span>
                {!multi && (
                  <button onClick={() => chooseSingle(item.folder ? 'folder' : 'file', item)} className="text-xs font-medium text-blue-600 opacity-0 group-hover:opacity-100 hover:underline shrink-0">
                    Select
                  </button>
                )}
              </li>
            ))}
            {items.length === 0 && !loading && <li className="text-slate-400 text-xs px-2 py-3">{isSearchResults ? 'No matches.' : 'Empty folder.'}</li>}
          </ul>

          {multi && ticked.size > 0 && (
            <div className="flex items-center justify-between bg-blue-600 text-white rounded-md px-3 py-2">
              <span className="text-xs font-medium">{ticked.size} item(s) ticked across this library</span>
              <div className="space-x-2">
                <button onClick={() => setTicked(new Map())} className="text-xs opacity-80 hover:opacity-100 underline">clear</button>
                <button onClick={confirmTicked} className="text-xs font-semibold bg-white text-blue-700 rounded px-2.5 py-1 hover:bg-blue-50">
                  Use {ticked.size} selected
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {loading && site && <div className="text-xs text-slate-400">Loading…</div>}

      {selected && (
        <div className="text-xs bg-green-50 border border-green-200 text-green-800 rounded-md px-2 py-1.5">
          {selected.multi
            ? <>Selected <span className="font-semibold">{selected.items.length} item(s)</span> in {selected.library}: {selected.items.map((i) => i.name).join(', ')}</>
            : <>Selected {selected.type}: {selected.library}/{selected.path || ''}</>}
        </div>
      )}
    </div>
  );
}
