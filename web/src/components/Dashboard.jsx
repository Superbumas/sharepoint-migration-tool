import React, { useEffect, useRef, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { socket } from '../lib/socket';
import StatCard from './StatCard';
import StatusPill from './StatusPill';

const STATUS_BADGE = {
  completed: 'bg-green-100 text-green-800',
  running: 'bg-blue-100 text-blue-800',
  paused: 'bg-amber-100 text-amber-800',
  failed: 'bg-red-100 text-red-700',
  cancelled: 'bg-slate-200 text-slate-600',
  queued: 'bg-slate-100 text-slate-600',
  approved: 'bg-sky-100 text-sky-700',
};

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

export default function Dashboard() {
  const [kpis, setKpis] = useState(null);
  const debounceRef = useRef(null);

  function refresh() {
    api.get('/api/kpis/global').then(setKpis).catch(() => {});
  }

  useEffect(() => {
    refresh();
    const handler = () => {
      if (debounceRef.current) return;
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refresh();
      }, 1000);
    };
    socket.on('dashboard:event', handler);
    return () => socket.off('dashboard:event', handler);
  }, []);

  if (!kpis) return <div className="text-slate-500">Loading dashboard...</div>;

  const errorLabels = Object.keys(kpis.errorBreakdown);
  const errorData = Object.values(kpis.errorBreakdown);
  const totalErrors = errorData.reduce((a, b) => a + b, 0);
  const retryLabels = Object.keys(kpis.retryDistribution);
  const retryData = Object.values(kpis.retryDistribution);
  const anyRetries = retryData.slice(1).some((n) => n > 0);
  const isIdle = (kpis.inFlight ?? 0) === 0;
  const v = kpis.verification || { verified: 0, problems: 0, unverified: 0 };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-800">Tenant-wide migration status</h1>
        <span className={`inline-flex items-center gap-2 text-xs font-medium rounded-full px-3 py-1.5 ${isIdle ? 'bg-slate-100 text-slate-500' : 'bg-blue-100 text-blue-800'}`}>
          {!isIdle && (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          )}
          {isIdle ? 'idle — no jobs in flight' : `${kpis.inFlight} job(s) in flight`}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Files migrated / total" value={`${kpis.files.done.toLocaleString()} / ${kpis.files.total.toLocaleString()}`} />
        <StatCard label="Data migrated / total" value={`${formatBytes(kpis.bytes.done)} / ${formatBytes(kpis.bytes.total)}`} />
        <StatCard
          label="Throughput (last 60s)"
          value={isIdle && kpis.throughput.filesPerMin === 0 ? 'idle' : `${kpis.throughput.filesPerMin} files/min`}
          sub={isIdle && kpis.throughput.filesPerMin === 0 ? undefined : `${kpis.throughput.mbPerMin} MB/min`}
        />
        <StatCard label="Success / Error rate" value={`${kpis.successRatePct ?? '-'}% / ${kpis.errorRatePct ?? '-'}%`} />
        <StatCard label="Jobs in flight" value={kpis.inFlight ?? 0} />
        <StatCard
          label="Verified jobs"
          value={`${v.verified} / ${v.verified + v.problems + v.unverified}`}
          sub={v.problems > 0 ? `${v.problems} with problems` : v.unverified > 0 ? `${v.unverified} not yet verified` : 'all hash-verified'}
          tone={v.problems > 0 ? 'danger' : undefined}
        />
        <StatCard label="Failed items (current)" value={kpis.files.failed} tone={kpis.files.failed > 0 ? 'danger' : undefined} />
        <StatCard label="Skipped (already migrated)" value={kpis.files.skipped} />
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <h2 className="text-sm font-semibold text-slate-700 px-4 py-2 border-b border-slate-100">Recent jobs</h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {(kpis.recentJobs || []).map((j) => {
              const done = (j.itemsDone ?? 0) + (j.itemsSkipped ?? 0);
              const pct = j.totalItems ? Math.min(100, (done / j.totalItems) * 100) : 0;
              return (
                <tr key={j.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2.5">
                    <Link to={`/jobs/${j.id}`} className="font-medium text-slate-800 hover:text-blue-600">{j.name}</Link>
                  </td>
                  <td className="px-4 py-2.5 w-56">
                    <div className="text-xs text-slate-500 mb-1">
                      {done.toLocaleString()} / {(j.totalItems ?? 0).toLocaleString() || '?'} files
                      {j.itemsFailed > 0 && <span className="text-red-600"> · {j.itemsFailed} failed</span>}
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${j.status === 'failed' ? 'bg-red-400' : j.status === 'paused' ? 'bg-amber-400' : j.status === 'completed' ? 'bg-green-500' : 'bg-blue-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-slate-400 text-xs tabular-nums">{formatBytes(j.bytesDone)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {j.status === 'completed' && j.verificationOk ? (
                      <span className={`inline-block text-xs rounded-full px-2.5 py-1 font-medium ${STATUS_BADGE.completed}`}>✓ completed &amp; verified</span>
                    ) : (
                      <StatusPill status={j.status} />
                    )}
                  </td>
                </tr>
              );
            })}
            {(!kpis.recentJobs || kpis.recentJobs.length === 0) && (
              <tr><td className="px-4 py-6 text-center text-slate-400">No jobs yet - create one from a mapping.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Current failures by type</h2>
          {totalErrors === 0 ? (
            <div className="text-sm text-slate-400 py-10 text-center">No failed items right now.</div>
          ) : (
            <Bar
              data={{ labels: errorLabels, datasets: [{ label: 'Count', data: errorData, backgroundColor: '#ef4444' }] }}
              options={{ responsive: true, plugins: { legend: { display: false } } }}
            />
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <h2 className="text-sm font-semibold text-slate-700 mb-3">Retry count distribution</h2>
          {!anyRetries ? (
            <div className="text-sm text-slate-400 py-10 text-center">
              No retries needed - {retryData[0]?.toLocaleString()} item(s) succeeded first time.
            </div>
          ) : (
            <Bar
              data={{ labels: retryLabels, datasets: [{ label: 'Items', data: retryData, backgroundColor: '#f59e0b' }] }}
              options={{ responsive: true, plugins: { legend: { display: false } } }}
            />
          )}
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h2 className="text-sm font-semibold text-slate-700 mb-3">Jobs by status</h2>
        <div className="flex gap-3 flex-wrap">
          {Object.entries(kpis.statusCounts).map(([status, count]) => (
            <div key={status} className={`px-4 py-2 rounded-md text-sm ${STATUS_BADGE[status] || 'bg-slate-100 text-slate-600'}`}>
              <span className="font-semibold">{count}</span>{' '}
              <span className="capitalize">{status}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
