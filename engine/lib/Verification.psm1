#Requires -Version 7.0

# Resume must never trust an index blindly - it re-checks the actual target
# state. A file is treated as already-done only if the target copy has the
# same size AND is at least as new as the source (delta rule: a source file
# edited after the last run re-copies even at an unchanged size). When either
# side's timestamp is unavailable the check degrades to size-only, matching
# the original behaviour.
function Test-PnPTargetFileMatches {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$TargetServerRelativeUrl,
        [Parameter(Mandatory)][long]$ExpectedSize,
        $SourceModified = $null
    )
    try {
        $existing = Get-PnPFile -Url $TargetServerRelativeUrl -AsFileObject -Connection $Connection -ErrorAction Stop
        if ($null -eq $existing) { return $false }
        if ([long]$existing.Length -ne $ExpectedSize) { return $false }
        if ($SourceModified) {
            $targetModified = $null
            try { $targetModified = $existing.TimeLastModified } catch {}
            if ($targetModified -and $targetModified -lt [datetime]$SourceModified) { return $false }
        }
        return $true
    } catch {
        return $false
    }
}

# --- Post-migration whole-tree verification --------------------------------
# Compares every file under the source root with its migrated copy using
# Microsoft Graph metadata: existence, size, and QuickXorHash - a content
# hash SharePoint computes server-side, so matching hashes prove identical
# bytes without downloading anything. Runs over the same app-only connection
# the engine already holds (Invoke-PnPGraphMethod reuses its token).
#
# Office documents (.docx/.xlsx/.pptx ...) are classified separately when
# only their hash differs: SharePoint rewrites embedded document properties
# (docProps/core.xml etc.) on ingestion - "property promotion" - so a fresh
# copy legitimately hashes differently while sheets/text are untouched.
# Flagging those as failures would make every job look broken.

function ConvertTo-GraphEscapedPath {
    param([string]$Path)
    (($Path -split '/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
}

function Get-GraphDriveId {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$SiteUrl,
        [Parameter(Mandatory)][string]$Library
    )
    $u = [Uri]$SiteUrl
    $site = Invoke-PnPGraphMethod -Url "v1.0/sites/$($u.Host):$($u.AbsolutePath)" -Connection $Connection
    $drives = (Invoke-PnPGraphMethod -Url "v1.0/sites/$($site.id)/drives" -Connection $Connection).value
    $match = $drives | Where-Object {
        [uri]::UnescapeDataString($_.webUrl).TrimEnd('/').EndsWith("/$Library", [System.StringComparison]::OrdinalIgnoreCase) -or
        $_.name -eq $Library
    } | Select-Object -First 1
    if (-not $match) { throw "No document library matching '$Library' found on $SiteUrl (drives: $($drives.name -join ', '))" }
    return $match.id
}

# Returns @{ '<path relative to root>' = @{ Size; Hash; ... } } for every file
# under the given drive-relative folder ('' = drive root). One walk of the
# whole tree costs a handful of paged requests - orders of magnitude cheaper
# than a per-file round trip - so this map doubles as the engine's prefetched
# skip-check index and source-metadata cache, not just verification input.
# -IncludeDetails adds Created/Modified timestamps and Author/Editor emails.
function Get-GraphFileMap {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$DriveId,
        [Parameter(Mandatory)][AllowEmptyString()][string]$RootPath,
        [switch]$IncludeDetails,
        # Invoked after each Graph page with the cumulative file count - lets
        # the caller surface progress during a prefetch that can run for many
        # minutes on large trees. Throttling is the callback's job.
        [scriptblock]$OnProgress
    )
    $root = $RootPath.Trim('/')
    $select = 'name,size,file,folder'
    if ($IncludeDetails) { $select += ',createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy' }
    $map = @{}
    $stack = [System.Collections.Generic.Stack[string]]::new()
    $stack.Push($root)
    while ($stack.Count -gt 0) {
        $current = $stack.Pop()
        $url = if ($current) {
            "v1.0/drives/$DriveId/root:/$(ConvertTo-GraphEscapedPath $current):/children?`$select=$select&`$top=999"
        } else {
            "v1.0/drives/$DriveId/root/children?`$select=$select&`$top=999"
        }
        do {
            $resp = Invoke-PnPGraphMethod -Url $url -Connection $Connection
            foreach ($item in $resp.value) {
                $childPath = if ($current) { "$current/$($item.name)" } else { $item.name }
                if ($item.folder) {
                    $stack.Push($childPath)
                } else {
                    $rel = if ($root) { $childPath.Substring($root.Length).TrimStart('/') } else { $childPath }
                    $entry = @{ Size = [long]$item.size; Hash = $item.file.hashes.quickXorHash }
                    if ($IncludeDetails) {
                        $entry.Created = if ($item.createdDateTime) { [datetime]$item.createdDateTime } else { $null }
                        $entry.Modified = if ($item.lastModifiedDateTime) { [datetime]$item.lastModifiedDateTime } else { $null }
                        $entry.AuthorEmail = $item.createdBy.user.email
                        $entry.EditorEmail = $item.lastModifiedBy.user.email
                    }
                    $map[$rel] = $entry
                }
            }
            $url = $resp.'@odata.nextLink'
            if ($OnProgress) { & $OnProgress $map.Count }
        } while ($url)
    }
    return $map
}

$script:OfficeExtensions = @('.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm', '.one', '.vsdx')

# The comparison rules themselves, over two already-built maps of
# '<relative path>' -> @{ Size; Hash } - shared by SharePoint-to-SharePoint
# verification (both maps from Graph) and filesystem-to-SharePoint
# verification (source map from FileSystemSource.psm1's local QuickXorHash
# walk, target map from Graph). The Office property-promotion exemption
# applies to both: SharePoint re-stamps embedded document properties on
# ingestion whether the file arrived by server-side copy or by upload.
function Compare-MigratedFileMaps {
    param(
        [Parameter(Mandatory)][hashtable]$SourceMap,
        [Parameter(Mandatory)][hashtable]$TargetMap
    )
    $missing = [System.Collections.Generic.List[string]]::new()
    $sizeMismatch = [System.Collections.Generic.List[string]]::new()
    $hashMismatch = [System.Collections.Generic.List[string]]::new()
    $officeRewritten = [System.Collections.Generic.List[string]]::new()
    $hashUnavailable = 0
    $identical = 0

    foreach ($rel in $SourceMap.Keys) {
        $ext = [System.IO.Path]::GetExtension($rel).ToLowerInvariant()
        $isOffice = $script:OfficeExtensions -contains $ext
        if (-not $TargetMap.ContainsKey($rel)) { $missing.Add($rel); continue }
        if ($SourceMap[$rel].Size -ne $TargetMap[$rel].Size) {
            if ($isOffice) { $officeRewritten.Add($rel) } else { $sizeMismatch.Add($rel) }
            continue
        }
        if (-not $SourceMap[$rel].Hash -or -not $TargetMap[$rel].Hash) { $hashUnavailable++; $identical++; continue }
        if ($SourceMap[$rel].Hash -ne $TargetMap[$rel].Hash) {
            if ($isOffice) { $officeRewritten.Add($rel) } else { $hashMismatch.Add($rel) }
            continue
        }
        $identical++
    }

    return [pscustomobject]@{
        SourceFiles     = $SourceMap.Count
        TargetFiles     = $TargetMap.Count
        Identical       = $identical
        Missing         = $missing
        SizeMismatch    = $sizeMismatch
        HashMismatch    = $hashMismatch
        OfficeRewritten = $officeRewritten
        HashUnavailable = $hashUnavailable
    }
}

function Compare-PnPMigratedTrees {
    param(
        [Parameter(Mandatory)]$SourceConnection,
        [Parameter(Mandatory)]$TargetConnection,
        [Parameter(Mandatory)][string]$SourceSiteUrl,
        [Parameter(Mandatory)][string]$SourceLibrary,
        [Parameter(Mandatory)][AllowEmptyString()][string]$SourcePathInLibrary,
        [Parameter(Mandatory)][string]$TargetSiteUrl,
        [Parameter(Mandatory)][string]$TargetLibrary,
        [Parameter(Mandatory)][AllowEmptyString()][string]$TargetPathInLibrary
    )
    $srcDrive = Get-GraphDriveId -Connection $SourceConnection -SiteUrl $SourceSiteUrl -Library $SourceLibrary
    $tgtDrive = Get-GraphDriveId -Connection $TargetConnection -SiteUrl $TargetSiteUrl -Library $TargetLibrary
    $src = Get-GraphFileMap -Connection $SourceConnection -DriveId $srcDrive -RootPath $SourcePathInLibrary
    $tgt = Get-GraphFileMap -Connection $TargetConnection -DriveId $tgtDrive -RootPath $TargetPathInLibrary
    return Compare-MigratedFileMaps -SourceMap $src -TargetMap $tgt
}

# --- Blob-target verification ----------------------------------------------
# Compares a source Graph file map (Get-GraphFileMap) against a target blob
# key map (BlobTarget.psm1's Get-BlobKeyMap) - same output shape as
# Compare-PnPMigratedTrees so Invoke-VerificationPhase in
# Invoke-MigrationJob.ps1 can treat both destinations identically.
#
# There is no free, re-fetchable-anytime source hash for a blob target the
# way QuickXorHash is for SharePoint-to-SharePoint (Graph doesn't expose an
# MD5 for SharePoint libraries). The source MD5 is instead computed once,
# during the copy, by streaming the SharePoint download
# (BlobTarget.psm1's Save-BlobFromSharePointFile) and stamped onto the blob
# as its durable Content-MD5. This routine's hash check is therefore a
# self-consistency check - the blob's stored Content-MD5 against the
# x-ms-meta-sourcemd5 value captured at upload time - which catches
# out-of-band tampering, a bad re-upload, or a commit inconsistency, not a
# full independent re-hash of the source (that would mean re-downloading
# the entire tree on every "Verify" click; see -DeepVerify for the opt-in,
# compliance-audit-grade alternative called from Invoke-MigrationJob.ps1).
# OfficeRewritten is always empty here: object storage never rewrites bytes
# the way SharePoint re-stamps Office document properties on copy - the
# field is kept only so both compare functions return the same shape.
function Compare-BlobMigratedTree {
    param(
        [Parameter(Mandatory)][hashtable]$SourceMap,
        [Parameter(Mandatory)][hashtable]$TargetMap
    )
    $missing = [System.Collections.Generic.List[string]]::new()
    $sizeMismatch = [System.Collections.Generic.List[string]]::new()
    $hashMismatch = [System.Collections.Generic.List[string]]::new()
    $officeRewritten = [System.Collections.Generic.List[string]]::new()
    $hashUnavailable = 0
    $identical = 0

    foreach ($rel in $SourceMap.Keys) {
        if (-not $TargetMap.ContainsKey($rel)) { $missing.Add($rel); continue }
        $src = $SourceMap[$rel]
        $tgt = $TargetMap[$rel]
        if ($src.Size -ne $tgt.Size) { $sizeMismatch.Add($rel); continue }
        if (-not $tgt.ContentMd5) { $hashUnavailable++; $identical++; continue }
        if ($tgt.SourceMd5 -and $tgt.SourceMd5 -ne $tgt.ContentMd5) { $hashMismatch.Add($rel); continue }
        $identical++
    }

    return [pscustomobject]@{
        SourceFiles     = $SourceMap.Count
        TargetFiles     = $TargetMap.Count
        Identical       = $identical
        Missing         = $missing
        SizeMismatch    = $sizeMismatch
        HashMismatch    = $hashMismatch
        OfficeRewritten = $officeRewritten
        HashUnavailable = $hashUnavailable
    }
}

Export-ModuleMember -Function Test-PnPTargetFileMatches, Compare-PnPMigratedTrees, Compare-MigratedFileMaps, Get-GraphDriveId, Get-GraphFileMap, Compare-BlobMigratedTree
