const express = require('express');
const { requireAuth, getTenantId, ownerScope, canAccessRow } = require('../auth/middleware');
const { getDb } = require('../db');
const { classifyError } = require('../util/errorClassify');
const config = require('../config');

const router = express.Router();
router.use(requireAuth);

const ROLLING_WINDOW_SECONDS = 60;

// job_log/job_items carry no tenant_id of their own (see 004_tenants.sql) -
// when scoped to one specific job (jobIdFilter set) that job was already
// tenant-checked by the caller, but the "across everything" global case
// needs an explicit join to jobs to avoid aggregating another tenant's rows.
function rollingThroughput(db, jobIdFilter, tenantId, owner) {
  const params = [];
  let sql = 'SELECT COUNT(*) AS files, COALESCE(SUM(l.bytes), 0) AS bytes FROM job_log l';
  if (!jobIdFilter) sql += ' JOIN jobs j ON j.id = l.job_id';
  sql += ` WHERE l.event_type = 'item_success' AND l.ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now',?)`;
  params.push(`-${ROLLING_WINDOW_SECONDS} seconds`);
  // `owner` is an ownerScope(req, 'j') fragment - per-user dashboards must
  // not aggregate a teammate's throughput.
  if (jobIdFilter) { sql += ' AND l.job_id = ?'; params.push(jobIdFilter); }
  else { sql += ' AND j.tenant_id = ?'; params.push(tenantId); if (owner) { sql += owner.sql; params.push(...owner.params); } }
  const row = db.prepare(sql).get(...params);
  const filesPerMin = (row.files / ROLLING_WINDOW_SECONDS) * 60;
  const mbPerMin = (row.bytes / (1024 * 1024) / ROLLING_WINDOW_SECONDS) * 60;
  return { filesPerMin: round2(filesPerMin), mbPerMin: round2(mbPerMin) };
}

function round2(n) { return Math.round(n * 100) / 100; }

function errorBreakdown(db, jobIdFilter) {
  const params = [];
  let sql = `SELECT http_status, error_message FROM job_log WHERE event_type IN ('item_failed','item_retry')`;
  if (jobIdFilter) { sql += ' AND job_id = ?'; params.push(jobIdFilter); }
  const rows = db.prepare(sql).all(...params);
  const breakdown = { throttled: 0, permission_denied: 0, name_too_long: 0, file_locked: 0, other: 0 };
  for (const r of rows) breakdown[classifyError(r.http_status, r.error_message)]++;
  return breakdown;
}

function retryDistribution(db, jobIdFilter, tenantId, owner) {
  const params = [];
  let sql = 'SELECT ji.attempt_count FROM job_items ji';
  if (!jobIdFilter) sql += ' JOIN jobs j ON j.id = ji.job_id';
  if (jobIdFilter) { sql += ' WHERE ji.job_id = ?'; params.push(jobIdFilter); }
  else { sql += ' WHERE j.tenant_id = ?'; params.push(tenantId); if (owner) { sql += owner.sql; params.push(...owner.params); } }
  const rows = db.prepare(sql).all(...params);
  const dist = { '0': 0, '1': 0, '2': 0, '3+': 0 };
  for (const r of rows) {
    const retries = Math.max(0, (r.attempt_count || 1) - 1);
    if (retries === 0) dist['0']++;
    else if (retries === 1) dist['1']++;
    else if (retries === 2) dist['2']++;
    else dist['3+']++;
  }
  return dist;
}

function buildJobKpis(db, job) {
  const throughput = rollingThroughput(db, job.id);
  const totalItems = job.total_items || 0;
  const done = job.items_done + job.items_skipped;
  const remainingItems = Math.max(0, totalItems - done);
  const etaSeconds = throughput.filesPerMin > 0 ? Math.round((remainingItems / throughput.filesPerMin) * 60) : null;

  const processed = job.items_done + job.items_failed + job.items_skipped;
  const successRate = processed > 0 ? round2((job.items_done / processed) * 100) : null;
  const errorRate = processed > 0 ? round2((job.items_failed / processed) * 100) : null;

  const longestRunning = db.prepare(
    `SELECT source_path, target_path, duration_ms FROM job_items WHERE job_id = ? AND duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 10`
  ).all(job.id);
  const largestFiles = db.prepare(
    `SELECT source_path, target_path, size_bytes FROM job_items WHERE job_id = ? AND size_bytes IS NOT NULL ORDER BY size_bytes DESC LIMIT 10`
  ).all(job.id);
  const slowItems = db.prepare(
    `SELECT source_path, target_path, duration_ms FROM job_items WHERE job_id = ? AND duration_ms >= ? ORDER BY duration_ms DESC LIMIT 25`
  ).all(job.id, config.slowTransferThresholdMs);

  return {
    jobId: job.id,
    status: job.status,
    throughput,
    successRatePct: successRate,
    errorRatePct: errorRate,
    errorBreakdown: errorBreakdown(db, job.id),
    retryDistribution: retryDistribution(db, job.id),
    files: { done, total: totalItems, remaining: remainingItems, failed: job.items_failed, skipped: job.items_skipped },
    bytes: { done: job.bytes_done, total: job.total_bytes },
    etaSeconds,
    longestRunningItems: longestRunning,
    largestFiles,
    slowItems,
    slowThresholdMs: config.slowTransferThresholdMs,
  };
}

router.get('/kpis/jobs/:id', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?').get(req.params.id, getTenantId(req));
  if (!job || !canAccessRow(req, job)) return res.status(404).json({ error: 'not_found' });
  res.json(buildJobKpis(db, job));
});

router.get('/kpis/global', (req, res) => {
  const db = getDb();
  // "Global" here means "everything THIS USER can see": all of the tenant
  // for admins, own + legacy rows for members - the dashboard is per-user.
  const owner = ownerScope(req, 'j');
  const bareOwner = ownerScope(req);
  const jobs = db.prepare(`SELECT * FROM jobs WHERE tenant_id = ?${bareOwner.sql}`)
    .all(getTenantId(req), ...bareOwner.params);
  const active = jobs.filter((j) => !j.deleted_at);

  const totals = active.reduce(
    (acc, j) => {
      acc.itemsDone += j.items_done;
      acc.itemsFailed += j.items_failed;
      acc.itemsSkipped += j.items_skipped;
      acc.bytesDone += j.bytes_done;
      acc.totalItems += j.total_items || 0;
      acc.totalBytes += j.total_bytes || 0;
      acc.retriesTotal += j.retries_total;
      return acc;
    },
    { itemsDone: 0, itemsFailed: 0, itemsSkipped: 0, bytesDone: 0, totalItems: 0, totalBytes: 0, retriesTotal: 0 }
  );

  const statusCounts = active.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  const throughput = rollingThroughput(db, null, getTenantId(req), owner);
  const processed = totals.itemsDone + totals.itemsFailed + totals.itemsSkipped;

  // Current-state error breakdown: classify items that are failed RIGHT NOW,
  // not every historical item_failed/item_retry log line - a job that failed
  // once and was then fixed and re-run to completion should not keep painting
  // hundreds of stale errors on the dashboard forever.
  const failedItems = db.prepare(
    `SELECT ji.http_status, ji.error_message FROM job_items ji
     JOIN jobs j ON j.id = ji.job_id
     WHERE ji.status = 'failed' AND j.deleted_at IS NULL AND j.tenant_id = ?${owner.sql}`
  ).all(getTenantId(req), ...owner.params);
  const currentErrorBreakdown = { throttled: 0, permission_denied: 0, name_too_long: 0, file_locked: 0, other: 0 };
  for (const r of failedItems) currentErrorBreakdown[classifyError(r.http_status, r.error_message)]++;

  // Verification outcomes across completed jobs.
  const verification = { verified: 0, problems: 0, unverified: 0 };
  for (const j of active.filter((x) => x.status === 'completed')) {
    if (!j.verification_json) { verification.unverified++; continue; }
    try { JSON.parse(j.verification_json).ok ? verification.verified++ : verification.problems++; }
    catch { verification.unverified++; }
  }

  const inFlight = active.filter((j) => ['running', 'paused', 'queued', 'approved'].includes(j.status)).length;

  const recentJobs = active
    .slice()
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 8)
    .map((j) => {
      let verificationOk = null;
      if (j.verification_json) { try { verificationOk = !!JSON.parse(j.verification_json).ok; } catch {} }
      return {
        id: j.id, name: j.name, status: j.status,
        itemsDone: j.items_done, itemsSkipped: j.items_skipped, itemsFailed: j.items_failed,
        totalItems: j.total_items, bytesDone: j.bytes_done,
        createdAt: j.created_at, completedAt: j.completed_at, verificationOk,
      };
    });

  res.json({
    statusCounts,
    throughput,
    successRatePct: processed > 0 ? round2((totals.itemsDone / processed) * 100) : null,
    errorRatePct: processed > 0 ? round2((totals.itemsFailed / processed) * 100) : null,
    errorBreakdown: currentErrorBreakdown,
    retryDistribution: retryDistribution(db, null, getTenantId(req), owner),
    files: { done: totals.itemsDone + totals.itemsSkipped, total: totals.totalItems, remaining: Math.max(0, totals.totalItems - totals.itemsDone - totals.itemsSkipped), failed: totals.itemsFailed, skipped: totals.itemsSkipped },
    bytes: { done: totals.bytesDone, total: totals.totalBytes },
    retriesTotal: totals.retriesTotal,
    jobCount: active.length,
    inFlight,
    verification,
    recentJobs,
  });
});

module.exports = router;
