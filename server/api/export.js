const express = require('express');
const { requireAuth, getTenantId } = require('../auth/middleware');
const { getDb } = require('../db');

const router = express.Router();
router.use(requireAuth);

const COLUMNS = [
  'id', 'job_id', 'job_name', 'item_id', 'event_type', 'source_path', 'target_path', 'action',
  'outcome', 'bytes', 'duration_ms', 'http_status', 'error_message', 'retry_count',
  'actor_name', 'actor_email', 'actor_upn', 'ts',
];

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// The master audit log - works across all jobs (including ones deleted from
// the active queue view, since job_log rows are never removed) or scoped to
// a single job. This is what gets handed to compliance/IT after a run.
router.get('/export/audit', (req, res, next) => {
  try {
    const db = getDb();
    const { jobId, since, until, format = 'csv' } = req.query;

    // j.tenant_id is unconditional, not folded into the optional `where`
    // list below - job_log has no tenant_id of its own (see
    // 004_tenants.sql), so without this every tenant's entire audit
    // history would be exportable by any authenticated user regardless of
    // which other filters they passed.
    let sql = `SELECT l.*, j.name AS job_name FROM job_log l JOIN jobs j ON j.id = l.job_id WHERE j.tenant_id = ?`;
    const where = [];
    const params = [getTenantId(req)];
    if (jobId) { where.push('l.job_id = ?'); params.push(jobId); }
    if (since) { where.push('l.ts >= ?'); params.push(since); }
    if (until) { where.push('l.ts <= ?'); params.push(until); }
    if (where.length) sql += ' AND ' + where.join(' AND ');
    sql += ' ORDER BY l.id ASC';

    const rows = db.prepare(sql).all(...params);

    const filenameBase = `audit-log${jobId ? `-${jobId}` : '-all'}`;

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
      return res.json({ exportedAt: new Date().toISOString(), count: rows.length, items: rows });
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
    res.write(COLUMNS.join(',') + '\n');
    for (const row of rows) {
      res.write(COLUMNS.map((c) => csvEscape(row[c])).join(',') + '\n');
    }
    res.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
