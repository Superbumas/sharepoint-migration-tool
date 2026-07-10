import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import StatusPill from './StatusPill';

// Compact action button for the queue table - a real button, not a bare text
// link, so the primary next step for each job is visually obvious.
function ActionBtn({ onClick, tone = 'default', children }) {
  const tones = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700',
    success: 'bg-green-600 text-white hover:bg-green-700',
    warn: 'bg-amber-100 text-amber-800 hover:bg-amber-200',
    danger: 'bg-red-50 text-red-700 hover:bg-red-100',
    default: 'bg-slate-100 text-slate-600 hover:bg-slate-200',
  };
  return (
    <button onClick={onClick} className={`text-xs font-medium rounded-md px-2.5 py-1 transition-colors ${tones[tone]}`}>
      {children}
    </button>
  );
}

export default function JobQueue() {
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState(null);
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
    return () => socket.off('dashboard:event', handler);
  }, []);

  async function act(job, action) {
    setError(null);
    try {
      if (action === 'delete') {
        if (!confirm(`Delete job "${job.name}"? This only hides it from the active queue - the audit log is kept forever and stays exportable.`)) return;
        await api.del(`/api/jobs/${job.id}`);
      } else if (action === 'cancel') {
        if (!confirm('Cancel this job? Whatever has already been copied stays copied - there is no automatic rollback.')) return;
        await api.post(`/api/jobs/${job.id}/cancel`);
      } else {
        await api.post(`/api/jobs/${job.id}/${action}`);
      }
      refresh();
    } catch (err) {
      setError(err.message);
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
        <Link to="/mappings" className="text-sm font-medium text-blue-600 hover:text-blue-800">+ New mapping / job</Link>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-md p-3">{error}</div>}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Progress</th>
              <th className="text-left px-4 py-2">Created by</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link to={`/jobs/${job.id}`} className="font-medium text-slate-800 hover:text-blue-600">{job.name}</Link>
                  <div className="text-xs text-slate-400">{job.action}</div>
                </td>
                <td className="px-4 py-3">
                  <StatusPill status={job.status} label={job.pauseRequested && job.status === 'running' ? 'pausing…' : undefined} />
                </td>
                <td className="px-4 py-3 w-48">
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
                          : job.phase.phase === 'preparing_folders' ? `creating folders ${(job.phase.done ?? 0).toLocaleString()}/${(job.phase.total ?? 0).toLocaleString()}`
                          : 'indexing…'}
                      </span>
                    ) : (
                      <>
                        {(job.progress.itemsDone + job.progress.itemsSkipped).toLocaleString()} / {(job.totals.items ?? 0).toLocaleString() || '?'} items
                        {job.progress.itemsFailed > 0 && <span className="text-red-500"> · {job.progress.itemsFailed} failed</span>}
                      </>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-500">{job.createdBy.name}</td>
                <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                  {job.status === 'queued' && <ActionBtn tone="primary" onClick={() => act(job, 'approve')}>Approve</ActionBtn>}
                  {job.status === 'approved' && <ActionBtn tone="success" onClick={() => act(job, 'run')}>Run</ActionBtn>}
                  {job.status === 'running' && <ActionBtn tone="warn" onClick={() => act(job, 'pause')}>Pause</ActionBtn>}
                  {job.status === 'paused' && <ActionBtn tone="success" onClick={() => act(job, 'resume')}>Resume</ActionBtn>}
                  {['running', 'paused', 'approved', 'queued'].includes(job.status) && (
                    <ActionBtn tone="danger" onClick={() => act(job, 'cancel')}>Cancel</ActionBtn>
                  )}
                  {['failed', 'cancelled'].includes(job.status) && <ActionBtn tone="success" onClick={() => act(job, 'restart')}>Restart</ActionBtn>}
                  {['completed', 'failed', 'cancelled'].includes(job.status) && <ActionBtn onClick={() => act(job, 'delete')}>Delete</ActionBtn>}
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-slate-400">No jobs yet - create a mapping first.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
