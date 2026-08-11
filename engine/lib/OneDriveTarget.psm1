#Requires -Version 7.0

# Microsoft Graph primitives for the "migrate into a specific user's OneDrive"
# target, mirroring the role BlobTarget.psm1 plays for the Azure Blob target:
# small composable functions, no orchestration.
#
# Why this can't reuse the SharePoint-target code path (Copy-PnPFile,
# Add-PnPFile, Initialize-PnPTargetFolders, ...): those cmdlets authenticate
# against the SharePoint Online RESOURCE (a distinct AAD app-role audience
# from Microsoft Graph). The whole reason this target exists is that
# Sites.Selected (the SharePoint Online app role every other target relies
# on) does not reliably extend to personal OneDrive site collections - so
# this target is deliberately granted Microsoft Graph's Files.ReadWrite.All
# instead. A Graph-only permission grants ZERO access to SharePoint's own
# CSOM/REST surface, so every OneDrive read/write here goes through Graph
# endpoints (Invoke-PnPGraphMethod, which uses the connection's separately-
# cached GRAPH-audience token - same mechanism Verification.psm1's
# Get-GraphDriveId/Get-GraphFileMap already rely on to query sites/drives
# beyond whichever one -Url originally connected to).
#
# NO -Force. See BlobTarget.psm1's identical note: a forced re-import from
# inside a module first REMOVES the already-loaded Retry module out from
# under every runspace that imported it.
Import-Module "$PSScriptRoot/Retry.psm1"

# Every non-empty file is uploaded via a resumable upload session (see
# Send-GraphDriveFile for why the simpler small-file content PUT is avoided).
# Session chunks must be a multiple of 320 KiB except the final one - 5 MiB
# (16 * 320 KiB) satisfies that exactly. Send-GraphDriveFile's own
# -ChunkSizeBytes parameter (server-configurable via
# ONEDRIVE_UPLOAD_CHUNK_SIZE_MB) is what every real caller actually uses -
# this is only the fallback for a direct/manual invocation that omits it.
$script:OneDriveChunkSizeBytes = 5 * 1024 * 1024

# Shared with BlobTarget.psm1's $script:BlobTempRoot by convention (same
# physical folder, generic name) rather than a second temp root - both
# targets stage transiting content there and Invoke-MigrationJob.ps1 sweeps
# it once at startup (Clear-StaleBlobTempFiles) regardless of which target a
# job uses.
$script:OneDriveTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'spmigrator-tmp'

# Each '/'-delimited segment of a Graph drive-relative path must be
# percent-encoded on its own - escaping the whole path at once would also
# encode the '/' separators (as %2F), breaking path-addressed Graph calls
# like ".../root:/{path}:/content". Deliberately duplicated rather than
# imported from BlobTarget.psm1 (which has the identical
# ConvertTo-BlobEscapedKey) - same choice Verification.psm1 already made
# with its own ConvertTo-GraphEscapedPath, keeping each target module
# independently loadable.
function ConvertTo-GraphDrivePath {
    param([string]$Path)
    (($Path -split '/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
}

# Resolves the target user's default drive id from their UPN. Distinguishes
# "user has no OneDrive" (404 - not licensed, or never signed in to
# provision one) from any other failure, since that is the single most
# likely misconfiguration an operator will hit.
function Get-OneDriveDriveId {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$Upn
    )
    try {
        $drive = Invoke-PnPGraphMethod -Url "v1.0/users/$([uri]::EscapeDataString($Upn))/drive" -Connection $Connection -ErrorAction Stop
    } catch {
        $status = Get-HttpStatusCode -Exception $_.Exception
        if ($status -eq 404) {
            throw "No OneDrive found for '$Upn' - they may not be licensed for OneDrive, or have never signed in to provision it."
        }
        throw
    }
    if (-not $drive.id) { throw "Microsoft Graph returned no drive id for '$Upn'." }
    return $drive.id
}

# Per-file existence/match fallback for when the bulk target-index prefetch
# (Get-GraphFileMap) is unavailable - mirrors BlobTarget.psm1's
# Test-BlobTargetMatches, which every OTHER lane already falls back to in
# this situation. The OneDrive lane used to have no equivalent at all and
# would blindly re-upload every remaining file instead - "safe" (Graph's
# conflictBehavior=replace just overwrites identically) but, on a large
# tree, catastrophically wasteful: a single bad page deep into a 27,000-file
# prefetch (observed live: a JSON parse error from Invoke-PnPGraphMethod,
# "Failure to parse near offset 178. Expected an ASCII digit") aborted the
# WHOLE prefetch and re-uploaded everything after that point, including
# many-hundred-MB files already sitting correctly at the target. A single
# GET by path (not a full listing) - 404 cleanly means "not there yet".
function Test-OneDriveTargetMatches {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][string]$RelPath,
        [Parameter(Mandatory)][long]$ExpectedSize,
        $SourceModified = $null
    )
    try {
        $item = Invoke-PnPGraphMethod -Url "v1.0/drives/$DriveId/root:/$(ConvertTo-GraphDrivePath -Path $RelPath)?`$select=size,lastModifiedDateTime" -Connection $Connection -ErrorAction Stop
    } catch {
        return $false
    }
    if ([long]$item.size -ne $ExpectedSize) { return $false }
    if ($SourceModified -and $item.lastModifiedDateTime) {
        if ([datetime]$item.lastModifiedDateTime -lt [datetime]$SourceModified) { return $false }
    }
    return $true
}

# Ensures every folder under the drive that the migration needs exists:
# $TargetRootPath itself AND all of its own ancestor segments, then every
# entry in $RelativeFolderPaths (each relative to the root). Created shallow-
# to-deep so a parent always exists before its child - the relative list is
# the source tree's breadth-first folder order (already parent-first), and the
# root's own ancestor chain is expanded here so a multi-segment target prefix
# like "Migrated/2024/Documents" doesn't try to create the leaf under a
# "Migrated/2024" that was never made (which 404s and fails the whole job).
#
# conflictBehavior=fail (NOT replace): an existing folder comes back 409, which
# we treat as "already there". Replace is deliberately avoided - for a folder
# it is not a documented safe no-op and can delete the folder's existing
# CHILDREN, which on a resume that re-runs folder pre-creation (its cache
# expired) would wipe already-uploaded files. fail + catch-409 never touches an
# existing folder's contents.
function Initialize-GraphDriveFolders {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][AllowEmptyString()][string]$TargetRootPath,
        [Parameter(Mandatory)][AllowEmptyString()][string[]]$RelativeFolderPaths,
        [scriptblock]$OnProgress
    )
    $root = $TargetRootPath.Trim('/')
    $allPaths = [System.Collections.Generic.List[string]]::new()
    # The root's own ancestor chain, shallow-first: "A/B/C" -> A, A/B, A/B/C.
    if ($root) {
        $acc = ''
        foreach ($seg in ($root -split '/')) {
            if (-not $seg) { continue }
            $acc = if ($acc) { "$acc/$seg" } else { $seg }
            $allPaths.Add($acc)
        }
    }
    foreach ($p in $RelativeFolderPaths) {
        if (-not $p) { continue }
        $allPaths.Add($(if ($root) { "$root/$p" } else { $p }))
    }
    $done = 0
    $total = $allPaths.Count
    foreach ($path in $allPaths) {
        $trimmed = $path.Trim('/')
        if (-not $trimmed) { continue }
        $parent = if ($trimmed.Contains('/')) { $trimmed.Substring(0, $trimmed.LastIndexOf('/')) } else { '' }
        $leaf = ($trimmed -split '/')[-1]
        $parentUrl = if ($parent) {
            "v1.0/drives/$DriveId/root:/$(ConvertTo-GraphDrivePath -Path $parent):/children"
        } else {
            "v1.0/drives/$DriveId/root/children"
        }
        try {
            Invoke-PnPGraphMethod -Connection $Connection -Method Post -Url $parentUrl -Content (@{
                name                                = $leaf
                folder                              = @{}
                '@microsoft.graph.conflictBehavior' = 'fail'
            }) -ErrorAction Stop | Out-Null
        } catch {
            # 409 = the folder already exists, which is exactly what we want.
            $status = Get-HttpStatusCode -Exception $_.Exception
            if ($status -ne 409) { throw "Could not create OneDrive folder '$trimmed': $($_.Exception.Message)" }
        }
        $done++
        if ($OnProgress) { & $OnProgress $done $total }
    }
}

# Uploads a local file's bytes into a drive at a drive-root-relative path,
# always through Graph's resumable upload SESSION for any non-empty file:
# createUploadSession, then PUT 5 MiB-aligned chunks with Content-Range
# directly against the session's own pre-authenticated uploadUrl (no
# Authorization header on those - same "the URL itself carries the signed
# access" contract BlobTarget.psm1's Save-GraphFileToPath relies on).
#
# It deliberately does NOT use the simpler "PUT :/content with -Content
# <byte[]>" via Invoke-PnPGraphMethod for small files. That path does NOT send
# the raw bytes - the cmdlet mangles a byte[] body - so the file lands at the
# WRONG size/content while the PUT still returns success: silent corruption
# (found live: a file-share -> OneDrive run reported 447 files "copied", then
# verification caught 368 of them with mismatched sizes - every corrupted one
# was a small file that took that path, while the large files, already on this
# session path, were byte-identical). The session PUTs send the raw byte[] with
# Invoke-WebRequest -Body, verified byte-for-byte correct, so every real file
# goes through it regardless of size. The one exception is a 0-byte file, which
# a session cannot express (no range to send) - it gets an explicit
# empty-content PUT, where there are no bytes to corrupt.
function Send-GraphDriveFile {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$TempPath,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][string]$RelPath,
        # Original source timestamps to stamp onto the OneDrive copy so migrated
        # files keep their real dates instead of showing the migration time
        # (the SharePoint and Blob targets preserve these too). Optional - null
        # just leaves OneDrive's own upload-time values. Applied via the upload
        # session's fileSystemInfo, so no extra request.
        $Created = $null,
        $Modified = $null,
        # Invoked with ('uploading', <cumulative bytes sent>) after each
        # staged chunk - small single-PUT files finish too fast to matter.
        [scriptblock]$OnProgress,
        # Server-configurable (ONEDRIVE_UPLOAD_CHUNK_SIZE_MB) - see
        # Invoke-MigrationJob.ps1's -OneDriveChunkSizeMB. Falls back to the
        # original hardcoded 5 MiB for any direct/manual caller (e.g. tests)
        # that doesn't pass one.
        [long]$ChunkSizeBytes = $script:OneDriveChunkSizeBytes
    )
    $itemPath = "v1.0/drives/$DriveId/root:/$(ConvertTo-GraphDrivePath -Path $RelPath)"
    # -LiteralPath: filenames legitimately contain [ and ] (PowerShell wildcard
    # metacharacters) - -Path would mis-glob them and fail to find the file.
    $fileInfo = Get-Item -LiteralPath $TempPath

    # 0-byte file: an upload session has no byte range to send, so it needs a
    # plain content PUT - but NOT via Invoke-PnPGraphMethod, whose byte[] body
    # handling is exactly what corrupts non-empty small files (an empty byte[]
    # would likely land as a "[]"-shaped 2-byte file, not 0 bytes). Send a
    # genuinely empty body straight to Graph with our own Invoke-WebRequest,
    # authorized with the connection's Graph token. -InFile on a 0-byte file
    # sends nothing, producing a true 0-byte item.
    if ($fileInfo.Length -eq 0) {
        # Get-PnPGraphAccessToken doesn't exist in PnP.PowerShell (the
        # correct cmdlet is Get-PnPAccessToken -ResourceTypeName Graph) -
        # calling the wrong name doesn't just fail cleanly, it makes
        # PowerShell's command resolution fall back to searching every OTHER
        # installed module for a same-named command, which on a machine that
        # also has the old deprecated SharePointPnPPowerShellOnline module
        # installed finds ITS same-named cmdlet and tries to load THAT
        # module instead - which then fails outright from an assembly
        # version clash with the already-loaded PnP.PowerShell. Only ever
        # hit on a 0-byte file (the one path that needs a raw bearer token
        # instead of going through Invoke-PnPGraphMethod), so it went
        # unnoticed until a real migration's source tree finally included one.
        $graphToken = Get-PnPAccessToken -ResourceTypeName Graph -Connection $Connection
        Invoke-WebRequest -Uri "https://graph.microsoft.com/${itemPath}:/content" -Method Put `
            -Headers @{ Authorization = "Bearer $graphToken" } -InFile $TempPath `
            -ContentType 'application/octet-stream' -ErrorAction Stop | Out-Null
        return
    }

    # Fast path for small files (Graph's own documented cutoff for the
    # simple, non-session upload): a single PUT straight to
    # graph.microsoft.com instead of createUploadSession + a chunk PUT
    # against a SEPARATE, session-specific uploadUrl host that changes on
    # every file. That host-hop matters: a lane processing many small files
    # in a row can reuse one warm connection across repeated calls to the
    # SAME host (graph.microsoft.com, here and for the timestamp PATCH
    # below), but can never reuse anything across the session path's
    # per-file uploadUrl, which pays a full fresh TLS handshake (measured
    # live: ~800ms cold vs ~200-300ms warm) on every single file regardless
    # of lane count or bandwidth. Falls through to the existing session path
    # on any failure rather than failing the file outright - this is a speed
    # optimization, not the only correct way to land the bytes.
    if ($fileInfo.Length -le 4MB) {
        try {
            $graphToken = Get-PnPAccessToken -ResourceTypeName Graph -Connection $Connection
            Invoke-WebRequest -Uri "https://graph.microsoft.com/${itemPath}:/content?`@microsoft.graph.conflictBehavior=replace" -Method Put `
                -Headers @{ Authorization = "Bearer $graphToken" } -InFile $TempPath `
                -ContentType 'application/octet-stream' -ErrorAction Stop | Out-Null
            if ($Created -or $Modified) {
                $fsInfo = @{}
                if ($Created) { $fsInfo.createdDateTime = ([datetime]$Created).ToUniversalTime().ToString('o') }
                if ($Modified) { $fsInfo.lastModifiedDateTime = ([datetime]$Modified).ToUniversalTime().ToString('o') }
                # Best-effort, same as the session path's own fileSystemInfo
                # handling - a file already landed correctly is never worth
                # failing over a timestamp-only follow-up call. It lands
                # with OneDrive's own upload-time stamp instead on failure.
                try {
                    Invoke-WebRequest -Uri "https://graph.microsoft.com/$itemPath" -Method Patch `
                        -Headers @{ Authorization = "Bearer $graphToken" } -Body (@{ fileSystemInfo = $fsInfo } | ConvertTo-Json -Compress) `
                        -ContentType 'application/json' -ErrorAction Stop | Out-Null
                } catch {}
            }
            if ($OnProgress) { & $OnProgress 'uploading' ([long]$fileInfo.Length) }
            return
        } catch {}
    }

    $uploadItem = @{ '@microsoft.graph.conflictBehavior' = 'replace' }
    $fsInfo = @{}
    # ISO 8601 with an explicit Z; the source tree hands us UTC DateTimes, and
    # ToUniversalTime keeps it correct even if a caller passes a local one.
    if ($Created) { $fsInfo.createdDateTime = ([datetime]$Created).ToUniversalTime().ToString('o') }
    if ($Modified) { $fsInfo.lastModifiedDateTime = ([datetime]$Modified).ToUniversalTime().ToString('o') }
    if ($fsInfo.Count -gt 0) { $uploadItem.fileSystemInfo = $fsInfo }

    try {
        $session = Invoke-PnPGraphMethod -Connection $Connection -Method Post -Url "${itemPath}:/createUploadSession" `
            -Content (@{ item = $uploadItem }) -ErrorAction Stop
    } catch {
        $status = Get-HttpStatusCode -Exception $_.Exception
        if ($status -eq 400 -and $fsInfo.Count -gt 0) {
            # Graph rejects some source files' Created/Modified values
            # outright with a generic "The request is malformed or
            # incorrect" and no further detail - observed live on an old
            # file-share source where a large fraction of files (copied
            # server-to-server over many years) have corrupted/out-of-range
            # NTFS timestamp metadata. Not transient (retrying the identical
            # request never helps), but the upload itself is fine without
            # fileSystemInfo - fall back to that once rather than failing
            # the file outright, at the cost of that file landing with
            # OneDrive's own upload-time stamp instead of its real one.
            $session = Invoke-PnPGraphMethod -Connection $Connection -Method Post -Url "${itemPath}:/createUploadSession" `
                -Content (@{ item = @{ '@microsoft.graph.conflictBehavior' = 'replace' } }) -ErrorAction Stop
        } elseif ($status -eq 409 -and $_.Exception.Message -match 'currently being uploaded') {
            # "A file with the same name is currently being uploaded" from
            # an EARLIER attempt at this exact path (interrupted mid-session
            # by a restart, cancel, or crash) can persist as a stale
            # reservation - conflictBehavior=replace only overrides a
            # COMPLETED item, never a still-open upload session, so blind
            # retries (Test-IsRetryableStatus does mark this retryable, for
            # the genuinely-transient case of another lane/process about to
            # finish) never resolve a truly stale one; they just fail
            # identically every time. Observed live: a single file surviving
            # a job's verification+repair pass with this exact error,
            # nothing else touching that path. Best-effort clear: delete
            # whatever's sitting at the path (even a partial/invisible item
            # a stale session left behind - Graph reserves the name before
            # any bytes are visible) and create a fresh session. A 404 on
            # the delete is expected and harmless when nothing visible is
            # there yet; if the reservation truly isn't tied to a deletable
            # item, this still throws and the caller's own retry/failure
            # handling takes over.
            try { Invoke-PnPGraphMethod -Connection $Connection -Method Delete -Url $itemPath -ErrorAction Stop | Out-Null } catch {}
            $session = Invoke-PnPGraphMethod -Connection $Connection -Method Post -Url "${itemPath}:/createUploadSession" `
                -Content (@{ item = $uploadItem }) -ErrorAction Stop
        } else {
            throw
        }
    }
    $uploadUrl = $session.uploadUrl
    if (-not $uploadUrl) { throw "Microsoft Graph did not return an upload session URL for '$RelPath'." }

    $stream = [System.IO.File]::OpenRead($TempPath)
    try {
        $total = [long]$fileInfo.Length
        $buffer = New-Object byte[] $ChunkSizeBytes
        [long]$offset = 0
        while ($offset -lt $total) {
            # Explicit [long] on BOTH arguments: PowerShell's overload binder
            # for [Math]::Min doesn't widen the way C# would - given one
            # Int32 arg (the chunk size) and one Int64 arg (bytes remaining),
            # it can bind to Min(Int32,Int32) and then try to NARROW the
            # Int64 down to fit, which throws outright once bytes-remaining
            # exceeds Int32.MaxValue (~2 GB). Forcing both to [long] pins the
            # Min(Int64,Int64) overload so the result (always <= chunk size)
            # is safe to narrow back to [int] afterwards. Observed live: a
            # 5.99 GB .pst file failed on its very first chunk with
            # "Cannot convert argument 'val2', with value: '5990237184' ...
            # to type System.Int32".
            $toRead = [int][Math]::Min([long]$ChunkSizeBytes, [long]($total - $offset))
            $read = $stream.Read($buffer, 0, $toRead)
            if ($read -le 0) { break }
            # Plain assignment, not an expression form - see BlobTarget.psm1's
            # Send-BlobFile for the documented Object[]-vs-byte[] trap this
            # avoids (a range-sliced or if-expression-assigned array silently
            # becomes Object[], which serializes as decimal text instead of
            # raw bytes and the target rejects the corrupted body).
            $chunk = $buffer
            if ($read -ne $buffer.Length) {
                $chunk = [byte[]]::new($read)
                [Array]::Copy($buffer, $chunk, $read)
            }
            $rangeEnd = $offset + $read - 1
            Invoke-WebRequest -Uri $uploadUrl -Method Put `
                -Headers @{ 'Content-Range' = "bytes $offset-$rangeEnd/$total" } `
                -Body $chunk -ContentType 'application/octet-stream' -ErrorAction Stop | Out-Null
            $offset += $read
            if ($OnProgress) { & $OnProgress 'uploading' ([long]$offset) }
        }
    } finally {
        $stream.Dispose()
    }
}

# Downloads a SharePoint file's bytes via Graph, addressed by drive id +
# drive-root-relative path with each segment percent-encoded on its own -
# the encoding-proof fallback for filenames containing % or # (see
# BlobTarget.psm1's Save-GraphFileToPath, which this duplicates rather than
# imports, for the same module-independence reason as ConvertTo-GraphDrivePath
# above). Streams straight from the item's short-lived pre-authenticated
# @microsoft.graph.downloadUrl to disk - no auth header, no memory buffering.
function Save-OneDriveSourceFileToPath {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][string]$RelPath,
        [Parameter(Mandatory)][string]$OutFile
    )
    $item = Invoke-PnPGraphMethod -Url "v1.0/drives/$DriveId/root:/$(ConvertTo-GraphDrivePath -Path $RelPath)" -Connection $Connection
    $downloadUrl = $item.'@microsoft.graph.downloadUrl'
    if (-not $downloadUrl) { throw "Graph returned no downloadUrl for '$RelPath' (drive $DriveId)." }
    Invoke-WebRequest -Uri $downloadUrl -OutFile $OutFile -ErrorAction Stop | Out-Null
}

# Per-file copy orchestration for a SharePoint SOURCE: downloads the source
# file to a temp path via the caller's existing PnP connection (CSOM, with
# the Graph encoding-proof fallback above for %/# names), then uploads it
# into the target OneDrive, always cleaning up the temp file regardless of
# outcome. A filesystem source needs no equivalent - its lane already has the
# file open locally and calls Send-GraphDriveFile directly.
function Save-OneDriveFileFromSharePoint {
    param(
        [Parameter(Mandatory)]$SourceConnection,
        [Parameter(Mandatory)][string]$SourceServerRelativeUrl,
        [Parameter(Mandatory)]$TargetConnection,
        [Parameter(Mandatory)][string]$TargetDriveId,
        [Parameter(Mandatory)][string]$TargetRelPath,
        # Optional @{ DriveId; RelPath } (drive-root-relative, decoded) for
        # the source: taken directly for names containing % or # (Get-PnPFile
        # cannot fetch those at all), and as the fallback after any
        # Get-PnPFile failure.
        [hashtable]$GraphSource,
        [scriptblock]$OnProgress,
        [long]$ChunkSizeBytes = $script:OneDriveChunkSizeBytes
    )
    $tempDir = $script:OneDriveTempRoot
    if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }
    $tempName = "$([guid]::NewGuid()).tmp"
    $tempPath = [System.IO.Path]::Combine($tempDir, $tempName)
    try {
        if ($OnProgress) { & $OnProgress 'downloading' 0 $tempPath }
        if ($GraphSource -and $SourceServerRelativeUrl -match '[%#]') {
            Save-OneDriveSourceFileToPath -Connection $SourceConnection -DriveId $GraphSource.DriveId -RelPath $GraphSource.RelPath -OutFile $tempPath
        } else {
            try {
                Get-PnPFile -Url $SourceServerRelativeUrl -Path $tempDir -Filename $tempName -AsFile -Connection $SourceConnection -ErrorAction Stop | Out-Null
            } catch {
                if (-not $GraphSource) { throw }
                Save-OneDriveSourceFileToPath -Connection $SourceConnection -DriveId $GraphSource.DriveId -RelPath $GraphSource.RelPath -OutFile $tempPath
            }
        }
        if ($OnProgress) { & $OnProgress 'uploading' 0 }
        Send-GraphDriveFile -Connection $TargetConnection -TempPath $tempPath -DriveId $TargetDriveId -RelPath $TargetRelPath -OnProgress $OnProgress -ChunkSizeBytes $ChunkSizeBytes
    } finally {
        Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Export-ModuleMember -Function `
    Get-OneDriveDriveId, Initialize-GraphDriveFolders, Send-GraphDriveFile, `
    Save-OneDriveSourceFileToPath, Save-OneDriveFileFromSharePoint, Test-OneDriveTargetMatches
