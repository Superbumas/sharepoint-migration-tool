// Shared display formatters - previously copy-pasted into four components.

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

// Job names are stored as "Source -> Target". The font's arrow ligature hid
// that on desktop, but a narrow screen could wrap between "-" and ">".
// Show a real arrow that never splits from the word before it.
export function jobTitle(name) {
  return String(name || '').replace(/ -> /g, ' → ');
}

// 'YYYY-MM-DD' -> 'dd/mm/yyyy' (UK), for the archive filter's date.
export function formatDay(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDay || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// Today minus N whole years, as 'YYYY-MM-DD' (the archive quick picks).
export function yearsAgo(n) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}
