import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import StatCard from './StatCard';

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

// Visual treatment per log line: a pill badge + row colour + optional row
// background tint for lines that must pop (failures, warnings). Falls back
// to a neutral grey for anything unlisted so new engine event types degrade
// gracefully instead of rendering raw.
const EVENT_STYLE = {
  item_success: { badge: '✓ copied', badgeClass: 'bg-green-500/15 text-green-400', rowClass: 'text-green-300' },
  item_failed: { badge: '✗ failed', badgeClass: 'bg-red-500/20 text-red-400', rowClass: 'text-red-300', rowBg: 'bg-red-500/10' },
  item_retry: { badge: '↻ retry', badgeClass: 'bg-amber-500/15 text-amber-400', rowClass: 'text-amber-300' },
  item_skipped: { badge: '↷ skipped', badgeClass: 'bg-slate-500/15 text-slate-500', rowClass: 'text-slate-500' },
  item_start: { badge: '→ start', badgeClass: 'text-slate-500', rowClass: 'text-slate-500' },
  verify_mismatch: { badge: '⚠ verify', badgeClass: 'bg-red-500/20 text-red-400 font-semibold', rowClass: 'text-red-300', rowBg: 'bg-red-500/10' },
  verification_summary: { badge: '🛡 verify', badgeClass: 'bg-sky-500/15 text-sky-400', rowClass: 'text-sky-300' },
  verify_started: { badge: '🛡 verify', badgeClass: 'bg-sky-500/15 text-sky-400', rowClass: 'text-sky-300' },
  job_created: { badge: '● created', badgeClass: 'text-slate-300 font-semibold', rowClass: 'text-slate-300' },
  job_approved: { badge: '● approved', badgeClass: 'text-slate-300 font-semibold', rowClass: 'text-slate-300' },
  job_run: { badge: '▶ run', badgeClass: 'bg-blue-500/15 text-blue-400 font-semibold', rowClass: 'text-slate-200' },
  job_resumed: { badge: '▶ resumed', badgeClass: 'bg-blue-500/15 text-blue-400 font-semibold', rowClass: 'text-slate-200' },
  job_started: { badge: '▶ started', badgeClass: 'bg-blue-500/15 text-blue-400 font-semibold', rowClass: 'text-slate-200' },
  job_paused: { badge: '⏸ paused', badgeClass: 'bg-amber-500/15 text-amber-400 font-semibold', rowClass: 'text-slate-200' },
  job_completed: { badge: '■ completed', badgeClass: 'bg-green-500/15 text-green-400 font-semibold', rowClass: 'text-green-300' },
  job_failed: { badge: '■ failed', badgeClass: 'bg-red-500/20 text-red-400 font-semibold', rowClass: 'text-red-300', rowBg: 'bg-red-500/10' },
  job_cancelled: { badge: '■ cancelled', badgeClass: 'text-slate-300 font-semibold', rowClass: 'text-slate-300' },
  job_pause_requested: { badge: '⏸ pause…', badgeClass: 'bg-amber-500/15 text-amber-400 font-semibold', rowClass: 'text-amber-300' },
  job_cancel_requested: { badge: '⛔ cancel…', badgeClass: 'bg-red-500/15 text-red-400 font-semibold', rowClass: 'text-red-300' },
  job_restarted: { badge: '↺ restarted', badgeClass: 'bg-blue-500/15 text-blue-400 font-semibold', rowClass: 'text-slate-200' },
  job_interrupted: { badge: '⚡ interrupted', badgeClass: 'bg-amber-500/15 text-amber-400 font-semibold', rowClass: 'text-amber-300', rowBg: 'bg-amber-500/10' },
  job_deleted: { badge: '🗑 deleted', badgeClass: 'text-slate-500', rowClass: 'text-slate-400' },
  checkpoint: { badge: '· checkpoint', badgeClass: 'text-slate-600', rowClass: 'text-slate-600' },
  cleanup_started: { badge: '🗑 cleanup', badgeClass: 'bg-amber-500/15 text-amber-400 font-semibold', rowClass: 'text-amber-300' },
  source_deleted: { badge: '🗑 recycled', badgeClass: 'text-slate-500', rowClass: 'text-slate-500' },
  source_kept: { badge: '⚠ kept', badgeClass: 'bg-amber-500/15 text-amber-400', rowClass: 'text-amber-300' },
  cleanup_summary: { badge: '🗑 done', badgeClass: 'bg-green-500/15 text-green-400 font-semibold', rowClass: 'text-green-300' },
  purge_started: { badge: '⛔ purge', badgeClass: 'bg-red-500/15 text-red-400 font-semibold', rowClass: 'text-red-300' },
  purge_summary: { badge: '⛔ purged', badgeClass: 'bg-green-500/15 text-green-400 font-semibold', rowClass: 'text-green-300' },
};

// 'log' events carry a level (info/warn/error) rather than a distinct type.
function styleFor(line) {
  if (line.event_type === 'log') {
    if (line.level === 'error') return { badge: '✗ error', badgeClass: 'bg-red-500/20 text-red-400', rowClass: 'text-red-300', rowBg: 'bg-red-500/10' };
    if (line.level === 'warn') return { badge: '⚠ warn', badgeClass: 'bg-amber-500/15 text-amber-400', rowClass: 'text-amber-300', rowBg: 'bg-amber-500/10' };
    return { badge: 'ℹ info', badgeClass: 'text-slate-500', rowClass: 'text-slate-400' };
  }
  return EVENT_STYLE[line.event_type] || { badge: line.event_type, badgeClass: 'text-slate-500', rowClass: 'text-slate-300' };
}

// Human line for the phase banner, per engine phase_progress event shape
// (engine/Invoke-MigrationJob.ps1's Write-PhaseProgress call sites).
function phaseLabel(phase) {
  const n = (v) => (v ?? 0).toLocaleString();
  switch (phase?.phase) {
    case 'enumerating':
      return `Scanning source tree — ${n(phase.folders)} folders · ${n(phase.files)} files found${phase.pending ? ` · ${n(phase.pending)} folders queued` : ''}`;
    case 'preparing_folders':
      return `Creating target folders — ${n(phase.done)} of ${n(phase.total)}`;
    case 'indexing_source':
      return `Indexing source metadata — ${n(phase.files)} files`;
    case 'indexing_target':
      return `Indexing existing target files — ${n(phase.files)} files`;
    case 'hashing_source':
      return `Hashing source files for verification — ${n(phase.files)} files`;
    case 'cleaning':
      return `Cleaning source — ${n(phase.deleted)} recycled · ${n(phase.kept)} kept of ${n(phase.total)}`;
    case 'purging':
      return `Purging recycle bin — ${n(phase.purged)} of ${n(phase.total)} permanently deleted`;
    case 'clearing_folders':
      return `Recycling emptied folders — ${n(phase.done)} of ${n(phase.total)}`;
    default:
      return null;
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const t = ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z';
  const d = new Date(t);
  return isNaN(d) ? ts : d.toLocaleTimeString('en-GB', { hour12: false });
}

// "Hub" from "https://tenant.sharepoint.com/sites/Hub" - jobs store only the
// site URL, and a bare library/path never says WHICH site is involved.
function siteFromUrl(u) {
  if (!u) return '';
  try {
    return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    return '';
  }
}

// Long server-relative paths dominate the log visually; show the filename
// bright and the folder dim, keep the full path in the hover title.
function PathLabel({ path }) {
  if (!path) return null;
  const idx = path.lastIndexOf('/');
  const dir = idx > 0 ? path.slice(0, idx + 1) : '';
  const name = idx > 0 ? path.slice(idx + 1) : path;
  return (
    <span title={path}>
      <span className="opacity-50">{dir}</span>
      <span>{name}</span>
    </span>
  );
}

export default function JobDetail() {
  const { id } = useParams();
  const [job, setJob] = useState(null);
  const [kpis, setKpis] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  // lane -> { sourcePath, bytesDone, bytesTotal, rate, ts } for uploads in
  // flight right now (item_progress heartbeats - big files only, small ones
  // finish between ticks). Live-only: never persisted, cleared on completion.
  const [uploads, setUploads] = useState({});
  const kpiDebounce = useRef(null);
  const logRef = useRef(null);
  // Pin the log view to the newest line, but stop pinning while the user has
  // scrolled up to read history; re-pin as soon as they return to the bottom.
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  function onLogScroll() {
    const el = logRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function refreshJob() {
    api.get(`/api/jobs/${id}`).then(setJob).catch(() => {});
  }
  function refreshKpis() {
    api.get(`/api/kpis/jobs/${id}`).then(setKpis).catch(() => {});
  }

  useEffect(() => {
    refreshJob();
    refreshKpis();
    api.get(`/api/jobs/${id}/log?limit=100`).then((r) => setLog(r.items));

    socket.emit('job:subscribe', id);
    const handler = (msg) => {
      if (msg.jobId !== id) return;
      if (msg.job) setJob(msg.job);
      // Live log lines come exclusively from 'log_row' - the server pushes
      // every audit-log row (engine events AND lifecycle actions like
      // pause/cancel requests) through that single channel, exactly once.
      // Consuming 'engine_event' here too would duplicate every line, and
      // phase_progress/checkpoint heartbeats never become rows at all.
      if (msg.type === 'log_row' && msg.row) {
        setLog((prev) => [...prev.slice(-299), msg.row]);
      }
      if (msg.type === 'engine_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'item_progress') {
          setUploads((prev) => {
            const now = Date.now();
            const key = ev.lane ?? ev.sourcePath;
            const prior = prev[key];
            const samePhase = prior && prior.sourcePath === ev.sourcePath && prior.phase === ev.phase;
            // Instantaneous rate from the delta between heartbeats - only
            // within the same file AND phase (blob transfers reset from
            // download to upload; a retry rewinds).
            let rate = samePhase ? (prior.rate || 0) : 0;
            if (samePhase && now > prior.ts && ev.bytesDone > prior.bytesDone) {
              rate = ((ev.bytesDone - prior.bytesDone) * 1000) / (now - prior.ts);
            }
            const firstSeen = (prior && prior.sourcePath === ev.sourcePath) ? prior.firstSeen : now;
            const next = { ...prev, [key]: { ...ev, ts: now, rate, firstSeen } };
            // Prune anything that stopped heartbeating (finished while we
            // missed the success event, e.g. socket reconnect).
            for (const k of Object.keys(next)) { if (now - next[k].ts > 15000) delete next[k]; }
            return next;
          });
        } else if (['item_success', 'item_failed', 'item_skipped'].includes(ev.type)) {
          setUploads((prev) => {
            const entries = Object.entries(prev).filter(([, u]) => u.sourcePath !== ev.sourcePath);
            return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
          });
        } else if (['job_completed', 'job_failed', 'job_cancelled', 'paused'].includes(ev.type)) {
          setUploads({});
        }
      }
      if (!kpiDebounce.current) {
        kpiDebounce.current = setTimeout(() => { kpiDebounce.current = null; refreshKpis(); }, 1000);
      }
    };
    socket.on('job:event', handler);
    return () => {
      socket.emit('job:unsubscribe', id);
      socket.off('job:event', handler);
    };
  }, [id]);

  async function act(action) {
    setError(null);
    try {
      if (action === 'cleanup-source') {
        const answer = prompt(
          'DELETE SOURCE FILES?\n\nEvery source file whose migrated copy re-verifies RIGHT NOW will be moved to the source site\'s RECYCLE BIN (recoverable for ~93 days). Files that do not verify are kept and reported. Emptied folders are recycled too.\n\nType DELETE to proceed.'
        );
        if (answer !== 'DELETE') return;
        await api.post(`/api/jobs/${id}/cleanup-source`);
        refreshJob();
        return;
      }
      if (action === 'purge-recycle-bin') {
        const answer = prompt(
          'PERMANENTLY DELETE RECYCLED ITEMS?\n\nThis permanently removes the recycle-bin items this job\'s cleanup created (only items from this job\'s source folder - nothing else). They can NOT be recovered afterwards.\n\nThis is how the SharePoint storage actually gets freed - recycled items count toward quota for 93 days otherwise.\n\nType PURGE to proceed.'
        );
        if (answer !== 'PURGE') return;
        await api.post(`/api/jobs/${id}/purge-recycle-bin`);
        refreshJob();
        return;
      }
      if (action === 'cancel' && !confirm('Cancel this job? Whatever has already been copied stays copied - there is no automatic rollback.')) return;
      if (action === 'delete') {
        if (!confirm('Delete this job from the active queue? The audit log is kept forever.')) return;
        await api.del(`/api/jobs/${id}`);
        window.location.href = '/jobs';
        return;
      }
      await api.post(`/api/jobs/${id}/${action}`);
      refreshJob();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!job) return <div className="text-slate-500">Loading job...</div>;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/jobs" className="text-xs text-slate-500 hover:underline">&larr; Back to queue</Link>
        <div className="flex items-center justify-between mt-1">
          <h1 className="text-xl font-semibold text-slate-800">{job.name}</h1>
          <div className="space-x-2">
            {job.status === 'queued' && <button onClick={() => act('approve')} className="btn-primary">Approve</button>}
            {job.status === 'approved' && <button onClick={() => act('run')} className="btn-primary">Run</button>}
            {job.status === 'running' && <button onClick={() => act('pause')} className="btn-secondary">Pause</button>}
            {job.status === 'paused' && <button onClick={() => act('resume')} className="btn-primary">Resume</button>}
            {['running', 'paused', 'approved', 'queued'].includes(job.status) && <button onClick={() => act('cancel')} className="btn-danger">Cancel</button>}
            {['failed', 'cancelled'].includes(job.status) && <button onClick={() => act('restart')} className="btn-primary">Restart</button>}
            {job.status === 'completed' && <button onClick={() => act('verify')} className="btn-secondary">Verify</button>}
            {['completed', 'failed', 'cancelled'].includes(job.status) && <button onClick={() => act('delete')} className="btn-secondary">Delete</button>}
          </div>
        </div>
        <div className="text-sm text-slate-500 mt-1">
          {job.source.provider === 'filesystem' && <span className="text-xs rounded bg-violet-100 text-violet-700 px-1.5 py-0.5 font-medium mr-1.5">file share</span>}
          <span title={job.source.siteUrl || undefined}>
            {job.source.provider !== 'filesystem' && siteFromUrl(job.source.siteUrl) && (
              <span className="text-slate-400">{siteFromUrl(job.source.siteUrl)} <span className="text-slate-300">›</span> </span>
            )}
            {job.source.path}
          </span>
          {' '}<span className="text-slate-300">&rarr;</span>{' '}
          {job.target.provider === 'azure_blob'
            ? `azure-blob://${job.target.container}/${job.target.blobPrefix || ''}`
            : (
              <span title={job.target.siteUrl || undefined}>
                {siteFromUrl(job.target.siteUrl) && (
                  <span className="font-medium text-slate-600">{siteFromUrl(job.target.siteUrl)} <span className="text-slate-300 font-normal">›</span> </span>
                )}
                {job.target.library}/{job.target.path}
              </span>
            )} · {job.action}
        </div>
        {job.verification && (
          <div className={`mt-2 text-sm rounded-md p-2 border ${job.verification.ok ? 'text-green-800 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200'}`}>
            {job.verification.ok
              ? `✓ Verified: ${job.verification.identical} of ${job.verification.sourceFiles} files byte-identical (content hash)`
              : `⚠ Verification found ${job.verification.missing + job.verification.sizeMismatch + job.verification.hashMismatch} problem(s): ${job.verification.missing} missing, ${job.verification.sizeMismatch} size / ${job.verification.hashMismatch} hash mismatches`}
            {job.verification.officeRewritten > 0 && (
              <span className="text-slate-500"> · {job.verification.officeRewritten} Office file(s) re-stamped by SharePoint (expected, content intact)</span>
            )}
            {job.verifiedAt && <span className="text-slate-400"> · verified {job.verifiedAt}</span>}
          </div>
        )}
        {job.cleanup && (
          <div className={`mt-2 text-sm rounded-md p-2 border ${job.cleanup.kept > 0 ? 'text-amber-800 bg-amber-50 border-amber-200' : 'text-green-800 bg-green-50 border-green-200'}`}>
            🗑 Source cleanup: {job.cleanup.deleted?.toLocaleString()} file(s) moved to the source recycle bin, {job.cleanup.foldersDeleted?.toLocaleString()} emptied folder(s) removed
            {job.cleanup.kept > 0 && <> · <span className="font-medium">{job.cleanup.kept} file(s) kept</span> (did not re-verify — see the log)</>}
            {job.cleanup.purged != null && <> · <span className="font-medium">{job.cleanup.purged.toLocaleString()} purged permanently ({formatBytes(job.cleanup.purgedBytes)})</span></>}
            {job.cleanedAt && <span className="text-slate-400"> · {job.cleanedAt}</span>}
          </div>
        )}
        {job.cleanup && job.cleanup.purged == null && (
          <div className="mt-2 text-sm rounded-md p-2 border text-slate-600 bg-slate-50 border-slate-200 flex items-center justify-between gap-3 flex-wrap">
            <span>
              <span className="font-medium text-slate-700">Storage note:</span>{' '}
              the recycled files still count toward SharePoint storage for up to 93 days. To free the space now, permanently purge the items this job recycled (scoped to this job's source folder only).
            </span>
            <button onClick={() => act('purge-recycle-bin')} className="btn-danger shrink-0">Purge recycled items…</button>
          </div>
        )}
        {/* Source cleanup only exists for SharePoint sources - the engine
            never deletes from a file share (no recycle bin to soften it). */}
        {job.status === 'completed' && job.verification?.ok && !job.cleanup && job.source.provider !== 'filesystem' && (
          <div className="mt-2 text-sm rounded-md p-2 border text-slate-600 bg-slate-50 border-slate-200 flex items-center justify-between gap-3 flex-wrap">
            <span>
              <span className="font-medium text-slate-700">Archive complete?</span>{' '}
              Every file is hash-verified at the target. You can now move the source files to the site's recycle bin (recoverable ~93 days) — each file is re-verified once more at deletion time.
            </span>
            <button onClick={() => act('cleanup-source')} className="btn-danger shrink-0">Delete source files…</button>
          </div>
        )}
        {job.errorMessage && <div className="mt-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{job.errorMessage}</div>}
        {error && <div className="mt-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md p-2">{error}</div>}
      </div>

      {job.phase && phaseLabel(job.phase) && ['running', 'completed'].includes(job.status) && (
        <div className="rounded-lg border border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-3 flex items-center gap-3">
          <span className="relative flex h-3 w-3 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-blue-900 truncate">{phaseLabel(job.phase)}</div>
            {job.phase.phase === 'preparing_folders' && job.phase.total > 0 && (
              <div className="mt-1.5 h-1.5 bg-blue-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${Math.min(100, (job.phase.done / job.phase.total) * 100)}%` }} />
              </div>
            )}
          </div>
          <span className="text-xs text-blue-400 shrink-0">preparing…</span>
        </div>
      )}

      {job.totals.items > 0 && ['running', 'paused'].includes(job.status) && !(job.phase && phaseLabel(job.phase)) && (() => {
        const done = (job.progress.itemsDone || 0) + (job.progress.itemsSkipped || 0);
        const pct = Math.min(100, (done / job.totals.items) * 100);
        return (
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-baseline justify-between text-sm mb-1.5">
              <span className="font-medium text-slate-700">
                {job.status === 'paused' ? '⏸ Paused — ' : ''}
                {done.toLocaleString()} of {job.totals.items.toLocaleString()} files
                {job.progress.itemsFailed > 0 && <span className="text-red-600"> · {job.progress.itemsFailed} failed</span>}
              </span>
              <span className="text-slate-500 tabular-nums">{formatBytes(job.progress.bytesDone)} / {formatBytes(job.totals.bytes)} · {pct.toFixed(1)}%</span>
            </div>
            <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${job.status === 'paused' ? 'bg-amber-400' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })()}

      {/* Live per-file transfer progress - only files that live long enough
          between engine heartbeats appear here, which is exactly when a row
          is needed (a 370MB file otherwise "disappears" for minutes between
          item_start and item_success). Byte-accurate for uploads/downloads;
          SharePoint-to-SharePoint is a server-side copy with no measurable
          bytes, so it shows an indeterminate "copying" row with elapsed time. */}
      {job.status === 'running' && Object.keys(uploads).length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-3 space-y-2.5">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Transferring now</div>
          {Object.entries(uploads).map(([lane, u]) => {
            const isCopy = u.phase === 'copying' || u.bytesDone == null;
            const pct = !isCopy && u.bytesTotal > 0 ? Math.min(100, (u.bytesDone / u.bytesTotal) * 100) : 0;
            const name = (u.sourcePath || '').split(/[\\/]/).pop();
            const etaSec = !isCopy && u.rate > 1 && u.bytesTotal > u.bytesDone ? (u.bytesTotal - u.bytesDone) / u.rate : null;
            const elapsedSec = u.firstSeen ? Math.max(0, Math.round((u.ts - u.firstSeen) / 1000)) : 0;
            const phaseLabelText = u.phase === 'downloading' ? 'downloading from source'
              : isCopy ? 'server-side copy' : 'uploading';
            return (
              <div key={lane}>
                <div className="flex items-baseline justify-between gap-2 text-xs mb-1">
                  <span className="min-w-0 truncate">
                    <span className="font-medium text-slate-700" title={u.sourcePath}>{name}</span>
                    <span className="text-slate-400"> · {phaseLabelText}</span>
                  </span>
                  <span className="text-slate-500 tabular-nums shrink-0">
                    {isCopy ? (
                      <>{formatBytes(u.bytesTotal)}{elapsedSec >= 5 && <> · {elapsedSec >= 90 ? `${Math.round(elapsedSec / 60)} min` : `${elapsedSec}s`} elapsed</>}</>
                    ) : (
                      <>
                        {formatBytes(u.bytesDone)} / {formatBytes(u.bytesTotal)} · {pct.toFixed(0)}%
                        {u.rate > 1 && <> · {formatBytes(u.rate)}/s</>}
                        {etaSec != null && <> · ~{etaSec >= 90 ? `${Math.round(etaSec / 60)} min` : `${Math.round(etaSec)}s`} left</>}
                      </>
                    )}
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  {isCopy ? (
                    <div className="h-full w-full rounded-full bg-gradient-to-r from-blue-300 to-indigo-400 animate-pulse" />
                  ) : (
                    <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all duration-1000" style={{ width: `${pct}%` }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {kpis && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Files done / total" value={`${kpis.files.done.toLocaleString()} / ${(kpis.files.total ?? 0).toLocaleString()}`} />
          <StatCard label="Bytes done / total" value={`${formatBytes(kpis.bytes.done)} / ${formatBytes(kpis.bytes.total)}`} />
          <StatCard label="Throughput" value={`${kpis.throughput.filesPerMin} files/min`} sub={`${kpis.throughput.mbPerMin} MB/min`} />
          <StatCard label="ETA" value={kpis.etaSeconds != null ? `${Math.round(kpis.etaSeconds / 60)} min` : '-'} />
          <StatCard label="Success / Error rate" value={`${kpis.successRatePct ?? '-'}% / ${kpis.errorRatePct ?? '-'}%`} />
          <StatCard label="Failed" value={kpis.files.failed} tone="danger" />
          <StatCard label="Skipped" value={kpis.files.skipped} />
          <StatCard label="Retries (3+ / total items)" value={`${kpis.retryDistribution['3+']}`} />
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Largest files</h2>
          <ul className="text-xs text-slate-600 space-y-1">
            {kpis?.largestFiles.map((f, i) => (
              <li key={i} className="flex justify-between gap-2"><span className="truncate">{f.source_path}</span><span className="text-slate-400 shrink-0">{formatBytes(f.size_bytes)}</span></li>
            ))}
          </ul>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-2">Slow transfers (&gt; {Math.round((kpis?.slowThresholdMs || 0) / 1000)}s)</h2>
          <ul className="text-xs text-slate-600 space-y-1">
            {kpis?.slowItems.map((f, i) => (
              <li key={i} className="flex justify-between gap-2"><span className="truncate">{f.source_path}</span><span className="text-slate-400 shrink-0">{(f.duration_ms / 1000).toFixed(1)}s</span></li>
            ))}
            {kpis && kpis.slowItems.length === 0 && <li className="text-slate-400">None</li>}
          </ul>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
            Live log
            {job.status === 'running' && (
              <span className="relative flex h-2 w-2" title="Job is running">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
            )}
          </h2>
          <div className="space-x-3 text-xs">
            <a className="font-medium text-blue-600 hover:underline" href={`/api/jobs/${id}/report.pdf`}>📄 PDF report</a>
            <a className="text-blue-600 hover:underline" href={`/api/export/audit?jobId=${id}&format=csv`}>Export CSV</a>
            <a className="text-blue-600 hover:underline" href={`/api/export/audit?jobId=${id}&format=json`}>Export JSON</a>
          </div>
        </div>
        <div ref={logRef} onScroll={onLogScroll} className="h-80 overflow-y-auto font-mono text-xs bg-slate-900 text-slate-100 rounded-md p-3 leading-5">
          {log.map((l, i) => {
            const s = styleFor(l);
            return (
              <div key={i} className={`flex gap-2 items-baseline rounded px-1 -mx-1 ${s.rowClass} ${s.rowBg || ''}`}>
                <span className="text-slate-600 shrink-0 tabular-nums">{formatTime(l.ts)}</span>
                <span className={`shrink-0 w-24 rounded px-1 text-center ${s.badgeClass}`}>{s.badge}</span>
                <span className="flex-1 min-w-0 whitespace-normal break-words">
                  {l.source_path && <PathLabel path={l.source_path} />}
                  {l.source_path && l.error_message && <span className="opacity-40"> — </span>}
                  {l.error_message}
                  {l.actor_name && l.actor_name !== 'system' && <span className="opacity-40"> · by {l.actor_name}</span>}
                </span>
                {l.bytes != null && l.bytes > 0 && <span className="text-slate-500 shrink-0 tabular-nums">{formatBytes(l.bytes)}</span>}
                {l.duration_ms != null && l.duration_ms > 0 && <span className="text-slate-600 shrink-0 tabular-nums">{(l.duration_ms / 1000).toFixed(1)}s</span>}
              </div>
            );
          })}
          {log.length === 0 && <div className="text-slate-500">No log entries yet.</div>}
        </div>
      </div>
    </div>
  );
}
