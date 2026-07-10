import React from 'react';

// Single source of truth for job-status colors - Dashboard and JobQueue
// previously each had their own map and disagreed (running was blue on one
// page, green on the other).
const STATUS_STYLE = {
  queued: { pill: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  approved: { pill: 'bg-sky-100 text-sky-700', dot: 'bg-sky-500' },
  running: { pill: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500', pulse: true },
  paused: { pill: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  completed: { pill: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
  failed: { pill: 'bg-red-100 text-red-700', dot: 'bg-red-500' },
  cancelled: { pill: 'bg-slate-200 text-slate-600', dot: 'bg-slate-400' },
};

export default function StatusPill({ status, label }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.queued;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 ${s.pill}`}>
      <span className="relative flex h-1.5 w-1.5">
        {s.pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${s.dot}`} />}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${s.dot}`} />
      </span>
      {label || status}
    </span>
  );
}
