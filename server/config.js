// Anchored to __dirname, not process.cwd() - when this runs via `npm run dev`
// through the npm workspaces script (`npm run dev -w server`), npm sets cwd to
// this package's own directory (server/), not the repo root where .env lives.
// A bare dotenv.config() would silently look for server/.env and find nothing.
require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  return v;
}

const path = require('node:path');
const fs = require('node:fs');
const resolvedEngineScriptPath = path.resolve(
  __dirname, '..', required('ENGINE_SCRIPT_PATH', './engine/Invoke-MigrationJob.ps1')
);
// Fails loudly at server startup instead of at job-run time - a malformed
// .env (e.g. two lines accidentally glued onto one, with no newline between
// them) silently corrupts whichever variable comes first with the text of
// whatever follows it, producing a nonsense path here. Left uncaught, that
// only surfaces later as a confusing PowerShell "argument ... is not
// recognized as the name of a script file" / exit code 64 the first time a
// job actually tries to run.
if (!fs.existsSync(resolvedEngineScriptPath)) {
  throw new Error(
    `ENGINE_SCRIPT_PATH does not resolve to a real file: "${resolvedEngineScriptPath}". ` +
    'Check .env for two variables accidentally merged onto one line (a common cause: ' +
    'appending a new variable right after an existing one without a line break first).'
  );
}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  tenantId: required('TENANT_ID', ''),
  // Display-only; '' is fine (the default project is then named "Default
  // project" and the Settings page shows a dash). The old placeholder
  // default leaked into the UI header as a literal project name.
  tenantName: required('TENANT_NAME', ''),
  clientId: required('CLIENT_ID', ''),
  clientSecret: required('CLIENT_SECRET', ''),
  redirectUri: required('REDIRECT_URI', 'http://localhost:3000/auth/redirect'),
  postLogoutRedirectUri: required('POST_LOGOUT_REDIRECT_URI', 'http://localhost:3000'),
  delegatedScopes: (process.env.DELEGATED_SCOPES ||
    'openid profile email offline_access User.Read Sites.Read.All Files.Read.All'
  ).split(' ').filter(Boolean),

  // What a BARE sign-in (no ?project= - a team member identifying themself)
  // asks for: just enough to know who they are. The heavy DELEGATED_SCOPES
  // above (site browsing, file reads, Sites.FullControl.All for engine
  // grants) are only requested on a project-scoped sign-in, where the user
  // is actually going to work against that tenant - so a teammate's first
  // login shows a one-line consent, not a "full control of all your site
  // collections" wall.
  identityScopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read'],

  sessionSecret: required('SESSION_SECRET', 'dev-only-insecure-secret'),

  // Restricts who may sign in at all, by the DOMAIN of the authenticated
  // account (e.g. `ALLOWED_LOGIN_DOMAINS=knowall.net`) - the "only our team
  // uses this instance" control. Comma/space-separated, case-insensitive,
  // matched against the account's UPN/email including the un-mangled home
  // UPN of B2B guest accounts (user_domain#EXT#@tenant... forms). Empty =
  // no restriction (the pre-existing behaviour). Gates bare identity
  // sign-ins; a client tenant's own GA may still complete a PROJECT-scoped
  // sign-in for an existing project bound to (or being bound to) their
  // tenant - see nonTeamProjectSignInAllowed in server/auth/routes.js.
  allowedLoginDomains: (process.env.ALLOWED_LOGIN_DOMAINS || '')
    .split(/[,\s]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),

  // UPNs (comma/space-separated, case-insensitive) force-promoted to the
  // 'admin' role at every login - admins see every user's mappings/jobs,
  // members only their own. Users that existed before roles were introduced
  // are grandfathered as admin (see server/db/index.js); everyone else
  // defaults to 'member'.
  adminUpns: (process.env.ADMIN_UPNS || '')
    .split(/[,\s]+/).map((u) => u.trim().toLowerCase()).filter(Boolean),

  sqliteDbPath: required('SQLITE_DB_PATH', './data/migration.db'),

  defaultJobConcurrency: parseInt(process.env.DEFAULT_JOB_CONCURRENCY || '4', 10),
  globalMaxConcurrency: parseInt(process.env.GLOBAL_MAX_CONCURRENCY || '12', 10),
  retryRateBackoffThreshold: parseFloat(process.env.RETRY_RATE_BACKOFF_THRESHOLD || '0.20'),
  slowTransferThresholdMs: parseInt(process.env.SLOW_TRANSFER_THRESHOLD_MS || '30000', 10),

  pwshExecutable: required('PWSH_EXECUTABLE', 'pwsh'),
  engineScriptPath: resolvedEngineScriptPath,
  engineCertThumbprint: required('ENGINE_CERT_THUMBPRINT', ''),
  // The shared engine identity's PFX file (written by setup/New-AppRegistration.ps1
  // together with pfx-password.txt beside it). Preferred over the thumbprint:
  // a file travels with the install, while a cert-store thumbprint only works
  // on the exact machine+account where the setup script ran or where someone
  // remembered to Import-PfxCertificate.
  engineCertPath: path.resolve(__dirname, '..', required('ENGINE_CERT_PATH', './setup/certs/migration-engine.pfx')),
  enginePermissionMode: required('ENGINE_PERMISSION_MODE', 'Sites.Selected'),

  // Optional: archive-to-Azure-Blob target. Empty disables the feature
  // entirely - hidden in the UI (see /api/settings blobArchivingEnabled)
  // and rejected server-side if a job somehow requests it anyway.
  azureBlobConnectionString: required('AZURE_BLOB_CONNECTION_STRING', ''),

  // Optional: migrate-into-a-user's-OneDrive target. Unlike the blob target
  // this needs no stored secret - it rides the engine's existing app-only
  // cert - but it DOES require the app registration to hold the
  // Files.ReadWrite.All Graph permission (tenant-wide standing file access,
  // a much bigger grant than the per-site Sites.Selected model everything
  // else here uses - see setup/New-AppRegistration.ps1 -EnableOneDriveTarget
  // and COMPLIANCE.md). Defaults off; hidden in the UI (see /api/settings
  // onedriveTargetEnabled) and rejected server-side if a job somehow
  // requests it anyway.
  onedriveTargetEnabled: process.env.ENGINE_ONEDRIVE_TARGET_ENABLED === 'true',

  // Optional server-wide FALLBACK roots for the file-share (DFS) migration
  // source - the normal way is per-project via the Settings page
  // (projects.fs_source_roots); server/util/fsSource.js merges both.
  // Semicolon-separated, e.g. `FS_SOURCE_ROOTS=\\corp\dfs\A;\\filesrv\B`.
  // Roots listed here are visible to EVERY project on this instance; the
  // browse endpoint reads the SERVER's filesystem with the server process's
  // own account - never point it anywhere broader than the shares being
  // migrated.
  fsSourceRoots: (process.env.FS_SOURCE_ROOTS || '')
    .split(';').map((r) => r.trim()).filter(Boolean),

  // Optional server-side BOUND on the per-project file-share allowlists:
  // when set (semicolon-separated), every root added on any project's
  // Settings page must live under one of these parents. This is the control
  // that stops a signed-in project user pointing the tool's service account
  // at arbitrary server/network paths (C:\, \\dc01\c$, ...) - set it to the
  // migration share(s), e.g. FS_SOURCE_ALLOWED_PARENTS=\\10.5.92.10\Fastdata$.
  // Empty = no bound (the pre-existing behaviour).
  fsSourceAllowedParents: (process.env.FS_SOURCE_ALLOWED_PARENTS || '')
    .split(';').map((r) => r.trim()).filter(Boolean),

  // Encrypts each Project's auto-provisioned engine client secret at rest
  // in SQLite (see server/util/secretCrypto.js) - a 32-byte base64 value,
  // e.g. `openssl rand -base64 32`. Generate once and never change it
  // (changing it makes every already-stored per-project secret undecryptable).
  credentialEncryptionKey: required('CREDENTIAL_ENCRYPTION_KEY', ''),
};
