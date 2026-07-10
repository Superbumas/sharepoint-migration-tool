const { graphGet, graphPost, graphDelete } = require('./client');
const { getDb } = require('../db');
const { getProjectId } = require('../auth/middleware');
const config = require('../config');

// The engine identity for the caller's current project - its own dedicated
// app if provisioned, else the shared app (legacy tenant). Same rule as
// server/jobs/orchestrator.js's resolveEngineIdentity, from the request side.
function resolveEngineClientId(req) {
  const project = getDb().prepare('SELECT engine_client_id FROM projects WHERE id = ?').get(getProjectId(req));
  return project?.engine_client_id || config.clientId;
}

// Graph site id for a plain site URL (mappings/jobs store URLs, not ids).
async function resolveSiteId(req, siteUrl) {
  const u = new URL(siteUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const site = await graphGet(req, path && path !== '/' ? `/sites/${u.host}:${path}` : `/sites/${u.host}`);
  return site.id;
}

// Ensures the current project's engine identity holds a fullcontrol
// Sites.Selected grant on the site - creating, or upgrading a weaker role,
// only when actually needed (grants persist until revoked, so in the steady
// state this is a single read). Uses the signed-in admin's delegated token
// (Sites.FullControl.All), exactly like the manual "Grant migration engine
// access" button - this is that button, made automatic.
//
// Delete-then-recreate on upgrade because Graph's PATCH /permissions/{id}
// doesn't support changing roles on an application-identity grant.
async function ensureEngineSiteAccessBySiteId(req, siteId) {
  const engineClientId = resolveEngineClientId(req);
  const existing = await graphGet(req, `/sites/${siteId}/permissions`);
  const ourGrant = (existing.value || []).find((p) =>
    (p.grantedToIdentitiesV2 || p.grantedToIdentities || []).some((g) => g.application?.id === engineClientId)
  );
  if (ourGrant && (ourGrant.roles || []).includes('fullcontrol')) {
    return { ok: true, action: 'already-granted' };
  }
  if (ourGrant) await graphDelete(req, `/sites/${siteId}/permissions/${ourGrant.id}`);
  await graphPost(req, `/sites/${siteId}/permissions`, {
    roles: ['fullcontrol'],
    grantedToIdentities: [{ application: { id: engineClientId, displayName: 'Content Migration Tool' } }],
  });
  return { ok: true, action: ourGrant ? 'upgraded' : 'granted' };
}

async function ensureEngineSiteAccess(req, siteUrl) {
  const siteId = await resolveSiteId(req, siteUrl);
  const result = await ensureEngineSiteAccessBySiteId(req, siteId);
  return { siteUrl, ...result };
}

module.exports = { ensureEngineSiteAccess, ensureEngineSiteAccessBySiteId, resolveEngineClientId };
