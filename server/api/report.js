const express = require('express');
const PDFDocument = require('pdfkit');
const { requireAuth, getActor, getTenantId, getProjectId, ownerScope, canAccessRow } = require('../auth/middleware');
const { getDb } = require('../db');
const { COLORS, Report, formatBytes, fmtDate, fmtDuration, parseDate } = require('../reports/pdf');
const { jobOutcome, fileTypeBreakdown, buildClientData, PROBLEM_LABEL, sourceRoot } = require('../reports/data');
const { renderClientPdf } = require('../reports/clientPdf');
const { renderClientXlsx } = require('../reports/clientXlsx');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Internal (operator) job report: everything that happened on one job -
// mapping, final outcome, how it got there (runs, retries, copy vs already
// present), verification with expected Office/Outlook rewrites separated
// out, metadata warnings, source cleanup, problem lists, timeline and the
// complete file inventory. The client-facing report is further down.
// ---------------------------------------------------------------------------

const ITEM_STATUS = {
  success: { text: 'copied', color: COLORS.green },
  skipped: { text: 'already there', color: COLORS.green },
  failed: { text: 'failed', color: COLORS.red },
  retried: { text: 'unfinished', color: COLORS.amber },
  pending: { text: 'unfinished', color: COLORS.amber },
};

function filesPerMin(files, ms) {
  const v = files / Math.max(1 / 60, ms / 60000);
  return v >= 10 ? Math.round(v).toLocaleString() : v.toFixed(1);
}

router.get('/jobs/:id/report.pdf', (req, res, next) => {
  try {
    const db = getDb();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?').get(req.params.id, getTenantId(req));
    if (!job || !canAccessRow(req, job)) return res.status(404).json({ error: 'not_found' });
    const mapping = job.mapping_id ? db.prepare('SELECT * FROM mappings WHERE id = ?').get(job.mapping_id) : null;
    const outcome = jobOutcome(db, job);
    const { items, ver, verification } = outcome;
    const lifecycle = db.prepare(
      `SELECT ts, event_type, actor_name, error_message FROM job_log WHERE job_id = ? AND event_type IN
       ('job_created','job_approved','job_run','job_started','job_paused','job_resumed','job_restarted','job_interrupted',
        'job_completed','job_failed','job_cancelled','verify_started','verification_summary','cleanup_started','cleanup_summary',
        'purge_started','purge_summary')
       ORDER BY rowid`
    ).all(job.id);
    const keptRows = db.prepare(
      `SELECT source_path, error_message FROM job_log WHERE job_id = ? AND event_type = 'source_kept' ORDER BY rowid`
    ).all(job.id);
    // Copy succeeded but Created/Modified/Author/Editor could not be stamped
    // onto the target item - the closest thing to a "partial" outcome.
    const metadataWarnings = db.prepare(
      `SELECT COUNT(*) AS n FROM job_log WHERE job_id = ? AND event_type = 'log' AND error_message LIKE 'Copied OK but could not preserve%'`
    ).get(job.id).n;
    let cleanup = null;
    try { cleanup = JSON.parse(job.cleanup_json || 'null'); } catch {}

    const isBlob = (job.target_provider || 'sharepoint') === 'azure_blob';
    const isOneDrive = job.target_provider === 'onedrive';
    const isFsSource = job.source_provider === 'filesystem';
    const targetDesc = isBlob
      ? `azure-blob://${job.target_container}/${job.target_blob_prefix || ''}`
      : isOneDrive
        ? `OneDrive of ${job.target_onedrive_upn} / ${job.target_onedrive_path || ''}`
        : `${job.target_site_url} / ${job.target_library}/${job.target_path}`;
    const sourceDesc = isFsSource ? job.source_path : `${job.source_site_url} / ${job.source_library}/${job.source_path}`;
    const pathPrefix = sourceRoot(job);
    const rel = (p) => {
      const s = String(p || '').replace(/\\/g, '/');
      return pathPrefix && s.toLowerCase().startsWith(pathPrefix.toLowerCase()) ? s.slice(pathPrefix.length) : s;
    };

    const copied = items.filter((i) => i.status === 'success').length;
    const alreadyThere = items.filter((i) => i.status === 'skipped').length;
    const started = parseDate(job.started_at);
    const ended = parseDate(job.completed_at);
    const elapsedMs = started && ended ? ended - started : null;
    const runs = job.run_seq || lifecycle.filter((e) => ['job_run', 'job_resumed'].includes(e.event_type)).length;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="migration-report-${job.id.slice(0, 8)}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 46, right: 46 }, bufferPages: true });
    doc.pipe(res);
    const r = new Report(doc);

    // --- Title block ------------------------------------------------------
    doc.fontSize(19).fillColor(COLORS.ink).font('Helvetica-Bold').text('Migration Report (internal)');
    doc.moveDown(0.15);
    doc.fontSize(10).fillColor(COLORS.muted).font('Helvetica').text(job.name);
    doc.moveDown(0.1);
    doc.fontSize(8).fillColor(COLORS.faint).text(`Generated ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}  ·  Job ${job.id}`);
    doc.moveTo(r.left, doc.y + 6).lineTo(r.left + r.width, doc.y + 6).lineWidth(2).strokeColor(COLORS.ink).stroke();
    doc.moveDown(1);

    // --- Outcome ----------------------------------------------------------
    r.section('Final outcome');
    const statusColor = job.status === 'completed' ? COLORS.green : job.status === 'failed' ? COLORS.red : COLORS.amber;
    r.statCards([
      ['Status', job.status.toUpperCase(), statusColor],
      ['At destination', outcome.migrated.length.toLocaleString(), COLORS.ink, `of ${items.length.toLocaleString()} files seen`],
      ['Data', formatBytes(outcome.bytes), COLORS.ink, job.total_bytes ? `of ${formatBytes(job.total_bytes)} enumerated` : undefined],
      ['Not migrated', outcome.notMigrated.length.toLocaleString(), outcome.notMigrated.length > 0 ? COLORS.red : COLORS.green],
      ['Verification', ver.state === 'verified' ? 'PASSED' : ver.state === 'exceptions' ? `${ver.problemCount} ISSUES` : 'NOT RUN',
        ver.state === 'verified' ? COLORS.green : ver.state === 'exceptions' ? COLORS.red : COLORS.amber],
    ], { height: 50 });
    r.kv([
      ['How it got there', `${copied.toLocaleString()} copied · ${alreadyThere.toLocaleString()} already present at the target (skipped on a later run)`],
      ['Runs', `${runs} engine run(s) · ${(job.retries_total ?? 0).toLocaleString()} retries · ${outcome.items.filter((i) => i.attempt_count > 1).length.toLocaleString()} file(s) needed more than one attempt`],
      ['Elapsed', elapsedMs ? `${fmtDuration(elapsedMs)} (first start to completion${runs > 1 ? ', including time paused between runs' : ''})` : '-'],
      ['Throughput', elapsedMs && outcome.bytes ? `${formatBytes(outcome.bytes / (elapsedMs / 1000))}/s average · ${filesPerMin(outcome.migrated.length, elapsedMs)} files/min` : '-'],
      ['Metadata', metadataWarnings === 0
        ? 'Original created/modified dates and people preserved on every copied file (no warnings)'
        : `${metadataWarnings.toLocaleString()} file(s) copied but original created/modified/author could not be stamped - see audit log`,
      metadataWarnings === 0 ? COLORS.green : COLORS.amber],
    ]);

    // --- Mapping ----------------------------------------------------------
    r.section('Mapping');
    r.kv([
      ['Source', sourceDesc],
      ['Target', targetDesc],
      ['Target type', isBlob ? 'Azure Blob Storage (archive)' : isOneDrive ? 'OneDrive' : 'SharePoint Online'],
      ['Action', `${job.action} (copy-only engine; source cleanup is a separate verified step)`],
      ['Mapping origin', mapping ? `${mapping.origin}${mapping.confidence ? ` (confidence: ${mapping.confidence})` : ''}` : '-'],
      ['Notes', mapping?.notes || '-'],
      ['Created', `${fmtDate(job.created_at)} by ${job.created_by_name || '-'}`],
      ['Approved', job.approved_at ? `${fmtDate(job.approved_at)} by ${job.approved_by_name || '-'}` : '-'],
      ['Started / completed', `${fmtDate(job.started_at)}  to  ${fmtDate(job.completed_at)}`],
    ]);

    // --- Verification -----------------------------------------------------
    r.section('Verification (content-hash comparison)');
    if (verification) {
      r.kv([
        ['Result', ver.state === 'verified' ? 'PASSED - every file accounted for' : `${ver.problemCount} PROBLEM(S) FOUND`, ver.state === 'verified' ? COLORS.green : COLORS.red],
        ['Files compared', `${ver.sourceFiles.toLocaleString()} source vs ${ver.targetFiles.toLocaleString()} target`],
        ['Hash-identical', ver.identical.toLocaleString()],
        ['Office/Outlook re-stamped', `${ver.expectedRewrites.toLocaleString()} (SharePoint rewrites document properties on ingestion - content intact, expected)`],
        ...(ver.reclassified > 0 ? [['Reclassified', `${ver.reclassified} .msg/Office file(s) the original check flagged as size/hash mismatches are counted as expected rewrites here (verified before .msg was recognised)`, COLORS.muted]] : []),
        ['Missing / size / hash', `${verification.missing ?? 0} / ${verification.sizeMismatch ?? 0} / ${verification.hashMismatch ?? 0} (as recorded by the engine)`],
        ['Verified at', fmtDate(job.verified_at)],
        ['Method', isBlob ? 'MD5 computed from the bytes streamed at copy time, stored as each blob\'s Content-MD5' : 'QuickXorHash computed server-side by SharePoint on both copies'],
      ]);
    } else {
      r.kv([['Result', 'Not verified yet', COLORS.amber]]);
    }

    // --- Source cleanup ----------------------------------------------------
    r.section('Source cleanup (archive-move)');
    if (cleanup) {
      r.kv([
        ['Files recycled', `${(cleanup.deleted ?? 0).toLocaleString()} (moved to the source site recycle bin${cleanup.purged == null ? ' - recoverable, never permanently deleted' : ''})`],
        ['Files kept', String(cleanup.kept ?? 0), cleanup.kept > 0 ? COLORS.amber : COLORS.green],
        ['Emptied folders removed', String(cleanup.foldersDeleted ?? 0)],
        ['Cleaned at', fmtDate(job.cleaned_at)],
        ['Recycle-bin purge', cleanup.purged != null
          ? `${cleanup.purged.toLocaleString()} item(s) permanently purged (${formatBytes(cleanup.purgedBytes)}) at ${fmtDate(cleanup.purgedAt)} - storage reclaimed`
          : 'Not purged - recycled items remain recoverable and still count toward storage quota for up to 93 days',
        cleanup.purged != null ? COLORS.green : COLORS.muted],
        ['Safety rule', 'Each file was individually re-verified against its migrated copy immediately before deletion.'],
      ]);
    } else {
      r.kv([['Result', 'Source files not removed - source remains intact.', COLORS.muted]]);
    }

    // --- Problems ----------------------------------------------------------
    if (outcome.notMigrated.length > 0 || keptRows.length > 0) {
      r.section(`Attention required (${outcome.notMigrated.length + keptRows.length})`, { color: COLORS.red });
      if (outcome.notMigrated.length > 0) {
        r.table(
          ['Not migrated', 'Reason', 'Detail'],
          [r.width * 0.45, r.width * 0.2, r.width * 0.35],
          outcome.notMigrated.map((n) => [{ text: n.path, color: COLORS.red }, PROBLEM_LABEL[n.reason] || n.reason, n.detail || '-'])
        );
        if (ver.truncated) r.paragraph('The engine lists at most 200 verification problems; the counts above are complete.', { color: COLORS.muted, size: 8 });
        doc.moveDown(0.5);
      }
      if (keptRows.length > 0) {
        r.table(
          ['Kept at source (cleanup)', 'Reason'],
          [r.width * 0.55, r.width * 0.45],
          keptRows.map((k) => [{ text: rel(k.source_path), color: COLORS.amber }, k.error_message || '-'])
        );
      }
    }

    // --- Content profile ---------------------------------------------------
    if (outcome.migrated.length > 0) {
      r.section('Content profile');
      r.bars(fileTypeBreakdown(outcome.migrated).map((t) => [t.ext, t.count, `${t.count.toLocaleString()} · ${formatBytes(t.bytes)}`]));
      doc.moveDown(0.4);
      const largest = [...outcome.migrated].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 10);
      r.table(
        ['Largest files', 'Size', 'Copy time'],
        [r.width * 0.72, r.width * 0.14, r.width * 0.14],
        largest.map((f) => [f.path, formatBytes(f.size), f.item.duration_ms ? `${(f.item.duration_ms / 1000).toFixed(1)}s` : '-']),
        { aligns: ['left', 'right', 'right'] }
      );
    }

    // --- Timeline ----------------------------------------------------------
    r.section('Timeline');
    r.table(
      ['Time', 'Event', 'By'],
      [r.width * 0.22, r.width * 0.53, r.width * 0.25],
      lifecycle.map((e) => [
        fmtDate(e.ts),
        e.event_type.replace(/^job_/, '').replace(/_/g, ' ') + (e.error_message && e.event_type === 'job_failed' ? ` - ${e.error_message}` : ''),
        e.actor_name || '-',
      ]),
      { rowHeight: 12 }
    );

    // --- File inventory ----------------------------------------------------
    doc.addPage();
    r.section(`File inventory (${items.length.toLocaleString()} files)`);
    if (pathPrefix) {
      doc.fontSize(7.5).fillColor(COLORS.muted).text(r.fit(`Paths relative to ${pathPrefix}`, r.width, 7.5), r.left, doc.y, { lineBreak: false });
      doc.y += 12;
    }
    r.table(
      ['#', 'File', 'Size', 'Tries', 'Status'],
      [r.width * 0.06, r.width * 0.65, r.width * 0.1, r.width * 0.06, r.width * 0.13],
      items.map((i, idx) => {
        const st = ITEM_STATUS[i.status] || { text: i.status, color: COLORS.muted };
        return [String(idx + 1), rel(i.source_path), formatBytes(i.size_bytes), String(Math.max(1, i.attempt_count || 1)), st];
      }),
      { rowHeight: 11, fontSize: 6.5, aligns: ['right', 'left', 'right', 'right', 'left'] }
    );

    r.footer(job.name);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Client-facing report across one or more migrated folders (one job each):
// what moved, where to, how much, and that it was verified. Built only from
// stored data, so it works for any job that has already finished.
//
//   ?jobs=id1,id2   which jobs (default: every completed job in scope)
//   ?client=Name    name on the cover (default: the project name)
//   ?inventory=1|0  force the per-file list in the PDF on/off
// ---------------------------------------------------------------------------

function resolveClientReport(req) {
  const db = getDb();
  const tenantId = getTenantId(req);
  const owner = ownerScope(req);
  const ids = String(req.query.jobs || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
  const jobs = ids.length
    ? db.prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})${owner.sql}`).all(tenantId, ...ids, ...owner.params)
    : db.prepare(`SELECT * FROM jobs WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'completed'${owner.sql}`).all(tenantId, ...owner.params);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(getProjectId(req) || '')
    || db.prepare('SELECT name FROM projects WHERE tenant_id = ?').get(tenantId);
  const client = String(req.query.client || '').trim().slice(0, 120) || project?.name || null;
  return { db, jobs, client };
}

function reportFilename(client, ext) {
  const day = new Date().toISOString().slice(0, 10);
  const safe = String(client || 'Migration').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'Migration';
  return `${safe} - Migration report - ${day}.${ext}`;
}

router.get('/reports/client.pdf', (req, res, next) => {
  try {
    const { db, jobs, client } = resolveClientReport(req);
    if (jobs.length === 0) return res.status(404).json({ error: 'no_jobs', message: 'No completed migrations to report on.' });
    const data = buildClientData(db, jobs);
    const inventory = req.query.inventory === '1' ? true : req.query.inventory === '0' ? false : undefined;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(client, 'pdf')}"`);
    renderClientPdf(res, data, { title: 'Migration report', client, preparedBy: getActor(req).name, inventory });
  } catch (err) {
    next(err);
  }
});

router.get('/reports/client.xlsx', (req, res, next) => {
  try {
    const { db, jobs, client } = resolveClientReport(req);
    if (jobs.length === 0) return res.status(404).json({ error: 'no_jobs', message: 'No completed migrations to report on.' });
    const buf = renderClientXlsx(buildClientData(db, jobs), { title: 'Migration report', client });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFilename(client, 'xlsx')}"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
