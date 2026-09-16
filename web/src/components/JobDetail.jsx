import React, { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import StatusPill from './StatusPill';

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
  const [logFilter, setLogFilter] = useState('all');
  const [follow, setFollow] = useState(true);
  const [showProblems, setShowProblems] = useState(false);
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
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stickToBottom.current = atBottom;
    if (atBottom !== follow) setFollow(atBottom);
  }
  function toggleFollow() {
    const next = !follow;
    setFollow(next);
    stickToBottom.current = next;
    if (next && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
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

  const phaseText = job.phase && phaseLabel(job.phase) && ['running', 'completed'].includes(job.status) ? phaseLabel(job.phase) : null;
  const isLive = ['running', 'paused'].includes(job.status);
  const done = (job.progress.itemsDone || 0) + (job.progress.itemsSkipped || 0);
  const pct = job.totals.items > 0 ? Math.min(100, (done / job.totals.items) * 100) : (job.status === 'completed' ? 100 : 0);
  const laneCount = Math.max(1, Math.min(8, job.concurrency || Object.keys(uploads).length || 1));
  // Lanes are fixed slots: a file starting or finishing swaps a slot's content
  // instead of adding/removing rows, so the log above never moves.
  const laneEntries = Object.entries(uploads).sort(([a], [b]) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const lanes = Array.from({ length: laneCount }, (_, i) => laneEntries[i] ? laneEntries[i][1] : null);
  const visibleLog = log.filter((l) => {
    if (logFilter === 'all') return true;
    if (logFilter === 'failures') return l.event_type === 'item_failed' || l.event_type === 'verify_mismatch' || l.event_type === 'job_failed' || (l.event_type === 'log' && l.level === 'error');
    if (logFilter === 'warnings') return l.event_type === 'item_retry' || l.event_type === 'source_kept' || l.event_type === 'job_interrupted' || (l.event_type === 'log' && l.level === 'warn');
    if (logFilter === 'job') return String(l.event_type || '').startsWith('job_') || ['verification_summary', 'verify_started', 'cleanup_started', 'cleanup_summary', 'purge_started', 'purge_summary'].includes(l.event_type);
    return true;
  });
  const failureCount = log.filter((l) => l.event_type === 'item_failed' || l.event_type === 'verify_mismatch' || (l.event_type === 'log' && l.level === 'error')).length;
  const warningCount = log.filter((l) => l.event_type === 'item_retry' || (l.event_type === 'log' && l.level === 'warn')).length;
  const v = job.verification;
  const problemCount = v && !v.ok ? v.missing + v.sizeMismatch + v.hashMismatch : 0;

  const notices = [];
  if (isLive && job.progress.itemsFailed > 0) {
    notices.push({ key: 'failed', tone: 'warn', title: `${job.progress.itemsFailed} file(s) failed so far`, detail: 'see the Failures filter in the log', action: <button onClick={() => setLogFilter('failures')} className="text-xs font-medium text-blue-600 hover:underline shrink-0">Show in log</button> });
  }
  if (v) {
    notices.push({
      key: 'verify', tone: v.ok ? 'ok' : 'error',
      title: v.ok ? `Verified: ${v.identical} of ${v.sourceFiles} files byte-identical` : `Verification found ${problemCount} problem(s)`,
      detail: [
        !v.ok && `${v.missing} missing · ${v.sizeMismatch} size / ${v.hashMismatch} hash mismatches`,
        v.officeRewritten > 0 && `${v.officeRewritten} Office file(s) re-stamped by SharePoint (expected)`,
        job.verifiedAt && `verified ${job.verifiedAt}`,
      ].filter(Boolean).join(' · '),
      action: (
        <>
          {!v.ok && v.problems?.length > 0 && (
            <button onClick={() => setShowProblems((s) => !s)} className="text-xs font-medium text-blue-600 hover:underline shrink-0">{showProblems ? 'Hide files' : `Show ${v.problems.length} files`}</button>
          )}
          {!v.ok && job.status === 'completed' && <button onClick={() => act('restart')} className="btn-primary shrink-0">Re-run to repair…</button>}
        </>
      ),
      expanded: !v.ok && showProblems && v.problems?.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-slate-100 bg-slate-50/60 pl-11 pr-4 py-1">
          {v.problems.map((p) => (
            <div key={`${p.reason}:${p.path}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 items-baseline text-xs py-1">
              <span className="rounded bg-red-100 text-red-700 px-1.5 py-0.5 uppercase text-[10px] font-medium text-center">{p.reason}</span>
              <span className="font-mono truncate text-slate-700" title={p.path}>{p.path}</span>
            </div>
          ))}
          {v.problemsTruncated && <div className="text-xs text-slate-500 py-1">List capped at 200 files — the full set is in the job log (verify entries).</div>}
        </div>
      ),
    });
  }
  if (job.cleanup) {
    notices.push({
      key: 'cleanup', tone: job.cleanup.kept > 0 ? 'warn' : 'ok',
      title: 'Source cleanup',
      detail: [
        `${job.cleanup.deleted?.toLocaleString()} file(s) moved to the source recycle bin`,
        `${job.cleanup.foldersDeleted?.toLocaleString()} emptied folder(s) removed`,
        job.cleanup.kept > 0 && `${job.cleanup.kept} file(s) kept (did not re-verify — see the log)`,
        job.cleanup.purged != null && `${job.cleanup.purged.toLocaleString()} purged permanently (${formatBytes(job.cleanup.purgedBytes)})`,
        job.cleanedAt,
      ].filter(Boolean).join(' · '),
    });
    if (job.cleanup.purged == null) {
      notices.push({
        key: 'purge', tone: 'info', title: 'Recycled files still count toward SharePoint storage',
        detail: 'up to 93 days · purging frees the space now, scoped to this job\'s source folder only',
        action: <button onClick={() => act('purge-recycle-bin')} className="btn-danger shrink-0">Purge recycled items…</button>,
      });
    }
  }
  // Source cleanup only exists for SharePoint sources - the engine never
  // deletes from a file share (no recycle bin to soften it).
  if (job.status === 'completed' && v?.ok && !job.cleanup && job.source.provider !== 'filesystem') {
    notices.push({
      key: 'archive', tone: 'info', title: 'Archive complete?',
      detail: 'every file is hash-verified at the target · move the source files to the site\'s recycle bin (recoverable ~93 days), each re-verified once more at deletion time',
      action: <button onClick={() => act('cleanup-source')} className="btn-danger shrink-0">Delete source files…</button>,
    });
  }
  if (job.errorMessage) notices.push({ key: 'jobError', tone: 'error', title: job.errorMessage });
  if (error) notices.push({ key: 'actError', tone: 'error', title: error });

  const stats = kpis && [
    { label: 'Throughput', value: `${kpis.throughput.filesPerMin}`, unit: 'files/min', sub: `${kpis.throughput.mbPerMin} MB/min` },
    { label: 'ETA', value: kpis.etaSeconds != null ? `${Math.round(kpis.etaSeconds / 60)} min` : '—', sub: kpis.etaSeconds != null ? `finishes ~${new Date(Date.now() + kpis.etaSeconds * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '' },
    { label: 'Success rate', value: `${kpis.successRatePct ?? '—'}%`, sub: `${kpis.errorRatePct ?? '—'}% errors` },
    { label: 'Failed', value: kpis.files.failed, tone: kpis.files.failed > 0 ? 'text-red-600' : '', sub: kpis.files.failed > 0 ? 'retried at end of run' : '' },
    { label: 'Skipped', value: kpis.files.skipped, sub: 'already identical' },
    { label: 'Retries 3+', value: kpis.retryDistribution['3+'], sub: `of ${kpis.files.done.toLocaleString()} items` },
  ];

  return (
    <div className="space-y-4">
      <div>
        <Link to="/jobs" className="text-xs text-slate-500 hover:underline">&larr; Back to queue</Link>
        <div className="flex items-center justify-between gap-4 mt-1">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-xl font-semibold text-slate-800 truncate">{job.name}</h1>
            <StatusPill status={job.status} />
          </div>
          <div className="flex gap-2 shrink-0">
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
      </div>

      {/* Notices: one card, one 44px row per notice - icon, one-line message,
          action on the right. Replaces the stack of tinted banners whose
          varying heights shoved everything below them around. */}
      {notices.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
          {notices.map((n) => (
            <div key={n.key}>
              <div className="flex items-center gap-3 px-4 py-2.5 min-h-[44px]">
                <NoticeIcon tone={n.tone} />
                <span className="flex-1 min-w-0 truncate text-sm text-slate-700" title={[n.title, n.detail].filter(Boolean).join(' · ')}>
                  <span className="font-medium">{n.title}</span>
                  {n.detail && <span className="text-slate-500"> · {n.detail}</span>}
                </span>
                {n.action}
              </div>
              {n.expanded}
            </div>
          ))}
        </div>
      )}

      {/* Progress + phase + stats in one fixed-shape card. The phase line and
          the file count share a slot, so the card is the same height whether
          the engine is enumerating, copying or paused. */}
      {(isLive || phaseText || kpis) && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <div className="flex items-center gap-2.5 min-w-0">
              {job.status === 'running' && (
                <span className="relative flex h-3 w-3 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-blue-500" />
                </span>
              )}
              <span className="font-medium text-slate-700 truncate">
                {phaseText
                  ? phaseText
                  : job.status === 'paused'
                    ? `Paused — ${done.toLocaleString()} of ${job.totals.items.toLocaleString()} files`
                    : job.status === 'completed'
                      ? `Completed — ${done.toLocaleString()} of ${job.totals.items.toLocaleString()} files`
                      : `${done.toLocaleString()} of ${job.totals.items.toLocaleString()} files`}
              </span>
              {isLive && job.progress.itemsFailed > 0 && <span className="text-red-600 shrink-0">· {job.progress.itemsFailed} failed</span>}
            </div>
            <span className="text-slate-500 tabular-nums shrink-0">{formatBytes(job.progress.bytesDone)} / {formatBytes(job.totals.bytes)} · {pct.toFixed(1)}%</span>
          </div>
          <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${job.status === 'paused' ? 'bg-amber-400' : job.status === 'completed' ? 'bg-green-500' : 'bg-gradient-to-r from-blue-500 to-indigo-500'}`}
              style={{ width: `${job.phase?.phase === 'preparing_folders' && job.phase.total > 0 ? Math.min(100, (job.phase.done / job.phase.total) * 100) : pct}%` }}
            />
          </div>
          {stats && (
            <div className="grid grid-cols-3 md:grid-cols-6 gap-4 pt-3 border-t border-slate-100">
              {stats.map((s) => (
                <div key={s.label} className="min-w-0">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500">{s.label}</div>
                  <div className={`text-lg font-semibold tabular-nums leading-6 ${s.tone || 'text-slate-800'}`}>
                    {s.value}{s.unit && <span className="text-xs font-normal text-slate-500"> {s.unit}</span>}
                  </div>
                  <div className="text-xs text-slate-400 truncate">{s.sub || ' '}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between gap-4 mb-2">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              Live log
              {job.status === 'running' && (
                <span className="relative flex h-2 w-2" title="Job is running">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
                </span>
              )}
            </h2>
            <div className="flex gap-1 text-xs font-medium">
              {[
                ['all', 'All', null],
                ['failures', 'Failures', failureCount ? <span className="text-red-600 tabular-nums"> {failureCount}</span> : null],
                ['warnings', 'Warnings', warningCount ? <span className="text-amber-700 tabular-nums"> {warningCount}</span> : null],
                ['job', 'Job events', null],
              ].map(([key, label, count]) => (
                <button
                  key={key}
                  onClick={() => setLogFilter(key)}
                  className={`px-2.5 py-0.5 rounded-full ${logFilter === key ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  {label}{logFilter === key ? null : count}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <button onClick={toggleFollow} className="inline-flex items-center gap-1.5 text-slate-600" title="Keep the newest line in view">
              <span className={`relative inline-block w-7 h-4 rounded-full transition-colors ${follow ? 'bg-blue-600' : 'bg-slate-300'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${follow ? 'right-0.5' : 'left-0.5'}`} />
              </span>
              Follow newest
            </button>
            <a className="font-medium text-blue-600 hover:underline" href={`/api/jobs/${id}/report.pdf`}>PDF report</a>
            <a className="text-blue-600 hover:underline" href={`/api/export/audit?jobId=${id}&format=csv`}>Export CSV</a>
            <a className="text-blue-600 hover:underline" href={`/api/export/audit?jobId=${id}&format=json`}>Export JSON</a>
          </div>
        </div>
        {/* Fixed-height console: a column grid keeps time/size/duration aligned
            (no jitter as values change width), every row is one line, and the
            lane strip below is a fixed number of slots - so a transfer starting
            or finishing never moves the list. */}
        <div className="h-[28rem] flex flex-col bg-slate-900 rounded-md overflow-hidden font-mono text-xs leading-5">
          <div className="grid grid-cols-[64px_96px_minmax(0,1fr)_72px_56px] gap-2 px-3 py-1.5 text-[11px] text-slate-500 border-b border-slate-700/70 shrink-0">
            <span>time</span><span>event</span><span>path</span><span className="text-right">size</span><span className="text-right">took</span>
          </div>
          <div ref={logRef} onScroll={onLogScroll} className="flex-1 min-h-0 overflow-y-auto text-slate-100 px-3 py-1.5">
            {visibleLog.map((l, i) => {
              const s = styleFor(l);
              return (
                <div key={i} className={`grid grid-cols-[64px_96px_minmax(0,1fr)_72px_56px] gap-2 items-baseline rounded px-1 -mx-1 ${s.rowClass} ${s.rowBg || ''}`}>
                  <span className="text-slate-600 tabular-nums">{formatTime(l.ts)}</span>
                  <span className={`rounded px-1 text-center truncate ${s.badgeClass}`}>{s.badge}</span>
                  <span className="min-w-0 truncate" title={[l.source_path, l.error_message].filter(Boolean).join(' — ')}>
                    {l.source_path && <PathLabel path={l.source_path} />}
                    {l.source_path && l.error_message && <span className="opacity-40"> — </span>}
                    {l.error_message && <span className="opacity-70">{l.error_message}</span>}
                    {l.actor_name && l.actor_name !== 'system' && <span className="opacity-40"> · by {l.actor_name}</span>}
                  </span>
                  <span className="text-slate-500 text-right tabular-nums">{l.bytes != null && l.bytes > 0 ? formatBytes(l.bytes) : ''}</span>
                  <span className="text-slate-600 text-right tabular-nums">{l.duration_ms != null && l.duration_ms > 0 ? `${(l.duration_ms / 1000).toFixed(1)}s` : ''}</span>
                </div>
              );
            })}
            {visibleLog.length === 0 && <div className="text-slate-500">{log.length === 0 ? 'No log entries yet.' : 'Nothing matches this filter.'}</div>}
          </div>
          {/* In-flight transfers as fixed lane slots. Byte-accurate for
              uploads/downloads; SharePoint-to-SharePoint is a server-side copy
              with no measurable bytes, so it shows an indeterminate pulse with
              elapsed time instead. Idle slots stay in place. */}
          {job.status === 'running' && (
            <div className="shrink-0 border-t border-slate-700/70 bg-slate-800/60 px-3 py-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-500">
                <span>Transferring now · {laneCount} lane{laneCount === 1 ? '' : 's'}</span>
                <span className="tabular-nums">{laneEntries.length} active</span>
              </div>
              {lanes.map((u, i) => {
                if (!u) {
                  return (
                    <div key={i} className="grid grid-cols-[20px_minmax(0,1fr)_260px_100px] gap-3 items-center h-6">
                      <span className="text-slate-600 tabular-nums">{i + 1}</span>
                      <span className="text-slate-600">idle</span>
                      <span className="h-1 rounded-full bg-slate-800" />
                      <span />
                    </div>
                  );
                }
                const isCopy = u.phase === 'copying' || u.bytesDone == null;
                const lanePct = !isCopy && u.bytesTotal > 0 ? Math.min(100, (u.bytesDone / u.bytesTotal) * 100) : 0;
                const name = (u.sourcePath || '').split(/[\\/]/).pop();
                const etaSec = !isCopy && u.rate > 1 && u.bytesTotal > u.bytesDone ? (u.bytesTotal - u.bytesDone) / u.rate : null;
                const elapsedSec = u.firstSeen ? Math.max(0, Math.round((u.ts - u.firstSeen) / 1000)) : 0;
                const phaseLabelText = u.phase === 'downloading' ? 'downloading' : isCopy ? 'server-side copy' : 'uploading';
                const fmtSec = (s) => (s >= 90 ? `${Math.round(s / 60)} min` : `${Math.round(s)}s`);
                return (
                  <div key={i} className="grid grid-cols-[20px_minmax(0,1fr)_260px_100px] gap-3 items-center h-6">
                    <span className="text-slate-600 tabular-nums">{i + 1}</span>
                    <span className="min-w-0 truncate text-slate-300" title={u.sourcePath}>
                      {name} <span className="text-slate-500">· {phaseLabelText}
                        {isCopy && elapsedSec >= 5 && <> · {fmtSec(elapsedSec)}</>}
                        {!isCopy && u.rate > 1 && <> · {formatBytes(u.rate)}/s</>}
                        {etaSec != null && <> · ~{fmtSec(etaSec)}</>}
                      </span>
                    </span>
                    <span className="h-1 rounded-full bg-slate-700 overflow-hidden">
                      {isCopy ? (
                        <span className="block h-full w-full bg-indigo-400/70 animate-pulse" />
                      ) : (
                        <span className="block h-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-all duration-1000" style={{ width: `${lanePct}%` }} />
                      )}
                    </span>
                    <span className="text-slate-400 text-right tabular-nums truncate">
                      {isCopy ? formatBytes(u.bytesTotal) : `${formatBytes(u.bytesDone)} / ${formatBytes(u.bytesTotal)}`}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

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
    </div>
  );
}

// Stroke icons for the notice rows - one consistent 16px set, recolored by tone.
function NoticeIcon({ tone }) {
  const color = { error: '#dc2626', warn: '#f59e0b', ok: '#16a34a', info: '#64748b' }[tone] || '#64748b';
  const common = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: color, strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'shrink-0' };
  if (tone === 'error' || tone === 'warn') {
    return <svg {...common}><path d="M8 2 1.5 13.5h13L8 2Z" /><path d="M8 6.5v3.5M8 12.5h.01" /></svg>;
  }
  if (tone === 'ok') {
    return <svg {...common} strokeWidth={1.8}><path d="M3 8.5 6.5 12 13 4.5" /></svg>;
  }
  return <svg {...common}><circle cx="8" cy="8" r="6.5" /><path d="M8 7v4M8 5h.01" /></svg>;
}
