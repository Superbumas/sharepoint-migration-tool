#Requires -Version 7.0

# NO -Force - see BlobTarget.psm1's note on forced re-imports from a module.
Import-Module "$PSScriptRoot/Retry.psm1"

# --- Pre-flight content check ----------------------------------------------
# Runs over the already-enumerated source tree, before anything is copied,
# and finds what SharePoint Online will refuse or struggle with - so the
# person running the job sees it up front instead of as a handful of
# mystery failures six hours in:
#
#   Blockers (the file WILL fail to copy):
#     - Full decoded target path longer than SharePoint's 400-character
#       limit. Counted the way SharePoint counts it: the server-relative URL
#       path including the site, library, the folder the job copies into,
#       every subfolder and the file name. A path that is fine at the source
#       can tip over the limit once a longer target site/folder prefix is
#       added, which is the common surprise.
#     - Files over 250 GB, SharePoint's maximum file size.
#     (Azure Blob targets: blob names are capped at 1,024 characters and
#     there is no 250 GB limit.)
#
#   Warnings (the copy works, but you should know):
#     - Items with their own (broken-inheritance) permissions in a
#       SharePoint source. Microsoft supports at most 50,000 unique
#       permission scopes per library and recommends staying under 5,000;
#       this engine does not copy item-level permissions, so every one of
#       these needs re-applying on the target. Folders holding the most are
#       listed so they can be reviewed before the job runs.

$script:MaxFileBytes = 250GB
$script:UniquePermsRecommended = 5000
$script:UniquePermsSupported = 50000
$script:MaxListed = 50

# $Files: tree files (Name/TargetName, Size, RelativeFromRoot).
# $TargetPrefix: everything in front of RelativeFromRoot at the target - a
# server-relative URL path for SharePoint/OneDrive ("/sites/Hub/Shared
# Documents/Projects/HR"), or the blob prefix for Azure Blob.
function Test-MigrationContent {
    param(
        [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Files,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Folders,
        [Parameter(Mandatory)][AllowEmptyString()][string]$TargetPrefix,
        [ValidateSet('sharepoint', 'onedrive', 'azure_blob')][string]$TargetProvider = 'sharepoint'
    )
    $isBlob = $TargetProvider -eq 'azure_blob'
    $maxPath = if ($isBlob) { 1024 } else { 400 }
    $prefix = $TargetPrefix.TrimEnd('/')
    # SharePoint measures the DECODED path; ours is never encoded, so plain
    # length is right.
    $longPaths = [System.Collections.Generic.List[object]]::new()
    $largeFiles = [System.Collections.Generic.List[object]]::new()
    [long]$bytes = 0
    $longestLen = 0
    foreach ($f in $Files) {
        $name = if ($f.TargetName) { $f.TargetName } else { $f.Name }
        $rel = if ($f.RelativeFromRoot) { "$($f.RelativeFromRoot)/$name" } else { $name }
        $full = if ($prefix) { "$prefix/$rel" } else { $rel }
        $len = $full.Length
        if ($len -gt $longestLen) { $longestLen = $len }
        if ($len -gt $maxPath) { $longPaths.Add([pscustomobject]@{ path = $rel; length = $len }) }
        $size = [long]$f.Size
        $bytes += $size
        if (-not $isBlob -and $size -gt $script:MaxFileBytes) { $largeFiles.Add([pscustomobject]@{ path = $rel; size = $size }) }
    }
    # A folder whose own path is over the limit can't be created, so
    # everything under it fails too - list folders separately: renaming or
    # shortening one folder often fixes hundreds of file paths at once.
    $longFolders = [System.Collections.Generic.List[object]]::new()
    foreach ($d in $Folders) {
        $full = if ($prefix) { "$prefix/$d" } else { $d }
        if ($full.Length -gt $maxPath) { $longFolders.Add([pscustomobject]@{ path = $d; length = $full.Length }) }
    }
    # Report only the top-most over-limit folders (a child of a listed
    # folder is implied).
    $topLongFolders = @($longFolders | Sort-Object { $_.path.Length } | Where-Object {
            $p = $_.path
            -not ($longFolders | Where-Object { $_.path -ne $p -and $p.StartsWith("$($_.path)/") } | Select-Object -First 1)
        })

    return [pscustomobject]@{
        Files          = @($Files).Count
        Folders        = @($Folders).Count
        Bytes          = $bytes
        MaxPathLength  = $maxPath
        TargetPrefix   = $prefix
        PrefixLength   = $prefix.Length
        LongestPath    = $longestLen
        LongPaths      = $longPaths
        LongFolders    = $topLongFolders
        LargeFiles     = $largeFiles
    }
}

# Counts list items with unique permissions under a SharePoint source folder
# via REST, 5,000 items per request (HasUniqueRoleAssignments is selectable in
# a bulk items query, so this is ~items/5000 calls - not one per item).
# Returns @{ Checked; Count; Folders = [{ path; count }]; Error }.
function Get-UniquePermissionSummary {
    param(
        [Parameter(Mandatory)]$Connection,
        # Server-relative URL of the library root folder, e.g.
        # "/sites/HR/Shared Documents"
        [Parameter(Mandatory)][string]$LibraryServerRelativeUrl,
        # Server-relative URL of the scanned folder (= library root for a
        # whole-library job).
        [Parameter(Mandatory)][string]$RootServerRelativeUrl,
        [scriptblock]$OnProgress
    )
    $lib = $LibraryServerRelativeUrl.TrimEnd('/')
    $root = $RootServerRelativeUrl.TrimEnd('/')
    $escapedLib = $lib.Replace("'", "''")
    $url = "/_api/web/GetList('$([uri]::EscapeDataString($escapedLib))')/items?`$select=FileRef,FileDirRef,FSObjType,HasUniqueRoleAssignments&`$top=5000"
    $count = 0
    $scanned = 0
    # Per immediate child folder of the scanned root ('' = the root itself):
    # where the uniquely-permissioned items live.
    $byFolder = @{}
    try {
        while ($url) {
            $resp = Invoke-WithRetry -Action { Invoke-PnPSPRestMethod -Method Get -Url $url -Connection $Connection }
            foreach ($it in $resp.value) {
                $scanned++
                if (-not $it.HasUniqueRoleAssignments) { continue }
                $ref = [string]$it.FileRef
                if ($ref -ne $root -and -not $ref.StartsWith("$root/", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
                if ($ref -eq $root) { continue }
                $count++
                $rel = $ref.Substring($root.Length).TrimStart('/')
                # Bucket by the item's folder, two levels deep at most - deep
                # enough to point at the culprit, shallow enough to stay a
                # short list.
                $dir = if ([int]$it.FSObjType -eq 1) { $rel } else { ([string]$it.FileDirRef).Substring([Math]::Min($root.Length, ([string]$it.FileDirRef).Length)).TrimStart('/') }
                $parts = @(($dir -split '/') | Where-Object { $_ } | Select-Object -First 2)
                $key = $parts -join '/'
                $byFolder[$key] = 1 + [int]$byFolder[$key]
            }
            if ($OnProgress) { & $OnProgress $scanned $count }
            $next = $resp.'odata.nextLink'
            if (-not $next) { $next = $resp.'@odata.nextLink' }
            $url = $next
        }
    } catch {
        return [pscustomobject]@{ Checked = $false; Count = $count; Scanned = $scanned; Folders = @(); Error = $_.Exception.Message }
    }
    $folders = @($byFolder.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 |
            ForEach-Object { [pscustomobject]@{ path = $(if ($_.Key) { $_.Key } else { '(top level)' }); count = $_.Value } })
    return [pscustomobject]@{ Checked = $true; Count = $count; Scanned = $scanned; Folders = $folders; Error = $null }
}

# Assembles the report the UI shows and the engine logs. $Content from
# Test-MigrationContent, $UniquePerms from Get-UniquePermissionSummary (or
# $null when the source has no SharePoint permissions to check).
function New-PreflightReport {
    param(
        [Parameter(Mandatory)]$Content,
        $UniquePerms,
        [string]$TargetProvider = 'sharepoint'
    )
    $warnings = [System.Collections.Generic.List[string]]::new()
    $permsBlock = $null
    if ($UniquePerms) {
        $level = if (-not $UniquePerms.Checked) { 'unknown' }
            elseif ($UniquePerms.Count -ge $script:UniquePermsSupported) { 'error' }
            elseif ($UniquePerms.Count -ge $script:UniquePermsRecommended) { 'warn' }
            elseif ($UniquePerms.Count -gt 0) { 'info' } else { 'ok' }
        $permsBlock = @{
            checked     = [bool]$UniquePerms.Checked
            count       = [int]$UniquePerms.Count
            scanned     = [int]$UniquePerms.Scanned
            recommended = $script:UniquePermsRecommended
            supported   = $script:UniquePermsSupported
            level       = $level
            folders     = @($UniquePerms.Folders)
            error       = $UniquePerms.Error
        }
        switch ($level) {
            'unknown' { $warnings.Add("Unique-permission check could not run: $($UniquePerms.Error)") }
            'error' { $warnings.Add("$($UniquePerms.Count) items have their own permissions - over SharePoint's supported 50,000 per library. Flatten permissions before migrating; they are not copied and would have to be re-applied by hand.") }
            'warn' { $warnings.Add("$($UniquePerms.Count) items have their own permissions (Microsoft recommends under 5,000 per library). They are not copied - plan to re-apply them on the target.") }
            'info' { $warnings.Add("$($UniquePerms.Count) item(s) have their own permissions. They are not copied - re-apply them on the target if still needed.") }
        }
    }
    $blockers = $Content.LongPaths.Count + $Content.LargeFiles.Count
    return @{
        ok                = ($blockers -eq 0)
        checkedAt         = (Get-Date).ToUniversalTime().ToString('o')
        targetProvider    = $TargetProvider
        files             = $Content.Files
        folders           = $Content.Folders
        bytes             = [long]$Content.Bytes
        maxPathLength     = $Content.MaxPathLength
        targetPrefix      = $Content.TargetPrefix
        prefixLength      = $Content.PrefixLength
        longestPath       = $Content.LongestPath
        blockers          = $blockers
        longPaths         = @{ count = $Content.LongPaths.Count; items = @($Content.LongPaths | Sort-Object length -Descending | Select-Object -First $script:MaxListed) }
        longFolders       = @{ count = @($Content.LongFolders).Count; items = @($Content.LongFolders | Select-Object -First $script:MaxListed) }
        largeFiles        = @{ count = $Content.LargeFiles.Count; items = @($Content.LargeFiles | Sort-Object size -Descending | Select-Object -First $script:MaxListed) }
        uniquePermissions = $permsBlock
        warnings          = @($warnings)
    }
}

Export-ModuleMember -Function Test-MigrationContent, Get-UniquePermissionSummary, New-PreflightReport
