const { getDb } = require('../db');

function requireAuth(req, res, next) {
  if (!req.session.account || !req.session.profile || !req.session.tenantId || !req.session.projectId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

// Identity to stamp against every action a signed-in user takes (approve, run,
// pause, cancel, delete, and every mapping/job they create) for the audit trail
// AND for ownership (id = users.id = Azure AD oid, written to owner_user_id).
function getActor(req) {
  const p = req.session.profile;
  if (!p) return { id: null, name: 'unknown', email: null, upn: null };
  return { id: p.id, name: p.displayName, email: p.email, upn: p.upn };
}

// The signed-in Global Admin's Azure AD tenant (set in auth/routes.js from
// result.account.tenantId at login) - scopes every mapping/job/query to the
// client tenant they're currently working in, since the app is multi-tenant
// and one shared SQLite DB serves every tenant that's ever signed in.
function getTenantId(req) {
  return req.session.tenantId;
}

// The Project (see server/api/projects.js) this session is scoped to - a
// friendlier, explicitly-named wrapper around one tenant. Not used for data
// scoping directly (mappings/jobs are still scoped by tenant_id, unchanged),
// just for display and for resolving which project a sign-in belongs to.
function getProjectId(req) {
  return req.session.projectId;
}

function getUserId(req) {
  return req.session.profile?.id || null;
}

// Read live from the DB, not the session snapshot taken at login - promoting
// a teammate to admin must take effect on their next request, not their next
// sign-in. SQLite point reads are effectively free at this scale.
function isAdmin(req) {
  const id = getUserId(req);
  if (!id) return false;
  return getDb().prepare('SELECT role FROM users WHERE id = ?').get(id)?.role === 'admin';
}

// The second data-isolation axis, alongside tenant_id: WHO within the team
// may see a row. Returns an SQL fragment (starting with ' AND ...') plus its
// params, to be appended to any query over a table with owner_user_id.
//
//   - admins: no clause - they see everything in the tenant.
//   - members: their own rows plus NULL-owner rows (rows that predate
//     ownership - hiding those on upgrade would make existing data vanish).
//
// `alias` prefixes the column for joined queries (e.g. 'j' -> j.owner_user_id).
function ownerScope(req, alias) {
  if (isAdmin(req)) return { sql: '', params: [] };
  const col = alias ? `${alias}.owner_user_id` : 'owner_user_id';
  return { sql: ` AND (${col} = ? OR ${col} IS NULL)`, params: [getUserId(req)] };
}

// True when this request may see/act on the given row (a raw jobs/mappings
// row with owner_user_id). Same visibility rule as ownerScope, for call
// sites that already fetched the row tenant-scoped.
function canAccessRow(req, row) {
  if (!row) return false;
  if (!row.owner_user_id) return true; // legacy/shared row
  return row.owner_user_id === getUserId(req) || isAdmin(req);
}

module.exports = { requireAuth, getActor, getTenantId, getProjectId, getUserId, isAdmin, ownerScope, canAccessRow };
