#Requires -Version 7.0

# Azure Blob Storage primitives for the "archive to Azure Blob" target,
# mirroring the role SharePointTree.psm1 plays for the SharePoint target:
# small composable functions, no orchestration. Talks to the Blob REST API
# directly (Invoke-WebRequest/Invoke-RestMethod authorized with a
# self-built Account SAS token) rather than the Az.Storage module family -
# this repo already carries PnP.PowerShell's large dependency graph in the
# same pwsh process, and Az.Storage/Az.Accounts bring their own
# login/context model that doesn't map cleanly onto "just a connection
# string, no separate Azure login". The handful of REST calls needed here
# (list, put blob, put block/blocklist) are well documented and small.

# NO -Force. A forced re-import from inside a module first REMOVES the
# already-loaded Retry module - yanking Invoke-WithRetry/Get-HttpStatusCode
# out of the importing runspace's global scope (and every lane that had
# imported it) - then re-imports it nested, visible only inside this module.
# Seen live as: blob lanes silently uploading nothing (every per-item
# Invoke-WithRetry call failed as "not recognized") and the main thread's
# verification-repair loop failing the same way, while SharePoint-target
# jobs (which never load this module in their lanes) worked fine. A plain
# import makes Retry's exports visible in this module's scope without
# touching anyone else's.
Import-Module "$PSScriptRoot/Retry.psm1"

$script:BlobApiVersion = '2019-12-12'
$script:SingleUploadThresholdBytes = 32MB
$script:BlockSizeBytes = 4MB
# Every transiting file lands in this dedicated folder, never loose in %TEMP%:
# blob copies stage customer content on local disk for the duration of one
# file's transfer, and a force-killed engine (pause grace timer, server
# restart) can orphan the in-flight one. A known folder makes those
# identifiable and cleanable - see Clear-StaleBlobTempFiles, called at the
# start of every blob-target run.
$script:BlobTempRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'spmigrator-tmp'

# Removes leftovers from previous force-killed runs. Only files older than an
# hour: a concurrent job's actively-transferring temp files are always
# younger than that... unless a single file takes over an hour to move, in
# which case it is re-copied anyway when its run resumes.
function Clear-StaleBlobTempFiles {
    $removed = 0
    try {
        if (Test-Path $script:BlobTempRoot) {
            $cutoff = (Get-Date).AddHours(-1)
            foreach ($f in (Get-ChildItem -Path $script:BlobTempRoot -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff })) {
                try { Remove-Item -Path $f.FullName -Force -ErrorAction Stop; $removed++ } catch {}
            }
        }
    } catch {}
    return $removed
}

# Parses 'Key=Value;Key=Value;...' - either an account-key connection string
# (AccountName/AccountKey, as copy-pasted from the Azure Portal's "Access
# keys" blade) or a SAS connection string (BlobEndpoint/.../
# SharedAccessSignature, as copy-pasted from the Portal's "Shared access
# signature" blade) - into the account name/endpoint/credential the rest of
# this module needs. Returned .Sas is non-null only for the SAS form; the
# caller (New-BlobSasToken) only needs to run when it's null.
function ConvertFrom-BlobConnectionString {
    param([Parameter(Mandatory)][string]$ConnectionString)

    $parts = @{}
    foreach ($pair in ($ConnectionString -split ';')) {
        if (-not $pair.Trim()) { continue }
        $idx = $pair.IndexOf('=')
        if ($idx -lt 1) { continue }
        $parts[$pair.Substring(0, $idx).Trim()] = $pair.Substring($idx + 1).Trim()
    }

    $protocol = if ($parts.ContainsKey('DefaultEndpointsProtocol')) { $parts['DefaultEndpointsProtocol'] } else { 'https' }
    $endpointSuffix = if ($parts.ContainsKey('EndpointSuffix')) { $parts['EndpointSuffix'] } else { 'core.windows.net' }
    $blobEndpoint = if ($parts.ContainsKey('BlobEndpoint')) {
        $parts['BlobEndpoint'].TrimEnd('/')
    } elseif ($parts.ContainsKey('AccountName')) {
        "${protocol}://$($parts['AccountName']).blob.$endpointSuffix"
    } else {
        $null
    }

    if ($parts.ContainsKey('SharedAccessSignature')) {
        if (-not $blobEndpoint) { throw 'Azure Blob SAS connection string is missing BlobEndpoint.' }
        $accountName = if ($parts.ContainsKey('AccountName')) {
            $parts['AccountName']
        } else {
            try { ([uri]$blobEndpoint).Host.Split('.')[0] } catch { $null }
        }
        return [pscustomobject]@{
            AccountName  = $accountName
            AccountKey   = $null
            BlobEndpoint = $blobEndpoint
            Sas          = $parts['SharedAccessSignature']
        }
    }

    if (-not $parts.ContainsKey('AccountName') -or -not $parts.ContainsKey('AccountKey')) {
        throw 'Azure Blob connection string must contain either AccountName+AccountKey or a SharedAccessSignature.'
    }
    return [pscustomobject]@{
        AccountName  = $parts['AccountName']
        AccountKey   = $parts['AccountKey']
        BlobEndpoint = $blobEndpoint
        Sas          = $null
    }
}

# Builds one Account SAS (service=blob, resource types=service/container/
# object) good for the whole engine invocation - a generous fixed expiry
# with no mid-job refresh, the same simplification the cert-based SharePoint
# auth already makes today (no mid-job token refresh there either).
function New-BlobSasToken {
    param(
        [Parameter(Mandatory)][string]$AccountName,
        [Parameter(Mandatory)][string]$AccountKey,
        [string]$Permissions = 'racwdl',
        [int]$ExpiryHours = 48
    )
    $signedService = 'b'
    $signedResourceType = 'sco'
    $signedStart = ''
    $signedExpiry = (Get-Date).ToUniversalTime().AddHours($ExpiryHours).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $signedIP = ''
    $signedProtocol = 'https'

    $fields = @(
        $AccountName, $Permissions, $signedService, $signedResourceType,
        $signedStart, $signedExpiry, $signedIP, $signedProtocol, $script:BlobApiVersion
    )
    $stringToSign = ($fields -join "`n") + "`n"

    $keyBytes = [Convert]::FromBase64String($AccountKey)
    $hmac = [System.Security.Cryptography.HMACSHA256]::new($keyBytes)
    try {
        $sigBytes = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($stringToSign))
    } finally {
        $hmac.Dispose()
    }
    $signature = [Convert]::ToBase64String($sigBytes)

    $sasParts = @(
        "sv=$script:BlobApiVersion"
        "ss=$signedService"
        "srt=$signedResourceType"
        "sp=$Permissions"
        "se=$([uri]::EscapeDataString($signedExpiry))"
        "spr=$signedProtocol"
        "sig=$([uri]::EscapeDataString($signature))"
    )
    return ($sasParts -join '&')
}

# Blob keys are '/'-delimited but have no real folder semantics - joins
# non-empty segments the same way Invoke-MigrationJob.ps1's Join-UrlSegments
# joins SharePoint path segments.
function Get-BlobKey {
    param([string[]]$Segments)
    ($Segments | Where-Object { $_ } | ForEach-Object { $_.Trim('/') } | Where-Object { $_ }) -join '/'
}

# Each '/'-delimited segment of a blob key must be percent-encoded on its
# own - escaping the whole key at once would also encode the '/' separators
# themselves (as %2F), breaking the virtual folder hierarchy.
function ConvertTo-BlobEscapedKey {
    param([string]$Key)
    (($Key -split '/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
}

# Preflight: list (maxresults=1, cheap) to check the container exists;
# create it if not (idempotent - a 409 from a concurrent create, e.g. two
# jobs racing to archive into a brand-new container, is swallowed). Fails
# fast with an actionable message instead of deep inside enumeration.
function Confirm-BlobContainerExists {
    param(
        [Parameter(Mandatory)][string]$BlobEndpoint,
        [Parameter(Mandatory)][string]$Container,
        [Parameter(Mandatory)][string]$Sas
    )
    $headers = @{ 'x-ms-version' = $script:BlobApiVersion }
    $listUrl = "$BlobEndpoint/$Container`?restype=container&comp=list&maxresults=1&$Sas"
    try {
        Invoke-RestMethod -Uri $listUrl -Method Get -Headers $headers -ErrorAction Stop | Out-Null
        return
    } catch {
        $status = Get-HttpStatusCode -Exception $_.Exception
        if ($status -ne 404) {
            throw "Cannot access Azure Blob container '$Container': $($_.Exception.Message)"
        }
    }
    $createUrl = "$BlobEndpoint/$Container`?restype=container&$Sas"
    try {
        Invoke-RestMethod -Uri $createUrl -Method Put -Headers $headers -ErrorAction Stop | Out-Null
    } catch {
        $status = Get-HttpStatusCode -Exception $_.Exception
        if ($status -ne 409) {
            throw "Failed to create Azure Blob container '$Container': $($_.Exception.Message)"
        }
    }
}

# One paginated List Blobs walk of the whole prefix, returning the same map
# shape as Get-GraphFileMap (Verification.psm1): '<relative key>' ->
# @{ Size; ContentMd5; Modified }. This makes it a drop-in for the engine's
# prefetched target-side skip-check index. Modified comes from the custom
# x-ms-meta-modified value this module writes at upload time (a blob's own
# Last-Modified reflects upload time, not the original source mtime, so it
# can't be used for the delta skip-check the way it is for SharePoint).
function Get-BlobKeyMap {
    param(
        [Parameter(Mandatory)][string]$BlobEndpoint,
        [Parameter(Mandatory)][string]$Container,
        [Parameter(Mandatory)][string]$Sas,
        [AllowEmptyString()][string]$Prefix = ''
    )
    $map = @{}
    $marker = $null
    $prefixTrimmed = $Prefix.Trim('/')
    $headers = @{ 'x-ms-version' = $script:BlobApiVersion }
    do {
        $url = "$BlobEndpoint/$Container`?restype=container&comp=list&include=metadata&maxresults=5000&$Sas"
        if ($prefixTrimmed) { $url += "&prefix=$([uri]::EscapeDataString("$prefixTrimmed/"))" }
        if ($marker) { $url += "&marker=$([uri]::EscapeDataString($marker))" }
        # NOT Invoke-RestMethod: Azure prefixes its List Blobs XML with a
        # UTF-8 BOM, which makes Invoke-RestMethod return a raw STRING
        # instead of parsed XML - $resp.EnumerationResults is then $null and
        # this function silently returned an empty map on every call.
        # Downstream that meant: resume never skipped a single blob
        # (everything re-uploaded from scratch), the prefetch always said
        # "0 existing target files", and verification declared every file
        # missing. Parse explicitly, stripping anything before the first '<'.
        $raw = (Invoke-WebRequest -Uri $url -Method Get -Headers $headers -ErrorAction Stop).Content
        if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
        $ltIndex = $raw.IndexOf('<')
        if ($ltIndex -lt 0) { throw "Azure List Blobs returned an unrecognizable response for container '$Container'." }
        $resp = [xml]$raw.Substring($ltIndex)
        foreach ($blob in @($resp.EnumerationResults.Blobs.Blob)) {
            if (-not $blob) { continue }
            # Storage accounts with hierarchical namespace (Data Lake Gen2)
            # list every DIRECTORY as a zero-byte entry tagged with
            # hdi_isfolder metadata. Counting those as files inflated the
            # verification's target total (e.g. "3,904 source vs 4,316
            # target" - the 412 extras were folders).
            if ($blob.Metadata -and [string]$blob.Metadata.hdi_isfolder -eq 'true') { continue }
            $name = [string]$blob.Name
            $rel = if ($prefixTrimmed) { $name.Substring($prefixTrimmed.Length + 1) } else { $name }
            $props = $blob.Properties
            $meta = $blob.Metadata
            $modified = $null
            if ($meta -and $meta.modified) {
                try { $modified = [datetime]$meta.modified } catch { $modified = $null }
            }
            $map[$rel] = @{
                Size       = [long]$props.'Content-Length'
                ContentMd5 = $props.'Content-MD5'
                SourceMd5  = if ($meta) { $meta.sourcemd5 } else { $null }
                Modified   = $modified
            }
        }
        $marker = $resp.EnumerationResults.NextMarker
    } while ($marker)
    return $map
}

# Per-file fallback skip check (used only if the prefetched map above is
# unavailable) - same "same size AND target at least as new" delta rule as
# SharePointTree.psm1's Test-PnPTargetFileMatches.
function Test-BlobTargetMatches {
    param(
        [Parameter(Mandatory)][string]$BlobEndpoint,
        [Parameter(Mandatory)][string]$Container,
        [Parameter(Mandatory)][string]$Sas,
        [Parameter(Mandatory)][string]$BlobKey,
        [Parameter(Mandatory)][long]$ExpectedSize,
        $SourceModified = $null
    )
    $url = "$BlobEndpoint/$Container/$(ConvertTo-BlobEscapedKey -Key $BlobKey)?$Sas"
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Head -Headers @{ 'x-ms-version' = $script:BlobApiVersion } -ErrorAction Stop
        $len = [long]($resp.Headers['Content-Length'] | Select-Object -First 1)
        if ($len -ne $ExpectedSize) { return $false }
        if ($SourceModified) {
            $modifiedMeta = $resp.Headers['x-ms-meta-modified'] | Select-Object -First 1
            if ($modifiedMeta) {
                $targetModified = [datetime]$modifiedMeta
                if ($targetModified -lt [datetime]$SourceModified) { return $false }
            }
        }
        return $true
    } catch {
        return $false
    }
}

# Uploads a byte array/file as a block blob, committing a durable
# Content-MD5 (x-ms-blob-content-md5) plus custom x-ms-meta-* properties.
# Small files go up as one PUT (Content-MD5 request header lets Azure
# validate transit integrity and reject corruption with a retryable
# Md5Mismatch); larger files are staged as 4 MiB blocks (each individually
# MD5-checked) then committed with a block list.
function Send-BlobFile {
    param(
        [Parameter(Mandatory)][string]$TempPath,
        [Parameter(Mandatory)][string]$BlobEndpoint,
        [Parameter(Mandatory)][string]$Container,
        [Parameter(Mandatory)][string]$Sas,
        [Parameter(Mandatory)][string]$BlobKey,
        [Parameter(Mandatory)][string]$ContentMd5Base64,
        [hashtable]$Metadata,
        # Invoked with ('uploading', <cumulative bytes sent>) after each
        # staged block - lets the caller surface live per-file progress on
        # large uploads. Small single-PUT files finish too fast to matter.
        [scriptblock]$OnProgress
    )
    $escapedKey = ConvertTo-BlobEscapedKey -Key $BlobKey
    $blobUrl = "$BlobEndpoint/$Container/$escapedKey"
    $fileInfo = Get-Item -Path $TempPath

    $metaHeaders = @{}
    if ($Metadata) {
        foreach ($k in $Metadata.Keys) {
            if ($null -ne $Metadata[$k] -and $Metadata[$k] -ne '') {
                $metaHeaders["x-ms-meta-$($k.ToLowerInvariant())"] = [string]$Metadata[$k]
            }
        }
    }

    if ($fileInfo.Length -le $script:SingleUploadThresholdBytes) {
        $headers = @{
            'x-ms-blob-type'        = 'BlockBlob'
            'x-ms-version'          = $script:BlobApiVersion
            'x-ms-blob-content-md5' = $ContentMd5Base64
            'Content-MD5'           = $ContentMd5Base64
        } + $metaHeaders
        Invoke-WebRequest -Uri "$blobUrl`?$Sas" -Method Put -Headers $headers `
            -InFile $TempPath -ContentType 'application/octet-stream' -ErrorAction Stop | Out-Null
        return
    }

    $blockIds = [System.Collections.Generic.List[string]]::new()
    $stream = [System.IO.File]::OpenRead($TempPath)
    try {
        $buffer = New-Object byte[] $script:BlockSizeBytes
        $blockIndex = 0
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $blockId = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(('{0:D6}' -f $blockIndex)))
            $blockIds.Add($blockId)
            # $chunk MUST remain a true byte[] all the way to -Body. Two
            # PowerShell traps both silently produce Object[] here, which
            # Invoke-WebRequest then serializes as a space-separated decimal
            # STRING (~3.6x the size) instead of raw bytes - the body no
            # longer matches its Content-MD5 header and Azure rejects every
            # block with 400 Md5Mismatch (so every file above the single-shot
            # threshold failed, while small files - which use -InFile - were
            # fine):
            #   1. range-slicing:      $buffer[0..($read-1)]         -> Object[]
            #   2. if-as-expression:   $x = if (...) { $byteArray }  -> pipeline
            #      enumeration unrolls the array and re-collects it  -> Object[]
            # Plain assignments avoid both. Verified against a local listener
            # replicating Azure's per-block MD5 validation.
            $chunk = $buffer
            if ($read -ne $buffer.Length) {
                $chunk = [byte[]]::new($read)
                [Array]::Copy($buffer, $chunk, $read)
            }
            $md5 = [System.Security.Cryptography.MD5]::Create()
            try { $chunkMd5 = [Convert]::ToBase64String($md5.ComputeHash($chunk)) } finally { $md5.Dispose() }
            $blockHeaders = @{ 'x-ms-version' = $script:BlobApiVersion; 'Content-MD5' = $chunkMd5 }
            Invoke-WebRequest -Uri "$blobUrl`?comp=block&blockid=$([uri]::EscapeDataString($blockId))&$Sas" `
                -Method Put -Headers $blockHeaders -Body $chunk -ContentType 'application/octet-stream' -ErrorAction Stop | Out-Null
            $blockIndex++
            if ($OnProgress) { & $OnProgress 'uploading' ([long]$stream.Position) }
        }
    } finally {
        $stream.Dispose()
    }

    $blockListXml = '<?xml version="1.0" encoding="utf-8"?><BlockList>' +
        (($blockIds | ForEach-Object { "<Latest>$_</Latest>" }) -join '') + '</BlockList>'
    $commitHeaders = @{
        'x-ms-version'          = $script:BlobApiVersion
        'x-ms-blob-content-md5' = $ContentMd5Base64
    } + $metaHeaders
    Invoke-WebRequest -Uri "$blobUrl`?comp=blocklist&$Sas" -Method Put -Headers $commitHeaders `
        -Body $blockListXml -ContentType 'application/xml' -ErrorAction Stop | Out-Null
}

# Downloads a SharePoint file's bytes via Microsoft Graph, addressed by
# drive id + drive-root-relative path with each segment percent-encoded
# on its own (a literal % in the name becomes %25, which Graph decodes
# back to the literal). This is the download path that survives filenames
# containing % or #: Get-PnPFile round-trips the server-relative URL and
# SharePoint decodes %XX sequences in it, resolving the WRONG name
# (observed live 2026-07-13: 'a%20b.pptx' was looked up as 'a b.pptx' ->
# "The file ... does not exist" on every copy and repair attempt). The
# byte transfer itself streams from the item's short-lived
# pre-authenticated @microsoft.graph.downloadUrl straight to disk - no
# auth header, no memory buffering.
function Save-GraphFileToPath {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$DriveId,
        # Path relative to the drive (library) root, decoded form.
        [Parameter(Mandatory)][string]$RelPath,
        [Parameter(Mandatory)][string]$OutFile
    )
    $escaped = ConvertTo-BlobEscapedKey -Key $RelPath
    $item = Invoke-PnPGraphMethod -Url "v1.0/drives/$DriveId/root:/$escaped" -Connection $Connection
    $downloadUrl = $item.'@microsoft.graph.downloadUrl'
    if (-not $downloadUrl) { throw "Graph returned no downloadUrl for '$RelPath' (drive $DriveId)." }
    Invoke-WebRequest -Uri $downloadUrl -OutFile $OutFile -ErrorAction Stop | Out-Null
}

# Per-file copy orchestration: downloads the SharePoint file to a temp path
# via the caller's existing PnP connection (no separate Graph download
# plumbing needed), streams-hashes it (chunked MD5 - never loads the whole
# file into memory), uploads it, and always cleans up the temp file
# regardless of success/failure.
function Save-BlobFromSharePointFile {
    param(
        [Parameter(Mandatory)]$SourceConnection,
        [Parameter(Mandatory)][string]$SourceServerRelativeUrl,
        [Parameter(Mandatory)][string]$BlobEndpoint,
        [Parameter(Mandatory)][string]$Container,
        [Parameter(Mandatory)][string]$Sas,
        [Parameter(Mandatory)][string]$BlobKey,
        [hashtable]$Metadata,
        # Optional @{ DriveId; RelPath } (drive-root-relative, decoded):
        # enables the encoding-proof Graph download above - taken directly
        # for names containing % or # (Get-PnPFile cannot fetch those at
        # all), and as the fallback after any Get-PnPFile failure.
        [hashtable]$GraphSource,
        # Invoked at stage transitions and per uploaded block:
        #   ('downloading', 0, <tempPath>) before the SharePoint download -
        #       the temp path lets the caller poll the growing file's size
        #       for download progress (Get-PnPFile itself exposes no hook);
        #   ('uploading', <cumulative bytes>) during the block upload.
        [scriptblock]$OnProgress
    )
    $tempDir = $script:BlobTempRoot
    if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }
    $tempName = "$([guid]::NewGuid()).tmp"
    $tempPath = [System.IO.Path]::Combine($tempDir, $tempName)
    try {
        if ($OnProgress) { & $OnProgress 'downloading' 0 $tempPath }
        if ($GraphSource -and $SourceServerRelativeUrl -match '[%#]') {
            Save-GraphFileToPath -Connection $SourceConnection -DriveId $GraphSource.DriveId -RelPath $GraphSource.RelPath -OutFile $tempPath
        } else {
            try {
                Get-PnPFile -Url $SourceServerRelativeUrl -Path $tempDir -Filename $tempName -AsFile -Connection $SourceConnection -ErrorAction Stop | Out-Null
            } catch {
                if (-not $GraphSource) { throw }
                Save-GraphFileToPath -Connection $SourceConnection -DriveId $GraphSource.DriveId -RelPath $GraphSource.RelPath -OutFile $tempPath
            }
        }
        if ($OnProgress) { & $OnProgress 'uploading' 0 }

        $md5 = [System.Security.Cryptography.MD5]::Create()
        try {
            $stream = [System.IO.File]::OpenRead($tempPath)
            try { $hashBytes = $md5.ComputeHash($stream) } finally { $stream.Dispose() }
        } finally {
            $md5.Dispose()
        }
        $md5Base64 = [Convert]::ToBase64String($hashBytes)

        # Stamped redundantly alongside the blob's own durable Content-MD5
        # property, as a self-consistency value Compare-BlobMigratedTree can
        # check without re-downloading/re-hashing the whole tree (see
        # Verification.psm1's Compare-BlobMigratedTree for why).
        $metaWithHash = @{ sourcemd5 = $md5Base64 }
        if ($Metadata) { foreach ($k in $Metadata.Keys) { $metaWithHash[$k] = $Metadata[$k] } }

        Send-BlobFile -TempPath $tempPath -BlobEndpoint $BlobEndpoint -Container $Container -Sas $Sas `
            -BlobKey $BlobKey -ContentMd5Base64 $md5Base64 -Metadata $metaWithHash -OnProgress $OnProgress

        return $md5Base64
    } finally {
        Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
    }
}

Export-ModuleMember -Function `
    ConvertFrom-BlobConnectionString, New-BlobSasToken, Get-BlobKey, ConvertTo-BlobEscapedKey, `
    Confirm-BlobContainerExists, Get-BlobKeyMap, Test-BlobTargetMatches, Send-BlobFile, Save-BlobFromSharePointFile, `
    Save-GraphFileToPath, Clear-StaleBlobTempFiles
