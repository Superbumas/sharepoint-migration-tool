// Client-facing migration report: what was moved, where it went, and that
// it was checked. Deliberately leaves out operator detail (runs, resumes,
// retries, timelines, engine errors) - every number is the final state.

const PDFDocument = require('pdfkit');
const { COLORS, Report, formatBytes, fmtDay } = require('./pdf');
const { PROBLEM_LABEL, fileTypeBreakdown } = require('./data');

// Above this many files the per-file list moves to the Excel workbook only;
// a PDF of tens of thousands of rows helps nobody.
const INVENTORY_PDF_LIMIT = 5000;

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function statusFor(folder) {
  if (folder.ver.state === 'verified' && folder.notMigrated.length === 0) return { text: 'Complete · verified', color: COLORS.green };
  if (folder.notMigrated.length > 0) return { text: `${plural(folder.notMigrated.length, 'file')} to review`, color: COLORS.amber };
  return { text: 'Complete', color: COLORS.ink };
}

function periodText(totals) {
  if (!totals.from || !totals.to) return null;
  const a = fmtDay(totals.from);
  const b = fmtDay(totals.to);
  return a === b ? a : `${a} – ${b}`;
}

function renderClientPdf(out, data, { title, client, preparedBy, inventory }) {
  const doc = new PDFDocument({
    size: 'A4', margins: { top: 54, bottom: 54, left: 46, right: 46 }, bufferPages: true,
    info: { Title: `${title}${client ? ` - ${client}` : ''}`, Author: preparedBy || '' },
  });
  doc.pipe(out);
  const r = new Report(doc);
  const { totals, folders } = data;
  const allVerified = totals.folders > 0 && totals.verifiedFolders === totals.folders && totals.notMigrated === 0;
  const showInventory = inventory ?? totals.files <= INVENTORY_PDF_LIMIT;

  // --- Cover band ----------------------------------------------------------
  const bandH = 128;
  doc.rect(0, 0, doc.page.width, bandH).fillColor(COLORS.navy).fill();
  doc.rect(0, bandH, doc.page.width, 4).fillColor(COLORS.accent).fill();
  doc.font('Helvetica').fontSize(9).fillColor('#93c5fd')
    .text('MIGRATION REPORT', r.left, 38, { characterSpacing: 1.5 });
  doc.font('Helvetica-Bold').fontSize(24).fillColor('#ffffff')
    .text(r.fit(client || title, r.width, 24, 'Helvetica-Bold'), r.left, 54, { width: r.width, lineBreak: false });
  const period = periodText(totals);
  doc.font('Helvetica').fontSize(10).fillColor('#cbd5e1')
    .text(period || ' ', r.left, 88, { width: r.width });
  doc.fontSize(8).fillColor('#94a3b8')
    .text(`Issued ${fmtDay(new Date())}${preparedBy ? `  ·  Prepared by ${preparedBy}` : ''}`, r.left, 106, { width: r.width });
  doc.y = bandH + 26;

  // --- Summary -------------------------------------------------------------
  const destKinds = [...new Set(folders.map((f) => f.target.kind))];
  r.paragraph(
    `${totals.files.toLocaleString()} files (${formatBytes(totals.bytes)}) across ${totals.folders.toLocaleString()} `
    + `folder${totals.folders === 1 ? '' : 's'} were migrated to ${destKinds.join(' and ') || 'the destination'}`
    + `${period ? ` between ${period.replace(' – ', ' and ')}` : ''}. `
    + 'The folder structure and file names were kept as they were, and every file was checked against its original after copying.',
    { size: 10 }
  );
  doc.moveDown(0.3);
  r.statCards([
    ['Files migrated', totals.files.toLocaleString(), COLORS.ink],
    ['Data migrated', formatBytes(totals.bytes), COLORS.ink],
    ['Locations', totals.folders.toLocaleString(), COLORS.ink, `${totals.subfolders.toLocaleString()} subfolders`],
    ['Verification', allVerified ? '100% verified' : totals.notMigrated > 0 ? `${totals.notMigrated} to review` : 'Complete',
      allVerified ? COLORS.green : totals.notMigrated > 0 ? COLORS.amber : COLORS.ink],
  ], { height: 54, valueSize: 17 });

  if (allVerified) {
    r.callout('All files migrated and verified',
      'Every file was compared with its original after the copy. Each one is present at the destination with matching content.');
  } else if (totals.notMigrated > 0) {
    r.callout(`${plural(totals.notMigrated, 'file')} ${totals.notMigrated === 1 ? 'needs' : 'need'} a second look`,
      'Everything else was migrated and checked. The files concerned are listed under "Files to review" below, with the reason for each.', { tone: 'amber' });
  }

  // --- Locations -----------------------------------------------------------
  r.section('Migrated locations');
  r.table(
    ['Folder', 'Destination', 'Files', 'Size', 'Status'],
    [r.width * 0.2, r.width * 0.38, r.width * 0.1, r.width * 0.11, r.width * 0.21],
    folders.map((f) => {
      const st = statusFor(f);
      return [{ text: f.name, bold: true }, f.target.where, f.migrated.length.toLocaleString(), formatBytes(f.bytes), { text: st.text, color: st.color }];
    }),
    { rowHeight: 17, fontSize: 7.5, aligns: ['left', 'left', 'right', 'right', 'left'] }
  );
  if (folders.length > 1) {
    r.ensure(18);
    const y = doc.y;
    doc.moveTo(r.left, y).lineTo(r.left + r.width, y).lineWidth(0.75).strokeColor(COLORS.ink).stroke();
    const cols = [r.width * 0.2, r.width * 0.38, r.width * 0.1, r.width * 0.11];
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLORS.ink);
    doc.text('Total', r.left + 4, y + 4, { width: cols[0] - 8, lineBreak: false });
    doc.text(totals.files.toLocaleString(), r.left + cols[0] + cols[1] + 4, y + 4, { width: cols[2] - 8, align: 'right', lineBreak: false });
    doc.text(formatBytes(totals.bytes), r.left + cols[0] + cols[1] + cols[2] + 4, y + 4, { width: cols[3] - 8, align: 'right', lineBreak: false });
    doc.font('Helvetica');
    doc.y = y + 16;
  }

  // --- File types ----------------------------------------------------------
  if (data.fileTypes.length > 0 && totals.files > 0) {
    r.section('What was migrated');
    r.bars(data.fileTypes.map((t) => [
      t.ext === 'Other' || t.ext.startsWith('(') ? t.ext : t.ext.slice(1).toUpperCase(),
      t.count,
      `${t.count.toLocaleString()} files · ${formatBytes(t.bytes)}`,
    ]));
  }

  // --- How we checked ------------------------------------------------------
  r.section('How the migration was checked');
  const anySp = folders.some((f) => f.target.kind === 'SharePoint Online' || f.target.kind === 'OneDrive');
  r.paragraph(
    'After copying, every file at the destination was compared with its original: it must exist, '
    + 'be the same size, and have the same content fingerprint (a checksum calculated from the file\'s bytes). '
    + 'Anything that did not match was copied again and re-checked.'
  );
  if (anySp && totals.expectedRewrites > 0) {
    r.paragraph(
      `${totals.expectedRewrites.toLocaleString()} Office document(s) and Outlook messages (.msg) show a small size difference. `
      + 'This is expected: Microsoft 365 updates the properties stored inside these files (author, title, sender and so on) '
      + 'when they are saved to SharePoint. Their content is unchanged.',
      { color: COLORS.muted, size: 8.5 }
    );
  }

  // --- Files to review -----------------------------------------------------
  const review = folders.flatMap((f) => f.notMigrated.map((n) => ({ ...n, folder: f.name })));
  if (review.length > 0) {
    r.section(`Files to review (${review.length.toLocaleString()})`, { color: COLORS.amber });
    r.table(
      ['Folder', 'File', 'Reason'],
      [r.width * 0.18, r.width * 0.54, r.width * 0.28],
      review.map((n) => [n.folder, n.path, { text: PROBLEM_LABEL[n.reason] || n.reason, color: COLORS.amber }]),
      { rowHeight: 13, fontSize: 7 }
    );
  }

  // --- Per-location detail -------------------------------------------------
  for (const f of folders) {
    doc.addPage();
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.accent).text('LOCATION', r.left, doc.y, { characterSpacing: 1.2 });
    const nameY = doc.y + 2;
    doc.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.ink).text(r.fit(f.name, r.width, 17, 'Helvetica-Bold'), r.left, nameY, { lineBreak: false });
    doc.y = nameY + 28;
    r.kv([
      ['From', `${f.source.where}  (${f.source.kind})`],
      ['To', `${f.target.where}  (${f.target.kind})`],
      ['Completed', fmtDay(f.completedAt)],
    ], { labelW: 70 });
    doc.moveDown(0.4);
    const st = statusFor(f);
    r.statCards([
      ['Files migrated', f.migrated.length.toLocaleString()],
      ['Data', formatBytes(f.bytes)],
      ['Subfolders', f.folderCount.toLocaleString()],
      ['Status', st.text, st.color],
    ]);

    const types = fileTypeBreakdown(f.migrated, 6);
    if (types.length > 1) {
      r.section('File types');
      r.bars(types.map((t) => [
        t.ext === 'Other' || t.ext.startsWith('(') ? t.ext : t.ext.slice(1).toUpperCase(),
        t.count, `${t.count.toLocaleString()} · ${formatBytes(t.bytes)}`,
      ]));
    }

    if (showInventory) {
      r.section(`Files (${f.migrated.length.toLocaleString()})`);
      r.table(
        ['File', 'Size'],
        [r.width * 0.86, r.width * 0.14],
        f.migrated.map((m) => [m.path, formatBytes(m.size)]),
        { rowHeight: 11, fontSize: 6.5, aligns: ['left', 'right'] }
      );
    } else {
      r.paragraph(`The full list of ${f.migrated.length.toLocaleString()} files is in the accompanying Excel workbook.`, { color: COLORS.muted, size: 8.5 });
    }
  }

  r.footer(`${client || title}  ·  Migration report`);
  doc.end();
}

module.exports = { renderClientPdf, INVENTORY_PDF_LIMIT };
