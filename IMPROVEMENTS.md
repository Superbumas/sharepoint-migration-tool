# Improvements backlog

Things worth doing later, not blocking current work.

- (none currently)

## Done

- **Progress feedback during slow pre-copy phases** (2026-07-09): engine now
  emits throttled `phase_progress` events during enumeration, target-folder
  pre-creation, and index prefetch; shown as a live phase banner on the job
  page, in the queue's progress column, and in the server console.

- **Pause force-stop fallback** (2026-07-09): pause now has the same 60s
  grace-period force-kill cancel has (`PAUSE_GRACE_MS`); a force-stopped
  pause lands as a clean `paused` (checkpoint preserved), not `failed`.
