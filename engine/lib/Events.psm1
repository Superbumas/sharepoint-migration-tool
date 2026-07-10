#Requires -Version 7.0

# Every engine event is a single compact JSON line. Node parses stdout line by
# line (NDJSON), so nothing in this module may write anything else to stdout -
# callers on the main thread write the returned string directly with
# [Console]::Out.WriteLine(); lane threads enqueue it into the shared result
# queue instead of touching Console themselves (avoids interleaved/corrupted
# lines from concurrent writers).
function New-EngineEventJson {
    param(
        [Parameter(Mandatory)][string]$Type,
        [hashtable]$Data = @{}
    )
    $evt = [ordered]@{
        type = $Type
        ts   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    }
    foreach ($key in $Data.Keys) { $evt[$key] = $Data[$key] }
    return ($evt | ConvertTo-Json -Compress -Depth 10)
}

function Write-EngineEvent {
    param(
        [Parameter(Mandatory)][string]$Type,
        [hashtable]$Data = @{}
    )
    $line = New-EngineEventJson -Type $Type -Data $Data
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

Export-ModuleMember -Function New-EngineEventJson, Write-EngineEvent
