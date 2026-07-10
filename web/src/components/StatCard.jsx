import React from 'react';

const TONES = {
  danger: { value: 'text-red-600', accent: 'bg-red-500' },
  success: { value: 'text-green-600', accent: 'bg-green-500' },
  default: { value: 'text-slate-800', accent: 'bg-blue-500' },
};

export default function StatCard({ label, value, sub, tone }) {
  const t = TONES[tone] || TONES.default;
  return (
    <div className="relative bg-white border border-slate-200 rounded-lg p-4 overflow-hidden transition-shadow hover:shadow-md">
      <div className={`absolute inset-y-0 left-0 w-1 ${t.accent} opacity-60`} />
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${t.value}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-1">{sub}</div>}
    </div>
  );
}
