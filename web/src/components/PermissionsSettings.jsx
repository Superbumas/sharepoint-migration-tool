import { useState } from 'react';
import { api } from '../lib/api';

// "Copy item permissions" job setting. Off by default. When on, a run
// re-applies the grants the pre-flight recorded ("who had access") to the
// matching target items: own permissions (keeping the inherited ones), the
// same people and groups with the same role (owner becomes edit), and new
// sharing links of the same type and scope. Guests are skipped unless
// "include guests" is on; across tenants only mapped users are granted.
export default function PermissionsSettings({ job, onSaved }) {
  const s = job.permissions || {};
  const [copy, setCopy] = useState(!!s.copy);
  const [includeGuests, setIncludeGuests] = useState(!!s.includeGuests);
  const [userMapCsv, setUserMapCsv] = useState(
    Object.entries(s.userMap || {}).map(([a, b]) => `${a}, ${b}`).join('\n')
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const locked = ['running', 'paused'].includes(job.status);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await api.patch(`/api/jobs/${job.id}/permissions-settings`, { copy, includeGuests, userMapCsv });
      setMsg({ ok: true, text: 'Saved' });
      onSaved?.();
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 text-xs text-slate-700">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={copy} disabled={locked} onChange={(e) => setCopy(e.target.checked)} />
        <span>
          <span className="font-medium">Copy item permissions</span>
          <span className="block text-slate-500">After copying, items that had their own sharing get the same people, groups and roles at the target (owner becomes edit). Sharing links are re-created as new links — the old link URLs keep pointing at the source.</span>
        </span>
      </label>
      {copy && (
        <div className="pl-6 space-y-2">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={includeGuests} disabled={locked} onChange={(e) => setIncludeGuests(e.target.checked)} />
            <span>
              <span className="font-medium">Include guests</span>
              <span className="block text-slate-500">Re-grant external/guest users too. Off: guests are skipped and listed in the CSV.</span>
            </span>
          </label>
          <div>
            <div className="font-medium mb-0.5">User mapping (only needed when the target is another tenant)</div>
            <textarea
              value={userMapCsv} disabled={locked} onChange={(e) => setUserMapCsv(e.target.value)} rows={3}
              placeholder={'source.user@old.com, target.user@new.com'}
              className="w-full rounded border border-slate-300 px-2 py-1 font-mono text-[11px]"
            />
            <div className="text-slate-500">One per line: source UPN, target UPN. Across tenants, people without a mapping are skipped and logged.</div>
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="button" className="btn-secondary" onClick={save} disabled={busy || locked}>{busy ? 'Saving…' : 'Save'}</button>
        {locked && <span className="text-slate-500">Change this before or after a run.</span>}
        {msg && <span className={msg.ok ? 'text-green-700' : 'text-red-700'}>{msg.text}</span>}
      </div>
    </div>
  );
}
