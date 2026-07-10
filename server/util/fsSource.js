const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = require('../config');
const { getDb } = require('../db');
const { encrypt, decrypt } = require('./secretCrypto');

// Allowlist + credential store for the file-share source feature.
//
// Roots come from two places, merged: the project's own list saved from the
// Settings page (projects.fs_source_roots) and the optional server-wide
// FS_SOURCE_ROOTS env fallback. Every path that reaches the filesystem - the
// browse API, mapping creation, and the orchestrator right before it spawns
// an engine process - must pass through isAllowedFsPath. Validating only at
// browse time would leave stale jobs runnable after the allowlist is
// narrowed, and validating only at run time would let the UI wander the
// whole disk.
//
// Each project root may optionally carry ITS OWN credentials (username +
// password, encrypted at rest like every other stored secret) so the tool
// can reach shares the server's service account has no rights on - the
// connection is established per SMB server with `net use ... /persistent:no`
// before any read (browse, save-check, and by the engine itself at
// preflight, since the engine is a separate process that may outlive this
// one's session). Env-fallback roots never have credentials - they are read
// as the service account, the original behaviour.
//
// Storage format: projects.fs_source_roots is a JSON array of
// {path, username, passwordEncrypted}; the pre-credentials format (plain
// semicolon-separated paths) still parses so existing rows keep working.

function normalizeFsPath(p) {
  // path.win32 explicitly: UNC semantics must hold even if this server ever
  // runs under a POSIX Node for development. normalize() collapses '..'
  // segments so a crafted "\\allowed\root\..\..\secret" can't escape the
  // prefix check below.
  const normalized = path.win32.normalize(String(p || '').trim());
  return normalized.replace(/[\\/]+$/, '');
}

// "\\server\share" from any UNC path, null for local/drive paths.
function shareBaseOf(p) {
  const m = /^(\\\\[^\\/]+\\[^\\/]+)/.exec(normalizeFsPath(p));
  return m ? m[1] : null;
}

function parseStoredRoots(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s)
        .map((e) => ({
          path: normalizeFsPath(e.path),
          username: e.username || null,
          passwordEncrypted: e.passwordEncrypted || null,
        }))
        .filter((e) => e.path);
    } catch {
      return [];
    }
  }
  // Legacy pre-credentials format: semicolon-separated paths.
  return s.split(';').map(normalizeFsPath).filter(Boolean)
    .map((p) => ({ path: p, username: null, passwordEncrypted: null }));
}

// Full root entries for a tenant: project roots first (they're what the user
// manages, and the only ones that can carry credentials), then env roots,
// de-duped by path.
function resolveFsRootEntries(tenantId) {
  const project = tenantId
    ? parseStoredRoots(getDb().prepare('SELECT fs_source_roots FROM projects WHERE tenant_id = ?').get(tenantId)?.fs_source_roots)
    : [];
  const env = config.fsSourceRoots.map((p) => ({ path: normalizeFsPath(p), username: null, passwordEncrypted: null }));
  const seen = new Set();
  const out = [];
  for (const e of [...project, ...env]) {
    const key = e.path.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function allowedFsRoots(tenantId) {
  return resolveFsRootEntries(tenantId).map((e) => e.path);
}

function fsSourceEnabled(tenantId) {
  return resolveFsRootEntries(tenantId).length > 0;
}

// The allowlist entry whose subtree contains `p`, or null. Case-insensitive
// (Windows filesystems are) and boundary-safe: a root of \\srv\share never
// admits \\srv\share2.
function findFsRootEntry(p, tenantId) {
  const candidate = normalizeFsPath(p);
  if (!candidate) return null;
  const lower = candidate.toLowerCase();
  return resolveFsRootEntries(tenantId).find((e) => {
    const rootLower = e.path.toLowerCase();
    return lower === rootLower || lower.startsWith(rootLower + path.win32.sep);
  }) || null;
}

function isAllowedFsPath(p, tenantId) {
  return findFsRootEntry(p, tenantId) !== null;
}

function decryptRootPassword(entry) {
  if (!entry?.passwordEncrypted) return null;
  if (!config.credentialEncryptionKey) {
    throw httpError(409, 'CREDENTIAL_ENCRYPTION_KEY is not set on this server - the stored share credential cannot be decrypted.');
  }
  try {
    return decrypt(entry.passwordEncrypted, config.credentialEncryptionKey);
  } catch {
    throw httpError(409, `The stored credential for "${entry.path}" can't be decrypted - CREDENTIAL_ENCRYPTION_KEY has changed since it was saved. Re-enter the password on the Settings page.`);
  }
}

// Establishes an SMB session to the entry's server as its configured user
// (no-op for credential-less roots - those are read as the service account).
// `net use /persistent:no` sessions are per logon session and shared with
// child processes, but they can drop - callers re-invoke before every access
// and the 10-minute success cache keeps that cheap.
const shareSessions = new Map(); // "\\server\share|user" -> last success ms
function ensureShareConnection(entry) {
  if (!entry?.username || !entry.passwordEncrypted) return { ok: true, skipped: true };
  const share = shareBaseOf(entry.path);
  if (!share) {
    return { ok: false, error: `Credentials are only supported on UNC roots (\\\\server\\share\\...), not "${entry.path}".` };
  }
  const cacheKey = `${share.toLowerCase()}|${entry.username.toLowerCase()}`;
  const cached = shareSessions.get(cacheKey);
  if (cached && Date.now() - cached < 10 * 60 * 1000) return { ok: true, cached: true };

  const password = decryptRootPassword(entry);
  // Args array, no shell: the password is never shell-parsed. (It is briefly
  // visible in the process's own command line - the standard trade-off of
  // net.exe; the alternative, WNetAddConnection2, needs a native addon.)
  const r = spawnSync('net', ['use', share, password, `/user:${entry.username}`, '/persistent:no'],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const output = `${r.stdout || ''} ${r.stderr || ''}`.trim();
  if (r.status === 0) {
    shareSessions.set(cacheKey, Date.now());
    return { ok: true };
  }
  if (/1219/.test(output)) {
    return {
      ok: false,
      error: `Windows already holds a connection to ${share} under different credentials (error 1219). On the machine running this server, run "net use ${share} /delete" (as the account the server runs under), or use the same user for every root on that server.`,
    };
  }
  return { ok: false, error: output || `net use exited with code ${r.status}` };
}

// Replaces the project's whole root list. Passwords: a non-empty password is
// encrypted and stored; an empty password KEEPS the previously stored secret
// for the same path+user (so re-saving the list never forces retyping);
// no username clears any stored credential for that root.
function saveProjectRoots(tenantId, roots) {
  const prior = tenantId
    ? parseStoredRoots(getDb().prepare('SELECT fs_source_roots FROM projects WHERE tenant_id = ?').get(tenantId)?.fs_source_roots)
    : [];
  const priorByPath = new Map(prior.map((e) => [e.path.toLowerCase(), e]));

  const cleaned = [];
  const seen = new Set();
  for (const raw of roots || []) {
    const entry = typeof raw === 'string' ? { path: raw } : (raw || {});
    const p = normalizeFsPath(entry.path);
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());

    const username = String(entry.username || '').trim();
    let passwordEncrypted = null;
    if (username) {
      if (!shareBaseOf(p)) {
        throw httpError(400, `Credentials are only supported on UNC roots (\\\\server\\share\\...) - "${p}" is a local path, which is always read as the server's own account.`);
      }
      const password = String(entry.password || '');
      if (password) {
        if (!config.credentialEncryptionKey) {
          throw httpError(409, 'CREDENTIAL_ENCRYPTION_KEY is not set on this server - an operator needs to add it to .env and restart before share credentials can be saved.');
        }
        passwordEncrypted = encrypt(password, config.credentialEncryptionKey);
      } else {
        const existing = priorByPath.get(p.toLowerCase());
        if (existing && (existing.username || '').toLowerCase() === username.toLowerCase()) {
          passwordEncrypted = existing.passwordEncrypted;
        }
      }
      if (!passwordEncrypted) {
        throw httpError(400, `A password is required for "${p}" (user "${username}") - none is stored yet.`);
      }
    }
    cleaned.push({ path: p, username: username || null, passwordEncrypted });
  }

  getDb().prepare('UPDATE projects SET fs_source_roots = ? WHERE tenant_id = ?')
    .run(cleaned.length ? JSON.stringify(cleaned) : null, tenantId);
  return cleaned;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  fsSourceEnabled,
  allowedFsRoots,
  resolveFsRootEntries,
  findFsRootEntry,
  isAllowedFsPath,
  normalizeFsPath,
  shareBaseOf,
  saveProjectRoots,
  ensureShareConnection,
  decryptRootPassword,
};
