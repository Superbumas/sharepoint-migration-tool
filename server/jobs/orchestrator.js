const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { v4: uuid } = require('uuid');
const { getDb } = require('../db');
const config = require('../config');
const { attachNdjsonParser } = require('./ndjson');
const { controlFilePath, writeControlFile, removeControlFile, treeCachePath, removeTreeCache } = require('./controlFile');
const { mapJob } = require('../util/mapJob');
const clog = require('../util/consoleLog');
const { decrypt } = require('../util/secretCrypto');
const { resolveBlobConnectionString } = require('../util/blobCredential');
const { isAllowedFsPath, findFsRootEntry, shareBaseOf, decryptRootPassword } = require('../util/fsSource');

// Resolves which Azure AD app the engine should authenticate as for a given
// job's tenant: the Project's own dedicated app if one was successfully
// auto-provisioned (server/graph/provisionTenantApp.js) - a certificate
// (base64 PFX + password), NOT a client secret, since SharePoint Online
// app-only auth rejects client-secret-based tokens outright regardless of
// permissions - or the original shared global config.clientId/
// config.engineCertThumbprint (a local certificate-store thumbprint) for
// the legacy/backfilled project that predates that feature -
// config.tenantId is exactly that one tenant, so it's the only case
// allowed to fall back to the global identity. Any OTHER tenant with no
// engine_client_id means provisioning never completed - fails loudly
// rather than silently using the wrong tenant's credential.
function resolveEngineIdentity(tenantId) {
  const project = getDb().prepare('SELECT * FROM projects WHERE tenant_id = ?').get(tenantId);
  // Both cert columns must be present, not just engine_client_id - a row
  // provisioned during the abandoned client-secret era has engine_client_id
  // set but no certificate, and decrypt(null) crashes with an opaque
  // "Cannot read properties of null (reading 'split')" instead of the
  // actionable 409 below.
  if (project?.engine_client_id && project.engine_cert_base64_encrypted && project.engine_cert_password_encrypted) {
    if (!config.credentialEncryptionKey) {
      throw httpError(409, "This project's engine app credential can't be decrypted - CREDENTIAL_ENCRYPTION_KEY is not set on this server.");
    }
    try {
      return {
        clientId: project.engine_client_id,
        certBase64: decrypt(project.engine_cert_base64_encrypted, config.credentialEncryptionKey),
        certPassword: decrypt(project.engine_cert_password_encrypted, config.credentialEncryptionKey),
        certThumbprint: null,
      };
    } catch {
      throw httpError(409, "This project's stored engine credential can't be decrypted - CREDENTIAL_ENCRYPTION_KEY has changed since it was saved. Sign out and back into this project to re-provision automatically.");
    }
  }
  if (tenantId && tenantId !== config.tenantId) {
    throw httpError(409, "This project's engine app couldn't be provisioned yet. Sign out and back in to retry.");
  }
  // Legacy/shared identity. Prefer the PFX FILE the setup script exported -
  // it works on any machine the repo (plus setup/certs) was copied to. The
  // cert-store thumbprint only resolves where the setup script originally
  // ran (or where someone imported the PFX by hand), which cost a fresh
  // install a "Cannot find certificate with this thumbprint" job failure.
  const pfx = readSharedEnginePfx();
  if (pfx) {
    return { clientId: config.clientId, certBase64: pfx.base64, certPassword: pfx.password, certThumbprint: null };
  }
  if (!config.engineCertThumbprint) {
    throw httpError(409, `No engine credential is configured on this server: neither the certificate file (${config.engineCertPath} + pfx-password.txt) nor ENGINE_CERT_THUMBPRINT exists. Run setup/New-AppRegistration.ps1 on this machine, or copy the setup/certs folder from the machine where it was run.`);
  }
  return { clientId: config.clientId, certBase64: null, certPassword: null, certThumbprint: config.engineCertThumbprint };
}

// setup/New-AppRegistration.ps1 writes migration-engine.pfx and
// pfx-password.txt side by side; both must be present and readable.
function readSharedEnginePfx() {
  try {
    const passwordPath = path.join(path.dirname(config.engineCertPath), 'pfx-password.txt');
    if (!fs.existsSync(config.engineCertPath) || !fs.existsSync(passwordPath)) return null;
    const password = fs.readFileSync(passwordPath, 'utf8').trim();
    if (!password) return null;
    return { base64: fs.readFileSync(config.engineCertPath).toString('base64'), password };
  } catch {
    return null;
  }
}

// A file-share job re-validates against the CURRENT allowlist right before
// every engine spawn - a mapping saved last month must not stay runnable
// after an operator narrows (or empties) FS_SOURCE_ROOTS in .env.
function assertFsSourceAllowed(job) {
  if ((job.source_provider || 'sharepoint') !== 'filesystem') return;
  if (!isAllowedFsPath(job.source_path, job.tenant_id || config.tenantId)) {
    throw httpError(409, `This job's source path "${job.source_path}" is not inside this project's allowed file-share roots - the allowlist may have been narrowed (Settings page) since the mapping was created.`);
  }
}

// When the job's file-share root carries its own credentials, the engine (a
// separate, possibly long-lived process) must be able to establish the SMB
// session itself - a session made here could drop hours into a run. The
// credentials travel in the CHILD's environment, never on the command line
// (command lines are visible to every process on the machine); the engine's
// preflight runs `net use` with them and they die with the process.
function fsSourceSpawnEnv(job) {
  if ((job.source_provider || 'sharepoint') !== 'filesystem') return null;
  const entry = findFsRootEntry(job.source_path, job.tenant_id || config.tenantId);
  if (!entry?.username || !entry.passwordEncrypted) return null;
  return {
    FS_SOURCE_SHARE: shareBaseOf(entry.path),
    FS_SOURCE_USERNAME: entry.username,
    FS_SOURCE_PASSWORD: decryptRootPassword(entry),
  };
}

// EVERY secret the engine needs travels in its child ENVIRONMENT, never in
// argv: on Windows, any local process can read any other process's command
// line (WMI Win32_Process), and the engine's used to carry the app
// certificate (base64 PFX + password) and the storage account key there.
// The engine's parameters default from these variables when the args are
// absent (see the param block in engine/Invoke-MigrationJob.ps1).
function buildEngineSpawnEnv(job, engineIdentity, blobConnectionString) {
  const env = { ...process.env, ...(fsSourceSpawnEnv(job) || {}) };
  if (engineIdentity?.certBase64) {
    env.ENGINE_CERT_BASE64_ENCODED = engineIdentity.certBase64;
    env.ENGINE_CERT_PASSWORD = engineIdentity.certPassword;
  }
  if (blobConnectionString) {
    env.ENGINE_BLOB_CONNECTION_STRING = blobConnectionString;
  }
  return env;
}

// jobId -> { child, actorOnPause, cancelTimer, recentOutcomes: [{ ok, ts }] }
const runningJobs = new Map();
const RETRY_WINDOW_SIZE = 30; // items considered for the adaptive-concurrency retry rate
const CANCEL_GRACE_MS = 60_000;
// Pause politely asks lanes to finish their current file first - but a single
// huge file (or a lane wedged in a long retry backoff) can hold that up
// indefinitely, leaving a pause that never lands (observed live: 3 of 4 lanes
// stopped, one didn't, pause hung 15+ minutes until a manual cancel). After
// this grace period the engine is force-stopped and the job is marked paused
// anyway - safe, because resume never trusts the checkpoint: it re-verifies
// every file against the actual target state before copying.
const PAUSE_GRACE_MS = 60_000;

let io = null;
function init(socketIoServer) {
  io = socketIoServer;
  reconcileOrphanedJobs();
}

// Map any raw DB row on `event.job` to the same camelCase/nested shape the
// REST API returns, at this single choke point. Previously call sites sent
// the raw row straight through - the initial page load (via REST) rendered
// fine, but the first live socket update replaced it with a raw row lacking
// job.source/job.target, crashing the page on job.source.path.
function normalizeJobEvent(event) {
  return event?.job ? { ...event, job: mapJob(event.job) } : event;
}

function emitJob(jobId, event) {
  if (io) io.to(`job:${jobId}`).emit('job:event', { jobId, ...normalizeJobEvent(event) });
}
// tenantId is required (not derived from the event itself) so a broadcast
// can never accidentally reach every tenant's dashboard - see server/index.js
// for the matching per-tenant room join, which is derived from the socket's
// own authenticated session, never anything client-supplied.
function emitDashboard(event, tenantId) {
  if (io && tenantId) io.to(`dashboard:${tenantId}`).emit('dashboard:event', normalizeJobEvent(event));
}

// If Node restarted while a job's engine process was running, reconcile on
// startup. SQLite still has the job's true progress as of the last ingested
// event, so nothing is lost - but three things need handling:
// - On Windows a spawned child does NOT die with its parent, so the old
//   engine may still be running blind (its stdout pipe now goes nowhere) -
//   kill it by recorded pid, or a re-run would have two engines writing the
//   same target simultaneously.
// - A pause/cancel the user clicked just before the restart lives only in
//   the pause_requested/cancel_requested columns (the in-memory grace timers
//   died with the server) - honor it now instead of silently forgetting it.
// - Otherwise the job just can't be called "running" anymore - back to
//   'approved', resume when ready.
function reconcileOrphanedJobs() {
  const db = getDb();
  // A non-running job with a phase snapshot means an auxiliary run (source
  // cleanup / recycle-bin purge) was killed mid-flight by a restart before
  // its summary event could clear it - without this, the job page shows a
  // stuck "Cleaning source - N of M" banner forever. The action itself is
  // idempotent and can simply be started again.
  const stale = db.prepare(`UPDATE jobs SET phase_json = NULL WHERE status != 'running' AND phase_json IS NOT NULL`).run();
  if (stale.changes > 0) clog.dim('startup', `Cleared ${stale.changes} stale phase banner(s) from interrupted cleanup/purge runs.`);

  const orphaned = db.prepare(`SELECT * FROM jobs WHERE status = 'running'`).all();
  for (const job of orphaned) {
    if (job.pid) {
      try {
        process.kill(job.pid);
        clog.warn('startup', `Killed orphaned engine process ${job.pid} left over from before the restart (job "${job.name}").`);
      } catch { /* already gone - the normal case */ }
    }
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE jobs SET status = 'cancelled', completed_at = datetime('now'), pid = NULL, phase_json = NULL, cancel_requested = 0, error_message = COALESCE(error_message, 'Cancelled by user.') WHERE id = ?`
      ).run(job.id);
      insertLog(job.id, { event_type: 'job_cancelled', error_message: 'Cancel was requested before the server restarted - completed on startup.', actor_name: 'system' });
    } else if (job.pause_requested === 1) {
      db.prepare(
        `UPDATE jobs SET status = 'paused', paused_at = datetime('now'), pid = NULL, phase_json = NULL, pause_requested = 0 WHERE id = ?`
      ).run(job.id);
      insertLog(job.id, { event_type: 'job_paused', error_message: 'Pause was requested before the server restarted - completed on startup. Progress up to the last checkpoint is preserved.', actor_name: 'system' });
    } else {
      db.prepare(
        `UPDATE jobs SET status = 'approved', pid = NULL, phase_json = NULL WHERE id = ?`
      ).run(job.id);
      insertLog(job.id, {
        event_type: 'job_interrupted',
        error_message: 'Server restarted while this job was running. Progress up to the last checkpoint was preserved - resume when ready.',
        actor_name: 'system',
      });
    }
  }
}

function insertLog(jobId, fields) {
  const db = getDb();
  db.prepare(
    `INSERT INTO job_log (
      job_id, item_id, event_type, source_path, target_path, action, outcome,
      bytes, duration_ms, http_status, error_message, retry_count,
      actor_name, actor_email, actor_upn, raw_json
    ) VALUES (
      @job_id, @item_id, @event_type, @source_path, @target_path, @action, @outcome,
      @bytes, @duration_ms, @http_status, @error_message, @retry_count,
      @actor_name, @actor_email, @actor_upn, @raw_json
    )`
  ).run({
    job_id: jobId,
    item_id: fields.item_id || null,
    event_type: fields.event_type,
    source_path: fields.source_path || null,
    target_path: fields.target_path || null,
    action: fields.action || null,
    outcome: fields.outcome || null,
    bytes: fields.bytes ?? null,
    duration_ms: fields.duration_ms ?? null,
    http_status: fields.http_status ?? null,
    error_message: fields.error_message || null,
    retry_count: fields.retry_count || 0,
    actor_name: fields.actor_name || null,
    actor_email: fields.actor_email || null,
    actor_upn: fields.actor_upn || null,
    raw_json: fields.raw_json ? JSON.stringify(fields.raw_json) : null,
  });

  // Every audit row is also pushed to the job page's live log, exactly once,
  // from this single choke point. Previously only engine events were pushed
  // - lifecycle actions (pause/cancel/restart requests, interrupted-on-
  // restart, stderr lines) wrote their DB row but never reached the browser
  // until a page reload, so clicking Pause looked like it did nothing.
  // `level` is transient (no DB column) - it only colors the live line.
  emitJob(jobId, {
    type: 'log_row',
    row: {
      event_type: fields.event_type,
      level: fields.level,
      source_path: fields.source_path || null,
      target_path: fields.target_path || null,
      error_message: fields.error_message || null,
      bytes: fields.bytes ?? null,
      duration_ms: fields.duration_ms ?? null,
      actor_name: fields.actor_name || null,
      ts: new Date().toISOString(),
    },
  });
}

// tenantId is optional: request-driven call sites (every exported lifecycle
// function below) always pass the caller's session tenant, so a user in one
// tenant can never look up or act on another tenant's job by UUID (404, not
// 403 - don't confirm the row exists at all). Internal/system call sites
// that react to the engine's own already-tenant-validated process (engine
// event handling, orphan reconciliation, adaptive concurrency) omit it and
// look the job up unfiltered, since they're never driven by a user request.
function getJob(jobId, tenantId) {
  if (tenantId) return getDb().prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?').get(jobId, tenantId);
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

function createJobFromMapping(mapping, actor, overrides = {}) {
  const db = getDb();
  const id = uuid();
  // source_path/target_path can legitimately be '' (the library root, e.g. a
  // freshly created site with no subfolders yet) - fall back to the library
  // name so the job name doesn't read as "-> Documents" with a blank side.
  const sourceLabel = mapping.source_provider === 'filesystem'
    ? mapping.source_path
    : (mapping.source_path || mapping.source_library || '(root)');
  const targetLabel = mapping.target_provider === 'azure_blob'
    ? `azure-blob://${mapping.target_container}/${mapping.target_blob_prefix || ''}`
    : mapping.target_provider === 'onedrive'
    ? `onedrive://${mapping.target_onedrive_upn}/${mapping.target_onedrive_path || ''}`
    : (mapping.target_library || mapping.target_path || '(root)');
  const name = overrides.name || `${sourceLabel} -> ${targetLabel}`;
  db.prepare(
    `INSERT INTO jobs (
      id, mapping_id, name, status, tenant_id,
      source_type, source_provider, source_site_url, source_library, source_path,
      target_type, target_site_url, target_library, target_path,
      target_provider, target_container, target_blob_prefix, target_onedrive_upn, target_onedrive_path, target_onedrive_host_url,
      action, concurrency,
      created_by_name, created_by_email, created_by_upn
    ) VALUES (
      @id, @mapping_id, @name, 'queued', @tenant_id,
      @source_type, @source_provider, @source_site_url, @source_library, @source_path,
      @target_type, @target_site_url, @target_library, @target_path,
      @target_provider, @target_container, @target_blob_prefix, @target_onedrive_upn, @target_onedrive_path, @target_onedrive_host_url,
      @action, @concurrency,
      @created_by_name, @created_by_email, @created_by_upn
    )`
  ).run({
    id,
    mapping_id: mapping.id,
    name,
    // Trusted from the mapping row, not re-derived here: the caller
    // (server/api/jobs.js) already fetched this mapping tenant-scoped to
    // the signed-in session, so a job can never be created against a
    // different tenant's mapping.
    tenant_id: mapping.tenant_id,
    source_type: mapping.source_type,
    source_provider: mapping.source_provider || 'sharepoint',
    source_site_url: mapping.source_site_url,
    source_library: mapping.source_library,
    source_path: mapping.source_path,
    target_type: mapping.target_type,
    target_site_url: mapping.target_site_url,
    target_library: mapping.target_library,
    target_path: mapping.target_path,
    target_provider: mapping.target_provider || 'sharepoint',
    target_container: mapping.target_container,
    target_blob_prefix: mapping.target_blob_prefix,
    target_onedrive_upn: mapping.target_onedrive_upn,
    target_onedrive_path: mapping.target_onedrive_path,
    target_onedrive_host_url: mapping.target_onedrive_host_url,
    action: mapping.action,
    concurrency: overrides.concurrency || config.defaultJobConcurrency,
    created_by_name: actor.name,
    created_by_email: actor.email,
    created_by_upn: actor.upn,
  });
  insertLog(id, { event_type: 'job_created', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  return getJob(id);
}

function approveJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (job.status !== 'queued') throw httpError(409, `Cannot approve a job in status "${job.status}" - only queued jobs can be approved.`);
  getDb().prepare(
    `UPDATE jobs SET status = 'approved', approved_by_name = ?, approved_by_email = ?, approved_at = datetime('now') WHERE id = ?`
  ).run(actor.name, actor.email, jobId);
  insertLog(jobId, { event_type: 'job_approved', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  emitDashboard({ type: 'job_updated', job: updated }, updated.tenant_id);
  return updated;
}

// Concurrency budgets are per-tenant: one client's heavy migration
// shouldn't throttle a different client's job just because they happen to
// share this server process.
function currentGlobalConcurrencyUsage(excludeJobId, tenantId) {
  const rows = getDb().prepare(`SELECT concurrency FROM jobs WHERE status = 'running' AND id != ? AND tenant_id = ?`).all(excludeJobId || '', tenantId);
  return rows.reduce((sum, r) => sum + (r.concurrency || 0), 0);
}

function runJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (!['approved', 'paused'].includes(job.status)) {
    throw httpError(409, `Cannot run a job in status "${job.status}". It must be "approved" (first run) or "paused" (resume).`);
  }
  if (runningJobs.has(jobId)) throw httpError(409, 'Job already has a running engine process.');
  const blobConnectionString = job.target_provider === 'azure_blob'
    ? resolveBlobConnectionString(job.tenant_id || config.tenantId) : null;
  if (job.target_provider === 'azure_blob' && !blobConnectionString) {
    throw httpError(409, 'Azure Blob archiving is not configured for this project - add a connection string on the Settings page (or set AZURE_BLOB_CONNECTION_STRING on the server) before running this job.');
  }
  if (job.target_provider === 'onedrive' && !config.onedriveTargetEnabled) {
    throw httpError(409, 'The OneDrive target is not enabled on this server - set ENGINE_ONEDRIVE_TARGET_ENABLED before running this job.');
  }
  assertFsSourceAllowed(job);

  const isResume = job.status === 'paused';

  const usage = currentGlobalConcurrencyUsage(jobId, job.tenant_id);
  let effectiveConcurrency = job.concurrency;
  if (usage + effectiveConcurrency > config.globalMaxConcurrency) {
    effectiveConcurrency = Math.max(1, config.globalMaxConcurrency - usage);
  }

  writeControlFile(jobId, { pauseRequested: false, cancelRequested: false, concurrencyOverride: effectiveConcurrency });

  // The job's own tenant's own app (per-project client secret) or, for the
  // legacy tenant only, the original shared cert-based identity - see
  // resolveEngineIdentity above.
  const engineIdentity = resolveEngineIdentity(job.tenant_id || config.tenantId);

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-File', config.engineScriptPath,
    '-JobId', jobId,
    '-SourceProvider', job.source_provider || 'sharepoint',
    '-SourceSiteUrl', job.source_site_url || '',
    '-SourceLibrary', job.source_library || '',
    '-SourcePath', job.source_path,
    '-TargetProvider', job.target_provider || 'sharepoint',
    '-Action', job.action,
    '-Concurrency', String(effectiveConcurrency),
    '-ControlFilePath', controlFilePath(jobId),
    '-TreeCachePath', treeCachePath(jobId),
    '-ClientId', engineIdentity.clientId,
    '-TenantId', job.tenant_id || config.tenantId,
  ];
  // Certificate secrets travel via buildEngineSpawnEnv, not argv; the
  // thumbprint is a public identifier, so it may stay an argument.
  if (!engineIdentity.certBase64) {
    args.push('-CertThumbprint', engineIdentity.certThumbprint);
  }
  if (job.target_provider === 'azure_blob') {
    args.push(
      '-TargetContainer', job.target_container || '',
      '-TargetBlobPrefix', job.target_blob_prefix || ''
    );
  } else if (job.target_provider === 'onedrive') {
    args.push(
      '-TargetOneDriveUpn', job.target_onedrive_upn || '',
      '-TargetOneDrivePath', job.target_onedrive_path || '',
      '-TargetOneDriveHostUrl', job.target_onedrive_host_url || ''
    );
  } else {
    args.push(
      '-TargetSiteUrl', job.target_site_url || '',
      '-TargetLibrary', job.target_library || '',
      '-TargetPath', job.target_path
    );
  }
  if (isResume && job.checkpoint_json) {
    args.push('-CheckpointJson', job.checkpoint_json);
  }

  const child = spawn(config.pwshExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildEngineSpawnEnv(job, engineIdentity, blobConnectionString) });

  const db = getDb();
  // run_seq: every engine start (fresh run AND resume) is a new run. Item
  // rows stamp last_run_seq as they're touched, which is what lets the
  // counters and completion recomputes count exactly this run's outcomes
  // instead of accumulating across runs (see 014_run_scoped_counters.sql).
  db.prepare(
    `UPDATE jobs SET status = 'running', pid = ?, run_seq = run_seq + 1, started_at = COALESCE(started_at, datetime('now')), pause_requested = 0, cancel_requested = 0, phase_json = NULL,
     verification_json = NULL, verified_at = NULL WHERE id = ?`
  ).run(child.pid, jobId);

  insertLog(jobId, {
    event_type: isResume ? 'job_resumed' : 'job_run',
    actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn,
  });

  const state = { child, actorOnPause: actor, cancelTimer: null, recentOutcomes: [] };
  runningJobs.set(jobId, state);

  attachNdjsonParser(
    child.stdout,
    (event) => handleEngineEvent(jobId, event, state),
    (rawLine, err) => {
      insertLog(jobId, { event_type: 'log', error_message: `Unparseable engine output: ${rawLine}` });
    }
  );

  let stderrBuffer = '';
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split('\n');
    stderrBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        insertLog(jobId, { event_type: 'log', error_message: `[stderr] ${line.trim()}` });
        emitJob(jobId, { type: 'log', level: 'error', message: line.trim() });
      }
    }
  });

  child.on('error', (err) => {
    insertLog(jobId, { event_type: 'log', error_message: `Failed to start engine process: ${err.message}` });
  });

  child.on('close', (code) => {
    // A 'paused' NDJSON event already frees the jobId for a new run (see
    // releaseRunningState) before this OS-level close event necessarily
    // fires. If a resume has since spawned a new process for the same jobId,
    // runningJobs now points at that new child - this stale close event
    // belongs to the old process and must not touch the new run's state.
    const current = runningJobs.get(jobId);
    if (current && current.child !== child) return;
    finalizeJobProcess(jobId, code);
  });

  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  emitDashboard({ type: 'job_updated', job: updated }, updated.tenant_id);
  return updated;
}

// Frees up the jobId for a new run as soon as we know - from the engine's own
// NDJSON declaration - that this invocation is over (paused/cancelled/done),
// rather than waiting for the OS-level child 'close' event. That event can
// lag behind the NDJSON line by a tick or two, which otherwise creates a race
// where clicking Resume immediately after the UI shows "paused" gets a false
// "already running" error. finalizeJobProcess() still calls this too, as a
// safety net for crashes that never emit a terminal event.
function releaseRunningState(jobId) {
  const state = runningJobs.get(jobId);
  if (state?.cancelTimer) clearTimeout(state.cancelTimer);
  if (state?.pauseTimer) clearTimeout(state.pauseTimer);
  removeControlFile(jobId);
  runningJobs.delete(jobId);
  consoleThrottles.delete(jobId);
}

function finalizeJobProcess(jobId, code) {
  const db = getDb();
  const job = getJob(jobId);

  if (job && !['completed', 'failed', 'cancelled', 'paused'].includes(job.status)) {
    if (job.cancel_requested === 1) {
      db.prepare(
        `UPDATE jobs SET status = 'cancelled', completed_at = datetime('now'), pid = NULL, phase_json = NULL, error_message = COALESCE(error_message, 'Cancelled by user.') WHERE id = ?`
      ).run(jobId);
      insertLog(jobId, { event_type: 'job_cancelled', error_message: 'Cancelled by user.', actor_name: 'system' });
    } else if (job.pause_requested === 1) {
      // The engine was force-stopped by the pause grace timer before it could
      // emit its own 'paused' event. The periodic checkpoint events already
      // persisted true progress, and resume re-verifies every file against the
      // target anyway - so this lands as a clean pause, not a failure.
      db.prepare(
        `UPDATE jobs SET status = 'paused', paused_at = datetime('now'), pause_requested = 0, pid = NULL, phase_json = NULL WHERE id = ?`
      ).run(jobId);
      insertLog(jobId, {
        event_type: 'job_paused',
        error_message: 'Engine was force-stopped after the pause grace period; progress up to the last checkpoint is preserved.',
        actor_name: 'system',
      });
    } else {
      const message = `Engine process exited unexpectedly (exit code ${code}).`;
      db.prepare(
        `UPDATE jobs SET status = 'failed', completed_at = datetime('now'), pid = NULL, phase_json = NULL, error_message = COALESCE(error_message, ?) WHERE id = ?`
      ).run(message, jobId);
      insertLog(jobId, { event_type: 'job_failed', error_message: message, actor_name: 'system' });
    }
  } else if (job) {
    db.prepare(`UPDATE jobs SET pid = NULL WHERE id = ?`).run(jobId);
  }

  releaseRunningState(jobId);

  const updated = getJob(jobId);
  if (updated) {
    emitJob(jobId, { type: 'job_updated', job: updated });
    emitDashboard({ type: 'job_updated', job: updated }, updated.tenant_id);
  }
}

// Compact terminal feed of what every running job is doing - the web UI gets
// the full event stream over Socket.IO, but whoever is watching the server
// console (npm run dev) previously saw nothing at all between "listening on
// :3000" and a job finishing. High-volume events (per-file successes, phase
// ticks) are throttled to one summary line every few seconds per job;
// failures and lifecycle changes always print.
const consoleThrottles = new Map(); // jobId -> { lastProgressAt }
function consoleEngineEvent(job, event) {
  const name = job.name || job.id;
  const throttleKey = job.id;
  const throttled = () => {
    const t = consoleThrottles.get(throttleKey) || { lastProgressAt: 0 };
    if (Date.now() - t.lastProgressAt < 5000) return true;
    t.lastProgressAt = Date.now();
    consoleThrottles.set(throttleKey, t);
    return false;
  };
  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${units[i]}`;
  };

  switch (event.type) {
    case 'job_started':
      clog.start('job', `${name}: starting copy of ${(event.totalItems ?? 0).toLocaleString()} files (${fmtBytes(event.totalBytes)})`);
      break;
    case 'phase_progress': {
      if (throttled()) break;
      const p = event;
      const label = p.phase === 'enumerating' ? `scanning source — ${(p.folders ?? 0).toLocaleString()} folders, ${(p.files ?? 0).toLocaleString()} files found`
        : p.phase === 'preparing_folders' ? `creating target folders — ${(p.done ?? 0).toLocaleString()}/${(p.total ?? 0).toLocaleString()}`
        : p.phase === 'indexing_source' ? `indexing source metadata — ${(p.files ?? 0).toLocaleString()} files`
        : p.phase === 'indexing_target' ? `indexing existing target files — ${(p.files ?? 0).toLocaleString()} files`
        : p.phase === 'hashing_source' ? `hashing source files for verification — ${(p.files ?? 0).toLocaleString()} files`
        : p.phase;
      clog.progress('job', `${name}: ${label}`);
      break;
    }
    case 'item_success': {
      if (throttled()) break;
      // items_done on the row was read before this event's increment - +1 is
      // the count including this file.
      const done = (job.items_done ?? 0) + (job.items_skipped ?? 0) + 1;
      const total = job.total_items;
      if (total) {
        const pct = (done / total) * 100;
        clog.progress('job', `${name} ${clog.bar(pct)} ${pct.toFixed(1).padStart(5)}% · ${done.toLocaleString()}/${total.toLocaleString()} · ${fmtBytes((job.bytes_done ?? 0) + (event.bytes || 0))}`);
      } else {
        clog.progress('job', `${name}: ${done.toLocaleString()} files · ${fmtBytes((job.bytes_done ?? 0) + (event.bytes || 0))}`);
      }
      break;
    }
    case 'item_failed':
      clog.error('job', `${name}: FAILED ${event.sourcePath} — ${event.error || 'unknown error'}`);
      break;
    case 'item_progress': {
      if (throttled()) break;
      const fileName = (event.sourcePath || '').split(/[\\/]/).pop();
      if (event.bytesDone == null) {
        // Server-side copy - no measurable bytes, just show what's in flight.
        clog.progress('job', `${name}: copying ${fileName} (${fmtBytes(event.bytesTotal)}, server-side)`);
      } else {
        const pct = event.bytesTotal > 0 ? ((event.bytesDone / event.bytesTotal) * 100).toFixed(0) : '?';
        const verb = event.phase === 'downloading' ? 'downloading' : 'uploading';
        clog.progress('job', `${name}: ${verb} ${fileName} — ${pct}% of ${fmtBytes(event.bytesTotal)}`);
      }
      break;
    }
    case 'item_retry':
      if (!throttled()) clog.warn('job', `${name}: retrying ${event.sourcePath} (attempt ${event.attempt}${event.reason ? `, ${event.reason}` : ''})`);
      break;
    case 'paused':
      clog.stop('job', `${name}: paused`);
      break;
    case 'job_completed':
      clog.ok('job', `${name}: completed — ${(job.items_done ?? 0).toLocaleString()} files, ${fmtBytes(job.bytes_done)}`);
      break;
    case 'job_failed':
      clog.error('job', `${name}: FAILED — ${event.error || 'unknown engine error'}`);
      break;
    case 'job_cancelled':
      clog.stop('job', `${name}: cancelled`);
      break;
    case 'verification_summary': {
      const v = event.verification || {};
      const problems = (v.Missing?.length ?? v.missing ?? 0) + (v.SizeMismatch?.length ?? v.sizeMismatch ?? 0) + (v.HashMismatch?.length ?? v.hashMismatch ?? 0);
      if (problems > 0) clog.warn('verify', `${name}: ${problems} problem(s) found`);
      else clog.ok('verify', `${name}: all files verified identical`);
      break;
    }
    case 'source_deleted':
      if (!throttled()) clog.progress('cleanup', `${name}: recycling verified source files…`);
      break;
    case 'source_kept':
      clog.warn('cleanup', `${name}: KEPT ${event.sourcePath} — ${event.reason}`);
      break;
    case 'cleanup_summary':
      clog.ok('cleanup', `${name}: source cleanup done — ${(event.deleted ?? 0).toLocaleString()} file(s) recycled, ${(event.kept ?? 0).toLocaleString()} kept, ${(event.foldersDeleted ?? 0).toLocaleString()} empty folder(s) removed`);
      break;
    case 'purge_summary':
      clog.ok('purge', `${name}: ${(event.purged ?? 0).toLocaleString()} recycled item(s) permanently purged (${fmtBytes(event.bytes)}) — storage freed`);
      break;
    case 'log':
      if (event.level === 'error') clog.error('engine', `${name}: ${event.message}`);
      else if (event.level === 'warn') clog.warn('engine', `${name}: ${event.message}`);
      else clog.dim('engine', `${name}: ${event.message}`);
      break;
    default:
      break;
  }
}

function handleEngineEvent(jobId, event, state) {
  const db = getDb();
  const job = getJob(jobId);
  if (!job) return;

  consoleEngineEvent(job, event);

  switch (event.type) {
    case 'job_started': {
      // phase_json cleared: the copy phase has begun, so the phase banner
      // hands over to the regular items_done/total_items progress bar.
      // Counters reset to zero for THIS run: totals come from this run's
      // enumeration, so the counts compared against them must too. A resume
      // rebuilds them within seconds - every already-present file streams
      // back as an item_skipped - and the old accumulate-forever behaviour
      // produced "3,717 of 3,164 files" after a stop/restart.
      db.prepare(
        `UPDATE jobs SET total_items = ?, total_bytes = ?, phase_json = NULL,
         items_done = 0, bytes_done = 0, items_failed = 0, items_skipped = 0 WHERE id = ?`
      ).run(event.totalItems ?? job.total_items, event.totalBytes ?? job.total_bytes, jobId);
      insertLog(jobId, { event_type: 'job_started', raw_json: event });
      break;
    }
    case 'phase_progress': {
      // Live progress for the long pre-copy phases (enumerating, folder
      // pre-creation, index prefetch). Fires every ~2s while one is running -
      // persisted for page reloads, broadcast via the socket emit below, but
      // deliberately never written to job_log (it's a heartbeat, not audit).
      db.prepare('UPDATE jobs SET phase_json = ? WHERE id = ?').run(JSON.stringify(event), jobId);
      break;
    }
    case 'item_progress': {
      // Per-file upload progress for large files (filesystem-source lanes).
      // Same heartbeat treatment as phase_progress: broadcast via the socket
      // emit below so the job page can render live bars, never persisted -
      // the audit log records outcomes, not percentages.
      break;
    }
    case 'item_start': {
      // The prefetch phases run after job_started, so their phase_json can
      // still be set when copying begins - the first file starting is the
      // real "pre-copy phases are over" signal.
      if (job.phase_json) db.prepare('UPDATE jobs SET phase_json = NULL WHERE id = ?').run(jobId);
      // Size captured from the very first event so the row has one no matter
      // how the item ends - a failed-then-reconciled row otherwise counts
      // zero bytes and the "Bytes done" tile undercounts forever.
      upsertItem(job, event, { status: 'pending', size_bytes: event.bytes });
      insertLog(jobId, { event_type: 'item_start', source_path: event.sourcePath, target_path: event.targetPath, action: job.action });
      break;
    }
    case 'item_success': {
      // Counters reconcile against the item's state AS SEEN BY THIS RUN
      // (priorStatusThisRun) - a row last touched by a previous run counts
      // like a fresh file, because the counters were zeroed at job_started
      // and totals describe only this run's enumeration. Within a run, the
      // old reconciliation still applies: failed-then-repaired moves from
      // "failed" to "done", re-copies count nothing extra, and a skipped-
      // then-recopied file moves from "skipped" to "done" (its bytes were
      // already counted by the skip - not added twice).
      const prior = priorStatusThisRun(db, job, event.sourcePath);
      upsertItem(job, event, {
        status: 'success', size_bytes: event.bytes, duration_ms: event.durationMs,
        http_status: event.httpStatus, completed_at: true,
      });
      if (prior !== 'success') {
        db.prepare(
          `UPDATE jobs SET items_done = items_done + 1, bytes_done = bytes_done + ?,
           items_failed = MAX(items_failed - ?, 0), items_skipped = MAX(items_skipped - ?, 0) WHERE id = ?`
        ).run(prior === 'skipped' ? 0 : (event.bytes || 0), prior === 'failed' ? 1 : 0, prior === 'skipped' ? 1 : 0, jobId);
      }
      insertLog(jobId, {
        event_type: 'item_success', source_path: event.sourcePath, target_path: event.targetPath, action: job.action,
        outcome: 'success', bytes: event.bytes, duration_ms: event.durationMs, http_status: event.httpStatus,
      });
      trackOutcome(state, true);
      break;
    }
    case 'item_retry': {
      upsertItem(job, event, { status: 'retried' });
      db.prepare('UPDATE jobs SET retries_total = retries_total + 1 WHERE id = ?').run(jobId);
      insertLog(jobId, {
        event_type: 'item_retry', source_path: event.sourcePath, target_path: event.targetPath, action: job.action,
        outcome: 'retried', retry_count: event.attempt, http_status: event.httpStatus,
        error_message: event.reason ? `${event.reason}${event.waitMs ? ` (backoff ${event.waitMs}ms)` : ''}` : null,
      });
      trackOutcome(state, false);
      maybeAdaptConcurrency(jobId, job, state);
      break;
    }
    case 'item_failed': {
      // A file that already counted as failed on a previous attempt of THIS
      // run doesn't count twice - this is what turned 4 genuinely-failing
      // files into "12 failed" across three resumes.
      const prior = priorStatusThisRun(db, job, event.sourcePath);
      upsertItem(job, event, {
        status: 'failed', http_status: event.httpStatus, error_message: event.error, completed_at: true,
      });
      if (prior !== 'failed') {
        db.prepare('UPDATE jobs SET items_failed = items_failed + 1 WHERE id = ?').run(jobId);
      }
      insertLog(jobId, {
        event_type: 'item_failed', source_path: event.sourcePath, target_path: event.targetPath, action: job.action,
        outcome: 'failed', http_status: event.httpStatus, error_message: event.error, retry_count: event.retryCount || 0,
      });
      break;
    }
    case 'item_skipped': {
      // Per-run semantics: the first skip THIS RUN counts (counters were
      // zeroed at job_started - on a resume this is exactly how the bar
      // refills), repeats within the run don't. A skipped file's bytes ARE
      // at the target, so they count toward bytes_done - without this a
      // resumed job's byte counter stayed near zero while the file counter
      // showed nearly complete.
      const prior = priorStatusThisRun(db, job, event.sourcePath);
      if (prior !== 'success') upsertItem(job, event, { status: 'skipped', size_bytes: event.bytes, completed_at: true });
      if (prior !== 'success' && prior !== 'skipped') {
        db.prepare(
          `UPDATE jobs SET items_skipped = items_skipped + 1, bytes_done = bytes_done + ?,
           items_failed = MAX(items_failed - ?, 0) WHERE id = ?`
        ).run(event.bytes || 0, prior === 'failed' ? 1 : 0, jobId);
      }
      insertLog(jobId, {
        event_type: 'item_skipped', source_path: event.sourcePath, target_path: event.targetPath,
        error_message: event.reason || 'already present at target',
      });
      break;
    }
    case 'checkpoint': {
      db.prepare('UPDATE jobs SET checkpoint_json = ? WHERE id = ?').run(
        JSON.stringify({ lastCompletedPath: event.lastCompletedPath, deltaToken: event.deltaToken, itemsDone: event.itemsDone, bytesDone: event.bytesDone }),
        jobId
      );
      break;
    }
    case 'paused': {
      db.prepare(
        `UPDATE jobs SET status = 'paused', paused_at = datetime('now'), pause_requested = 0, phase_json = NULL, checkpoint_json = ? WHERE id = ?`
      ).run(JSON.stringify(event.checkpoint || {}), jobId);
      const actor = state.actorOnPause || { name: 'system' };
      insertLog(jobId, { event_type: 'job_paused', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
      releaseRunningState(jobId);
      break;
    }
    case 'job_cancelled': {
      db.prepare(`UPDATE jobs SET status = 'cancelled', completed_at = datetime('now'), phase_json = NULL WHERE id = ?`).run(jobId);
      insertLog(jobId, { event_type: 'job_cancelled', actor_name: 'system' });
      releaseRunningState(jobId);
      break;
    }
    case 'job_completed': {
      // Counters are event-driven approximations that can drift across
      // repairs; at completion the per-item rows are the truth, so recompute
      // from them - but ONLY rows this run touched (last_run_seq): rows for
      // files that vanished from the source between runs would otherwise
      // push the counts past this run's totals. Skipped rows count toward
      // bytes_done - their bytes are at the target.
      db.prepare(
        `UPDATE jobs SET
           items_done = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id AND status = 'success' AND last_run_seq = jobs.run_seq),
           items_failed = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id AND status = 'failed' AND last_run_seq = jobs.run_seq),
           items_skipped = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id AND status = 'skipped' AND last_run_seq = jobs.run_seq),
           bytes_done = (SELECT COALESCE(SUM(size_bytes), 0) FROM job_items WHERE job_id = jobs.id AND status IN ('success', 'skipped') AND last_run_seq = jobs.run_seq)
         WHERE id = ?`
      ).run(jobId);
      db.prepare(`UPDATE jobs SET status = 'completed', completed_at = datetime('now'), phase_json = NULL WHERE id = ?`).run(jobId);
      insertLog(jobId, { event_type: 'job_completed', raw_json: event.summary });
      // The cached source-tree scan exists to make resume cheap; a completed
      // job won't resume, and any later re-run should see the source fresh.
      removeTreeCache(jobId);
      releaseRunningState(jobId);
      break;
    }
    case 'job_failed': {
      db.prepare(`UPDATE jobs SET status = 'failed', completed_at = datetime('now'), phase_json = NULL, error_message = ? WHERE id = ?`).run(event.error || 'Unknown engine error', jobId);
      insertLog(jobId, { event_type: 'job_failed', error_message: event.error });
      releaseRunningState(jobId);
      break;
    }
    case 'verify_mismatch': {
      insertLog(jobId, {
        event_type: 'verify_mismatch', source_path: event.sourcePath || null,
        outcome: 'failed', error_message: event.message || `Verification mismatch (${event.reason})`,
        raw_json: event,
      });
      break;
    }
    case 'verification_summary': {
      db.prepare(`UPDATE jobs SET verification_json = ?, verified_at = datetime('now') WHERE id = ?`).run(
        JSON.stringify(event.verification || {}), jobId
      );
      // A clean verification is ground truth for the whole tree: every
      // source file has a hash-identical copy at the target. Item rows
      // still marked 'failed' from upload-time errors that in fact
      // committed (PnP can throw after the content landed) are factually
      // copied - reconcile them, or the KPI tiles show "2 failed" forever
      // right next to a "verified 4 of 4 byte-identical" banner.
      if (event.verification?.ok) {
        const healed = db.prepare(`UPDATE job_items SET status = 'success', error_message = NULL WHERE job_id = ? AND status = 'failed'`).run(jobId);
        if (healed.changes > 0) {
          db.prepare(
            `UPDATE jobs SET
               items_done = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id AND status = 'success' AND last_run_seq = jobs.run_seq),
               items_failed = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id AND status = 'failed' AND last_run_seq = jobs.run_seq),
               items_skipped = (SELECT COUNT(*) FROM job_items WHERE job_id = jobs.id AND status = 'skipped' AND last_run_seq = jobs.run_seq),
               bytes_done = (SELECT COALESCE(SUM(size_bytes), 0) FROM job_items WHERE job_id = jobs.id AND status IN ('success', 'skipped') AND last_run_seq = jobs.run_seq)
             WHERE id = ?`
          ).run(jobId);
          insertLog(jobId, {
            event_type: 'log', level: 'info',
            error_message: `${healed.changes} item(s) previously marked failed verified hash-identical at the target - reclassified as copied.`,
          });
        }
        // Every source file verified hash-identical at the target = every
        // enumerated byte is there. Rows from before sizes were captured on
        // item_start have NULL size_bytes and undercount the SUM above -
        // the enumeration total is the honest number for a clean tree.
        db.prepare(
          `UPDATE jobs SET bytes_done = total_bytes
           WHERE id = ? AND total_bytes IS NOT NULL AND bytes_done < total_bytes`
        ).run(jobId);
      }
      insertLog(jobId, { event_type: 'verification_summary', raw_json: event.verification });
      break;
    }
    case 'log': {
      insertLog(jobId, { event_type: 'log', error_message: event.message, level: event.level });
      break;
    }
    case 'source_deleted': {
      insertLog(jobId, { event_type: 'source_deleted', source_path: event.sourcePath, outcome: 'success' });
      break;
    }
    case 'source_kept': {
      insertLog(jobId, { event_type: 'source_kept', source_path: event.sourcePath, error_message: event.reason });
      break;
    }
    case 'cleanup_summary': {
      db.prepare(`UPDATE jobs SET cleanup_json = ?, cleaned_at = datetime('now'), phase_json = NULL WHERE id = ?`).run(
        JSON.stringify({ deleted: event.deleted, kept: event.kept, foldersDeleted: event.foldersDeleted, keptSample: event.keptSample || [] }),
        jobId
      );
      insertLog(jobId, { event_type: 'cleanup_summary', raw_json: event });
      break;
    }
    case 'purge_summary': {
      // Merged into cleanup_json rather than its own column - the purge is
      // the storage-reclamation tail of the cleanup story.
      let existing = {};
      try { existing = JSON.parse(job.cleanup_json || '{}'); } catch {}
      existing.purged = event.purged;
      existing.purgedBytes = event.bytes;
      existing.purgedAt = new Date().toISOString();
      db.prepare(`UPDATE jobs SET cleanup_json = ?, phase_json = NULL WHERE id = ?`).run(JSON.stringify(existing), jobId);
      insertLog(jobId, { event_type: 'purge_summary', raw_json: event });
      break;
    }
    default: {
      insertLog(jobId, { event_type: 'log', error_message: `Unknown engine event type "${event.type}"`, raw_json: event });
    }
  }

  const updated = getJob(jobId);
  emitJob(jobId, { type: 'engine_event', event, job: updated });
  emitDashboard({ type: 'engine_event', jobId, eventType: event.type, job: updated }, updated?.tenant_id);
}

// Row status as seen by THIS run: a row last touched by a previous run reads
// as "not seen yet" (null), so the per-run counters - zeroed at job_started -
// count every file exactly once per run regardless of earlier runs' history.
function priorStatusThisRun(db, job, sourcePath) {
  const row = db.prepare('SELECT status, last_run_seq FROM job_items WHERE job_id = ? AND source_path = ?').get(job.id, sourcePath);
  return row && row.last_run_seq === job.run_seq ? row.status : null;
}

function upsertItem(job, event, fields) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM job_items WHERE job_id = ? AND source_path = ?').get(job.id, event.sourcePath);
  if (existing) {
    // attempt_count counts actual retries (a new attempt beginning), not every
    // status transition - the success/failed event that follows a retry is
    // reporting the outcome of the attempt already counted, not starting one.
    const bumpAttempt = fields.status === 'retried';
    db.prepare(
      `UPDATE job_items SET status = ?, size_bytes = COALESCE(?, size_bytes), duration_ms = COALESCE(?, duration_ms),
       http_status = COALESCE(?, http_status), error_message = COALESCE(?, error_message),
       attempt_count = attempt_count + ?, last_run_seq = ?, completed_at = CASE WHEN ? THEN datetime('now') ELSE completed_at END
       WHERE id = ?`
    ).run(
      fields.status, fields.size_bytes ?? null, fields.duration_ms ?? null,
      fields.http_status ?? null, fields.error_message ?? null,
      bumpAttempt ? 1 : 0, job.run_seq, fields.completed_at ? 1 : 0, existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO job_items (id, job_id, item_type, source_path, target_path, size_bytes, status, attempt_count, duration_ms, http_status, error_message, last_run_seq, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'), CASE WHEN ? THEN datetime('now') ELSE NULL END)`
    ).run(
      uuid(), job.id, event.itemType || 'file', event.sourcePath, event.targetPath || '',
      fields.size_bytes ?? null, fields.status, fields.duration_ms ?? null, fields.http_status ?? null,
      fields.error_message ?? null, job.run_seq, fields.completed_at ? 1 : 0
    );
  }
}

function trackOutcome(state, ok) {
  if (!state) return;
  state.recentOutcomes.push(ok);
  if (state.recentOutcomes.length > RETRY_WINDOW_SIZE) state.recentOutcomes.shift();
}

// Backs off a job's own concurrency (via the control file the engine polls)
// when its recent retry rate crosses the configured threshold, instead of
// letting it keep hammering an API that's already struggling.
function maybeAdaptConcurrency(jobId, job, state) {
  if (!state || state.recentOutcomes.length < RETRY_WINDOW_SIZE) return;
  const retryCount = state.recentOutcomes.filter((ok) => ok === false).length;
  const retryRate = retryCount / state.recentOutcomes.length;
  if (retryRate > config.retryRateBackoffThreshold) {
    const current = getJob(jobId);
    const reduced = Math.max(1, Math.floor((current.concurrency || 1) / 2));
    writeControlFile(jobId, { pauseRequested: false, cancelRequested: false, concurrencyOverride: reduced });
    insertLog(jobId, {
      event_type: 'log',
      error_message: `Adaptive throttling: retry rate ${(retryRate * 100).toFixed(0)}% over last ${state.recentOutcomes.length} items exceeded threshold - reducing concurrency to ${reduced}.`,
      actor_name: 'system',
    });
    state.recentOutcomes = [];
  }
}

// On-demand re-verification of a completed job (the "Verify" button). Spawns
// the engine in -VerifyOnly mode: no copying, no lifecycle events - it only
// emits log / verify_mismatch / verification_summary, so a completed job's
// status can never change. Useful weeks later, e.g. right before
// decommissioning the source site.
const verifyRuns = new Map(); // jobId -> child process
function verifyJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (job.status !== 'completed') throw httpError(409, `Only completed jobs can be verified (this one is "${job.status}").`);
  if (verifyRuns.has(jobId)) throw httpError(409, 'A verification is already running for this job.');
  const blobConnectionString = job.target_provider === 'azure_blob'
    ? resolveBlobConnectionString(job.tenant_id || config.tenantId) : null;
  if (job.target_provider === 'azure_blob' && !blobConnectionString) {
    throw httpError(409, 'Azure Blob archiving is not configured for this project - add a connection string on the Settings page (or set AZURE_BLOB_CONNECTION_STRING on the server).');
  }
  if (job.target_provider === 'onedrive' && !config.onedriveTargetEnabled) {
    throw httpError(409, 'The OneDrive target is not enabled on this server - set ENGINE_ONEDRIVE_TARGET_ENABLED before verifying this job.');
  }
  assertFsSourceAllowed(job);

  const engineIdentity = resolveEngineIdentity(job.tenant_id || config.tenantId);

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-File', config.engineScriptPath,
    '-JobId', jobId,
    '-SourceProvider', job.source_provider || 'sharepoint',
    '-SourceSiteUrl', job.source_site_url || '',
    '-SourceLibrary', job.source_library || '',
    '-SourcePath', job.source_path,
    '-TargetProvider', job.target_provider || 'sharepoint',
    '-Action', job.action,
    '-ControlFilePath', controlFilePath(jobId),
    '-ClientId', engineIdentity.clientId,
    '-TenantId', job.tenant_id || config.tenantId,
    '-VerifyOnly',
  ];
  // Certificate secrets travel via buildEngineSpawnEnv, not argv; the
  // thumbprint is a public identifier, so it may stay an argument.
  if (!engineIdentity.certBase64) {
    args.push('-CertThumbprint', engineIdentity.certThumbprint);
  }
  if (job.target_provider === 'azure_blob') {
    args.push(
      '-TargetContainer', job.target_container || '',
      '-TargetBlobPrefix', job.target_blob_prefix || ''
    );
  } else if (job.target_provider === 'onedrive') {
    args.push(
      '-TargetOneDriveUpn', job.target_onedrive_upn || '',
      '-TargetOneDrivePath', job.target_onedrive_path || '',
      '-TargetOneDriveHostUrl', job.target_onedrive_host_url || ''
    );
  } else {
    args.push(
      '-TargetSiteUrl', job.target_site_url || '',
      '-TargetLibrary', job.target_library || '',
      '-TargetPath', job.target_path
    );
  }
  const child = spawn(config.pwshExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildEngineSpawnEnv(job, engineIdentity, blobConnectionString) });
  verifyRuns.set(jobId, child);
  insertLog(jobId, { event_type: 'verify_started', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });

  attachNdjsonParser(
    child.stdout,
    (event) => handleEngineEvent(jobId, event, null),
    (rawLine) => insertLog(jobId, { event_type: 'log', error_message: `Unparseable engine output: ${rawLine}` })
  );
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) insertLog(jobId, { event_type: 'log', error_message: `[verify stderr] ${text}` });
  });
  child.on('close', () => {
    verifyRuns.delete(jobId);
    // A verify-only run emits phase heartbeats (hashing_source etc.) but no
    // lifecycle events - without this, the last heartbeat sticks as a frozen
    // "Hashing source files - N files" banner on the completed job forever.
    getDb().prepare('UPDATE jobs SET phase_json = NULL WHERE id = ?').run(jobId);
    const updated = getJob(jobId);
    emitJob(jobId, { type: 'job_updated', job: updated });
    emitDashboard({ type: 'job_updated', job: updated }, updated?.tenant_id);
  });

  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  return updated;
}

// Post-verification source cleanup - the deliberate, explicit "delete the
// source now that the archive is verified" action (the engine itself stays
// copy-only during migration; this is a separate, user-triggered step).
// Guards: completed job, verification passed clean, not already cleaned or
// cleaning. The engine re-verifies each file at deletion time regardless and
// only ever recycles (never permanent-deletes).
const cleanupRuns = new Map(); // jobId -> child process
function cleanupSourceJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (job.status !== 'completed') throw httpError(409, `Only completed jobs can have their source cleaned up (this one is "${job.status}").`);
  if ((job.source_provider || 'sharepoint') === 'filesystem') {
    // The engine only ever deletes via SharePoint's recycle bin; a file share
    // has no equivalent, so file-share sources stay strictly copy-only.
    throw httpError(409, 'Source cleanup is not available for file-share sources - the engine never deletes from a file share. Retire the share manually once you are satisfied with the migration.');
  }
  let verification = null;
  try { verification = JSON.parse(job.verification_json || 'null'); } catch {}
  if (!verification?.ok) {
    throw httpError(409, 'Source cleanup requires a clean verification first - click Verify and make sure it reports no problems, then try again.');
  }
  if (cleanupRuns.has(jobId)) throw httpError(409, 'A source cleanup is already running for this job.');
  if (verifyRuns.has(jobId)) throw httpError(409, 'A verification is currently running for this job - wait for it to finish.');

  const blobConnectionString = job.target_provider === 'azure_blob'
    ? resolveBlobConnectionString(job.tenant_id || config.tenantId) : null;
  if (job.target_provider === 'azure_blob' && !blobConnectionString) {
    throw httpError(409, 'Azure Blob archiving is not configured for this project - the cleanup needs it to re-verify each file before deleting.');
  }
  if (job.target_provider === 'onedrive' && !config.onedriveTargetEnabled) {
    throw httpError(409, 'The OneDrive target is not enabled on this server - the cleanup needs it to re-verify each file before deleting.');
  }
  const engineIdentity = resolveEngineIdentity(job.tenant_id || config.tenantId);

  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-File', config.engineScriptPath,
    '-JobId', jobId,
    '-SourceSiteUrl', job.source_site_url || '',
    '-SourceLibrary', job.source_library || '',
    '-SourcePath', job.source_path,
    '-TargetProvider', job.target_provider || 'sharepoint',
    '-Action', job.action,
    '-ControlFilePath', controlFilePath(jobId),
    '-ClientId', engineIdentity.clientId,
    '-TenantId', job.tenant_id || config.tenantId,
    '-CleanupSource',
  ];
  // Certificate secrets travel via buildEngineSpawnEnv, not argv; the
  // thumbprint is a public identifier, so it may stay an argument.
  if (!engineIdentity.certBase64) {
    args.push('-CertThumbprint', engineIdentity.certThumbprint);
  }
  if (job.target_provider === 'azure_blob') {
    args.push(
      '-TargetContainer', job.target_container || '',
      '-TargetBlobPrefix', job.target_blob_prefix || ''
    );
  } else if (job.target_provider === 'onedrive') {
    args.push(
      '-TargetOneDriveUpn', job.target_onedrive_upn || '',
      '-TargetOneDrivePath', job.target_onedrive_path || '',
      '-TargetOneDriveHostUrl', job.target_onedrive_host_url || ''
    );
  } else {
    args.push(
      '-TargetSiteUrl', job.target_site_url || '',
      '-TargetLibrary', job.target_library || '',
      '-TargetPath', job.target_path
    );
  }
  const child = spawn(config.pwshExecutable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: buildEngineSpawnEnv(job, engineIdentity, blobConnectionString) });
  cleanupRuns.set(jobId, child);
  insertLog(jobId, { event_type: 'cleanup_started', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  clog.warn('cleanup', `${job.name}: source cleanup started by ${actor.name} - verified files are being moved to the source recycle bin`);

  attachNdjsonParser(
    child.stdout,
    (event) => handleEngineEvent(jobId, event, null),
    (rawLine) => insertLog(jobId, { event_type: 'log', error_message: `Unparseable engine output: ${rawLine}` })
  );
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) insertLog(jobId, { event_type: 'log', error_message: `[cleanup stderr] ${text}` });
  });
  child.on('close', () => {
    cleanupRuns.delete(jobId);
    // Same stuck-banner guard as the verify close handler: if the run died
    // without emitting its summary event, the last phase heartbeat would
    // freeze on the job page forever.
    getDb().prepare('UPDATE jobs SET phase_json = NULL WHERE id = ?').run(jobId);
    const updated = getJob(jobId);
    emitJob(jobId, { type: 'job_updated', job: updated });
    emitDashboard({ type: 'job_updated', job: updated }, updated?.tenant_id);
  });

  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  return updated;
}

// Permanently purges the recycle-bin items this job's cleanup created -
// recycled files still count toward SharePoint storage quota for 93 days,
// which defeats the purpose of an archive-to-free-space migration. Scoped
// strictly to items whose original path was under the job's source root.
function purgeRecycleBinJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (job.status !== 'completed') throw httpError(409, 'Only completed jobs can purge their recycled items.');
  if ((job.source_provider || 'sharepoint') === 'filesystem') {
    throw httpError(409, 'There is no recycle bin to purge for a file-share source - nothing was ever deleted from it.');
  }
  let cleanup = null;
  try { cleanup = JSON.parse(job.cleanup_json || 'null'); } catch {}
  if (!cleanup) throw httpError(409, 'Run the source cleanup first - there is nothing recycled by this job to purge yet.');
  if (cleanupRuns.has(jobId)) throw httpError(409, 'A cleanup/purge is already running for this job.');

  const engineIdentity = resolveEngineIdentity(job.tenant_id || config.tenantId);
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-File', config.engineScriptPath,
    '-JobId', jobId,
    '-SourceSiteUrl', job.source_site_url || '',
    '-SourceLibrary', job.source_library || '',
    '-SourcePath', job.source_path,
    '-TargetProvider', job.target_provider || 'sharepoint',
    '-Action', job.action,
    '-ControlFilePath', controlFilePath(jobId),
    '-ClientId', engineIdentity.clientId,
    '-TenantId', job.tenant_id || config.tenantId,
    '-PurgeRecycleBin',
  ];
  // Certificate secrets travel via buildEngineSpawnEnv, not argv; the
  // thumbprint is a public identifier, so it may stay an argument.
  if (!engineIdentity.certBase64) {
    args.push('-CertThumbprint', engineIdentity.certThumbprint);
  }
  // Target params are irrelevant to a purge but the engine requires a valid
  // target shape - pass the job's own.
  if (job.target_provider === 'azure_blob') {
    args.push('-TargetContainer', job.target_container || '', '-TargetBlobPrefix', job.target_blob_prefix || '');
  } else if (job.target_provider === 'onedrive') {
    args.push('-TargetOneDriveUpn', job.target_onedrive_upn || '', '-TargetOneDrivePath', job.target_onedrive_path || '', '-TargetOneDriveHostUrl', job.target_onedrive_host_url || '');
  } else {
    args.push('-TargetSiteUrl', job.target_site_url || '', '-TargetLibrary', job.target_library || '', '-TargetPath', job.target_path);
  }
  // A purge never touches the blob target, but the engine requires a valid
  // target shape - satisfy the blob branch with a placeholder via env.
  const child = spawn(config.pwshExecutable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildEngineSpawnEnv(job, engineIdentity, job.target_provider === 'azure_blob' ? 'unused=1;AccountName=unused;AccountKey=dW51c2Vk' : null),
  });
  cleanupRuns.set(jobId, child);
  insertLog(jobId, { event_type: 'purge_started', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  clog.warn('purge', `${job.name}: recycle-bin purge started by ${actor.name}`);

  attachNdjsonParser(
    child.stdout,
    (event) => handleEngineEvent(jobId, event, null),
    (rawLine) => insertLog(jobId, { event_type: 'log', error_message: `Unparseable engine output: ${rawLine}` })
  );
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) insertLog(jobId, { event_type: 'log', error_message: `[purge stderr] ${text}` });
  });
  child.on('close', () => {
    cleanupRuns.delete(jobId);
    // Same stuck-banner guard as the verify close handler: if the run died
    // without emitting its summary event, the last phase heartbeat would
    // freeze on the job page forever.
    getDb().prepare('UPDATE jobs SET phase_json = NULL WHERE id = ?').run(jobId);
    const updated = getJob(jobId);
    emitJob(jobId, { type: 'job_updated', job: updated });
    emitDashboard({ type: 'job_updated', job: updated }, updated?.tenant_id);
  });

  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  return updated;
}

function pauseJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (job.status !== 'running') throw httpError(409, `Cannot pause a job in status "${job.status}".`);
  const state = runningJobs.get(jobId);
  if (state) {
    state.actorOnPause = actor;
    // Same force-stop safety net cancel has always had (see cancelJob): lanes
    // only notice the pause flag between files, so one long copy or a wedged
    // retry backoff can otherwise hold "pausing..." open forever. Killing
    // mid-file is safe - finalizeJobProcess sees pause_requested=1 and lands
    // the job as cleanly paused, and resume re-verifies every file's actual
    // target state rather than trusting the checkpoint.
    state.pauseTimer = setTimeout(() => {
      const stillRunning = runningJobs.get(jobId);
      if (stillRunning?.child && !stillRunning.child.killed) {
        insertLog(jobId, { event_type: 'log', error_message: `Engine did not pause within ${PAUSE_GRACE_MS}ms (a large in-flight file can cause this) - forcing it to stop. Progress up to the last checkpoint is preserved.`, actor_name: 'system' });
        stillRunning.child.kill();
      }
    }, PAUSE_GRACE_MS);
  }
  getDb().prepare('UPDATE jobs SET pause_requested = 1 WHERE id = ?').run(jobId);
  writeControlFile(jobId, { pauseRequested: true, cancelRequested: false });
  insertLog(jobId, { event_type: 'job_pause_requested', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  return updated;
}

function cancelJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (!['running', 'paused', 'approved', 'queued'].includes(job.status)) {
    throw httpError(409, `Cannot cancel a job in status "${job.status}".`);
  }

  getDb().prepare('UPDATE jobs SET cancel_requested = 1 WHERE id = ?').run(jobId);
  insertLog(jobId, { event_type: 'job_cancel_requested', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });

  if (job.status === 'running') {
    writeControlFile(jobId, { pauseRequested: false, cancelRequested: true });
    const state = runningJobs.get(jobId);
    if (state) {
      state.cancelTimer = setTimeout(() => {
        const stillRunning = runningJobs.get(jobId);
        if (stillRunning?.child && !stillRunning.child.killed) {
          insertLog(jobId, { event_type: 'log', error_message: `Engine did not exit within ${CANCEL_GRACE_MS}ms of cancel request - forcing termination.`, actor_name: 'system' });
          stillRunning.child.kill();
        }
      }, CANCEL_GRACE_MS);
    }
  } else {
    // Not yet running (queued/approved) or already paused - just mark it cancelled directly.
    getDb().prepare(`UPDATE jobs SET status = 'cancelled', completed_at = datetime('now') WHERE id = ?`).run(jobId);
    insertLog(jobId, { event_type: 'job_cancelled', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  }

  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  emitDashboard({ type: 'job_updated', job: updated }, updated.tenant_id);
  return updated;
}

// Resets a failed/cancelled job back to 'approved' so it can be run again
// without recreating it from the mapping. Deliberately does NOT skip the
// approve step - it goes back to 'approved', not straight to 'running' - so
// the explicit run action (and its own audit log entry) still happens. Job
// history (job_items, job_log) is left alone; the next run's verify-before-
// copy logic re-checks the real target state regardless of old rows here.
function restartJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  // A completed job whose verification found problems may also restart:
  // re-running IS the targeted repair - the engine's skip/delta check
  // streams every verified file back as a skip and only re-copies the
  // failures, then verifies the whole tree again.
  let verificationOk = null;
  try { verificationOk = JSON.parse(job.verification_json || 'null')?.ok ?? null; } catch {}
  const repairable = job.status === 'completed' && verificationOk === false;
  if (!['failed', 'cancelled'].includes(job.status) && !repairable) {
    throw httpError(409, `Cannot restart a job in status "${job.status}" - only failed or cancelled jobs (or completed jobs whose verification found problems) can be restarted.`);
  }
  getDb().prepare(
    `UPDATE jobs SET status = 'approved', error_message = NULL,
     items_done = 0, bytes_done = 0, items_failed = 0, items_skipped = 0, retries_total = 0,
     checkpoint_json = NULL, started_at = NULL, paused_at = NULL, completed_at = NULL,
     pause_requested = 0, cancel_requested = 0, verification_json = NULL, verified_at = NULL
     WHERE id = ?`
  ).run(jobId);
  insertLog(jobId, { event_type: 'job_restarted', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  const updated = getJob(jobId);
  emitJob(jobId, { type: 'job_updated', job: updated });
  emitDashboard({ type: 'job_updated', job: updated }, updated.tenant_id);
  return updated;
}

function deleteJob(jobId, actor, tenantId) {
  const job = getJob(jobId, tenantId);
  if (!job) throw httpError(404, 'Job not found');
  if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
    throw httpError(409, 'Only jobs in a terminal state (completed, failed, cancelled) can be deleted.');
  }
  // Soft delete only: job_items and job_log rows are untouched and remain
  // exportable via /api/export forever, per the compliance requirement.
  getDb().prepare(`UPDATE jobs SET deleted_at = datetime('now'), deleted_by_name = ? WHERE id = ?`).run(actor.name, jobId);
  insertLog(jobId, { event_type: 'job_deleted', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn });
  removeTreeCache(jobId);
  emitDashboard({ type: 'job_deleted', jobId }, job.tenant_id);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  init,
  // Exported for tests: drives the exact counter/reconciliation logic the
  // engine's NDJSON stream drives in production.
  handleEngineEvent,
  createJobFromMapping,
  approveJob,
  runJob,
  pauseJob,
  cancelJob,
  verifyJob,
  cleanupSourceJob,
  purgeRecycleBinJob,
  restartJob,
  deleteJob,
  getJob,
};
