const fs = require('node:fs');
const path = require('node:path');

// The engine polls this small JSON file after finishing each item - never an OS
// signal, so it can always finish its current file and write a clean checkpoint
// before reacting. SQLite (jobs.pause_requested / cancel_requested) remains the
// durable source of truth; this file is just a fast, simple read surface for the
// PowerShell process that Node keeps in sync with the DB on every change and
// re-derives from the DB whenever a job (re)starts.
// Anchored to the repo root (same reasoning as db/index.js): with cwd=server/
// these .json files landed inside nodemon's watched tree, so merely starting a
// job restarted the server - killing the engine process it had just spawned.
const CONTROL_DIR = path.join(__dirname, '..', '..', 'data', 'control');

function controlFilePath(jobId) {
  return path.join(CONTROL_DIR, `${jobId}.json`);
}

function writeControlFile(jobId, state) {
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  fs.writeFileSync(controlFilePath(jobId), JSON.stringify(state), 'utf8');
}

function removeControlFile(jobId) {
  try {
    fs.unlinkSync(controlFilePath(jobId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Where the engine persists its source-tree scan between runs (see
// engine/Invoke-MigrationJob.ps1's -TreeCachePath) so a pause/restart/server
// bounce doesn't redo a 15+ minute enumeration. Same repo-root anchoring
// rationale as CONTROL_DIR above.
const TREE_CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'tree-cache');

function treeCachePath(jobId) {
  fs.mkdirSync(TREE_CACHE_DIR, { recursive: true });
  return path.join(TREE_CACHE_DIR, `${jobId}.json`);
}

function removeTreeCache(jobId) {
  try {
    fs.unlinkSync(path.join(TREE_CACHE_DIR, `${jobId}.json`));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { controlFilePath, writeControlFile, removeControlFile, treeCachePath, removeTreeCache };
