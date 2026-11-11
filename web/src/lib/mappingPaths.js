// Path helpers shared by the mapping builder and the mappings grid.

// Characters SharePoint refuses in a folder name. Kept in step with
// ILLEGAL_SEGMENT_CHARS in server/api/mappings.js.
const ILLEGAL_SEGMENT = /["*:<>?|]/;

// 'Teams\\Finance/ ' -> 'Teams/Finance'
export function cleanPath(value) {
  return String(value ?? '').split(/[\\/]+/).map((s) => s.trim()).filter(Boolean).join('/');
}

export function joinPath(...parts) {
  return cleanPath(parts.filter(Boolean).join('/'));
}

// Why a target folder path can't be used, or null when it is fine.
export function pathProblem(value) {
  for (const seg of cleanPath(value).split('/').filter(Boolean)) {
    if (ILLEGAL_SEGMENT.test(seg)) return 'Folder names can\'t contain " * : < > ? |';
    if (seg.endsWith('.')) return 'Folder names can\'t end with a full stop';
  }
  return null;
}

// Turns a site or library title into something usable as one folder name:
// "Finance: Q1/Q2" -> "Finance- Q1-Q2".
export function safeSegment(name) {
  return String(name ?? '').replace(/["*:<>?|\\/]/g, '-').replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
}

export const PATTERN_TOKENS = ['site', 'library', 'folder'];

// Fills {site}, {library} and {folder} in a target pattern. A token with no
// value (e.g. {folder} when a whole library is the source) drops out, along
// with the slash it would have left behind.
export function expandPattern(pattern, vars) {
  const filled = String(pattern ?? '').replace(/\{(\w+)\}/g, (whole, key) => {
    const k = key.toLowerCase();
    return PATTERN_TOKENS.includes(k) ? safeSegment(vars[k]) : whole;
  });
  return cleanPath(filled);
}

// Last segment of a path: the folder the engine recreates at the target.
export function leafOf(path) {
  const parts = cleanPath(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// Where a mapping's content actually ends up inside the target library. A
// folder source is recreated inside the target folder; a library-root source
// (empty path) puts its contents straight into the target folder.
export function landingPath(targetPath, sourcePath) {
  return joinPath(targetPath, leafOf(sourcePath));
}

// Identity of a SharePoint source, for spotting "this is already mapped".
export function sourceKey(siteUrl, library, path) {
  return [String(siteUrl || '').replace(/\/+$/, ''), cleanPath(library), cleanPath(path)].join('|').toLowerCase();
}

// Runs fn over items with at most `limit` in flight, keeping result order.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
