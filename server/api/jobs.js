const express = require('express');
const { requireAuth, getActor, getTenantId, ownerScope, canAccessRow } = require('../auth/middleware');
const { getDb } = require('../db');
const orchestrator = require('../jobs/orchestrator');
const { mapJob } = require('../util/mapJob');
const { ensureEngineSiteAccess } = require('../graph/siteAccess');
const clog = require('../util/consoleLog');
const config = require('../config');
const fs = require('node:fs');
const { accessReportPath } = require('../jobs/controlFile');

const router = express.Router();
router.use(requireAuth);

// Best-effort re-check of the engine's per-site grants right before a run,
// using the clicking user's own delegated token. Catches the "engine app was
// re-provisioned since the mapping was created" case (new app identity =
// grants must be re-made) without anyone thinking about it. Never blocks the
// run - if it fails (or the user lacks Sites.FullControl.All), the engine's
// own preflight still reports the definitive error.
async function ensureJobSiteAccess(req, jobId) {
  try {
    const job = orchestrator.getJob(jobId, getTenantId(req));
    if (!job) return;
    const sites = [job.source_site_url, job.target_provider === 'azure_blob' ? null : job.target_site_url].filter(Boolean);
    for (const siteUrl of [...new Set(sites)]) {
      const result = await ensureEngineSiteAccess(req, siteUrl);
      if (result.action !== 'already-granted') {
        clog.ok('grant', `Auto-${result.action} engine access on ${siteUrl} before run`);
      }
    }
  } catch (err) {
    clog.warn('grant', `Pre-run grant check failed (${err.message}) - continuing; engine preflight will verify.`);
  }
}

// The per-user visibility gate for every /jobs/:id route: tenant check first
// (unchanged), then owner check - a member gets 404 (not 403) for a teammate's
// job, exactly like a foreign tenant's job, so the UUID's existence is never
// confirmed. Admins and legacy NULL-owner jobs pass.
function visibleJob(req, jobId) {
  const job = orchestrator.getJob(jobId, getTenantId(req));
  if (!job || !canAccessRow(req, job)) return null;
  return job;
}

router.get('/jobs', (req, res) => {
  const db = getDb();
  const includeDeleted = req.query.includeDeleted === 'true';
  const status = req.query.status;
  const owner = ownerScope(req);
  // Joined to the mapping only for its project (group) name, so the queue
  // can be filtered and run one project at a time.
  const ownerJ = ownerScope(req, 'j');
  let sql = `SELECT j.*, m.group_name FROM jobs j LEFT JOIN mappings m ON m.id = j.mapping_id WHERE j.tenant_id = ?${ownerJ.sql}`;
  const params = [getTenantId(req), ...ownerJ.params];
  if (!includeDeleted) sql += ' AND j.deleted_at IS NULL';
  if (status) { sql += ' AND j.status = ?'; params.push(status); }
  sql += ' ORDER BY j.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json({ items: rows.map(mapJob) });
});

router.get('/jobs/:id', (req, res) => {
  const row = visibleJob(req, req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(mapJob(row));
});

// Always available regardless of deleted_at - this is the audit trail, not
// the active queue. job_log/job_items carry no tenant_id of their own (see
// 004_tenants.sql) - scoped here via a join to the tenant-checked job.
router.get('/jobs/:id/log', (req, res) => {
  if (!visibleJob(req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 5000);
  const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;
  let sql = 'SELECT * FROM job_log WHERE job_id = ?';
  const params = [req.params.id];
  if (beforeId) { sql += ' AND id < ?'; params.push(beforeId); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  res.json({ items: rows.reverse() });
});

router.get('/jobs/:id/items', (req, res) => {
  if (!visibleJob(req, req.params.id)) return res.status(404).json({ error: 'not_found' });
  const db = getDb();
  const status = req.query.status;
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 5000);
  let sql = 'SELECT * FROM job_items WHERE job_id = ?';
  const params = [req.params.id];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY rowid DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  res.json({ items: rows });
});

router.post('/mappings/:mappingId/jobs', (req, res, next) => {
  try {
    const db = getDb();
    // Tenant- AND owner-scoped fetch, not a bare `WHERE id = ?` - this is what
    // actually guarantees a job can never be created from another tenant's
    // (or, for members, another teammate's) mapping; createJobFromMapping
    // trusts mapping.tenant_id precisely because it's only ever reached
    // through a lookup like this one.
    const owner = ownerScope(req);
    const mapping = db.prepare(`SELECT * FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`)
      .get(req.params.mappingId, getTenantId(req), ...owner.params);
    if (!mapping) return res.status(404).json({ error: 'mapping_not_found' });
    const job = orchestrator.createJobFromMapping(mapping, getActor(req), req.body || {});
    res.status(201).json(mapJob(job));
  } catch (err) { next(err); }
});

router.post('/jobs/bulk-create', async (req, res, next) => {
  try {
    const { mappingIds, approve, run } = req.body || {};
    if (!Array.isArray(mappingIds) || !mappingIds.length) {
      return res.status(400).json({ error: 'mappingIds array is required' });
    }
    const db = getDb();
    const actor = getActor(req);
    const tenantId = getTenantId(req);
    const created = [];
    const skipped = [];
    const owner = ownerScope(req);
    for (const mid of mappingIds) {
      const mapping = db.prepare(`SELECT * FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`)
        .get(mid, tenantId, ...owner.params);
      if (!mapping) continue;
      if (orchestrator.activeJobForMapping(mapping.id)) { skipped.push(mapping.id); continue; }
      let job = orchestrator.createJobFromMapping(mapping, actor);
      // approve: true is "create and approve" in one step for a batch - the
      // same two audit events as doing each job by hand.
      if (approve === true || run === true) job = orchestrator.approveJob(job.id, actor, tenantId);
      created.push(mapJob(job));
    }
    // run: true also sends them to the run queue (see /jobs/bulk-run).
    if (run === true && created.length > 0) {
      await queueRuns(req, created.map((j) => j.id));
    }
    res.status(201).json({ items: created, skippedActive: skipped.length, runQueued: run === true ? created.length : 0 });
  } catch (err) { next(err); }
});

// Sends approved jobs to the run queue: the orchestrator runs a few at a
// time and starts the next as each finishes. Engine site access is checked
// once per distinct site for the whole batch (same best-effort check a
// single Run does), then every job is queued and the queue is pumped once.
async function queueRuns(req, jobIds) {
  const actor = getActor(req);
  const tenantId = getTenantId(req);
  const jobs = jobIds.map((id) => visibleJob(req, id)).filter((j) => j && j.status === 'approved');
  const sites = new Set();
  for (const job of jobs) {
    if (job.source_site_url) sites.add(job.source_site_url);
    if (job.target_provider !== 'azure_blob' && job.target_site_url) sites.add(job.target_site_url);
  }
  for (const siteUrl of sites) {
    try {
      const result = await ensureEngineSiteAccess(req, siteUrl);
      if (result.action !== 'already-granted') clog.ok('grant', `Auto-${result.action} engine access on ${siteUrl} before queued run`);
    } catch (err) {
      clog.warn('grant', `Pre-run grant check failed for ${siteUrl} (${err.message}) - continuing; engine preflight will verify.`);
    }
  }
  for (const job of jobs) orchestrator.queueRun(job.id, actor, tenantId);
  orchestrator.pumpRunQueue(tenantId);
  return jobs.length;
}

// Approve (where still needed) and queue a list of jobs to run. Jobs in any
// other status than queued/approved are skipped and counted.
router.post('/jobs/bulk-run', async (req, res, next) => {
  try {
    const { jobIds } = req.body || {};
    if (!Array.isArray(jobIds) || !jobIds.length) {
      return res.status(400).json({ error: 'jobIds array is required' });
    }
    const actor = getActor(req);
    const tenantId = getTenantId(req);
    const ready = [];
    let skipped = 0;
    for (const id of jobIds) {
      const job = visibleJob(req, id);
      if (!job) continue;
      if (job.status === 'queued') { orchestrator.approveJob(job.id, actor, tenantId); ready.push(job.id); }
      else if (job.status === 'approved') ready.push(job.id);
      else skipped += 1;
    }
    const queued = await queueRuns(req, ready);
    res.json({ queued, skipped, runAtOnce: config.runQueueMaxJobs });
  } catch (err) { next(err); }
});

// "Stop the queue": takes every listed job that is still waiting back out, so
// pausing or cancelling the running ones doesn't just start the next.
router.post('/jobs/bulk-unqueue-run', (req, res, next) => {
  try {
    const { jobIds } = req.body || {};
    if (!Array.isArray(jobIds) || !jobIds.length) {
      return res.status(400).json({ error: 'jobIds array is required' });
    }
    let removed = 0;
    for (const id of jobIds) {
      const job = visibleJob(req, id);
      if (!job || job.status !== 'approved' || !job.run_queued_at) continue;
      orchestrator.unqueueRun(job.id, getActor(req), getTenantId(req));
      removed += 1;
    }
    res.json({ removed });
  } catch (err) { next(err); }
});

router.post('/jobs/:id/unqueue-run', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.unqueueRun(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

// Owner gate for every lifecycle action below: the orchestrator functions
// only check tenant_id themselves, so the per-user check lives here, at the
// route boundary, in one place.
function requireVisibleJob(req, res) {
  if (visibleJob(req, req.params.id)) return true;
  res.status(404).json({ error: 'not_found' });
  return false;
}

router.post('/jobs/:id/approve', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.approveJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/run', async (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try {
    await ensureJobSiteAccess(req, req.params.id);
    res.json(mapJob(orchestrator.runJob(req.params.id, getActor(req), getTenantId(req))));
  } catch (err) { next(err); }
});

router.post('/jobs/:id/resume', async (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try {
    await ensureJobSiteAccess(req, req.params.id);
    res.json(mapJob(orchestrator.runJob(req.params.id, getActor(req), getTenantId(req))));
  } catch (err) { next(err); }
});

router.post('/jobs/:id/cleanup-source', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.cleanupSourceJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/purge-recycle-bin', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.purgeRecycleBinJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/pause', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.pauseJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/cancel', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.cancelJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/verify', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.verifyJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

// "Repair N files": re-copy and re-check only the files the last verification flagged.
router.post('/jobs/:id/repair-files', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.repairFilesJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

// "Who had access" export: one row per grant on every source item that had
// its own permissions (collected read-only by the pre-flight). Permissions
// are not copied by the migration - this is the record of what to re-apply.
router.get('/jobs/:id/access.csv', (req, res, next) => {
  try {
    const job = visibleJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    const file = accessReportPath(job.id);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ error: 'no_access_report', message: 'No access details for this job yet - run the pre-flight check (or the job) again to collect them.' });
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const csv = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [['Path', 'Type', 'Granted to', 'Email', 'Role', 'Granted via', 'Link scope', 'Link type', 'External / guest', 'Expires', 'Password', 'Note', 'Result'].join(',')];
    for (const item of data.items || []) {
      const grants = Array.isArray(item.grants) ? item.grants : (item.grants ? [item.grants] : []);
      if (item.error) lines.push([item.path, item.type, '', '', '', '', '', '', '', '', '', `could not read permissions: ${item.error}`, ''].map(csv).join(','));
      else if (grants.length === 0) lines.push([item.path, item.type, '', '', '', '', '', '', '', '', '', 'no grants of its own (inheritance broken, nothing added)', ''].map(csv).join(','));
      for (const g of grants) {
        lines.push([item.path, item.type, g.name, g.email, g.role, g.source === 'link' ? 'sharing link' : g.source === 'group' ? 'group' : 'direct',
          g.linkScope, g.linkType, g.external ? 'yes' : '', g.expires, g.hasPassword ? 'yes' : '', '', g.result || (data.permissionCopy ? '' : 'not copied')].map(csv).join(','));
      }
    }
    const day = new Date().toISOString().slice(0, 10);
    const name = String(job.name || 'job').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'job';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name} - who had access - ${day}.csv"`);
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (err) { next(err); }
});

// "Copy item permissions" setting: { copy, includeGuests, userMap } - the
// user mapping arrives as CSV text (source UPN, target UPN per line).
router.patch('/jobs/:id/permissions-settings', (req, res, next) => {
  try {
    const job = visibleJob(req, req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    if (['running', 'paused'].includes(job.status)) return res.status(409).json({ error: 'job_running', message: 'Change the permission settings before or after a run, not during one.' });
    const body = req.body || {};
    const userMap = {};
    const bad = [];
    String(body.userMapCsv || '').split(/\r?\n/).forEach((line, i) => {
      const s = line.trim();
      if (!s || s.startsWith('#') || /^source/i.test(s)) return;
      const [a, b] = s.split(/[,;\t]/).map((x) => (x || '').trim());
      if (!a || !b || !a.includes('@') || !b.includes('@')) { bad.push(i + 1); return; }
      userMap[a.toLowerCase()] = b;
    });
    if (bad.length) return res.status(400).json({ error: 'bad_user_map', message: `User mapping line(s) ${bad.slice(0, 10).join(', ')} are not "source@x, target@y".` });
    const settings = { copy: !!body.copy, includeGuests: !!body.includeGuests, userMap };
    getDb().prepare('UPDATE jobs SET permissions_json = ? WHERE id = ?').run(JSON.stringify(settings), job.id);
    const actor = getActor(req);
    orchestrator.insertLog(job.id, { event_type: 'log', level: 'info', actor_name: actor.name, actor_email: actor.email, actor_upn: actor.upn,
      error_message: `Permission settings changed: copy item permissions ${settings.copy ? `ON, guests ${settings.includeGuests ? 'included' : 'skipped'}, ${Object.keys(userMap).length} user mapping(s)` : 'off'}` });
    res.json(mapJob(orchestrator.getJob(job.id)));
  } catch (err) { next(err); }
});

// Re-apply the recorded permissions to an already-copied job, on demand.
router.post('/jobs/:id/copy-permissions', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.copyPermissionsJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/preflight', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.preflightJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.post('/jobs/:id/restart', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { res.json(mapJob(orchestrator.restartJob(req.params.id, getActor(req), getTenantId(req)))); }
  catch (err) { next(err); }
});

router.delete('/jobs/:id', (req, res, next) => {
  if (!requireVisibleJob(req, res)) return;
  try { orchestrator.deleteJob(req.params.id, getActor(req), getTenantId(req)); res.status(204).end(); }
  catch (err) { next(err); }
});

module.exports = router;
