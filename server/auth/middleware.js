function requireAuth(req, res, next) {
  if (!req.session.account || !req.session.profile || !req.session.tenantId || !req.session.projectId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  next();
}

// Identity to stamp against every action a signed-in user takes (approve, run,
// pause, cancel, delete, and every mapping/job they create) for the audit trail.
function getActor(req) {
  const p = req.session.profile;
  if (!p) return { name: 'unknown', email: null, upn: null };
  return { name: p.displayName, email: p.email, upn: p.upn };
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

module.exports = { requireAuth, getActor, getTenantId, getProjectId };
