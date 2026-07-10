const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { requireAuth, getTenantId } = require('../auth/middleware');
const { fsSourceEnabled, allowedFsRoots, isAllowedFsPath, normalizeFsPath } = require('../util/fsSource');

const router = express.Router();
router.use(requireAuth);

// The file-share source picker's backend. Deliberately minimal: list the
// allowed roots, and list one directory at a time under them. Everything is
// confined to the project's allowlist (Settings page, plus the optional
// FS_SOURCE_ROOTS fallback - see server/util/fsSource.js) because this reads
// the SERVER's filesystem as the server's own account.

router.get('/fs/roots', (req, res) => {
  res.json({
    enabled: fsSourceEnabled(getTenantId(req)),
    roots: allowedFsRoots(getTenantId(req)).map((p) => ({ path: p, name: path.win32.basename(p) || p })),
  });
});

router.get('/fs/browse', (req, res) => {
  if (!fsSourceEnabled(getTenantId(req))) {
    return res.status(409).json({ error: 'fs_source_disabled', message: 'No file-share roots are configured - add them on the Settings page.' });
  }
  const dir = normalizeFsPath(req.query.path);
  if (!isAllowedFsPath(dir, getTenantId(req))) {
    return res.status(403).json({ error: 'path_not_allowed', message: 'That path is outside this project\'s allowed file-share roots (see Settings).' });
  }

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: 'unreadable', message: `Cannot read '${dir}': ${err.message}` });
  }

  const folders = [];
  const files = [];
  let fileCount = 0;
  for (const entry of entries) {
    // Junctions/symlinks are skipped by the engine's enumeration too (cycle
    // hazard) - hiding them here keeps the picker honest about what a job
    // would actually copy.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      folders.push({ name: entry.name, path: path.win32.join(dir, entry.name) });
    } else if (entry.isFile()) {
      fileCount++;
      // Files are context for the person picking a folder, not selectable -
      // capped so a directory with 300k files doesn't melt the response.
      if (files.length < 200) {
        let size = null, modified = null;
        try {
          const stat = fs.statSync(path.win32.join(dir, entry.name));
          size = stat.size;
          modified = stat.mtime.toISOString();
        } catch { /* transient/locked file - still listed, just without stats */ }
        files.push({ name: entry.name, size, modified });
      }
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  // One level of look-ahead per subfolder ("34 items") - a single readdir
  // each, so it's one syscall per row, same cost as Explorer. Capped: a
  // directory with hundreds of subfolders skips counts rather than issuing
  // hundreds of network readdirs against a DFS share.
  if (folders.length <= 80) {
    for (const f of folders) {
      try { f.childCount = fs.readdirSync(f.path).length; } catch { f.childCount = null; }
    }
  }

  res.json({ path: dir, folders, files, fileCount, fileListTruncated: fileCount > files.length });
});

module.exports = router;
