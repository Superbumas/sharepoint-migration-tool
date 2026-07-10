#Requires -Version 7.0

# Breadth-first walk of a document library folder, using Get-PnPFolderItem at
# each level rather than relying on any single cmdlet's built-in recursion -
# this keeps behaviour predictable across PnP.PowerShell versions and lets us
# build the exact relative paths we need for target mapping as we go.
function Get-PnPFolderTree {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$RootSiteRelativeUrl,
        # Invoked after each folder is processed with (foldersFound, filesFound,
        # foldersPending) - lets the caller surface progress during a walk that
        # can otherwise sit silent for 10+ minutes on large trees. Throttling
        # is the callback's job, not this function's.
        [scriptblock]$OnProgress
    )

    $root = $RootSiteRelativeUrl.TrimEnd('/')
    $queue = [System.Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($root)

    $files = [System.Collections.Generic.List[object]]::new()
    $folders = [System.Collections.Generic.List[string]]::new()

    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()

        $folderItems = Get-PnPFolderItem -FolderSiteRelativeUrl $current -ItemType Folder -Connection $Connection -ErrorAction Stop
        foreach ($f in $folderItems) {
            $childPath = "$current/$($f.Name)"
            # Folders is consumed as paths RELATIVE to the enumeration root
            # (Initialize-PnPTargetFolders appends them to the *target* root),
            # matching RelativeFromRoot on files. Storing the full source path
            # here re-nests the source library/root under the target root -
            # the pre-created tree then never matches the server-relative
            # target paths the copy lanes build, and every file in a subfolder
            # fails with "destination location does not exist".
            $folders.Add($childPath.Substring($root.Length).TrimStart('/'))
            $queue.Enqueue($childPath)
        }

        $fileItems = Get-PnPFolderItem -FolderSiteRelativeUrl $current -ItemType File -Connection $Connection -ErrorAction Stop
        foreach ($fi in $fileItems) {
            $relativeFromRoot = ($current.Substring($root.Length)).TrimStart('/')
            # TimeLastModified feeds the delta skip check: on a re-run, a file
            # is only skipped if the target copy is same-size AND at least as
            # new as the source - so a source file edited after the last run
            # gets re-copied even when its size happens to be unchanged.
            $modified = $null
            try { $modified = $fi.TimeLastModified } catch {}
            $files.Add([pscustomobject]@{
                SourceFolder     = $current
                Name             = $fi.Name
                Size             = [long]$fi.Length
                Modified         = $modified
                RelativeFromRoot = $relativeFromRoot
            })
        }

        if ($OnProgress) { & $OnProgress $folders.Count $files.Count $queue.Count }
    }

    return [pscustomobject]@{ Files = $files; Folders = $folders }
}

# Creates every target subfolder up front (single-threaded, before lanes start)
# so parallel file copies never race each other creating the same folder.
#
# Ensures each path level explicitly with Get-PnPFolder/Add-PnPFolder rather
# than Resolve-PnPFolder: creating level-by-level from the library root means
# a wrong path can never silently materialize a whole misplaced tree without
# also failing loudly on the first missing parent, and the ensured-set makes
# re-runs cheap.
function Initialize-PnPTargetFolders {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$TargetRootSiteRelativeUrl,
        # AllowEmptyCollection: a source folder with no subfolders (only files
        # directly inside it) legitimately produces an empty array here - same
        # class of issue as the earlier AllowEmptyString fixes, just for an
        # array instead of a string.
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$RelativeFolderPaths,
        # Invoked after each folder is ensured with (done, total) - same
        # progress-surfacing contract as Get-PnPFolderTree's OnProgress.
        [scriptblock]$OnProgress
    )
    $root = $TargetRootSiteRelativeUrl.TrimEnd('/')
    $ensured = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    $done = 0
    $total = $RelativeFolderPaths.Count + 1
    foreach ($rel in (@('') + $RelativeFolderPaths)) {
        $target = "$root/$rel".TrimEnd('/')
        $segments = $target.Split('/') | Where-Object { $_ }
        # Walk down from the library root, ensuring each level exists. The
        # first segment is the library's own root folder - it must already
        # exist; we never try to create it.
        for ($i = 2; $i -le $segments.Count; $i++) {
            $path = ($segments[0..($i - 1)] -join '/')
            if (-not $ensured.Add($path)) { continue }
            $existing = Get-PnPFolder -Url $path -Connection $Connection -ErrorAction SilentlyContinue
            if (-not $existing) {
                $parent = ($segments[0..($i - 2)] -join '/')
                Add-PnPFolder -Name $segments[$i - 1] -Folder $parent -Connection $Connection | Out-Null
            }
        }
        $done++
        if ($OnProgress) { & $OnProgress $done $total }
    }
}

Export-ModuleMember -Function Get-PnPFolderTree, Initialize-PnPTargetFolders
