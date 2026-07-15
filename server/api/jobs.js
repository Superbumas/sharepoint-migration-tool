const express = require('express');
const { requireAuth, getActor, getTenantId, ownerScope, canAccessRow } = require('../auth/middleware');
const { getDb } = require('../db');
const orchestrator = require('../jobs/orchestrator');
const { mapJob } = require('../util/mapJob');
const { ensureEngineSiteAccess } = require('../graph/siteAccess');
const clog = require('../util/consoleLog');

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
  let sql = `SELECT * FROM jobs WHERE tenant_id = ?${owner.sql}`;
  const params = [getTenantId(req), ...owner.params];
  if (!includeDeleted) sql += ' AND deleted_at IS NULL';
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC';
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

router.post('/jobs/bulk-create', (req, res, next) => {
  try {
    const { mappingIds } = req.body || {};
    if (!Array.isArray(mappingIds) || !mappingIds.length) {
      return res.status(400).json({ error: 'mappingIds array is required' });
    }
    const db = getDb();
    const actor = getActor(req);
    const tenantId = getTenantId(req);
    const created = [];
    const owner = ownerScope(req);
    for (const mid of mappingIds) {
      const mapping = db.prepare(`SELECT * FROM mappings WHERE id = ? AND tenant_id = ?${owner.sql}`)
        .get(mid, tenantId, ...owner.params);
      if (!mapping) continue;
      created.push(mapJob(orchestrator.createJobFromMapping(mapping, actor)));
    }
    res.status(201).json({ items: created });
  } catch (err) { next(err); }
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
