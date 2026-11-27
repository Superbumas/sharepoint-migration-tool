import React from 'react';
import { formatDay, yearsAgo } from '../../lib/format';

const QUICK_YEARS = [1, 2, 3, 5, 7];

// "Only files last modified before": the archive filter on a mapping. value
// is 'YYYY-MM-DD' or '' (every file). Copy, Verify and "Delete source files"
// then only ever touch the files older than that; newer ones stay put.
export default function ArchiveDateField({ value, onChange, idPrefix = 'archive' }) {
  const on = !!value;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
      <label className="inline-flex items-center gap-2 text-slate-700">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => onChange(e.target.checked ? yearsAgo(3) : '')}
          className="accent-blue-600"
        />
        Archive: only files last modified before
      </label>
      {on && (
        <>
          <input
            id={`${idPrefix}-date`}
            type="date"
            value={value}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Only files last modified before"
            className="border border-slate-300 rounded-md px-2 py-0.5 text-sm"
          />
          <span className="flex flex-wrap items-center gap-1 text-xs" role="group" aria-label="Quick picks">
            {QUICK_YEARS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onChange(yearsAgo(n))}
                aria-pressed={value === yearsAgo(n)}
                className={`rounded-full px-2 py-0.5 ${value === yearsAgo(n) ? 'bg-blue-100 text-blue-800 font-medium' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
              >
                {n} year{n === 1 ? '' : 's'}
              </button>
            ))}
          </span>
          <span className="basis-full text-xs text-slate-500">
            Only files last changed before {formatDay(value)} are copied, checked and offered for removal from the source. Newer files stay where they are.
          </span>
        </>
      )}
    </div>
  );
}
