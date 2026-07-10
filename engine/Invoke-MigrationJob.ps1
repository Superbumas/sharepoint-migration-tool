#Requires -Version 7.0
<#
.SYNOPSIS
  SharePoint migration engine. Spawned once per running job by the Node
  orchestrator (server/jobs/orchestrator.js). Emits one NDJSON event per line
  on stdout - Node is the only consumer of stdout, so nothing else may write
  to it (see engine/lib/Events.psm1).

.DESIGN NOTES
  - Copy-only: the engine copies source -> target and never deletes or
    modifies source content. New mappings are always action 'Migrate'; the
    legacy 'Migrate-selective'/'Archive' labels are still accepted below so
    jobs created from historical crosswalk rows keep working.
    Decommissioning legacy sites is a deliberate, separate step outside this
    tool - not something that should happen silently as a side effect of an
    Action label in a spreadsheet, given the HR/Finance content in scope.
  - Resume is verification-based, not index-based: every item (not just ones
    after a checkpoint) is checked against the actual target state (same file,
    same size) before being copied. A checkpoint is passed in for progress/ETA
    continuity only - correctness never depends on it.
  - Concurrency is implemented with persistent Start-ThreadJob "lanes" that
    each hold their own PnP connection and pull from a shared, thread-safe work
    queue - not a fresh connection per file, which would be prohibitively slow
    at hundreds of thousands of files.
  - Pause/cancel are polled from a small JSON control file after every item
    completes (never an OS signal), so a lane always finishes its current file
    and can report a clean checkpoint before stopping.
#>
param(
    [Parameter(Mandatory)][string]$JobId,
    # Which kind of source this job copies from. 'sharepoint' is every job
    # created before this option existed and remains the default. 'filesystem'
    # reads a DFS/UNC/local directory instead (see engine/lib/
    # FileSystemSource.psm1): SourcePath then holds the absolute directory
    # path (e.g. \\corp\dfs\Finance) and SourceSiteUrl/SourceLibrary are
    # empty - there is no source SharePoint connection at all.
    [ValidateSet('sharepoint', 'filesystem')][string]$SourceProvider = 'sharepoint',
    [string]$SourceSiteUrl,
    [string]$SourceLibrary,
    # AllowEmptyString: '' is a legitimate, deliberate value here - it means
    # "the root of the library" (e.g. a freshly created site with no
    # subfolders yet). Without this, PowerShell's mandatory-parameter binder
    # rejects an empty string as if the parameter were never supplied at all,
    # and the engine fails immediately with "Cannot bind argument ... because
    # it is an empty string" before it even connects to SharePoint.
    # For a filesystem source this is instead the absolute source directory.
    [Parameter(Mandatory)][AllowEmptyString()][string]$SourcePath,
    # Which kind of destination this job copies into. 'sharepoint' is every
    # job created before this option existed and remains the default - that
    # whole code path is untouched by the branches below. 'azure_blob'
    # archives into a container instead (see engine/lib/BlobTarget.psm1).
    [ValidateSet('sharepoint', 'azure_blob')][string]$TargetProvider = 'sharepoint',
    [string]$TargetSiteUrl,
    [string]$TargetLibrary,
    # No longer [Parameter(Mandatory)]: azure_blob jobs never pass this -
    # TargetBlobPrefix is the equivalent field for that destination. Every
    # sharepoint-provider job still gets it from the orchestrator exactly as
    # before, so this relaxation changes nothing for the existing path.
    [AllowEmptyString()][string]$TargetPath = '',
    [string]$TargetContainer,
    [string]$TargetBlobPrefix,
    # Secret: defaults from the environment - the orchestrator passes it
    # there (buildEngineSpawnEnv) because command lines are readable by any
    # local process on Windows. The parameter form still works for manual
    # invocations.
    [string]$BlobConnectionString = $env:ENGINE_BLOB_CONNECTION_STRING,
    [Parameter(Mandatory)][ValidateSet('Migrate', 'Migrate-selective', 'Archive')][string]$Action,
    [int]$Concurrency = 4,
    [Parameter(Mandatory)][string]$ControlFilePath,
    # Where the source-tree scan is persisted between runs of the same job, so
    # pause/resume/server restarts don't redo a many-minute enumeration.
    # Optional: empty means always scan fresh. Safe to reuse because every file
    # is re-verified against the actual target before copying regardless -
    # a stale scan can only miss files added after it was taken (a later
    # fresh run picks those up), never corrupt anything.
    [string]$TreeCachePath,
    [Parameter(Mandatory)][string]$ClientId,
    [Parameter(Mandatory)][string]$TenantId,
    # Exactly one credential style identifies the app-only identity
    # Connect-PnPOnline uses: CertThumbprint for the original shared app (a
    # certificate already in the local certificate store - the
    # legacy/backfilled project's identity), or CertificateBase64Encoded +
    # CertificatePassword for a Project's own auto-provisioned, tenant-local
    # app (see server/graph/provisionTenantApp.js) - a certificate generated
    # fresh at sign-in time and shipped as a PFX blob rather than installed
    # locally. Never a client secret: SharePoint Online's app-only auth
    # rejects client-secret-based tokens outright regardless of permissions.
    [string]$CertThumbprint,
    # Secrets: default from the environment (see -BlobConnectionString above).
    [string]$CertificateBase64Encoded = $env:ENGINE_CERT_BASE64_ENCODED,
    [string]$CertificatePassword = $env:ENGINE_CERT_PASSWORD,
    [string]$CheckpointJson,
    # Verify-only mode: skips all copying and runs just the post-migration
    # verification (Graph size + QuickXorHash comparison, or the blob-target
    # equivalent), emitting the same verify_mismatch / verification_summary
    # events. Used by the "Verify" button on completed jobs. Never emits
    # job_* lifecycle events - a re-verification must not change a completed
    # job's status.
    [switch]$VerifyOnly,
    # Archive-move semantics: for every source file whose migrated copy
    # re-verifies RIGHT NOW (existence + size + hash rule, same as the
    # verification phase), move the source file to the site RECYCLE BIN
    # (recoverable, never a permanent delete). Anything that fails the check
    # is kept and reported. Emptied folders are recycled afterwards. Like
    # -VerifyOnly this never emits job_* lifecycle events.
    [switch]$CleanupSource,
    # Storage reclamation after -CleanupSource: PERMANENTLY deletes recycle-bin
    # items (both stages) whose original location was under this job's source
    # root - recycled items still count toward SharePoint storage quota for 93
    # days otherwise. Touches nothing outside the source root. Irreversible.
    [switch]$PurgeRecycleBin
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Import-Module "$PSScriptRoot/lib/Events.psm1" -Force
Import-Module "$PSScriptRoot/lib/Retry.psm1" -Force
Import-Module "$PSScriptRoot/lib/Verification.psm1" -Force
Import-Module "$PSScriptRoot/lib/SharePointTree.psm1" -Force
Import-Module "$PSScriptRoot/lib/BlobTarget.psm1" -Force
Import-Module "$PSScriptRoot/lib/FileSystemSource.psm1" -Force
Import-Module PnP.PowerShell -ErrorAction Stop
Import-Module Microsoft.PowerShell.ThreadJob -ErrorAction SilentlyContinue

function Join-UrlSegments {
    param([string[]]$Segments)
    ($Segments | Where-Object { $_ } | ForEach-Object { $_.Trim('/') } | Where-Object { $_ }) -join '/'
}

function Get-ServerRelativeSitePath {
    param([string]$SiteUrl)
    if (-not $SiteUrl) { return '' }
    return ([Uri]$SiteUrl).AbsolutePath.TrimEnd('/')
}

function Read-ControlFile {
    param([string]$Path)
    try {
        $raw = Get-Content -Path $Path -Raw -ErrorAction Stop
        return ($raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ pauseRequested = $false; cancelRequested = $false; concurrencyOverride = $null }
    }
}

# Pause/cancel responsiveness during the long pre-copy phases: worker lanes
# poll the control file between files, but during enumeration / folder
# pre-creation / index prefetch no lanes exist yet - without this check a
# pause or cancel clicked mid-enumeration was ignored by the engine entirely
# (only Node's grace-period force-kill ever ended it, and a server restart
# loses even that timer). Called from the same per-folder/per-page progress
# hooks as Write-PhaseProgress, throttled to one file read every 2 seconds.
$script:ControlCheckLast = [datetime]::MinValue
function Assert-EngineNotStopped {
    if (-not $ControlFilePath) { return }
    if (((Get-Date) - $script:ControlCheckLast).TotalSeconds -lt 2) { return }
    $script:ControlCheckLast = Get-Date
    $ctrl = Read-ControlFile -Path $ControlFilePath
    if ($ctrl.cancelRequested) {
        Write-EngineEvent -Type 'job_cancelled' -Data @{ itemsDone = 0; bytesDone = 0 }
        exit 0
    }
    if ($ctrl.pauseRequested) {
        # No per-file progress exists yet in these phases - an empty checkpoint
        # is correct; resume simply redoes the (idempotent) pre-copy phases.
        Write-EngineEvent -Type 'paused' -Data @{ checkpoint = @{} }
        exit 0
    }
}

# Throttled phase_progress emitter for the long pre-copy phases (enumeration,
# folder pre-creation, index prefetch) - each otherwise sits on a single log
# line with zero sign of life for 10+ minutes on large trees. At most one
# event every 2 seconds regardless of how often callers invoke it; Node
# persists the latest snapshot (jobs.phase_json) and broadcasts it to the UI's
# phase banner, but never writes these to the audit log. Also doubles as the
# pause/cancel poll point for these phases (Assert-EngineNotStopped above) -
# every caller of one needs the other anyway.
$script:PhaseProgressLastEmit = [datetime]::MinValue
function Write-PhaseProgress {
    param(
        [Parameter(Mandatory)][string]$Phase,
        [hashtable]$Data = @{},
        [switch]$Force
    )
    Assert-EngineNotStopped
    if (-not $Force -and ((Get-Date) - $script:PhaseProgressLastEmit).TotalSeconds -lt 2) { return }
    $script:PhaseProgressLastEmit = Get-Date
    Write-EngineEvent -Type 'phase_progress' -Data (@{ phase = $Phase } + $Data)
}

# Runs the whole-tree verification (existence + size + content hash - Graph
# QuickXorHash for a SharePoint target, or the blob Content-MD5
# self-consistency check for an azure_blob target), emits
# verify_mismatch / verification_summary / log events, and returns
# @{ Summary = <counts hashtable>; Result = <raw compare object> }, or $null
# if verification itself errored (never fatal to the job).
function Invoke-VerificationPhase {
    param(
        [Parameter(Mandatory)][string]$TargetProvider,
        # 'filesystem' has no source connection/site/library - the source map
        # is built by hashing local files (Get-FileSystemFileMap), so the
        # three SharePoint-source params below become optional.
        [string]$SourceProvider = 'sharepoint',
        $SourceConn,
        [AllowEmptyString()][string]$SourceSite,
        [AllowEmptyString()][string]$SourceLib,
        # Path within the source library - or, for a filesystem source, the
        # absolute source directory.
        [Parameter(Mandatory)][AllowEmptyString()][string]$SourcePathInLib,
        # SharePoint-target only:
        $TargetConn,
        [string]$TargetSite,
        [string]$TargetLib,
        [AllowEmptyString()][string]$TargetPathInLib,
        # azure_blob-target only:
        [hashtable]$BlobCtx
    )
    try {
        $isBlob = $TargetProvider -eq 'azure_blob'
        $isFsSource = $SourceProvider -eq 'filesystem'
        $hashLabel = if ($isBlob) { 'MD5' } else { 'QuickXorHash' }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Verifying migration: comparing existence, size and content hash ($hashLabel) of every source file against its copy..." }
        $result = if ($isFsSource) {
            # Local QuickXorHash of every source file vs the hash SharePoint
            # computed server-side for the uploaded copy - reads every source
            # byte, which is exactly what makes this verification honest.
            $srcMap = Get-FileSystemFileMap -RootPath $SourcePathInLib -IncludeHash -OnProgress {
                param($count)
                Write-PhaseProgress -Phase 'hashing_source' -Data @{ files = $count }
            }
            $tgtDriveId = Get-GraphDriveId -Connection $TargetConn -SiteUrl $TargetSite -Library $TargetLib
            $tgtMap = Get-GraphFileMap -Connection $TargetConn -DriveId $tgtDriveId -RootPath $TargetPathInLib
            Compare-MigratedFileMaps -SourceMap $srcMap -TargetMap $tgtMap
        } elseif ($isBlob) {
            $srcDriveId = Get-GraphDriveId -Connection $SourceConn -SiteUrl $SourceSite -Library $SourceLib
            $srcMap = Get-GraphFileMap -Connection $SourceConn -DriveId $srcDriveId -RootPath $SourcePathInLib
            $tgtMap = Get-BlobKeyMap -BlobEndpoint $BlobCtx.BlobEndpoint -Container $BlobCtx.Container -Sas $BlobCtx.Sas -Prefix $BlobCtx.Prefix
            Compare-BlobMigratedTree -SourceMap $srcMap -TargetMap $tgtMap
        } else {
            Compare-PnPMigratedTrees `
                -SourceConnection $SourceConn -TargetConnection $TargetConn `
                -SourceSiteUrl $SourceSite -SourceLibrary $SourceLib -SourcePathInLibrary $SourcePathInLib `
                -TargetSiteUrl $TargetSite -TargetLibrary $TargetLib -TargetPathInLibrary $TargetPathInLib
        }

        $maxListed = 50
        foreach ($p in ($result.Missing | Select-Object -First $maxListed)) {
            Write-EngineEvent -Type 'verify_mismatch' -Data @{ level = 'error'; reason = 'missing'; sourcePath = $p; message = "VERIFY MISSING at target: $p" }
        }
        foreach ($p in ($result.SizeMismatch | Select-Object -First $maxListed)) {
            Write-EngineEvent -Type 'verify_mismatch' -Data @{ level = 'error'; reason = 'size'; sourcePath = $p; message = "VERIFY SIZE MISMATCH: $p" }
        }
        foreach ($p in ($result.HashMismatch | Select-Object -First $maxListed)) {
            Write-EngineEvent -Type 'verify_mismatch' -Data @{ level = 'error'; reason = 'hash'; sourcePath = $p; message = "VERIFY CONTENT HASH MISMATCH: $p" }
        }
        foreach ($p in ($result.OfficeRewritten | Select-Object -First $maxListed)) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Verify note: '$p' hash differs only because SharePoint re-stamps Office document properties on copy (content parts verified unaffected by this mechanism); open the copy to confirm if in doubt." }
        }

        $problems = $result.Missing.Count + $result.SizeMismatch.Count + $result.HashMismatch.Count
        $summary = @{
            sourceFiles     = $result.SourceFiles
            targetFiles     = $result.TargetFiles
            identical       = $result.Identical
            missing         = $result.Missing.Count
            sizeMismatch    = $result.SizeMismatch.Count
            hashMismatch    = $result.HashMismatch.Count
            officeRewritten = $result.OfficeRewritten.Count
            hashUnavailable = $result.HashUnavailable
            ok              = ($problems -eq 0)
        }
        Write-EngineEvent -Type 'verification_summary' -Data @{ verification = $summary }
        $verdict = if ($problems -eq 0) { 'PASSED' } else { "FOUND $problems PROBLEM(S)" }
        Write-EngineEvent -Type 'log' -Data @{ level = ($problems -eq 0 ? 'info' : 'error'); message = "Verification ${verdict}: $($result.Identical) of $($result.SourceFiles) files verified identical (hash), $($result.OfficeRewritten.Count) Office file(s) re-stamped by SharePoint (expected), $($result.Missing.Count) missing, $($result.SizeMismatch.Count) size / $($result.HashMismatch.Count) hash mismatches." }
        return @{ Summary = $summary; Result = $result }
    } catch {
        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Verification could not run (copies are unaffected): $($_.Exception.Message)" }
        return $null
    }
}

$jobFailed = $false
try {
    $isBlobTarget = $TargetProvider -eq 'azure_blob'
    $isFsSource = $SourceProvider -eq 'filesystem'
    if ($isBlobTarget -and -not $BlobConnectionString) {
        throw 'Azure Blob archiving is not configured on this server (AZURE_BLOB_CONNECTION_STRING is empty). Set it and restart the server before running this job.'
    }
    if ($isFsSource -and $isBlobTarget) {
        throw 'A filesystem (file share) source can only migrate into SharePoint - archiving a file share to Azure Blob is not supported.'
    }
    if ($isFsSource -and ($CleanupSource -or $PurgeRecycleBin)) {
        # The engine deletes source content only via SharePoint's recycle bin
        # (recoverable); a file share has no equivalent, so a filesystem
        # source stays strictly copy-only. Decommissioning the share is a
        # deliberate step outside this tool.
        throw 'Source cleanup is not available for file-share sources - the engine never deletes from a file share. Retire the share manually once you are satisfied with the migration.'
    }
    if (-not $CertThumbprint -and -not $CertificateBase64Encoded) {
        throw 'Neither -CertThumbprint nor -CertificateBase64Encoded was supplied - the engine has no app-only credential to authenticate with.'
    }
    # Splatted into every Connect-PnPOnline call below (main thread and both
    # lane scriptblocks) so each one only needs to add -Url/-ReturnConnection.
    # Certificate-based auth (either style) self-refreshes internally for
    # the life of the connection - no manual token refresh needed, unlike
    # the client-secret approach this replaced (SharePoint Online rejects
    # client-secret-based app-only tokens outright).
    $certArgs = if ($CertificateBase64Encoded) {
        @{ CertificateBase64Encoded = $CertificateBase64Encoded; CertificatePassword = (ConvertTo-SecureString -String $CertificatePassword -AsPlainText -Force) }
    } else {
        @{ Thumbprint = $CertThumbprint }
    }

    $sourceConn = $null
    if (-not $isFsSource) {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Connecting to source site $SourceSiteUrl" }
        $sourceConn = Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection
    } else {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Source: file share '$SourcePath'" }
    }

    $targetConn = $null
    $blobCtx = $null
    $sameSite = $false
    $effTargetSite = $null
    $effTargetLib = $null
    $targetPathInLib = $null
    $targetRoot = $null
    $targetSiteServerRelative = $null

    $sourceRoot = Join-UrlSegments @($SourceLibrary, $SourcePath)
    # Migrating a folder recreates the folder itself at the destination (the
    # convention every migration tool follows), rather than spilling its
    # contents directly into the target root. TargetPath/TargetBlobPrefix
    # addresses the folder/prefix the source folder is placed IN. Only a
    # library-root source ('' path) maps contents root-to-root.
    # A filesystem source's leaf comes from its directory path (and is
    # sanitized - the migrated folder's own name must be SharePoint-legal
    # just like everything under it).
    $sourceLeaf = if ($isFsSource) {
        ConvertTo-SharePointSafeName -Name ([System.IO.Path]::GetFileName($SourcePath.TrimEnd('\', '/')))
    } else {
        ($SourcePath.Trim('/') -split '/')[-1]
    }
    $sourceSiteServerRelative = Get-ServerRelativeSitePath -SiteUrl $SourceSiteUrl

    if ($isBlobTarget) {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Target: Azure Blob container '$TargetContainer'" }
        # Client content stages on local disk for the duration of one file's
        # transfer - sweep leftovers a force-killed previous run may have
        # orphaned before this run creates new ones.
        $staleTemp = Clear-StaleBlobTempFiles
        if ($staleTemp -gt 0) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Removed $staleTemp stale temp file(s) left by a previously interrupted run." }
        }
        $blobAccount = ConvertFrom-BlobConnectionString -ConnectionString $BlobConnectionString
        # A SAS connection string (Portal's "Shared access signature" blade)
        # already carries a signed token - use it as-is. An account-key
        # connection string ("Access keys" blade) has no token, so this
        # engine invocation builds its own Account SAS from the key.
        $blobSas = if ($blobAccount.Sas) { $blobAccount.Sas } else {
            New-BlobSasToken -AccountName $blobAccount.AccountName -AccountKey $blobAccount.AccountKey
        }
        $blobCtx = @{
            AccountName  = $blobAccount.AccountName
            BlobEndpoint = $blobAccount.BlobEndpoint
            Sas          = $blobSas
            Container    = $TargetContainer
            Prefix       = Get-BlobKey -Segments @($TargetBlobPrefix, $sourceLeaf)
        }
    } else {
        $sameSite = $TargetSiteUrl -and ($TargetSiteUrl.TrimEnd('/') -eq $SourceSiteUrl.TrimEnd('/'))
        if ($sameSite) {
            $targetConn = $sourceConn
        } else {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Connecting to target site $TargetSiteUrl" }
            $targetConn = Connect-PnPOnline -Url $TargetSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection
        }
        $targetRoot = Join-UrlSegments @($TargetLibrary, $TargetPath, $sourceLeaf)
        $targetSiteServerRelative = Get-ServerRelativeSitePath -SiteUrl $TargetSiteUrl
        $effTargetSite = if ($TargetSiteUrl) { $TargetSiteUrl } else { $SourceSiteUrl }
        $effTargetLib = if ($TargetLibrary) { $TargetLibrary } else { $SourceLibrary }
        $targetPathInLib = Join-UrlSegments @($TargetPath, $sourceLeaf)
    }

    $verifyArgs = @{
        TargetProvider  = $TargetProvider
        SourceProvider  = $SourceProvider
        SourceConn      = $sourceConn
        SourceSite      = $SourceSiteUrl
        SourceLib       = $SourceLibrary
        SourcePathInLib = $SourcePath
    }
    if ($isBlobTarget) {
        $verifyArgs.BlobCtx = $blobCtx
    } else {
        $verifyArgs.TargetConn = $targetConn
        $verifyArgs.TargetSite = $effTargetSite
        $verifyArgs.TargetLib = $effTargetLib
        $verifyArgs.TargetPathInLib = $targetPathInLib
    }

    if ($VerifyOnly) {
        Invoke-VerificationPhase @verifyArgs | Out-Null
        exit 0
    }

    if ($PurgeRecycleBin) {
        # --- Permanent purge of this job's recycled items -------------------
        # Recycled files still count toward the site's storage quota (first
        # AND second stage) for 93 days. This permanently deletes ONLY items
        # whose original path was under this job's source root - other
        # recycle-bin content is untouched.
        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = 'Recycle-bin purge started: permanently deleting recycled items that originated under this job''s source root. This cannot be undone.' }
        $rootDir = "$sourceSiteServerRelative/$sourceRoot".Replace('//', '/').TrimStart('/')
        $all = @(Get-PnPRecycleBinItem -Connection $sourceConn)
        $mine = @($all | Where-Object { $_.DirName -eq $rootDir -or $_.DirName -like "$rootDir/*" })
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Recycle bin holds $($all.Count) item(s); $($mine.Count) originated under '$rootDir' and will be purged." }
        $purged = 0; [long]$purgedBytes = 0
        foreach ($item in $mine) {
            try {
                $item | Clear-PnPRecycleBinItem -Force
                $purged++
                $purgedBytes += [long]$item.Size
                if ($purged % 25 -eq 0) { Write-PhaseProgress -Phase 'purging' -Data @{ purged = $purged; total = $mine.Count } }
            } catch {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Could not purge '$($item.LeafName)': $($_.Exception.Message)" }
            }
        }
        Write-EngineEvent -Type 'purge_summary' -Data @{ purged = $purged; bytes = $purgedBytes; binTotal = $all.Count }
        exit 0
    }

    if ($CleanupSource) {
        # --- Source cleanup after verified migration ("move" semantics) ----
        # Every file individually re-verifies against its migrated copy AT
        # THIS MOMENT before being touched - the stored verification result
        # is not trusted (the target could have changed since). Deletes go
        # to the site recycle bin, never permanent. Anything that fails the
        # check is kept and reported, per-file, in the audit log.
        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = 'Source cleanup started: each file is re-verified against its migrated copy right now, then moved to the source site recycle bin. Files that do not verify are kept.' }

        $srcDriveId = Get-GraphDriveId -Connection $sourceConn -SiteUrl $SourceSiteUrl -Library $SourceLibrary
        $srcMap = Get-GraphFileMap -Connection $sourceConn -DriveId $srcDriveId -RootPath $SourcePath -OnProgress {
            param($count)
            Write-PhaseProgress -Phase 'indexing_source' -Data @{ files = $count }
        }
        $tgtMap = if ($isBlobTarget) {
            Get-BlobKeyMap -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas -Prefix $blobCtx.Prefix
        } else {
            $tgtDriveId = Get-GraphDriveId -Connection $targetConn -SiteUrl $effTargetSite -Library $effTargetLib
            Get-GraphFileMap -Connection $targetConn -DriveId $tgtDriveId -RootPath $targetPathInLib
        }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Cleanup check: $($srcMap.Count) source file(s) vs $($tgtMap.Count) migrated file(s)." }

        # Same acceptance rule as verification: exact size+hash, hash
        # unavailable degrades to size-only, and Office documents may differ
        # (SharePoint property re-stamp) without failing.
        $officeExtensions = @('.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.one', '.vsdx')
        $deleted = 0; $kept = 0
        $keptList = [System.Collections.Generic.List[string]]::new()
        foreach ($rel in @($srcMap.Keys)) {
            $src = $srcMap[$rel]
            $tgt = $tgtMap[$rel]
            $verified = $false
            if ($tgt) {
                if ($isBlobTarget) {
                    $verified = ([long]$src.Size -eq [long]$tgt.Size) -and
                        (-not $tgt.SourceMd5 -or -not $tgt.ContentMd5 -or $tgt.SourceMd5 -eq $tgt.ContentMd5)
                } else {
                    $isOffice = $officeExtensions -contains ([System.IO.Path]::GetExtension($rel).ToLowerInvariant())
                    if ([long]$src.Size -eq [long]$tgt.Size) {
                        $verified = (-not $src.Hash -or -not $tgt.Hash) -or ($src.Hash -eq $tgt.Hash) -or $isOffice
                    } elseif ($isOffice) {
                        $verified = $true
                    }
                }
            }
            $serverRel = "$sourceSiteServerRelative/$sourceRoot/$rel".Replace('//', '/')
            if ($verified) {
                try {
                    # Out-Null: -Recycle returns the recycle-bin item id on
                    # stdout, which is reserved for NDJSON events.
                    Remove-PnPFile -ServerRelativeUrl $serverRel -Recycle -Force -Connection $sourceConn -ErrorAction Stop | Out-Null
                    $deleted++
                    Write-EngineEvent -Type 'source_deleted' -Data @{ sourcePath = $serverRel }
                } catch {
                    $kept++; $keptList.Add($rel)
                    Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Could not recycle '$rel' ($($_.Exception.Message)) - kept in place." }
                }
            } else {
                $kept++; $keptList.Add($rel)
                Write-EngineEvent -Type 'source_kept' -Data @{
                    sourcePath = $serverRel
                    reason = if ($tgt) { 'migrated copy does not match the source right now' } else { 'no migrated copy found at the target' }
                }
            }
            Write-PhaseProgress -Phase 'cleaning' -Data @{ deleted = $deleted; kept = $kept; total = $srcMap.Count }
        }

        # Recycle now-empty folders, deepest first. Any folder that still has
        # a file anywhere beneath it (kept files, or files created after the
        # migration) protects its whole ancestor chain.
        $foldersDeleted = 0
        try {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = 'Files done - scanning the source tree for now-empty folders to recycle (this walks every folder; large trees take a while)...' }
            $treeAfter = Get-PnPFolderTree -Connection $sourceConn -RootSiteRelativeUrl $sourceRoot -OnProgress {
                param($folderCount, $fileCount, $pendingCount)
                Write-PhaseProgress -Phase 'enumerating' -Data @{ folders = $folderCount; files = $fileCount; pending = $pendingCount }
            }
            $protected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            foreach ($f in @($treeAfter.Files)) {
                $parts = @(($f.RelativeFromRoot -split '/') | Where-Object { $_ })
                for ($i = 1; $i -le $parts.Count; $i++) { $null = $protected.Add(($parts[0..($i - 1)] -join '/')) }
            }
            $candidates = @($treeAfter.Folders) | Where-Object { $_ -and -not $protected.Contains($_) } |
                Sort-Object { ($_ -split '/').Count } -Descending
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Recycling $(@($candidates).Count) empty folder(s), deepest first..." }
            foreach ($relDir in $candidates) {
                $leaf = ($relDir -split '/')[-1]
                $parentRel = if ($relDir.Contains('/')) { $relDir.Substring(0, $relDir.LastIndexOf('/')) } else { '' }
                $parentPath = "$sourceRoot/$parentRel".TrimEnd('/').Replace('//', '/')
                try {
                    Remove-PnPFolder -Name $leaf -Folder $parentPath -Recycle -Force -Connection $sourceConn -ErrorAction Stop | Out-Null
                    $foldersDeleted++
                    Write-PhaseProgress -Phase 'clearing_folders' -Data @{ done = $foldersDeleted; total = @($candidates).Count }
                } catch {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Could not recycle empty folder '$relDir': $($_.Exception.Message)" }
                }
            }
        } catch {
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Empty-folder cleanup skipped: $($_.Exception.Message)" }
        }

        Write-EngineEvent -Type 'cleanup_summary' -Data @{
            deleted = $deleted; kept = $kept; foldersDeleted = $foldersDeleted
            keptSample = @($keptList | Select-Object -First 20)
        }
        exit 0
    }

    # --- Preflight ----------------------------------------------------------
    # Fail in seconds with an actionable message instead of a bare "Access
    # denied" mid-enumeration. A connection succeeding proves nothing under
    # Sites.Selected - the first real read is where a missing/weak per-site
    # grant surfaces. A filesystem source instead needs a readable share -
    # either as the engine PROCESS account (whoever runs the Node server) or,
    # when the root was configured with its own credentials, as that user.
    if ($isFsSource) {
        # Per-root share credentials (Settings page): the orchestrator passes
        # them in this process's ENVIRONMENT (never the command line - that's
        # visible to every process on the machine) and the engine establishes
        # the SMB session itself, so a session made by Node can't strand a
        # long job by dropping hours in. `net` output stays captured - stdout
        # is NDJSON-reserved - and a non-zero exit only matters if the path
        # is genuinely unreadable afterward (e.g. "already connected" while
        # the session is in fact fine).
        if ($env:FS_SOURCE_USERNAME -and $env:FS_SOURCE_SHARE) {
            $netOutput = & net use $env:FS_SOURCE_SHARE $env:FS_SOURCE_PASSWORD "/user:$($env:FS_SOURCE_USERNAME)" /persistent:no 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Connected to $($env:FS_SOURCE_SHARE) as $($env:FS_SOURCE_USERNAME)." }
            } elseif (-not (Test-Path -LiteralPath $SourcePath)) {
                throw "Preflight failed: could not connect to $($env:FS_SOURCE_SHARE) as $($env:FS_SOURCE_USERNAME): $(($netOutput | Out-String).Trim())"
            }
        }
        try {
            $probe = [System.IO.DirectoryInfo]::new($SourcePath.TrimEnd('\', '/'))
            if (-not $probe.Exists) { throw "the path does not exist or is not reachable" }
            $probe.EnumerateFileSystemInfos() | Select-Object -First 1 | Out-Null
        } catch {
            $identityHint = if ($env:FS_SOURCE_USERNAME) { "the configured share user '$($env:FS_SOURCE_USERNAME)'" } else { 'the account running the migration server' }
            throw "Preflight failed: the migration engine cannot read source path '$SourcePath' ($($_.Exception.Message)). $identityHint needs read access to that share/directory."
        }
    } else {
        try {
            Get-PnPFolderItem -FolderSiteRelativeUrl $SourceLibrary -ItemType Folder -Connection $sourceConn -ErrorAction Stop | Out-Null
        } catch {
            throw "Preflight failed: the migration engine cannot read source library '$SourceLibrary' on $SourceSiteUrl ($($_.Exception.Message)). Use 'Grant migration engine access to this site' in the site picker (grants the 'fullcontrol' role - 'write' is not enough when items have unique permissions), then run the job again."
        }
    }
    if ($isBlobTarget) {
        try {
            Confirm-BlobContainerExists -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas
        } catch {
            throw "Preflight failed: the migration engine cannot access Azure Blob container '$($blobCtx.Container)' ($($_.Exception.Message))."
        }
        # A portal-generated SAS connection string carries its own fixed
        # expiry (se=...) that the engine cannot refresh - a long job can
        # outlive it and start failing with 403 "signature" errors hours in
        # (observed live: uploads fine at 03:46, 403s by 04:04). Check up
        # front instead of discovering it at hour six; the Access-Keys
        # connection string form avoids the problem entirely (the engine
        # mints its own 48h token from the account key).
        if ($blobCtx.Sas -match '(?:^|&)se=([^&]+)') {
            try {
                $sasExpiry = [datetime]::Parse([uri]::UnescapeDataString($Matches[1])).ToUniversalTime()
                $hoursLeft = ($sasExpiry - (Get-Date).ToUniversalTime()).TotalHours
                if ($hoursLeft -le 0) {
                    throw "Preflight failed: the Azure Blob SAS in this project's connection string expired at $($sasExpiry.ToString('u')). Generate a new one, or (better) use the storage account's Access-Keys connection string instead - the engine then creates its own long-lived token automatically."
                }
                if ($hoursLeft -lt 12) {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "The Azure Blob SAS in this project's connection string expires in $([Math]::Round($hoursLeft, 1)) hour(s) ($($sasExpiry.ToString('u'))). A long job may outlive it and start failing with 403 errors - prefer the storage account's Access-Keys connection string." }
                }
            } catch {
                if ($_.Exception.Message -like 'Preflight failed*') { throw }
            }
        }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Preflight OK: engine can read source library and access blob container '$($blobCtx.Container)'." }
    } else {
        try {
            Get-PnPFolderItem -FolderSiteRelativeUrl $effTargetLib -ItemType Folder -Connection $targetConn -ErrorAction Stop | Out-Null
        } catch {
            throw "Preflight failed: the migration engine cannot read target library '$effTargetLib' on $effTargetSite ($($_.Exception.Message)). Use 'Grant migration engine access to this site' in the site picker (grants the 'fullcontrol' role), then run the job again."
        }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = ($isFsSource ? 'Preflight OK: engine can read the source path and the target library.' : 'Preflight OK: engine can read both source and target libraries.') }
    }

    if ($CheckpointJson) {
        try {
            $checkpoint = $CheckpointJson | ConvertFrom-Json
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Resuming job. Last checkpoint: $($checkpoint.itemsDone) items / $($checkpoint.bytesDone) bytes done. Every item is still re-verified against the target before being skipped." }
        } catch {
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = 'Could not parse checkpoint JSON - continuing as a fresh enumeration (verification will still prevent duplicate copies).' }
        }
    }

    # --- Source-tree scan, with a persisted cache ---------------------------
    # A full enumeration of a large tree takes many minutes, and it used to be
    # redone from scratch on every pause/resume/server restart. The scan is
    # persisted to $TreeCachePath after a fresh walk and reused on the next
    # run of the same job while it's still fresh (same source, < 6 hours old).
    # This is safe: every file is still individually re-verified against the
    # actual target before copying, so a stale scan can only miss files added
    # to the source after it was taken - never copy anything wrong.
    $TREE_CACHE_MAX_AGE_HOURS = 6
    # Filesystem sources get a provider-prefixed key; SharePoint keeps the
    # original format so caches from jobs paused before this feature existed
    # still validate on resume.
    $sourceKey = if ($isFsSource) { "filesystem|$SourcePath" } else { "$SourceSiteUrl|$SourceLibrary|$SourcePath" }
    $targetKey = if ($isBlobTarget) { 'blob' } else { "$effTargetSite|$effTargetLib|$targetPathInLib" }
    $tree = $null
    $cachedFoldersEnsuredFor = $null
    if ($TreeCachePath -and (Test-Path $TreeCachePath)) {
        try {
            $cache = Get-Content -Path $TreeCachePath -Raw | ConvertFrom-Json
            $ageHours = ((Get-Date).ToUniversalTime() - [datetime]$cache.generatedAtUtc).TotalHours
            if ($cache.sourceKey -eq $sourceKey -and $ageHours -lt $TREE_CACHE_MAX_AGE_HOURS) {
                $tree = [pscustomobject]@{
                    Files   = @($cache.files)
                    Folders = @($cache.folders | ForEach-Object { [string]$_ })
                }
                $cachedFoldersEnsuredFor = $cache.foldersEnsuredFor
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Reusing source tree scan from $([Math]::Round($ageHours * 60)) minute(s) ago ($(@($cache.files).Count) files) - every file is still re-verified against the target before copying. Files added to the source since then are picked up by the next fresh run." }
            }
        } catch {
            $tree = $null
        }
    }

    if (-not $tree) {
        if ($isFsSource) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Enumerating source tree under '$SourcePath'" }
            $tree = Get-FileSystemTree -RootPath $SourcePath -OnProgress {
                param($folderCount, $fileCount, $pendingCount)
                Write-PhaseProgress -Phase 'enumerating' -Data @{ folders = $folderCount; files = $fileCount; pending = $pendingCount }
            }
            # Surface everything the walk had to work around - a partial or
            # adjusted enumeration must be visible, never silent.
            if ($tree.JunkSkipped -gt 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Skipped $($tree.JunkSkipped) system/temp file(s) (Thumbs.db, desktop.ini, Office ~`$ lock files) - these are never migrated." }
            }
            if ($tree.RenamedCount -gt 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "$($tree.RenamedCount) file/folder name(s) contain characters SharePoint does not allow and will be renamed at the target (deterministically - resume and verification handle this). Each rename is listed as its file is copied." }
            }
            foreach ($rp in ($tree.SkippedReparsePoints | Select-Object -First 20)) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Skipped junction/symlink '$rp' (following links risks cycles and double-copies; migrate the link target directly if its content is needed)." }
            }
            foreach ($e in ($tree.Errors | Select-Object -First 50)) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "Could not enumerate '$($e.Path)': $($e.Message) - files under it are NOT in this job." }
            }
            if ($tree.Errors.Count -gt 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "$($tree.Errors.Count) folder(s) could not be read (see above) - fix access for the engine account and run the job again to pick their contents up." }
            }
        } else {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Enumerating source tree under '$sourceRoot'" }
            $tree = Get-PnPFolderTree -Connection $sourceConn -RootSiteRelativeUrl $sourceRoot -OnProgress {
                param($folderCount, $fileCount, $pendingCount)
                Write-PhaseProgress -Phase 'enumerating' -Data @{ folders = $folderCount; files = $fileCount; pending = $pendingCount }
            }
        }
        if ($TreeCachePath) {
            try {
                @{
                    generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
                    sourceKey      = $sourceKey
                    files          = $tree.Files
                    folders        = $tree.Folders
                } | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $TreeCachePath -Encoding utf8
            } catch {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Could not persist the tree scan cache ($($_.Exception.Message)) - harmless, the next run just re-enumerates." }
            }
        }
    }
    $totalItems = @($tree.Files).Count
    $totalBytes = ($tree.Files | Measure-Object -Property Size -Sum).Sum
    if (-not $totalBytes) { $totalBytes = 0 }

    Write-EngineEvent -Type 'job_started' -Data @{ jobId = $JobId; totalItems = $totalItems; totalBytes = [long]$totalBytes }

    if ($isBlobTarget) {
        # No pre-creation step: object storage has no real folders, only
        # '/'-delimited blob key names - uploading a blob whose key contains
        # '/' is sufficient, and portals render the virtual hierarchy
        # automatically. This is a genuine simplification versus the
        # SharePoint path's Initialize-PnPTargetFolders, not an oversight.
    } elseif ($cachedFoldersEnsuredFor -eq $targetKey) {
        # This exact target's folder tree was already fully created by a
        # previous run of this job (recorded in the cache below) - re-checking
        # thousands of folders one by one costs the better part of an hour on
        # big trees for zero gain. If someone deleted target folders since,
        # affected files fail visibly at copy time and a fresh run (cache
        # expires after 6h, or delete data/tree-cache/<jobId>.json) recreates them.
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Target folders were already created by a previous run of this job - skipping folder pre-creation." }
    } else {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Pre-creating $($tree.Folders.Count) target folder(s) under '$targetRoot'" }
        Initialize-PnPTargetFolders -Connection $targetConn -TargetRootSiteRelativeUrl $targetRoot -RelativeFolderPaths $tree.Folders -OnProgress {
            param($done, $total)
            Write-PhaseProgress -Phase 'preparing_folders' -Data @{ done = $done; total = $total }
        }
        # Record folder-creation success against this exact target so the next
        # resume of this job can skip it (see the branch above).
        if ($TreeCachePath -and (Test-Path $TreeCachePath)) {
            try {
                $cacheUpdate = Get-Content -Path $TreeCachePath -Raw | ConvertFrom-Json
                $cacheUpdate | Add-Member -NotePropertyName 'foldersEnsuredFor' -NotePropertyValue $targetKey -Force
                $cacheUpdate | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $TreeCachePath -Encoding utf8
            } catch {}
        }
    }

    # --- Prefetched indexes (performance) -----------------------------------
    # One Graph/Blob-list walk of each tree replaces two network calls PER
    # FILE in the lanes: the target map turns the skip/delta check into a
    # memory lookup, and the source metadata map removes the per-file source
    # item fetch when stamping Created/Modified/Author/Editor. On failure
    # both fall back to the per-file code paths - slower but identical
    # behaviour.
    $targetFileMap = $null
    $sourceMetaMap = $null
    try {
        if ($isFsSource) {
            # No source-side prefetch: the filesystem walk above already
            # captured Size/Created/Modified on every tree item, so the lanes
            # need no separate metadata map at all.
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = 'Prefetching target file index (single tree walk instead of per-file lookups)...' }
        } else {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = 'Prefetching target file index and source metadata (single tree walk instead of per-file lookups)...' }
            $srcDriveId = Get-GraphDriveId -Connection $sourceConn -SiteUrl $SourceSiteUrl -Library $SourceLibrary
            $sourceMetaMap = Get-GraphFileMap -Connection $sourceConn -DriveId $srcDriveId -RootPath $SourcePath -IncludeDetails -OnProgress {
                param($count)
                Write-PhaseProgress -Phase 'indexing_source' -Data @{ files = $count }
            }
        }
        if ($isBlobTarget) {
            $targetFileMap = Get-BlobKeyMap -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas -Prefix $blobCtx.Prefix
        } else {
            $tgtDriveId = Get-GraphDriveId -Connection $targetConn -SiteUrl $effTargetSite -Library $effTargetLib
            $targetFileMap = Get-GraphFileMap -Connection $targetConn -DriveId $tgtDriveId -RootPath $targetPathInLib -IncludeDetails -OnProgress {
                param($count)
                Write-PhaseProgress -Phase 'indexing_target' -Data @{ files = $count }
            }
        }
        $prefetchNote = if ($isFsSource) { '' } else { ", metadata cached for $($sourceMetaMap.Count) source file(s)" }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Prefetch OK: $($targetFileMap.Count) existing target file(s) indexed$prefetchNote." }
    } catch {
        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Prefetch failed - falling back to per-file checks (slower, same behaviour): $($_.Exception.Message)" }
        $targetFileMap = $null
        $sourceMetaMap = $null
    }

    if ($totalItems -eq 0) {
        Write-EngineEvent -Type 'job_completed' -Data @{ summary = @{ itemsDone = 0; bytesDone = 0; itemsFailed = 0 } }
        exit 0
    }

    # --- Shared state between the main thread and the worker lanes ------------
    $workQueue = [System.Collections.Concurrent.ConcurrentQueue[object]]::new()
    foreach ($f in $tree.Files) { $workQueue.Enqueue($f) }

    $resultQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
    $shared = [hashtable]::Synchronized(@{
        Stop            = $false
        Paused          = $false
        Cancelled       = $false
        TargetLaneCount = $Concurrency
        # laneIndex -> @{ SourcePath; TargetPath; Total; Stream } for uploads
        # currently in flight. Filesystem-source lanes register here so the
        # main thread's drain loop can emit live item_progress events for
        # big files - a 370MB upload otherwise sits silent for 6 minutes
        # between item_start and item_success. Lanes write, main thread
        # reads; Stream.BytesConsumed is an Interlocked counter, safe to
        # poll cross-thread even after the lane disposes the stream.
        InFlight        = [hashtable]::Synchronized(@{})
    })

    $laneScriptSharePoint = {
        param($LaneIndex, $WorkQueue, $ResultQueue, $Shared, $SourceSiteUrl, $TargetSiteUrl, $ClientId, $TenantId,
              $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath, $SourceSiteServerRelative, $TargetSiteServerRelative,
              $SourceRoot, $TargetRoot, $SameSite, $TargetFileMap, $SourceMetaMap)

        Import-Module PnP.PowerShell -ErrorAction Stop
        # NO -Force here: ThreadJob lanes share the process with the main
        # thread, and a concurrent -Force re-import of a module the main
        # thread also holds can yank its functions out from under it - seen
        # live as "The term 'Invoke-WithRetry' is not recognized" thrown by
        # the main thread's verification-repair loop after lanes had run.
        # A fresh lane runspace has nothing loaded, so plain Import-Module
        # is both sufficient and safe.
        Import-Module "$using:PSScriptRoot/lib/Events.psm1"
        Import-Module "$using:PSScriptRoot/lib/Retry.psm1"
        Import-Module "$using:PSScriptRoot/lib/Verification.psm1"

        function local:Read-Control {
            param([string]$Path)
            try {
                return (Get-Content -Path $Path -Raw -ErrorAction Stop | ConvertFrom-Json)
            } catch {
                return [pscustomobject]@{ pauseRequested = $false; cancelRequested = $false }
            }
        }

        $certArgs = if ($CertificateBase64Encoded) {
            @{ CertificateBase64Encoded = $CertificateBase64Encoded; CertificatePassword = (ConvertTo-SecureString -String $CertificatePassword -AsPlainText -Force) }
        } else {
            @{ Thumbprint = $CertThumbprint }
        }
        $laneSourceConn = Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection
        $laneTargetConn = if ($SameSite) { $laneSourceConn } else { Connect-PnPOnline -Url $TargetSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection }

        # Target library list, resolved once per lane - used to stamp original
        # metadata (Created/Modified/Author/Editor) onto each copied file.
        # Get-PnPList accepts the library's URL segment (e.g. "Shared
        # Documents"), which is what the job stores; the display title
        # ("Documents") may differ.
        $laneTargetList = $null
        try { $laneTargetList = Get-PnPList -Identity (($TargetRoot -split '/')[0]) -Connection $laneTargetConn -ErrorAction Stop } catch {}

        while (-not $Shared.Stop) {
            if ($LaneIndex -ge $Shared.TargetLaneCount) { break }

            $item = $null
            if (-not $WorkQueue.TryDequeue([ref]$item)) { break }

            $relFromRoot = $item.RelativeFromRoot
            $sourceFileServerRel = "$SourceSiteServerRelative/$SourceRoot/$relFromRoot/$($item.Name)".Replace('//', '/')
            $targetFolderServerRel = "$TargetSiteServerRelative/$TargetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
            $targetFileServerRel = "$targetFolderServerRel/$($item.Name)"

            $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_start' -Data @{
                sourcePath = $sourceFileServerRel; targetPath = $targetFileServerRel; itemType = 'file'; bytes = [long]$item.Size
            }))

            # Skip/delta check: prefer the prefetched target index (memory
            # lookup, zero network) - same rule as Test-PnPTargetFileMatches:
            # same size AND target at least as new as the source.
            $relKey = if ($relFromRoot) { "$relFromRoot/$($item.Name)" } else { $item.Name }
            if ($null -ne $TargetFileMap) {
                $existing = $TargetFileMap[$relKey]
                $alreadyDone = $existing -and
                    ([long]$existing.Size -eq [long]$item.Size) -and
                    (-not $item.Modified -or -not $existing.Modified -or $existing.Modified -ge [datetime]$item.Modified)
            } else {
                $alreadyDone = Test-PnPTargetFileMatches -Connection $laneTargetConn -TargetServerRelativeUrl $targetFileServerRel -ExpectedSize $item.Size -SourceModified $item.Modified
            }
            if ($alreadyDone) {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_skipped' -Data @{
                    sourcePath = $sourceFileServerRel; targetPath = $targetFileServerRel; bytes = [long]$item.Size
                    reason     = 'target already has a file of the same name and size'
                }))
            } else {
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $script:attemptsUsed = 0
                # Live "currently copying" indicator. Copy-PnPFile is a
                # SERVER-SIDE copy - the bytes never pass through the engine
                # and SharePoint exposes no percentage for it - so this entry
                # has no BytesDone: the UI shows which file each lane is on
                # (with size and elapsed time) rather than a fake bar.
                $Shared.InFlight[$LaneIndex] = @{
                    SourcePath = $sourceFileServerRel; TargetPath = $targetFileServerRel
                    Total = [long]$item.Size; Phase = 'copying'
                }
                try {
                    Invoke-WithRetry -MaxAttempts 5 -Action {
                        Copy-PnPFile -SourceUrl $sourceFileServerRel -TargetUrl $targetFolderServerRel `
                            -Force -OverwriteIfAlreadyExists -Connection $laneSourceConn -ErrorAction Stop
                    } -OnRetry {
                        param($attempt, $waitMs, $reason, $statusCode, $message)
                        $script:attemptsUsed = $attempt
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_retry' -Data @{
                            sourcePath = $sourceFileServerRel; targetPath = $targetFileServerRel
                            attempt    = $attempt; reason = $reason; waitMs = $waitMs; httpStatus = $statusCode
                        }))
                    }
                    # Preserve the original item metadata on the copy. Copy-PnPFile
                    # stamps the target with copy-time/app identity; compliance
                    # needs the real Created/Modified dates and people. Failure
                    # here never fails the item - the content copy already
                    # succeeded - it just logs a warning.
                    try {
                        $values = @{}
                        $meta = if ($null -ne $SourceMetaMap) { $SourceMetaMap[$relKey] } else { $null }
                        if ($meta) {
                            # Fast path: metadata came from the prefetched source walk.
                            if ($meta.Created) { $values['Created'] = $meta.Created }
                            if ($meta.Modified) { $values['Modified'] = $meta.Modified }
                            if ($meta.AuthorEmail) { $values['Author'] = $meta.AuthorEmail }
                            if ($meta.EditorEmail) { $values['Editor'] = $meta.EditorEmail }
                        } else {
                            $srcItem = Get-PnPFile -Url $sourceFileServerRel -AsListItem -Connection $laneSourceConn -ErrorAction Stop
                            if ($srcItem['Created']) { $values['Created'] = $srcItem['Created'] }
                            if ($srcItem['Modified']) { $values['Modified'] = $srcItem['Modified'] }
                            if ($srcItem['Author'] -and $srcItem['Author'].Email) { $values['Author'] = $srcItem['Author'].Email }
                            if ($srcItem['Editor'] -and $srcItem['Editor'].Email) { $values['Editor'] = $srcItem['Editor'].Email }
                        }
                        if ($laneTargetList -and $values.Count -gt 0) {
                            $tgtItem = Get-PnPFile -Url $targetFileServerRel -AsListItem -Connection $laneTargetConn -ErrorAction Stop
                            Set-PnPListItem -List $laneTargetList -Identity $tgtItem.Id -Values $values -Connection $laneTargetConn -ErrorAction Stop | Out-Null
                        }
                    } catch {
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                            level = 'warn'; message = "Copied OK but could not preserve original metadata for '$targetFileServerRel': $($_.Exception.Message)"
                        }))
                    }

                    $sw.Stop()
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_success' -Data @{
                        sourcePath = $sourceFileServerRel; targetPath = $targetFileServerRel
                        bytes      = [long]$item.Size; durationMs = [int]$sw.ElapsedMilliseconds; httpStatus = 200
                    }))
                } catch {
                    $sw.Stop()
                    $statusCode = Get-HttpStatusCode -Exception $_.Exception
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_failed' -Data @{
                        sourcePath = $sourceFileServerRel; targetPath = $targetFileServerRel
                        error      = $_.Exception.Message; httpStatus = $statusCode; retryCount = $script:attemptsUsed
                    }))
                } finally {
                    $null = $Shared.InFlight.Remove($LaneIndex)
                }
            }

            $ctrl = Read-Control -Path $ControlFilePath
            if ($ctrl.cancelRequested) { $Shared.Cancelled = $true; $Shared.Stop = $true; break }
            if ($ctrl.pauseRequested) { $Shared.Paused = $true; $Shared.Stop = $true; break }
        }

        try { Disconnect-PnPOnline -Connection $laneSourceConn } catch {}
        if (-not $SameSite) { try { Disconnect-PnPOnline -Connection $laneTargetConn } catch {} }
    }

    # Blob-target lane: downloads each file from SharePoint (reusing the
    # lane's own PnP connection - Get-PnPFile -AsFile) then uploads it to the
    # blob container via BlobTarget.psm1 (Copy-PnPFile has no blob
    # equivalent - it's a SharePoint-native server-side copy). Pushes the
    # identical item_start/item_success/item_retry/item_failed/item_skipped
    # NDJSON event shapes onto the same $resultQueue as the SharePoint lane,
    # so the drain loop, checkpointing and adaptive concurrency below need
    # no changes to support either target.
    $laneScriptBlob = {
        param($LaneIndex, $WorkQueue, $ResultQueue, $Shared, $SourceSiteUrl, $ClientId, $TenantId,
              $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath, $SourceSiteServerRelative, $SourceRoot,
              $BlobEndpoint, $Container, $Sas, $BlobPrefix, $TargetFileMap, $SourceMetaMap)

        Import-Module PnP.PowerShell -ErrorAction Stop
        # NO -Force - same in-process clobbering hazard as the SharePoint
        # lane above.
        Import-Module "$using:PSScriptRoot/lib/Events.psm1"
        Import-Module "$using:PSScriptRoot/lib/Retry.psm1"
        Import-Module "$using:PSScriptRoot/lib/BlobTarget.psm1"

        function local:Read-Control {
            param([string]$Path)
            try {
                return (Get-Content -Path $Path -Raw -ErrorAction Stop | ConvertFrom-Json)
            } catch {
                return [pscustomobject]@{ pauseRequested = $false; cancelRequested = $false }
            }
        }

        $certArgs = if ($CertificateBase64Encoded) {
            @{ CertificateBase64Encoded = $CertificateBase64Encoded; CertificatePassword = (ConvertTo-SecureString -String $CertificatePassword -AsPlainText -Force) }
        } else {
            @{ Thumbprint = $CertThumbprint }
        }
        $laneSourceConn = Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection

        while (-not $Shared.Stop) {
            if ($LaneIndex -ge $Shared.TargetLaneCount) { break }

            $item = $null
            if (-not $WorkQueue.TryDequeue([ref]$item)) { break }

            $relFromRoot = $item.RelativeFromRoot
            $sourceFileServerRel = "$SourceSiteServerRelative/$SourceRoot/$relFromRoot/$($item.Name)".Replace('//', '/')
            $blobKey = Get-BlobKey -Segments @($BlobPrefix, $relFromRoot, $item.Name)
            $targetDisplayPath = "$Container/$blobKey"

            $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_start' -Data @{
                sourcePath = $sourceFileServerRel; targetPath = $targetDisplayPath; itemType = 'file'; bytes = [long]$item.Size
            }))

            # Skip/delta check: prefer the prefetched target index (memory
            # lookup, zero network) - same rule as Test-BlobTargetMatches:
            # same size AND target at least as new as the source.
            $relKey = if ($relFromRoot) { "$relFromRoot/$($item.Name)" } else { $item.Name }
            if ($null -ne $TargetFileMap) {
                $existing = $TargetFileMap[$relKey]
                $alreadyDone = $existing -and
                    ([long]$existing.Size -eq [long]$item.Size) -and
                    (-not $item.Modified -or -not $existing.Modified -or $existing.Modified -ge [datetime]$item.Modified)
            } else {
                $alreadyDone = Test-BlobTargetMatches -BlobEndpoint $BlobEndpoint -Container $Container -Sas $Sas `
                    -BlobKey $blobKey -ExpectedSize $item.Size -SourceModified $item.Modified
            }

            if ($alreadyDone) {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_skipped' -Data @{
                    sourcePath = $sourceFileServerRel; targetPath = $targetDisplayPath; bytes = [long]$item.Size
                    reason     = 'target already has a blob of the same name and size'
                }))
            } else {
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $script:attemptsUsed = 0
                # Live per-file progress: the main thread polls this entry
                # every ~2.5s - during the download phase it reads the growing
                # temp file's size (TempPath), during the block upload the
                # OnProgress closure updates BytesDone from this lane's thread.
                $inflight = [hashtable]::Synchronized(@{
                    SourcePath = $sourceFileServerRel; TargetPath = $targetDisplayPath
                    Total = [long]$item.Size; Phase = 'downloading'; BytesDone = [long]0; TempPath = $null
                })
                $Shared.InFlight[$LaneIndex] = $inflight
                # GetNewClosure: scriptblocks resolve variables dynamically at
                # the CALL site (inside BlobTarget.psm1's module scope, where
                # $inflight doesn't exist) - the closure pins this iteration's
                # $inflight reference.
                $blobProgress = {
                    param($phase, $bytes, $temp = $null)
                    $inflight.Phase = $phase
                    $inflight.BytesDone = [long]$bytes
                    if ($temp) { $inflight.TempPath = $temp }
                }.GetNewClosure()
                try {
                    # Metadata (Created/Modified/Author/Editor) lands on the
                    # blob atomically at upload commit - no separate restamp
                    # step the way SharePoint needs Set-PnPListItem after the
                    # copy (arguably stronger: no window where the copy exists
                    # without its original metadata).
                    $meta = if ($null -ne $SourceMetaMap) { $SourceMetaMap[$relKey] } else { $null }
                    $metadata = @{}
                    if ($meta) {
                        if ($meta.Created) { $metadata['created'] = ([datetime]$meta.Created).ToString('o') }
                        if ($meta.Modified) { $metadata['modified'] = ([datetime]$meta.Modified).ToString('o') }
                        if ($meta.AuthorEmail) { $metadata['author'] = $meta.AuthorEmail }
                        if ($meta.EditorEmail) { $metadata['editor'] = $meta.EditorEmail }
                    }

                    Invoke-WithRetry -MaxAttempts 5 -Action {
                        Save-BlobFromSharePointFile -SourceConnection $laneSourceConn -SourceServerRelativeUrl $sourceFileServerRel `
                            -BlobEndpoint $BlobEndpoint -Container $Container -Sas $Sas -BlobKey $blobKey -Metadata $metadata -OnProgress $blobProgress | Out-Null
                    } -OnRetry {
                        param($attempt, $waitMs, $reason, $statusCode, $message)
                        $script:attemptsUsed = $attempt
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_retry' -Data @{
                            sourcePath = $sourceFileServerRel; targetPath = $targetDisplayPath
                            attempt    = $attempt; reason = $reason; waitMs = $waitMs; httpStatus = $statusCode
                        }))
                    }

                    $sw.Stop()
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_success' -Data @{
                        sourcePath = $sourceFileServerRel; targetPath = $targetDisplayPath
                        bytes      = [long]$item.Size; durationMs = [int]$sw.ElapsedMilliseconds; httpStatus = 200
                    }))
                } catch {
                    $sw.Stop()
                    $statusCode = Get-HttpStatusCode -Exception $_.Exception
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_failed' -Data @{
                        sourcePath = $sourceFileServerRel; targetPath = $targetDisplayPath
                        error      = $_.Exception.Message; httpStatus = $statusCode; retryCount = $script:attemptsUsed
                    }))
                } finally {
                    $null = $Shared.InFlight.Remove($LaneIndex)
                }
            }

            $ctrl = Read-Control -Path $ControlFilePath
            if ($ctrl.cancelRequested) { $Shared.Cancelled = $true; $Shared.Stop = $true; break }
            if ($ctrl.pauseRequested) { $Shared.Paused = $true; $Shared.Stop = $true; break }
        }

        try { Disconnect-PnPOnline -Connection $laneSourceConn } catch {}
    }

    # Filesystem-source lane: reads each file from the share and uploads it
    # with Add-PnPFile (PnP chunks large uploads internally - there is no
    # server-side copy from a file share the way Copy-PnPFile works for
    # SharePoint-to-SharePoint). No source connection at all; only the target
    # PnP connection. Pushes the identical NDJSON event shapes onto the same
    # $resultQueue as the other lanes, so the drain loop, checkpointing and
    # adaptive concurrency work unchanged.
    $laneScriptFileUpload = {
        param($LaneIndex, $WorkQueue, $ResultQueue, $Shared, $TargetSiteUrl, $ClientId, $TenantId,
              $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath,
              $TargetSiteServerRelative, $TargetRoot, $TargetFileMap)

        Import-Module PnP.PowerShell -ErrorAction Stop
        # NO -Force - same in-process clobbering hazard as the other lanes.
        Import-Module "$using:PSScriptRoot/lib/Events.psm1"
        Import-Module "$using:PSScriptRoot/lib/Retry.psm1"
        Import-Module "$using:PSScriptRoot/lib/Verification.psm1"

        function local:Read-Control {
            param([string]$Path)
            try {
                return (Get-Content -Path $Path -Raw -ErrorAction Stop | ConvertFrom-Json)
            } catch {
                return [pscustomobject]@{ pauseRequested = $false; cancelRequested = $false }
            }
        }

        $certArgs = if ($CertificateBase64Encoded) {
            @{ CertificateBase64Encoded = $CertificateBase64Encoded; CertificatePassword = (ConvertTo-SecureString -String $CertificatePassword -AsPlainText -Force) }
        } else {
            @{ Thumbprint = $CertThumbprint }
        }
        $laneTargetConn = Connect-PnPOnline -Url $TargetSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection

        # Target library list, resolved once per lane - used to stamp the
        # original filesystem timestamps onto each uploaded file.
        $laneTargetList = $null
        try { $laneTargetList = Get-PnPList -Identity (($TargetRoot -split '/')[0]) -Connection $laneTargetConn -ErrorAction Stop } catch {}

        while (-not $Shared.Stop) {
            if ($LaneIndex -ge $Shared.TargetLaneCount) { break }

            $item = $null
            if (-not $WorkQueue.TryDequeue([ref]$item)) { break }

            $relFromRoot = $item.RelativeFromRoot
            $sourceFilePath = Join-Path $item.SourceFolder $item.Name
            $targetFolderSiteRel = "$TargetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
            $targetFolderServerRel = "$TargetSiteServerRelative/$targetFolderSiteRel".TrimEnd('/').Replace('//', '/')
            $targetFileServerRel = "$targetFolderServerRel/$($item.TargetName)"

            $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_start' -Data @{
                sourcePath = $sourceFilePath; targetPath = $targetFileServerRel; itemType = 'file'; bytes = [long]$item.Size
            }))
            if ($item.Renamed) {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                    level = 'warn'; message = "'$($item.Name)' is not a legal SharePoint name - uploading as '$($item.TargetName)'."
                }))
            }

            # Skip/delta check: prefer the prefetched target index (memory
            # lookup, zero network) - same rule as the other lanes: same size
            # AND target at least as new as the source.
            $relKey = if ($relFromRoot) { "$relFromRoot/$($item.TargetName)" } else { $item.TargetName }
            if ($null -ne $TargetFileMap) {
                $existing = $TargetFileMap[$relKey]
                $alreadyDone = $existing -and
                    ([long]$existing.Size -eq [long]$item.Size) -and
                    (-not $item.Modified -or -not $existing.Modified -or $existing.Modified -ge [datetime]$item.Modified)
            } else {
                $alreadyDone = Test-PnPTargetFileMatches -Connection $laneTargetConn -TargetServerRelativeUrl $targetFileServerRel -ExpectedSize $item.Size -SourceModified $item.Modified
            }
            if ($alreadyDone) {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_skipped' -Data @{
                    sourcePath = $sourceFilePath; targetPath = $targetFileServerRel; bytes = [long]$item.Size
                    reason     = 'target already has a file of the same name and size'
                }))
            } else {
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $script:attemptsUsed = 0
                try {
                    Invoke-WithRetry -MaxAttempts 5 -Action {
                        # Stream opened INSIDE the retried action so every
                        # attempt reads from position 0 - reusing one stream
                        # across attempts would upload a truncated tail.
                        # ProgressReadStream counts consumed bytes so the main
                        # thread can report live progress on long uploads;
                        # re-registering per attempt resets the bar on retry.
                        $fileStream = [MigrationEngine.ProgressReadStream]::new([System.IO.File]::OpenRead($sourceFilePath))
                        $Shared.InFlight[$LaneIndex] = @{
                            SourcePath = $sourceFilePath; TargetPath = $targetFileServerRel
                            Total = [long]$item.Size; Stream = $fileStream
                        }
                        try {
                            # Out-Null: Add-PnPFile returns the file object on
                            # stdout, which is reserved for NDJSON events.
                            Add-PnPFile -FileName $item.TargetName -Folder $targetFolderSiteRel -Stream $fileStream -Connection $laneTargetConn -ErrorAction Stop | Out-Null
                        } finally {
                            $fileStream.Dispose()
                        }
                    } -OnRetry {
                        param($attempt, $waitMs, $reason, $statusCode, $message)
                        $script:attemptsUsed = $attempt
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_retry' -Data @{
                            sourcePath = $sourceFilePath; targetPath = $targetFileServerRel
                            attempt    = $attempt; reason = $reason; waitMs = $waitMs; httpStatus = $statusCode
                        }))
                    }
                    # Preserve the original filesystem timestamps on the copy.
                    # Add-PnPFile stamps upload-time/app identity; compliance
                    # needs the real Created/Modified dates. There is no
                    # meaningful Author/Editor on a file share (the NTFS owner
                    # is frequently a SID or an admin group after years of
                    # churn), so people fields are deliberately left alone.
                    # Failure here never fails the item - the content upload
                    # already succeeded - it just logs a warning.
                    try {
                        $values = @{}
                        if ($item.Created) { $values['Created'] = [datetime]$item.Created }
                        if ($item.Modified) { $values['Modified'] = [datetime]$item.Modified }
                        if ($laneTargetList -and $values.Count -gt 0) {
                            $tgtItem = Get-PnPFile -Url $targetFileServerRel -AsListItem -Connection $laneTargetConn -ErrorAction Stop
                            Set-PnPListItem -List $laneTargetList -Identity $tgtItem.Id -Values $values -Connection $laneTargetConn -ErrorAction Stop | Out-Null
                        }
                    } catch {
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                            level = 'warn'; message = "Copied OK but could not preserve original timestamps for '$targetFileServerRel': $($_.Exception.Message)"
                        }))
                    }

                    $sw.Stop()
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_success' -Data @{
                        sourcePath = $sourceFilePath; targetPath = $targetFileServerRel
                        bytes      = [long]$item.Size; durationMs = [int]$sw.ElapsedMilliseconds; httpStatus = 200
                    }))
                } catch {
                    $sw.Stop()
                    # Add-PnPFile can throw AFTER the upload has committed
                    # (observed live: parallel cold-start uploads reporting
                    # "Cannot access a closed file" while the file verified
                    # present and hash-identical). Check the actual target
                    # state before declaring failure - a file that landed is
                    # a success with a footnote, not a failure that
                    # verification later has to contradict.
                    $landedAnyway = $false
                    try {
                        $landedAnyway = Test-PnPTargetFileMatches -Connection $laneTargetConn -TargetServerRelativeUrl $targetFileServerRel -ExpectedSize $item.Size -SourceModified $item.Modified
                    } catch {}
                    if ($landedAnyway) {
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                            level = 'warn'; message = "Upload of '$($item.TargetName)' reported an error after committing ($($_.Exception.Message)) - the file is present at the correct size and counts as copied; verification will hash-check it like every other file."
                        }))
                        # The in-cmdlet failure skipped the timestamp stamp -
                        # do it here so this path matches a clean success.
                        try {
                            $values = @{}
                            if ($item.Created) { $values['Created'] = [datetime]$item.Created }
                            if ($item.Modified) { $values['Modified'] = [datetime]$item.Modified }
                            if ($laneTargetList -and $values.Count -gt 0) {
                                $tgtItem = Get-PnPFile -Url $targetFileServerRel -AsListItem -Connection $laneTargetConn -ErrorAction Stop
                                Set-PnPListItem -List $laneTargetList -Identity $tgtItem.Id -Values $values -Connection $laneTargetConn -ErrorAction Stop | Out-Null
                            }
                        } catch {}
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_success' -Data @{
                            sourcePath = $sourceFilePath; targetPath = $targetFileServerRel
                            bytes      = [long]$item.Size; durationMs = [int]$sw.ElapsedMilliseconds; httpStatus = 200
                        }))
                    } else {
                        $statusCode = Get-HttpStatusCode -Exception $_.Exception
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_failed' -Data @{
                            sourcePath = $sourceFilePath; targetPath = $targetFileServerRel
                            error      = $_.Exception.Message; httpStatus = $statusCode; retryCount = $script:attemptsUsed
                        }))
                    }
                } finally {
                    $null = $Shared.InFlight.Remove($LaneIndex)
                }
            }

            $ctrl = Read-Control -Path $ControlFilePath
            if ($ctrl.cancelRequested) { $Shared.Cancelled = $true; $Shared.Stop = $true; break }
            if ($ctrl.pauseRequested) { $Shared.Paused = $true; $Shared.Stop = $true; break }
        }

        try { Disconnect-PnPOnline -Connection $laneTargetConn } catch {}
    }

    $lanes = @()
    for ($i = 0; $i -lt $Concurrency; $i++) {
        if ($isFsSource) {
            $lanes += Start-ThreadJob -ScriptBlock $laneScriptFileUpload -ArgumentList @(
                $i, $workQueue, $resultQueue, $shared, $effTargetSite, $ClientId, $TenantId,
                $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath,
                $targetSiteServerRelative, $targetRoot, $targetFileMap
            )
        } elseif ($isBlobTarget) {
            $lanes += Start-ThreadJob -ScriptBlock $laneScriptBlob -ArgumentList @(
                $i, $workQueue, $resultQueue, $shared, $SourceSiteUrl, $ClientId, $TenantId,
                $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath, $sourceSiteServerRelative, $sourceRoot,
                $blobCtx.BlobEndpoint, $blobCtx.Container, $blobCtx.Sas, $blobCtx.Prefix, $targetFileMap, $sourceMetaMap
            )
        } else {
            $lanes += Start-ThreadJob -ScriptBlock $laneScriptSharePoint -ArgumentList @(
                $i, $workQueue, $resultQueue, $shared, $SourceSiteUrl, $TargetSiteUrl, $ClientId, $TenantId,
                $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath, $sourceSiteServerRelative, $targetSiteServerRelative,
                $sourceRoot, $targetRoot, $sameSite, $targetFileMap, $sourceMetaMap
            )
        }
    }

    $itemsDone = 0; $bytesDone = 0; $itemsFailed = 0; $itemsSkipped = 0
    $lastCheckpointAt = Get-Date
    $lastProgressAt = Get-Date
    $lastCompletedPath = $null

    # Lanes start in state NotStarted and only later transition to Running -
    # checking for Running alone races lane spin-up: the loop can see zero
    # "running" lanes immediately after Start-ThreadJob, exit at once, and
    # leave every event the lanes later enqueue undrained (the job then
    # reports "completed, 0 items" while Wait-Job silently does the work).
    $laneActive = { ($lanes | Where-Object { $_.State -in @('NotStarted', 'Running') }).Count -gt 0 }
    while ((& $laneActive) -or $resultQueue.Count -gt 0) {
        $line = $null
        $drained = 0
        while ($drained -lt 500 -and $resultQueue.TryDequeue([ref]$line)) {
            [Console]::Out.WriteLine($line)
            $drained++
            try {
                $parsed = $line | ConvertFrom-Json
                switch ($parsed.type) {
                    'item_success' { $itemsDone++; $bytesDone += [long]$parsed.bytes; $lastCompletedPath = $parsed.sourcePath }
                    'item_skipped' { $itemsSkipped++; $lastCompletedPath = $parsed.sourcePath }
                    'item_failed' { $itemsFailed++ }
                }
            } catch {}
        }
        [Console]::Out.Flush()

        $ctrl = Read-ControlFile -Path $ControlFilePath
        if ($ctrl.concurrencyOverride -and $ctrl.concurrencyOverride -lt $shared.TargetLaneCount) {
            $shared.TargetLaneCount = [Math]::Max(1, [int]$ctrl.concurrencyOverride)
        }

        if (((Get-Date) - $lastCheckpointAt).TotalSeconds -ge 3) {
            Write-EngineEvent -Type 'checkpoint' -Data @{
                lastCompletedPath = $lastCompletedPath; itemsDone = $itemsDone + $itemsSkipped; bytesDone = $bytesDone
            }
            $lastCheckpointAt = Get-Date
        }

        # Live per-file progress for transfers still in flight (every lane
        # type registers in $shared.InFlight). Small files finish between
        # ticks and never appear - only transfers long enough to need a
        # progress row produce events. Heartbeat like phase_progress:
        # broadcast to the UI, never written to the audit log.
        # Progress source varies by lane:
        #  - fs upload:  Stream.BytesConsumed (byte-counting wrapper)
        #  - blob:       TempPath file size while downloading, then BytesDone
        #                updated per uploaded block
        #  - SP-to-SP:   none - Copy-PnPFile is a server-side copy, no bytes
        #                pass through the engine; bytesDone stays null and the
        #                UI shows an indeterminate "copying" row instead.
        if (((Get-Date) - $lastProgressAt).TotalSeconds -ge 2.5) {
            foreach ($laneIdx in @($shared.InFlight.Keys)) {
                try {
                    $inf = $shared.InFlight[$laneIdx]
                    if (-not $inf) { continue }
                    $phase = $inf.Phase ?? 'uploading'
                    $done = $null
                    if ($inf.Stream) {
                        $done = [long]$inf.Stream.BytesConsumed
                    } elseif ($phase -eq 'downloading' -and $inf.TempPath) {
                        try { $done = [long][System.IO.FileInfo]::new($inf.TempPath).Length } catch { $done = [long]0 }
                    } elseif ($phase -ne 'copying') {
                        $done = [long]$inf.BytesDone
                    }
                    Write-EngineEvent -Type 'item_progress' -Data @{
                        lane       = [int]$laneIdx
                        sourcePath = $inf.SourcePath
                        targetPath = $inf.TargetPath
                        phase      = $phase
                        bytesDone  = $done
                        bytesTotal = [long]$inf.Total
                    }
                } catch {
                    # Entry vanished between snapshot and read - the transfer
                    # just finished; its item_success is already on the queue.
                }
            }
            $lastProgressAt = Get-Date
        }

        if (& $laneActive) { Start-Sleep -Milliseconds 200 }
    }

    $lanes | Wait-Job | Out-Null

    # Final drain: events enqueued between the loop's last drain and lane
    # termination would otherwise be lost.
    $line = $null
    while ($resultQueue.TryDequeue([ref]$line)) {
        [Console]::Out.WriteLine($line)
        try {
            $parsed = $line | ConvertFrom-Json
            switch ($parsed.type) {
                'item_success' { $itemsDone++; $bytesDone += [long]$parsed.bytes; $lastCompletedPath = $parsed.sourcePath }
                'item_skipped' { $itemsSkipped++; $lastCompletedPath = $parsed.sourcePath }
                'item_failed' { $itemsFailed++ }
            }
        } catch {}
    }
    [Console]::Out.Flush()

    # Surface lane-level crashes (connection failures, module import errors,
    # anything thrown outside the per-item try/catch). Without this the lane
    # output streams are discarded and a dead lane looks like a clean finish.
    foreach ($lane in $lanes) {
        $laneErrors = @($lane.ChildJobs | ForEach-Object { $_.Error }) + @(Receive-Job -Job $lane -ErrorAction SilentlyContinue 2>&1 | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] })
        foreach ($e in ($laneErrors | Where-Object { $_ })) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "Worker lane error: $($e.Exception.Message)" }
        }
    }
    $lanes | Remove-Job -Force

    $finalCheckpoint = @{ lastCompletedPath = $lastCompletedPath; itemsDone = $itemsDone + $itemsSkipped; bytesDone = $bytesDone }

    # Circuit breaker: N items in, zero results out means the lanes silently
    # broke (observed live: a module-scope corruption left every lane unable
    # to call Invoke-WithRetry - 3,904 item_start events, then nothing).
    # Without this guard the run would sail into verification, find every
    # file "missing", and attempt a pointless full re-copy - fail loudly and
    # immediately instead.
    if (-not $shared.Cancelled -and -not $shared.Paused -and $totalItems -gt 0 -and ($itemsDone + $itemsSkipped + $itemsFailed) -eq 0) {
        Write-EngineEvent -Type 'job_failed' -Data @{
            error = "Copy phase processed $totalItems item(s) but produced zero successes, skips or failures - the worker lanes broke silently (check for 'Worker lane error' lines above). Nothing was copied; fix the cause and run again."
        }
        exit 1
    }

    if ($shared.Cancelled) {
        Write-EngineEvent -Type 'job_cancelled' -Data @{ itemsDone = $itemsDone; bytesDone = $bytesDone }
    } elseif ($shared.Paused) {
        Write-EngineEvent -Type 'paused' -Data @{ checkpoint = $finalCheckpoint }
    } else {
        # --- Post-migration verification + automatic repair ----------------
        # Full source<->target comparison (Graph metadata for both sides on
        # a SharePoint target; Graph source + blob-list target on an
        # azure_blob target - see Invoke-VerificationPhase). A verification
        # failure never fails the job, but real problems (missing / size /
        # hash mismatches on non-Office files) get one automatic sequential
        # re-copy pass, followed by a second verification. Reuses the same
        # $verifyArgs and connections built earlier (before the VerifyOnly
        # early-exit) - safe even after the lanes have run for hours, since
        # certificate-based connections (the only kind now) self-refresh.
        $verifyOut = Invoke-VerificationPhase @verifyArgs
        $verification = $verifyOut?.Summary

        if ($verifyOut -and -not $verifyOut.Summary.ok) {
            $problemPaths = @($verifyOut.Result.Missing) + @($verifyOut.Result.SizeMismatch) + @($verifyOut.Result.HashMismatch)
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Attempting automatic re-copy of $($problemPaths.Count) file(s) that failed verification..." }
            $recopied = 0
            foreach ($rel in $problemPaths) {
                # Filesystem-source map keys are built from the SANITIZED
                # (SharePoint-legal) names, so match on TargetName there.
                $file = $tree.Files | Where-Object {
                    $leaf = $isFsSource ? $_.TargetName : $_.Name
                    (($_.RelativeFromRoot ? "$($_.RelativeFromRoot)/$leaf" : $leaf)) -eq $rel
                } | Select-Object -First 1
                if (-not $file) {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Re-copy skipped for '$rel': not found in this run's source enumeration (added after enumeration?)." }
                    continue
                }
                $relFromRoot = $file.RelativeFromRoot
                $srcRel = if ($isFsSource) {
                    Join-Path $file.SourceFolder $file.Name
                } else {
                    "$sourceSiteServerRelative/$sourceRoot/$relFromRoot/$($file.Name)".Replace('//', '/')
                }
                try {
                    Invoke-WithRetry -MaxAttempts 3 -Action {
                        if ($isFsSource) {
                            $tgtFolderSiteRel = "$targetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
                            $repairStream = [System.IO.File]::OpenRead($srcRel)
                            try {
                                Add-PnPFile -FileName $file.TargetName -Folder $tgtFolderSiteRel -Stream $repairStream -Connection $targetConn -ErrorAction Stop | Out-Null
                            } finally {
                                $repairStream.Dispose()
                            }
                        } elseif ($isBlobTarget) {
                            $blobKey = Get-BlobKey -Segments @($blobCtx.Prefix, $relFromRoot, $file.Name)
                            Save-BlobFromSharePointFile -SourceConnection $sourceConn -SourceServerRelativeUrl $srcRel `
                                -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas -BlobKey $blobKey | Out-Null
                        } else {
                            $tgtFolderRel = "$targetSiteServerRelative/$targetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
                            Copy-PnPFile -SourceUrl $srcRel -TargetUrl $tgtFolderRel -Force -OverwriteIfAlreadyExists -Connection $sourceConn -ErrorAction Stop
                        }
                    }
                    $recopied++
                    # A real item_success (not just a log line) so Node moves
                    # the item from failed to done - a file repaired here
                    # synced in the end and must not be reported as a failure.
                    Write-EngineEvent -Type 'item_success' -Data @{
                        sourcePath = $srcRel; targetPath = ''; itemType = 'file'
                        bytes = [long]$file.Size; durationMs = 0; httpStatus = 200
                    }
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Re-copied after verification failure: $rel" }
                } catch {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "Re-copy FAILED for '$rel': $($_.Exception.Message)" }
                }
            }
            if ($recopied -gt 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Re-copied $recopied file(s) - running verification again..." }
                $verifyOut = Invoke-VerificationPhase @verifyArgs
                if ($verifyOut) { $verification = $verifyOut.Summary }
            }
        }

        Write-EngineEvent -Type 'job_completed' -Data @{
            summary = @{ itemsDone = $itemsDone; itemsSkipped = $itemsSkipped; itemsFailed = $itemsFailed; bytesDone = $bytesDone; verification = $verification }
        }
    }
}
catch {
    $jobFailed = $true
    Write-EngineEvent -Type 'job_failed' -Data @{ error = $_.Exception.Message }
}
finally {
    try { Disconnect-PnPOnline -ErrorAction SilentlyContinue } catch {}
}

if ($jobFailed) { exit 1 } else { exit 0 }
