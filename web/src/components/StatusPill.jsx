import React from 'react';

// Single source of truth for job-status colors - Dashboard and JobQueue
// previously each had their own map and disagreed (running was blue on one
// page, green on the other). Outlined, as in the Knowall CRM.
export const STATUS_STYLE = {
  queued: { pill: 'pill-outline border bg-white border-slate-300 text-slate-600', dot: 'bg-slate-400' },
  approved: { pill: 'pill-outline border bg-white border-sky-300 text-sky-700', dot: 'bg-sky-500' },
  running: { pill: 'pill-outline border bg-white border-blue-300 text-blue-700', dot: 'bg-blue-500', pulse: true },
  paused: { pill: 'pill-outline border bg-white border-amber-300 text-amber-700', dot: 'bg-amber-500' },
  completed: { pill: 'pill-outline border bg-white border-green-300 text-green-700', dot: 'bg-green-500' },
  failed: { pill: 'pill-outline border bg-white border-red-300 text-red-700', dot: 'bg-red-500' },
  cancelled: { pill: 'pill-outline border bg-white border-slate-300 text-slate-500', dot: 'bg-slate-400' },
};

export default function StatusPill({ status, label }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.queued;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-semibold rounded-full px-2.5 py-0.5 ${s.pill}`}>
      <span className="relative flex h-1.5 w-1.5">
        {s.pulse && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${s.dot}`} />}
        <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${s.dot}`} />
      </span>
      {label || status}
    </span>
  );
}
