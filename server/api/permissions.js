const express = require('express');
const { requireAuth, getTenantId, getProjectId } = require('../auth/middleware');
const { getGraphToken } = require('../auth/msal');
const { getDb } = require('../db');
const config = require('../config');
const { ensureEngineSiteAccess, checkEngineSiteAccess } = require('../graph/siteAccess');

const router = express.Router();
router.use(requireAuth);

// OIDC sign-in scopes are always present and aren't Graph API permissions -
// exclude them from the "do I have what the app needs" delegated check.
const OIDC_SCOPES = new Set(['openid', 'profile', 'email', 'offline_access']);

// A Graph access token is a JWT; its `scp` claim lists the delegated scopes it
// was actually granted. Decoding it is a display hint for the health panel
// (which permission is missing), never a security decision - so a token that
// won't decode just yields null ("couldn't determine") rather than an error.
function decodeGrantedScopes(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return String(payload.scp || '').split(' ').filter(Boolean);
  } catch {
    return null;
  }
}

// The SharePoint sites this project's mappings actually touch - the set the
// engine needs per-site Sites.Selected grants on. File-share sources have no
// site; azure_blob / onedrive targets have no target site.
function collectProjectSiteUrls(tenantId) {
  const rows = getDb().prepare(
    `SELECT DISTINCT source_site_url, source_provider, target_site_url, target_provider
     FROM mappings WHERE tenant_id = ?`
  ).all(tenantId);
  const urls = new Set();
  for (const r of rows) {
    if ((r.source_provider || 'sharepoint') !== 'filesystem' && r.source_site_url) urls.add(r.source_site_url);
    if ((r.target_provider || 'sharepoint') === 'sharepoint' && r.target_site_url) urls.add(r.target_site_url);
  }
  return [...urls];
}

// Health check across the three permission layers for the current project:
// A) the signed-in user's delegated scopes, B) the project's own engine app,
// C) per-site access grants. Best-effort per site - one unreachable site never
// fails the whole report.
router.get('/permissions/health', async (req, res, next) => {
  try {
    const token = await getGraphToken(req);
    const present = token ? decodeGrantedScopes(token) : null;
    const required = config.delegatedScopes.filter((s) => !OIDC_SCOPES.has(s));
    const delegated = {
      required,
      present,
      // null present = couldn't determine (no token / undecodable) - the UI
      // shows "unknown" rather than a false "all missing".
      missing: present ? required.filter((s) => !present.includes(s)) : null,
    };

    const project = getDb().prepare('SELECT engine_client_id FROM projects WHERE id = ?').get(getProjectId(req));
    const engineApp = {
      clientId: project?.engine_client_id || null,
      dedicated: !!project?.engine_client_id,
      onedriveTargetEnabled: config.onedriveTargetEnabled,
    };

    const sites = [];
    for (const url of collectProjectSiteUrls(getTenantId(req))) {
      try {
        sites.push(await checkEngineSiteAccess(req, url));
      } catch (err) {
        sites.push({ siteUrl: url, granted: null, error: err.message });
      }
    }

    res.json({ delegated, engineApp, sites });
  } catch (err) {
    next(err);
  }
});

// Grant the engine fullcontrol on every site this project's mappings use, in
// one action (idempotent - already-granted sites report 'already-granted').
router.post('/permissions/grant-sites', async (req, res, next) => {
  try {
    const results = [];
    for (const url of collectProjectSiteUrls(getTenantId(req))) {
      try {
        results.push(await ensureEngineSiteAccess(req, url));
      } catch (err) {
        results.push({ siteUrl: url, ok: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// One-shot readout of the last engine-app re-sync result (stashed in the
// session by the repair login leg in server/auth/routes.js). Cleared on read
// so a page refresh doesn't keep re-showing a stale banner.
router.get('/permissions/last-repair', (req, res) => {
  const repair = req.session.lastEngineRepair || null;
  delete req.session.lastEngineRepair;
  res.json({ repair });
});

module.exports = router;
