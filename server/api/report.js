const express = require('express');
const PDFDocument = require('pdfkit');
const { requireAuth, getTenantId } = require('../auth/middleware');
const { getDb } = require('../db');

const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Full migration report as a real PDF: mapping details, timeline, statistics,
// verification, source cleanup, failure/kept lists, and the complete file
// inventory. Built with pdfkit (pure JS, no browser dependency) so it can be
// attached to a client email / filed for compliance as-is.
// ---------------------------------------------------------------------------

const COLORS = {
  ink: '#1e293b', muted: '#64748b', faint: '#94a3b8',
  line: '#e2e8f0', headBg: '#f1f5f9', zebra: '#f8fafc',
  green: '#15803d', red: '#b91c1c', amber: '#b45309', blue: '#1d4ed8',
};

function formatBytes(n) {
  if (!n && n !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}
function fmtDate(s) {
  if (!s) return '-';
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? s : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

class Report {
  constructor(doc) {
    this.doc = doc;
    this.left = doc.page.margins.left;
    this.width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    this.bottom = () => doc.page.height - doc.page.margins.bottom;
  }
  ensure(height) {
    if (this.doc.y + height > this.bottom()) this.doc.addPage();
  }
  // Guaranteed single line: pdfkit wraps text to `width` even with
  // lineBreak:false, which made long file paths spill into the row below.
  // Measure and hard-truncate (keeping the tail - the filename end is the
  // informative part of a path) before drawing.
  fit(text, width, fontSize, font = 'Helvetica') {
    const s = String(text ?? '');
    this.doc.font(font).fontSize(fontSize);
    if (this.doc.widthOfString(s) <= width) return s;
    let t = s;
    while (t.length > 1 && this.doc.widthOfString(`…${t}`) > width) {
      t = t.slice(Math.max(1, Math.floor(t.length * 0.1)));
    }
    return `…${t}`;
  }
  section(title) {
    this.ensure(40);
    const { doc } = this;
    doc.moveDown(0.8);
    doc.fontSize(11).fillColor(COLORS.ink).font('Helvetica-Bold').text(title.toUpperCase(), this.left, doc.y, { characterSpacing: 0.5 });
    doc.moveTo(this.left, doc.y + 2).lineTo(this.left + this.width, doc.y + 2).lineWidth(1).strokeColor(COLORS.line).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica');
  }
  kv(rows) {
    const { doc } = this;
    const labelW = 150;
    for (const [label, value, color] of rows) {
      this.ensure(16);
      const y = doc.y;
      doc.fontSize(8.5).fillColor(COLORS.muted).text(label, this.left, y, { width: labelW });
      doc.fontSize(8.5).fillColor(color || COLORS.ink).text(String(value ?? '-'), this.left + labelW, y, { width: this.width - labelW });
      doc.y = Math.max(doc.y, y + 13);
    }
  }
  statCards(stats) {
    const { doc } = this;
    this.ensure(52);
    const gap = 8;
    const cardW = (this.width - gap * (stats.length - 1)) / stats.length;
    const y = doc.y;
    stats.forEach(([label, value, color], i) => {
      const x = this.left + i * (cardW + gap);
      doc.roundedRect(x, y, cardW, 42, 4).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      doc.fontSize(7).fillColor(COLORS.muted).font('Helvetica')
        .text(this.fit(label.toUpperCase(), cardW - 16, 7), x + 8, y + 7, { width: cardW - 16, lineBreak: false });
      // Shrink long values (e.g. "COMPLETED") until they fit on one line
      // instead of wrapping inside the card.
      let size = 13;
      doc.font('Helvetica-Bold');
      while (size > 7 && doc.fontSize(size).widthOfString(String(value)) > cardW - 16) size -= 1;
      doc.fontSize(size).fillColor(color || COLORS.ink)
        .text(String(value), x + 8, y + 33 - size, { width: cardW - 16, lineBreak: false });
      doc.font('Helvetica');
    });
    doc.y = y + 50;
  }
  table(headers, widths, rows, opts = {}) {
    const { doc } = this;
    const rowH = opts.rowHeight || 13;
    const fontSize = opts.fontSize || 7;
    const drawHead = () => {
      const y = doc.y;
      doc.rect(this.left, y, this.width, rowH).fillColor(COLORS.headBg).fill();
      let x = this.left;
      headers.forEach((h, i) => {
        const fitted = this.fit(h, widths[i] - 8, fontSize, 'Helvetica-Bold');
        doc.fontSize(fontSize).fillColor(COLORS.muted).font('Helvetica-Bold')
          .text(fitted, x + 4, y + 3, { width: widths[i] - 8, align: opts.aligns?.[i] || 'left', lineBreak: false });
        x += widths[i];
      });
      doc.font('Helvetica');
      doc.y = y + rowH;
    };
    drawHead();
    rows.forEach((row, r) => {
      if (doc.y + rowH > this.bottom()) { doc.addPage(); drawHead(); }
      const y = doc.y;
      if (r % 2 === 1) { doc.rect(this.left, y, this.width, rowH).fillColor(COLORS.zebra).fill(); }
      let x = this.left;
      row.forEach((cell, i) => {
        const isObj = cell && typeof cell === 'object';
        // fit() guarantees one line per cell - pdfkit wraps to `width` even
        // with lineBreak:false, which used to pile rows on top of each other.
        const fitted = this.fit(isObj ? cell.text : cell, widths[i] - 8, fontSize);
        doc.fontSize(fontSize).fillColor(isObj ? cell.color : COLORS.ink)
          .text(fitted, x + 4, y + 3, { width: widths[i] - 8, align: opts.aligns?.[i] || 'left', lineBreak: false });
        x += widths[i];
      });
      doc.y = y + rowH;
    });
  }
}

router.get('/jobs/:id/report.pdf', (req, res, next) => {
  try {
    const db = getDb();
    const job = db.prepare('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?').get(req.params.id, getTenantId(req));
    if (!job) return res.status(404).json({ error: 'not_found' });
    const mapping = job.mapping_id ? db.prepare('SELECT * FROM mappings WHERE id = ?').get(job.mapping_id) : null;
    const items = db.prepare('SELECT source_path, target_path, status, size_bytes, duration_ms, error_message FROM job_items WHERE job_id = ? ORDER BY source_path').all(job.id);
    const lifecycle = db.prepare(
      `SELECT ts, event_type, actor_name, error_message FROM job_log WHERE job_id = ? AND event_type IN
       ('job_created','job_approved','job_run','job_started','job_paused','job_resumed','job_restarted','job_interrupted',
        'job_completed','job_failed','job_cancelled','verify_started','verification_summary','cleanup_started','cleanup_summary')
       ORDER BY rowid`
    ).all(job.id);
    const keptRows = db.prepare(
      `SELECT source_path, error_message FROM job_log WHERE job_id = ? AND event_type = 'source_kept' ORDER BY rowid`
    ).all(job.id);
    let verification = null, cleanup = null;
    try { verification = JSON.parse(job.verification_json || 'null'); } catch {}
    try { cleanup = JSON.parse(job.cleanup_json || 'null'); } catch {}

    const isBlob = (job.target_provider || 'sharepoint') === 'azure_blob';
    const targetDesc = isBlob
      ? `azure-blob://${job.target_container}/${job.target_blob_prefix || ''}`
      : `${job.target_site_url} / ${job.target_library}/${job.target_path}`;

    // Every item path repeats the same server-relative root - strip it once
    // and say so in the table header, so the column shows the part that
    // actually differs between rows.
    let pathPrefix = '';
    try {
      pathPrefix = `${new URL(job.source_site_url).pathname}/${job.source_library}/${job.source_path}/`
        .replace(/\/{2,}/g, '/');
    } catch {}
    const relPath = (p) => (pathPrefix && p?.startsWith(pathPrefix) ? p.slice(pathPrefix.length) : p);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="migration-report-${job.id.slice(0, 8)}.pdf"`);

    const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 46, right: 46 }, bufferPages: true });
    doc.pipe(res);
    const r = new Report(doc);

    // --- Title block ------------------------------------------------------
    doc.fontSize(19).fillColor(COLORS.ink).font('Helvetica-Bold').text('Migration Report');
    doc.moveDown(0.15);
    doc.fontSize(10).fillColor(COLORS.muted).font('Helvetica').text(job.name);
    doc.moveDown(0.1);
    doc.fontSize(8).fillColor(COLORS.faint).text(`Generated ${new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}  ·  Job ${job.id}`);
    doc.moveTo(r.left, doc.y + 6).lineTo(r.left + r.width, doc.y + 6).lineWidth(2).strokeColor(COLORS.ink).stroke();
    doc.moveDown(1);

    // --- Mapping ----------------------------------------------------------
    r.section('Mapping');
    r.kv([
      ['Source site', job.source_site_url],
      ['Source path', `${job.source_library}/${job.source_path}`],
      ['Target', targetDesc],
      ['Target type', isBlob ? 'Azure Blob Storage (archive)' : 'SharePoint Online'],
      ['Action', `${job.action} (copy-only engine; source cleanup is a separate verified step)`],
      ['Mapping origin', mapping ? `${mapping.origin}${mapping.confidence ? ` (confidence: ${mapping.confidence})` : ''}` : '-'],
      ['Notes', mapping?.notes || '-'],
    ]);

    // --- Outcome ----------------------------------------------------------
    r.section('Outcome');
    const statusColor = job.status === 'completed' ? COLORS.green : job.status === 'failed' ? COLORS.red : COLORS.amber;
    r.statCards([
      ['Status', job.status.toUpperCase(), statusColor],
      ['Files migrated', (job.items_done ?? 0).toLocaleString()],
      ['Data volume', formatBytes(job.bytes_done)],
      ['Failed', String(job.items_failed ?? 0), job.items_failed > 0 ? COLORS.red : COLORS.green],
      ['Skipped', String(job.items_skipped ?? 0)],
      ['Retries', String(job.retries_total ?? 0)],
    ]);
    r.kv([
      ['Created', `${fmtDate(job.created_at)} by ${job.created_by_name || '-'}`],
      ['Approved', job.approved_at ? `${fmtDate(job.approved_at)} by ${job.approved_by_name || '-'}` : '-'],
      ['Completed', fmtDate(job.completed_at)],
    ]);

    // --- Verification -----------------------------------------------------
    r.section('Verification (content-hash comparison)');
    if (verification) {
      const problems = (verification.missing ?? 0) + (verification.sizeMismatch ?? 0) + (verification.hashMismatch ?? 0);
      r.kv([
        ['Result', verification.ok ? 'PASSED - every file accounted for' : `${problems} PROBLEM(S) FOUND`, verification.ok ? COLORS.green : COLORS.red],
        ['Files compared', `${(verification.sourceFiles ?? 0).toLocaleString()} source vs ${(verification.targetFiles ?? 0).toLocaleString()} target`],
        ['Hash-identical', (verification.identical ?? 0).toLocaleString()],
        ['Office re-stamped', `${verification.officeRewritten ?? 0} (SharePoint rewrites document properties on copy - content intact, expected)`],
        ['Missing / size / hash', `${verification.missing ?? 0} / ${verification.sizeMismatch ?? 0} / ${verification.hashMismatch ?? 0}`],
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
    const failedItems = items.filter((i) => i.status === 'failed');
    if (failedItems.length > 0 || keptRows.length > 0) {
      r.section(`Attention required (${failedItems.length + keptRows.length})`);
      if (failedItems.length > 0) {
        r.table(
          ['Failed file', 'Error'],
          [r.width * 0.45, r.width * 0.55],
          failedItems.map((i) => [{ text: relPath(i.source_path), color: COLORS.red }, i.error_message || '-'])
        );
        doc.moveDown(0.5);
      }
      if (keptRows.length > 0) {
        r.table(
          ['Kept at source (cleanup)', 'Reason'],
          [r.width * 0.55, r.width * 0.45],
          keptRows.map((k) => [{ text: relPath(k.source_path), color: COLORS.amber }, k.error_message || '-'])
        );
      }
    }

    // --- Timeline ----------------------------------------------------------
    r.section('Timeline');
    r.table(
      ['Time', 'Event', 'By'],
      [r.width * 0.22, r.width * 0.53, r.width * 0.25],
      lifecycle.map((e) => [
        fmtDate(e.ts),
        e.event_type.replace(/^job_/, '').replace(/_/g, ' '),
        e.actor_name || '-',
      ]),
      { rowHeight: 12 }
    );

    // --- File inventory ----------------------------------------------------
    doc.addPage();
    r.section(`File inventory (${items.length.toLocaleString()} files)`);
    if (pathPrefix) {
      doc.fontSize(7.5).fillColor(COLORS.muted).text(`Paths relative to ${pathPrefix}`, r.left, doc.y, { lineBreak: false });
      doc.y += 12;
    }
    r.table(
      ['#', 'File', 'Size', 'Status'],
      [r.width * 0.06, r.width * 0.72, r.width * 0.11, r.width * 0.11],
      items.map((i, idx) => [
        String(idx + 1),
        relPath(i.source_path),
        formatBytes(i.size_bytes),
        { text: i.status, color: i.status === 'success' ? COLORS.green : i.status === 'failed' ? COLORS.red : COLORS.muted },
      ]),
      { rowHeight: 11, fontSize: 6.5, aligns: ['right', 'left', 'right', 'left'] }
    );

    // --- Footer with page numbers -------------------------------------------
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      doc.fontSize(7).fillColor(COLORS.faint).text(
        `${job.name}  ·  page ${p + 1} of ${range.count}`,
        r.left, doc.page.height - 40,
        { width: r.width, align: 'center', lineBreak: false }
      );
    }
    doc.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
