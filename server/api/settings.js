const express = require('express');
const { requireAuth, getTenantId } = require('../auth/middleware');
const { getDb } = require('../db');
const { encrypt } = require('../util/secretCrypto');
const { resolveBlobConnectionString } = require('../util/blobCredential');
const { analyzeBlobConnectionString } = require('../util/blobConnectionInfo');
const { fsSourceEnabled, allowedFsRoots, saveProjectRoots, normalizeFsPath } = require('../util/fsSource');
const config = require('../config');
const fs = require('node:fs');

const router = express.Router();
router.use(requireAuth);

// Read-only view of the throttling/concurrency defaults - these are set via
// environment variables (see .env.example) rather than mutated at runtime,
// since they're tenant-wide throttle-budget decisions, not per-user prefs.
router.get('/settings', (req, res) => {
  // Never leak the connection string itself - just whether one is set for
  // THIS project (its own, from the form below, or the server-wide
  // AZURE_BLOB_CONNECTION_STRING fallback) plus a non-secret analysis of it
  // (form, account name, SAS expiry) so problems like a portal SAS quietly
  // expiring mid-job are visible in the UI instead of surfacing as 403s
  // six hours into a run.
  const connectionString = resolveBlobConnectionString(getTenantId(req));
  res.json({
    tenantName: config.tenantName,
    defaultJobConcurrency: config.defaultJobConcurrency,
    globalMaxConcurrency: config.globalMaxConcurrency,
    retryRateBackoffThreshold: config.retryRateBackoffThreshold,
    slowTransferThresholdMs: config.slowTransferThresholdMs,
    enginePermissionMode: config.enginePermissionMode,
    blobArchivingEnabled: !!connectionString,
    blobConnectionInfo: analyzeBlobConnectionString(connectionString),
    // File-share (DFS) sources: allowlist managed on the Settings page
    // (plus the optional server-wide FS_SOURCE_ROOTS fallback, merged in).
    fsSourceEnabled: fsSourceEnabled(getTenantId(req)),
    fsSourceRoots: allowedFsRoots(getTenantId(req)),
  });
});

// Analyzes a pasted connection string BEFORE saving, so the Settings form can
// show its form/expiry live. The string is only parsed, never stored or
// logged by this route.
router.post('/settings/blob-connection-string/analyze', (req, res) => {
  const connectionString = (req.body?.connectionString || '').trim();
  if (!connectionString) return res.json({ info: null });
  res.json({ info: analyzeBlobConnectionString(connectionString) });
});

// Per-project Azure Blob connection string, set from the Settings page
// instead of requiring server-side .env access for every client tenant.
// Encrypted at rest the same way as the auto-provisioned engine app secret
// (server/util/secretCrypto.js).
router.post('/settings/blob-connection-string', (req, res) => {
  const connectionString = (req.body?.connectionString || '').trim();
  if (!connectionString) return res.status(400).json({ error: 'connectionString is required' });
  if (!config.credentialEncryptionKey) {
    return res.status(409).json({
      error: 'credential_encryption_not_configured',
      message: 'CREDENTIAL_ENCRYPTION_KEY is not set on this server - an operator needs to add it to .env and restart before per-project secrets can be saved.',
    });
  }
  const encrypted = encrypt(connectionString, config.credentialEncryptionKey);
  getDb().prepare('UPDATE projects SET blob_connection_string_encrypted = ? WHERE tenant_id = ?').run(encrypted, getTenantId(req));
  res.status(200).json({ ok: true });
});

router.delete('/settings/blob-connection-string', (req, res) => {
  getDb().prepare('UPDATE projects SET blob_connection_string_encrypted = NULL WHERE tenant_id = ?').run(getTenantId(req));
  res.status(204).end();
});

// File-share (DFS) source roots for this project, managed from the Settings
// page. Saving replaces the whole list (an empty list disables the feature
// for this project, unless the server-wide FS_SOURCE_ROOTS fallback is set).
// The response reports whether the SERVER's process account can actually
// read each root right now - a root the server can't reach is still saved
// (maybe the share is being provisioned) but flagged, so "the picker shows
// nothing" never needs a server-side investigation to explain.
router.post('/settings/fs-source-roots', (req, res) => {
  const roots = req.body?.roots;
  if (!Array.isArray(roots)) return res.status(400).json({ error: 'roots must be an array of paths' });
  for (const r of roots) {
    const p = normalizeFsPath(r);
    // Absolute paths only: UNC (\\server\share) or a drive letter. Anything
    // relative would silently resolve against the server's cwd.
    if (!/^(\\\\[^\\]+\\[^\\]+|[A-Za-z]:\\)/.test(p + '\\')) {
      return res.status(400).json({ error: `"${r}" is not an absolute UNC (\\\\server\\share\\...) or drive (X:\\...) path.` });
    }
  }
  const saved = saveProjectRoots(getTenantId(req), roots);
  const status = saved.map((p) => {
    try {
      fs.readdirSync(p);
      return { path: p, ok: true };
    } catch (err) {
      return { path: p, ok: false, error: err.message };
    }
  });
  res.json({ roots: saved, status });
});

module.exports = router;
