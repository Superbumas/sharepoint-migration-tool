# SharePoint Migration Tool

A self-hosted tool for migrating file content into and around SharePoint Online, with
hash-verified copies, resumable jobs, live progress, and a permanent audit trail.
A React web UI drives a Node/Express server that spawns a PowerShell 7 + PnP.PowerShell
engine per job; every file operation is streamed back as NDJSON, persisted to SQLite,
and broadcast live to the browser.

## What it migrates

| Source | Target | How the bytes move |
|---|---|---|
| SharePoint site/library/folder | SharePoint (same or another site) | Server-side `Copy-PnPFile` — nothing passes through the tool |
| File share (DFS / UNC / local disk) | SharePoint | Chunked upload with live per-file progress bars |
| SharePoint site/library/folder | Azure Blob Storage container | Streamed download → block upload (archive/decommission scenario) |

Every path is **copy-only by design**: the engine never deletes or modifies source
content during migration. Deleting a verified source afterward is a separate, explicit,
guarded action (SharePoint sources only, recycle-bin based, per-file re-verified at
deletion time).

## Highlights

- **Hash-verified, automatically.** After every job the engine compares existence, size
  and content hash of every source file against its copy — QuickXorHash via Microsoft
  Graph for SharePoint targets (computed locally for file-share sources, byte-for-byte
  the same algorithm), Content-MD5 self-consistency for blob targets. Files that fail
  get one automatic re-copy pass and a second verification. Office documents that
  SharePoint legitimately re-stamps on ingestion (property promotion) are classified
  separately, not reported as corruption.
- **Resumable and restart-safe.** Pause/resume/cancel from the UI; server restarts
  reconcile orphaned engine processes; resume never trusts a checkpoint — every file is
  re-checked against the actual target state before being skipped or copied.
- **Parallel with adaptive throttling.** Concurrent worker lanes per job, a global
  concurrency budget per tenant, and automatic back-off when SharePoint starts
  throttling (429/503 retry rates halve the lane count).
- **Live visibility.** Real-time dashboard, per-job progress, phase banners for the
  long pre-copy stages (enumeration, folder pre-creation, indexing), and per-file
  progress bars with transfer rate and ETA for large uploads.
- **Permanent audit trail.** Every file operation and lifecycle action (approve, run,
  pause, cancel, delete, verify, cleanup) is an append-only SQLite row, exportable as
  CSV/JSON forever — deleting a job from the queue never deletes its history.
- **Multi-tenant by design.** One operator hosts the tool; each client tenant onboards
  as a "Project" via a Global Admin sign-in. Every project gets its own auto-provisioned
  Azure AD app (certificate auth, `Sites.Selected` model) inside the client's own
  tenant — per-site grants, no tenant-wide standing access, no shared credentials.
- **File-share sources handle real-world DFS mess.** Names SharePoint rejects
  (trailing dots/spaces, `"*:<>?/\|`, reserved device names) are deterministically
  sanitized and reported per file; Office lock temps and `Thumbs.db`/`desktop.ini`
  junk are skipped; junctions/symlinks are skipped (cycle hazard) and reported;
  unreadable folders are reported loudly rather than silently missing.

## Architecture

```
web/      React + Vite + Tailwind SPA — dashboard, mappings + pickers, job queue,
          job detail (live log, KPIs, verification), settings. Served by the same
          Express server in production; Socket.IO for live updates.

server/   Express + Socket.IO. Microsoft sign-in (MSAL, auth-code + PKCE), SharePoint
          browsing API (Graph, delegated), file-share browsing API (allowlisted),
          mappings (manual picker or crosswalk spreadsheet import), job orchestration
          (spawns the engine, ingests NDJSON into SQLite, broadcasts), KPIs, reports,
          audit export. SQLite (better-sqlite3, WAL) is the single source of truth.

engine/   Invoke-MigrationJob.ps1 + modules — PowerShell 7 + PnP.PowerShell, one
          process per running job, app-only certificate auth. Emits one NDJSON event
          per line on stdout; polls a control file for pause/cancel between files.
          engine/tests/ holds the QuickXorHash property test.

setup/    New-AppRegistration.ps1 — one-time, idempotent Azure AD bootstrap
          (multi-tenant app, certificate, permissions, admin consent, .env).
```

The engine's worker lanes are persistent thread jobs holding their own PnP connections,
pulling from a shared queue — not a connection per file, which would be unusably slow at
hundreds of thousands of files. The orchestrator ingests events at a single choke point,
so the DB, the live UI, and the server console can never disagree about what happened.

## Getting started

**[SETUP.md](SETUP.md)** is the full operational guide — one-time operator setup,
onboarding each client tenant (a couple of minutes, no scripts), optional features
(Azure Blob archiving, file-share sources), and troubleshooting for the exact errors
people actually hit.

The short version:

```bash
npm install
pwsh -File setup/New-AppRegistration.ps1   # one-time: app registration + cert + .env
                                            # sign in with YOUR OWN tenant's admin -
                                            # never a client's (see SETUP.md, top)
npm run dev                                 # dev: http://localhost:5173
# production: npm run build && npm run start:server-only
```

Requirements: Node.js 20+, PowerShell 7 (`pwsh`), and the PnP.PowerShell module.
For file-share sources, the account running the server needs read access to the shares.

Running this under an ISO 27001 (or similar) ISMS? **[COMPLIANCE.md](COMPLIANCE.md)**
inventories exactly what data the tool touches, where it flows and rests, the
controls in place, and the handful of things left to the operator.

## The safety model, briefly

- The engine authenticates app-only with a certificate under Microsoft's
  `Sites.Selected` model — it can only touch sites explicitly granted to it, and grants
  are per-project apps living in the client's own tenant.
- File-share access is gated by a per-project allowlist of directory roots (Settings
  page). The browse API, mapping creation, and every engine spawn all re-validate
  against the current allowlist — narrowing it immediately invalidates stale jobs.
- Migration is copy-only. Source cleanup is a separate action, only offered for
  SharePoint sources after a clean verification, recycles rather than deletes, and
  re-verifies every file at deletion time. File-share sources are never cleaned up by
  the tool at all.
- Verification failures never silently pass: mismatches are logged per file, counted in
  the job's verification summary, and shown in the UI.

## Development notes

- `npm run dev` runs the server and the Vite dev server together (proxied).
- `pwsh -File engine/tests/Test-QuickXorHash.ps1` property-tests the local QuickXorHash
  implementation against an independent naive implementation of the documented spec.
- The SQLite schema migrates automatically on server start (`server/db/migrations/`).
- `express-session` uses the default in-memory store: fine for a single-instance
  internal tool (a restart just means signing in again), but swap in a shared session
  store before running more than one Node instance.
