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
function Send-HttpWithRetry([System.Net.Http.HttpClient]$Http, [string]$Url, $Range, $Gate, [int]$MaxAttempts = 10) {
    for ($attempt = 1; ; $attempt++) {
        if ($Gate) {
            $pause = ($Gate.Until - [DateTime]::UtcNow).TotalMilliseconds
            if ($pause -gt 0) { Start-Sleep -Milliseconds ([int]$pause + (Get-Random -Maximum 500)) }
        }
        $req = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Url)
        if ($Range) { $req.Headers.Range = $Range }
        $resp = $Http.SendAsync($req).GetAwaiter().GetResult()
        $code = [int]$resp.StatusCode
        if (($code -ne 429 -and $code -ne 503 -and $code -ne 504) -or $attempt -ge $MaxAttempts) { return $resp }
        # The longer of our own doubling backoff and SharePoint's Retry-After.
        # Under sustained throttling SharePoint keeps answering "Retry-After:
        # 1", and taking that literally gave up after ~10 s (seen on hilasti:
        # 96 of 3,000 files left unchecked).
        $wait = [Math]::Min(60, [Math]::Pow(2, $attempt))
        $ra = $resp.Headers.RetryAfter
        if ($ra -and $ra.Delta) { $wait = [Math]::Min(120, [Math]::Max($wait, $ra.Delta.Value.TotalSeconds)) }
        elseif ($ra -and $ra.Date) { $wait = [Math]::Min(120, [Math]::Max($wait, ($ra.Date.Value - [DateTimeOffset]::UtcNow).TotalSeconds)) }
        $resp.Dispose(); $req.Dispose()
        if ($Gate) {
            $until = [DateTime]::UtcNow.AddSeconds($wait)
            [System.Threading.Monitor]::Enter($Gate.SyncRoot)
            try {
                if ($until -gt $Gate.Until) { $Gate.Until = $until }
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
        return $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
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
            return $buf
        } finally { $fs.Dispose() }
    }
    $resp = Send-HttpWithRetry $Ref.Http $Ref.Url ([System.Net.Http.Headers.RangeHeaderValue]::new($Offset, $Offset + $Count - 1)) $Ref.Gate
    try {
        if ([int]$resp.StatusCode -ne 206) { throw "range request returned $([int]$resp.StatusCode)" }
        $b = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        if ($b.Length -ne $Count) { throw 'range request returned the wrong length' }
        return $b
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
    $cd = if ($cdOff -ge $tailStart -and ($cdOff + $cdSize) -le $tail.Total) {
        [byte[]]$b[($cdOff - $tailStart)..($cdOff - $tailStart + $cdSize - 1)]
    } else { Read-ZipRange $Ref $cdOff $cdSize }
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
    if ($Entry.Method -eq 0) { return $data }
    if ($Entry.Method -ne 8) { throw "unsupported compression in $($Entry.Name)" }
    $in = [System.IO.MemoryStream]::new($data); $out = [System.IO.MemoryStream]::new()
    $z = [System.IO.Compression.DeflateStream]::new($in, [System.IO.Compression.CompressionMode]::Decompress)
    try { $z.CopyTo($out) } finally { $z.Dispose(); $in.Dispose() }
    return $out.ToArray()
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
    return $enc.GetBytes($s)
}

# A result that only says this attempt failed (download error, throttling,
# missing link) must never be cached: the next Verify has to try the file
# again rather than replay the failure.
function Test-TransientContentResult($Result) {
    if (-not $Result -or $Result.Status -ne 'unchecked') { return $false }
    $d = "$($Result.Detail)"
    return $d -like 'download failed*' -or $d -like 'no download link*'
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

# Downloads both copies of each rewritten file (in parallel) and runs
# Test-RewrittenFileContent on them. Items: @{ Rel; Ext; Size;
# SourceUrl | SourceFile; TargetUrl; Key }. Download URLs are Graph's
# pre-authenticated @microsoft.graph.downloadUrl, so lanes need no PnP
# connection. Returns one @{ Rel; Key; Status; Detail } per item.
#
# Smallest files go first, so most of a library is done quickly and a few
# big decks don't hold up the count. Work runs in batches: big files (over
# 50 MB) only two at a time to keep memory down, and Graph's download links
# (valid about an hour) are refreshed with -RefreshLinks before a batch once
# they are older than -LinkMaxMinutes. OnProgress gets (done, bytesDone, rel).
function Invoke-RewrittenContentCheck {
    param(
        [Parameter(Mandatory)][object[]]$Items,
        [int]$ThrottleLimit = 8,
        [long]$MaxBytes = 300MB,
        [scriptblock]$OnProgress,
        # Returns @{ Source = @{ rel = url }; Target = @{ rel = url } }.
        [scriptblock]$RefreshLinks,
        [int]$LinkMaxMinutes = 40
    )
    $modulePath = $PSCommandPath
    # Shared by all lanes: throttle pause, and counters for the caller's log.
    $gate = [hashtable]::Synchronized(@{ Until = [DateTime]::UtcNow; Throttles = 0; LastWait = 0 })
    # Same decorated User-Agent as the copy engine (UserAgent.psm1);
    # Microsoft throttles undecorated traffic harder.
    $ua = if (Get-Command Get-MigrationUserAgent -ErrorAction SilentlyContinue) { Get-MigrationUserAgent } else { $null }
    $throttlesReported = 0
    $throttleNoteAt = [datetime]::MinValue
    $done = 0
    [long]$bytesDone = 0
    $results = [System.Collections.Generic.List[object]]::new()
    $ordered = @($Items | Sort-Object { [long]$_.Size })
    $linksAt = Get-Date
    $bigFile = 50MB
    $i = 0
    # Zip-based Office files are checked from their index, so only other
    # big files (downloaded in full) count as big.
    $heavy = { param($x) [long]$x.Size -gt $bigFile -and $script:ZipExtensions -notcontains "$($x.Ext)".ToLowerInvariant() }
    while ($i -lt $ordered.Count) {
        $isBig = & $heavy $ordered[$i]
        $batchSize = if ($isBig) { 4 } else { [Math]::Max(1, $ThrottleLimit * 4) }
        $batch = [System.Collections.Generic.List[object]]::new()
        while ($i -lt $ordered.Count -and $batch.Count -lt $batchSize -and ((& $heavy $ordered[$i]) -eq $isBig)) {
            $batch.Add($ordered[$i]); $i++
        }
        if ($RefreshLinks -and ((Get-Date) - $linksAt).TotalMinutes -ge $LinkMaxMinutes) {
            try {
                $fresh = & $RefreshLinks
                foreach ($it in @($ordered[($i - $batch.Count)..($ordered.Count - 1)])) {
                    if (-not $it.SourceFile -and $fresh.Source -and $fresh.Source.ContainsKey($it.Rel)) { $it.SourceUrl = $fresh.Source[$it.Rel] }
                    if ($fresh.Target -and $fresh.Target.ContainsKey($it.Rel)) { $it.TargetUrl = $fresh.Target[$it.Rel] }
                }
                $linksAt = Get-Date
            } catch { }
        }
        $lanes = if ($isBig) { [Math]::Min(2, $ThrottleLimit) } else { $ThrottleLimit }
        $batch.ToArray() | ForEach-Object -ThrottleLimit $lanes -Parallel {
            $it = $_
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
                    $src = if ($it.SourceFile) { [System.IO.File]::ReadAllBytes($it.SourceFile) } else { Get-HttpBytes $http $it.SourceUrl $gate }
                    $tgt = Get-HttpBytes $http $it.TargetUrl $gate
                } finally { $http.Dispose() }
                $r = Test-RewrittenFileContent -SourceBytes $src -TargetBytes $tgt -Extension $it.Ext
                return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = $r.Status; Detail = $r.Detail }
            } catch {
                return @{ Rel = $it.Rel; Key = $it.Key; Size = $it.Size; Status = 'unchecked'; Detail = "download failed: $($_.Exception.Message)" }
            }
        } | ForEach-Object {
            $results.Add(@{ Rel = $_.Rel; Key = $_.Key; Status = $_.Status; Detail = $_.Detail })
            $done++
            $bytesDone += [long]$_.Size
            $throttleNote = $null
            # At most one throttle note every 30 s, so the log isn't flooded.
            if ($gate.Throttles -gt $throttlesReported -and ((Get-Date) - $throttleNoteAt).TotalSeconds -ge 30) {
                $throttleNote = $gate.LastWait; $throttlesReported = $gate.Throttles; $throttleNoteAt = Get-Date
            }
            if ($OnProgress) { & $OnProgress $done $bytesDone $_.Rel $throttleNote }
        }
    }
    return $results
}

Export-ModuleMember -Function Test-RewrittenFileContent, Test-RemoteZipContent, Get-HttpBytes, Invoke-RewrittenContentCheck, Test-TransientContentResult
