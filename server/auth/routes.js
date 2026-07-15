const express = require('express');
const axios = require('axios');
const { v4: uuid } = require('uuid');
const config = require('../config');
const { getMsalClient, persistMsalCache, getGraphToken, ORGANIZATIONS_AUTHORITY } = require('./msal');
const { generatePkcePair, generateState } = require('./pkce');
const { getDb } = require('../db');
const { provisionTenantApp, ensureEngineAppRoles } = require('../graph/provisionTenantApp');
const { encrypt, decrypt } = require('../util/secretCrypto');

const router = express.Router();

// True only when the project's stored engine credential is complete AND
// actually decryptable with the current CREDENTIAL_ENCRYPTION_KEY. Covers
// three broken states that must all trigger (re-)provisioning at sign-in:
// never provisioned, half-provisioned (client-secret-era row with no cert),
// and undecryptable (the encryption key changed since it was saved).
function engineCredentialUsable(project) {
  if (!project?.engine_client_id || !project.engine_cert_base64_encrypted) return false;
  if (!config.credentialEncryptionKey) return false;
  try {
    decrypt(project.engine_cert_base64_encrypted, config.credentialEncryptionKey);
    return true;
  } catch {
    return false;
  }
}

// Only requested on the specific login that provisions a new Project's own
// dedicated, tenant-local app registration (server/graph/provisionTenantApp.js)
// - never part of an ordinary sign-in's scopes. Declared on the shared app
// registration (setup/New-AppRegistration.ps1) but not consented/used unless
// actually requested.
const PROJECT_PROVISION_SCOPES = [...config.delegatedScopes, 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All'];

// Every identity string this sign-in could be known by, normalized to plain
// user@domain lowercase. B2B guests matter here: a knowall.net user signing
// into a client tenant they're a guest in authenticates fine, but their UPN
// *in that tenant* is the mangled `user_knowall.net#EXT#@client.onmicrosoft.com`
// form - un-mangle it so the domain allowlist still recognizes them.
function accountIdentities(account) {
  const candidates = [
    account?.username,
    account?.idTokenClaims?.preferred_username,
    account?.idTokenClaims?.email,
    account?.idTokenClaims?.upn,
  ].filter(Boolean).map((s) => String(s).toLowerCase());
  const out = new Set();
  for (const c of candidates) {
    out.add(c);
    const extIdx = c.indexOf('#ext#');
    if (extIdx > 0) {
      // user_domain#EXT#@tenant -> user@domain (last '_' before #EXT# is the
      // mangled '@'; earlier underscores belong to the username itself).
      const mangled = c.slice(0, extIdx);
      const lastUnderscore = mangled.lastIndexOf('_');
      if (lastUnderscore > 0) out.add(`${mangled.slice(0, lastUnderscore)}@${mangled.slice(lastUnderscore + 1)}`);
    }
  }
  return [...out];
}

// The "only our team may sign in" gate (ALLOWED_LOGIN_DOMAINS in .env).
// Checked on every sign-in leg - ordinary, project-bound, provisioning and
// repair alike - so a client-tenant GA account can only use this instance if
// its domain is explicitly listed. Empty list = no restriction.
function loginAllowed(account) {
  if (!config.allowedLoginDomains.length) return true;
  return accountIdentities(account).some((id) => {
    const domain = id.split('@')[1];
    return domain && config.allowedLoginDomains.includes(domain);
  });
}

router.get('/auth/login', async (req, res, next) => {
  try {
    const { verifier, challenge } = generatePkcePair();
    const state = generateState();
    req.session.pkceVerifier = verifier;
    req.session.authState = state;

    // ?project=<id> ties this sign-in to a specific Project (see
    // server/api/projects.js) - stashed in the session so /auth/redirect can
    // bind (first time) or verify (subsequent times) that project's tenant
    // once the real tenant is known post-login.
    let authority = ORGANIZATIONS_AUTHORITY;
    let needsProvisionScopes = false;
    if (req.query.project) {
      req.session.pendingProjectId = req.query.project;
      const project = getDb().prepare('SELECT tenant_id, engine_client_id, engine_cert_base64_encrypted FROM projects WHERE id = ?').get(req.query.project);
      // Already-bound project: skip the generic multi-tenant picker and go
      // straight to that tenant's own sign-in page - a nicer "open this
      // project" experience than always landing on the ambiguous /organizations
      // chooser. A brand-new (unbound) project has no tenant yet, so it still
      // uses the generic authority for its first-ever sign-in.
      if (project?.tenant_id) authority = `https://login.microsoftonline.com/${project.tenant_id}`;
      // Not yet provisioned - a brand-new project (no tenant_id), one whose
      // dedicated app creation failed last time (has a tenant_id but no
      // engine_client_id), or a half-provisioned row from the abandoned
      // client-secret era (engine_client_id but no certificate - unusable by
      // the engine, must be re-provisioned; see /auth/redirect below).
      // Request the extra scopes needed to (re)try provisioning this time.
      // The operator's own tenant is deliberately NOT special-cased anymore:
      // every tenant - home included - gets its own dedicated engine app.
      // Projects grandfathered on the original shared certificate keep
      // working via resolveEngineIdentity's fallback until their next
      // sign-in provisions them.
      if (project && (!project.tenant_id || !engineCredentialUsable(project))) {
        needsProvisionScopes = true;
      }
      // A permissions-repair leg (from /auth/repair-engine) always needs the
      // management scopes even though the project's credential is already
      // usable - it's topping up the app's ROLES, not its certificate.
      if (req.query.repair) needsProvisionScopes = true;
    } else {
      delete req.session.pendingProjectId;
    }
    req.session.pendingProvisionScopes = needsProvisionScopes;

    // Three consent tiers, narrowest that fits this leg:
    //   identity  - bare sign-in, team member identifying themself (User.Read)
    //   working   - opening a project: site pickers, file reads, engine grants
    //   provision - first-ever project sign-in: working + app-creation scopes
    // The tier actually requested is stashed on the session because the
    // /auth/redirect token exchange must ask for EXACTLY what the auth code
    // was granted for.
    const scopes = needsProvisionScopes ? PROJECT_PROVISION_SCOPES
      : req.query.project ? config.delegatedScopes
      : config.identityScopes;
    req.session.pendingLoginScopes = scopes;

    // Always the tenant-agnostic (or that project's own) authority,
    // regardless of any tenantId left over on this session from a previous
    // login - a browser could sign out and sign back into a different project.
    const client = getMsalClient(req.session, { authority });
    const url = await client.getAuthCodeUrl({
      scopes,
      redirectUri: config.redirectUri,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
    });
    res.redirect(url);
  } catch (err) {
    next(err);
  }
});

// One-time, explicit path for a client tenant that hasn't consented to this
// app yet - a Global Admin's ordinary sign-in often auto-offers "consent on
// behalf of your organization" for admin-restricted scopes, so this is only
// needed as a fallback (see the error branch in /auth/redirect below). This
// is a distinct Microsoft flow from the OIDC/PKCE login - no code is
// returned, just admin_consent=True&tenant=... on success.
router.get('/auth/admin-consent', (req, res) => {
  const state = generateState();
  req.session.adminConsentState = state;
  const url = 'https://login.microsoftonline.com/organizations/v2.0/adminconsent' +
    `?client_id=${encodeURIComponent(config.clientId)}` +
    `&scope=${encodeURIComponent('https://graph.microsoft.com/.default')}` +
    `&redirect_uri=${encodeURIComponent(config.redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

// "Re-sync engine app permissions" from the Settings → Permissions panel.
// Bounces the signed-in admin through a provisioning-scope login leg (SSO
// makes it near-silent) so the callback below has a token that can grant app
// roles, then tops up the CURRENT project's own engine app to the required
// permission set (server/graph/provisionTenantApp.js ensureEngineAppRoles).
router.get('/auth/repair-engine', (req, res) => {
  if (!req.session.projectId) return res.redirect('/?authError=not_authenticated');
  req.session.pendingRepairEngine = true;
  res.redirect(`/auth/login?project=${req.session.projectId}&repair=1`);
});

router.get('/auth/redirect', async (req, res, next) => {
  try {
    // Returning from /auth/admin-consent, not the normal login flow - its
    // own state value (separate from authState, since no login was in
    // progress), and consent is all this leg does; the actual sign-in
    // happens on the /auth/login redirect right after.
    if (req.query.admin_consent !== undefined) {
      if (!req.query.state || req.query.state !== req.session.adminConsentState) {
        return res.status(400).send('Invalid consent state - please try again.');
      }
      delete req.session.adminConsentState;
      return res.redirect('/auth/login');
    }

    // Azure AD couldn't complete the sign-in - most commonly because this
    // tenant hasn't consented to the app yet (AADSTS65001/90094 and
    // similar). Send the user to a message pointing at /auth/admin-consent
    // instead of falling through to acquireTokenByCode with an undefined code.
    if (req.query.error) {
      console.error('[auth] /auth/redirect error from Azure AD:', req.query.error, '-', req.query.error_description);
      return res.redirect('/?authError=consent_required');
    }

    if (!req.query.state || req.query.state !== req.session.authState) {
      return res.status(400).send('Invalid auth state - please try signing in again.');
    }
    // Must match whatever /auth/login actually requested for this same
    // sign-in - MSAL's token exchange is against the code's own granted
    // scopes, not an independent request. wasProvisionLeg also guards the
    // provisioning bounce below against redirect loops. The fallback covers
    // a session that somehow lost pendingLoginScopes (e.g. an in-flight
    // login started before this deploy).
    const wasProvisionLeg = !!req.session.pendingProvisionScopes;
    const scopes = req.session.pendingLoginScopes
      || (wasProvisionLeg ? PROJECT_PROVISION_SCOPES : config.delegatedScopes);
    delete req.session.pendingProvisionScopes;
    delete req.session.pendingLoginScopes;
    const client = getMsalClient(req.session, { authority: ORGANIZATIONS_AUTHORITY });
    const result = await client.acquireTokenByCode({
      code: req.query.code,
      scopes,
      redirectUri: config.redirectUri,
      codeVerifier: req.session.pkceVerifier,
    });
    persistMsalCache(req.session, client);

    // Team allowlist gate - BEFORE anything is written to the session or DB.
    // A disallowed account gets a clean signed-out state and a clear message,
    // never a half-authenticated session.
    if (!loginAllowed(result.account)) {
      console.warn('[auth] Rejected sign-in for', result.account?.username, '- not in ALLOWED_LOGIN_DOMAINS');
      return req.session.destroy(() => res.redirect('/?authError=account_not_allowed'));
    }

    req.session.account = result.account;
    // MSAL's AccountInfo already carries the real tenant GUID - this is the
    // one piece of state that makes the rest of the app (mappings/jobs/the
    // PowerShell engine) tenant-aware instead of using one hardcoded tenant.
    req.session.tenantId = result.account.tenantId;
    delete req.session.pkceVerifier;
    delete req.session.authState;

    // Best-effort, zero-new-scopes tenant label: the UPN domain suffix from
    // the token MSAL already has, not a Graph /organization call (that would
    // need a new Organization.Read.All permission just for a cosmetic name).
    const tenantDomain = (result.account.username || '').split('@')[1] || null;
    const db = getDb();
    db.prepare(
      `INSERT INTO tenants (id, display_name, last_login_at)
       VALUES (@id, @displayName, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, last_login_at = excluded.last_login_at`
    ).run({ id: req.session.tenantId, displayName: tenantDomain });

    // Resolve which Project this sign-in belongs to: bind a pending one
    // (first-ever sign-in through it), verify an already-bound one wasn't
    // just signed into with the wrong tenant's account, or fall back to
    // whatever project this tenant is already attached to / auto-create one
    // for a tenant that's never been assigned to a project at all (e.g. a
    // bare /auth/login with no ?project= context).
    const pendingProjectId = req.session.pendingProjectId;
    delete req.session.pendingProjectId;
    let project = null;
    if (pendingProjectId) {
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pendingProjectId);
      if (project && !project.tenant_id) {
        db.prepare(`UPDATE projects SET tenant_id = ?, status = 'active', activated_at = datetime('now') WHERE id = ?`)
          .run(req.session.tenantId, project.id);
        project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
      } else if (project && project.tenant_id !== req.session.tenantId) {
        // Signed in with a different tenant's account than this project is
        // bound to - don't silently rebind or half-authenticate; force a
        // clean retry with the right account.
        return req.session.destroy(() => res.redirect('/?authError=wrong_tenant_for_project'));
      }
    }
    if (!project) {
      project = db.prepare('SELECT * FROM projects WHERE tenant_id = ?').get(req.session.tenantId);
    }
    if (!project) {
      const id = uuid();
      db.prepare(`INSERT INTO projects (id, name, tenant_id, status, activated_at) VALUES (?, ?, ?, 'active', datetime('now'))`)
        .run(id, tenantDomain || 'New project', req.session.tenantId);
      project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    }
    req.session.projectId = project.id;

    // First sign-in for this project (or a retry after a previous attempt
    // failed) - create its own dedicated, tenant-local app registration for
    // the engine to use, using this GA's own delegated rights and the
    // extra scopes requested above. Never blocks sign-in from completing:
    // a failure here is surfaced later, at job-run time
    // (server/jobs/orchestrator.js), with a clear "sign in again to retry"
    // message - not by leaving the user stuck on an error page mid-login.
    //
    // EVERY tenant provisions - including the operator's own. The old
    // home-tenant exclusion (kept on the shared certificate forever) is
    // gone; existing unprovisioned home-tenant projects are grandfathered
    // via resolveEngineIdentity's shared-cert fallback until a sign-in
    // like this one gives them a dedicated app.
    //
    // "Not provisioned" covers three broken states (see engineCredentialUsable):
    // never provisioned, half-provisioned (client-secret era), and stored but
    // undecryptable because CREDENTIAL_ENCRYPTION_KEY changed. All three
    // re-provision here exactly like a failed first attempt.
    if (!engineCredentialUsable(project)) {
      if (!config.credentialEncryptionKey) {
        console.error('[auth] Skipping engine app provisioning for project', project.id, '- CREDENTIAL_ENCRYPTION_KEY is not set.');
      } else if (!wasProvisionLeg) {
        // A bare "Sign in with Microsoft" (no ?project=) is an IDENTITY
        // login - it deliberately carries only User.Read (see identityScopes)
        // and must never drag a team member through the full-scope +
        // app-creation consent wall just because their home tenant's
        // placeholder project is unprovisioned. Provisioning happens when
        // someone actually opens the project (the /projects page links go
        // through /auth/login?project=, which requests the provisioning
        // scopes when this credential is unusable) - that is also how a new
        // client tenant is onboarded: create the project, then sign into it
        // with that tenant's GA account.
        console.log(`[auth] Identity sign-in for project ${project.id} - leaving engine app unprovisioned until a project-scoped sign-in.`);
      } else {
        try {
          const provisioned = await provisionTenantApp(result.accessToken, project.name, config.onedriveTargetEnabled);
          db.prepare(
            `UPDATE projects SET engine_client_id = ?, engine_cert_base64_encrypted = ?, engine_cert_password_encrypted = ?, engine_cert_expires_at = ? WHERE id = ?`
          ).run(
            provisioned.clientId,
            encrypt(provisioned.certBase64, config.credentialEncryptionKey),
            encrypt(provisioned.certPassword, config.credentialEncryptionKey),
            provisioned.certExpiresAt,
            project.id
          );
          console.log(`[auth] Provisioned dedicated engine app ${provisioned.clientId} for project ${project.id}`);
        } catch (err) {
          console.error(`[auth] Engine app provisioning failed for project ${project.id}:`, err.message);
        }
      }
    }

    // Permissions-repair leg (from /auth/repair-engine): this token carries
    // the management scopes, so top up the project's existing engine app to
    // the current required role set (idempotent; never re-provisions). The
    // result is stashed for the Settings page to show. A freshly-provisioned
    // project (the block above just ran) already has current roles, so this is
    // a harmless no-op in that case.
    if (req.session.pendingRepairEngine) {
      delete req.session.pendingRepairEngine;
      // Re-read: the provisioning block above may have just set engine_client_id.
      const repairProject = db.prepare('SELECT id, name, engine_client_id FROM projects WHERE id = ?').get(project.id);
      try {
        const repair = await ensureEngineAppRoles(result.accessToken, repairProject, config.onedriveTargetEnabled);
        req.session.lastEngineRepair = { at: new Date().toISOString(), ...repair };
        console.log(`[auth] Engine permission re-sync for project ${project.id}: added [${(repair.added || []).join(', ') || 'none'}]`);
      } catch (err) {
        console.error(`[auth] Engine permission re-sync failed for project ${project.id}:`, err.message);
        req.session.lastEngineRepair = { at: new Date().toISOString(), ok: false, error: err.message };
      }
      await hydrateUserProfile(req);
      return res.redirect('/settings?repair=engine');
    }

    await hydrateUserProfile(req);

    res.redirect('/');
  } catch (err) {
    next(err);
  }
});

router.get('/auth/logout', (req, res) => {
  const tenantId = req.session.tenantId || 'organizations';
  req.session.destroy(() => {
    const logoutUrl =
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout` +
      `?post_logout_redirect_uri=${encodeURIComponent(config.postLogoutRedirectUri)}`;
    res.redirect(logoutUrl);
  });
});

// Fetches /me and /me/photo/$value once per login and caches into SQLite + session
// so the header can show identity without re-hitting Graph on every page load.
async function hydrateUserProfile(req) {
  // identityScopes, not the full working set: this only calls /me and
  // /me/photo, and it MUST also work right after a bare identity sign-in,
  // whose consent covers nothing beyond User.Read.
  const token = await getGraphToken(req, config.identityScopes);
  if (!token) {
    // Used to fail silently here, which left req.session.profile unset with
    // no explanation - /auth/redirect would still redirect to '/' as if sign-in
    // succeeded, and the UI would just show "Sign in" again with no error, since
    // /api/me requires both session.account AND session.profile. Surfacing this
    // as a thrown error (caught by the /auth/redirect route below) means the
    // user sees a real message instead of a silent bounce back to the login screen.
    throw new Error(
      'Signed in, but could not get a Graph token for the basic profile scopes (User.Read/offline_access). ' +
      'Check the server log above for the acquireTokenSilent error - this is usually missing admin consent.'
    );
  }

  const { data: me } = await axios.get('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${token}` },
  });

  let photoDataUrl = null;
  try {
    const photoResp = await axios.get('https://graph.microsoft.com/v1.0/me/photo/$value', {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer',
    });
    const contentType = photoResp.headers['content-type'] || 'image/jpeg';
    photoDataUrl = `data:${contentType};base64,${Buffer.from(photoResp.data).toString('base64')}`;
  } catch (err) {
    // No photo set for this user - not an error condition.
  }

  const profile = {
    id: me.id,
    displayName: me.displayName,
    email: me.mail || me.userPrincipalName,
    upn: me.userPrincipalName,
    photoDataUrl,
  };

  // Role resolution: ADMIN_UPNS force-promotes on every login (so promoting
  // a teammate is a .env edit + their next sign-in, no DB surgery). An
  // existing row's role is otherwise preserved - the CASE keeps a manually
  // promoted admin an admin even though this login computed 'member'.
  // Guests: match ADMIN_UPNS against every identity form of the account
  // (home UPN and mangled #EXT# UPN), same as the login allowlist.
  const identities = accountIdentities(req.session.account)
    .concat([profile.upn, profile.email].filter(Boolean).map((s) => s.toLowerCase()));
  const computedRole = config.adminUpns.some((u) => identities.includes(u)) ? 'admin' : 'member';

  const db = getDb();
  db.prepare(
    `INSERT INTO users (id, display_name, email, upn, photo_data_url, tenant_id, role, last_login_at)
     VALUES (@id, @displayName, @email, @upn, @photoDataUrl, @tenantId, @role, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name, email=excluded.email, upn=excluded.upn,
       photo_data_url=excluded.photo_data_url, tenant_id=excluded.tenant_id, last_login_at=excluded.last_login_at,
       role=CASE WHEN excluded.role='admin' THEN 'admin' ELSE users.role END`
  ).run({ ...profile, tenantId: req.session.tenantId, role: computedRole });

  // Read back rather than trusting computedRole - the CASE above may have
  // kept a stored 'admin' this login didn't compute.
  profile.role = db.prepare('SELECT role FROM users WHERE id = ?').get(profile.id)?.role || 'member';
  req.session.profile = profile;
}

router.get('/api/me', (req, res) => {
  if (!req.session.account || !req.session.profile || !req.session.projectId) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  const db = getDb();
  const project = db.prepare(
    'SELECT id, name, tenant_id, engine_client_id, engine_cert_base64_encrypted FROM projects WHERE id = ?'
  ).get(req.session.projectId);

  // Everything the UI needs to *show* the authentication picture: which
  // tenant this project is bound to and which identity the engine will use
  // for it. clientId is a public identifier (not a secret) - the site picker
  // uses it to check whether a site's permission grants already cover the
  // engine, so users stop re-granting sites blind.
  let projectInfo = null;
  if (project) {
    const isLegacy = project.tenant_id === config.tenantId;
    const dedicated = engineCredentialUsable(project);
    const tenant = project.tenant_id
      ? db.prepare('SELECT display_name FROM tenants WHERE id = ?').get(project.tenant_id)
      : null;
    projectInfo = {
      id: project.id,
      name: project.name,
      tenantId: project.tenant_id,
      tenantName: tenant?.display_name || null,
      engine: {
        clientId: dedicated ? project.engine_client_id : (isLegacy ? config.clientId : null),
        mode: dedicated ? 'dedicated' : (isLegacy ? 'shared' : 'not_provisioned'),
        ready: dedicated || isLegacy,
      },
    };
  }
  // Role is read live from the DB (not the login-time session snapshot) so a
  // promotion/demotion takes effect on the next page load, not the next login.
  const role = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.profile.id)?.role || 'member';
  res.json({ ...req.session.profile, role, project: projectInfo });
});

module.exports = router;
// Exported for tests (engine/tests) - not used by any other runtime module.
module.exports.accountIdentities = accountIdentities;
module.exports.loginAllowed = loginAllowed;
