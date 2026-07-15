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

# Graph's simple ("PUT .../content") upload only accepts files up to 4 MiB;
# above that a resumable upload session is required. Session chunks must be a
# multiple of 320 KiB except the final one - 5 MiB (16 * 320 KiB) satisfies
# that exactly.
$script:OneDriveSimpleUploadThresholdBytes = 4MB
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

# Ensures every folder in $RelativeFolderPaths (plus the target root itself)
# exists under the drive, in the given order - which must be parent-before-
# child (true by construction: callers pass the source tree's breadth-first
# folder list, exactly like Initialize-PnPTargetFolders relies on for the
# SharePoint target). Idempotent: POSTing a folder-create with
# conflictBehavior=replace against an existing item that is ALSO a folder is
# a documented Graph no-op (it does not touch the existing folder's
# children) - the same idiom OneDrive's own sync clients use to ensure a
# path exists without first checking whether it already does.
function Initialize-GraphDriveFolders {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][AllowEmptyString()][string]$TargetRootPath,
        [Parameter(Mandatory)][AllowEmptyString()][string[]]$RelativeFolderPaths,
        [scriptblock]$OnProgress
    )
    $root = $TargetRootPath.Trim('/')
    $allPaths = @()
    if ($root) { $allPaths += $root }
    foreach ($p in $RelativeFolderPaths) {
        if (-not $p) { continue }
        $allPaths += if ($root) { "$root/$p" } else { $p }
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
                name                                 = $leaf
                folder                               = @{}
                '@microsoft.graph.conflictBehavior'   = 'replace'
            }) -ErrorAction Stop | Out-Null
        } catch {
            $status = Get-HttpStatusCode -Exception $_.Exception
            if ($status -ne 409) { throw "Could not create OneDrive folder '$trimmed': $($_.Exception.Message)" }
        }
        $done++
        if ($OnProgress) { & $OnProgress $done $total }
    }
}

# Uploads a local file's bytes into a drive at a drive-root-relative path.
# Small files (<= 4 MiB) go up as one PUT; larger files use Graph's resumable
# upload session, PUTting 5 MiB-aligned chunks with Content-Range directly
# against the session's own pre-authenticated uploadUrl (no Authorization
# header on those - same "the URL itself carries the signed access" contract
# BlobTarget.psm1's Save-GraphFileToPath already relies on for its
# pre-authenticated downloadUrl).
#
# The small-file path (simple content PUT) goes through Invoke-PnPGraphMethod,
# which has been seen to throw "Nullable object must have a value" on some
# files (observed live migrating a user-documents share to OneDrive: a handful
# of small PDFs failed while everything else copied). That is an error inside
# the compiled cmdlet's own request/response handling, NOT a real upload
# problem - the file and connection are fine. So on ANY failure of the simple
# PUT we fall back to the resumable upload SESSION path below, which uploads
# the bytes with our own Invoke-WebRequest and is unaffected by whatever the
# cmdlet trips over. The lane's own retry loop can't recover these on its own:
# the simple PUT fails deterministically for such a file, so retrying the same
# call just fails again - switching mechanisms is what actually recovers it.
function Send-GraphDriveFile {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$TempPath,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][string]$RelPath,
        # Invoked with ('uploading', <cumulative bytes sent>) after each
        # staged chunk - small single-PUT files finish too fast to matter.
        [scriptblock]$OnProgress
    )
    $itemPath = "v1.0/drives/$DriveId/root:/$(ConvertTo-GraphDrivePath -Path $RelPath)"
    # -LiteralPath: filenames legitimately contain [ and ] (PowerShell wildcard
    # metacharacters) - -Path would mis-glob them and fail to find the file.
    $fileInfo = Get-Item -LiteralPath $TempPath

    if ($fileInfo.Length -le $script:OneDriveSimpleUploadThresholdBytes) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($TempPath)
            Invoke-PnPGraphMethod -Connection $Connection -Method Put -Url "${itemPath}:/content" `
                -Content $bytes -ContentType 'application/octet-stream' -ErrorAction Stop | Out-Null
            return
        } catch {
            # A 0-byte file can only go via the simple PUT (an upload session
            # has no byte range to send), so there is nothing to fall back to.
            if ($fileInfo.Length -eq 0) { throw }
            # Otherwise fall through to the upload-session path below.
        }
    }

    $session = Invoke-PnPGraphMethod -Connection $Connection -Method Post -Url "${itemPath}:/createUploadSession" `
        -Content (@{ item = @{ '@microsoft.graph.conflictBehavior' = 'replace' } }) -ErrorAction Stop
    $uploadUrl = $session.uploadUrl
    if (-not $uploadUrl) { throw "Microsoft Graph did not return an upload session URL for '$RelPath'." }

    $stream = [System.IO.File]::OpenRead($TempPath)
    try {
        $total = [long]$fileInfo.Length
        $buffer = New-Object byte[] $script:OneDriveChunkSizeBytes
        [long]$offset = 0
        while ($offset -lt $total) {
            $toRead = [int][Math]::Min($script:OneDriveChunkSizeBytes, ($total - $offset))
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
        [scriptblock]$OnProgress
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
        Send-GraphDriveFile -Connection $TargetConnection -TempPath $tempPath -DriveId $TargetDriveId -RelPath $TargetRelPath -OnProgress $OnProgress
    } finally {
        Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Export-ModuleMember -Function `
    Get-OneDriveDriveId, Initialize-GraphDriveFolders, Send-GraphDriveFile, `
    Save-OneDriveSourceFileToPath, Save-OneDriveFileFromSharePoint
