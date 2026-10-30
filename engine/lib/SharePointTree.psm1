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

# Carries each source folder's own list-item metadata over to its copy:
# Created / Modified / Author ("Created by") / Editor ("Modified by") and the
# folder colour. Folders are created fresh by Initialize-PnPTargetFolders
# (Copy-PnPFile only ever copies files), so without this pass every target
# folder shows the migration app as its creator/modifier, today's date, and
# the default yellow colour.
#
# Folder colour lives in the hidden '_ColorHex' field on the folder's list
# item (an index 0-15, not an actual hex value - 0/empty is the default
# yellow); the same value is mirrored in the folder property bag as
# 'vti_colorhex'. Microsoft doesn't document either, so the value is copied
# verbatim rather than mapped, and the property bag is only used as a
# fallback on whichever side lacks the field.
#
# Run AFTER the file copy: adding files into a folder can bump the folder's
# own Modified stamp, which would undo the restored date.
#
# Never throws per folder - a failure is reported through OnWarning and
# counted, because the files themselves are already safely copied. A person
# who can't be resolved on the target (left the organization, external
# account) retries the same folder without Author/Editor so the dates and
# colour still land.
function Copy-PnPFolderMetadata {
    param(
        [Parameter(Mandatory)]$SourceConnection,
        [Parameter(Mandatory)]$TargetConnection,
        [Parameter(Mandatory)][string]$SourceRootSiteRelativeUrl,
        [Parameter(Mandatory)][string]$TargetRootSiteRelativeUrl,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$RelativeFolderPaths,
        # Also stamp the migrated root folder itself (the source folder the
        # job was pointed at). False for a library-root source, whose root is
        # the library and has no item of its own.
        [switch]$IncludeRoot,
        [scriptblock]$OnProgress,
        [scriptblock]$OnWarning
    )
    $srcRoot = $SourceRootSiteRelativeUrl.TrimEnd('/')
    $tgtRoot = $TargetRootSiteRelativeUrl.TrimEnd('/')
    $result = @{ Total = 0; Updated = 0; AlreadyCorrect = 0; Coloured = 0; PeopleDropped = 0; Failed = 0 }

    $targetList = Get-PnPList -Identity (($tgtRoot -split '/')[0]) -Connection $TargetConnection -ErrorAction Stop
    $targetHasColorField = [bool](Get-PnPField -List $targetList -Identity '_ColorHex' -Connection $TargetConnection -ErrorAction SilentlyContinue)

    $paths = @($RelativeFolderPaths)
    if ($IncludeRoot) { $paths = @('') + $paths }
    $result.Total = $paths.Count
    $done = 0
    foreach ($rel in $paths) {
        $srcUrl = "$srcRoot/$rel".TrimEnd('/')
        $tgtUrl = "$tgtRoot/$rel".TrimEnd('/')
        try {
            $src = Get-PnPFolder -Url $srcUrl -Includes ListItemAllFields, Properties -Connection $SourceConnection -ErrorAction Stop
            $sf = $src.ListItemAllFields.FieldValues
            $tgt = Get-PnPFolder -Url $tgtUrl -Includes ListItemAllFields, Properties -Connection $TargetConnection -ErrorAction Stop
            $tf = $tgt.ListItemAllFields.FieldValues

            $color = $sf['_ColorHex']
            if ([string]::IsNullOrEmpty([string]$color)) { $color = $src.Properties.FieldValues['vti_colorhex'] }
            $color = if ([string]::IsNullOrEmpty([string]$color)) { $null } else { [string]$color }
            $tgtColor = $tf['_ColorHex']
            if ([string]::IsNullOrEmpty([string]$tgtColor)) { $tgtColor = $tgt.Properties.FieldValues['vti_colorhex'] }
            $tgtColor = if ([string]::IsNullOrEmpty([string]$tgtColor)) { $null } else { [string]$tgtColor }

            $authorEmail = if ($sf['Author']) { $sf['Author'].Email } else { $null }
            $editorEmail = if ($sf['Editor']) { $sf['Editor'].Email } else { $null }
            $tgtAuthorEmail = if ($tf['Author']) { $tf['Author'].Email } else { $null }
            $tgtEditorEmail = if ($tf['Editor']) { $tf['Editor'].Email } else { $null }

            # Re-runs: leave a folder alone when its copy already carries the
            # original stamp - cheap reads instead of a write per folder.
            $sameDate = { param($a, $b) (-not $a) -or ($b -and [Math]::Abs(([datetime]$a - [datetime]$b).TotalSeconds) -lt 2) }
            $upToDate = (& $sameDate $sf['Modified'] $tf['Modified']) -and (& $sameDate $sf['Created'] $tf['Created']) -and
                ((-not $editorEmail) -or ($tgtEditorEmail -eq $editorEmail)) -and
                ((-not $authorEmail) -or ($tgtAuthorEmail -eq $authorEmail)) -and
                ($color -eq $tgtColor)
            if ($upToDate) {
                $result.AlreadyCorrect++
            } else {
                $values = @{}
                if ($sf['Created']) { $values['Created'] = $sf['Created'] }
                if ($sf['Modified']) { $values['Modified'] = $sf['Modified'] }
                if ($color -and $targetHasColorField) { $values['_ColorHex'] = $color }
                $people = @{}
                if ($authorEmail) { $people['Author'] = $authorEmail }
                if ($editorEmail) { $people['Editor'] = $editorEmail }
                $itemId = $tgt.ListItemAllFields.Id
                try {
                    Set-PnPListItem -List $targetList -Identity $itemId -Values ($values + $people) -UpdateType UpdateOverwriteVersion -Connection $TargetConnection -ErrorAction Stop | Out-Null
                } catch {
                    if ($people.Count -eq 0) { throw }
                    Set-PnPListItem -List $targetList -Identity $itemId -Values $values -UpdateType UpdateOverwriteVersion -Connection $TargetConnection -ErrorAction Stop | Out-Null
                    $result.PeopleDropped++
                    if ($OnWarning) { & $OnWarning "Folder '$tgtUrl': dates/colour restored, but created-by/modified-by ($(($people.Values | Select-Object -Unique) -join ', ')) could not be set on the target - $($_.Exception.Message)" }
                }
                if ($color -and -not $targetHasColorField) {
                    Set-PnPPropertyBagValue -Folder $tgtUrl -Key 'vti_colorhex' -Value $color -Connection $TargetConnection -ErrorAction Stop | Out-Null
                }
                if ($color) { $result.Coloured++ }
                $result.Updated++
            }
        } catch {
            $result.Failed++
            if ($OnWarning) { & $OnWarning "Folder '$tgtUrl': could not copy its original metadata/colour - $($_.Exception.Message)" }
        }
        $done++
        if ($OnProgress) { & $OnProgress $done $paths.Count }
    }
    return $result
}

Export-ModuleMember -Function Get-PnPFolderTree, Initialize-PnPTargetFolders, Copy-PnPFolderMetadata
