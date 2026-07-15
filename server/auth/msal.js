const msal = require('@azure/msal-node');
const config = require('../config');

// Multi-tenant app registration (signInAudience: AzureADMultipleOrgs) - the
// login/redirect flow doesn't know which tenant a user belongs to until
// after they've authenticated, so it's built against this fixed,
// tenant-agnostic authority rather than a single hardcoded tenant. Once a
// session knows its real tenant (req.session.tenantId, set in
// auth/routes.js from result.account.tenantId post-login), getMsalClient
// switches to that tenant-specific authority for correct silent-refresh
// behaviour. 'organizations' (not 'common') excludes personal Microsoft
// accounts, matching AzureADMultipleOrgs.
const ORGANIZATIONS_AUTHORITY = 'https://login.microsoftonline.com/organizations';

// Builds a fresh ConfidentialClientApplication per request (MSAL Node's
// recommended web-app pattern, since a real deployment could run behind a
// load balancer / multiple processes and can't rely on one process's
// in-memory cache surviving for a given user).
//
// NOTE: this deliberately does NOT use the `cache.cachePlugin` hook pattern
// documented in MSAL's samples. In practice (msal-node 2.16.x), the
// beforeCacheAccess hook fires for acquireTokenByCode but is never invoked by
// acquireTokenSilent's internal SilentFlowClient/RefreshTokenClient, which
// read straight from the client's own in-memory cache manager - so a plugin
// bound to a brand-new per-request client is populated on write but silently
// never consulted on read, and acquireTokenSilent fails with
// `no_tokens_found` even though the refresh token is sitting right there in
// the session. Explicitly deserializing into the client's public
// getTokenCache() immediately after construction sidesteps that hook
// entirely and is the same underlying cache manager every operation reads.
function getMsalClient(session, opts = {}) {
  const authority = opts.authority
    || (session.tenantId ? `https://login.microsoftonline.com/${session.tenantId}` : ORGANIZATIONS_AUTHORITY);
  const client = new msal.ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority,
      clientSecret: config.clientSecret,
    },
  });
  if (session.msalTokenCache) {
    client.getTokenCache().deserialize(session.msalTokenCache);
  }
  return client;
}

// Call after any operation that may have written new tokens (acquireTokenByCode,
// acquireTokenSilent) so the refreshed cache - not just the pre-call snapshot -
// is what's saved back into the session.
function persistMsalCache(session, client) {
  session.msalTokenCache = client.getTokenCache().serialize();
}

// Returns a fresh Graph access token for the signed-in user, refreshing silently
// via the cached refresh token if the access token has expired. Used only for the
// SharePoint browser/picker + /me - never for the long-running migration engine.
//
// `scopes` defaults to the full working set; pass config.identityScopes for
// calls that must also succeed on an identity-only session (a bare team
// sign-in consented to nothing beyond User.Read, so silently requesting the
// working scopes there fails with interaction_required).
async function getGraphToken(req, scopes) {
  if (!req.session.account) return null;
  const client = getMsalClient(req.session);
  try {
    const result = await client.acquireTokenSilent({
      account: req.session.account,
      scopes: (scopes || config.delegatedScopes).filter((s) => !['openid', 'profile', 'email', 'offline_access'].includes(s)),
    });
    persistMsalCache(req.session, client);
    return result.accessToken;
  } catch (err) {
    // Log rather than swallow - a real failure here (expired refresh token,
    // revoked consent, conditional access) used to be indistinguishable from
    // "not signed in yet", bouncing the UI back to the login screen with zero
    // explanation.
    console.error('[auth] acquireTokenSilent failed:', err.errorCode || err.name, '-', err.errorMessage || err.message);
    return null;
  }
}

module.exports = { getMsalClient, persistMsalCache, getGraphToken, ORGANIZATIONS_AUTHORITY };
