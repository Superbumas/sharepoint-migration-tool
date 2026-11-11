# Copy item permissions ("Copy item permissions" job setting).
#
# Input: the "who had access" list the pre-flight writes (Get-ItemAccessGrants
# in Preflight.psm1) - for every source item with its own permissions, each
# grant that is not inherited. For the matching TARGET item this:
#   1. breaks inheritance, keeping the inherited permissions (the target
#      folder's own people stay);
#   2. re-grants direct user / group grants with the same role (owner becomes
#      edit - full control is never handed out by a migration);
#   3. re-creates sharing links of the same type and scope (a NEW link: the
#      old link's URL keeps pointing at the source and does not move);
#   4. skips guests unless IncludeGuests, people who can't be resolved on the
#      target (left the organisation), and - across tenants - anyone without
#      a row in the user mapping.
# Every grant gets a 'result' text; the caller writes it back into the access
# file so the CSV export carries it. Only the target connection is written
# to - the source is never touched. Re-runs are idempotent: role assignments
# that are already there and links of the same type/scope are reported as
# "already in place" instead of being added twice.

function Copy-ItemPermissions {
    param(
        [Parameter(Mandatory)]$Connection,                 # PnP connection to the TARGET site
        [Parameter(Mandatory)][string]$TargetSiteUrl,
        [Parameter(Mandatory)][string]$TargetDriveId,
        [Parameter(Mandatory)][AllowEmptyString()][string]$TargetServerRelRoot,  # /sites/x/Lib/path/leaf
        [Parameter(Mandatory)][AllowEmptyString()][string]$TargetPathInLib,      # path/leaf (drive-relative)
        [Parameter(Mandatory)][AllowEmptyString()][string]$SourceServerRelRoot,
        [Parameter(Mandatory)][object[]]$Items,
        [hashtable]$UserMap = @{},
        [bool]$CrossTenant = $false,
        [bool]$SameSite = $true,
        [bool]$IncludeGuests = $false,
        [scriptblock]$OnProgress,
        [scriptblock]$Log
    )
    $site = $TargetSiteUrl.TrimEnd('/')
    $say = { param($level, $msg) if ($Log) { & $Log $level $msg } }
    $rest = {
        param([string]$Method, [string]$Url, $Content)
        $p = @{ Method = $Method; Url = $Url; Connection = $Connection }
        if ($null -ne $Content) { $p.Content = $Content }
        Invoke-WithRetry -Action { Invoke-PnPSPRestMethod @p }
    }
    $graph = {
        param([string]$Method, [string]$Url, $Content)
        $p = @{ Method = $Method; Url = $Url; Connection = $Connection }
        if ($null -ne $Content) { $p.Content = $Content; $p.ContentType = 'application/json' }
        Invoke-WithRetry -Action { Invoke-PnPGraphMethod @p }
    }
    $escPath = { param($p) ((($p -replace '\\', '/') -split '/') | Where-Object { $_ } | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/' }
    $errText = { param($e)
        $m = "$($e.Exception.Message)"
        if ($m.Length -gt 220) { $m = $m.Substring(0, 220) + '...' }
        $m }

    # Role definitions on the target web: read -> Read, edit -> Edit (or
    # Contribute on webs without the Edit level), owner -> same as edit.
    $defs = @{}
    foreach ($d in @((& $rest 'Get' "$site/_api/web/roledefinitions?`$select=Id,Name" $null).value)) { $defs["$($d.Name)"] = [int]$d.Id }
    $editName = if ($defs.ContainsKey('Edit')) { 'Edit' } else { 'Contribute' }
    $roleFor = @{ read = 'Read'; edit = $editName; owner = $editName }

    $siteGroups = @{}
    foreach ($g in @((& $rest 'Get' "$site/_api/web/sitegroups?`$select=Id,Title" $null).value)) { $siteGroups["$($g.Title)".ToLowerInvariant()] = [int]$g.Id }

    # One ensureuser per identity for the whole run.
    $principalCache = @{}
    $ensure = {
        param([string[]]$Candidates)
        foreach ($cand in $Candidates) {
            if (-not $cand) { continue }
            $k = $cand.ToLowerInvariant()
            if ($principalCache.ContainsKey($k)) { if ($principalCache[$k]) { return $principalCache[$k] } else { continue } }
            try {
                $u = & $rest 'Post' "$site/_api/web/ensureuser" @{ logonName = $cand }
                $principalCache[$k] = [int]$u.Id
                return [int]$u.Id
            } catch { $principalCache[$k] = $null }
        }
        return $null
    }
    $mapIdentity = {
        # Returns @{ ok; who; why } - who is the email/login to resolve on the target.
        param($g)
        $email = "$($g.email)".Trim()
        $key = $email.ToLowerInvariant()
        if ($key -and $UserMap.ContainsKey($key)) { return @{ ok = $true; who = "$($UserMap[$key])" } }
        if ($CrossTenant) { return @{ ok = $false; why = "skipped: no user mapping for $(if ($email) { $email } else { $g.name }) (different tenant)" } }
        return @{ ok = $true; who = $email }
    }

    $stats = @{ items = 0; granted = 0; linksCreated = 0; already = 0; skipped = 0; failed = 0; inheritanceBroken = 0 }
    $done = 0
    foreach ($item in $Items) {
        $done++
        $grants = @($item.grants)
        if ($grants.Count -eq 0) { continue }
        $stats.items++
        $rel = "$($item.path)".Trim('/')
        $tgtSr = (@($TargetServerRelRoot.TrimEnd('/'), $rel) | Where-Object { $_ }) -join '/'
        $srcSr = (@($SourceServerRelRoot.TrimEnd('/'), $rel) | Where-Object { $_ }) -join '/'
        $setAll = { param($text, $bucket) foreach ($g in $grants) { if (-not $g.result) { $g.result = $text; $stats[$bucket]++ } } }
        foreach ($g in $grants) { $g.result = $null }
        if ($item.error) { & $setAll "skipped: the source permissions could not be read ($($item.error))" 'skipped'; continue }
        # Hard guard: never write to the source item, whatever the mapping says.
        if ($tgtSr.TrimEnd('/').ToLowerInvariant() -eq $srcSr.TrimEnd('/').ToLowerInvariant()) {
            & $setAll 'skipped: target is the same item as the source' 'skipped'; continue
        }
        $kind = if ("$($item.type)" -eq 'folder') { 'Folder' } else { 'File' }
        $enc = [uri]::EscapeDataString($tgtSr.Replace("'", "''"))
        $itemUrl = "$site/_api/web/Get$($kind)ByServerRelativePath(decodedurl='$enc')/ListItemAllFields"
        try {
            $li = & $rest 'Get' "$($itemUrl)?`$select=Id,HasUniqueRoleAssignments" $null
            if (-not $li -or -not $li.Id) { throw 'no list item' }
        } catch {
            & $setAll 'skipped: item not found at the target (not copied yet?)' 'skipped'; continue
        }
        try {
            if (-not $li.HasUniqueRoleAssignments) {
                & $rest 'Post' "$itemUrl/breakroleinheritance(copyRoleAssignments=true,clearSubscopes=false)" $null | Out-Null
                $stats.inheritanceBroken++
            }
        } catch {
            & $setAll "failed: could not give the target item its own permissions ($(& $errText $_))" 'failed'; continue
        }
        # What the target item already has: principalId -> role names.
        $have = @{}
        try {
            foreach ($a in @((& $rest 'Get' "$itemUrl/roleassignments?`$expand=RoleDefinitionBindings" $null).value)) {
                $have[[int]$a.PrincipalId] = @($a.RoleDefinitionBindings | ForEach-Object { "$($_.Name)" })
            }
        } catch {}

        # --- direct / group grants -----------------------------------------
        foreach ($g in $grants | Where-Object { $_.source -ne 'link' }) {
            if ($g.external -and -not $IncludeGuests) { $g.result = 'skipped: guest (include guests is off)'; $stats.skipped++; continue }
            $roleKey = "$($g.role)"
            if (-not $roleFor.ContainsKey($roleKey)) { $g.result = "skipped: role '$roleKey' has no equivalent"; $stats.skipped++; continue }
            $roleName = $roleFor[$roleKey]
            $principalId = $null
            # Lists recorded before 'kind' existed: a group without an email is a SharePoint site group.
            $gKind = if ($g.kind) { "$($g.kind)" } elseif ($g.source -eq 'group' -and -not $g.email) { 'siteGroup' } elseif ($g.source -eq 'group') { 'group' } else { 'user' }
            if ($gKind -eq 'siteGroup') {
                $nm = "$($g.name)".ToLowerInvariant()
                if ($siteGroups.ContainsKey($nm)) { $principalId = $siteGroups[$nm] }
                else { $g.result = "skipped: SharePoint group '$($g.name)' does not exist on the target site"; $stats.skipped++; continue }
            } else {
                $m = & $mapIdentity $g
                if (-not $m.ok) { $g.result = $m.why; $stats.skipped++; continue }
                $cands = @($m.who)
                if (-not $CrossTenant -or $m.who -ne "$($g.email)") {
                    if ($gKind -eq 'group' -and $g.principalId -and -not $CrossTenant) {
                        $cands += "c:0o.c|federateddirectoryclaimprovider|$($g.principalId)"
                        $cands += "c:0t.c|tenant|$($g.principalId)"
                    }
                    if ($g.login -and -not $CrossTenant) { $cands += "$($g.login)" }
                }
                $principalId = & $ensure ($cands | Where-Object { $_ })
                if (-not $principalId) { $g.result = "skipped: $(if ($m.who) { $m.who } else { $g.name }) could not be found on the target (left the organisation?)"; $stats.skipped++; continue }
            }
            if ($have.ContainsKey($principalId) -and ($have[$principalId] -contains $roleName)) {
                $g.result = "already in place ($roleName)"; $stats.already++; continue
            }
            try {
                & $rest 'Post' "$itemUrl/roleassignments/addroleassignment(principalid=$principalId,roledefid=$($defs[$roleName]))" $null | Out-Null
                if (-not $have.ContainsKey($principalId)) { $have[$principalId] = @() }
                $have[$principalId] += $roleName
                $g.result = "granted $roleName$(if ($roleKey -eq 'owner') { ' (owner given edit)' })"
                $stats.granted++
            } catch { $g.result = "failed: $(& $errText $_)"; $stats.failed++ }
        }

        # --- sharing links ---------------------------------------------------
        $linkRows = @($grants | Where-Object { $_.source -eq 'link' })
        if ($linkRows.Count -gt 0) {
            $driveItemId = $null
            $existing = @()
            try {
                $path = & $escPath ((@($TargetPathInLib, $rel) | Where-Object { $_ }) -join '/')
                $driveItemId = if ($path) { (& $graph 'Get' "v1.0/drives/$TargetDriveId/root:/$($path)?`$select=id" $null).id } else { (& $graph 'Get' "v1.0/drives/$TargetDriveId/root?`$select=id" $null).id }
                $existing = @((& $graph 'Get' "v1.0/drives/$TargetDriveId/items/$driveItemId/permissions" $null).value | Where-Object { $_.link -and -not $_.inheritedFrom })
            } catch {
                foreach ($g in $linkRows) { $g.result = "failed: target item not reachable through Graph ($(& $errText $_))"; $stats.failed++ }
                continue
            }
            $byLink = $linkRows | Group-Object { if ($_.linkId) { $_.linkId } else { "$($_.linkScope)|$($_.linkType)" } }
            foreach ($grp in $byLink) {
                $rows = @($grp.Group)
                $first = $rows[0]
                $scope = switch ("$($first.linkScope)") { 'anyone' { 'anonymous' } 'organisation' { 'organization' } 'specific people' { 'users' } default { $null } }
                if (-not $scope) { foreach ($g in $rows) { $g.result = "skipped: '$($first.linkScope)' links grant nothing new"; $stats.skipped++ }; continue }
                if ($first.hasPassword) { foreach ($g in $rows) { $g.result = 'skipped: the original link had a password - create it by hand'; $stats.skipped++ }; continue }
                $type = "$($first.linkType)".ToLowerInvariant()
                $typeNote = ''
                if ($type -notin @('view', 'edit')) { $typeNote = " ('$type' link re-created as view)"; $type = 'view' }

                # Recipients of a specific-people link go through the same
                # guest / mapping / resolve rules as direct grants.
                $recipients = @()
                if ($scope -eq 'users') {
                    foreach ($g in $rows) {
                        if (-not $g.email) { $g.result = 'skipped: link recipient has no email'; $stats.skipped++; continue }
                        if ($g.external -and -not $IncludeGuests) { $g.result = 'skipped: guest (include guests is off)'; $stats.skipped++; continue }
                        $m = & $mapIdentity $g
                        if (-not $m.ok) { $g.result = $m.why; $stats.skipped++; continue }
                        if (-not $g.external -and -not (& $ensure @($m.who))) { $g.result = "skipped: $($m.who) could not be found on the target (left the organisation?)"; $stats.skipped++; continue }
                        $recipients += @{ row = $g; email = $m.who }
                    }
                    if ($recipients.Count -eq 0) { continue }
                }

                $match = @($existing | Where-Object { "$($_.link.scope)" -eq $scope -and "$($_.link.type)" -eq $type }) | Select-Object -First 1
                $link = $null
                $created = $false
                if ($match) { $link = $match }
                else {
                    $body = @{ type = $type; scope = $scope; retainInheritedPermissions = $true }
                    $exp = $null
                    if ($first.expires -and [datetime]::TryParse("$($first.expires)", [ref]$exp) -and $exp.ToUniversalTime() -gt (Get-Date).ToUniversalTime().AddHours(1)) {
                        $body.expirationDateTime = $exp.ToUniversalTime().ToString('o')
                    }
                    try {
                        $link = & $graph 'Post' "v1.0/drives/$TargetDriveId/items/$driveItemId/createLink" ($body | ConvertTo-Json -Compress)
                        $created = $true
                        $existing += $link
                    } catch {
                        $why = & $errText $_
                        foreach ($g in $rows) { if (-not $g.result) { $g.result = "failed: could not create the $($first.linkScope) link ($why)"; $stats.failed++ } }
                        continue
                    }
                }
                $url = "$($link.link.webUrl)"
                if ($scope -eq 'users') {
                    $enc64 = 'u!' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($url)).TrimEnd('=').Replace('/', '_').Replace('+', '-')
                    $roles = @($(if ($type -eq 'edit') { 'write' } else { 'read' }))
                    foreach ($r in $recipients) {
                        try {
                            & $graph 'Post' "v1.0/shares/$enc64/permission/grant" (@{ recipients = @(@{ email = $r.email }); roles = $roles } | ConvertTo-Json -Compress -Depth 4) | Out-Null
                            $r.row.result = $(if ($created) { "new link created for $($r.email), old link URL no longer works: $url" } else { "already in place (link $url) - $($r.email) added" })
                            if ($created) { $stats.linksCreated++ } else { $stats.already++ }
                        } catch { $r.row.result = "failed: link created but $($r.email) could not be added ($(& $errText $_))"; $stats.failed++ }
                    }
                } else {
                    foreach ($g in $rows) {
                        if ($created) { $g.result = "new link created, old link URL no longer works: $url$typeNote"; $stats.linksCreated++ }
                        else { $g.result = "already in place (link $url)"; $stats.already++ }
                    }
                }
            }
        }
        if ($OnProgress) { & $OnProgress $done $Items.Count }
    }
    return $stats
}

Export-ModuleMember -Function Copy-ItemPermissions
