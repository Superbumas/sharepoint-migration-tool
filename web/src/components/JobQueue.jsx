import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { jobTitle } from '../lib/format';
import { socket } from '../lib/socket';
import StatusPill from './StatusPill';

// Compact action button for the queue table - a real button, not a bare text
// link, so the primary next step for each job is visually obvious.
function ActionBtn({ onClick, tone = 'default', disabled, children }) {
  const tones = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    success: 'bg-green-600 text-white hover:bg-green-700',
    warn: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
    danger: 'bg-red-50 text-red-700 hover:bg-red-100',
    default: 'bg-slate-100 text-slate-600 hover:bg-slate-200',
  };
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`text-xs font-medium rounded-md px-2.5 py-1 whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-wait ${tones[tone]}`}>
      {children}
    </button>
  );
}

// Client report builder: pick which finished migrations go into one
// client-facing report (PDF summary + Excel file list). Defaults to every
// completed job; the server collapses several jobs of the same mapping to
// the latest, so re-runs never show twice.
function ClientReportPanel({ jobs, onClose }) {
  const completed = jobs.filter((j) => j.status === 'completed');
  const [selected, setSelected] = useState(() => new Set(completed.map((j) => j.id)));
  const [client, setClient] = useState('');
  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allOn = selected.size === completed.length;
  const query = new URLSearchParams();
  query.set('jobs', [...selected].join(','));
  if (client.trim()) query.set('client', client.trim());
  const disabled = selected.size === 0;
  const linkCls = (primary) => `text-xs font-medium rounded-md px-3 py-1.5 transition-colors ${
    disabled ? 'pointer-events-none opacity-40 bg-slate-100 text-slate-500'
      : primary ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`;

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Client report</h2>
          <p className="text-xs text-slate-500">Files moved, sizes and verification per folder, in its final state. Runs, retries and repair passes are left out.</p>
        </div>
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-lg leading-none" aria-label="Close">×</button>
      </div>
      {completed.length === 0 ? (
        <p className="text-sm text-slate-500">No completed migrations yet.</p>
      ) : (
        <>
          <label className="block text-xs text-slate-600">
            Name on the cover
            <input
              type="text" value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client name"
              className="mt-1 block w-full sm:w-80 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm"
            />
          </label>
          <div>
            <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
              <span>{selected.size} of {completed.length} completed migrations</span>
              <button type="button" className="text-blue-600 hover:underline" onClick={() => setSelected(allOn ? new Set() : new Set(completed.map((j) => j.id)))}>
                {allOn ? 'Select none' : 'Select all'}
              </button>
            </div>
            <ul className="max-h-56 overflow-y-auto border border-slate-100 rounded-md divide-y divide-slate-100">
              {completed.map((j) => (
                <li key={j.id}>
                  <label className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={selected.has(j.id)} onChange={() => toggle(j.id)} />
                    <span className="min-w-0 truncate">{jobTitle(j.name)}</span>
                    <span className="ml-auto text-xs text-slate-400 tabular-nums shrink-0">{(j.progress.itemsDone + j.progress.itemsSkipped).toLocaleString()} files</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            <a className={linkCls(true)} href={`/api/reports/client.pdf?${query}`} aria-disabled={disabled}>Download PDF</a>
            <a className={linkCls(false)} href={`/api/reports/client.xlsx?${query}`} aria-disabled={disabled}>Download Excel file list</a>
          </div>
        </>
      )}
    </div>
  );
}

export default function JobQueue() {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
  const [showReport, setShowReport] = useState(false);
  // The job a request is in flight for: its buttons are disabled so a
  // double-click can't fire Run twice (the second came back as a 409 error).
  const [busyId, setBusyId] = useState(null);
  const [project, setProject] = useState(''); // '' = every project
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [runAtOnce, setRunAtOnce] = useState(3);
  const debounceRef = useRef(null);

  function refresh() {
    api.get('/api/jobs').then((r) => setJobs(r.items)).catch(() => {});
  }

  useEffect(() => {
    refresh();
    const handler = () => {
      if (debounceRef.current) return;
      debounceRef.current = setTimeout(() => { debounceRef.current = null; refresh(); }, 800);
    };
    socket.on('dashboard:event', handler);
    api.get('/api/settings').then((r) => { if (r.runQueueMaxJobs) setRunAtOnce(r.runQueueMaxJobs); }).catch(() => {});
    return () => socket.off('dashboard:event', handler);
  }, []);

  // Projects come from the jobs' mappings. The filter only shows once at
  // least one job belongs to a project.
  const NO_PROJECT = '\u0000none';
  const projectNames = [...new Set(jobs.map((j) => j.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const shown = !project ? jobs
    : jobs.filter((j) => (project === NO_PROJECT ? !j.project : j.project === project));
  const waitingInQueue = shown.filter((j) => j.status === 'approved' && j.runQueuedAt);
  const startable = shown.filter((j) => j.status === 'queued' || (j.status === 'approved' && !j.runQueuedAt));
  const scopeLabel = !project ? '' : project === NO_PROJECT ? ' with no project' : ` in "${project}"`;

  // Approve (where needed) and queue every startable job in view. The server
  // runs a few at a time and starts the next as each finishes.
  async function runAll() {
    const n = startable.length;
    if (!confirm(`Approve and run ${n} job${n === 1 ? '' : 's'}${scopeLabel}? They run ${runAtOnce} at a time, and the rest start on their own as each one finishes.`)) return;
    setError(null);
    setNotice(null);
    setBulkBusy(true);
    try {
      const r = await api.post('/api/jobs/bulk-run', { jobIds: startable.map((j) => j.id) });
      setNotice(`${r.queued} job${r.queued === 1 ? '' : 's'} sent to the run queue. ${r.runAtOnce} run at a time.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
      refresh();
    }
  }

  async function clearRunQueue() {
    setError(null);
    setNotice(null);
    setBulkBusy(true);
    try {
      const r = await api.post('/api/jobs/bulk-unqueue-run', { jobIds: waitingInQueue.map((j) => j.id) });
      setNotice(`${r.removed} job${r.removed === 1 ? '' : 's'} taken out of the run queue. Jobs already running carry on.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBulkBusy(false);
      refresh();
    }
  }

  async function act(job, action) {
    setError(null);
    setBusyId(job.id);
    try {
      if (action === 'delete') {
        if (!confirm(`Delete job "${job.name}"? This only hides it from the active queue - the audit log is kept forever and stays exportable.`)) return;
        await api.del(`/api/jobs/${job.id}`);
      } else if (action === 'cancel') {
        if (!confirm('Cancel this job? Whatever has already been copied stays copied - there is no automatic rollback.')) return;
        await api.post(`/api/jobs/${job.id}/cancel`);
      } else if (action === 'approve-run') {
        // One click for the usual case. Still two audit events (approved,
        // then started), same as clicking Approve and then Run.
        await api.post(`/api/jobs/${job.id}/approve`);
        await api.post(`/api/jobs/${job.id}/run`);
      } else {
        await api.post(`/api/jobs/${job.id}/${action}`);
      }
      refresh();
    } catch (err) {
      setError(`${job.name}: ${err.message}`);
      refresh();
    } finally {
      setBusyId(null);
    }
  }

  function progressPct(job) {
    if (!job.totals.items) return 0;
    return Math.min(100, Math.round(((job.progress.itemsDone + job.progress.itemsSkipped) / job.totals.items) * 100));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-800">Job queue</h1>
        <div className="flex items-center gap-4">
          <button type="button" onClick={() => setShowReport((v) => !v)} className="text-sm font-medium text-blue-600 hover:text-blue-800">Client report</button>
          <Link to="/mappings" className="text-sm font-medium text-blue-600 hover:text-blue-800">+ New mapping / job</Link>
        </div>
      </div>

      {showReport && <ClientReportPanel jobs={jobs} onClose={() => setShowReport(false)} />}

      {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md p-3">{error}</div>}
      {notice && <div role="status" className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-md p-3">{notice}</div>}

      {(projectNames.length > 0 || startable.length > 0 || waitingInQueue.length > 0) && (
        <div className="bg-white border border-slate-200 rounded-lg px-4 py-2.5 flex flex-wrap items-center gap-3">
          {projectNames.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-slate-600">
              Project
              <select value={project} onChange={(e) => setProject(e.target.value)} className="border border-slate-300 rounded-md px-2 py-1 text-sm bg-white">
                <option value="">All projects ({jobs.length})</option>
                {projectNames.map((p) => <option key={p} value={p}>{p} ({jobs.filter((j) => j.project === p).length})</option>)}
                {jobs.some((j) => !j.project) && <option value={NO_PROJECT}>No project ({jobs.filter((j) => !j.project).length})</option>}
              </select>
            </label>
          )}
          <span className="text-xs text-slate-500 tabular-nums">
            {shown.filter((j) => j.status === 'running').length} running
            {waitingInQueue.length > 0 && <> · {waitingInQueue.length} waiting to run</>}
            {' '}· {shown.filter((j) => j.status === 'completed').length} of {shown.length} completed
          </span>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {waitingInQueue.length > 0 && (
              <button type="button" onClick={clearRunQueue} disabled={bulkBusy} className="btn-secondary" title="Jobs already running carry on; the waiting ones go back to approved">
                Stop the run queue ({waitingInQueue.length} waiting)
              </button>
            )}
            {startable.length > 0 && (
              <button type="button" onClick={runAll} disabled={bulkBusy} className="btn-primary" title={`Runs ${runAtOnce} at a time; the rest wait their turn`}>
                Approve and run all {startable.length}{scopeLabel}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="hidden md:table-cell text-left px-4 py-2">Status</th>
              <th className="hidden md:table-cell text-left px-4 py-2">Progress</th>
              <th className="hidden lg:table-cell text-left px-4 py-2">Created by</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {shown.map((job) => (
              <tr key={job.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/jobs/${job.id}`} className="font-medium text-slate-800 hover:text-blue-600 break-words">{jobTitle(job.name)}</Link>
                  <div className="text-xs text-slate-400">{job.project ? `${job.project} · ` : ''}{job.action}</div>
                  {/* Phone: status and progress fold into the name cell so the
                      action buttons stay on screen instead of off to the right. */}
                  <div className="md:hidden mt-1.5 flex flex-wrap items-center gap-2 text-xs text-slate-500 tabular-nums">
                    <StatusPill status={job.status} label={job.pauseRequested && job.status === 'running' ? 'pausing…' : job.runQueuedAt ? 'waiting to run' : undefined} />
                    <span>{(job.progress.itemsDone + job.progress.itemsSkipped).toLocaleString()} / {job.totals.items ? job.totals.items.toLocaleString() : '?'}</span>
                    {job.progress.itemsFailed > 0 && <span className="text-red-500">{job.progress.itemsFailed} failed</span>}
                  </div>
                </td>
                <td className="hidden md:table-cell px-4 py-3">
                  <StatusPill status={job.status} label={job.pauseRequested && job.status === 'running' ? 'pausing…' : job.runQueuedAt ? 'waiting to run' : undefined} />
                </td>
                <td className="hidden md:table-cell px-4 py-3 w-48 min-w-[10rem]">
                  <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
                    <div
                      className={`h-2 rounded-full transition-all duration-500 ${
                        job.status === 'failed' ? 'bg-red-400'
                        : job.status === 'paused' ? 'bg-amber-400'
                        : job.status === 'completed' ? 'bg-green-500'
                        : job.status === 'running' ? 'bg-gradient-to-r from-blue-500 to-indigo-500 animate-pulse'
                        : 'bg-blue-600'
                      }`}
                      style={{ width: `${progressPct(job)}%` }}
                    />
                  </div>
                  <div className="text-xs text-slate-400 mt-1 tabular-nums">
                    {job.status === 'running' && job.phase ? (
                      <span className="text-blue-500 animate-pulse">
                        {job.phase.phase === 'enumerating' ? `scanning — ${(job.phase.files ?? 0).toLocaleString()} files found`
                          : job.phase.phase === 'preparing_folders' ? `checking folders ${(job.phase.done ?? 0).toLocaleString()}/${(job.phase.total ?? 0).toLocaleString()}`
                          : 'indexing…'}
                      </span>
                    ) : (
                      <>
                        {(job.progress.itemsDone + job.progress.itemsSkipped).toLocaleString()} / {job.totals.items ? job.totals.items.toLocaleString() : '?'} items
                        {job.progress.itemsFailed > 0 && <span className="text-red-500"> · {job.progress.itemsFailed} failed</span>}
                      </>
                    )}
                  </div>
                </td>
                <td className="hidden lg:table-cell px-4 py-3 text-slate-500 whitespace-nowrap">{job.createdBy.name}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex flex-wrap justify-end gap-1.5">
                  {job.status === 'queued' && <ActionBtn tone="success" disabled={busyId === job.id} onClick={() => act(job, 'approve-run')}>Approve &amp; run</ActionBtn>}
                  {job.status === 'queued' && <ActionBtn disabled={busyId === job.id} onClick={() => act(job, 'approve')}>Approve only</ActionBtn>}
                  {job.status === 'approved' && <ActionBtn tone="success" disabled={busyId === job.id} onClick={() => act(job, 'run')}>{job.runQueuedAt ? 'Run now' : 'Run'}</ActionBtn>}
                  {job.status === 'approved' && job.runQueuedAt && <ActionBtn disabled={busyId === job.id} onClick={() => act(job, 'unqueue-run')}>Take out of queue</ActionBtn>}
                  {job.status === 'running' && <ActionBtn tone="warn" disabled={busyId === job.id} onClick={() => act(job, 'pause')}>Pause</ActionBtn>}
                  {job.status === 'paused' && <ActionBtn tone="success" disabled={busyId === job.id} onClick={() => act(job, 'resume')}>Resume</ActionBtn>}
                  {['running', 'paused', 'approved', 'queued'].includes(job.status) && (
                    <ActionBtn tone="danger" disabled={busyId === job.id} onClick={() => act(job, 'cancel')}>Cancel</ActionBtn>
                  )}
                  {['failed', 'cancelled'].includes(job.status) && <ActionBtn tone="success" disabled={busyId === job.id} onClick={() => act(job, 'restart')}>Restart</ActionBtn>}
                  {['completed', 'failed', 'cancelled'].includes(job.status) && <ActionBtn disabled={busyId === job.id} onClick={() => act(job, 'delete')}>Delete</ActionBtn>}
                  </div>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">{jobs.length === 0 ? 'No jobs yet - create a mapping first.' : 'No jobs in this project.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
