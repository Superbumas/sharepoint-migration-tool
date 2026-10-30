// Excel companion to the client PDF: the full file list (the PDF drops it
// past a few thousand files) plus the same per-location summary, so the
// client can filter and spot-check without asking for another export.

const XLSX = require('xlsx');
const { formatBytes, fmtDay } = require('./pdf');
const { PROBLEM_LABEL, extOf } = require('./data');

function renderClientXlsx(data, { title, client }) {
  const { totals, folders } = data;
  const summary = [
    [client || title],
    [`Migration report · issued ${fmtDay(new Date())}`],
    [],
    ['Location', 'From', 'To', 'Files migrated', 'Size', 'Size (bytes)', 'Subfolders', 'Status', 'Completed', 'Link'],
    ...folders.map((f) => [
      f.name, f.source.where, f.target.where, f.migrated.length, formatBytes(f.bytes), f.bytes, f.folderCount,
      f.notMigrated.length > 0 ? `${f.notMigrated.length} file${f.notMigrated.length === 1 ? '' : 's'} to review` : f.ver.state === 'verified' ? 'Complete · verified' : 'Complete',
      fmtDay(f.completedAt), f.target.url || '',
    ]),
    ['Total', '', '', totals.files, formatBytes(totals.bytes), totals.bytes, totals.subfolders, '', ''],
  ];
  const files = [
    ['Location', 'Path', 'File name', 'Type', 'Size', 'Size (bytes)'],
    ...folders.flatMap((f) => f.migrated.map((m) => [
      f.name, m.path, m.path.split('/').pop(), (extOf(m.path) || '').slice(1).toUpperCase(), formatBytes(m.size), m.size ?? null,
    ])),
  ];

  const wb = XLSX.utils.book_new();
  const s1 = XLSX.utils.aoa_to_sheet(summary);
  s1['!cols'] = [{ wch: 26 }, { wch: 48 }, { wch: 48 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 11 }, { wch: 22 }, { wch: 16 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(wb, s1, 'Summary');
  const s2 = XLSX.utils.aoa_to_sheet(files);
  s2['!cols'] = [{ wch: 22 }, { wch: 90 }, { wch: 40 }, { wch: 8 }, { wch: 10 }, { wch: 14 }];
  s2['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, files.length - 1), c: files[0].length - 1 } }) };
  XLSX.utils.book_append_sheet(wb, s2, 'Files');

  const review = folders.flatMap((f) => f.notMigrated.map((n) => [f.name, n.path, PROBLEM_LABEL[n.reason] || n.reason]));
  if (review.length > 0) {
    const s3 = XLSX.utils.aoa_to_sheet([['Location', 'Path', 'Reason'], ...review]);
    s3['!cols'] = [{ wch: 22 }, { wch: 90 }, { wch: 32 }];
    XLSX.utils.book_append_sheet(wb, s3, 'To review');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { renderClientXlsx };
