# Setup guide

This covers everything needed to get the tool running: the one-time setup (done once,
ever, by whoever operates the tool), onboarding each new client tenant (repeatable,
takes a couple of minutes), and troubleshooting for the exact errors people hit while
setting this up.

If you just want the architecture overview, see [README.md](README.md). This document
is the operational "how do I actually get this working" guide.

## The identity model in one minute (read this first)

The tool uses two kinds of Azure AD apps, and mixing them up is the #1 setup mistake:

- **One front-door app, in YOUR OWN company tenant.** Created once by the setup script
  below. It only handles web sign-in, site browsing (as the signed-in person), and the
  one-time bootstrap of each tenant. It never copies files. Your company tenant is its
  home purely because a multi-tenant Azure AD app has to be registered somewhere.
- **One engine app PER TENANT - yours included - created automatically.** The first
  time a tenant's Global Admin signs in, the tool creates a dedicated app registration
  *inside that tenant* (certificate auth, `Sites.Selected`, per-site grants). This is
  what actually reads and writes SharePoint. No script, no Portal visit, nothing to
  install per tenant - ever. (Installs from before July 2026 may have a home-tenant
  project still on the setup script's shared certificate - it keeps working via a
  fallback and upgrades itself to a dedicated app on its next admin sign-in.)

The rule that follows: **the setup script is run once, signed into your own company
tenant - never a client's.** Tenants are onboarded just by signing in (Part 2).
Running the setup script signed into a client's tenant no longer breaks anything
operationally, but it registers the tool's front-door app (and `.env`) against the
wrong tenant and leaves a stray app registration in the client's Entra ID - see
Troubleshooting: "I ran the setup script signed into the wrong tenant".

---

## Part 1: One-time setup (do this once, ever)

You need: Node.js 20+, PowerShell 7 (`pwsh`), and an account with rights to create app
registrations in **your own company's** tenant - Application Administrator, Cloud
Application Administrator, or Global Administrator all work. Not a client account: see
"The identity model in one minute" above for why this matters.

### 1. Install dependencies

```
npm install
```
Installs both the `server` and `web` npm workspaces.

### 2. Create the app registration

```
pwsh -File setup/New-AppRegistration.ps1
```
(or `npm run setup:app-registration`)

This prompts an interactive Microsoft Graph login (`Connect-MgGraph`) - **sign in with
your own company tenant's admin account, never a client's** (the tenant you sign into
here becomes the tool's home tenant - see the identity model section at the top).
It's idempotent (safe to re-run) - it:
- Creates (or finds and updates) an Azure AD app registration named "SharePoint
  Migration Tool", configured as **multi-tenant** (`SignInAudience: AzureADMultipleOrgs`)
  so any client tenant can use it once their admin consents.
- Generates a self-signed certificate for the tool's own delegated login flow's
  confidential-client setup, stored under `setup/certs/`.
- Requests the delegated Graph permissions the web UI needs (`Sites.Read.All`,
  `Files.Read.All`, `Sites.FullControl.All`, plus `Application.ReadWrite.All` and
  `AppRoleAssignment.ReadWrite.All` - see step 3 below for why those last two exist)
  and one application permission (`Sites.Selected`).
- Writes `.env` with `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `ENGINE_CERT_THUMBPRINT`,
  and the rest of the standard config.

**Run this again** (same command) any time you need to re-sync the app's declared
permissions after a code update - it's always safe, it never creates a second app or
rotates an existing valid certificate/secret unnecessarily.

### 3. Admin consent - automatic, no Portal visit

Nothing to do here anymore. The setup script grants admin consent for every declared
permission itself - both the application permissions (Microsoft Graph `Sites.Selected`
**and** SharePoint Online's own `Sites.Selected` - two separate permissions; the
engine's SharePoint REST/CSOM calls are authorized by the SharePoint one, and an app
holding only Graph's gets 401 Unauthorized from the engine even with a valid site
grant) and the tenant-wide delegated consent for the web sign-in scopes.

It can do this because *the script itself* runs interactively as you, the admin, via
Microsoft Graph PowerShell with `AppRoleAssignment.ReadWrite.All` and
`DelegatedPermissionGrant.ReadWrite.All` - the running web app could never self-grant
permissions (Azure AD forbids an app granting itself anything), but an admin running a
script can grant them *to* it. Re-running the script re-syncs consent after any
permission-list change - if jobs ever start failing with "Unauthorized" right after a
code update mentions new permissions, re-run step 2 and you're done.

### 4. Verify the app is actually multi-tenant

```powershell
Get-MgApplication -Filter "appId eq '<CLIENT_ID from .env>'" | Select-Object DisplayName, SignInAudience
```
Expected output: `SignInAudience` = `AzureADMultipleOrgs`. If it still says
`AzureADMyOrg`, re-run step 2's script - the update didn't take, or you ran an older
version of the script before this was added.

### 5. Credential encryption key - automatic

`CREDENTIAL_ENCRYPTION_KEY` is generated by the setup script on first run and
**preserved verbatim on every re-run** (as is `SESSION_SECRET` and any custom lines
you add to `.env`). It encrypts each client project's own engine credential at rest
in the database (see Part 2). Never change it manually - changing it makes every
already-stored secret undecryptable. If that ever happens anyway, nothing is
permanently broken: sign out and back into each affected project (its engine app
re-provisions automatically) and re-save the blob connection string in Settings.

### 6. Start the app

Dev mode (two processes, hot reload):
```
npm run dev
```
Open `http://localhost:5173`.

Production (single process, serves the built SPA):
```
npm run build && npm run start:server-only
```
Open `http://localhost:<PORT>` (default 3000).

---

## Part 2: Onboarding a tenant (repeatable - takes one sign-in)

This is the part that's genuinely just clicking through the browser - no scripts, no
Azure Portal, nothing outside the app.

1. Open the tool and click **Sign in with Microsoft**, using the tenant's **Global
   Admin account** (for a client migration, that means the client's GA - not your own
   tenant's account). That's it: the tool finds that tenant's project or creates one
   automatically (named after the sign-in domain), and switching between tenants later
   is the **Projects** page in the nav bar - every project has its own "Sign in" link.
2. Prefer a friendlier project name than the domain? Create it first: **Projects →
   + New project**, type the name (e.g. "Contoso Ltd"), then sign in with the tenant's
   GA when redirected - the project binds to whatever tenant signs into it first.
3. On a tenant's first sign-in, Azure AD asks the GA to consent to a few permissions.
   Most Global Admins see this as a single "Accept" click (their tenant's own sign-in
   auto-offers "consent on behalf of your organization" for admin-restricted scopes).
   If their tenant's policy blocks that, you'll instead land on a page saying "your
   organization hasn't approved this tool yet" with a link - click it, consent once,
   then sign in normally.
4. Behind the scenes, the tool automatically creates a **brand-new, dedicated Azure AD
   app registration inside that tenant** (visible afterward in *their* Entra ID →
   Enterprise Applications, named "Content Migration Tool - Contoso Ltd" or similar)
   with its own certificate, generated on the fly and consented using that GA's own
   rights. It's a certificate, not a client secret, because SharePoint Online's
   app-only authentication rejects client secrets outright regardless of permissions.
   This app belongs entirely to that tenant - the tool's shared front-door app is
   never used for SharePoint content access.
5. You're signed in, the project is active.

### Granting access to specific sites

Before a mapping/job can read or write a site, that site needs to explicitly grant the
engine access (this is Microsoft's `Sites.Selected` model - broad tenant-wide access is
deliberately not requested). In the SharePoint site picker, click **"Grant migration
engine access to this site"** for each source and target site you'll use. This grants
*that project's own* dedicated app (from step 5 above) `fullcontrol` on the site - not
your shared app.

---

## Part 3: Optional features (per project, all from the Settings page)

### Azure Blob archiving (SharePoint → Blob container)

Adds "Azure Blob container (archive)" as a target choice on the Mappings page. On
**Settings**, paste the storage account's connection string (Azure Portal → Storage
account → **Access keys**; prefer the access-keys form over a SAS — the engine then
mints its own 48h tokens and a long job can never outlive one). The string is analyzed
live (form, account, SAS expiry) before you save, encrypted at rest, and never shown
again. Leave it unset and the blob target option simply doesn't appear.

### File share (DFS) sources (file share → SharePoint)

Adds "File share (DFS)" as a source choice on the Mappings page, for migrating content
off DFS namespaces, file servers, or local disks. On **Settings**, add the UNC paths of
the shares this project may migrate from (e.g. `\\corp\dfs\Departments`). Saving
live-tests each root and shows a ✓ readable / ✗ unreadable chip per share.

Two things to know:

- **By default it's the server's account doing the reading**, not the signed-in user.
  Either give the account running the Node server read access to the roots, or give a
  root its own **username + password** when adding it — the tool then connects to that
  share's server over SMB as that user (standard `net use` semantics), so the migration
  server only needs network reachability to the file server, nothing more. The password
  is encrypted at rest with `CREDENTIAL_ENCRYPTION_KEY`, tested live on save, handed to
  the engine via its process environment (never a command line), and re-saving the list
  never requires retyping it. Credentials apply to UNC roots only — a local drive path
  is always read as the server's own account.
- **The roots are an allowlist with teeth**: the picker, mapping creation, and every
  engine start re-validate against the current list, and everyone signed into the
  project can browse everything under the roots — so list the folders actually being
  migrated, not a whole drive.

One Windows quirk worth knowing: SMB allows only one set of credentials per file server
per logon session. If the save check fails with **error 1219**, the server's session
already holds a connection to that file server under a different user — run
`net use \\server\share /delete` on the machine running the tool (as the account the
tool runs under), or use the same user for every root on that server.

### OneDrive target (SharePoint or file share → a specific user's OneDrive)

Adds "A user's OneDrive" as a target choice on the Mappings page — the source can be
either a SharePoint site/library or a file share (DFS/UNC/local disk).

**The tradeoff, up front:** every other target in this tool uses Microsoft's
`Sites.Selected` model — the engine can only touch sites explicitly granted to it,
one at a time. `Sites.Selected` does not reliably extend to personal OneDrive site
collections, so this target instead uses Microsoft Graph's **`Files.ReadWrite.All`**
application permission — **tenant-wide standing read/write access to every OneDrive
and SharePoint site's file content**, not just the ones this tool has been granted.
This is a materially bigger blast radius than everything else in this tool. Read
COMPLIANCE.md's note on this before enabling it in production, and enable it only if
the OneDrive-migration use case is one you actually need.

To enable it:

1. Re-run the app registration script with the extra switch:
   ```
   pwsh -File setup/New-AppRegistration.ps1 -EnableOneDriveTarget
   ```
   This grants `Files.ReadWrite.All` (with automatic admin consent, same as every
   other permission this script manages) and writes `ENGINE_ONEDRIVE_TARGET_ENABLED=true`
   to `.env`. Restart the server afterward.
2. Each project's own auto-provisioned engine app (created the first time someone signs
   into that project) picks up the same permission automatically on its **next sign-in**
   after the server restart — if a project was provisioned before this was enabled, have
   someone from that project sign out and back in once.
3. The "A user's OneDrive" target option now appears on the Mappings page. Search for the
   destination person by name or email, optionally set a subfolder, and save the mapping
   — the tool checks up front that the user actually has a provisioned OneDrive.

**Troubleshooting:** a file-share-source job migrating into OneDrive needs the engine to
open one connection purely to obtain a Microsoft Graph token (there's no SharePoint site
of its own in that job otherwise) — it uses the target OneDrive's own site collection for
this. If such a job fails at startup with an access-denied error establishing that
connection, granting the engine's app `Sites.Selected` access to that specific personal
site (the same "grant migration engine access" mechanism used for regular sites) is the
fix; a SharePoint-source job never hits this since it reuses its own source connection.

To disable it again: re-run the script **without** `-EnableOneDriveTarget` (this removes
the permission grant from the app's declared scopes on the next Portal sync) and set
`ENGINE_ONEDRIVE_TARGET_ENABLED=false` in `.env`, then restart the server.

File-share jobs upload with live per-file progress bars, sanitize names SharePoint
would reject (reported per file, deterministic so resume still works), skip
`Thumbs.db`/`desktop.ini`/Office `~$` lock temps, and are verified with the same
content-hash rigor as SharePoint-to-SharePoint jobs (the engine computes QuickXorHash
locally over each source file and compares it against SharePoint's server-side hash of
the uploaded copy). They are strictly copy-only — the tool never deletes from a file
share; retire the share manually once you're satisfied.

There is also an optional server-wide `FS_SOURCE_ROOTS` variable in `.env` that adds
roots visible to every project — the Settings page is the normal way; use the env
variable only if you deliberately want instance-wide roots.

---

## Part 4: Hosting it on a VM for the whole team

A **Windows Server VM** is the recommended host - the file-share (DFS) source works
natively there (UNC paths, per-share `net use` credentials), which a Linux container
can't do without mount gymnastics. One VM, one service, everyone uses the browser.

1. **Install prerequisites** on the VM: [Node.js LTS](https://nodejs.org),
   [PowerShell 7](https://aka.ms/powershell) (`winget install Microsoft.PowerShell`),
   git, and the PnP module:
   ```powershell
   pwsh -Command "Install-Module PnP.PowerShell -Scope AllUsers -Force"
   ```
2. **Clone and build:**
   ```powershell
   git clone <your repo url> C:\migrator ; cd C:\migrator
   npm install
   npm run build
   ```
3. **Configuration:** either run Part 1's setup script here (signed into your own
   tenant), or copy `.env` *and* `setup\certs\` from the machine where it was run.
   Then point the sign-in redirect at the VM instead of localhost - re-run the setup
   script with the URL your team will use:
   ```powershell
   pwsh -File setup/New-AppRegistration.ps1 -RedirectUri "http://YOUR-VM-NAME:3000/auth/redirect" -PostLogoutRedirectUri "http://YOUR-VM-NAME:3000"
   ```
   (it updates both the app registration's reply URLs and `.env`).
4. **Open the firewall:**
   ```powershell
   New-NetFirewallRule -DisplayName "SharePoint Migration Tool" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
   ```
5. **Run it as a service** so it survives reboots and sign-outs. Simplest is
   [NSSM](https://nssm.cc):
   ```powershell
   nssm install SPMigrator "C:\Program Files\nodejs\node.exe" "C:\migrator\server\index.js"
   nssm set SPMigrator AppDirectory C:\migrator
   nssm set SPMigrator AppStdout C:\migrator\logs\service.log
   nssm set SPMigrator AppStderr C:\migrator\logs\service-err.log
   nssm start SPMigrator
   ```
   (A Task Scheduler "At startup" task running `node server\index.js` in `C:\migrator`
   works too.) Team members browse to `http://YOUR-VM-NAME:3000` and sign in.

Two service-account notes:
- File-share sources are read by the account the service runs under - either give
  that account read access to the shares, or (usually easier) use the per-share
  username/password fields in Settings and it won't matter.
- The tool is plain HTTP out of the box, fine for an internal LAN. If you ever expose
  it further, put an HTTPS reverse proxy (IIS ARR/Caddy/nginx) in front and update
  the redirect URIs to the https address.

To update the tool later: `git pull ; npm install ; npm run build ; nssm restart SPMigrator`.

---

## Troubleshooting

**`npm install` fails building `better-sqlite3` (node-gyp, "find Python", "No prebuilt binaries found")**
The one native module in the stack found no prebuilt binary for your Node version and
fell back to compiling from source, which needs Python + Visual Studio Build Tools.
You should never need those: `git pull` (the repo pins a better-sqlite3 with prebuilt
binaries for current Node LTS and newer), delete `node_modules`, and run `npm install`
again. If it still tries to compile, your Node version is probably brand-new or EOL -
install the current LTS from nodejs.org and retry.

**I ran the setup script signed into the wrong (a client's) tenant**
Since every tenant now provisions its own engine app at sign-in, this no longer
breaks migrations - but the tool's front-door app registration (and `.env`) is living
in the client's tenant instead of yours, and their Entra ID has a stray app it
shouldn't. Fix: re-run `pwsh -File setup/New-AppRegistration.ps1` on the server
machine signed in with your own company tenant's admin account (it rewrites
`TENANT_ID` in `.env` to the tenant you signed into), restart the server. Optionally,
the client's admin deletes the stray "Content Migration Tool"/"SharePoint Migration
Tool" app registration from their Entra ID afterwards.

**A job fails immediately with "Cannot find certificate with this thumbprint in the certificate store"**
Only the project bound to the operator's own tenant (`TENANT_ID` in `.env`) uses the
shared engine certificate - and this error means that certificate isn't available on
the machine running the server. Since the fix in July 2026 the server prefers the
exported certificate FILE (`setup/certs/migration-engine.pfx` + `pfx-password.txt`),
which needs no import step: either re-run `pwsh -File setup/New-AppRegistration.ps1`
on this machine (it recreates the certificate and registers it on the app), or copy
the whole `setup/certs/` folder from the machine where the script originally ran
(transfer it securely - it contains a private key; it is deliberately never in git).
Client-tenant projects are unaffected - their engine apps are auto-provisioned at
sign-in and live in the database, not the certificate store.

**`AADSTS700016: Application ... was not found in the directory '<tenant>'`**
The app registration isn't multi-tenant yet (still `AzureADMyOrg`), or Azure AD's
directory change hasn't finished propagating. Run Part 1, step 4's verification
command. If it still shows `AzureADMyOrg`, re-run `setup/New-AppRegistration.ps1`. If
it already shows `AzureADMultipleOrgs`, wait a few minutes and retry - global
propagation of Entra ID changes isn't always instant.

**Redirected to "your organization hasn't approved this tool yet"**
Expected the first time a client tenant whose policy requires it signs in. Click the
`/auth/admin-consent` link on that page, approve, then sign in normally - one-time per
tenant.

**"That project is connected to a different Microsoft 365 tenant"**
You clicked "Sign in" on a project that's already bound to Tenant A, but authenticated
with an account from Tenant B. Use the correct client's GA account for that project, or
create a new project for Tenant B instead.

**"This project's engine app couldn't be provisioned yet. Sign out and back in to
retry."** (shown when trying to run a job)
The automatic per-project app creation (Part 2, step 5) failed silently at sign-in time
- usually `CREDENTIAL_ENCRYPTION_KEY` isn't set (check `.env`, restart the server), or a
transient Graph API error. Sign out and sign back into that project to retry - it's
safe to retry as many times as needed.

**`ErrorCode: ProhibitedWordInDisplayName` when creating the app registration**
Some tenants have an Entra ID admin-configured policy blocking product-name words
(SharePoint, Microsoft, Office, Azure, ...) in app registration display names - this is
a restriction on the Azure AD *Application object's* name specifically, unrelated to
this tool's own UI/documentation naming. The script defaults to "Content Migration
Tool" to avoid this; if you still hit it, re-run with a different
`-AppDisplayName "..."` of your choosing.

**A job fails trying to read/write a SharePoint site**
That site hasn't been granted access yet - see "Granting access to specific sites"
above. Existing sites with broken/unique permissions on some subfolders specifically
need the `fullcontrol` role (which the grant button already uses), not just `write`.
