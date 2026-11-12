# Real content check for files SharePoint rewrites on ingestion.
#
# Office documents, legacy Office binaries and saved web pages never come out
# of SharePoint byte-identical, so the size/QuickXorHash comparison cannot
# vouch for them. Instead of waving them through as "expected", both copies
# are downloaded and compared with only the parts SharePoint is known to
# touch left out. Measured on a live tenant (2026-11-11):
#
#   OOXML zip (.docx/.xlsx/.pptx/.xlsb/...): SharePoint ADDS customXml/* and
#     (after a cross-site server-side copy) an OPC [trash]/ entry, and
#     docProps/custom.xml (ContentTypeId) and CHANGES [Content_Types].xml and
#     the .rels files only to register those parts. Every content part is
#     byte-identical.
#   HTML (.htm/.html): byte-identical on upload; stamping created/modified-by
#     inserts two xmlns attributes into <html ...> and one
#     <!--[if gte mso 9]><xml>...</xml><![endif]--> block before </head>.
#     Removing exactly those gives back the original bytes.
#   OLE binaries (.doc/.xls/.ppt/.pps): SharePoint adds MsoDataStore/* and
#     rewrites \x05DocumentSummaryInformation; every content stream
#     (WordDocument, 1Table, Workbook, PowerPoint Document, ...) is identical.
#
# Result Status values:
#   equivalent  - content proven the same (only SharePoint's own parts differ)
#   different   - content differs: a real problem
#   unchecked   - format not covered, file too large, or an untested format
#                 (.msg, .one, .mht) that differs - reported, never "verified"

$script:ZipExtensions = @('.docx', '.docm', '.dotx', '.dotm', '.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb',
    '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm', '.vsdx')
$script:HtmlExtensions = @('.htm', '.html')
$script:OleStrictExtensions = @('.doc', '.dot', '.xls', '.xlt', '.ppt', '.pps', '.pot')
# Same container formats but SharePoint's exact changes are not measured yet:
# a difference is reported as "unchecked", never silently accepted.
$script:OleLenientExtensions = @('.msg')
$script:HtmlLenientExtensions = @('.mht', '.mhtml')

if (-not ('SpmtCfbReader' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

// Minimal read-only Compound File Binary (OLE2) reader: returns every stream
// as "Storage/Sub/Stream" -> SHA-256 hex. Enough for comparing legacy
// Office files stream by stream.
public static class SpmtCfbReader {
    const uint ENDOFCHAIN = 0xFFFFFFFE, FREESECT = 0xFFFFFFFF;

    static uint U32(byte[] b, long o) { return BitConverter.ToUInt32(b, (int)o); }
    static ushort U16(byte[] b, long o) { return BitConverter.ToUInt16(b, (int)o); }

    public static Dictionary<string, string> ReadStreams(byte[] d) {
        if (d.Length < 512 || U32(d, 0) != 0xE011CFD0 || U32(d, 4) != 0xE11AB1A1)
            throw new InvalidOperationException("not an OLE compound file");
        int secSize = 1 << U16(d, 0x1E);
        int miniSecSize = 1 << U16(d, 0x20);
        uint firstDir = U32(d, 0x30);
        uint miniCutoff = U32(d, 0x38);
        uint firstMiniFat = U32(d, 0x3C);
        uint firstDifat = U32(d, 0x44);
        uint numDifat = U32(d, 0x48);

        Func<uint, long> off = s => (long)(s + 1) * secSize;

        // DIFAT -> list of FAT sectors
        var fatSectors = new List<uint>();
        for (int i = 0; i < 109; i++) {
            uint s = U32(d, 0x4C + i * 4);
            if (s != FREESECT && s != ENDOFCHAIN) fatSectors.Add(s);
        }
        uint ds = firstDifat;
        for (uint n = 0; n < numDifat && ds != ENDOFCHAIN && ds != FREESECT; n++) {
            long o = off(ds);
            int per = secSize / 4 - 1;
            for (int i = 0; i < per; i++) {
                uint s = U32(d, o + i * 4);
                if (s != FREESECT && s != ENDOFCHAIN) fatSectors.Add(s);
            }
            ds = U32(d, o + per * 4);
        }
        var fat = new List<uint>();
        foreach (var fs in fatSectors) {
            long o = off(fs);
            for (int i = 0; i < secSize / 4 && o + i * 4 + 4 <= d.Length; i++) fat.Add(U32(d, o + i * 4));
        }

        Func<uint, long, byte[]> readChain = (start, size) => {
            var ms = new System.IO.MemoryStream();
            uint s = start; int guard = 0;
            while (s != ENDOFCHAIN && s != FREESECT && s < fat.Count && guard++ < 10000000) {
                long o = off(s);
                int len = (int)Math.Min(secSize, Math.Max(0, d.Length - o));
                ms.Write(d, (int)o, len);
                s = fat[(int)s];
            }
            var all = ms.ToArray();
            if (size >= 0 && all.Length > size) Array.Resize(ref all, (int)size);
            return all;
        };

        byte[] dir = readChain(firstDir, -1);
        int nEntries = dir.Length / 128;
        // Root entry (0) holds the mini stream.
        uint rootStart = U32(dir, 0x74);
        long rootSize = (long)BitConverter.ToUInt64(dir, 0x78);
        byte[] miniStream = rootSize > 0 ? readChain(rootStart, rootSize) : new byte[0];
        byte[] miniFatBytes = firstMiniFat != ENDOFCHAIN ? readChain(firstMiniFat, -1) : new byte[0];
        var miniFat = new List<uint>();
        for (int i = 0; i + 4 <= miniFatBytes.Length; i += 4) miniFat.Add(U32(miniFatBytes, i));

        Func<uint, long, byte[]> readMini = (start, size) => {
            var ms = new System.IO.MemoryStream();
            uint s = start; int guard = 0;
            while (s != ENDOFCHAIN && s != FREESECT && s < miniFat.Count && guard++ < 10000000) {
                long o = (long)s * miniSecSize;
                int len = (int)Math.Min(miniSecSize, Math.Max(0, miniStream.Length - o));
                if (len > 0) ms.Write(miniStream, (int)o, len);
                s = miniFat[(int)s];
            }
            var all = ms.ToArray();
            if (all.Length > size) Array.Resize(ref all, (int)size);
            return all;
        };

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var sha = SHA256.Create();
        var visited = new HashSet<uint>();
        Action<uint, string> walk = null;
        walk = (id, prefix) => {
            if (id == FREESECT || id >= nEntries || !visited.Add(id)) return;
            long e = (long)id * 128;
            int nameLen = U16(dir, e + 0x40);
            string name = nameLen >= 2 ? Encoding.Unicode.GetString(dir, (int)e, nameLen - 2) : "";
            byte type = dir[e + 0x42];
            uint left = U32(dir, e + 0x44), right = U32(dir, e + 0x48), child = U32(dir, e + 0x4C);
            uint start = U32(dir, e + 0x74);
            long size = (long)(BitConverter.ToUInt64(dir, (int)e + 0x78) & (secSize == 512 ? 0xFFFFFFFFUL : ulong.MaxValue));
            walk(left, prefix);
            walk(right, prefix);
            string path = prefix.Length == 0 ? name : prefix + "/" + name;
            if (type == 2) {
                byte[] data = size == 0 ? new byte[0] : (size < miniCutoff ? readMini(start, size) : readChain(start, size));
                result[path] = BitConverter.ToString(sha.ComputeHash(data)).Replace("-", "");
            } else if (type == 1) {
                walk(child, path);
            }
        };
        // Root's child starts the tree.
        walk(U32(dir, 0x4C), "");
        return result;
    }
}
'@
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($sha.ComputeHash($Bytes)).Replace('-', '') } finally { $sha.Dispose() }
}

# --- OOXML -----------------------------------------------------------------
function Test-IgnoredOpcPart([string]$Name) {
    $n = $Name.ToLowerInvariant()
    return $n.StartsWith('customxml/') -or $n.StartsWith('[trash]/') -or $n -eq 'docprops/custom.xml' -or $n -eq 'docprops/core.xml' -or $n -eq 'docprops/app.xml'
}
function Test-IgnoredRelTarget([string]$Type, [string]$Target) {
    $t = "$Target".ToLowerInvariant().Replace('\', '/')
    return $t -match '(^|/)customxml/' -or $t -match '(^|/)docprops/(custom|core|app)\.xml$' -or
        $Type -match '/(customXml|custom-properties|core-properties|extended-properties)$'
}
function Get-NormalizedOpcPart([string]$Name, [byte[]]$Bytes) {
    $lower = $Name.ToLowerInvariant()
    if ($lower -eq '[content_types].xml') {
        [xml]$x = [System.Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF)
        $lines = foreach ($n in $x.DocumentElement.ChildNodes) {
            if ($n.LocalName -eq 'Default') { "D|$($n.Extension.ToLowerInvariant())|$($n.ContentType)" }
            elseif ($n.LocalName -eq 'Override') {
                $p = "$($n.PartName)".TrimStart('/')
                if (-not (Test-IgnoredOpcPart $p)) { "O|$($p.ToLowerInvariant())|$($n.ContentType)" }
            }
        }
        return (($lines | Sort-Object) -join "`n")
    }
    if ($lower.EndsWith('.rels')) {
        [xml]$x = [System.Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF)
        $lines = foreach ($n in $x.DocumentElement.ChildNodes) {
            if ($n.LocalName -ne 'Relationship') { continue }
            if (Test-IgnoredRelTarget $n.Type $n.Target) { continue }
            "$($n.Id)|$($n.Type)|$($n.Target)|$($n.TargetMode)"
        }
        return (($lines | Sort-Object) -join "`n")
    }
    return Get-Sha256Hex $Bytes
}
# [Content_Types].xml compared by what it means: the content type each
# real part of the package resolves to (its Override, else the Default for
# its extension). SharePoint (and Office on re-save) may add, drop or
# reorder unused Defaults/Overrides, change case or URL-escaping of part
# names, which does not change how any part is read. A part whose type
# really changes is still caught.
function Get-EffectiveContentTypes([byte[]]$Bytes, [string[]]$PartNames) {
    [xml]$x = [System.Text.Encoding]::UTF8.GetString($Bytes).TrimStart([char]0xFEFF)
    $defaults = @{}; $overrides = @{}
    foreach ($n in $x.DocumentElement.ChildNodes) {
        if ($n.LocalName -eq 'Default') { $defaults["$($n.Extension)".ToLowerInvariant()] = "$($n.ContentType)".Trim().ToLowerInvariant() }
        elseif ($n.LocalName -eq 'Override') {
            $pn = [System.Uri]::UnescapeDataString("$($n.PartName)").TrimStart('/').ToLowerInvariant()
            $overrides[$pn] = "$($n.ContentType)".Trim().ToLowerInvariant()
        }
    }
    $lines = foreach ($name in $PartNames) {
        $pn = [System.Uri]::UnescapeDataString($name.Replace('\', '/')).TrimStart('/').ToLowerInvariant()
        if ($pn.EndsWith('/') -or $pn -eq '[content_types].xml' -or (Test-IgnoredOpcPart $pn)) { continue }
        $type = if ($overrides.ContainsKey($pn)) { $overrides[$pn] } else {
            $ext = [System.IO.Path]::GetExtension($pn).TrimStart('.')
            if ($defaults.ContainsKey($ext)) { $defaults[$ext] } else { '(none)' }
        }
        "$pn|$type"
    }
    return (($lines | Sort-Object) -join "`n")
}
function Get-OpcPartMap([byte[]]$Bytes) {
    $map = @{}
    $ms = [System.IO.MemoryStream]::new($Bytes)
    $zip = [System.IO.Compression.ZipArchive]::new($ms, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
        $allNames = @($zip.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        foreach ($e in $zip.Entries) {
            if ($e.FullName.EndsWith('/')) { continue }
            $name = $e.FullName.Replace('\', '/')
            if (Test-IgnoredOpcPart $name) { continue }
            $s = $e.Open(); $buf = [System.IO.MemoryStream]::new()
            try { $s.CopyTo($buf) } finally { $s.Dispose() }
            $map[$name.ToLowerInvariant()] = if ($name.ToLowerInvariant() -eq '[content_types].xml') {
                Get-EffectiveContentTypes $buf.ToArray() $allNames
            } else { Get-NormalizedOpcPart $name $buf.ToArray() }
        }
    } finally { $zip.Dispose(); $ms.Dispose() }
    return $map
}
function Compare-PartMaps([hashtable]$Src, [hashtable]$Tgt) {
    $diff = [System.Collections.Generic.List[string]]::new()
    foreach ($k in $Src.Keys) {
        if (-not $Tgt.ContainsKey($k)) { $diff.Add("missing $k") } elseif ($Src[$k] -ne $Tgt[$k]) { $diff.Add("changed $k") }
    }
    foreach ($k in $Tgt.Keys) { if (-not $Src.ContainsKey($k)) { $diff.Add("added $k") } }
    return $diff
}

# --- OOXML by zip index (no full download) ---------------------------------
# A zip ends with a central directory listing every part with its size and
# the CRC32 of its uncompressed content. Download links accept HTTP Range,
# so only the last 64 KB (plus the few small [Content_Types].xml / .rels
# parts SharePoint edits, which are normalised as in a full check) are
# fetched from each side, whatever the file's size. Any doubt (no Range
# support, zip64, unreadable index) throws, and the caller falls back to
# the full download.
# SharePoint throttles bursts of downloads with 429 (or 503) and a
# Retry-After header. Every request here waits and retries instead of
# giving up, so throttling slows a check down but never leaves files
# "could not be checked".
# $Gate (a synchronized hashtable shared by all lanes) makes one lane's
# throttle slow every lane down: nobody sends until Gate.Until has passed.
# It also paces requests to stay under SharePoint's limit instead of only
# reacting to it: the first 429/503 opens a small gap between any two
# requests (all lanes together, $script:GateStartMs), each further one
# doubles it up to $script:GateMaxMs, and every $script:GateEaseSec seconds
# without one the gap halves until requests flow freely again. (The first
# version started at 100 ms and eased only every 20 s, which held all lanes
# to ~10 requests/s for minutes after one short burst of 429s.)
$script:GateStartMs = 8
$script:GateMaxMs = 1000
$script:GateEaseSec = 10
function Wait-GateSlot($Gate) {
    $slot = $null
    [System.Threading.Monitor]::Enter($Gate.SyncRoot)
    try {
        $now = [DateTime]::UtcNow
        if ($Gate.Interval -gt 0 -and ($now - $Gate.LastThrottleAt).TotalSeconds -ge $script:GateEaseSec -and ($now - $Gate.LastEaseAt).TotalSeconds -ge $script:GateEaseSec) {
            $Gate.Interval = if ($Gate.Interval -le $script:GateStartMs) { 0 } else { [int]($Gate.Interval / 2) }
            $Gate.LastEaseAt = $now
        }
        $slot = if ($Gate.Until -gt $now) { $Gate.Until } else { $now }
        if ($Gate.Interval -gt 0) {
            if ($Gate.NextAt -gt $slot) { $slot = $Gate.NextAt }
            $Gate.NextAt = $slot.AddMilliseconds($Gate.Interval)
        }
    } finally { [System.Threading.Monitor]::Exit($Gate.SyncRoot) }
    $pause = ($slot - [DateTime]::UtcNow).TotalMilliseconds
    if ($pause -gt 0) { Start-Sleep -Milliseconds ([int]$pause) }
}
function Send-HttpWithRetry([System.Net.Http.HttpClient]$Http, [string]$Url, $Range, $Gate, [int]$MaxAttempts = 10) {
    if ($Gate) { foreach ($k in 'Interval', 'NextAt', 'LastThrottleAt', 'LastEaseAt') { if (-not $Gate.ContainsKey($k)) { $Gate[$k] = if ($k -eq 'Interval') { 0 } else { [DateTime]::MinValue } } } }
    for ($attempt = 1; ; $attempt++) {
        if ($Gate) {
            Wait-GateSlot $Gate
            # A little jitter after a throttle pause so lanes don't restart in step.
            if ($attempt -gt 1) { Start-Sleep -Milliseconds (Get-Random -Maximum 500) }
        }
        $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
        if ($Range) { $req.Headers.Range = $Range }
        $resp = $Http.SendAsync($req).GetAwaiter().GetResult()
        $code = [int]$resp.StatusCode
        if (($code -ne 429 -and $code -ne 503 -and $code -ne 504) -or $attempt -ge $MaxAttempts) { return $resp }
        # The longer of our own doubling backoff and SharePoint's Retry-After.
        # Under sustained throttling SharePoint keeps answering "Retry-After:
        # 1", and taking that literally gave up after ~10 s (seen on hilasti:
        # 96 of 3,000 files left unchecked). Our own backoff starts at 1 s
        # (1, 2, 4 ... 60 s): Retry-After still sets the minimum.
        $wait = [Math]::Min(60, [Math]::Pow(2, $attempt - 1))
        $ra = $resp.Headers.RetryAfter
        if ($ra -and $ra.Delta) { $wait = [Math]::Min(120, [Math]::Max($wait, $ra.Delta.Value.TotalSeconds)) }
        elseif ($ra -and $ra.Date) { $wait = [Math]::Min(120, [Math]::Max($wait, ($ra.Date.Value - [DateTimeOffset]::UtcNow).TotalSeconds)) }
        $resp.Dispose(); $req.Dispose()
        if ($Gate) {
            $until = [DateTime]::UtcNow.AddSeconds($wait)
            [System.Threading.Monitor]::Enter($Gate.SyncRoot)
            try {
                if ($until -gt $Gate.Until) { $Gate.Until = $until }
                $Gate.Interval = [Math]::Min($script:GateMaxMs, [Math]::Max($script:GateStartMs, [int]$Gate.Interval * 2))
                $Gate.LastThrottleAt = [DateTime]::UtcNow
                $Gate.Throttles++
                $Gate.LastWait = [int][Math]::Ceiling($wait)
            } finally { [System.Threading.Monitor]::Exit($Gate.SyncRoot) }
        } else {
            Start-Sleep -Milliseconds ([int]($wait * 1000) + (Get-Random -Maximum 1000))
        }
    }
}
function Get-HttpBytes([System.Net.Http.HttpClient]$Http, [string]$Url, $Gate) {
    $resp = Send-HttpWithRetry $Http $Url $null $Gate
    try {
        if (-not $resp.IsSuccessStatusCode) { throw "download returned $([int]$resp.StatusCode) ($($resp.ReasonPhrase))" }
        return , $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
    } finally { $resp.Dispose() }
}
function Read-ZipRange([hashtable]$Ref, [long]$Offset, [long]$Count) {
    if ($Count -le 0) { return [byte[]]::new(0) }
    if ($Ref.File) {
        $fs = [System.IO.File]::OpenRead($Ref.File)
        try {
            $null = $fs.Seek($Offset, 'Begin'); $buf = [byte[]]::new($Count); $read = 0
            while ($read -lt $Count) { $n = $fs.Read($buf, $read, $Count - $read); if ($n -le 0) { break }; $read += $n }
            if ($read -ne $Count) { throw 'short read' }
            return , $buf
        } finally { $fs.Dispose() }
    }
    $resp = Send-HttpWithRetry $Ref.Http $Ref.Url ([System.Net.Http.Headers.RangeHeaderValue]::new($Offset, $Offset + $Count - 1)) $Ref.Gate
    try {
        if ([int]$resp.StatusCode -ne 206) { throw "range request returned $([int]$resp.StatusCode)" }
        $b = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ($b.Length -ne $Count) { throw 'range request returned the wrong length' }
        return , $b
    } finally { $resp.Dispose() }
}
function Read-ZipTail([hashtable]$Ref, [int]$Want) {
    if ($Ref.File) {
        $total = (Get-Item -LiteralPath $Ref.File).Length
        $off = [Math]::Max(0, $total - $Want)
        return @{ Bytes = (Read-ZipRange $Ref $off ($total - $off)); Total = $total }
    }
    $resp = Send-HttpWithRetry $Ref.Http $Ref.Url ([System.Net.Http.Headers.RangeHeaderValue]::new($null, $Want)) $Ref.Gate
    if ([int]$resp.StatusCode -eq 416) {
        # SharePoint answers a suffix range longer than the file with 416
        # (not the whole file, as HTTP allows) - the file is smaller than
        # $Want, so just fetch all of it.
        $resp.Dispose()
        $resp = Send-HttpWithRetry $Ref.Http $Ref.Url $null $Ref.Gate
    }
    try {
        $b = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ([int]$resp.StatusCode -eq 200) { return @{ Bytes = $b; Total = [long]$b.Length } }
        if ([int]$resp.StatusCode -ne 206 -or -not $resp.Content.Headers.ContentRange.Length) { throw "range request returned $([int]$resp.StatusCode)" }
        return @{ Bytes = $b; Total = [long]$resp.Content.Headers.ContentRange.Length }
    } finally { $resp.Dispose() }
}
function Get-ZipDirectory([hashtable]$Ref) {
    $tail = Read-ZipTail $Ref 65536
    $b = $tail.Bytes
    $eocd = -1
    for ($i = $b.Length - 22; $i -ge 0; $i--) {
        if ($b[$i] -eq 0x50 -and $b[$i + 1] -eq 0x4B -and $b[$i + 2] -eq 0x05 -and $b[$i + 3] -eq 0x06) { $eocd = $i; break }
    }
    if ($eocd -lt 0) { throw 'zip index not found in the last 64 KB' }
    [long]$cdSize = [BitConverter]::ToUInt32($b, $eocd + 12)
    [long]$cdOff = [BitConverter]::ToUInt32($b, $eocd + 16)
    if ($cdOff -eq 0xFFFFFFFFL -or $cdSize -eq 0xFFFFFFFFL) { throw 'zip64' }
    if ($cdSize -le 0) { throw 'empty zip index' }
    $tailStart = $tail.Total - $b.Length
    # Plain assignments and Array.Copy, never "$cd = if (...) { $bytes }" or
    # $b[a..b]: those push every byte through the pipeline and leave $cd an
    # object[] of boxed bytes, which every BitConverter call below then
    # copies back to byte[] - seconds of CPU per many-part document, and it
    # gets far worse with parallel lanes fighting over the garbage collector.
    if ($cdOff -ge $tailStart -and ($cdOff + $cdSize) -le $tail.Total) {
        $cd = [byte[]]::new($cdSize)
        [Array]::Copy($b, [long]($cdOff - $tailStart), $cd, [long]0, [long]$cdSize)
    } else { $cd = Read-ZipRange $Ref $cdOff $cdSize }
    if ($cd -isnot [byte[]]) { throw 'zip index read did not return bytes' }
    $map = @{}
    $p = 0
    while ($p + 46 -le $cd.Length -and [BitConverter]::ToUInt32($cd, $p) -eq 0x02014B50) {
        $nameLen = [BitConverter]::ToUInt16($cd, $p + 28)
        $extraLen = [BitConverter]::ToUInt16($cd, $p + 30)
        $commentLen = [BitConverter]::ToUInt16($cd, $p + 32)
        $name = [System.Text.Encoding]::UTF8.GetString($cd, $p + 46, $nameLen).Replace('\', '/')
        $e = @{
            Name = $name
            Method = [BitConverter]::ToUInt16($cd, $p + 10)
            Crc = [BitConverter]::ToUInt32($cd, $p + 16)
            CSize = [long][BitConverter]::ToUInt32($cd, $p + 20)
            USize = [long][BitConverter]::ToUInt32($cd, $p + 24)
            Offset = [long][BitConverter]::ToUInt32($cd, $p + 42)
        }
        if ($e.CSize -eq 0xFFFFFFFFL -or $e.USize -eq 0xFFFFFFFFL -or $e.Offset -eq 0xFFFFFFFFL) { throw 'zip64' }
        if (-not $name.EndsWith('/')) { $map[$name.ToLowerInvariant()] = $e }
        $p += 46 + $nameLen + $extraLen + $commentLen
    }
    if ($map.Count -eq 0) { throw 'empty or unreadable zip index' }
    return $map
}
function Get-ZipEntryBytes([hashtable]$Ref, [hashtable]$Entry) {
    $h = Read-ZipRange $Ref $Entry.Offset 30
    if ([BitConverter]::ToUInt32($h, 0) -ne 0x04034B50) { throw "bad local header for $($Entry.Name)" }
    $dataOff = $Entry.Offset + 30 + [BitConverter]::ToUInt16($h, 26) + [BitConverter]::ToUInt16($h, 28)
    $data = Read-ZipRange $Ref $dataOff $Entry.CSize
    if ($Entry.Method -eq 0) { return , $data }
    if ($Entry.Method -ne 8) { throw "unsupported compression in $($Entry.Name)" }
    $in = [System.IO.MemoryStream]::new($data); $out = [System.IO.MemoryStream]::new()
    $z = [System.IO.Compression.DeflateStream]::new($in, [System.IO.Compression.CompressionMode]::Decompress)
    try { $z.CopyTo($out) } finally { $z.Dispose(); $in.Dispose() }
    return , $out.ToArray()
}
# Returns $null for a non-zip extension; throws when the index route can't
# decide (caller then downloads both files in full).
function Test-RemoteZipContent {
    param([Parameter(Mandatory)][hashtable]$Source, [Parameter(Mandatory)][hashtable]$Target, [Parameter(Mandatory)][string]$Extension)
    if ($script:ZipExtensions -notcontains $Extension.ToLowerInvariant()) { return $null }
    $src = Get-ZipDirectory $Source
    $tgt = Get-ZipDirectory $Target
    $diff = [System.Collections.Generic.List[string]]::new()
    $names = [System.Collections.Generic.HashSet[string]]::new([string[]]@($src.Keys + $tgt.Keys))
    foreach ($k in $names) {
        $s = $src[$k]; $t = $tgt[$k]
        $display = if ($s) { $s.Name } else { $t.Name }
        if (Test-IgnoredOpcPart $display) { continue }
        if (-not $t) { $diff.Add("missing $k"); continue }
        if (-not $s) { $diff.Add("added $k"); continue }
        if ($s.Crc -eq $t.Crc -and $s.USize -eq $t.USize) { continue }
        if ($k -eq '[content_types].xml') {
            $sNames = @($src.Values | ForEach-Object { $_.Name }); $tNames = @($tgt.Values | ForEach-Object { $_.Name })
            if ((Get-EffectiveContentTypes (Get-ZipEntryBytes $Source $s) $sNames) -eq (Get-EffectiveContentTypes (Get-ZipEntryBytes $Target $t) $tNames)) { continue }
        }
        elseif ($k.EndsWith('.rels')) {
            # Parts SharePoint edits: compare with its own entries removed.
            if ((Get-NormalizedOpcPart $s.Name (Get-ZipEntryBytes $Source $s)) -eq (Get-NormalizedOpcPart $t.Name (Get-ZipEntryBytes $Target $t))) { continue }
        }
        $diff.Add("changed $k")
    }
    if ($diff.Count -eq 0) { return @{ Status = 'equivalent'; Detail = 'all document parts identical by zip index (only SharePoint property parts differ)' } }
    return @{ Status = 'different'; Detail = (($diff | Select-Object -First 5) -join '; ') }
}

# --- HTML ------------------------------------------------------------------
$script:MsoXmlns = ' xmlns:mso="urn:schemas-microsoft-com:office:office" xmlns:msdt="uuid:C2F41010-65B3-11d1-A29F-00AA00C14882"'
function Remove-SharePointHtmlProperties([byte[]]$Bytes) {
    # Latin-1 maps every byte to one char and back, so this edits bytes
    # without any encoding round-trip. SharePoint wraps its block in line
    # breaks, which go with it.
    $enc = [System.Text.Encoding]::Latin1
    $s = $enc.GetString($Bytes)
    $s = $s.Replace($script:MsoXmlns, '')
    $s = [regex]::Replace($s, '(\r?\n)?<!--\[if gte mso 9\]><xml>\s*<mso:CustomDocumentProperties>.*?</mso:CustomDocumentProperties>\s*</xml><!\[endif\]-->(\r?\n)?', '', 'Singleline')
    return , $enc.GetBytes($s)
}

# A result that only says this attempt failed (download error, throttling,
# missing link) must never be cached: the next Verify has to try the file
# again rather than replay the failure.
# Only a proven "equivalent" is reused from the cache. A "different" or
# "could not be checked" result is always checked again: they are few and
# cheap, and a later fix to the checker (a SharePoint quirk it now knows,
# a format it can now read) must be able to clear them without anyone
# deleting the cache by hand.
function Test-TransientContentResult($Result) {
    if (-not $Result) { return $false }
    return $Result.Status -ne 'equivalent'
}

# --- Entry point -----------------------------------------------------------
function Test-RewrittenFileContent {
    param(
        [Parameter(Mandatory)][byte[]]$SourceBytes,
        [Parameter(Mandatory)][byte[]]$TargetBytes,
        [Parameter(Mandatory)][string]$Extension
    )
    $ext = $Extension.ToLowerInvariant()
    if ((Get-Sha256Hex $SourceBytes) -eq (Get-Sha256Hex $TargetBytes)) {
        return @{ Status = 'equivalent'; Detail = 'byte-identical' }
    }
    try {
        # A password-protected Office document is not a zip: Office wraps the
        # encrypted package in an OLE container (EncryptionInfo +
        # EncryptedPackage streams), and SharePoint adds its property streams
        # to that container like it does for .doc/.xls. Compare it stream by
        # stream - the encrypted content itself must be identical.
        $isCfb = { param($b) $b.Length -ge 8 -and $b[0] -eq 0xD0 -and $b[1] -eq 0xCF -and $b[2] -eq 0x11 -and $b[3] -eq 0xE0 }
        if ($script:ZipExtensions -contains $ext -and ((& $isCfb $SourceBytes) -or (& $isCfb $TargetBytes))) {
            if (-not ((& $isCfb $SourceBytes) -and (& $isCfb $TargetBytes))) {
                return @{ Status = 'different'; Detail = 'one copy is password-protected and the other is not' }
            }
            $filter = { param($m) $o = @{}; foreach ($k in $m.Keys) {
                    if ($k -like 'MsoDataStore*' -or $k -eq "$([char]5)DocumentSummaryInformation" -or $k -eq "$([char]5)SummaryInformation") { continue }
                    $o[$k] = $m[$k] }; $o }
            $srcStreams = & $filter ([SpmtCfbReader]::ReadStreams($SourceBytes))
            $tgtStreams = & $filter ([SpmtCfbReader]::ReadStreams($TargetBytes))
            $diff = Compare-PartMaps $srcStreams $tgtStreams
            if ($diff.Count -eq 0) { return @{ Status = 'equivalent'; Detail = 'password-protected document: encrypted content identical (only SharePoint property streams differ)' } }
            return @{ Status = 'different'; Detail = (($diff | Select-Object -First 5) -join '; ') }
        }
        if ($script:ZipExtensions -contains $ext) {
            $diff = Compare-PartMaps (Get-OpcPartMap $SourceBytes) (Get-OpcPartMap $TargetBytes)
            if ($diff.Count -eq 0) { return @{ Status = 'equivalent'; Detail = 'all document parts identical (only SharePoint property parts differ)' } }
            return @{ Status = 'different'; Detail = (($diff | Select-Object -First 5) -join '; ') }
        }
        if ($script:HtmlExtensions -contains $ext -or $script:HtmlLenientExtensions -contains $ext) {
            $a = Get-Sha256Hex (Remove-SharePointHtmlProperties $SourceBytes)
            $b = Get-Sha256Hex (Remove-SharePointHtmlProperties $TargetBytes)
            if ($a -eq $b) { return @{ Status = 'equivalent'; Detail = 'identical apart from the property block SharePoint inserts' } }
            if ($script:HtmlLenientExtensions -contains $ext) { return @{ Status = 'unchecked'; Detail = 'differs; SharePoint changes to this format are not measured yet' } }
            return @{ Status = 'different'; Detail = 'page content differs from the original' }
        }
        if ($script:OleStrictExtensions -contains $ext -or $script:OleLenientExtensions -contains $ext) {
            $filter = { param($m) $o = @{}; foreach ($k in $m.Keys) {
                    if ($k -like 'MsoDataStore*' -or $k -eq "$([char]5)DocumentSummaryInformation" -or $k -eq "$([char]5)SummaryInformation") { continue }
                    $o[$k] = $m[$k] }; $o }
            $src = & $filter ([SpmtCfbReader]::ReadStreams($SourceBytes))
            $tgt = & $filter ([SpmtCfbReader]::ReadStreams($TargetBytes))
            $diff = Compare-PartMaps $src $tgt
            if ($diff.Count -eq 0) { return @{ Status = 'equivalent'; Detail = 'all content streams identical (only SharePoint property streams differ)' } }
            if ($script:OleLenientExtensions -contains $ext) { return @{ Status = 'unchecked'; Detail = "differs ($(($diff | Select-Object -First 3) -join '; ')); SharePoint changes to this format are not measured yet" } }
            return @{ Status = 'different'; Detail = (($diff | Select-Object -First 5) -join '; ') }
        }
        return @{ Status = 'unchecked'; Detail = "no content check for $ext files" }
    } catch {
        # A file that cannot be parsed is reported, never passed.
        return @{ Status = 'unchecked'; Detail = "could not be compared: $($_.Exception.Message)" }
    }
}

# Checks each rewritten file against its original (in parallel) and returns
# one @{ Rel; Key; Status; Detail } per item. Items: @{ Rel; Ext; Size;
# SourceUrl | SourceFile; TargetUrl; Key }. Download URLs are Graph's
# pre-authenticated @microsoft.graph.downloadUrl, so lanes need no PnP
# connection. Modern Office files are compared by zip index (a few KB);
# everything else is downloaded in full.
#
# Two continuous parallel streams, smallest files first: every file except
# big non-zip ones (over 50 MB, downloaded in full) runs -ThrottleLimit at a
# time with no batch barrier - a slow file only holds up its own lane - then
# the big ones run -BigLanes at a time to keep memory in check.
#
# Results are written into -Cache as they arrive and -CachePath is rewritten
# every -SaveEvery new results (at most every 10 s), so stopping or
# restarting the server mid-check keeps the work already done. Failed
# attempts (throttling, download errors) are never cached.
#
# Download links (valid about an hour) are refreshed with -RefreshLinks once
# they are older than -LinkMaxMinutes; files not started yet pick the fresh
# link up. OnProgress gets (done, bytesDone, lastRel, throttleWaitSec,
# currentRel, currentBytes, throttle) - "current" is the biggest file still in
# progress; throttle = @{ Active; WaitLeft; Count; Recovered }.
function Invoke-RewrittenContentCheck {
    param(
        [Parameter(Mandatory)][object[]]$Items,
        # 16 lanes: SharePoint served ~170 range requests/s on hilasti before any 429;
        # 32 hit the throttle (and its pacing) sooner without finishing faster overall.
        [int]$ThrottleLimit = 16,
        [int]$BigLanes = 4,
        [long]$MaxBytes = 300MB,
        [scriptblock]$OnProgress,
        # Returns @{ Source = @{ rel = url }; Target = @{ rel = url } }.
        [scriptblock]$RefreshLinks,
        [int]$LinkMaxMinutes = 40,
        [hashtable]$Cache,
        [string]$CachePath,
        [int]$SaveEvery = 25
    )
    $modulePath = $PSCommandPath
    # Shared by all lanes: throttle pause, and counters for the caller's log.
    $gate = [hashtable]::Synchronized(@{ Until = [DateTime]::UtcNow; Throttles = 0; LastWait = 0; Interval = 0; NextAt = [DateTime]::MinValue; LastThrottleAt = [DateTime]::MinValue; LastEaseAt = [DateTime]::MinValue })
    # Files currently being checked (rel -> size), for "checking now".
    $inFlight = [hashtable]::Synchronized(@{})
    # Same decorated User-Agent as the copy engine (UserAgent.psm1);
    # Microsoft throttles undecorated traffic harder.
    $ua = if (Get-Command Get-MigrationUserAgent -ErrorAction SilentlyContinue) { Get-MigrationUserAgent } else { $null }
    $results = [System.Collections.Generic.List[object]]::new()
    $state = @{ Done = 0; Bytes = [long]0; ThrottlesReported = 0; NoteAt = [datetime]::MinValue; LinksAt = (Get-Date); Unsaved = 0; SavedAt = (Get-Date); Throttled = $false; CalmSince = $null; CalmCount = 0 }
    $all = @($Items | Sort-Object { [long]$_.Size })
    $bigFile = 50MB
    $isBig = { param($x) [long]$x.Size -gt $bigFile -and $script:ZipExtensions -notcontains "$($x.Ext)".ToLowerInvariant() }
    $small = @($all | Where-Object { -not (& $isBig $_) })
    $big = @($all | Where-Object { & $isBig $_ })

    $saveCache = {
        if (-not $CachePath -or -not $Cache) { return }
        try { $Cache | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $CachePath -Encoding utf8 } catch { }
        $state.Unsaved = 0; $state.SavedAt = Get-Date
    }
    $refreshIfStale = {
        if (-not $RefreshLinks -or ((Get-Date) - $state.LinksAt).TotalMinutes -lt $LinkMaxMinutes) { return }
        try {
            $fresh = & $RefreshLinks
            # Items are shared by reference with the lanes, so files not
            # started yet download through the new links.
            foreach ($it in $all) {
                if (-not $it.SourceFile -and $fresh.Source -and $fresh.Source.ContainsKey($it.Rel)) { $it.SourceUrl = $fresh.Source[$it.Rel] }
                if ($fresh.Target -and $fresh.Target.ContainsKey($it.Rel)) { $it.TargetUrl = $fresh.Target[$it.Rel] }
            }
        } catch { }
        $state.LinksAt = Get-Date
    }
    $consume = {
        $r = $_
        $results.Add(@{ Rel = $r.Rel; Key = $r.Key; Status = $r.Status; Detail = $r.Detail })
        $state.Done++
        $state.Bytes += [long]$r.Size
        if ($Cache -and $r.Key -and -not (Test-TransientContentResult $r)) {
            $Cache[$r.Key] = @{ Status = $r.Status; Detail = $r.Detail }
            $state.Unsaved++
            if ($state.Unsaved -ge $SaveEvery -and ((Get-Date) - $state.SavedAt).TotalSeconds -ge 10) { & $saveCache }
        }
        $throttleNote = $null
        # At most one throttle note every 30 s, so the log isn't flooded.
        if ($gate.Throttles -gt $state.ThrottlesReported -and ((Get-Date) - $state.NoteAt).TotalSeconds -ge 30) {
            $throttleNote = $gate.LastWait; $state.ThrottlesReported = $gate.Throttles; $state.NoteAt = Get-Date
        }
        # Throttle status for the progress line: throttled right now (any
        # lane waiting), and a one-off "recovered" once 20 s pass with no
        # new 429 after a throttled spell.
        $nowUtc = [DateTime]::UtcNow
        $active = $gate.Until -gt $nowUtc
        $recovered = $null
        if ($active) { $state.Throttled = $true; $state.CalmSince = $null }
        elseif ($state.Throttled) {
            if (-not $state.CalmSince -or $gate.Throttles -ne $state.CalmCount) { $state.CalmSince = Get-Date; $state.CalmCount = $gate.Throttles }
            elseif (((Get-Date) - $state.CalmSince).TotalSeconds -ge 20) { $recovered = $gate.Throttles; $state.Throttled = $false; $state.CalmSince = $null }
        }
        $throttle = @{
            Active = $active
            WaitLeft = if ($active) { [int][Math]::Ceiling(($gate.Until - $nowUtc).TotalSeconds) } else { 0 }
            Count = $gate.Throttles
            Recovered = $recovered
        }
        & $refreshIfStale
        $current = $null; [long]$currentSize = 0
        [System.Threading.Monitor]::Enter($inFlight.SyncRoot)
        try { foreach ($e in $inFlight.GetEnumerator()) { if ([long]$e.Value -ge $currentSize) { $current = $e.Key; $currentSize = [long]$e.Value } } }
        finally { [System.Threading.Monitor]::Exit($inFlight.SyncRoot) }
        if ($OnProgress) { & $OnProgress $state.Done $state.Bytes $r.Rel $throttleNote $current $currentSize $throttle }
    }

    foreach ($set in @(@{ Items = $small; Lanes = $ThrottleLimit }, @{ Items = $big; Lanes = [Math]::Max(1, [Math]::Min($BigLanes, $ThrottleLimit)) })) {
        if ($set.Items.Count -eq 0) { continue }
        & $refreshIfStale
        $set.Items | ForEach-Object -ThrottleLimit $set.Lanes -Parallel {
            $it = $_
            $flight = $using:inFlight
            $flight[$it.Rel] = [long]$it.Size
            Import-Module $using:modulePath
            try {
                if (-not $it.TargetUrl -or (-not $it.SourceUrl -and -not $it.SourceFile)) {
                    return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = 'unchecked'; Detail = 'no download link available' }
                }
                $http = [System.Net.Http.HttpClient]::new()
                $http.Timeout = [TimeSpan]::FromMinutes(10)
                if ($using:ua) { $null = $http.DefaultRequestHeaders.TryAddWithoutValidation('User-Agent', $using:ua) }
                $gate = $using:gate
                try {
                    # Modern Office files: compare the zip indexes (a few KB
                    # each) instead of downloading both files.
                    try {
                        $z = Test-RemoteZipContent -Extension $it.Ext `
                            -Source @{ Http = $http; Url = $it.SourceUrl; File = $it.SourceFile; Gate = $gate } `
                            -Target @{ Http = $http; Url = $it.TargetUrl; Gate = $gate }
                        if ($z) { return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = $z.Status; Detail = $z.Detail; Fast = $true } }
                    } catch { }
                    if ($it.Size -gt $using:MaxBytes) {
                        return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = 'unchecked'; Detail = 'too large for a content check' }
                    }
                    # Plain assignments: an if-expression enumerates a byte[] into an object[]
                    # (millions of boxed bytes - minutes of CPU and GBs of memory on a big file).
                    if ($it.SourceFile) { $src = [System.IO.File]::ReadAllBytes($it.SourceFile) } else { $src = Get-HttpBytes $http $it.SourceUrl $gate }
                    $tgt = Get-HttpBytes $http $it.TargetUrl $gate
                } finally { $http.Dispose() }
                $r = Test-RewrittenFileContent -SourceBytes $src -TargetBytes $tgt -Extension $it.Ext
                return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = $r.Status; Detail = $r.Detail }
            } catch {
                return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = 'unchecked'; Detail = "download failed: $($_.Exception.Message)" }
            } finally {
                $flight.Remove($it.Rel)
            }
        } | ForEach-Object $consume
    }
    if ($state.Unsaved -gt 0) { & $saveCache }
    return $results
}

Export-ModuleMember -Function Test-RewrittenFileContent, Test-RemoteZipContent, Get-HttpBytes, Invoke-RewrittenContentCheck, Test-TransientContentResult
