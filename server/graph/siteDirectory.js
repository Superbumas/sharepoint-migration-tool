const { graphGet, GRAPH_ROOT } = require('./client');
const { getProjectId } = require('../auth/middleware');

// Graph's GET /sites?search= runs through SharePoint Search, which is
// security-trimmed to sites the signed-in user can already open. A
// group-connected Team site whose only admins are "Group owners" is
// invisible to a Global/SharePoint admin who isn't in that group - it shows
// in the SharePoint admin center (which lists every site) but search returns
// nothing. This module is the admin-center's view: the hidden tenant-admin
// list behind the "Active sites" page, which a SharePoint admin can read
// with the same delegated Sites.Read.All token. Best-effort - a non-admin
// caller (or a tenant that blocks it) just gets no extra results.

const ADMIN_SITE_LIST = 'DO_NOT_DELETE_SPLIST_TENANTADMIN_AGGREGATED_SITECOLLECTIONS';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PAGES = 20; // 20 x 999 rows - far beyond any tenant we migrate
const cache = new Map(); // projectId -> { at, rows }

async function tenantHost(req) {
  const root = await graphGet(req, '/sites/root', { $select: 'siteCollection,webUrl' });
  return root.siteCollection?.hostname || new URL(root.webUrl).host;
}

// Every site collection the admin center knows about, as
// { title, url, storageUsed, lastActivity }. Deleted sites are dropped.
async function listAllTenantSites(req) {
  const key = getProjectId(req) || 'default';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;

  const host = await tenantHost(req);
  const adminHost = host.replace(/\.sharepoint\.com$/i, '-admin.sharepoint.com');
  const adminSite = await graphGet(req, `/sites/${adminHost}`, { $select: 'id' });

  const rows = [];
  let path = `/sites/${adminSite.id}/lists/${ADMIN_SITE_LIST}/items`;
  let params = { $expand: 'fields', $top: 999 };
  for (let page = 0; path && page < MAX_PAGES; page++) {
    const data = await graphGet(req, path, params);
    for (const item of data.value || []) {
      const f = item.fields || {};
      if (!f.SiteUrl || f.TimeDeleted) continue;
      rows.push({
        title: f.Title || '',
        url: f.SiteUrl,
        storageUsed: f.StorageUsed != null ? Number(f.StorageUsed) : null,
        lastActivity: f.LastActivityOn || null,
      });
    }
    const next = data['@odata.nextLink'];
    path = next ? next.slice(GRAPH_ROOT.length) : null;
    params = {};
  }
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

// Loose match: every word of the query must appear in the title or URL, and
// the URL also matches with spaces removed ("SHEQ Management Systems" ->
// .../sites/SHEQManagementSystems2).
function matchesQuery(row, query) {
  const hay = `${row.title} ${row.url}`.toLowerCase();
  const q = query.toLowerCase();
  if (hay.includes(q.replace(/\s+/g, ''))) return true;
  return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

async function searchTenantSites(req, query) {
  const rows = await listAllTenantSites(req);
  return rows.filter((r) => matchesQuery(r, query));
}

// Graph site for a pasted URL ("https://t.sharepoint.com/sites/X/...",
// "t.sharepoint.com/sites/X" or just "/sites/X"). Trailing library/folder
// segments are ignored - only the /sites/{name} or /teams/{name} part counts.
async function resolveSiteFromUrl(req, input) {
  let text = input.trim();
  if (text.startsWith('/')) text = `https://${await tenantHost(req)}${text}`;
  else if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  const u = new URL(text);
  const m = decodeURIComponent(u.pathname).match(/^\/(sites|teams)\/[^/]+/i);
  const path = m ? m[0] : '';
  return graphGet(req, path ? `/sites/${u.host}:${path}` : `/sites/${u.host}`);
}

function looksLikeSiteUrl(text) {
  return /sharepoint\.com/i.test(text) || /^\/(sites|teams)\//i.test(text.trim());
}

module.exports = { searchTenantSites, resolveSiteFromUrl, looksLikeSiteUrl };
