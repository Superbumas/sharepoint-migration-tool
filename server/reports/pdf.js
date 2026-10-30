// Shared pdfkit layout helpers for the internal job report and the
// client-facing migration report (server/api/report.js). Pure JS, no browser
// dependency, so either PDF can be attached to an email / filed as-is.

const COLORS = {
  ink: '#1e293b', muted: '#64748b', faint: '#94a3b8',
  line: '#e2e8f0', headBg: '#f1f5f9', zebra: '#f8fafc',
  green: '#15803d', red: '#b91c1c', amber: '#b45309', blue: '#1d4ed8',
  navy: '#0f2a4a', accent: '#2563eb', greenBg: '#ecfdf5', amberBg: '#fffbeb',
};

function formatBytes(n) {
  if (!n && n !== 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
// SQLite datetime('now') values have no zone marker but are UTC.
function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? null : d;
}
function fmtDate(s) {
  const d = parseDate(s);
  if (!d) return s || '-';
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtDay(s) {
  const d = s instanceof Date ? s : parseDate(s);
  return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '-';
}
function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  const m = Math.round(ms / 60000);
  if (m < 1) return `${Math.round(ms / 1000)}s`;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
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
  section(title, { color = COLORS.ink } = {}) {
    this.ensure(48);
    const { doc } = this;
    doc.moveDown(0.8);
    doc.fontSize(11).fillColor(color).font('Helvetica-Bold').text(title.toUpperCase(), this.left, doc.y, { characterSpacing: 0.5 });
    doc.moveTo(this.left, doc.y + 2).lineTo(this.left + this.width, doc.y + 2).lineWidth(1).strokeColor(COLORS.line).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica');
  }
  paragraph(text, { size = 9, color = COLORS.ink } = {}) {
    const { doc } = this;
    this.ensure(30);
    doc.font('Helvetica').fontSize(size).fillColor(color).text(text, this.left, doc.y, { width: this.width, lineGap: 2 });
    doc.moveDown(0.4);
  }
  kv(rows, { labelW = 150 } = {}) {
    const { doc } = this;
    for (const [label, value, color] of rows) {
      this.ensure(16);
      const y = doc.y;
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.muted).text(label, this.left, y, { width: labelW });
      doc.fontSize(8.5).fillColor(color || COLORS.ink).text(String(value ?? '-'), this.left + labelW, y, { width: this.width - labelW });
      doc.y = Math.max(doc.y, y + 13);
    }
  }
  statCards(stats, { height = 42, valueSize = 13 } = {}) {
    const { doc } = this;
    this.ensure(height + 10);
    const gap = 8;
    const cardW = (this.width - gap * (stats.length - 1)) / stats.length;
    const y = doc.y;
    stats.forEach(([label, value, color, sub], i) => {
      const x = this.left + i * (cardW + gap);
      doc.roundedRect(x, y, cardW, height, 4).lineWidth(0.5).strokeColor(COLORS.line).stroke();
      doc.fontSize(7).fillColor(COLORS.muted).font('Helvetica')
        .text(this.fit(label.toUpperCase(), cardW - 16, 7), x + 8, y + 7, { width: cardW - 16, lineBreak: false });
      // Shrink long values (e.g. "COMPLETED") until they fit on one line
      // instead of wrapping inside the card.
      let size = valueSize;
      doc.font('Helvetica-Bold');
      while (size > 7 && doc.fontSize(size).widthOfString(String(value)) > cardW - 16) size -= 1;
      const valueY = sub ? y + height - 14 - size : y + height - 9 - size;
      doc.fontSize(size).fillColor(color || COLORS.ink)
        .text(String(value), x + 8, valueY, { width: cardW - 16, lineBreak: false });
      if (sub) {
        doc.font('Helvetica').fontSize(6.5).fillColor(COLORS.faint)
          .text(this.fit(sub, cardW - 16, 6.5), x + 8, y + height - 11, { width: cardW - 16, lineBreak: false });
      }
      doc.font('Helvetica');
    });
    doc.y = y + height + 8;
  }
  // Horizontal bar list: [label, value, displayText]. Bars scale to the max.
  bars(rows, { color = COLORS.accent, labelW = 110, valueW = 90 } = {}) {
    const { doc } = this;
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const barW = this.width - labelW - valueW - 12;
    for (const [label, value, text] of rows) {
      this.ensure(15);
      const y = doc.y;
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.ink)
        .text(this.fit(label, labelW - 6, 8), this.left, y + 1, { width: labelW - 6, lineBreak: false });
      doc.roundedRect(this.left + labelW, y + 1, barW, 8, 2).fillColor(COLORS.headBg).fill();
      const w = Math.max(2, (value / max) * barW);
      doc.roundedRect(this.left + labelW, y + 1, w, 8, 2).fillColor(color).fill();
      doc.fontSize(7.5).fillColor(COLORS.muted)
        .text(text, this.left + labelW + barW + 8, y + 1.5, { width: valueW - 4, align: 'right', lineBreak: false });
      doc.y = y + 14;
    }
  }
  // A coloured call-out box with a bold title line and body text.
  callout(title, body, { tone = 'green' } = {}) {
    const { doc } = this;
    const bg = tone === 'green' ? COLORS.greenBg : COLORS.amberBg;
    const fg = tone === 'green' ? COLORS.green : COLORS.amber;
    doc.font('Helvetica').fontSize(8.5);
    const bodyH = body ? doc.heightOfString(body, { width: this.width - 28, lineGap: 1.5 }) : 0;
    const h = 22 + bodyH + (body ? 6 : 0);
    this.ensure(h + 8);
    const y = doc.y;
    doc.roundedRect(this.left, y, this.width, h, 5).fillColor(bg).fill();
    doc.rect(this.left, y, 3, h).fillColor(fg).fill();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(fg).text(title, this.left + 14, y + 9, { width: this.width - 28 });
    if (body) {
      doc.font('Helvetica').fontSize(8.5).fillColor(COLORS.ink).text(body, this.left + 14, y + 24, { width: this.width - 28, lineGap: 1.5 });
    }
    doc.y = y + h + 8;
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
          .text(fitted, x + 4, y + (rowH - fontSize) / 2 - 0.5, { width: widths[i] - 8, align: opts.aligns?.[i] || 'left', lineBreak: false });
        x += widths[i];
      });
      doc.font('Helvetica');
      doc.y = y + rowH;
    };
    if (doc.y + rowH * 2 > this.bottom()) doc.addPage();
    drawHead();
    rows.forEach((row, r) => {
      if (doc.y + rowH > this.bottom()) { doc.addPage(); drawHead(); }
      const y = doc.y;
      if (r % 2 === 1) { doc.rect(this.left, y, this.width, rowH).fillColor(COLORS.zebra).fill(); }
      let x = this.left;
      row.forEach((cell, i) => {
        const isObj = cell && typeof cell === 'object';
        const font = isObj && cell.bold ? 'Helvetica-Bold' : 'Helvetica';
        // fit() guarantees one line per cell - pdfkit wraps to `width` even
        // with lineBreak:false, which used to pile rows on top of each other.
        const fitted = this.fit(isObj ? cell.text : cell, widths[i] - 8, fontSize, font);
        doc.font(font).fontSize(fontSize).fillColor(isObj && cell.color ? cell.color : COLORS.ink)
          .text(fitted, x + 4, y + (rowH - fontSize) / 2 - 0.5, { width: widths[i] - 8, align: opts.aligns?.[i] || 'left', lineBreak: false });
        x += widths[i];
      });
      doc.font('Helvetica');
      doc.y = y + rowH;
    });
  }
  // Page numbers (and an optional left-hand label) on every buffered page.
  footer(label) {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
      doc.switchToPage(p);
      // Drawing inside the bottom margin would otherwise trigger an
      // automatic page break and append a blank page per footer.
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fontSize(7).fillColor(COLORS.faint).font('Helvetica').text(
        `${label}  ·  page ${p + 1} of ${range.count}`,
        this.left, doc.page.height - 36,
        { width: this.width, align: 'center', lineBreak: false }
      );
      doc.page.margins.bottom = bottomMargin;
    }
  }
}

module.exports = { COLORS, Report, formatBytes, fmtDate, fmtDay, fmtDuration, parseDate };
