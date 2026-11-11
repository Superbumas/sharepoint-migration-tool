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
    # 'onedrive' writes into a specific named user's OneDrive instead (see
    # engine/lib/OneDriveTarget.psm1).
    [ValidateSet('sharepoint', 'azure_blob', 'onedrive')][string]$TargetProvider = 'sharepoint',
    [string]$TargetSiteUrl,
    [string]$TargetLibrary,
    # No longer [Parameter(Mandatory)]: azure_blob/onedrive jobs never pass
    # this - TargetBlobPrefix/TargetOneDrivePath are the equivalent fields
    # for those destinations. Every sharepoint-provider job still gets it
    # from the orchestrator exactly as before, so this relaxation changes
    # nothing for the existing path.
    [AllowEmptyString()][string]$TargetPath = '',
    [string]$TargetContainer,
    [string]$TargetBlobPrefix,
    # onedrive-target only: the destination user's UPN, and the folder
    # (drive-relative) their migrated content is placed under. HostUrl is a
    # real, connectable SharePoint URL for the user's OneDrive host (e.g.
    # https://contoso-my.sharepoint.com), derived server-side from Graph's
    # /users/{upn}/drive response at mapping-save time - PnP.PowerShell's
    # Connect-PnPOnline needs SOME site URL to establish a connection (and
    # with it, a cached Graph-audience token) even though the actual
    # read/write traffic goes through Graph, never that site's own CSOM/REST
    # surface. Only used when there is no other SharePoint connection already
    # open in this job (a filesystem source) - see the connection setup below.
    [string]$TargetOneDriveUpn,
    [AllowEmptyString()][string]$TargetOneDrivePath = '',
    [string]$TargetOneDriveHostUrl,
    # onedrive-target only: upload chunk size in MiB for each createUploadSession
    # PUT (engine/lib/OneDriveTarget.psm1's Send-GraphDriveFile) - a bigger
    # chunk means fewer round trips per file, set server-side via
    # ONEDRIVE_UPLOAD_CHUNK_SIZE_MB (server/config.js clamps it to a valid
    # Graph chunk size before it ever reaches here). Ignored by every other
    # target.
    [int]$OneDriveChunkSizeMB = 5,
    # A filesystem source's verification hashing (Get-FileSystemFileMap)
    # deliberately runs at its OWN concurrency, not -Concurrency - that one
    # bounds Graph API calls (real throttling limits to respect), while
    # hashing is pure local/LAN file reads with no Graph traffic at all and
    # was observed live to be bound by per-file SMB open latency, not
    # bandwidth or CPU. Set via FS_SOURCE_HASH_CONCURRENCY (server/config.js).
    [int]$FsHashConcurrency = 16,
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
    # Content-check results (ContentCheck.psm1), keyed per file by path and
    # both hashes. Named by source+target location on the server side, so
    # it carries over between runs, re-created jobs and Verify clicks.
    [string]$ContentCachePath,
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
    # Targeted repair ("Repair N files" on the job page): re-copy only the
    # files the last verification flagged (read from -RepairFromPath, that
    # verification's summary JSON), restore their original dates/people,
    # re-check only those files, and emit the merged verification summary.
    # No enumeration, pre-flight, folder pass or full index. Like -VerifyOnly
    # it never emits job_* lifecycle events.
    [switch]$RepairOnly,
    [string]$RepairFromPath,
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
    [switch]$PurgeRecycleBin,
    # Pre-flight-only mode: connects, scans the source tree and runs the
    # content checks (target path length, file size, unique permissions -
    # see engine/lib/Preflight.psm1), emits one preflight_report event and
    # exits without creating or copying anything. Like -VerifyOnly it never
    # emits job_* lifecycle events. The scan is still written to
    # -TreeCachePath, so starting the job right after reuses it.
    [switch]$PreflightOnly,
    # "Who had access" export: during the pre-flight, the grants of every
    # item with its own permissions are read (Graph driveItem permissions,
    # read-only) and written to this JSON file for the job page's CSV export
    # and the reports. Empty = not collected.
    [string]$AccessReportPath,
    # "Copy item permissions": a JSON file with the job's permission settings
    # ({ includeGuests, userMap: { sourceUpn: targetUpn } }). When given, a
    # copy run re-applies the recorded grants to the target items at the end
    # (engine/lib/Permissions.psm1). -PermissionsOnly does just that step
    # (connect, apply, exit) for a job that has already been copied.
    [string]$CopyPermissionsPath,
    [switch]$PermissionsOnly,
    # How a SharePoint source is enumerated: 'auto' (default) picks Graph
    # delta or the folder-by-folder walk per Select-SharePointScanMethod;
    # 'delta' / 'folders' force one - for troubleshooting a scan, or to
    # compare the two on a real library.
    [ValidateSet('auto', 'delta', 'folders')][string]$SourceScanMethod = 'auto'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The server reads engine events as UTF-8 NDJSON. On Windows, pwsh otherwise
# writes stdout in the console code page, which folded or mangled non-ASCII
# file names in the audit log, reports and exports ("Žalgiris café" stored as
# "Zalgiris caf?"). The file names on SharePoint were never affected.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Source "last modified" comes from the file (TimeLastModified) while the
# date the engine stamps on the target comes from the list item (Modified);
# SharePoint can keep those a second or so apart, which made the stamped
# copy look older than its source and re-copied the file on every run.
# Anything within 5 seconds counts as the same moment (literal AddSeconds(5)
# in each skip check - the lanes run in separate runspaces).
Import-Module "$PSScriptRoot/lib/Events.psm1" -Force
Import-Module "$PSScriptRoot/lib/Retry.psm1" -Force
Import-Module "$PSScriptRoot/lib/Verification.psm1" -Force
Import-Module "$PSScriptRoot/lib/ContentCheck.psm1" -Force
Import-Module "$PSScriptRoot/lib/SharePointTree.psm1" -Force
Import-Module "$PSScriptRoot/lib/BlobTarget.psm1" -Force
Import-Module "$PSScriptRoot/lib/OneDriveTarget.psm1" -Force
Import-Module "$PSScriptRoot/lib/FileSystemSource.psm1" -Force
Import-Module "$PSScriptRoot/lib/UserAgent.psm1" -Force
Import-Module "$PSScriptRoot/lib/Preflight.psm1" -Force
Import-Module "$PSScriptRoot/lib/Permissions.psm1" -Force
# Before PnP.PowerShell loads: decorates every request this process sends
# (see engine/lib/UserAgent.psm1).
Initialize-MigrationUserAgent
Import-Module PnP.PowerShell -ErrorAction Stop
Import-Module Microsoft.PowerShell.ThreadJob -ErrorAction SilentlyContinue

function Join-UrlSegments {
    param([string[]]$Segments)
    ($Segments | Where-Object { $_ } | ForEach-Object { $_.Trim('/') } | Where-Object { $_ }) -join '/'
}

# Copy-PnPFile runs on the SOURCE connection and resolves a server-relative
# -TargetUrl against the source's own host. That is fine when both sites
# share a host, but a OneDrive source lives on <tenant>-my.sharepoint.com
# while the target is on <tenant>.sharepoint.com, so the copy was aimed at a
# path that doesn't exist on the -my host ("Cannot contact site at the
# specified URL"). Returns the scheme+host to prefix onto server-relative
# target URLs when the hosts differ, or '' when they match (unchanged
# behaviour for same-host copies).
function Get-CrossHostTargetPrefix {
    param([string]$SourceSiteUrl, [string]$TargetSiteUrl)
    if (-not $SourceSiteUrl -or -not $TargetSiteUrl) { return '' }
    $src = [Uri]$SourceSiteUrl
    $tgt = [Uri]$TargetSiteUrl
    if ($src.Authority -ieq $tgt.Authority) { return '' }
    return "$($tgt.Scheme)://$($tgt.Authority)"
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
        [hashtable]$BlobCtx,
        # onedrive-target only: @{ Connection; DriveId; PathRoot }
        [hashtable]$OneDriveCtx,
        # Passed straight through to Get-FileSystemFileMap's -ThrottleLimit
        # for a filesystem source's hashing lanes - deliberately its own
        # setting, not the job's Graph-bound copy concurrency (see
        # -FsHashConcurrency's own doc comment on the main param block).
        [int]$FsHashConcurrency = 16
    )
    try {
        $isBlob = $TargetProvider -eq 'azure_blob'
        $isOneDrive = $TargetProvider -eq 'onedrive'
        $isFsSource = $SourceProvider -eq 'filesystem'
        $hashLabel = if ($isBlob) { 'MD5' } else { 'QuickXorHash' }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Verifying migration: comparing existence, size and content hash ($hashLabel) of every source file against its copy..." }
        # Listing both trees can take minutes on a big library: heartbeat the
        # job page's progress card on every Graph page, and put a line in the
        # live log at most every 15 s so the log doesn't look frozen.
        $vProgress = @{ LogAt = (Get-Date) }
        $idxSrc = {
            param($count)
            Write-PhaseProgress -Phase 'indexing_source' -Data @{ files = $count }
            if (((Get-Date) - $vProgress.LogAt).TotalSeconds -ge 15) { $vProgress.LogAt = Get-Date; Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Verify: listed $count source file(s) so far..." } }
        }
        $idxTgt = {
            param($count)
            Write-PhaseProgress -Phase 'indexing_target' -Data @{ files = $count }
            if (((Get-Date) - $vProgress.LogAt).TotalSeconds -ge 15) { $vProgress.LogAt = Get-Date; Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Verify: listed $count migrated file(s) at the target so far..." } }
        }
        $result = if ($isOneDrive) {
            # Both sides come from Graph (Get-GraphFileMap), so this is the
            # same generic hash-based comparator every SharePoint target
            # verification already uses - only the two map RESOLUTIONS differ
            # (source: filesystem hash walk or the source drive; target:
            # OneDriveCtx's drive, resolved once at connection setup).
            $srcMap = if ($isFsSource) {
                Get-FileSystemFileMap -RootPath $SourcePathInLib -IncludeHash -ThrottleLimit $FsHashConcurrency -OnProgress {
                    param($count)
                    Write-PhaseProgress -Phase 'hashing_source' -Data @{ files = $count }
                }
            } else {
                $srcDriveId = Get-GraphDriveId -Connection $SourceConn -SiteUrl $SourceSite -Library $SourceLib
                Get-GraphFileMap -Connection $SourceConn -DriveId $srcDriveId -RootPath $SourcePathInLib -IncludeDownloadUrl -OnProgress $idxSrc
            }
            $tgtMap = Get-GraphFileMap -Connection $OneDriveCtx.Connection -DriveId $OneDriveCtx.DriveId -RootPath $OneDriveCtx.PathRoot -IncludeDownloadUrl -OnProgress $idxTgt
            Compare-MigratedFileMaps -SourceMap $srcMap -TargetMap $tgtMap
        } elseif ($isFsSource) {
            # Local QuickXorHash of every source file vs the hash SharePoint
            # computed server-side for the uploaded copy - reads every source
            # byte, which is exactly what makes this verification honest.
            $srcMap = Get-FileSystemFileMap -RootPath $SourcePathInLib -IncludeHash -ThrottleLimit $FsHashConcurrency -OnProgress {
                param($count)
                Write-PhaseProgress -Phase 'hashing_source' -Data @{ files = $count }
            }
            $tgtDriveId = Get-GraphDriveId -Connection $TargetConn -SiteUrl $TargetSite -Library $TargetLib
            $tgtMap = Get-GraphFileMap -Connection $TargetConn -DriveId $tgtDriveId -RootPath $TargetPathInLib -IncludeDownloadUrl -OnProgress $idxTgt
            Compare-MigratedFileMaps -SourceMap $srcMap -TargetMap $tgtMap
        } elseif ($isBlob) {
            $srcDriveId = Get-GraphDriveId -Connection $SourceConn -SiteUrl $SourceSite -Library $SourceLib
            $srcMap = Get-GraphFileMap -Connection $SourceConn -DriveId $srcDriveId -RootPath $SourcePathInLib -OnProgress $idxSrc
            $tgtMap = Get-BlobKeyMap -BlobEndpoint $BlobCtx.BlobEndpoint -Container $BlobCtx.Container -Sas $BlobCtx.Sas -Prefix $BlobCtx.Prefix
            Compare-BlobMigratedTree -SourceMap $srcMap -TargetMap $tgtMap
        } else {
            # Same as Compare-PnPMigratedTrees, with the maps kept (and
            # download links included) for the rewritten-file content check.
            $srcDriveId = Get-GraphDriveId -Connection $SourceConn -SiteUrl $SourceSite -Library $SourceLib
            $tgtDriveId = Get-GraphDriveId -Connection $TargetConn -SiteUrl $TargetSite -Library $TargetLib
            $srcMap = Get-GraphFileMap -Connection $SourceConn -DriveId $srcDriveId -RootPath $SourcePathInLib -IncludeDownloadUrl -OnProgress $idxSrc
            $tgtMap = Get-GraphFileMap -Connection $TargetConn -DriveId $tgtDriveId -RootPath $TargetPathInLib -IncludeDownloadUrl -OnProgress $idxTgt
            Compare-MigratedFileMaps -SourceMap $srcMap -TargetMap $tgtMap
        }

        # --- Content check of files SharePoint rewrote -------------------
        # Size/hash cannot vouch for these, so both copies are downloaded and
        # compared minus SharePoint's own property parts (ContentCheck.psm1).
        # A real difference becomes a hash mismatch (and so a repair re-copy);
        # anything that cannot be compared is counted as unchecked, never as
        # verified. Results are cached per (path, source hash, target hash)
        # so a re-run only checks files that changed.
        $contentVerified = [System.Collections.Generic.List[string]]::new()
        $contentUnchecked = [System.Collections.Generic.List[object]]::new()
        $contentDifferent = [System.Collections.Generic.List[object]]::new()
        if ($result.OfficeRewritten.Count -gt 0 -and $srcMap -and $tgtMap -and -not $isBlob) {
            $ccCachePath = if ($ContentCachePath) { $ContentCachePath } else { $null }
            $ccCache = @{}
            if ($ccCachePath -and (Test-Path $ccCachePath)) {
                try { (Get-Content $ccCachePath -Raw | ConvertFrom-Json -AsHashtable).GetEnumerator() | ForEach-Object { $ccCache[$_.Key] = $_.Value } } catch {}
            }
            $todo = [System.Collections.Generic.List[object]]::new()
            foreach ($rel in $result.OfficeRewritten) {
                $s = $srcMap[$rel]; $t = $tgtMap[$rel]
                $key = "$rel|$($s.Hash)|$($s.Size)|$($t.Hash)|$($t.Size)"
                if ($ccCache.ContainsKey($key) -and $s.Hash -and $t.Hash -and -not (Test-TransientContentResult $ccCache[$key])) {
                    $c = $ccCache[$key]
                    if ($c.Status -eq 'equivalent') { $contentVerified.Add($rel) }
                    elseif ($c.Status -eq 'different') { $contentDifferent.Add(@{ path = $rel; detail = $c.Detail }) }
                    else { $contentUnchecked.Add(@{ path = $rel; detail = $c.Detail }) }
                    continue
                }
                $srcFile = if ($isFsSource) { Join-Path $SourcePathInLib ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar) } else { $null }
                $todo.Add(@{ Rel = $rel; Key = $key; Ext = [System.IO.Path]::GetExtension($rel); Size = [long]$s.Size; SourceUrl = $s.DownloadUrl; SourceFile = $srcFile; TargetUrl = $t.DownloadUrl })
            }
            if ($todo.Count -gt 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Content check: comparing $($todo.Count) file(s) SharePoint rewrote (Office documents, web pages) part by part against their originals$(if ($ccCache.Count) { " ($($result.OfficeRewritten.Count - $todo.Count) unchanged since the last check)" })..." }
                $ccStart = Get-Date
                $ccTotal = $todo.Count
                [long]$ccTotalBytes = ($todo | Measure-Object -Property Size -Sum).Sum
                # Fresh download links for long checks (Graph's expire after
                # about an hour): re-list both sides with links included.
                $ccSrcLinks = if ($isFsSource) { $null } else { @{ Conn = $SourceConn; Drive = $srcDriveId; Root = $SourcePathInLib } }
                $ccTgtLinks = if ($isOneDrive) { @{ Conn = $OneDriveCtx.Connection; Drive = $OneDriveCtx.DriveId; Root = $OneDriveCtx.PathRoot } } else { @{ Conn = $TargetConn; Drive = $tgtDriveId; Root = $TargetPathInLib } }
                $ccRefresh = {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = 'Content check: refreshing download links (they expire after about an hour)...' }
                    $out = @{ Source = @{}; Target = @{} }
                    if ($ccSrcLinks) { $m = Get-GraphFileMap -Connection $ccSrcLinks.Conn -DriveId $ccSrcLinks.Drive -RootPath $ccSrcLinks.Root -IncludeDownloadUrl; foreach ($k in @($m.Keys)) { $out.Source[$k] = $m[$k].DownloadUrl } }
                    $m = Get-GraphFileMap -Connection $ccTgtLinks.Conn -DriveId $ccTgtLinks.Drive -RootPath $ccTgtLinks.Root -IncludeDownloadUrl; foreach ($k in @($m.Keys)) { $out.Target[$k] = $m[$k].DownloadUrl }
                    $out
                }
                # -Cache/-CachePath: results are saved as they arrive (every
                # 25), so a server restart mid-check keeps finished files.
                $ccLog = @{ At = (Get-Date) }
                $checked = Invoke-RewrittenContentCheck -Items $todo.ToArray() -RefreshLinks $ccRefresh -Cache $ccCache -CachePath $ccCachePath -OnProgress {
                    param($n, $bytes, $rel, $throttleWait, $current, $currentBytes, $throttle)
                    if ($throttleWait) { Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Content check: SharePoint is throttling - pausing about $($throttleWait)s, then carrying on (nothing is skipped)." } }
                    if ($throttle -and $throttle.Recovered) { Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Content check: SharePoint stopped throttling - back to full speed ($($throttle.Recovered) pause(s) so far, nothing skipped)." } }
                    Write-PhaseProgress -Phase 'content_check' -Data @{ done = $n; total = $ccTotal; bytesDone = $bytes; bytesTotal = $ccTotalBytes; last = $rel; current = $current; currentBytes = $currentBytes; throttled = [bool]($throttle -and $throttle.Active); throttleWait = $(if ($throttle) { $throttle.WaitLeft } else { 0 }); throttles = $(if ($throttle) { $throttle.Count } else { 0 }) }
                    if (((Get-Date) - $ccLog.At).TotalSeconds -ge 15) {
                        $ccLog.At = Get-Date
                        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Content check: $n of $ccTotal checked ($([Math]::Round($bytes / 1MB)) of $([Math]::Round($ccTotalBytes / 1MB)) MB)$(if ($current) { " · now: $(($current -split '/')[-1]) ($([Math]::Max(1, [Math]::Round($currentBytes / 1MB))) MB)" })$(if ($throttle -and $throttle.Active) { " · throttled by SharePoint, waiting ~$($throttle.WaitLeft)s" })" }
                    }
                }
                foreach ($c in $checked) {
                    if (-not (Test-TransientContentResult $c)) { $ccCache[$c.Key] = @{ Status = $c.Status; Detail = $c.Detail } }
                    if ($c.Status -eq 'equivalent') { $contentVerified.Add($c.Rel) }
                    elseif ($c.Status -eq 'different') { $contentDifferent.Add(@{ path = $c.Rel; detail = $c.Detail }) }
                    else { $contentUnchecked.Add(@{ path = $c.Rel; detail = $c.Detail }) }
                }
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Content check done in $([int]((Get-Date) - $ccStart).TotalSeconds)s: $($contentVerified.Count) identical in content, $($contentDifferent.Count) different, $($contentUnchecked.Count) could not be checked." }
                if ($ccCachePath) {
                    try { $ccCache | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $ccCachePath -Encoding utf8 } catch {}
                }
            }
            foreach ($d in $contentDifferent) {
                $result.HashMismatch.Add($d.path)
                Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "Content check: '$($d.path)' differs from the original - $($d.detail)" }
            }
            foreach ($u in ($contentUnchecked | Select-Object -First 50)) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Content check: '$($u.path)' could not be checked - $($u.detail)" }
            }
            # OfficeRewritten keeps only what was proven equivalent.
            $differentSet = [System.Collections.Generic.HashSet[string]]::new([string[]]@($contentDifferent | ForEach-Object { $_.path }))
            $kept = @($result.OfficeRewritten | Where-Object { -not $differentSet.Contains($_) })
            $result.OfficeRewritten.Clear(); foreach ($k in $kept) { $result.OfficeRewritten.Add($k) }
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

        $problems = $result.Missing.Count + $result.SizeMismatch.Count + $result.HashMismatch.Count
        # The problem paths travel INSIDE the summary (capped), not just as
        # log lines: the summary is what Node persists to verification_json
        # and what job_completed carries, so the UI can show a durable
        # failed-files list. The verify_mismatch log lines above are capped
        # at 50 and scroll away with the live log.
        $maxReportedProblems = 200
        $problemList = @(
            @($result.Missing | ForEach-Object { @{ path = $_; reason = 'missing' } }) +
            @($result.SizeMismatch | ForEach-Object { @{ path = $_; reason = 'size' } }) +
            @($result.HashMismatch | ForEach-Object { @{ path = $_; reason = 'hash' } })
        ) | Select-Object -First $maxReportedProblems
        $summary = @{
            sourceFiles       = $result.SourceFiles
            targetFiles       = $result.TargetFiles
            identical         = $result.Identical
            missing           = $result.Missing.Count
            sizeMismatch      = $result.SizeMismatch.Count
            hashMismatch      = $result.HashMismatch.Count
            officeRewritten   = $result.OfficeRewritten.Count
            contentVerified   = $contentVerified.Count
            contentUnchecked  = $contentUnchecked.Count
            contentUncheckedList = @($contentUnchecked | Select-Object -First 200)
            hashUnavailable   = $result.HashUnavailable
            ok                = ($problems -eq 0)
            problems          = @($problemList)
            problemsTruncated = ($problems -gt $maxReportedProblems)
        }
        Write-EngineEvent -Type 'verification_summary' -Data @{ verification = $summary }
        $verdict = if ($problems -gt 0) { "FOUND $problems PROBLEM(S)" } elseif ($contentUnchecked.Count -gt 0) { "PASSED, BUT $($contentUnchecked.Count) FILE(S) NOT YET CONTENT-CHECKED (click Verify again to check only those)" } else { 'PASSED' }
        Write-EngineEvent -Type 'log' -Data @{ level = ($problems -eq 0 ? 'info' : 'error'); message = "Verification ${verdict}: $($result.Identical) of $($result.SourceFiles) files verified identical (hash), $($contentVerified.Count) re-stamped by SharePoint and verified identical in content, $($contentUnchecked.Count) re-stamped but not content-checked, $($result.Missing.Count) missing, $($result.SizeMismatch.Count) size / $($result.HashMismatch.Count) content mismatches." }
        return @{ Summary = $summary; Result = $result }
    } catch {
        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Verification could not run (copies are unaffected): $($_.Exception.Message)" }
        return $null
    }
}

$jobFailed = $false
try {
    $isBlobTarget = $TargetProvider -eq 'azure_blob'
    $isOneDriveTarget = $TargetProvider -eq 'onedrive'
    $isFsSource = $SourceProvider -eq 'filesystem'
    if ($isBlobTarget -and -not $BlobConnectionString) {
        throw 'Azure Blob archiving is not configured on this server (AZURE_BLOB_CONNECTION_STRING is empty). Set it and restart the server before running this job.'
    }
    if ($isFsSource -and $isBlobTarget) {
        throw 'A filesystem (file share) source can only migrate into SharePoint - archiving a file share to Azure Blob is not supported.'
    }
    if ($isOneDriveTarget -and -not $TargetOneDriveUpn) {
        throw 'TargetOneDriveUpn is required when TargetProvider is onedrive.'
    }
    if ($isOneDriveTarget -and $isFsSource -and -not $TargetOneDriveHostUrl) {
        throw 'TargetOneDriveHostUrl is required for a filesystem source migrating into OneDrive (there is no other SharePoint connection in this job to mint a Graph token from).'
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
        $sourceConn = Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent
    } else {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Source: file share '$SourcePath'" }
    }

    $targetConn = $null
    $blobCtx = $null
    # Bytes, rounded to a valid Graph upload-session chunk size (a multiple
    # of 320 KiB, capped at 60 MiB) - the server already clamps the .env
    # value before it gets here, but a manual invocation could pass anything.
    $oneDriveChunkSizeBytes = [Math]::Min(60MB, [Math]::Max(320KB,
        [Math]::Round(([long]$OneDriveChunkSizeMB * 1MB) / 320KB) * 320KB))

    $oneDriveCtx = $null
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
    } elseif ($isOneDriveTarget) {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Target: OneDrive for '$TargetOneDriveUpn'" }
        # Same transit-staging folder as the blob target - sweep leftovers a
        # force-killed previous run may have orphaned before this run creates
        # new ones (OneDriveTarget.psm1 stages a SharePoint source's download
        # there too; a filesystem source uploads straight from the share with
        # no staging at all).
        $staleTemp = Clear-StaleBlobTempFiles
        if ($staleTemp -gt 0) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Removed $staleTemp stale temp file(s) left by a previously interrupted run." }
        }
        # A SharePoint source's own connection already proved it can reach
        # this tenant (preflight/enumeration succeeded) and its cached
        # Graph-audience token works for ANY Graph endpoint regardless of
        # which site -Url named - reuse it rather than opening a second
        # connection. A filesystem source has no such connection, so it opens
        # one against the target OneDrive's own host purely to mint that
        # token (see the -TargetOneDriveHostUrl parameter's comment).
        $oneDriveAnchorConn = if (-not $isFsSource) {
            $sourceConn
        } else {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Connecting to $TargetOneDriveHostUrl to authenticate Microsoft Graph calls" }
            Connect-PnPOnline -Url $TargetOneDriveHostUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent
        }
        $targetOneDriveDriveId = Get-OneDriveDriveId -Connection $oneDriveAnchorConn -Upn $TargetOneDriveUpn
        $targetOneDrivePathRoot = Join-UrlSegments @($TargetOneDrivePath, $sourceLeaf)
        $oneDriveCtx = @{
            Connection = $oneDriveAnchorConn
            DriveId    = $targetOneDriveDriveId
            PathRoot   = $targetOneDrivePathRoot
        }
    } else {
        $sameSite = $TargetSiteUrl -and ($TargetSiteUrl.TrimEnd('/') -eq $SourceSiteUrl.TrimEnd('/'))
        if ($sameSite) {
            $targetConn = $sourceConn
        } else {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Connecting to target site $TargetSiteUrl" }
            $targetConn = Connect-PnPOnline -Url $TargetSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent
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
        FsHashConcurrency = $FsHashConcurrency
    }
    if ($isBlobTarget) {
        $verifyArgs.BlobCtx = $blobCtx
    } elseif ($isOneDriveTarget) {
        $verifyArgs.OneDriveCtx = $oneDriveCtx
    } else {
        $verifyArgs.TargetConn = $targetConn
        $verifyArgs.TargetSite = $effTargetSite
        $verifyArgs.TargetLib = $effTargetLib
        $verifyArgs.TargetPathInLib = $targetPathInLib
    }

    # "Copy item permissions": re-applies the grants the pre-flight recorded
    # (the access file) to the matching target items. Runs at the end of a
    # copy run when the job has the setting on, and on its own with
    # -PermissionsOnly. Writes each grant's outcome back into the access file
    # (the CSV's Result column). Target writes only - never the source.
    $runPermissionCopy = {
        if ($isFsSource -or $isBlobTarget -or $isOneDriveTarget) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = 'Copy item permissions: available for SharePoint to SharePoint jobs only - skipped.' }
            return
        }
        if (-not $AccessReportPath -or -not (Test-Path -LiteralPath $AccessReportPath)) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = 'Copy item permissions: no "who had access" list yet - run the pre-flight check first. Skipped.' }
            return
        }
        $settings = @{}
        if ($CopyPermissionsPath -and (Test-Path -LiteralPath $CopyPermissionsPath)) { $settings = Get-Content -LiteralPath $CopyPermissionsPath -Raw | ConvertFrom-Json -AsHashtable }
        $userMap = @{}
        foreach ($k in @(($settings.userMap ?? @{}).Keys)) { $userMap["$k".Trim().ToLowerInvariant()] = "$($settings.userMap[$k])".Trim() }
        $access = Get-Content -LiteralPath $AccessReportPath -Raw | ConvertFrom-Json -AsHashtable
        $items = @($access.items | Where-Object { $_ -and @($_.grants).Count -gt 0 })
        if ($items.Count -eq 0) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = 'Copy item permissions: no item has its own permissions at the source - nothing to copy.' }
            return
        }
        $hostOf = { param($u) try { ([uri]$u).Host.ToLowerInvariant() } catch { '' } }
        $tenantOf = { param($h) ($h -replace '-my\.sharepoint\.com$', '.sharepoint.com') }
        $crossTenant = (& $tenantOf (& $hostOf $SourceSiteUrl)) -ne (& $tenantOf (& $hostOf $effTargetSite))
        $sameSite = $effTargetSite.TrimEnd('/') -eq $SourceSiteUrl.TrimEnd('/')
        $includeGuests = [bool]$settings.includeGuests
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Copy item permissions: $($items.Count) item(s) with their own permissions$(if ($crossTenant) { " - different tenant, using $($userMap.Count) user mapping(s)" })$(if ($includeGuests) { ', including guests' } else { ', guests skipped' })..." }
        Write-PhaseProgress -Phase 'permissions' -Data @{ done = 0; total = $items.Count } -Force
        $permDrive = Get-GraphDriveId -Connection $targetConn -SiteUrl $effTargetSite -Library $effTargetLib
        $stats = Copy-ItemPermissions -Connection $targetConn -TargetSiteUrl $effTargetSite -TargetDriveId $permDrive `
            -TargetServerRelRoot ("$targetSiteServerRelative/$targetRoot".Replace('//', '/')) -TargetPathInLib $targetPathInLib `
            -SourceServerRelRoot ("$sourceSiteServerRelative/$sourceRoot".Replace('//', '/')) -Items $items `
            -UserMap $userMap -CrossTenant $crossTenant -SameSite $sameSite -IncludeGuests $includeGuests -OnProgress {
                param($n, $total)
                Write-PhaseProgress -Phase 'permissions' -Data @{ done = $n; total = $total }
            }
        $access.permissionCopy = @{ at = (Get-Date).ToUniversalTime().ToString('o'); includeGuests = $includeGuests; crossTenant = $crossTenant; stats = $stats }
        $access | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $AccessReportPath -Encoding utf8
        foreach ($it in $items) {
            foreach ($g in @($it.grants)) {
                if ("$($g.result)" -like 'failed:*') { Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Copy item permissions: $($it.path) - $($g.name): $($g.result)" } }
            }
        }
        Write-EngineEvent -Type 'permissions_copied' -Data @{ stats = $stats }
        Write-EngineEvent -Type 'log' -Data @{ level = $(if ($stats.failed) { 'warn' } else { 'info' }); message = "Copy item permissions done: $($stats.items) item(s) - $($stats.granted) grant(s) added, $($stats.linksCreated) new sharing link(s), $($stats.already) already in place, $($stats.skipped) skipped, $($stats.failed) failed. Per-grant results are in 'Export access (CSV)'." }
    }

    if ($PermissionsOnly) {
        & $runPermissionCopy
        exit 0
    }

    if ($VerifyOnly) {
        Invoke-VerificationPhase @verifyArgs | Out-Null
        exit 0
    }

    if ($RepairOnly) {
        # --- Targeted repair ("Repair N files") ------------------------------
        # Re-copies only the files the last verification flagged, puts their
        # original dates and people back, re-checks only those files (hash, and
        # the content check for files SharePoint rewrites) and emits the
        # previous verification summary with those files' outcomes merged in.
        # No enumeration, pre-flight, folder pass or full index - seconds for a
        # handful of files whatever the library size.
        if ($isFsSource -or $isBlobTarget -or $isOneDriveTarget) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = 'Repairing individual files is available for SharePoint/OneDrive to SharePoint jobs - use "Full re-run" for this job.' }
            exit 0
        }
        $prev = Get-Content -LiteralPath $RepairFromPath -Raw | ConvertFrom-Json -AsHashtable
        $prevReason = @{}
        foreach ($p in @($prev.problems)) { if ($p.path -and -not $prevReason.ContainsKey($p.path)) { $prevReason[$p.path] = "$($p.reason)" } }
        $paths = @($prevReason.Keys)
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Repair: re-copying $($paths.Count) file(s) that failed verification, then re-checking only those files..." }
        $srcDriveId = Get-GraphDriveId -Connection $sourceConn -SiteUrl $SourceSiteUrl -Library $SourceLibrary
        $tgtDriveId = Get-GraphDriveId -Connection $targetConn -SiteUrl $effTargetSite -Library $effTargetLib
        $graphItem = {
            param($Conn, $Drive, $Root, $Rel)
            $p = (@($Root, $Rel) | Where-Object { $_ }) -join '/'
            try { Invoke-PnPGraphMethod -Url "v1.0/drives/$Drive/root:/$(ConvertTo-BlobEscapedKey -Key $p.Trim('/'))" -Connection $Conn -ErrorAction Stop } catch { $null }
        }
        $repairList = $null
        $done = 0
        foreach ($rel in $paths) {
            Write-PhaseProgress -Phase 'repairing' -Data @{ done = $done; total = $paths.Count; current = $rel }
            $done++
            $s = & $graphItem $sourceConn $srcDriveId $SourcePath $rel
            if (-not $s -or -not $s.file) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Repair: '$rel' no longer exists at the source - nothing to copy." }
                continue
            }
            $leaf = ($rel -split '/')[-1]
            $relDir = if ($rel.Contains('/')) { $rel.Substring(0, $rel.LastIndexOf('/')) } else { '' }
            $tgtFolderWebRel = (@($targetRoot, $relDir) | Where-Object { $_ }) -join '/'
            try {
                # Exact bytes: download from the source through Graph (name-
                # and encoding-proof) and upload with Add-PnPFile. A server-
                # side copy is what produced the bad copy in the first place,
                # so it is not tried again here.
                Invoke-WithRetry -MaxAttempts 3 -Action {
                    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('mig-repair-' + [guid]::NewGuid().ToString('N'))
                    $null = New-Item -ItemType Directory -Path $tmpDir -Force
                    try {
                        $tmpFile = Join-Path $tmpDir $leaf
                        Save-GraphFileToPath -Connection $sourceConn -DriveId $srcDriveId -RelPath ((@($SourcePath, $rel) | Where-Object { $_ }) -join '/') -OutFile $tmpFile
                        $stream = [System.IO.File]::OpenRead($tmpFile)
                        try { Add-PnPFile -FileName $leaf -Folder $tgtFolderWebRel -Stream $stream -Connection $targetConn -ErrorAction Stop | Out-Null }
                        finally { $stream.Dispose() }
                    } finally { Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
                }
                # Original created/modified and people, from the source item.
                try {
                    if (-not $repairList) { $repairList = Get-PnPList -Identity (($targetRoot -split '/')[0]) -Connection $targetConn -ErrorAction Stop }
                    $vals = @{}; $ppl = @{}
                    if ($s.createdDateTime) { $vals['Created'] = [datetime]$s.createdDateTime }
                    if ($s.lastModifiedDateTime) { $vals['Modified'] = [datetime]$s.lastModifiedDateTime }
                    if ($s.createdBy.user.email) { $ppl['Author'] = $s.createdBy.user.email }
                    if ($s.lastModifiedBy.user.email) { $ppl['Editor'] = $s.lastModifiedBy.user.email }
                    $fileRef = "$targetSiteServerRelative/$targetRoot/$rel".Replace('//', '/')
                    $esc = [System.Security.SecurityElement]::Escape($fileRef)
                    $li = Get-PnPListItem -List $repairList -Query "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$esc</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>" -Connection $targetConn -ErrorAction Stop | Select-Object -First 1
                    if ($li -and ($vals.Count + $ppl.Count) -gt 0) {
                        try { Set-PnPListItem -List $repairList -Identity $li.Id -Values ($vals + $ppl) -Connection $targetConn -ErrorAction Stop | Out-Null }
                        catch { if ($vals.Count) { Set-PnPListItem -List $repairList -Identity $li.Id -Values $vals -Connection $targetConn -ErrorAction Stop | Out-Null } }
                    }
                } catch {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Repair: re-copied '$rel' but could not restore its original dates/people: $($_.Exception.Message)" }
                }
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Repair: re-copied '$rel' (exact bytes)." }
            } catch {
                Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "Repair: re-copy FAILED for '$rel': $($_.Exception.Message)" }
            }
        }

        # Re-check only the repaired files: both sides read fresh from Graph.
        Write-PhaseProgress -Phase 'repairing' -Data @{ done = $paths.Count; total = $paths.Count; current = $null; checking = $true }
        $srcMap = @{}; $tgtMap = @{}
        foreach ($rel in $paths) {
            $s = & $graphItem $sourceConn $srcDriveId $SourcePath $rel
            $t = & $graphItem $targetConn $tgtDriveId $targetPathInLib $rel
            if ($s -and $s.file) { $srcMap[$rel] = @{ Size = [long]$s.size; Hash = $s.file.hashes.quickXorHash; DownloadUrl = $s.'@microsoft.graph.downloadUrl' } }
            if ($t -and $t.file) { $tgtMap[$rel] = @{ Size = [long]$t.size; Hash = $t.file.hashes.quickXorHash; DownloadUrl = $t.'@microsoft.graph.downloadUrl' } }
        }
        $cmp = Compare-MigratedFileMaps -SourceMap $srcMap -TargetMap $tgtMap
        $content = @{}
        if ($cmp.OfficeRewritten.Count -gt 0) {
            $ccCache = @{}
            if ($ContentCachePath -and (Test-Path $ContentCachePath)) {
                try { (Get-Content $ContentCachePath -Raw | ConvertFrom-Json -AsHashtable).GetEnumerator() | ForEach-Object { $ccCache[$_.Key] = $_.Value } } catch {}
            }
            $todo = foreach ($rel in $cmp.OfficeRewritten) {
                $s = $srcMap[$rel]; $t = $tgtMap[$rel]
                @{ Rel = $rel; Key = "$rel|$($s.Hash)|$($s.Size)|$($t.Hash)|$($t.Size)"; Ext = [System.IO.Path]::GetExtension($rel); Size = [long]$s.Size; SourceUrl = $s.DownloadUrl; TargetUrl = $t.DownloadUrl }
            }
            foreach ($c in (Invoke-RewrittenContentCheck -Items @($todo) -Cache $ccCache -CachePath $ContentCachePath)) { $content[$c.Rel] = $c }
        }

        # Merge each repaired file's new outcome into the previous summary.
        $sum = $prev
        $counter = @{ missing = 'missing'; size = 'sizeMismatch'; hash = 'hashMismatch' }
        $rewrittenExt = @('.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.one', '.vsdx', '.msg', '.xlsb', '.pps', '.ppsx', '.ppsm', '.pot', '.potx', '.potm', '.dot', '.dotx', '.dotm', '.xlt', '.xltx', '.xltm', '.htm', '.html', '.mht', '.mhtml')
        $remaining = [System.Collections.Generic.List[object]]::new()
        $unchecked = [System.Collections.Generic.List[object]]::new(); foreach ($u in @($sum.contentUncheckedList)) { if ($u) { $unchecked.Add($u) } }
        $fixed = 0
        foreach ($rel in $paths) {
            $old = $prevReason[$rel]
            if ($counter.ContainsKey($old)) { $sum[$counter[$old]] = [Math]::Max(0, [int]$sum[$counter[$old]] - 1) }
            # officeRewritten counts only rewritten files WITHOUT a problem, so a
            # flagged file was never in it - a repaired one that comes back
            # rewritten-but-identical-in-content is added to it.
            $wasRewrittenCounted = $false
            $new = $null; $detail = $null
            if (-not $srcMap.ContainsKey($rel)) { $new = 'gone' }
            elseif ($cmp.Missing -contains $rel) { $new = 'missing' }
            elseif ($cmp.SizeMismatch -contains $rel) { $new = 'size' }
            elseif ($cmp.HashMismatch -contains $rel) { $new = 'hash' }
            elseif ($cmp.OfficeRewritten -contains $rel) {
                $c = $content[$rel]
                if ($c -and $c.Status -eq 'equivalent') { $new = 'content-ok' }
                elseif ($c -and $c.Status -eq 'different') { $new = 'hash'; $detail = $c.Detail }
                else { $new = 'unchecked'; $detail = if ($c) { $c.Detail } else { 'not checked' } }
            } else { $new = 'identical' }
            switch ($new) {
                'gone' { if ($wasRewrittenCounted) { $sum.officeRewritten = [Math]::Max(0, [int]$sum.officeRewritten - 1) }; Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Repair: '$rel' is no longer at the source, so it is no longer checked." } }
                'identical' { $sum.identical = [int]$sum.identical + 1; if ($wasRewrittenCounted) { $sum.officeRewritten = [Math]::Max(0, [int]$sum.officeRewritten - 1) }; $fixed++; Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Repair: '$rel' now verified identical (hash)." } }
                'content-ok' { $sum.contentVerified = [int]$sum.contentVerified + 1; if (-not $wasRewrittenCounted) { $sum.officeRewritten = [int]$sum.officeRewritten + 1 }; $fixed++; Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Repair: '$rel' now verified identical in content." } }
                'unchecked' { $sum.contentUnchecked = [int]$sum.contentUnchecked + 1; if (-not $wasRewrittenCounted) { $sum.officeRewritten = [int]$sum.officeRewritten + 1 }; $unchecked.Add(@{ path = $rel; detail = $detail }); Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Repair: '$rel' re-copied but could not be content-checked - $detail" } }
                default {
                    $sum[$counter[$new]] = [int]$sum[$counter[$new]] + 1
                    $remaining.Add(@{ path = $rel; reason = $new })
                    Write-EngineEvent -Type 'verify_mismatch' -Data @{ level = 'error'; reason = $new; sourcePath = $rel; message = "STILL FAILS after repair ($new$(if ($detail) { ": $detail" })): $rel" }
                }
            }
        }
        $sum.problems = @($remaining)
        $sum.contentUncheckedList = @($unchecked | Select-Object -First 200)
        $problems = [int]$sum.missing + [int]$sum.sizeMismatch + [int]$sum.hashMismatch
        $sum.ok = ($problems -eq 0)
        $sum.problemsTruncated = $false
        Write-EngineEvent -Type 'verification_summary' -Data @{ verification = $sum }
        $verdict = if ($problems -gt 0) { "FOUND $problems PROBLEM(S)" } elseif ([int]$sum.contentUnchecked -gt 0) { "PASSED, BUT $($sum.contentUnchecked) FILE(S) NOT YET CONTENT-CHECKED (click Verify again to check only those)" } else { 'PASSED' }
        Write-EngineEvent -Type 'log' -Data @{ level = ($problems -eq 0 ? 'info' : 'error'); message = "Repair done: $fixed of $($paths.Count) file(s) fixed. Verification ${verdict}: $($sum.identical) of $($sum.sourceFiles) files verified identical (hash), $($sum.contentVerified) re-stamped by SharePoint and verified identical in content, $($sum.contentUnchecked) re-stamped but not content-checked, $($sum.missing) missing, $($sum.sizeMismatch) size / $($sum.hashMismatch) content mismatches." }
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
        # Download links are kept for the content check of rewritten files.
        $srcMap = Get-GraphFileMap -Connection $sourceConn -DriveId $srcDriveId -RootPath $SourcePath -IncludeDownloadUrl:(-not $isBlobTarget) -OnProgress {
            param($count)
            Write-PhaseProgress -Phase 'indexing_source' -Data @{ files = $count }
        }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Source indexed: $($srcMap.Count) file(s). Now indexing the migrated copies at the target (takes about as long again on large libraries) - nothing is deleted until both indexes are complete." }
        $tgtProgress = { param($count) Write-PhaseProgress -Phase 'indexing_target' -Data @{ files = $count } }
        $tgtMap = if ($isBlobTarget) {
            Get-BlobKeyMap -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas -Prefix $blobCtx.Prefix
        } elseif ($isOneDriveTarget) {
            Get-GraphFileMap -Connection $oneDriveCtx.Connection -DriveId $oneDriveCtx.DriveId -RootPath $oneDriveCtx.PathRoot -IncludeDownloadUrl -OnProgress $tgtProgress
        } else {
            $tgtDriveId = Get-GraphDriveId -Connection $targetConn -SiteUrl $effTargetSite -Library $effTargetLib
            Get-GraphFileMap -Connection $targetConn -DriveId $tgtDriveId -RootPath $targetPathInLib -IncludeDownloadUrl -OnProgress $tgtProgress
        }

        $officeExtensions = @('.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.one', '.vsdx', '.xlsb', '.pps', '.ppsx', '.ppsm', '.pot', '.potx', '.potm', '.dot', '.dotx', '.dotm', '.xlt', '.xltx', '.xltm', '.htm', '.html', '.mht', '.mhtml')

        # --- Content proof for files SharePoint rewrote ------------------
        # A rewritten Office file or web page can't be vouched for by size or
        # hash, so its source is recycled ONLY if the content check (the same
        # one verification uses, ContentCheck.psm1) proves the target copy
        # identical right now. 'different' or 'could not be checked' keeps
        # the source. Cached results are reused only while both hashes match.
        $contentProven = [System.Collections.Generic.HashSet[string]]::new()
        $contentReason = @{}
        if (-not $isBlobTarget) {
            $ccCache = @{}
            if ($ContentCachePath -and (Test-Path $ContentCachePath)) {
                try { (Get-Content $ContentCachePath -Raw | ConvertFrom-Json -AsHashtable).GetEnumerator() | ForEach-Object { $ccCache[$_.Key] = $_.Value } } catch {}
            }
            $todo = [System.Collections.Generic.List[object]]::new()
            foreach ($rel in @($srcMap.Keys)) {
                $s = $srcMap[$rel]; $t = $tgtMap[$rel]
                if (-not $t) { continue }
                if (-not ($officeExtensions -contains ([System.IO.Path]::GetExtension($rel).ToLowerInvariant()))) { continue }
                if ([long]$s.Size -eq [long]$t.Size -and $s.Hash -and $t.Hash -and $s.Hash -eq $t.Hash) { continue }  # byte-identical, no rewrite
                $key = "$rel|$($s.Hash)|$($s.Size)|$($t.Hash)|$($t.Size)"
                if ($s.Hash -and $t.Hash -and $ccCache.ContainsKey($key) -and -not (Test-TransientContentResult $ccCache[$key])) {
                    $c = $ccCache[$key]
                    if ($c.Status -eq 'equivalent') { $null = $contentProven.Add($rel) } else { $contentReason[$rel] = "content check: $($c.Detail)" }
                    continue
                }
                $todo.Add(@{ Rel = $rel; Key = $key; Ext = [System.IO.Path]::GetExtension($rel); Size = [long]$s.Size; SourceUrl = $s.DownloadUrl; TargetUrl = $t.DownloadUrl })
            }
            if ($todo.Count -gt 0) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Cleanup check: comparing $($todo.Count) file(s) SharePoint rewrote part by part against their originals before anything is recycled..." }
                $ccTotal = $todo.Count
                [long]$ccTotalBytes = ($todo | Measure-Object -Property Size -Sum).Sum
                $ccSrcLinks = @{ Conn = $sourceConn; Drive = $srcDriveId; Root = $SourcePath }
                $ccTgtLinks = if ($isOneDriveTarget) { @{ Conn = $oneDriveCtx.Connection; Drive = $oneDriveCtx.DriveId; Root = $oneDriveCtx.PathRoot } } else { @{ Conn = $targetConn; Drive = $tgtDriveId; Root = $targetPathInLib } }
                $ccRefresh = {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = 'Cleanup check: refreshing download links (they expire after about an hour)...' }
                    $out = @{ Source = @{}; Target = @{} }
                    $m = Get-GraphFileMap -Connection $ccSrcLinks.Conn -DriveId $ccSrcLinks.Drive -RootPath $ccSrcLinks.Root -IncludeDownloadUrl; foreach ($k in @($m.Keys)) { $out.Source[$k] = $m[$k].DownloadUrl }
                    $m = Get-GraphFileMap -Connection $ccTgtLinks.Conn -DriveId $ccTgtLinks.Drive -RootPath $ccTgtLinks.Root -IncludeDownloadUrl; foreach ($k in @($m.Keys)) { $out.Target[$k] = $m[$k].DownloadUrl }
                    $out
                }
                $ccLog = @{ At = (Get-Date) }
                $checked = Invoke-RewrittenContentCheck -Items $todo.ToArray() -RefreshLinks $ccRefresh -Cache $ccCache -CachePath $ContentCachePath -OnProgress {
                    param($n, $bytes, $rel, $throttleWait, $current, $currentBytes, $throttle)
                    if ($throttleWait) { Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Content check: SharePoint is throttling - pausing about $($throttleWait)s, then carrying on (nothing is skipped)." } }
                    if ($throttle -and $throttle.Recovered) { Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Content check: SharePoint stopped throttling - back to full speed ($($throttle.Recovered) pause(s) so far, nothing skipped)." } }
                    Write-PhaseProgress -Phase 'content_check' -Data @{ done = $n; total = $ccTotal; bytesDone = $bytes; bytesTotal = $ccTotalBytes; last = $rel; current = $current; currentBytes = $currentBytes; throttled = [bool]($throttle -and $throttle.Active); throttleWait = $(if ($throttle) { $throttle.WaitLeft } else { 0 }); throttles = $(if ($throttle) { $throttle.Count } else { 0 }) }
                    if (((Get-Date) - $ccLog.At).TotalSeconds -ge 15) {
                        $ccLog.At = Get-Date
                        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Cleanup check: $n of $ccTotal checked ($([Math]::Round($bytes / 1MB)) of $([Math]::Round($ccTotalBytes / 1MB)) MB)$(if ($current) { " · now: $(($current -split '/')[-1]) ($([Math]::Max(1, [Math]::Round($currentBytes / 1MB))) MB)" })$(if ($throttle -and $throttle.Active) { " · throttled by SharePoint, waiting ~$($throttle.WaitLeft)s" })" }
                    }
                }
                foreach ($c in $checked) {
                    if (-not (Test-TransientContentResult $c)) { $ccCache[$c.Key] = @{ Status = $c.Status; Detail = $c.Detail } }
                    if ($c.Status -eq 'equivalent') { $null = $contentProven.Add($c.Rel) } else { $contentReason[$c.Rel] = "content check: $($c.Detail)" }
                }
                if ($ContentCachePath) {
                    try { $ccCache | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $ContentCachePath -Encoding utf8 } catch {}
                }
            }
        }
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Cleanup check: $($srcMap.Count) source file(s) vs $($tgtMap.Count) migrated file(s). Re-verifying and recycling each file now..." }

        # Same acceptance rule as verification: exact size+hash (hash
        # unavailable degrades to size-only), and a rewritten Office file or
        # web page only if the content check above proved it identical.
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
                    if ($isOffice) {
                        $verified = ([long]$src.Size -eq [long]$tgt.Size -and $src.Hash -and $tgt.Hash -and $src.Hash -eq $tgt.Hash) -or $contentProven.Contains($rel)
                    } elseif ([long]$src.Size -eq [long]$tgt.Size) {
                        $verified = (-not $src.Hash -or -not $tgt.Hash) -or ($src.Hash -eq $tgt.Hash)
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
                    reason = if (-not $tgt) { 'no migrated copy found at the target' } elseif ($contentReason.ContainsKey($rel)) { "migrated copy not proven identical ($($contentReason[$rel]))" } else { 'migrated copy does not match the source right now' }
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
            $treeAfter = Get-PnPFolderTree -Connection $sourceConn -RootSiteRelativeUrl $sourceRoot -SkipLibraryFormsFolder:(-not ([string]$SourcePath).Trim('/')) -OnProgress {
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
        #
        # `net use` is tried ONLY if the path isn't already readable - not
        # unconditionally on every job start/resume. `/persistent:no`
        # sessions are shared across the whole Windows logon session (see
        # server/util/fsSource.js's identical note and its own 10-minute
        # reconnect cache for the same reason) - including every OTHER
        # concurrently-running engine process for a different job against
        # the same share. Blindly re-issuing `net use` while another job is
        # actively mid-copy can disrupt its in-flight session. Observed
        # live: three jobs running concurrently against different
        # subfolders of \\10.5.53.10\users$ (same share) all started
        # failing "Access is denied" on OpenRead in a burst right as one of
        # them resumed and unconditionally reconnected.
        if ($env:FS_SOURCE_USERNAME -and $env:FS_SOURCE_SHARE -and -not (Test-Path -LiteralPath $SourcePath)) {
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
    } elseif ($isOneDriveTarget) {
        # The drive itself was already resolved (and would have thrown) when
        # the connection was set up above - nothing left to probe here.
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Preflight OK: engine can read the source$(if ($isFsSource) { ' path' } else { ' library' }) and access the OneDrive for '$TargetOneDriveUpn'." }
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
    $targetKey = if ($isBlobTarget) { 'blob' } elseif ($isOneDriveTarget) { "onedrive|$TargetOneDriveUpn|$($oneDriveCtx.PathRoot)" } else { "$effTargetSite|$effTargetLib|$targetPathInLib" }
    $tree = $null
    $treeFromCache = $false
    $cachedFoldersEnsuredFor = $null
    if ($TreeCachePath -and (Test-Path $TreeCachePath)) {
        try {
            $cache = Get-Content -Path $TreeCachePath -Raw | ConvertFrom-Json
            $ageHours = ((Get-Date).ToUniversalTime() - [datetime]$cache.generatedAtUtc).TotalHours
            if ($cache.sourceKey -eq $sourceKey -and $ageHours -lt $TREE_CACHE_MAX_AGE_HOURS) {
                # Scans cached before the library "Forms" folder was excluded
                # (see Get-PnPFolderTree -SkipLibraryFormsFolder) still list
                # its system files - drop them the same way.
                $skipForms = -not ([string]$SourcePath).Trim('/')
                $tree = [pscustomobject]@{
                    Files   = @($cache.files | Where-Object { -not ($skipForms -and ($_.RelativeFromRoot -eq 'Forms' -or "$($_.RelativeFromRoot)" -like 'Forms/*')) })
                    Folders = @($cache.folders | ForEach-Object { [string]$_ } | Where-Object { -not ($skipForms -and ($_ -eq 'Forms' -or $_ -like 'Forms/*')) })
                }
                $cachedFoldersEnsuredFor = $cache.foldersEnsuredFor
                $treeFromCache = $true
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
            # Graph delta first (one paged walk of the library - see
            # Get-GraphDeltaTree), folder-by-folder CSOM when the job only
            # covers a small part of a big library or delta fails for any
            # reason. Both return the same shape.
            try {
                $scanDriveId = Get-GraphDriveId -Connection $sourceConn -SiteUrl $SourceSiteUrl -Library $SourceLibrary
                $libItemCount = -1
                try { $libItemCount = [long](Get-PnPList -Identity $SourceLibrary -Connection $sourceConn -ErrorAction Stop).ItemCount } catch {}
                $scan = Select-SharePointScanMethod -Connection $sourceConn -DriveId $scanDriveId -PathInLibrary $SourcePath -LibraryItemCount $libItemCount
                if ($SourceScanMethod -ne 'auto') { $scan.Method = $SourceScanMethod; $scan.Reason = "forced by -SourceScanMethod $SourceScanMethod" }
                if ($scan.Method -eq 'delta') {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Enumerating source tree under '$sourceRoot' with a Graph delta scan ($($scan.Reason))" }
                    $tree = Get-GraphDeltaTree -Connection $sourceConn -DriveId $scanDriveId -RootSiteRelativeUrl $sourceRoot -ScopeFolderId $scan.FolderId -OnProgress {
                        param($folderCount, $fileCount, $pageCount)
                        Write-PhaseProgress -Phase 'enumerating' -Data @{ folders = $folderCount; files = $fileCount; pending = 0 }
                    } -OnRetry {
                        param($attempt, $waitMs, $reason, $statusCode, $message)
                        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Delta scan retry $attempt`: $reason - $message" }
                    }
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Delta scan done: $(@($tree.Files).Count) file(s) in $(@($tree.Folders).Count) folder(s), $($tree.Pages) Graph page(s)." }
                } else {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Enumerating source tree under '$sourceRoot' folder by folder ($($scan.Reason), so a whole-library delta scan would read more than it saves)" }
                }
            } catch {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Graph delta scan unavailable ($($_.Exception.Message)) - enumerating folder by folder instead." }
                $tree = $null
            }
            if (-not $tree) {
                $tree = Get-PnPFolderTree -Connection $sourceConn -RootSiteRelativeUrl $sourceRoot -SkipLibraryFormsFolder:(-not ([string]$SourcePath).Trim('/')) -OnProgress {
                    param($folderCount, $fileCount, $pendingCount)
                    Write-PhaseProgress -Phase 'enumerating' -Data @{ folders = $folderCount; files = $fileCount; pending = $pendingCount }
                }
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

    # --- Pre-flight content check -------------------------------------------
    # Before anything is created or copied: target paths over SharePoint's
    # 400-character limit, files over 250 GB, and how many source items carry
    # their own permissions (engine/lib/Preflight.psm1). Never fatal - a
    # blocked file simply fails at copy time as it would have anyway, while
    # everything else migrates - but the report lands in the job log and on
    # the job page first, and -PreflightOnly stops here so it can be read
    # before the job is started at all.
    try {
        Write-PhaseProgress -Phase 'preflight' -Data @{ step = 'paths' } -Force
        $preflightPrefix = if ($isBlobTarget) {
            $blobCtx.Prefix
        } elseif ($isOneDriveTarget) {
            $driveWeb = Invoke-WithRetry -Action { Invoke-PnPGraphMethod -Url "v1.0/drives/$($oneDriveCtx.DriveId)?`$select=webUrl" -Connection $oneDriveCtx.Connection }
            (Join-UrlSegments @([uri]::UnescapeDataString(([Uri]$driveWeb.webUrl).AbsolutePath), $oneDriveCtx.PathRoot)) -replace '^(?!/)', '/'
        } else {
            (Join-UrlSegments @((Get-ServerRelativeSitePath -SiteUrl $effTargetSite), $targetRoot)) -replace '^(?!/)', '/'
        }
        $content = Test-MigrationContent -Files @($tree.Files) -Folders @($tree.Folders) -TargetPrefix $preflightPrefix -TargetProvider $TargetProvider
        $uniquePerms = $null
        $permsSkipped = $false
        # Reading HasUniqueRoleAssignments costs ~4 ms per item (measured: 20s
        # per 5,000 vs 2s without it), so a resume that reuses a recent scan
        # also reuses that scan's permission count - the server keeps the
        # earlier figure when this run reports it as skipped.
        if (-not $isFsSource -and $treeFromCache) {
            $permsSkipped = $true
        } elseif (-not $isFsSource) {
            Write-PhaseProgress -Phase 'preflight' -Data @{ step = 'permissions'; scanned = 0 } -Force
            $uniquePerms = Get-UniquePermissionSummary -Connection $sourceConn `
                -LibraryServerRelativeUrl ("$sourceSiteServerRelative/$SourceLibrary".Replace('//', '/')) `
                -RootServerRelativeUrl ("$sourceSiteServerRelative/$sourceRoot".Replace('//', '/')) -OnProgress {
                    param($scanned, $found)
                    Write-PhaseProgress -Phase 'preflight' -Data @{ step = 'permissions'; scanned = $scanned; found = $found }
                }
        }
        $preflight = New-PreflightReport -Content $content -UniquePerms $uniquePerms -TargetProvider $TargetProvider
        if ($permsSkipped) { $preflight.uniquePermissions = @{ skipped = $true } }
        # "Who had access": the grants of every item with its own permissions,
        # read from Graph (read-only) and saved for the CSV export. Capped so a
        # pathological library can't stall the pre-flight.
        if ($AccessReportPath -and $uniquePerms -and $uniquePerms.Checked -and @($uniquePerms.Items).Count -gt 0) {
            try {
                $accessItems = @($uniquePerms.Items | Select-Object -First 5000)
                Write-PhaseProgress -Phase 'preflight' -Data @{ step = 'access'; done = 0; total = $accessItems.Count } -Force
                $accessDrive = Get-GraphDriveId -Connection $sourceConn -SiteUrl $SourceSiteUrl -Library $SourceLibrary
                $access = Get-ItemAccessGrants -Connection $sourceConn -DriveId $accessDrive -RootPath $SourcePath -Items $accessItems -OnProgress {
                    param($n, $total)
                    if ($n % 25 -eq 0) { Write-PhaseProgress -Phase 'preflight' -Data @{ step = 'access'; done = $n; total = $total } }
                }
                $allGrants = @($access | ForEach-Object { $_.grants } | Where-Object { $_ })
                $summary = @{
                    items        = $access.Count
                    grants       = $allGrants.Count
                    links        = @($allGrants | Where-Object { $_.source -eq 'link' }).Count
                    anyoneLinks  = @($allGrants | Where-Object { $_.source -eq 'link' -and $_.linkScope -eq 'anyone' }).Count
                    external     = @($allGrants | Where-Object { $_.external }).Count
                    errors       = @($access | Where-Object { $_.error }).Count
                    truncated    = (@($uniquePerms.Items).Count -gt $accessItems.Count)
                    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
                }
                $null = New-Item -ItemType Directory -Force -Path (Split-Path $AccessReportPath -Parent)
                @{ summary = $summary; sourceSite = $SourceSiteUrl; sourceLibrary = $SourceLibrary; sourcePath = $SourcePath; items = @($access) } |
                    ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $AccessReportPath -Encoding utf8
                $preflight.uniquePermissions.access = $summary
                Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "PRE-FLIGHT: who had access recorded for $($summary.items) item(s) with their own permissions: $($summary.grants) grant(s), $($summary.links) sharing link grant(s) ($($summary.anyoneLinks) 'anyone'), $($summary.external) external/guest. Use 'Export access (CSV)' on the job page." }
            } catch {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "PRE-FLIGHT: could not record who had access (the job is unaffected): $($_.Exception.Message)" }
            }
        }
        Write-EngineEvent -Type 'preflight_report' -Data @{ preflight = $preflight }
        foreach ($lp in ($preflight.longFolders.items | Select-Object -First 10)) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "PRE-FLIGHT: folder path is $($lp.length) characters at the target (limit $($preflight.maxPathLength)) - nothing under it can be created: $($lp.path)" }
        }
        foreach ($lp in ($preflight.longPaths.items | Select-Object -First 20)) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "PRE-FLIGHT: target path would be $($lp.length) characters (limit $($preflight.maxPathLength)): $($lp.path)" }
        }
        foreach ($lf in ($preflight.largeFiles.items | Select-Object -First 20)) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "PRE-FLIGHT: file is $([Math]::Round($lf.size / 1GB, 1)) GB - over SharePoint's 250 GB limit: $($lf.path)" }
        }
        foreach ($w in $preflight.warnings) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "PRE-FLIGHT: $w" }
        }
        $pfSummary = if ($preflight.ok) {
            "Pre-flight OK: $totalItems file(s) checked, longest target path $($preflight.longestPath) of $($preflight.maxPathLength) characters, no file over the size limit."
        } else {
            "Pre-flight found $($preflight.blockers) file(s) that cannot be copied as they are ($($preflight.longPaths.count) path(s) over $($preflight.maxPathLength) characters, $($preflight.largeFiles.count) file(s) over 250 GB). Shorten the folder names or the target location to fix them; everything else copies normally."
        }
        Write-EngineEvent -Type 'log' -Data @{ level = ($preflight.ok ? 'info' : 'error'); message = $pfSummary }
    } catch {
        Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Pre-flight check could not run (the job is unaffected): $($_.Exception.Message)" }
    }
    if ($PreflightOnly) { exit 0 }

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
    } elseif ($isOneDriveTarget) {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Checking $($tree.Folders.Count) target folder(s) in OneDrive (creating any that are missing) under '$($oneDriveCtx.PathRoot)'" }
        Initialize-GraphDriveFolders -Connection $oneDriveCtx.Connection -DriveId $oneDriveCtx.DriveId -TargetRootPath $oneDriveCtx.PathRoot -RelativeFolderPaths $tree.Folders -ThrottleLimit $Concurrency -OnProgress {
            param($done, $total)
            Write-PhaseProgress -Phase 'preparing_folders' -Data @{ done = $done; total = $total }
        }
        if ($TreeCachePath -and (Test-Path $TreeCachePath)) {
            try {
                $cacheUpdate = Get-Content -Path $TreeCachePath -Raw | ConvertFrom-Json
                $cacheUpdate | Add-Member -NotePropertyName 'foldersEnsuredFor' -NotePropertyValue $targetKey -Force
                $cacheUpdate | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $TreeCachePath -Encoding utf8
            } catch {}
        }
    } else {
        Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Checking $($tree.Folders.Count) target folder(s) under '$targetRoot' (creating any that are missing)" }
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
    # Source drive id doubles as the handle for the encoding-proof Graph
    # download fallback (blob lanes and the repair pass) - keep whatever the
    # prefetch resolved even if a later prefetch step fails.
    $srcDriveId = $null
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
            } -OnRetry {
                param($attempt, $waitMs, $reason, $statusCode, $message)
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Prefetch (source index) retry $attempt`: $reason - $message" }
            }
        }
        if ($isBlobTarget) {
            $targetFileMap = Get-BlobKeyMap -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas -Prefix $blobCtx.Prefix
        } elseif ($isOneDriveTarget) {
            $targetFileMap = Get-GraphFileMap -Connection $oneDriveCtx.Connection -DriveId $oneDriveCtx.DriveId -RootPath $oneDriveCtx.PathRoot -IncludeDetails -OnProgress {
                param($count)
                Write-PhaseProgress -Phase 'indexing_target' -Data @{ files = $count }
            } -OnRetry {
                param($attempt, $waitMs, $reason, $statusCode, $message)
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Prefetch (target index) retry $attempt`: $reason - $message" }
            }
        } else {
            $tgtDriveId = Get-GraphDriveId -Connection $targetConn -SiteUrl $effTargetSite -Library $effTargetLib
            $targetFileMap = Get-GraphFileMap -Connection $targetConn -DriveId $tgtDriveId -RootPath $targetPathInLib -IncludeDetails -OnProgress {
                param($count)
                Write-PhaseProgress -Phase 'indexing_target' -Data @{ files = $count }
            } -OnRetry {
                param($attempt, $waitMs, $reason, $statusCode, $message)
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Prefetch (target index) retry $attempt`: $reason - $message" }
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
        Import-Module "$using:PSScriptRoot/lib/UserAgent.psm1"
        Initialize-MigrationUserAgent
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
        $laneSourceConn = Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent
        $laneTargetConn = if ($SameSite) { $laneSourceConn } else { Connect-PnPOnline -Url $TargetSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent }
        # Same rule as Get-CrossHostTargetPrefix (lane runspaces can't see
        # script-scope functions): a cross-host copy, e.g. OneDrive (-my
        # host) into a SharePoint site, needs an absolute -TargetUrl.
        # Same list as Verification.psm1's OfficeExtensions.
        $laneOfficeExtensions = @('.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.one', '.vsdx', '.msg', '.xlsb', '.pps', '.ppsx', '.ppsm', '.pot', '.potx', '.potm', '.dot', '.dotx', '.dotm', '.xlt', '.xltx', '.xltm', '.htm', '.html', '.mht', '.mhtml')
        $laneTargetUrlPrefix = ''
        if ($SourceSiteUrl -and $TargetSiteUrl) {
            $laneSrcUri = [Uri]$SourceSiteUrl; $laneTgtUri = [Uri]$TargetSiteUrl
            if ($laneSrcUri.Authority -ine $laneTgtUri.Authority) { $laneTargetUrlPrefix = "$($laneTgtUri.Scheme)://$($laneTgtUri.Authority)" }
        }

        # Target library list, resolved once per lane - used to stamp original
        # metadata (Created/Modified/Author/Editor) onto each copied file.
        # Get-PnPList accepts the library's URL segment (e.g. "Shared
        # Documents"), which is what the job stores; the display title
        # ("Documents") may differ.
        $laneTargetList = $null
        try { $laneTargetList = Get-PnPList -Identity (($TargetRoot -split '/')[0]) -Connection $laneTargetConn -ErrorAction Stop } catch {}

        # Stamps the source file's Created/Modified/Author/Editor onto its
        # copy. A person SharePoint can't resolve on the target (left the
        # organization, external account) used to fail the whole update and
        # lose the dates too - retry without the people so the dates always
        # land, and say whose name couldn't be carried over. Returns $true
        # when everything was applied.
        function local:Set-LaneOriginalMetadata {
            param([string]$RelKey, [string]$SourceFileServerRel, [string]$TargetFileServerRel)
            try {
                $values = @{}
                $people = @{}
                $meta = if ($null -ne $SourceMetaMap) { $SourceMetaMap[$RelKey] } else { $null }
                if ($meta) {
                    # Fast path: metadata came from the prefetched source walk.
                    if ($meta.Created) { $values['Created'] = $meta.Created }
                    if ($meta.Modified) { $values['Modified'] = $meta.Modified }
                    if ($meta.AuthorEmail) { $people['Author'] = $meta.AuthorEmail }
                    if ($meta.EditorEmail) { $people['Editor'] = $meta.EditorEmail }
                } else {
                    $srcItem = Get-PnPFile -Url $SourceFileServerRel -AsListItem -Connection $laneSourceConn -ErrorAction Stop
                    if ($srcItem['Created']) { $values['Created'] = $srcItem['Created'] }
                    if ($srcItem['Modified']) { $values['Modified'] = $srcItem['Modified'] }
                    if ($srcItem['Author'] -and $srcItem['Author'].Email) { $people['Author'] = $srcItem['Author'].Email }
                    if ($srcItem['Editor'] -and $srcItem['Editor'].Email) { $people['Editor'] = $srcItem['Editor'].Email }
                }
                if (-not $laneTargetList -or ($values.Count + $people.Count) -eq 0) { return $false }
                $tgtItem = $null
                try {
                    $tgtItem = Get-PnPFile -Url $TargetFileServerRel -AsListItem -Connection $laneTargetConn -ErrorAction Stop
                } catch {
                    # Get-PnPFile URL-decodes its -Url, so a name containing
                    # a literal %XX (e.g. "report %20 final.txt") is looked up
                    # under the wrong name. Find the item by its exact path.
                    $esc = [System.Security.SecurityElement]::Escape($TargetFileServerRel)
                    $caml = "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$esc</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>"
                    $tgtItem = Get-PnPListItem -List $laneTargetList -Query $caml -Connection $laneTargetConn -ErrorAction Stop | Select-Object -First 1
                    if (-not $tgtItem) { throw }
                }
                # Get-PnPFile can also return $null instead of throwing for
                # such a name - same exact-path lookup then.
                if (-not $tgtItem -or -not $tgtItem.Id) {
                    $esc = [System.Security.SecurityElement]::Escape($TargetFileServerRel)
                    $caml = "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$esc</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>"
                    $tgtItem = Get-PnPListItem -List $laneTargetList -Query $caml -Connection $laneTargetConn -ErrorAction Stop | Select-Object -First 1
                    if (-not $tgtItem) { throw "target item not found: $TargetFileServerRel" }
                }
                try {
                    Set-PnPListItem -List $laneTargetList -Identity $tgtItem.Id -Values ($values + $people) -Connection $laneTargetConn -ErrorAction Stop | Out-Null
                    return $true
                } catch {
                    if ($people.Count -eq 0 -or $values.Count -eq 0) { throw }
                    $peopleError = $_.Exception.Message
                    Set-PnPListItem -List $laneTargetList -Identity $tgtItem.Id -Values $values -Connection $laneTargetConn -ErrorAction Stop | Out-Null
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                        level = 'warn'; message = "Copied OK with original dates, but created-by/modified-by ($(($people.Values | Select-Object -Unique) -join ', ')) could not be set on '$TargetFileServerRel': $peopleError"
                    }))
                    return $false
                }
            } catch {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                    level = 'warn'; message = "Copied OK but could not preserve original metadata for '$TargetFileServerRel': $($_.Exception.Message)"
                }))
                return $false
            }
        }

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
            # SharePoint re-stamps Office/Outlook files' embedded properties
            # on copy, so their copy is never the same size as the source
            # (verification already treats that as expected). Requiring an
            # equal size here made every re-run copy every Office file again;
            # for those, an existing copy at least as new as the source counts.
            $sizeMayDiffer = $laneOfficeExtensions -contains [System.IO.Path]::GetExtension($item.Name).ToLowerInvariant()
            if ($null -ne $TargetFileMap) {
                $existing = $TargetFileMap[$relKey]
                $alreadyDone = $existing -and
                    (([long]$existing.Size -eq [long]$item.Size) -or ($sizeMayDiffer -and $item.Modified -and $existing.Modified)) -and
                    (-not $item.Modified -or -not $existing.Modified -or ([datetime]$existing.Modified).AddSeconds(5) -ge [datetime]$item.Modified)
            } else {
                $alreadyDone = Test-PnPTargetFileMatches -Connection $laneTargetConn -TargetServerRelativeUrl $targetFileServerRel -ExpectedSize $item.Size -SourceModified $item.Modified -AllowSizeDifference:$sizeMayDiffer
            }
            if ($alreadyDone) {
                # Backfill for copies made before the metadata stamp worked
                # (or that a previous run couldn't stamp): a target file whose
                # modified-by is still the migration app - Graph reports no
                # email for an app identity - gets the original people and
                # dates re-applied. A file someone has genuinely edited on the
                # target since carries their email and is left alone.
                $reason = 'target already has a file of the same name and size'
                $srcMeta = if ($null -ne $SourceMetaMap) { $SourceMetaMap[$relKey] } else { $null }
                if ($existing -and $srcMeta -and $srcMeta.EditorEmail -and -not $existing.EditorEmail) {
                    if (Set-LaneOriginalMetadata -RelKey $relKey -SourceFileServerRel $sourceFileServerRel -TargetFileServerRel $targetFileServerRel) {
                        $reason = 'target already has a file of the same name and size - original created/modified-by re-applied'
                    }
                }
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_skipped' -Data @{
                    sourcePath = $sourceFileServerRel; targetPath = $targetFileServerRel; bytes = [long]$item.Size
                    reason     = $reason
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
                        Copy-PnPFile -SourceUrl $sourceFileServerRel -TargetUrl "$laneTargetUrlPrefix$targetFolderServerRel" `
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
                    Set-LaneOriginalMetadata -RelKey $relKey -SourceFileServerRel $sourceFileServerRel -TargetFileServerRel $targetFileServerRel | Out-Null

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
              $BlobEndpoint, $Container, $Sas, $BlobPrefix, $TargetFileMap, $SourceMetaMap, $SourcePathInLib, $SrcDriveId)

        Import-Module PnP.PowerShell -ErrorAction Stop
        # NO -Force - same in-process clobbering hazard as the SharePoint
        # lane above.
        Import-Module "$using:PSScriptRoot/lib/Events.psm1"
        Import-Module "$using:PSScriptRoot/lib/UserAgent.psm1"
        Initialize-MigrationUserAgent
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
        $laneSourceConn = Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent

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
                    (-not $item.Modified -or -not $existing.Modified -or ([datetime]$existing.Modified).AddSeconds(5) -ge [datetime]$item.Modified)
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

                    # Drive-addressed Graph fallback for the download: kicks
                    # in for %/# names (which Get-PnPFile cannot fetch) and
                    # after any Get-PnPFile failure. Unavailable (null) only
                    # if the prefetch couldn't resolve the source drive id.
                    $graphSource = if ($SrcDriveId) {
                        @{ DriveId = $SrcDriveId; RelPath = (Get-BlobKey -Segments @($SourcePathInLib, $relFromRoot, $item.Name)) }
                    } else { $null }
                    Invoke-WithRetry -MaxAttempts 5 -Action {
                        Save-BlobFromSharePointFile -SourceConnection $laneSourceConn -SourceServerRelativeUrl $sourceFileServerRel `
                            -BlobEndpoint $BlobEndpoint -Container $Container -Sas $Sas -BlobKey $blobKey -Metadata $metadata `
                            -GraphSource $graphSource -OnProgress $blobProgress | Out-Null
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

    # OneDrive-target lane: for a SharePoint source, downloads each file
    # (reusing the lane's own PnP connection, same Get-PnPFile-with-Graph-
    # fallback approach as the blob lane) then uploads it into the target
    # user's OneDrive via Microsoft Graph (OneDriveTarget.psm1 - Copy-PnPFile
    # has no cross-resource-audience equivalent; see that module's header
    # comment for why this target can't reuse the SharePoint-target code
    # path at all). For a filesystem source, uploads the local/UNC file
    # directly - no download/temp-staging phase, no source PnP connection at
    # all (only a nominal one purely to mint a Graph token - see
    # -TargetOneDriveHostUrl). Pushes the identical item_start/item_success/
    # item_retry/item_failed/item_skipped NDJSON event shapes onto the same
    # $resultQueue as every other lane, so the drain loop, checkpointing and
    # adaptive concurrency below need no changes to support this target.
    #
    # Same per-file HEAD/existence fallback as the other lanes (see
    # Test-OneDriveTargetMatches) when the prefetched $TargetFileMap is
    # unavailable - a prefetch failure partway through a large tree used to
    # mean every remaining file got blindly re-uploaded.
    $laneScriptOneDrive = {
        param($LaneIndex, $WorkQueue, $ResultQueue, $Shared, $IsFsSource, $ClientId, $TenantId,
              $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath,
              $SourceSiteUrl, $SourceSiteServerRelative, $SourceRoot, $SourcePathInLib, $SrcDriveId,
              $TargetOneDriveHostUrl, $TargetDriveId, $TargetOneDrivePathRoot, $TargetFileMap, $OneDriveChunkSizeBytes)

        Import-Module PnP.PowerShell -ErrorAction Stop
        # NO -Force - same in-process clobbering hazard as every other lane
        # (see the SharePoint lane above for the full explanation).
        Import-Module "$using:PSScriptRoot/lib/Events.psm1"
        Import-Module "$using:PSScriptRoot/lib/UserAgent.psm1"
        Initialize-MigrationUserAgent
        Import-Module "$using:PSScriptRoot/lib/Retry.psm1"
        Import-Module "$using:PSScriptRoot/lib/OneDriveTarget.psm1"

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
        # A SharePoint source's own connection doubles as the Graph-audience
        # token vehicle for the OneDrive upload calls too - Invoke-PnPGraphMethod
        # calls arbitrary Graph endpoints off ANY connection regardless of
        # which site -Url named (see Verification.psm1's Get-GraphDriveId,
        # which already relies on this to query other sites' drives). A
        # filesystem source has no source connection at all, so it opens one
        # against the target OneDrive's own host purely to mint that token.
        $laneSourceConn = if (-not $IsFsSource) {
            Connect-PnPOnline -Url $SourceSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent
        } else { $null }
        $laneOneDriveConn = if ($IsFsSource) {
            Connect-PnPOnline -Url $TargetOneDriveHostUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent
        } else { $laneSourceConn }

        while (-not $Shared.Stop) {
            if ($LaneIndex -ge $Shared.TargetLaneCount) { break }

            $item = $null
            if (-not $WorkQueue.TryDequeue([ref]$item)) { break }

            $relFromRoot = $item.RelativeFromRoot
            $leafName = if ($IsFsSource) { $item.TargetName } else { $item.Name }
            $relKey = if ($relFromRoot) { "$relFromRoot/$leafName" } else { $leafName }
            $targetRelPath = "$TargetOneDrivePathRoot/$relKey".Trim('/').Replace('//', '/')
            $sourceDisplayPath = if ($IsFsSource) {
                Join-Path $item.SourceFolder $item.Name
            } else {
                "$SourceSiteServerRelative/$SourceRoot/$relFromRoot/$($item.Name)".Replace('//', '/')
            }
            $targetDisplayPath = "onedrive:/$targetRelPath"

            $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_start' -Data @{
                sourcePath = $sourceDisplayPath; targetPath = $targetDisplayPath; itemType = 'file'; bytes = [long]$item.Size
            }))
            if ($IsFsSource -and $item.Renamed) {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'log' -Data @{
                    level = 'warn'; message = "'$($item.Name)' is not a legal SharePoint/OneDrive name - uploading as '$($item.TargetName)'."
                }))
            }

            # Skip/delta check: prefer the prefetched target index (memory
            # lookup, zero network) - same rule as every other lane: same size
            # AND target at least as new as the source. Falls back to a
            # single per-file Graph GET (Test-OneDriveTargetMatches) when the
            # prefetch itself failed, same as the other lanes already do.
            $alreadyDone = $false
            if ($null -ne $TargetFileMap) {
                $existing = $TargetFileMap[$relKey]
                $alreadyDone = $existing -and
                    ([long]$existing.Size -eq [long]$item.Size) -and
                    (-not $item.Modified -or -not $existing.Modified -or ([datetime]$existing.Modified).AddSeconds(5) -ge [datetime]$item.Modified)
            } else {
                $alreadyDone = Test-OneDriveTargetMatches -Connection $laneOneDriveConn -DriveId $TargetDriveId `
                    -RelPath $targetRelPath -ExpectedSize $item.Size -SourceModified $item.Modified
            }

            if ($alreadyDone) {
                $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_skipped' -Data @{
                    sourcePath = $sourceDisplayPath; targetPath = $targetDisplayPath; bytes = [long]$item.Size
                    reason     = 'target already has a file of the same name and size'
                }))
            } else {
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $script:attemptsUsed = 0
                $inflight = [hashtable]::Synchronized(@{
                    SourcePath = $sourceDisplayPath; TargetPath = $targetDisplayPath
                    Total = [long]$item.Size; Phase = $(if ($IsFsSource) { 'uploading' } else { 'downloading' }); BytesDone = [long]0; TempPath = $null
                })
                $Shared.InFlight[$LaneIndex] = $inflight
                # GetNewClosure: same reason as the blob lane - scriptblocks
                # resolve variables dynamically at the CALL site (inside
                # OneDriveTarget.psm1's module scope, where $inflight doesn't
                # exist) - the closure pins this iteration's reference.
                $progress = {
                    param($phase, $bytes, $temp = $null)
                    $inflight.Phase = $phase
                    $inflight.BytesDone = [long]$bytes
                    if ($temp) { $inflight.TempPath = $temp }
                }.GetNewClosure()
                try {
                    Invoke-WithRetry -MaxAttempts 5 -Action {
                        if ($IsFsSource) {
                            $localPath = Join-Path $item.SourceFolder $item.Name
                            Send-GraphDriveFile -Connection $laneOneDriveConn -TempPath $localPath -DriveId $TargetDriveId -RelPath $targetRelPath `
                                -Created $item.Created -Modified $item.Modified -OnProgress $progress -ChunkSizeBytes $OneDriveChunkSizeBytes
                        } else {
                            # Drive-addressed Graph fallback for the download:
                            # kicks in for %/# names (which Get-PnPFile cannot
                            # fetch at all) and after any Get-PnPFile failure.
                            # Unavailable (null) only if the prefetch couldn't
                            # resolve the source drive id.
                            $graphSource = if ($SrcDriveId) {
                                @{ DriveId = $SrcDriveId; RelPath = "$SourcePathInLib/$relFromRoot/$($item.Name)".Trim('/').Replace('//', '/') }
                            } else { $null }
                            Save-OneDriveFileFromSharePoint -SourceConnection $laneSourceConn -SourceServerRelativeUrl $sourceDisplayPath `
                                -TargetConnection $laneOneDriveConn -TargetDriveId $TargetDriveId -TargetRelPath $targetRelPath `
                                -GraphSource $graphSource -OnProgress $progress -ChunkSizeBytes $OneDriveChunkSizeBytes
                        }
                    } -OnRetry {
                        param($attempt, $waitMs, $reason, $statusCode, $message)
                        $script:attemptsUsed = $attempt
                        $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_retry' -Data @{
                            sourcePath = $sourceDisplayPath; targetPath = $targetDisplayPath
                            attempt    = $attempt; reason = $reason; waitMs = $waitMs; httpStatus = $statusCode
                        }))
                    }

                    $sw.Stop()
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_success' -Data @{
                        sourcePath = $sourceDisplayPath; targetPath = $targetDisplayPath
                        bytes      = [long]$item.Size; durationMs = [int]$sw.ElapsedMilliseconds; httpStatus = 200
                    }))
                } catch {
                    $sw.Stop()
                    $statusCode = Get-HttpStatusCode -Exception $_.Exception
                    $ResultQueue.Enqueue((New-EngineEventJson -Type 'item_failed' -Data @{
                        sourcePath = $sourceDisplayPath; targetPath = $targetDisplayPath
                        # Prefix the .NET exception type: a bare message like
                        # "Nullable object must have a value" is unactionable,
                        # but "InvalidOperationException: ..." pins down where
                        # it came from for the next round of diagnosis.
                        error      = "$($_.Exception.GetType().Name): $($_.Exception.Message)"; httpStatus = $statusCode; retryCount = $script:attemptsUsed
                    }))
                } finally {
                    $null = $Shared.InFlight.Remove($LaneIndex)
                }
            }

            $ctrl = Read-Control -Path $ControlFilePath
            if ($ctrl.cancelRequested) { $Shared.Cancelled = $true; $Shared.Stop = $true; break }
            if ($ctrl.pauseRequested) { $Shared.Paused = $true; $Shared.Stop = $true; break }
        }

        try { if ($laneSourceConn) { Disconnect-PnPOnline -Connection $laneSourceConn } } catch {}
        try { if ($IsFsSource -and $laneOneDriveConn) { Disconnect-PnPOnline -Connection $laneOneDriveConn } } catch {}
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
        Import-Module "$using:PSScriptRoot/lib/UserAgent.psm1"
        Initialize-MigrationUserAgent
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
        $laneTargetConn = Connect-PnPOnline -Url $TargetSiteUrl -ClientId $ClientId -Tenant $TenantId @certArgs -ReturnConnection | Register-PnPUserAgent

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
                    (-not $item.Modified -or -not $existing.Modified -or ([datetime]$existing.Modified).AddSeconds(5) -ge [datetime]$item.Modified)
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
                            $tgtItem = try { Get-PnPFile -Url $targetFileServerRel -AsListItem -Connection $laneTargetConn -ErrorAction Stop } catch {
                                # Literal %XX in a name defeats Get-PnPFile's URL decoding - look the item up by exact path.
                                Get-PnPListItem -List $laneTargetList -Query "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$([System.Security.SecurityElement]::Escape($targetFileServerRel))</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>" -Connection $laneTargetConn -ErrorAction Stop | Select-Object -First 1
                            }
                            if (-not $tgtItem -or -not $tgtItem.Id) {
                                $tgtItem = Get-PnPListItem -List $laneTargetList -Query "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$([System.Security.SecurityElement]::Escape($targetFileServerRel))</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>" -Connection $laneTargetConn -ErrorAction Stop | Select-Object -First 1
                            }
                            if (-not $tgtItem) { throw "target item not found: $targetFileServerRel" }
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
                                $tgtItem = try { Get-PnPFile -Url $targetFileServerRel -AsListItem -Connection $laneTargetConn -ErrorAction Stop } catch {
                                    # Literal %XX in a name defeats Get-PnPFile's URL decoding - look the item up by exact path.
                                    Get-PnPListItem -List $laneTargetList -Query "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$([System.Security.SecurityElement]::Escape($targetFileServerRel))</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>" -Connection $laneTargetConn -ErrorAction Stop | Select-Object -First 1
                                }
                                if (-not $tgtItem -or -not $tgtItem.Id) {
                                    $tgtItem = Get-PnPListItem -List $laneTargetList -Query "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$([System.Security.SecurityElement]::Escape($targetFileServerRel))</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>" -Connection $laneTargetConn -ErrorAction Stop | Select-Object -First 1
                                }
                                if (-not $tgtItem) { throw "target item not found: $targetFileServerRel" }
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
        if ($isOneDriveTarget) {
            $lanes += Start-ThreadJob -ScriptBlock $laneScriptOneDrive -ArgumentList @(
                $i, $workQueue, $resultQueue, $shared, $isFsSource, $ClientId, $TenantId,
                $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath,
                $SourceSiteUrl, $sourceSiteServerRelative, $sourceRoot, $SourcePath, $srcDriveId,
                $TargetOneDriveHostUrl, $oneDriveCtx.DriveId, $oneDriveCtx.PathRoot, $targetFileMap,
                $oneDriveChunkSizeBytes
            )
        } elseif ($isFsSource) {
            $lanes += Start-ThreadJob -ScriptBlock $laneScriptFileUpload -ArgumentList @(
                $i, $workQueue, $resultQueue, $shared, $effTargetSite, $ClientId, $TenantId,
                $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath,
                $targetSiteServerRelative, $targetRoot, $targetFileMap
            )
        } elseif ($isBlobTarget) {
            $lanes += Start-ThreadJob -ScriptBlock $laneScriptBlob -ArgumentList @(
                $i, $workQueue, $resultQueue, $shared, $SourceSiteUrl, $ClientId, $TenantId,
                $CertThumbprint, $CertificateBase64Encoded, $CertificatePassword, $ControlFilePath, $sourceSiteServerRelative, $sourceRoot,
                $blobCtx.BlobEndpoint, $blobCtx.Container, $blobCtx.Sas, $blobCtx.Prefix, $targetFileMap, $sourceMetaMap, $SourcePath, $srcDriveId
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
        # --- Folder metadata + colours (SharePoint -> SharePoint) ----------
        # Target folders were created fresh before the copy, so they carry
        # the migration app as created/modified-by, today's dates and the
        # default colour. Copy each source folder's own stamp and colour
        # across now that the files are in (adding files can bump a folder's
        # Modified). Skips folders whose copy already matches, so re-running
        # an already-migrated job is how existing targets get backfilled.
        # Never fails the job.
        if (-not $isFsSource -and -not $isBlobTarget -and -not $isOneDriveTarget) {
            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Restoring original created/modified-by, dates and colours on $($tree.Folders.Count + [int][bool]$SourcePath.Trim('/')) target folder(s)..." }
            $folderWarnings = 0
            try {
                $folderMeta = Copy-PnPFolderMetadata -SourceConnection $sourceConn -TargetConnection $targetConn `
                    -SourceRootSiteRelativeUrl $sourceRoot -TargetRootSiteRelativeUrl $targetRoot `
                    -RelativeFolderPaths $tree.Folders -IncludeRoot:([bool]$SourcePath.Trim('/')) -OnProgress {
                        param($done, $total)
                        Write-PhaseProgress -Phase 'stamping_folders' -Data @{ done = $done; total = $total }
                    } -OnWarning {
                        param($message)
                        $script:folderWarnings++
                        # Cap the per-folder noise; the summary line has the totals.
                        if ($script:folderWarnings -le 50) { Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = $message } }
                    }
                $level = if ($folderMeta.Failed -gt 0) { 'warn' } else { 'info' }
                Write-EngineEvent -Type 'log' -Data @{ level = $level; message = "Folder metadata: $($folderMeta.Updated) folder(s) updated ($($folderMeta.Coloured) with a colour), $($folderMeta.AlreadyCorrect) already correct, $($folderMeta.PeopleDropped) without created/modified-by (person not found on the target), $($folderMeta.Failed) failed." }
            } catch {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Could not restore folder metadata/colours: $($_.Exception.Message). Files are unaffected; re-run the job to retry." }
            }
        }

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

        # The repair pass downloads source bytes via Graph wherever possible
        # (encoding-proof - see Save-GraphFileToPath); resolve the source
        # drive id now if the prefetch didn't get the chance.
        if ($verifyOut -and -not $verifyOut.Summary.ok -and -not $isFsSource -and -not $srcDriveId) {
            try { $srcDriveId = Get-GraphDriveId -Connection $sourceConn -SiteUrl $SourceSiteUrl -Library $SourceLibrary } catch {}
        }

        # Up to 3 verify->repair->verify rounds. Round 1 re-runs the
        # server-side copy; round 2 always follows with the escalated stream
        # copy below (download + upload of the exact bytes), even when round 1
        # fixed nothing - a server-side copy that keeps producing the same bad
        # result is exactly the case the stream copy exists for. From round 3
        # on, a round only runs while the problem count strictly decreases, so
        # files nothing can fix stop the loop instead of spinning.
        $prevProblemCount = [int]::MaxValue
        $repairTargetList = $null
        for ($repairRound = 1; $repairRound -le 3 -and $verifyOut -and -not $verifyOut.Summary.ok; $repairRound++) {
            $problemPaths = @($verifyOut.Result.Missing) + @($verifyOut.Result.SizeMismatch) + @($verifyOut.Result.HashMismatch)
            if ($repairRound -gt 2 -and $problemPaths.Count -ge $prevProblemCount) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Repair made no further progress - $($problemPaths.Count) file(s) still fail verification (listed on the job). Re-running the job retries only these files." }
                break
            }
            $prevProblemCount = $problemPaths.Count
            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Repair round ${repairRound}: attempting re-copy of $($problemPaths.Count) file(s) that failed verification..." }
            # rel path -> @{ SrcRel; Size } for each file whose re-copy call
            # succeeded this round. Deliberately NOT reported as item_success
            # yet: a copy call can "succeed" while still leaving verification
            # broken (observed live: SharePoint's server-side copy endpoint
            # URL-decodes names, so a file literally named 'a%20b.pptx' lands
            # as 'a b.pptx' - the copy reports OK, the %20 name stays
            # missing). Only files the follow-up verification confirms fixed
            # get counted as repaired.
            $attempted = @{}
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
                    if ($isOneDriveTarget) {
                        Invoke-WithRetry -MaxAttempts 3 -Action {
                            $relPath = "$($oneDriveCtx.PathRoot)/$rel".Trim('/').Replace('//', '/')
                            if ($isFsSource) {
                                Send-GraphDriveFile -Connection $oneDriveCtx.Connection -TempPath $srcRel -DriveId $oneDriveCtx.DriveId -RelPath $relPath -ChunkSizeBytes $oneDriveChunkSizeBytes
                            } else {
                                $graphSource = if ($srcDriveId) {
                                    @{ DriveId = $srcDriveId; RelPath = (Get-BlobKey -Segments @($SourcePath, $relFromRoot, $file.Name)) }
                                } else { $null }
                                Save-OneDriveFileFromSharePoint -SourceConnection $sourceConn -SourceServerRelativeUrl $srcRel `
                                    -TargetConnection $oneDriveCtx.Connection -TargetDriveId $oneDriveCtx.DriveId -TargetRelPath $relPath `
                                    -GraphSource $graphSource -ChunkSizeBytes $oneDriveChunkSizeBytes | Out-Null
                            }
                        }
                    } elseif ($isFsSource) {
                        Invoke-WithRetry -MaxAttempts 3 -Action {
                            $tgtFolderSiteRel = "$targetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
                            $repairStream = [System.IO.File]::OpenRead($srcRel)
                            try {
                                Add-PnPFile -FileName $file.TargetName -Folder $tgtFolderSiteRel -Stream $repairStream -Connection $targetConn -ErrorAction Stop | Out-Null
                            } finally {
                                $repairStream.Dispose()
                            }
                        }
                    } elseif ($isBlobTarget) {
                        Invoke-WithRetry -MaxAttempts 3 -Action {
                            $blobKey = Get-BlobKey -Segments @($blobCtx.Prefix, $relFromRoot, $file.Name)
                            $graphSource = if ($srcDriveId) {
                                @{ DriveId = $srcDriveId; RelPath = (Get-BlobKey -Segments @($SourcePath, $relFromRoot, $file.Name)) }
                            } else { $null }
                            Save-BlobFromSharePointFile -SourceConnection $sourceConn -SourceServerRelativeUrl $srcRel `
                                -BlobEndpoint $blobCtx.BlobEndpoint -Container $blobCtx.Container -Sas $blobCtx.Sas -BlobKey $blobKey `
                                -GraphSource $graphSource | Out-Null
                        }
                    } else {
                        # SP->SP repair ladder: server-side Copy-PnPFile first
                        # (fast, no bytes through the engine), stream
                        # download/upload as the fallback. Names containing %
                        # or # skip straight to the stream path - the
                        # server-side endpoint mangles them (see above) - as
                        # does any file still broken after a Copy-PnPFile
                        # round: repeating the exact call that already failed
                        # to stick would loop forever.
                        $useStreamCopy = ($file.Name -match '[%#]') -or ($repairRound -gt 1)
                        if (-not $useStreamCopy) {
                            try {
                                Invoke-WithRetry -MaxAttempts 3 -Action {
                                    $tgtFolderRel = "$targetSiteServerRelative/$targetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
                                    Copy-PnPFile -SourceUrl $srcRel -TargetUrl "$(Get-CrossHostTargetPrefix -SourceSiteUrl $SourceSiteUrl -TargetSiteUrl $effTargetSite)$tgtFolderRel" -Force -OverwriteIfAlreadyExists -Connection $sourceConn -ErrorAction Stop
                                }
                            } catch {
                                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Server-side re-copy failed for '$rel' ($($_.Exception.Message)) - retrying as a stream copy..." }
                                $useStreamCopy = $true
                            }
                        }
                        if ($useStreamCopy) {
                            # Add-PnPFile sets the target name as a CSOM
                            # property rather than a URL segment, so names
                            # that break the server-side copy survive intact.
                            # Staged through a temp file, not memory - repair
                            # candidates can be multi-GB videos.
                            Invoke-WithRetry -MaxAttempts 3 -Action {
                                $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('mig-repair-' + [guid]::NewGuid().ToString('N'))
                                $null = New-Item -ItemType Directory -Path $tmpDir -Force
                                try {
                                    # Get-PnPFile decodes %XX in the URL and
                                    # fetches the wrong name - download via
                                    # Graph whenever the drive id is known.
                                    if ($srcDriveId) {
                                        Save-GraphFileToPath -Connection $sourceConn -DriveId $srcDriveId `
                                            -RelPath (Get-BlobKey -Segments @($SourcePath, $relFromRoot, $file.Name)) `
                                            -OutFile (Join-Path $tmpDir $file.Name)
                                    } else {
                                        Get-PnPFile -Url $srcRel -Path $tmpDir -Filename $file.Name -AsFile -Force -Connection $sourceConn -ErrorAction Stop
                                    }
                                    $repairStream = [System.IO.File]::OpenRead((Join-Path $tmpDir $file.Name))
                                    try {
                                        $tgtFolderWebRel = "$targetRoot/$relFromRoot".TrimEnd('/').Replace('//', '/')
                                        Add-PnPFile -FileName $file.Name -Folder $tgtFolderWebRel -Stream $repairStream -Connection $targetConn -ErrorAction Stop | Out-Null
                                    } finally {
                                        $repairStream.Dispose()
                                    }
                                } finally {
                                    Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
                                }
                            }
                        }
                    }
                    # A re-copy lands with the app as author and "now" as its
                    # dates - put the original metadata back, like the copy
                    # lanes do (SharePoint -> SharePoint only; the metadata
                    # comes from the prefetched source walk).
                    if (-not $isFsSource -and -not $isBlobTarget -and -not $isOneDriveTarget -and $sourceMetaMap -and $sourceMetaMap[$rel]) {
                        try {
                            if (-not $repairTargetList) { $repairTargetList = Get-PnPList -Identity (($targetRoot -split '/')[0]) -Connection $targetConn -ErrorAction Stop }
                            $m = $sourceMetaMap[$rel]
                            $vals = @{}
                            if ($m.Created) { $vals['Created'] = $m.Created }
                            if ($m.Modified) { $vals['Modified'] = $m.Modified }
                            $ppl = @{}
                            if ($m.AuthorEmail) { $ppl['Author'] = $m.AuthorEmail }
                            if ($m.EditorEmail) { $ppl['Editor'] = $m.EditorEmail }
                            $tgtFileRel = "$targetSiteServerRelative/$targetRoot/$rel".Replace('//', '/')
                            $esc = [System.Security.SecurityElement]::Escape($tgtFileRel)
                            $li = Get-PnPListItem -List $repairTargetList -Query "<View Scope='RecursiveAll'><Query><Where><Eq><FieldRef Name='FileRef'/><Value Type='Text'>$esc</Value></Eq></Where></Query><RowLimit>1</RowLimit></View>" -Connection $targetConn -ErrorAction Stop | Select-Object -First 1
                            if ($li -and ($vals.Count + $ppl.Count) -gt 0) {
                                try { Set-PnPListItem -List $repairTargetList -Identity $li.Id -Values ($vals + $ppl) -Connection $targetConn -ErrorAction Stop | Out-Null }
                                catch { if ($vals.Count) { Set-PnPListItem -List $repairTargetList -Identity $li.Id -Values $vals -Connection $targetConn -ErrorAction Stop | Out-Null } }
                            }
                        } catch {
                            Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Re-copied '$rel' but could not restore its original dates/people: $($_.Exception.Message)" }
                        }
                    }
                    $attempted[$rel] = @{ SrcRel = $srcRel; Size = [long]$file.Size }
                    Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Re-copied after verification failure: $rel" }
                } catch {
                    Write-EngineEvent -Type 'log' -Data @{ level = 'error'; message = "Re-copy FAILED for '$rel': $($_.Exception.Message)" }
                }
            }
            if ($attempted.Count -eq 0) { break }

            Write-EngineEvent -Type 'log' -Data @{ level = 'info'; message = "Re-copied $($attempted.Count) file(s) - running verification again..." }
            $verifyOut = Invoke-VerificationPhase @verifyArgs
            if (-not $verifyOut) {
                Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Could not re-verify after the repairs - the $($attempted.Count) re-copied file(s) stay marked failed until a verification confirms them (use the job's Verify button)." }
                break
            }
            $verification = $verifyOut.Summary

            # Confirm repairs against the fresh verification: only files that
            # dropped off the problem list emit item_success (a real event,
            # not just a log line, so Node moves them from failed to done).
            $stillBroken = [System.Collections.Generic.HashSet[string]]::new(
                [string[]](@($verifyOut.Result.Missing) + @($verifyOut.Result.SizeMismatch) + @($verifyOut.Result.HashMismatch))
            )
            foreach ($rel in $attempted.Keys) {
                if (-not $stillBroken.Contains($rel)) {
                    Write-EngineEvent -Type 'item_success' -Data @{
                        sourcePath = $attempted[$rel].SrcRel; targetPath = ''; itemType = 'file'
                        bytes = $attempted[$rel].Size; durationMs = 0; httpStatus = 200
                    }
                }
            }
        }

        if ($CopyPermissionsPath) {
            try { & $runPermissionCopy }
            catch { Write-EngineEvent -Type 'log' -Data @{ level = 'warn'; message = "Copy item permissions could not finish (the copied files are unaffected): $($_.Exception.Message)" } }
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
