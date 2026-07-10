const path = require('node:path');
const config = require('../config');
const { getDb } = require('../db');

// Allowlist guard for the file-share source feature. Roots come from two
// places, merged: the project's own list saved from the Settings page
// (projects.fs_source_roots - the normal way) and the optional server-wide
// FS_SOURCE_ROOTS env fallback. Every path that reaches the filesystem - the
// browse API, mapping creation, and the orchestrator right before it spawns
// an engine process - must pass through isAllowedFsPath. Validating only at
// browse time would leave stale jobs runnable after the allowlist is
// narrowed, and validating only at run time would let the UI wander the
// whole disk.
//
// The paths are read by the SERVER's own process account regardless of which
// tenant configured them - keep roots scoped to the shares actually being
// migrated.

function normalizeFsPath(p) {
  // path.win32 explicitly: UNC semantics must hold even if this server ever
  // runs under a POSIX Node for development. normalize() collapses '..'
  // segments so a crafted "\\allowed\root\..\..\secret" can't escape the
  // prefix check below.
  const normalized = path.win32.normalize(String(p || '').trim());
  return normalized.replace(/[\\/]+$/, '');
}

function parseRootList(text) {
  return String(text || '').split(';').map(normalizeFsPath).filter(Boolean);
}

function projectRoots(tenantId) {
  if (!tenantId) return [];
  const row = getDb().prepare('SELECT fs_source_roots FROM projects WHERE tenant_id = ?').get(tenantId);
  return parseRootList(row?.fs_source_roots);
}

function allowedFsRoots(tenantId) {
  // De-duped union, project roots first (they're what the user manages).
  const merged = [...projectRoots(tenantId), ...config.fsSourceRoots.map(normalizeFsPath)];
  const seen = new Set();
  return merged.filter((r) => {
    const key = r.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function fsSourceEnabled(tenantId) {
  return allowedFsRoots(tenantId).length > 0;
}

// True when `p` is one of the allowed roots or strictly inside one.
// Case-insensitive (Windows filesystems are) and boundary-safe: a root of
// \\srv\share never admits \\srv\share2.
function isAllowedFsPath(p, tenantId) {
  const candidate = normalizeFsPath(p);
  if (!candidate) return false;
  const lower = candidate.toLowerCase();
  return allowedFsRoots(tenantId).some((root) => {
    const rootLower = root.toLowerCase();
    return lower === rootLower || lower.startsWith(rootLower + path.win32.sep);
  });
}

function saveProjectRoots(tenantId, roots) {
  const cleaned = [...new Set((roots || []).map(normalizeFsPath).filter(Boolean).map((r) => r))];
  getDb().prepare('UPDATE projects SET fs_source_roots = ? WHERE tenant_id = ?')
    .run(cleaned.length ? cleaned.join(';') : null, tenantId);
  return cleaned;
}

module.exports = { fsSourceEnabled, allowedFsRoots, isAllowedFsPath, normalizeFsPath, saveProjectRoots };
