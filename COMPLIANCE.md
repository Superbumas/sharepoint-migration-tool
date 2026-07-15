# Data handling & security controls

Written for operators running this tool under an information-security
management system (e.g. ISO/IEC 27001): what data the tool touches, where it
flows, what rests where, and which controls exist. Statements here describe
the code as of this document's last commit - verify against the code when in
doubt; file paths are given for that purpose.

## 1. What data the tool processes

| Category | Examples | Where it goes |
|---|---|---|
| Customer file **content** | documents, media | See flow table below - never stored durably by the tool |
| Customer file **metadata** | paths, names, sizes, timestamps, author/editor emails | SQLite (`data/migration.db`), tree-cache JSON, audit log |
| **Identity** data | signed-in users' names, emails, UPNs, profile photo; tenant IDs/domains | SQLite + server session |
| **Credentials** | per-tenant engine app certificates, Azure Blob connection strings, file-share passwords | SQLite, encrypted (see §4) |

## 2. Content flow per migration path

| Path | Content transits the tool's server? | Content at rest on the server? |
|---|---|---|
| SharePoint → SharePoint | **No** - `Copy-PnPFile` is a server-side copy inside SharePoint Online | No |
| File share → SharePoint | Yes - streamed from the share through the engine process to SharePoint (memory only) | No |
| SharePoint → Azure Blob | Yes - each file is downloaded, hashed, and uploaded | **Transiently**: one file at a time under `%TEMP%\spmigrator-tmp`, deleted after its transfer; stale leftovers from a killed process are swept at the start of every blob run (`engine/lib/BlobTarget.psm1`) |
| SharePoint or file share → a user's OneDrive (optional feature) | Yes for a SharePoint source (downloaded then uploaded via Microsoft Graph); a file-share source uploads directly from the share, nothing staged | **Transiently** for a SharePoint source only, same `%TEMP%\spmigrator-tmp` staging/sweep as the blob path (`engine/lib/OneDriveTarget.psm1`); nothing at rest for a file-share source |

All Microsoft 365 / Azure traffic is HTTPS. Nothing is sent to any third
party besides Microsoft (Graph/SharePoint Online) and, for blob archiving,
the operator's own Azure Storage account.

## 3. Data at rest on the operator's server

- `data/migration.db` (SQLite): jobs, per-file audit rows (paths/sizes/
  outcomes), user identities, tenant registry, encrypted credentials.
  The audit trail is **append-only by design** - deleting a job hides it from
  the queue but never removes its history (a compliance feature; it also
  means retention is indefinite until the operator defines and applies a
  retention procedure - see §8).
- `data/tree-cache/*.json`: source file listings for resumable jobs; deleted
  on job completion, otherwise expire after 6 hours.
- `%TEMP%\spmigrator-tmp`: transient blob-transfer staging (see §2).
- `.env` and `setup/certs/` (front-door app secret, shared certificate PFX +
  password): filesystem-protected only - restrict the server/VM to
  operations staff and enable full-disk encryption (BitLocker).

**Recommendation:** treat the whole VM as in-scope for customer data
handling: disk encryption on, access limited, backups of `data/` treated at
the same classification as the customer metadata inside it.

## 4. Credentials

- Per-tenant engine app certificates, blob connection strings, and
  file-share passwords are encrypted at rest with **AES-256-GCM**
  (`server/util/secretCrypto.js`), keyed by `CREDENTIAL_ENCRYPTION_KEY`
  in `.env`.
- Secrets are **never placed on process command lines** (argv is readable by
  any local process on Windows) - the engine receives them through its child
  environment. They are never written to logs and never returned to the
  browser (the UI sees only "a credential is stored").
- SharePoint access is certificate-based app-only auth under Microsoft's
  `Sites.Selected` model: each tenant's dedicated app can only touch sites
  explicitly granted to it, with grants visible in that tenant's own
  Entra ID / SharePoint admin surface. No client secrets (SharePoint rejects
  them), no tenant-wide standing content permission - **except** when the
  optional OneDrive target is enabled (`ENGINE_ONEDRIVE_TARGET_ENABLED`,
  SETUP.md): that feature requires Microsoft Graph's `Files.ReadWrite.All`,
  a **tenant-wide standing read/write grant to every OneDrive and SharePoint
  site's file content**, because `Sites.Selected` does not reliably extend to
  personal OneDrive site collections. This is a deliberate, opt-in exception
  to the per-site model above - review whether it's acceptable for a given
  engagement before turning it on, and note it in that engagement's own
  security documentation.

## 5. Access control

- Every data route requires a signed-in Microsoft (Azure AD) session; all
  queries are scoped to the session's tenant, so one tenant's users can
  never read another tenant's mappings/jobs/logs (UUID guessing returns 404).
  Socket.IO live events enforce the same session + tenant rooms.
- The project list requires authentication (project names are client names).
- File-share sources are allowlist-bound at three points (browse, mapping
  creation, engine spawn). Set **`FS_SOURCE_ALLOWED_PARENTS`** in `.env` to
  bound what any project's allowlist may contain - without it, any signed-in
  project user can point the service account at any path it can read.
  Allowlist changes are logged to the server console with the actor.
- Sign-in itself can be restricted to the operator's own staff domains
  (`ALLOWED_LOGIN_DOMAINS`, B2B-guest aware). A client tenant's GA may still
  complete a project-scoped sign-in, but only for an existing project bound
  to (or being bound to) their own tenant - never the generic sign-in, a
  foreign project, or a guessed project id.
- **Role model within a team:** every mapping/job records its owning user
  (Azure AD oid). `member` users see and act on only their own rows (plus
  rows predating ownership); `admin` users (`ADMIN_UPNS`, or grandfathered
  pre-existing users) see everything in the tenant. Enforced on every REST
  read/list/action (foreign UUIDs return 404), on Socket.IO event routing,
  and on KPI/export aggregates. Gated source-deletion actions follow the
  same ownership rule. Compensating controls still apply: keep the tool on
  an internal network.
- A bare identity sign-in is consented only for `User.Read`; the delegated
  working scopes (`Sites.Read.All`, `Files.Read.All`, `Sites.FullControl.All`)
  are requested only on project-scoped sign-ins, where they are used.

## 6. Integrity

- Migration is **copy-only**: the engine never deletes or modifies source
  content. Source cleanup is a separate, explicit action (SharePoint sources
  only) that re-verifies every file at deletion time and only ever recycles.
- Every completed job is verified per file - existence, size, and content
  hash (QuickXorHash via Graph; computed locally for file-share sources;
  Content-MD5 for blob targets) - with automatic re-copy of failures and
  re-verification. Verification results are stored and exportable.

## 7. Logging & audit

- Every file operation and every lifecycle action (create/approve/run/
  pause/cancel/verify/cleanup/delete) is an append-only `job_log` row with
  actor identity and timestamp, exportable as CSV/JSON (`/api/export`), and
  a per-job PDF report exists for handover packs.
- The server console additionally logs sign-ins, provisioning, engine
  activity, and security-relevant configuration changes. When running as a
  service, keep stdout/stderr redirected to files (SETUP.md Part 4 does).

## 8. Operator responsibilities (not enforced by code)

1. **HTTPS**: the app serves HTTP; on anything beyond a trusted internal
   segment, put a TLS reverse proxy in front and update the redirect URIs.
2. **Retention**: define how long `data/migration.db` (customer file paths +
   user identities) is kept per engagement and delete/archive accordingly -
   the tool never deletes it.
3. **`FS_SOURCE_ALLOWED_PARENTS`**: set it on any server using file-share
   sources (§5).
4. **VM hardening**: disk encryption, restricted logins, OS patching -
   the tool inherits the security of the host.
5. **Dependency currency**: `npm audit` on update. Known accepted findings
   at the time of writing: two *moderate* advisories against a transitive
   `uuid` inside Microsoft's `@azure/msal-node` (insecure-randomness class;
   not used for security tokens here; awaiting upstream). The previously
   flagged `xlsx` advisories are resolved by pinning SheetJS 0.20.3 from the
   vendor's official distribution.

## 9. Residency summary

Customer file content stays within Microsoft 365 / the operator's Azure
tenancy end-to-end, except the transient blob-staging file in §2 and the
in-memory streaming of file-share uploads. Customer file *metadata* and the
audit trail reside in SQLite on the operator's server for as long as the
operator retains them. The optional OneDrive target does not change this
residency picture - it only changes the *permission scope* used to reach it
(§4).
