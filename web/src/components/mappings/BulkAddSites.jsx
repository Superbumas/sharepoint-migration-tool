import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import SharePointPicker, { libraryRelativePathFromDrive } from '../SharePointPicker';
import { cleanPath, expandPattern, joinPath, landingPath, mapLimit, pathProblem, sourceKey } from '../../lib/mappingPaths';

// What to take from each ticked site, and the target pattern that suits it.
const SCOPES = [
  {
    id: 'library',
    label: 'The whole document library',
    hint: 'One mapping per site. Everything in its main library goes straight into the target folder.',
    pattern: '{site}',
  },
  {
    id: 'folders',
    label: 'Each top-level folder',
    hint: 'One mapping per folder, which for a Team is one per channel. Files sitting loose at the top of the library are not included.',
    pattern: '{site}',
  },
  {
    id: 'all-libraries',
    label: 'Every library on the site',
    hint: 'One mapping per library, for sites that keep documents in more than one.',
    pattern: '{site}/{library}',
  },
];

const SAVE_CHUNK = 25;

function isHoldLibrary(drive) {
  return /preservation hold/i.test(drive.name || '');
}

// The library people mean by "the site's documents": Graph calls it
// "Documents" on English sites; otherwise the first real library.
function mainLibrary(drives) {
  const real = drives.filter((d) => !isHoldLibrary(d));
  return real.find((d) => d.name === 'Documents') || real[0] || null;
}

// Builds many mappings in one pass: tick the source sites, say what to take
// from each, pick one target and a folder pattern, check the preview, save.
// Made for consolidations - dozens of Teams or group sites folded into one
// hub - where doing each mapping by hand means the same clicks forty times.
export default function BulkAddSites({ existingMappings, group, onSaved }) {
  const [siteQuery, setSiteQuery] = useState('');
  const [sites, setSites] = useState([]);
  const [loadingSites, setLoadingSites] = useState(false);
  const [sitesError, setSitesError] = useState(null);
  const [ticked, setTicked] = useState(new Map()); // site id -> site
  const [scope, setScope] = useState('library');
  const [target, setTarget] = useState(null);
  const [pattern, setPattern] = useState('{site}');
  const [patternEdited, setPatternEdited] = useState(false);
  const [rows, setRows] = useState(null); // null = no preview built yet
  const [progress, setProgress] = useState(null); // { done, total } while reading sites
  const [readErrors, setReadErrors] = useState([]);
  const [saving, setSaving] = useState(null); // { done, total }
  const [result, setResult] = useState(null);

  function loadSites(q) {
    setLoadingSites(true);
    setSitesError(null);
    api.get(`/api/sharepoint/sites${q ? `?search=${encodeURIComponent(q)}` : ''}`)
      .then((r) => setSites(r.items))
      .catch((err) => { setSites([]); setSitesError(err.message); })
      .finally(() => setLoadingSites(false));
  }
  useEffect(() => { loadSites(''); }, []);

  // Typing narrows the loaded list at once; Search asks the server, which
  // also finds sites beyond the first page.
  const shown = useMemo(() => {
    const q = siteQuery.trim().toLowerCase();
    if (!q) return sites;
    const hits = sites.filter((s) => `${s.displayName || s.name || ''} ${s.webUrl || ''}`.toLowerCase().includes(q));
    return hits.length > 0 ? hits : sites;
  }, [sites, siteQuery]);
  const tickable = shown.filter((s) => s.id && !s.noAccess);
  const allShownTicked = tickable.length > 0 && tickable.every((s) => ticked.has(s.id));

  function invalidatePreview() {
    setRows(null);
    setReadErrors([]);
    setResult(null);
  }

  function toggleSite(site) {
    const next = new Map(ticked);
    if (next.has(site.id)) next.delete(site.id); else next.set(site.id, site);
    setTicked(next);
    invalidatePreview();
  }

  function toggleAllShown() {
    const next = new Map(ticked);
    for (const s of tickable) {
      if (allShownTicked) next.delete(s.id); else next.set(s.id, s);
    }
    setTicked(next);
    invalidatePreview();
  }

  function chooseScope(id) {
    setScope(id);
    if (!patternEdited) setPattern(SCOPES.find((s) => s.id === id).pattern);
    invalidatePreview();
  }

  const existingSources = useMemo(() => new Set(
    existingMappings
      .filter((m) => (m.sourceProvider || 'sharepoint') === 'sharepoint')
      .map((m) => sourceKey(m.sourceSiteUrl, m.sourceLibrary, m.sourcePath))
  ), [existingMappings]);

  async function buildPreview() {
    const picked = [...ticked.values()];
    setProgress({ done: 0, total: picked.length });
    setReadErrors([]);
    setResult(null);
    let done = 0;
    const errors = [];
    const perSite = await mapLimit(picked, 4, async (site) => {
      const siteName = site.displayName || site.name;
      const out = [];
      try {
        const drives = (await api.get(`/api/sharepoint/sites/${site.id}/drives`)).items || [];
        const libraries = scope === 'all-libraries' ? drives.filter((d) => !isHoldLibrary(d)) : [mainLibrary(drives)].filter(Boolean);
        if (libraries.length === 0) throw new Error('no document library found');
        for (const drive of libraries) {
          const library = libraryRelativePathFromDrive(site, drive);
          const base = { siteUrl: site.webUrl, siteName, library, libraryName: drive.name };
          if (scope === 'folders') {
            const children = (await api.get(`/api/sharepoint/drives/${drive.id}/root-children`)).items || [];
            const folders = children.filter((c) => c.folder);
            if (folders.length === 0) errors.push({ site: siteName, message: 'has no folders at the top of its library, so nothing was added for it' });
            for (const f of folders) out.push({ ...base, sourcePath: f.name, folderName: f.name });
          } else {
            out.push({ ...base, sourcePath: '', folderName: '' });
          }
        }
      } catch (err) {
        errors.push({ site: siteName, message: err.message });
      }
      done += 1;
      setProgress({ done, total: picked.length });
      return out;
    });
    const built = perSite.flat().map((r, i) => {
      const alreadyMapped = existingSources.has(sourceKey(r.siteUrl, r.library, r.sourcePath));
      return { ...r, key: `${i}`, include: !alreadyMapped, alreadyMapped, override: null };
    });
    setRows(built);
    setReadErrors(errors);
    setProgress(null);
  }

  // A row's target folder: what was typed for that row, else the pattern.
  function targetPathOf(row) {
    if (row.override != null) return cleanPath(row.override);
    return joinPath(target?.path, expandPattern(pattern, { site: row.siteName, library: row.libraryName, folder: row.folderName }));
  }

  function updateRow(key, patch) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const included = (rows || []).filter((r) => r.include);

  // Two rows landing in one folder is sometimes wanted (merging) and often a
  // pattern with no {site} in it, so it is flagged, not blocked.
  const landingCounts = useMemo(() => {
    const counts = new Map();
    for (const r of included) {
      const k = landingPath(targetPathOf(r), r.sourcePath).toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return counts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, pattern, target]);

  const invalidCount = included.filter((r) => pathProblem(targetPathOf(r))).length;
  const sharedCount = included.filter((r) => landingCounts.get(landingPath(targetPathOf(r), r.sourcePath).toLowerCase()) > 1).length;

  async function save() {
    const items = included.map((r) => ({
      sourceType: 'folder',
      sourceSiteUrl: r.siteUrl,
      sourceSiteName: r.siteName,
      sourceLibrary: r.library,
      sourcePath: r.sourcePath,
      targetType: 'folder',
      targetSiteUrl: target.siteUrl,
      targetSiteName: target.siteName,
      targetLibrary: target.library,
      targetPath: targetPathOf(r),
      action: 'Migrate',
      group: group || undefined,
    }));
    setSaving({ done: 0, total: items.length });
    setResult(null);
    let saved = 0;
    const failed = [];
    const grants = [];
    try {
      for (let i = 0; i < items.length; i += SAVE_CHUNK) {
        const chunk = items.slice(i, i + SAVE_CHUNK);
        const r = await api.post('/api/mappings/bulk', { items: chunk });
        saved += r.items.length;
        failed.push(...r.failed.map((f) => ({ ...f, row: included[i + f.index] })));
        grants.push(...(r.engineAccess || []));
        setSaving({ done: Math.min(i + SAVE_CHUNK, items.length), total: items.length });
      }
      const noAccess = [...new Set(grants.filter((g) => !g.ok).map((g) => g.siteUrl))];
      setResult({ saved, failed, noAccess });
      if (saved > 0) {
        setTicked(new Map());
        setRows(null);
        setReadErrors([]);
      }
    } catch (err) {
      setResult({ saved, failed, noAccess: [], error: err.message });
    } finally {
      setSaving(null);
      onSaved();
    }
  }

  const example = rows && rows[0] ? rows[0] : { siteName: 'Finance Team', libraryName: 'Documents', folderName: scope === 'folders' ? 'General' : '', sourcePath: scope === 'folders' ? 'General' : '' };
  const exampleLanding = landingPath(
    joinPath(target?.path, expandPattern(pattern, { site: example.siteName, library: example.libraryName, folder: example.folderName })),
    example.sourcePath
  );
  const maxStorage = Math.max(1, ...sites.map((s) => s.storageUsed || 0));

  return (
    <div className="space-y-5">
      {/* ---- 1. Sources ---------------------------------------------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">1. Tick the sites to bring across</h3>
        <div className="flex gap-2">
          <input
            value={siteQuery}
            onChange={(e) => setSiteQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && loadSites(siteQuery)}
            placeholder="Filter sites, or search by name…"
            aria-label="Filter sites, or search by name"
            type="search"
            autoComplete="off"
            className="flex-1 min-w-0 border border-slate-300 rounded-md px-2 py-1 text-sm"
          />
          <button onClick={() => loadSites(siteQuery)} className="btn-secondary">Search</button>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span>{loadingSites ? 'Loading sites…' : `${shown.length} site(s) shown`}</span>
          {tickable.length > 0 && (
            <button onClick={toggleAllShown} className="text-blue-600 hover:underline">
              {allShownTicked ? 'Untick all shown' : `Tick all ${tickable.length} shown`}
            </button>
          )}
          {ticked.size > 0 && (
            <>
              <span className="font-medium text-blue-700 bg-blue-50 rounded-full px-2 py-0.5">{ticked.size} ticked</span>
              <button onClick={() => { setTicked(new Map()); invalidatePreview(); }} className="text-slate-500 hover:underline">clear</button>
            </>
          )}
        </div>
        <ul className="max-h-64 overflow-y-auto border border-slate-200 rounded-md divide-y divide-slate-100 text-sm">
          {shown.map((s) => {
            const disabled = !s.id || s.noAccess;
            return (
              <li key={s.id || s.webUrl}>
                <label className={`flex items-center gap-2.5 px-2.5 py-1.5 ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-slate-50'} ${ticked.has(s.id) ? 'bg-blue-50' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={!!s.id && ticked.has(s.id)}
                    onChange={() => toggleSite(s)}
                    className="shrink-0 accent-blue-600"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium text-slate-800 truncate">{s.displayName || s.name}</span>
                    <span className="block text-xs text-slate-400 truncate">{s.webUrl?.replace(/^https?:\/\//, '')}</span>
                  </span>
                  {s.noAccess && <span className="text-xs font-medium text-amber-700 shrink-0">no access</span>}
                  {s.storageUsed != null && (
                    <span className="shrink-0 w-24 text-right">
                      <span className="block text-xs font-medium text-slate-600 tabular-nums">{formatBytes(s.storageUsed)}</span>
                      <span className="block h-1 mt-1 bg-slate-100 rounded-full overflow-hidden">
                        <span className="block h-full bg-blue-500 rounded-full" style={{ width: `${Math.max(3, (s.storageUsed / maxStorage) * 100)}%` }} />
                      </span>
                    </span>
                  )}
                </label>
              </li>
            );
          })}
          {sitesError && !loadingSites && <li role="alert" className="text-red-600 text-xs px-2.5 py-3">Couldn't load sites: {sitesError}</li>}
          {shown.length === 0 && !loadingSites && !sitesError && <li className="text-slate-400 text-xs px-2.5 py-3">No sites found. Try a different name, or paste the site's URL.</li>}
        </ul>
        <p className="text-xs text-slate-400">Ticks are kept while you search, so you can gather sites from several searches.</p>
      </section>

      {/* ---- 2. What to take ----------------------------------------------- */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">2. From each site, take</h3>
        <div className="grid md:grid-cols-3 gap-2">
          {SCOPES.map((s) => (
            <label key={s.id} className={`flex gap-2 border rounded-md px-3 py-2 cursor-pointer ${scope === s.id ? 'border-blue-300 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}>
              <input type="radio" name="bulk-scope" checked={scope === s.id} onChange={() => chooseScope(s.id)} className="mt-0.5 accent-blue-600" />
              <span>
                <span className="block text-sm font-medium text-slate-800">{s.label}</span>
                <span className="block text-xs text-slate-500">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ---- 3. Target ------------------------------------------------------ */}
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-700">3. Choose where it all goes</h3>
        <div className="grid md:grid-cols-2 gap-4 [&>*]:min-w-0">
          <SharePointPicker label="Target folder" onSelect={(t) => { setTarget(t); setResult(null); }} allowCreateFolder />
          <div className="space-y-2">
            <label htmlFor="bulk-pattern" className="block text-sm font-medium text-slate-700">Folder for each one, inside the target</label>
            <input
              id="bulk-pattern"
              value={pattern}
              onChange={(e) => { setPattern(e.target.value); setPatternEdited(true); }}
              placeholder="{site}"
              autoComplete="off"
              spellCheck={false}
              className="w-full border border-slate-300 rounded-md px-2 py-1 text-sm font-mono"
            />
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span>Insert:</span>
              {['{site}', '{library}', ...(scope === 'folders' ? ['{folder}'] : [])].map((tok) => (
                <button key={tok} onClick={() => { setPattern((p) => `${p}${p && !p.endsWith('/') ? '/' : ''}${tok}`); setPatternEdited(true); }} className="font-mono rounded bg-slate-100 text-slate-700 px-1.5 py-0.5 hover:bg-slate-200">
                  {tok}
                </button>
              ))}
            </div>
            <p className="text-xs text-slate-500">
              Leave it empty to put everything directly in the target folder. A folder that doesn't exist yet is created when the job runs.
            </p>
            <div className="text-xs bg-slate-50 border border-slate-200 rounded-md px-2 py-1.5 text-slate-600">
              Example: <span className="font-medium">{example.siteName}</span>
              {example.sourcePath ? <> › {example.sourcePath}</> : null} lands in{' '}
              <span className="font-medium text-slate-800">{target ? `${target.library}/` : '(target)/'}{exampleLanding}</span>
            </div>
          </div>
        </div>
      </section>

      {/* ---- 4. Preview ------------------------------------------------------ */}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-700">4. Check and add</h3>
          <button onClick={buildPreview} disabled={ticked.size === 0 || !target || !!progress || !!saving} className={rows ? 'btn-secondary' : 'btn-primary'}>
            {progress ? `Reading sites ${progress.done}/${progress.total}…` : rows ? 'Rebuild preview' : `Preview ${ticked.size || ''} site${ticked.size === 1 ? '' : 's'}`.replace('  ', ' ')}
          </button>
          {(ticked.size === 0 || !target) && !rows && (
            <span className="text-xs text-slate-400">{ticked.size === 0 ? 'Tick at least one site.' : 'Choose the target folder (open it, then "Use current folder").'}</span>
          )}
        </div>

        {readErrors.length > 0 && (
          <div role="alert" className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-md px-2.5 py-2 space-y-0.5">
            {readErrors.map((e, i) => <div key={i}><span className="font-medium">{e.site}</span>: {e.message}</div>)}
          </div>
        )}

        {rows && rows.length > 0 && (
          <>
            <div className="border border-slate-200 rounded-md overflow-hidden">
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase tracking-wide sticky top-0">
                    <tr>
                      <th className="px-3 py-2 w-8">
                        <input
                          type="checkbox"
                          aria-label="Include all rows"
                          checked={rows.every((r) => r.include)}
                          onChange={(e) => setRows(rows.map((r) => ({ ...r, include: e.target.checked })))}
                          className="accent-blue-600"
                        />
                      </th>
                      <th className="text-left px-3 py-2">Source</th>
                      <th className="text-left px-3 py-2">Target folder in {target?.siteName} › {target?.library}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r) => {
                      const targetPath = targetPathOf(r);
                      const problem = r.include ? pathProblem(targetPath) : null;
                      const shared = r.include && landingCounts.get(landingPath(targetPath, r.sourcePath).toLowerCase()) > 1;
                      return (
                        <tr key={r.key} className={r.include ? '' : 'opacity-50'}>
                          <td className="px-3 py-1.5">
                            <input type="checkbox" aria-label={`Include ${r.siteName} ${r.sourcePath}`} checked={r.include} onChange={(e) => updateRow(r.key, { include: e.target.checked })} className="accent-blue-600" />
                          </td>
                          <td className="px-3 py-1.5 text-slate-700">
                            <span className="text-slate-500">{r.siteName} <span className="text-slate-300">›</span> </span>
                            {r.libraryName}{r.sourcePath ? `/${r.sourcePath}` : ''}
                            {r.alreadyMapped && <span className="ml-2 text-xs rounded-full border border-amber-300 text-amber-700 px-1.5 py-0.5 whitespace-nowrap">already mapped</span>}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1.5">
                              <input
                                value={r.override != null ? r.override : targetPath}
                                onChange={(e) => updateRow(r.key, { override: e.target.value })}
                                aria-label={`Target folder for ${r.siteName} ${r.sourcePath}`}
                                aria-invalid={!!problem}
                                placeholder="(top of the library)"
                                autoComplete="off"
                                spellCheck={false}
                                className={`flex-1 min-w-0 border rounded px-1.5 py-0.5 text-sm ${problem ? 'border-red-300' : 'border-slate-300'}`}
                              />
                              {r.sourcePath && <span className="text-slate-400 text-xs whitespace-nowrap" title="The source folder is recreated inside the target folder">/ {r.sourcePath}</span>}
                              {r.override != null && (
                                <button onClick={() => updateRow(r.key, { override: null })} className="text-xs text-blue-600 hover:underline whitespace-nowrap" title="Go back to the pattern">reset</button>
                              )}
                            </div>
                            {problem && <div className="text-xs text-red-600 mt-0.5">{problem}</div>}
                            {!problem && shared && <div className="text-xs text-amber-700 mt-0.5">Lands in the same folder as another row, so their contents merge.</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={save} disabled={included.length === 0 || invalidCount > 0 || !!saving || !target} className="btn-primary">
                {saving ? `Adding ${saving.done}/${saving.total}…` : `Add ${included.length} mapping${included.length === 1 ? '' : 's'}${group ? ` to "${group}"` : ''}`}
              </button>
              <span className="text-xs text-slate-500">
                {included.length} of {rows.length} rows included
                {sharedCount > 0 && <span className="text-amber-700"> · {sharedCount} share a folder</span>}
                {invalidCount > 0 && <span className="text-red-600"> · {invalidCount} need fixing</span>}
              </span>
            </div>
          </>
        )}
        {rows && rows.length === 0 && <div className="text-sm text-slate-500">Nothing to add from the ticked sites.</div>}

        {result && (
          <div role={result.error || result.failed.length > 0 ? 'alert' : 'status'} className={`text-sm rounded-md p-2 border space-y-1 ${result.error || result.failed.length > 0 ? 'bg-red-50 text-red-700 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
            <div>
              {result.saved} mapping{result.saved === 1 ? '' : 's'} added{group ? ` to "${group}"` : ''}.
              {result.error && ` Then it stopped: ${result.error}`}
            </div>
            {result.failed.map((f, i) => (
              <div key={i} className="text-xs">{f.row ? `${f.row.siteName} ${f.row.sourcePath}` : `Row ${f.index + 1}`}: {f.message}</div>
            ))}
            {result.noAccess.length > 0 && (
              <div className="text-xs text-amber-800">
                Engine access could not be granted automatically on {result.noAccess.length} site(s): {result.noAccess.join(', ')}. It is tried again when the job runs.
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
