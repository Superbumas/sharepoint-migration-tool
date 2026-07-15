#Requires -Version 7.0
<#
.SYNOPSIS
  One-time bootstrap - runs ONCE EVER, by the tool's operator, never again
  per client tenant: creates (or repairs) the single, multi-tenant Azure AD
  app registration used by the SharePoint Migration Tool, both for the
  delegated web-login flow (Node/MSAL) and the certificate-based app-only
  flow (PowerShell engine).

.DESCRIPTION
  The app registration is multi-tenant (SignInAudience: AzureADMultipleOrgs)
  - a new client tenant's own Global Admin just signs in (their ordinary
  sign-in usually auto-offers "consent on behalf of your organization" for
  the admin-restricted scopes below; /auth/admin-consent in the app is a
  one-time fallback if their tenant's policy blocks that). No per-tenant
  app/certificate, and no re-run of this script, is needed to onboard a
  new client.

  Idempotent - safe to re-run. Each step checks for the resource it would
  create (by display name / appId / thumbprint) before creating a new one, so
  a partial failure (e.g. network blip after creating the app but before the
  certificate step) can be fixed by simply running the script again.

  This script does NOT grant per-site Sites.Selected access - that's a
  per-client-tenant, per-site action, done via the in-app "grant migration
  engine access to this site" button (or Grant-PnPAzureADAppSitePermission
  by hand) once you know which source/target sites are in scope for that
  client.

.PARAMETER SiteUrls
  Optional. If you already know the source/target site URLs, pass them here
  and the exact grant command for each is printed (this script does not run
  them for you - granting site access is a deliberate, separate action).

.PARAMETER UseTenantWideFallback
  Adds the Sites.ReadWrite.All application permission instead of (in addition
  to) Sites.Selected. Only use this if Sites.Selected proves too restrictive
  for some source sites - it trades least-privilege for simplicity and
  requires tenant-wide admin consent.

.PARAMETER EnableOneDriveTarget
  Adds Microsoft Graph's Files.ReadWrite.All application permission, needed
  for the "migrate into a specific user's OneDrive" target. This is a
  TENANT-WIDE standing grant to every OneDrive and SharePoint site's file
  content, a materially bigger blast radius than the per-site Sites.Selected
  model everything else here uses - Sites.Selected does not reliably extend
  to personal OneDrive site collections, which is why this exists as a
  separate, deliberately opt-in switch rather than being requested by
  default. See COMPLIANCE.md before enabling this in production. Also set
  ENGINE_ONEDRIVE_TARGET_ENABLED=true in .env (this script does that for you)
  and toggle it on the Settings page.

.EXAMPLE
  ./New-AppRegistration.ps1 -SiteUrls "https://yourtenant.sharepoint.com/sites/HRLegacy","https://yourtenant.sharepoint.com/sites/Hub"
#>
param(
    # Avoid product-name words (SharePoint, Microsoft, Office, Azure, ...) -
    # some tenants' Entra ID admin-configured "prohibited words" policy
    # rejects app registration display names containing them
    # (ErrorCode: ProhibitedWordInDisplayName) even though the same words
    # are fine in this tool's own UI/documentation, which isn't subject to
    # that restriction at all.
    [string]$AppDisplayName = 'Content Migration Tool',
    [string]$RedirectUri = 'http://localhost:3000/auth/redirect',
    [string]$PostLogoutRedirectUri = 'http://localhost:3000',
    [string[]]$SiteUrls = @(),
    [string]$CertOutputDir = "$PSScriptRoot/certs",
    [int]$CertValidityYears = 2,
    [int]$SecretValidityMonths = 12,
    [string]$EnvFilePath = "$PSScriptRoot/../.env",
    [switch]$UseTenantWideFallback,
    [switch]$EnableOneDriveTarget,
    [switch]$ForceNewSecret
)

$ErrorActionPreference = 'Stop'
$GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000'   # Microsoft Graph - well-known across all tenants

function Write-Section($title) {
    Write-Host ''
    Write-Host "=== $title ===" -ForegroundColor Cyan
}

# System.Web.Security.Membership isn't available under PowerShell 7 (.NET, not
# .NET Framework), so random secrets are generated from a crypto RNG instead.
function New-RandomPassword {
    param([int]$Length = 32)
    $bytes = [byte[]]::new($Length)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B').Substring(0, $Length)
}

# ---------------------------------------------------------------------------
# 0. Prerequisites
# ---------------------------------------------------------------------------
Write-Section 'Checking prerequisite modules'
foreach ($mod in @('Microsoft.Graph.Applications', 'Microsoft.Graph.Identity.SignIns', 'Microsoft.Graph.Authentication')) {
    if (-not (Get-Module -ListAvailable -Name $mod)) {
        Write-Host "Installing $mod ..."
        Install-Module $mod -Scope CurrentUser -Force -AllowClobber
    }
    Import-Module $mod -ErrorAction Stop
}

Write-Section 'Connecting to Microsoft Graph'
Connect-MgGraph -Scopes 'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -NoWelcome
$tenantId = (Get-MgContext).TenantId
Write-Host "Connected. Tenant: $tenantId"

# ---------------------------------------------------------------------------
# 1. Resolve Microsoft Graph's own service principal so we can look up the
#    exact permission GUIDs by name instead of hardcoding IDs that can vary.
# ---------------------------------------------------------------------------
$graphSp = Get-MgServicePrincipal -Filter "appId eq '$GRAPH_APP_ID'"

function Get-GraphPermissionId {
    param([Parameter(Mandatory)][ValidateSet('Scope', 'Role')]$Kind, [Parameter(Mandatory)][string]$Value)
    if ($Kind -eq 'Scope') {
        $match = $graphSp.Oauth2PermissionScopes | Where-Object { $_.Value -eq $Value }
    } else {
        $match = $graphSp.AppRoles | Where-Object { $_.Value -eq $Value }
    }
    if (-not $match) { throw "Could not resolve Graph permission '$Value' ($Kind) - check the name is correct for this tenant's Graph service principal." }
    return $match.Id
}

# Sites.FullControl.All is not needed for browsing (that only needs
# Sites.Read.All/Files.Read.All) - it's what lets a signed-in admin use the
# in-app "grant migration engine access to this site" button, which calls
# Graph's POST /sites/{id}/permissions on their behalf instead of requiring
# them to run Grant-PnPAzureADAppSitePermission by hand in PowerShell.
#
# Application.ReadWrite.All and AppRoleAssignment.ReadWrite.All are declared
# here so Azure AD will issue tokens for them, but neither is part of the
# baseline scopes an ordinary sign-in requests - server/auth/routes.js only
# asks for them on the specific login that provisions a new Project's own
# dedicated, tenant-local app registration (server/graph/provisionTenantApp.js).
$delegatedScopeNames = @(
    'openid', 'profile', 'email', 'offline_access', 'User.Read',
    'Sites.Read.All', 'Files.Read.All', 'Sites.FullControl.All',
    'Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All'
)
$appRoleNames = @('Sites.Selected')
if ($UseTenantWideFallback) {
    Write-Host 'UseTenantWideFallback set - adding Sites.ReadWrite.All application permission alongside Sites.Selected.' -ForegroundColor Yellow
    $appRoleNames += 'Sites.ReadWrite.All'
}
if ($EnableOneDriveTarget) {
    Write-Host 'EnableOneDriveTarget set - adding Microsoft Graph Files.ReadWrite.All (tenant-wide file access; see the parameter help before using this in production).' -ForegroundColor Yellow
    # App-only: what the ENGINE uses to write into a user's OneDrive.
    $appRoleNames += 'Files.ReadWrite.All'
    # Delegated: what the signed-in admin's BROWSER uses to FIND the target
    # user in the OneDrive target picker (GET /users?$search=). Without this
    # the picker's search box 403s even though the engine could write fine -
    # the two are separate permissions on separate token audiences.
    $delegatedScopeNames += 'User.Read.All'
}

$resourceAccess = @()
foreach ($name in $delegatedScopeNames) {
    $resourceAccess += @{ Id = (Get-GraphPermissionId -Kind Scope -Value $name); Type = 'Scope' }
}
foreach ($name in $appRoleNames) {
    $resourceAccess += @{ Id = (Get-GraphPermissionId -Kind Role -Value $name); Type = 'Role' }
}

# Sites.Selected exists on BOTH Microsoft Graph and SharePoint Online, and
# they are separate permissions: Graph's covers Graph API calls only, while
# SharePoint REST/CSOM (everything the PnP.PowerShell engine does) checks
# SharePoint Online's own Sites.Selected. An app holding only Graph's gets
# 401 Unauthorized from the engine even with a valid cert and a fullcontrol
# site grant. Both are needed.
$SPO_APP_ID = '00000003-0000-0ff1-ce00-000000000000'  # Office 365 SharePoint Online
$spoSp = Get-MgServicePrincipal -Filter "appId eq '$SPO_APP_ID'"
$spoSitesSelected = $spoSp.AppRoles | Where-Object { $_.Value -eq 'Sites.Selected' }
if (-not $spoSitesSelected) { throw "Could not resolve the 'Sites.Selected' application permission on the Office 365 SharePoint Online service principal." }
$spoResourceAccess = @(@{ Id = $spoSitesSelected.Id; Type = 'Role' })
if ($UseTenantWideFallback) {
    $spoReadWrite = $spoSp.AppRoles | Where-Object { $_.Value -eq 'Sites.ReadWrite.All' }
    if ($spoReadWrite) { $spoResourceAccess += @{ Id = $spoReadWrite.Id; Type = 'Role' } }
}

$requiredResourceAccess = @(
    @{ ResourceAppId = $GRAPH_APP_ID; ResourceAccess = $resourceAccess },
    @{ ResourceAppId = $SPO_APP_ID; ResourceAccess = $spoResourceAccess }
)

# ---------------------------------------------------------------------------
# 2. App registration (idempotent: reuse by display name if it already exists)
# ---------------------------------------------------------------------------
Write-Section 'App registration'
$app = Get-MgApplication -Filter "displayName eq '$AppDisplayName'" | Select-Object -First 1
if ($app) {
    Write-Host "Found existing app registration '$AppDisplayName' ($($app.AppId)) - updating its configuration."
    # SignInAudience is included on the update path (not just at creation)
    # so re-running this script against an app that was originally created
    # single-tenant converts it to multi-tenant in place - no new app
    # object, service principal, or certificate needed.
    Update-MgApplication -ApplicationId $app.Id `
        -SignInAudience 'AzureADMultipleOrgs' `
        -Web @{ RedirectUris = @($RedirectUri); ImplicitGrantSettings = @{ EnableIdTokenIssuance = $true } } `
        -RequiredResourceAccess $requiredResourceAccess
    $app = Get-MgApplication -ApplicationId $app.Id
} else {
    Write-Host "Creating new app registration '$AppDisplayName' ..."
    # AzureADMultipleOrgs (not AzureADMyOrg): this app is meant to be used
    # across every client tenant the operator manages, each granting its own
    # admin consent - not just the tenant this script happens to run in.
    $app = New-MgApplication -DisplayName $AppDisplayName -SignInAudience 'AzureADMultipleOrgs' `
        -Web @{ RedirectUris = @($RedirectUri); ImplicitGrantSettings = @{ EnableIdTokenIssuance = $true } } `
        -RequiredResourceAccess $requiredResourceAccess
}
Write-Host "App: $($app.DisplayName)  AppId: $($app.AppId)  ObjectId: $($app.Id)"

# ---------------------------------------------------------------------------
# 3. Service principal (idempotent)
# ---------------------------------------------------------------------------
Write-Section 'Service principal'
$sp = Get-MgServicePrincipal -Filter "appId eq '$($app.AppId)'"
if (-not $sp) {
    Write-Host 'Creating service principal ...'
    $sp = New-MgServicePrincipal -AppId $app.AppId
} else {
    Write-Host "Service principal already exists ($($sp.Id))."
}

# ---------------------------------------------------------------------------
# 3b. Admin consent (automatic - no Azure Portal visit needed)
# ---------------------------------------------------------------------------
# Application permissions (app roles) can never be granted through a normal
# user sign-in - they need tenant admin consent. But this script already runs
# as the admin with AppRoleAssignment.ReadWrite.All (grants app roles) and
# DelegatedPermissionGrant.ReadWrite.All (grants delegated-scope consent), so
# it grants everything itself instead of sending anyone to the Portal's
# "Grant admin consent" button. Idempotent like the rest of the script.
Write-Section 'Admin consent (granted automatically by this script)'

# App roles (application permissions) - Graph's Sites.Selected (+ ReadWrite
# fallback if requested) and SharePoint Online's own Sites.Selected. The
# engine's CSOM/REST calls are authorized by the SPO one; Graph API calls by
# the Graph one - both are needed (see the requiredResourceAccess comment above).
$existingAssignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id -All
$roleGrants = @()
foreach ($name in $appRoleNames) {
    $roleGrants += @{ ResourceSp = $graphSp; RoleId = (Get-GraphPermissionId -Kind Role -Value $name); Label = "Microsoft Graph / $name" }
}
$roleGrants += @{ ResourceSp = $spoSp; RoleId = $spoSitesSelected.Id; Label = 'SharePoint Online / Sites.Selected' }
if ($UseTenantWideFallback -and $spoReadWrite) {
    $roleGrants += @{ ResourceSp = $spoSp; RoleId = $spoReadWrite.Id; Label = 'SharePoint Online / Sites.ReadWrite.All' }
}
foreach ($grant in $roleGrants) {
    $already = $existingAssignments | Where-Object { $_.AppRoleId -eq $grant.RoleId -and $_.ResourceId -eq $grant.ResourceSp.Id }
    if ($already) {
        Write-Host "Already consented: $($grant.Label)"
    } else {
        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $sp.Id `
            -PrincipalId $sp.Id -ResourceId $grant.ResourceSp.Id -AppRoleId $grant.RoleId | Out-Null
        Write-Host "Granted: $($grant.Label)" -ForegroundColor Green
    }
}

# Delegated scopes - one tenant-wide oauth2PermissionGrant (ConsentType
# AllPrincipals = the Portal's "Grant admin consent" for delegated
# permissions). Updated in place if it exists so re-runs converge on the
# current scope list.
$delegatedScopeString = $delegatedScopeNames -join ' '
$existingGrant = Get-MgOauth2PermissionGrant -Filter "clientId eq '$($sp.Id)' and resourceId eq '$($graphSp.Id)' and consentType eq 'AllPrincipals'" | Select-Object -First 1
if ($existingGrant) {
    if ($existingGrant.Scope -ne $delegatedScopeString) {
        Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existingGrant.Id -Scope $delegatedScopeString
        Write-Host 'Updated tenant-wide delegated consent to the current scope list.' -ForegroundColor Green
    } else {
        Write-Host 'Tenant-wide delegated consent already up to date.'
    }
} else {
    New-MgOauth2PermissionGrant -ClientId $sp.Id -ConsentType 'AllPrincipals' `
        -ResourceId $graphSp.Id -Scope $delegatedScopeString | Out-Null
    Write-Host 'Granted tenant-wide delegated consent for the web sign-in scopes.' -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 4. Certificate for the app-only (engine) auth path
# ---------------------------------------------------------------------------
Write-Section 'Certificate (app-only auth for the PowerShell engine)'
New-Item -ItemType Directory -Path $CertOutputDir -Force | Out-Null
$thumbprintMarkerPath = Join-Path $CertOutputDir 'thumbprint.txt'

$existingThumbprint = if (Test-Path $thumbprintMarkerPath) { (Get-Content $thumbprintMarkerPath -Raw).Trim() } else { $null }
$existingKeyStillOnApp = $false
if ($existingThumbprint) {
    $appWithKeys = Get-MgApplication -ApplicationId $app.Id -Property 'KeyCredentials'
    $existingKeyStillOnApp = [bool]($appWithKeys.KeyCredentials | Where-Object { $_.CustomKeyIdentifier -and ([System.BitConverter]::ToString($_.CustomKeyIdentifier) -replace '-', '') -eq $existingThumbprint })
}

if ($existingThumbprint -and $existingKeyStillOnApp -and (Test-Path "Cert:\CurrentUser\My\$existingThumbprint")) {
    Write-Host "Reusing existing certificate (thumbprint $existingThumbprint) - already installed and registered on the app."
    $thumbprint = $existingThumbprint
} else {
    Write-Host 'Generating a new self-signed certificate ...'
    $cert = New-SelfSignedCertificate -Subject "CN=$AppDisplayName Engine Cert" `
        -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -KeySpec Signature `
        -KeyLength 2048 -KeyAlgorithm RSA -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears($CertValidityYears)
    $thumbprint = $cert.Thumbprint

    $pfxPassword = New-RandomPassword -Length 24
    $securePfxPassword = ConvertTo-SecureString -String $pfxPassword -AsPlainText -Force
    $pfxPath = Join-Path $CertOutputDir 'migration-engine.pfx'
    $cerPath = Join-Path $CertOutputDir 'migration-engine.cer'
    Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePfxPassword | Out-Null
    Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
    Set-Content -Path (Join-Path $CertOutputDir 'pfx-password.txt') -Value $pfxPassword -NoNewline
    Set-Content -Path $thumbprintMarkerPath -Value $thumbprint -NoNewline

    Write-Host "Uploading public key to app registration ..."
    Update-MgApplication -ApplicationId $app.Id -KeyCredentials @(
        @{
            Type        = 'AsymmetricX509Cert'
            Usage       = 'Verify'
            Key         = $cert.RawData
            DisplayName = "$AppDisplayName engine cert ($((Get-Date).ToString('yyyy-MM-dd')))"
        }
    )

    Write-Host "Certificate ready. Thumbprint: $thumbprint" -ForegroundColor Green
    Write-Host "Private key exported to: $pfxPath (password in pfx-password.txt - NEVER commit either file)" -ForegroundColor Yellow
    Write-Host 'If the migration engine runs under a different account/machine than this script, import the .pfx there:'
    Write-Host "  Import-PfxCertificate -FilePath '$pfxPath' -CertStoreLocation Cert:\CurrentUser\My -Password (ConvertTo-SecureString -String (Get-Content '$CertOutputDir/pfx-password.txt' -Raw) -AsPlainText -Force)"
}

# ---------------------------------------------------------------------------
# 5. Client secret (for the Node MSAL confidential-client delegated flow only)
# ---------------------------------------------------------------------------
Write-Section 'Client secret (delegated web-login flow only - never used by the engine)'
$appWithPasswords = Get-MgApplication -ApplicationId $app.Id -Property 'PasswordCredentials'
$hasLiveSecret = [bool]($appWithPasswords.PasswordCredentials | Where-Object { $_.EndDateTime -gt (Get-Date) })
$existingEnv = @{}
if (Test-Path $EnvFilePath) {
    Get-Content $EnvFilePath | ForEach-Object {
        if ($_ -match '^([A-Za-z0-9_]+)=(.*)$') { $existingEnv[$Matches[1]] = $Matches[2] }
    }
}

$clientSecret = $null
if ($hasLiveSecret -and $existingEnv.ContainsKey('CLIENT_SECRET') -and $existingEnv['CLIENT_SECRET'] -and -not $ForceNewSecret) {
    Write-Host 'A live client secret already exists and is recorded in .env - reusing it (pass -ForceNewSecret to rotate).'
    $clientSecret = $existingEnv['CLIENT_SECRET']
} else {
    Write-Host 'Creating a new client secret ...'
    $secretResult = Add-MgApplicationPassword -ApplicationId $app.Id -PasswordCredential @{
        DisplayName = 'node-delegated-auth'
        EndDateTime = (Get-Date).AddMonths($SecretValidityMonths)
    }
    $clientSecret = $secretResult.SecretText
    Write-Host 'Secret created. This is the only time it can be read - it is being written to .env now.' -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 6. Write .env
# ---------------------------------------------------------------------------
Write-Section 'Writing .env'
# MERGE with the existing .env, never replace it. An earlier version of this
# script wrote a fixed list of lines over the whole file - silently destroying
# CREDENTIAL_ENCRYPTION_KEY (making every per-project secret encrypted at rest
# permanently undecryptable), rotating SESSION_SECRET (logging everyone out),
# and dropping any custom tuning. Values the operator may have customized or
# that must never change are preserved when present; script-owned values
# (app id, thumbprint, ...) are always refreshed.
$keep = { param($name, $default) if ($existingEnv.ContainsKey($name) -and $existingEnv[$name]) { $existingEnv[$name] } else { $default } }
$newEncryptionKey = {
    $bytes = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToBase64String($bytes)
}
# The signed-in tenant's real default domain - used as the display name of
# the default project a fresh database creates. A literal placeholder here
# used to leak all the way into the UI header ("yourtenant.sharepoint.com ·
# <real tenant>") on every fresh install.
$tenantDefaultDomain = ''
try {
    $org = (Invoke-MgGraphRequest -Method GET -Uri 'v1.0/organization?$select=verifiedDomains').value | Select-Object -First 1
    $tenantDefaultDomain = ($org.verifiedDomains | Where-Object { $_.isDefault } | Select-Object -First 1).name
} catch {}
$managed = [ordered]@{
    TENANT_ID                    = $tenantId
    TENANT_NAME                  = (& $keep 'TENANT_NAME' $tenantDefaultDomain)
    CLIENT_ID                    = $app.AppId
    CLIENT_SECRET                = $clientSecret
    REDIRECT_URI                 = $RedirectUri
    POST_LOGOUT_REDIRECT_URI     = $PostLogoutRedirectUri
    DELEGATED_SCOPES             = $(if ($EnableOneDriveTarget) { 'openid profile email offline_access User.Read User.Read.All Sites.Read.All Files.Read.All Sites.FullControl.All' } else { 'openid profile email offline_access User.Read Sites.Read.All Files.Read.All Sites.FullControl.All' })
    ENGINE_CERT_THUMBPRINT       = $thumbprint
    ENGINE_CERT_PATH             = './setup/certs/migration-engine.pfx'
    ENGINE_PERMISSION_MODE       = $(if ($UseTenantWideFallback) { 'Sites.ReadWrite.All' } else { 'Sites.Selected' })
    ENGINE_ONEDRIVE_TARGET_ENABLED = $(if ($EnableOneDriveTarget) { 'true' } else { 'false' })
    SESSION_SECRET               = (& $keep 'SESSION_SECRET' (New-RandomPassword -Length 32))
    # Generated here on first run so SETUP.md needs no separate openssl step;
    # NEVER regenerated on re-runs - changing it makes every already-stored
    # per-project secret undecryptable.
    CREDENTIAL_ENCRYPTION_KEY    = (& $keep 'CREDENTIAL_ENCRYPTION_KEY' (& $newEncryptionKey))
    PORT                         = (& $keep 'PORT' '3000')
    NODE_ENV                     = (& $keep 'NODE_ENV' 'development')
    SQLITE_DB_PATH               = (& $keep 'SQLITE_DB_PATH' './data/migration.db')
    DEFAULT_JOB_CONCURRENCY      = (& $keep 'DEFAULT_JOB_CONCURRENCY' '4')
    GLOBAL_MAX_CONCURRENCY       = (& $keep 'GLOBAL_MAX_CONCURRENCY' '12')
    RETRY_RATE_BACKOFF_THRESHOLD = (& $keep 'RETRY_RATE_BACKOFF_THRESHOLD' '0.20')
    SLOW_TRANSFER_THRESHOLD_MS   = (& $keep 'SLOW_TRANSFER_THRESHOLD_MS' '30000')
    PWSH_EXECUTABLE              = (& $keep 'PWSH_EXECUTABLE' 'pwsh')
    ENGINE_SCRIPT_PATH           = (& $keep 'ENGINE_SCRIPT_PATH' './engine/Invoke-MigrationJob.ps1')
}
$envLines = @()
foreach ($key in $managed.Keys) { $envLines += "$key=$($managed[$key])" }
# Anything else the operator added (AZURE_BLOB_CONNECTION_STRING, proxy
# settings, ...) survives verbatim at the end of the file.
foreach ($key in $existingEnv.Keys) {
    if (-not $managed.Contains($key)) { $envLines += "$key=$($existingEnv[$key])" }
}
Set-Content -Path $EnvFilePath -Value $envLines
Write-Host "Wrote $EnvFilePath (existing custom keys preserved)"

# ---------------------------------------------------------------------------
# 7. Summary / next steps
# ---------------------------------------------------------------------------
Write-Section 'Summary'
Write-Host "Tenant ID:        $tenantId"
Write-Host "Client ID:        $($app.AppId)"
Write-Host "Client Secret:    (written to .env - not re-printed here)"
Write-Host "Cert Thumbprint:  $thumbprint"
Write-Host ''
Write-Host 'NEXT STEPS - see SETUP.md for the full walkthrough. Short version:' -ForegroundColor Cyan

Write-Host ''
Write-Host '1) Nothing manual in the Azure Portal - this script just granted admin consent for every'
Write-Host '   declared permission itself (see the "Admin consent" section above). If you later change'
Write-Host '   the permission list, just re-run this script - consent is re-synced the same way.'

Write-Host ''
Write-Host '2) Every client tenant: just open the app and sign in - no PowerShell, no script.'
Write-Host '   Sites.Selected access is still per-site by Microsoft''s own design (admin consent alone'
Write-Host '   never grants access to any site) - grant each source/target site from inside the app:'
Write-Host '   the SharePoint site picker''s "Grant migration engine access to this site" button does'
Write-Host '   this with one click (calls Graph on the signed-in admin''s behalf) - no PowerShell needed.'
Write-Host ''
Write-Host '   If you specifically prefer doing it via PowerShell instead of that button, the equivalent is:'
if ($SiteUrls.Count -eq 0) {
    Write-Host "   Grant-PnPAzureADAppSitePermission -AppId <this project's own engine_client_id> -DisplayName '$AppDisplayName' -Site <site-url> -Permissions Write"
} else {
    foreach ($site in $SiteUrls) {
        Write-Host "   Grant-PnPAzureADAppSitePermission -AppId <this project's own engine_client_id> -DisplayName '$AppDisplayName' -Site $site -Permissions Write"
    }
}
Write-Host "   (find a project's own engine_client_id in its Enterprise Applications entry in that client's own tenant)"

Write-Host ''
Write-Host '3) Fallback (this shared app only - not the per-project apps step 2 creates automatically):'
Write-Host '   if Sites.Selected proves too restrictive for some source sites (e.g. a huge number of sites,'
Write-Host '   or a site with unusual sharing settings), re-run this script with -UseTenantWideFallback to'
Write-Host '   add the Sites.ReadWrite.All application permission instead - consent is granted automatically.'

if ($EnableOneDriveTarget) {
    Write-Host ''
    Write-Host '4) OneDrive target enabled: Files.ReadWrite.All was granted and ENGINE_ONEDRIVE_TARGET_ENABLED=true' -ForegroundColor Green
    Write-Host '   was written to .env - the "OneDrive" target option will now appear in the UI. Each project'
    Write-Host '   auto-provisions its own app (server/graph/provisionTenantApp.js); re-run that project''s'
    Write-Host '   sign-in once more if it was provisioned before this permission existed.'
} else {
    Write-Host ''
    Write-Host '4) OneDrive target: not enabled. Re-run this script with -EnableOneDriveTarget to add it -'
    Write-Host '   see the parameter help for the tenant-wide permission tradeoff before doing so.'
}

Write-Host ''
Write-Host 'This script is idempotent - re-run any time to repair a partial setup.' -ForegroundColor DarkGray
