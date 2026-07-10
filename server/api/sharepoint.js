const express = require('express');
const { requireAuth } = require('../auth/middleware');
const { graphGet } = require('../graph/client');
const { ensureEngineSiteAccessBySiteId } = require('../graph/siteAccess');

const router = express.Router();
router.use(requireAuth);

// List sites - auto-detects every site the signed-in user can see (Graph
// search '*') when no query is given, enriched with each site's default-drive
// storage usage and last activity, sorted biggest first. Enrichment is
// best-effort per site: locked/archived sites (423 resourceLocked) and other
// per-site failures just come back without numbers instead of failing the
// whole list.
router.get('/sharepoint/sites', async (req, res, next) => {
  try {
    const search = (req.query.search || '').trim();
    const data = await graphGet(req, '/sites', { search: search || '*' });
    let sites = (data.value || []).slice(0, 50);
    sites = await Promise.all(sites.map(async (s) => {
      try {
        const drive = await graphGet(req, `/sites/${s.id}/drive`, { $select: 'quota,lastModifiedDateTime' });
        return {
          ...s,
          storageUsed: drive.quota?.used ?? null,
          lastActivity: drive.lastModifiedDateTime || s.lastModifiedDateTime || null,
        };
      } catch {
        return { ...s, storageUsed: null, lastActivity: s.lastModifiedDateTime || null, inaccessible: true };
      }
    }));
    sites.sort((a, b) => (b.storageUsed || 0) - (a.storageUsed || 0));
    res.json({ items: sites });
  } catch (err) {
    next(err);
  }
});

// Read-only diagnostic: lists the actual permission grants currently on a
// site, so a failed grant (or one that hasn't propagated yet) is visible
// instead of just trusting the POST call's response.
router.get('/sharepoint/sites/:siteId/permissions', async (req, res, next) => {
  try {
    const data = await graphGet(req, `/sites/${req.params.siteId}/permissions`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Grants this Project's own dedicated engine app (see
// server/graph/provisionTenantApp.js) access to this specific site, via
// Graph's site-permissions API - the in-app equivalent of running
// Grant-PnPAzureADAppSitePermission by hand. Requires the signed-in user's
// delegated token to include Sites.FullControl.All (tenant admin consent for
// that scope is a one-time setup step - see README/.env.example). This is
// what actually authorizes the engine's app-only credential to read/write
// this site's content; admin-consenting the Sites.Selected permission alone
// only allows the app to exist, it does not grant per-site access.
//
// Falls back to the shared config.clientId only for a legacy project that
// predates per-project engine apps (engine_client_id still NULL) - every
// project created from here on has its own.
//
// Uses the "fullcontrol" role. "write" is enough for a site whose content
// all inherits permissions, but it behaves like a site-level role
// assignment: folders/files with broken permission inheritance (uniquely
// permissioned items - e.g. anything that was ever shared or had its
// permissions edited) are invisible to the app and return "Access denied"
// when addressed directly, even though the site itself connects fine.
// "fullcontrol" gives the app site-collection-admin-level access that is
// honored regardless of item-level permissions. Note the valid elevated
// role names for this API are "manage" and "fullcontrol" - an earlier
// attempt at "owner" (PnP's name for it) was silently accepted by Graph
// but stored as roles: ["none"], effectively revoking access.
//
// Idempotent: if this app already has a grant on the site, removes it first
// instead of leaving a stale lower-privilege entry alongside a new one -
// Graph's PATCH /permissions/{id} doesn't support changing roles on an
// application-identity grant (returns 400 invalidRequest), so delete-then-
// recreate is the reliable way to change an existing grant's role.
router.post('/sharepoint/sites/:siteId/grant-engine-access', async (req, res, next) => {
  try {
    const result = await ensureEngineSiteAccessBySiteId(req, req.params.siteId);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});

// Document libraries (drives) for a given site, each with its actual content
// size. Surfacing the "Preservation Hold Library" size here is deliberate:
// on sites under a Microsoft 365 retention policy every deleted/changed file
// is copied there, quietly eating quota that no amount of deleting frees -
// making it visible is the first step to understanding "why is this site
// still full".
router.get('/sharepoint/sites/:siteId/drives', async (req, res, next) => {
  try {
    const data = await graphGet(req, `/sites/${req.params.siteId}/drives`);
    const items = await Promise.all((data.value || []).map(async (d) => {
      try {
        const root = await graphGet(req, `/drives/${d.id}/root`, { $select: 'size' });
        return { ...d, sizeBytes: root.size ?? null };
      } catch {
        return { ...d, sizeBytes: null };
      }
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// Root-level children of a drive (document library).
router.get('/sharepoint/drives/:driveId/root-children', async (req, res, next) => {
  try {
    const data = await graphGet(req, `/drives/${req.params.driveId}/root/children`, {
      $select: 'id,name,size,folder,file,webUrl,parentReference,lastModifiedDateTime',
      $top: 200,
    });
    res.json({ items: data.value || [], breadcrumb: [] });
  } catch (err) {
    next(err);
  }
});

// Children of a specific folder item - the recursive browse step.
router.get('/sharepoint/drives/:driveId/items/:itemId/children', async (req, res, next) => {
  try {
    const data = await graphGet(req, `/drives/${req.params.driveId}/items/${req.params.itemId}/children`, {
      $select: 'id,name,size,folder,file,webUrl,parentReference,lastModifiedDateTime',
      $top: 200,
    });
    res.json({ items: data.value || [] });
  } catch (err) {
    next(err);
  }
});

// Single item metadata - used to build breadcrumb trails by walking parentReference.
router.get('/sharepoint/drives/:driveId/items/:itemId', async (req, res, next) => {
  try {
    const data = await graphGet(req, `/drives/${req.params.driveId}/items/${req.params.itemId}`, {
      $select: 'id,name,size,folder,file,webUrl,parentReference',
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Search within a drive - lets the user jump straight to a folder/file by name
// instead of clicking through the tree.
router.get('/sharepoint/drives/:driveId/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ items: [] });
    const data = await graphGet(
      req,
      `/drives/${req.params.driveId}/root/search(q='${encodeURIComponent(q)}')`,
      { $select: 'id,name,size,folder,file,webUrl,parentReference' }
    );
    res.json({ items: data.value || [] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
