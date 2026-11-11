import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { cleanPath, joinPath, pathProblem } from '../../lib/mappingPaths';

const NO_GROUP = '\u0000none';

// Human label for a mapping's SharePoint site: the picker-provided display
// name when there is one, else the last URL segment ("/sites/Hub" -> "Hub").
// Crosswalk-imported rows only have the URL, so the fallback matters.
function siteLabel(siteName, siteUrl) {
  if (siteName) return siteName;
  if (!siteUrl) return '';
  try {
    return decodeURIComponent(new URL(siteUrl).pathname.split('/').filter(Boolean).pop() || siteUrl);
  } catch {
    return siteUrl;
  }
}

// One of four buckets the filter chips work on.
function bucketOf(m) {
  const job = m.latestJob;
  if (!job) return 'new';
  if (['queued', 'approved', 'running', 'paused'].includes(job.status)) return 'active';
  if (job.status === 'completed' && !(job.itemsFailed > 0) && job.verificationOk !== false) return 'done';
  return 'attention';
}

const BUCKETS = [
  { id: 'all', label: 'All' },
  { id: 'new', label: 'Not migrated' },
  { id: 'active', label: 'In progress' },
  { id: 'done', label: 'Migrated' },
  { id: 'attention', label: 'Needs attention' },
];

// Only a SharePoint target with no job yet can be re-pointed (the server
// enforces the same rule).
function targetEditable(m) {
  return !m.latestJob && (m.targetProvider || 'sharepoint') === 'sharepoint';
}

// Status badge for a mapping's most recent job. Completed jobs distinguish
// verified-clean from completed-with-issues so "done" actually means done.
function MappingStatus({ job }) {
  if (!job) return <span className="inline-block whitespace-nowrap text-xs rounded-full px-2 py-0.5 bg-slate-100 text-slate-500">not migrated</span>;
  const label = (text, cls) => (
    <Link to={`/jobs/${job.id}`} className={`inline-block whitespace-nowrap text-xs rounded-full px-2 py-0.5 hover:opacity-80 ${cls}`} title={job.completedAt ? `Last run finished ${job.completedAt}` : 'Open latest job'}>
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

// A checkbox that can show "some but not all" - React has no prop for it.
function TriCheckbox({ checked, indeterminate, ...rest }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !checked && indeterminate; }, [checked, indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} className="accent-blue-600" {...rest} />;
}

function searchText(m) {
  return [
    m.sourceSiteName, m.sourceSiteUrl, m.sourceLibrary, m.sourcePath,
    m.targetSiteName, m.targetSiteUrl, m.targetLibrary, m.targetPath,
    m.targetContainer, m.targetBlobPrefix, m.targetOnedriveUpn, m.targetOnedrivePath,
    m.group, m.notes,
  ].filter(Boolean).join(' ').toLowerCase();
}

// The saved mappings as a working grid: search and filter, grouped by
// project, with the target folder editable in place and the usual bulk
// actions on whatever is ticked.
export default function MappingsGrid({ mappings, groupNames, refresh }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [bucket, setBucket] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [collapsed, setCollapsed] = useState(new Set());
  const [editing, setEditing] = useState(null); // { id, value, error }
  const [renaming, setRenaming] = useState(null); // { group, value }
  const [panel, setPanel] = useState(null); // null | 'project' | 'target'
  const [projectValue, setProjectValue] = useState('');
  const [targetMode, setTargetMode] = useState('replace'); // 'replace' | 'prefix' | 'set'
  const [findText, setFindText] = useState('');
  const [newText, setNewText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  // Drop ticks for rows that no longer exist (deleted here or elsewhere).
  useEffect(() => {
    setSelectedIds((prev) => {
      const ids = new Set(mappings.map((m) => m.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [mappings]);

  const counts = useMemo(() => {
    const c = { all: mappings.length, new: 0, active: 0, done: 0, attention: 0 };
    for (const m of mappings) c[bucketOf(m)] += 1;
    return c;
  }, [mappings]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return mappings.filter((m) => (bucket === 'all' || bucketOf(m) === bucket) && (!q || searchText(m).includes(q)));
  }, [mappings, query, bucket]);

  const hasGroups = mappings.some((m) => m.group);
  const sections = useMemo(() => {
    if (!hasGroups) return [{ key: NO_GROUP, name: null, rows: filtered }];
    const byGroup = new Map();
    for (const m of filtered) {
      const key = m.group || NO_GROUP;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(m);
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => (a === NO_GROUP) - (b === NO_GROUP) || a.localeCompare(b))
      .map(([key, rows]) => ({ key, name: key === NO_GROUP ? null : key, rows }));
  }, [filtered, hasGroups]);

  const selected = mappings.filter((m) => selectedIds.has(m.id));
  const selectedEditable = selected.filter(targetEditable);
  const allFilteredTicked = filtered.length > 0 && filtered.every((m) => selectedIds.has(m.id));
  const someFilteredTicked = filtered.some((m) => selectedIds.has(m.id));

  function setTicked(rows, on) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const m of rows) { if (on) next.add(m.id); else next.delete(m.id); }
      return next;
    });
  }

  function toggleCollapsed(key) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // Every action below reports into the grid's own message line; a failed
  // request must never leave a button that silently did nothing.
  async function run(work) {
    setMessage(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  function createJob(mappingId) {
    return run(async () => {
      const job = await api.post(`/api/mappings/${mappingId}/jobs`);
      navigate(`/jobs/${job.id}`);
    });
  }

  // mode: 'create' | 'approve' | 'run'. 'run' also sends the new jobs to the
  // run queue, which starts a few at a time.
  function bulkCreateJobs(mode) {
    if (mode === 'run' && !confirm(`Create, approve and run jobs for ${selected.length} mapping${selected.length === 1 ? '' : 's'}? They run a few at a time, and the rest start on their own as each one finishes.`)) return null;
    return run(async () => {
      const r = await api.post('/api/jobs/bulk-create', { mappingIds: [...selectedIds], approve: mode !== 'create', run: mode === 'run' });
      if (r.items.length === 0) {
        setMessage({ type: 'error', text: 'No jobs were created: every selected mapping already has an unfinished job.' });
        return;
      }
      setSelectedIds(new Set());
      navigate('/jobs');
    });
  }

  function duplicate(m) {
    return run(async () => {
      const r = await api.post('/api/mappings/bulk', {
        items: [{
          sourceType: m.sourceType, sourceProvider: m.sourceProvider, sourceSiteUrl: m.sourceSiteUrl, sourceSiteName: m.sourceSiteName,
          sourceLibrary: m.sourceLibrary, sourcePath: m.sourcePath,
          targetType: m.targetType, targetProvider: m.targetProvider, targetSiteUrl: m.targetSiteUrl, targetSiteName: m.targetSiteName,
          targetLibrary: m.targetLibrary, targetPath: m.targetPath,
          targetContainer: m.targetContainer, targetBlobPrefix: m.targetBlobPrefix,
          targetOnedriveUpn: m.targetOnedriveUpn, targetOnedrivePath: m.targetOnedrivePath,
          action: 'Migrate', notes: m.notes, group: m.group,
        }],
      });
      if (r.failed.length > 0) throw new Error(r.failed[0].message);
      await refresh();
      const copy = r.items[0];
      setMessage({ type: 'success', text: 'Duplicated. The copy has no job yet, so its target can be edited.' });
      if (copy && targetEditable(copy)) setEditing({ id: copy.id, value: copy.targetPath || '', error: null });
    });
  }

  function removeOne(m) {
    if (!confirm('Delete this mapping? Nothing in SharePoint is touched.')) return null;
    return run(async () => {
      await api.del(`/api/mappings/${m.id}`);
      await refresh();
    });
  }

  function removeSelected() {
    const deletable = selected.filter((m) => !m.latestJob).length;
    if (deletable === 0) {
      setMessage({ type: 'error', text: 'None of the selected mappings can be deleted: they all have jobs.' });
      return null;
    }
    if (!confirm(`Delete ${deletable} mapping${deletable === 1 ? '' : 's'}? Nothing in SharePoint is touched.`)) return null;
    return run(async () => {
      const r = await api.post('/api/mappings/bulk-delete', { ids: [...selectedIds] });
      await refresh();
      setMessage({
        type: 'success',
        text: `${r.deleted} mapping${r.deleted === 1 ? '' : 's'} deleted.${r.skippedInUse > 0 ? ` ${r.skippedInUse} kept because they already have jobs.` : ''}`,
      });
    });
  }

  function saveEdit() {
    if (!editing || busy) return null;
    const original = mappings.find((m) => m.id === editing.id);
    const value = cleanPath(editing.value);
    if (!original || value === cleanPath(original.targetPath)) { setEditing(null); return null; }
    const problem = pathProblem(value);
    if (problem) { setEditing({ ...editing, error: problem }); return null; }
    return run(async () => {
      try {
        await api.patch(`/api/mappings/${editing.id}`, { targetPath: value });
        setEditing(null);
        await refresh();
      } catch (err) {
        setEditing({ ...editing, error: err.message });
      }
    });
  }

  function renameGroup() {
    if (!renaming) return null;
    const name = renaming.value.replace(/\s+/g, ' ').trim();
    if (name === renaming.group) { setRenaming(null); return null; }
    const ids = mappings.filter((m) => m.group === renaming.group).map((m) => m.id);
    return run(async () => {
      await api.post('/api/mappings/bulk-update', { updates: ids.map((id) => ({ id, group: name })) });
      setRenaming(null);
      await refresh();
    });
  }

  function moveToProject() {
    const name = projectValue.replace(/\s+/g, ' ').trim();
    return run(async () => {
      const r = await api.post('/api/mappings/bulk-update', { updates: [...selectedIds].map((id) => ({ id, group: name })) });
      await refresh();
      setPanel(null);
      setProjectValue('');
      setMessage({
        type: r.failed.length > 0 ? 'error' : 'success',
        text: name ? `${r.updatedCount} mapping${r.updatedCount === 1 ? '' : 's'} moved to "${name}".` : `${r.updatedCount} mapping${r.updatedCount === 1 ? '' : 's'} taken out of their project.`,
      });
    });
  }

  // The new target folder a bulk change gives one mapping.
  function changedPath(m) {
    const old = cleanPath(m.targetPath);
    if (targetMode === 'replace') return findText ? cleanPath(old.split(findText).join(newText)) : old;
    if (targetMode === 'prefix') return joinPath(newText, old);
    return cleanPath(newText);
  }
  const targetChanges = panel === 'target'
    ? selectedEditable.map((m) => ({ m, next: changedPath(m) })).filter((c) => c.next !== cleanPath(c.m.targetPath))
    : [];
  const targetProblem = targetChanges.map((c) => pathProblem(c.next)).find(Boolean) || null;

  function applyTargetChange() {
    return run(async () => {
      const r = await api.post('/api/mappings/bulk-update', { updates: targetChanges.map((c) => ({ id: c.m.id, targetPath: c.next })) });
      await refresh();
      setPanel(null);
      setFindText('');
      setNewText('');
      setMessage({
        type: r.failed.length > 0 ? 'error' : 'success',
        text: `${r.updatedCount} target folder${r.updatedCount === 1 ? '' : 's'} changed.${r.failed.length > 0 ? ` ${r.failed.length} failed: ${r.failed[0].message}` : ''}`,
      });
    });
  }

  function renderRow(m) {
    const active = m.latestJob && ['queued', 'approved', 'running', 'paused'].includes(m.latestJob.status);
    const isEditing = editing?.id === m.id;
    return (
      <tr key={m.id} className={`hover:bg-slate-50 ${selectedIds.has(m.id) ? 'bg-blue-50' : ''}`}>
        <td className="px-4 py-2">
          <input type="checkbox" checked={selectedIds.has(m.id)} onChange={(e) => setTicked([m], e.target.checked)} aria-label="Select mapping" className="accent-blue-600" />
        </td>
        <td className="px-4 py-2 text-slate-700">
          {m.sourceProvider === 'filesystem'
            ? <span className="inline-flex items-center gap-1"><span className="text-xs rounded bg-violet-100 text-violet-700 px-1.5 py-0.5 font-medium">share</span>{m.sourcePath}</span>
            : (
              <span title={m.sourceSiteUrl || undefined}>
                {siteLabel(m.sourceSiteName, m.sourceSiteUrl) && (
                  <span className="text-slate-400">{siteLabel(m.sourceSiteName, m.sourceSiteUrl)} <span className="text-slate-300">›</span> </span>
                )}
                {m.sourceLibrary}/{m.sourcePath}
              </span>
            )}
          {m.notes && <div className="text-xs text-slate-400 truncate max-w-xs" title={m.notes}>{m.notes}</div>}
        </td>
        <td className="px-4 py-2 text-slate-700">
          <span className="text-slate-300 mr-1.5">→</span>
          {m.targetProvider === 'azure_blob' ? (
            <span className="inline-flex items-center gap-1"><span className="text-xs rounded bg-sky-100 text-sky-700 px-1.5 py-0.5 font-medium">blob</span>{m.targetContainer}/{m.targetBlobPrefix || ''}</span>
          ) : m.targetProvider === 'onedrive' ? (
            <span className="inline-flex items-center gap-1"><span className="text-xs rounded bg-sky-100 text-sky-700 px-1.5 py-0.5 font-medium">OneDrive</span>{m.targetOnedriveUpn}/{m.targetOnedrivePath || ''}</span>
          ) : (
            <span title={m.targetSiteUrl || undefined}>
              {siteLabel(m.targetSiteName, m.targetSiteUrl) && (
                <span className="text-slate-500 font-medium">{siteLabel(m.targetSiteName, m.targetSiteUrl)} <span className="text-slate-300 font-normal">›</span> </span>
              )}
              {m.targetLibrary}/
              {isEditing ? (
                <span className="inline-block align-middle">
                  <input
                    autoFocus
                    value={editing.value}
                    onChange={(e) => setEditing({ ...editing, value: e.target.value, error: null })}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(null); }}
                    onBlur={saveEdit}
                    aria-label="Target folder"
                    aria-invalid={!!editing.error}
                    placeholder="(top of the library)"
                    autoComplete="off"
                    spellCheck={false}
                    className={`w-64 border rounded px-1.5 py-0.5 text-sm ${editing.error ? 'border-red-300' : 'border-slate-300'}`}
                  />
                  {editing.error && <span role="alert" className="block text-xs text-red-600">{editing.error}</span>}
                </span>
              ) : targetEditable(m) ? (
                <button onClick={() => setEditing({ id: m.id, value: m.targetPath || '', error: null })} className="group/edit text-left hover:text-blue-700" title="Edit the target folder">
                  {m.targetPath || <span className="text-slate-400">(top of the library)</span>}
                  <span className="ml-1 text-xs text-blue-600 opacity-60 group-hover/edit:opacity-100" aria-hidden>✎</span>
                </button>
              ) : (
                m.targetPath
              )}
            </span>
          )}
        </td>
        <td className="px-4 py-2"><MappingStatus job={m.latestJob} /></td>
        <td className="px-4 py-2 text-right whitespace-nowrap">
          <button onClick={() => duplicate(m)} disabled={busy} className="text-xs text-slate-500 hover:text-blue-700 hover:underline mr-3">Duplicate</button>
          {!m.latestJob && (
            <button onClick={() => removeOne(m)} disabled={busy} className="text-xs text-slate-500 hover:text-red-600 hover:underline mr-3">Delete</button>
          )}
          {active ? (
            <Link to={`/jobs/${m.latestJob.id}`} className="text-xs font-medium rounded-md px-2.5 py-1 bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors">Open job</Link>
          ) : (
            <button onClick={() => createJob(m.id)} disabled={busy} className="text-xs font-medium rounded-md px-2.5 py-1 bg-blue-600 text-white hover:bg-blue-700 transition-colors">{m.latestJob ? 'Run again' : 'Create job'}</button>
          )}
        </td>
      </tr>
    );
  }

  function renderSectionHeader(section) {
    const all = mappings.filter((m) => (m.group || NO_GROUP) === section.key);
    const done = all.filter((m) => bucketOf(m) === 'done').length;
    const ticked = section.rows.filter((m) => selectedIds.has(m.id)).length;
    const open = !collapsed.has(section.key);
    const isRenaming = renaming && renaming.group === section.name;
    return (
      <tr key={`h-${section.key}`} className="bg-slate-50">
        <td className="px-4 py-2">
          <TriCheckbox
            checked={section.rows.length > 0 && ticked === section.rows.length}
            indeterminate={ticked > 0}
            onChange={(e) => setTicked(section.rows, e.target.checked)}
            aria-label={`Select all in ${section.name || 'no project'}`}
          />
        </td>
        <td colSpan={4} className="px-4 py-2">
          <div className="flex items-center gap-3">
            {isRenaming ? (
              <input
                autoFocus
                value={renaming.value}
                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') renameGroup(); if (e.key === 'Escape') setRenaming(null); }}
                onBlur={renameGroup}
                aria-label="Project name"
                autoComplete="off"
                className="border border-slate-300 rounded px-1.5 py-0.5 text-sm font-semibold w-64"
              />
            ) : (
              <button onClick={() => toggleCollapsed(section.key)} aria-expanded={open} className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <span className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>▸</span>
                {section.name || <span className="text-slate-500">No project</span>}
              </button>
            )}
            <span className="text-xs text-slate-500 tabular-nums">
              {section.rows.length === all.length ? all.length : `${section.rows.length} of ${all.length}`} mapping{all.length === 1 ? '' : 's'} · {done} migrated
            </span>
            {all.length > 0 && (
              <span className="hidden md:block w-28 h-1.5 bg-slate-200 rounded-full overflow-hidden" aria-hidden>
                <span className="block h-full bg-green-500 rounded-full" style={{ width: `${(done / all.length) * 100}%` }} />
              </span>
            )}
            {section.name && !isRenaming && (
              <button onClick={() => setRenaming({ group: section.name, value: section.name })} className="text-xs text-slate-500 hover:text-blue-700 hover:underline ml-auto">Rename</button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-700">All mappings ({mappings.length})</h2>
        <div className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Filter by status">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              onClick={() => setBucket(b.id)}
              aria-pressed={bucket === b.id}
              className={`rounded-full px-2 py-0.5 ${bucket === b.id ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              {b.label} <span className="tabular-nums">{counts[b.id]}</span>
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search site, folder or project…"
          aria-label="Search mappings"
          type="search"
          autoComplete="off"
          className="ml-auto w-64 max-w-full border border-slate-300 rounded-md px-2 py-1 text-sm"
        />
      </div>

      {selected.length > 0 && (
        // Solid white under the tint: the dark theme's tint is see-through,
        // and rows scroll beneath this bar. top-14 clears the app's top bar.
        <div className="sticky top-14 z-[5] bg-white border-b border-blue-200">
        <div className="bg-blue-50 px-4 py-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-blue-800 mr-1">{selected.length} selected</span>
            <button onClick={() => bulkCreateJobs('approve')} disabled={busy} className="btn-primary" title="Creates a job for each one and approves it, ready to run from the job queue">Create and approve jobs</button>
            <button onClick={() => bulkCreateJobs('run')} disabled={busy} className="btn-secondary bg-white border border-slate-200" title="Also starts them: a few run at a time and the rest wait their turn">…and run</button>
            <button onClick={() => bulkCreateJobs('create')} disabled={busy} className="btn-secondary bg-white border border-slate-200">Create jobs only</button>
            <span className="w-px h-5 bg-blue-200 mx-1" aria-hidden />
            <button onClick={() => setPanel(panel === 'project' ? null : 'project')} aria-expanded={panel === 'project'} className="btn-secondary bg-white border border-slate-200">Move to project…</button>
            <button onClick={() => setPanel(panel === 'target' ? null : 'target')} aria-expanded={panel === 'target'} className="btn-secondary bg-white border border-slate-200">Change target folder…</button>
            <button onClick={removeSelected} disabled={busy} className="btn-danger">Delete</button>
            <button onClick={() => { setSelectedIds(new Set()); setPanel(null); }} className="text-xs text-slate-600 hover:underline ml-auto">Clear selection</button>
          </div>

          {panel === 'project' && (
            <form onSubmit={(e) => { e.preventDefault(); moveToProject(); }} className="flex flex-wrap items-center gap-2">
              <label htmlFor="move-project" className="text-xs text-slate-600">Project</label>
              <input
                id="move-project"
                autoFocus
                list="mapping-projects"
                value={projectValue}
                onChange={(e) => setProjectValue(e.target.value)}
                placeholder="Type a new name or pick one…"
                autoComplete="off"
                className="w-72 max-w-full border border-slate-300 rounded-md px-2 py-1 text-sm bg-white"
              />
              <datalist id="mapping-projects">{groupNames.map((g) => <option key={g} value={g} />)}</datalist>
              <button type="submit" disabled={busy} className="btn-primary">{projectValue.trim() ? `Move ${selected.length}` : `Take ${selected.length} out of their project`}</button>
            </form>
          )}

          {panel === 'target' && (
            <form onSubmit={(e) => { e.preventDefault(); applyTargetChange(); }} className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <select value={targetMode} onChange={(e) => setTargetMode(e.target.value)} aria-label="How to change the target folder" className="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white">
                  <option value="replace">Find and replace</option>
                  <option value="prefix">Put inside a folder</option>
                  <option value="set">Set the folder to</option>
                </select>
                {targetMode === 'replace' && (
                  <input autoFocus value={findText} onChange={(e) => setFindText(e.target.value)} placeholder="Find…" aria-label="Find" autoComplete="off" spellCheck={false} className="w-48 border border-slate-300 rounded-md px-2 py-1 text-sm bg-white" />
                )}
                <input
                  value={newText}
                  onChange={(e) => setNewText(e.target.value)}
                  placeholder={targetMode === 'replace' ? 'Replace with…' : 'Folder, e.g. Teams/Archive'}
                  aria-label={targetMode === 'replace' ? 'Replace with' : 'Folder'}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-56 border border-slate-300 rounded-md px-2 py-1 text-sm bg-white"
                />
                <button type="submit" disabled={busy || targetChanges.length === 0 || !!targetProblem} className="btn-primary">Change {targetChanges.length} target{targetChanges.length === 1 ? '' : 's'}</button>
              </div>
              <div className="text-xs text-slate-600">
                {selected.length - selectedEditable.length > 0 && (
                  <span>{selected.length - selectedEditable.length} of the selected already have a job (or don't go to SharePoint) and stay as they are. </span>
                )}
                {targetProblem && <span className="text-red-600">{targetProblem}. </span>}
                {targetChanges.slice(0, 3).map((c) => (
                  <span key={c.m.id} className="block font-mono">
                    {c.m.targetLibrary}/{cleanPath(c.m.targetPath) || '(top)'} <span className="text-slate-400">→</span> {c.m.targetLibrary}/{c.next || '(top)'}
                  </span>
                ))}
                {targetChanges.length > 3 && <span className="block">and {targetChanges.length - 3} more</span>}
              </div>
            </form>
          )}
        </div>
        </div>
      )}

      {message && (
        <div role={message.type === 'error' ? 'alert' : 'status'} className={`text-sm px-4 py-2 border-b ${message.type === 'error' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-green-50 text-green-700 border-green-200'}`}>
          {message.text}
        </div>
      )}

      <div className="relative overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase tracking-wide">
            <tr>
              <th className="px-4 py-2 w-10">
                <TriCheckbox
                  checked={allFilteredTicked}
                  indeterminate={someFilteredTicked}
                  onChange={(e) => setTicked(filtered, e.target.checked)}
                  aria-label="Select all shown"
                />
              </th>
              <th className="text-left px-4 py-2">Source</th>
              <th className="text-left px-4 py-2">Target</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-right px-4 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sections.map((section) => (
              <React.Fragment key={section.key}>
                {hasGroups && renderSectionHeader(section)}
                {(!hasGroups || !collapsed.has(section.key)) && section.rows.map(renderRow)}
              </React.Fragment>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                  {mappings.length === 0 ? 'No mappings yet. Add some above.' : 'No mappings match the filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
