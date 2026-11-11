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
