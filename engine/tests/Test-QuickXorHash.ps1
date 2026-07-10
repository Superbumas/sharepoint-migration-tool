#Requires -Version 7.0
<#
.SYNOPSIS
  Property-tests FileSystemSource.psm1's C# QuickXorHash against an
  independent, naive bit-by-bit implementation of the documented algorithm.

.DESCRIPTION
  The spec (https://learn.microsoft.com/onedrive/developer/code-snippets/quickxorhash):
  each input byte i is XORed into a circular 160-bit vector so that bit b of
  the byte lands at bit position (i*11 + b) mod 160; the digest is those 160
  bits little-endian (global bit p -> output byte p/8, bit p%8) with the
  8-byte little-endian total input length XORed into the last 8 of the 20
  output bytes.

  The naive implementation below encodes ONLY that sentence - none of the
  cell/shift arithmetic the fast C# version uses - so agreement across sizes
  that straddle every boundary (empty, <160, ==160, chunked multi-block,
  cell-boundary offsets) is strong evidence the fast version is faithful.
  A wrong hash here would be worse than no hash: verification would flag
  every migrated file as a mismatch (or worse, a subtly broken hash could
  collide with nothing and mask nothing - either way, this must be exact).

  Exits 0 with "ALL PASSED" or 1 with the first mismatch.
#>

$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/../lib/FileSystemSource.psm1" -Force

function Get-NaiveQuickXorHash {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Data)
    $bits = [bool[]]::new(160)
    for ($i = 0; $i -lt $Data.Length; $i++) {
        $p = ($i * 11) % 160
        for ($b = 0; $b -lt 8; $b++) {
            if ((($Data[$i] -shr $b) -band 1) -eq 1) {
                $pos = ($p + $b) % 160
                $bits[$pos] = -not $bits[$pos]
            }
        }
    }
    $bytes = [byte[]]::new(20)
    for ($pos = 0; $pos -lt 160; $pos++) {
        if ($bits[$pos]) { $bytes[[int][Math]::Floor($pos / 8)] = $bytes[[int][Math]::Floor($pos / 8)] -bxor (1 -shl ($pos % 8)) }
    }
    $len = [BitConverter]::GetBytes([long]$Data.Length)
    for ($i = 0; $i -lt 8; $i++) { $bytes[12 + $i] = $bytes[12 + $i] -bxor $len[$i] }
    return [Convert]::ToBase64String($bytes)
}

function Get-FastQuickXorHash {
    param([Parameter(Mandatory)][AllowEmptyCollection()][byte[]]$Data, [int]$ChunkSize = 0)
    $algo = [MigrationEngine.QuickXorHash]::new()
    try {
        if ($ChunkSize -gt 0 -and $Data.Length -gt 0) {
            # Feed in uneven chunks to exercise the cross-call shift state
            # (HashCore is stateful; ComputeHash on a stream calls it
            # repeatedly with arbitrary block sizes).
            $offset = 0
            while ($offset -lt $Data.Length) {
                $n = [Math]::Min($ChunkSize, $Data.Length - $offset)
                $algo.TransformBlock($Data, $offset, $n, $null, 0) | Out-Null
                $offset += $n
            }
            $algo.TransformFinalBlock([byte[]]::new(0), 0, 0) | Out-Null
            return [Convert]::ToBase64String($algo.Hash)
        }
        return [Convert]::ToBase64String($algo.ComputeHash($Data))
    } finally {
        $algo.Dispose()
    }
}

$rng = [System.Random]::new(42)  # deterministic - failures must reproduce
function New-RandomBytes([int]$n) {
    $b = [byte[]]::new($n)
    $rng.NextBytes($b)
    # Unary comma: an empty (or any) array returned bare gets enumerated by
    # the pipeline - a 0-length byte[] would arrive at the caller as $null.
    return , $b
}

$failures = 0
$cases = [System.Collections.Generic.List[object]]::new()
# Boundary sizes: empty; sub-width; exactly the 160-byte width and neighbors;
# cell-boundary bit offsets (the 64/64/32-bit cells wrap at bytes whose
# (i*11 mod 160) lands near 56-64 and 120-128 and 152-160); multi-KB.
foreach ($size in @(0, 1, 2, 7, 8, 20, 159, 160, 161, 320, 1000, 4096, 65537)) {
    $cases.Add(@{ Name = "random[$size]"; Data = (New-RandomBytes $size) })
}
$cases.Add(@{ Name = 'all-zero[500]'; Data = [byte[]]::new(500) })
$cases.Add(@{ Name = 'all-FF[500]'; Data = ([byte[]](, [byte]255 * 500)) })

foreach ($case in $cases) {
    $naive = Get-NaiveQuickXorHash -Data $case.Data
    $fast = Get-FastQuickXorHash -Data $case.Data
    $status = $fast -eq $naive ? 'ok' : 'MISMATCH'
    if ($fast -ne $naive) { $failures++ }
    Write-Host ("{0,-16} naive={1} fast={2} {3}" -f $case.Name, $naive, $fast, $status)

    # Same data fed in awkward chunk sizes must agree too.
    foreach ($chunk in @(1, 3, 160, 333)) {
        if ($case.Data.Length -eq 0) { continue }
        $chunked = Get-FastQuickXorHash -Data $case.Data -ChunkSize $chunk
        if ($chunked -ne $naive) {
            $failures++
            Write-Host ("{0,-16} CHUNKED({1}) MISMATCH: {2}" -f $case.Name, $chunk, $chunked)
        }
    }
}

# Get-FileQuickXorHash (the streaming file wrapper the engine actually calls)
# must agree with the in-memory result.
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "qxh-test-$PID.bin"
$fileData = New-RandomBytes 100000
[System.IO.File]::WriteAllBytes($tmp, $fileData)
try {
    $fromFile = Get-FileQuickXorHash -Path $tmp
    $fromMem = Get-NaiveQuickXorHash -Data $fileData
    if ($fromFile -ne $fromMem) {
        $failures++
        Write-Host "FILE WRAPPER MISMATCH: file=$fromFile mem=$fromMem"
    } else {
        Write-Host "file-wrapper     $fromFile ok"
    }
} finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

if ($failures -gt 0) {
    Write-Host "FAILED: $failures mismatch(es)" -ForegroundColor Red
    exit 1
}
Write-Host 'ALL PASSED' -ForegroundColor Green
exit 0
