# Real content check for files SharePoint rewrites on ingestion.
#
# Office documents, legacy Office binaries and saved web pages never come out
# of SharePoint byte-identical, so the size/QuickXorHash comparison cannot
# vouch for them. Instead of waving them through as "expected", both copies
# are downloaded and compared with only the parts SharePoint is known to
# touch left out. Measured on a live tenant (2026-11-11):
#
#   OOXML zip (.docx/.xlsx/.pptx/.xlsb/...): SharePoint ADDS customXml/* and
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
    return $n.StartsWith('customxml/') -or $n -eq 'docprops/custom.xml' -or $n -eq 'docprops/core.xml' -or $n -eq 'docprops/app.xml'
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
function Get-OpcPartMap([byte[]]$Bytes) {
    $map = @{}
    $ms = [System.IO.MemoryStream]::new($Bytes)
    $zip = [System.IO.Compression.ZipArchive]::new($ms, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
        foreach ($e in $zip.Entries) {
            if ($e.FullName.EndsWith('/')) { continue }
            $name = $e.FullName.Replace('\', '/')
            if (Test-IgnoredOpcPart $name) { continue }
            $s = $e.Open(); $buf = [System.IO.MemoryStream]::new()
            try { $s.CopyTo($buf) } finally { $s.Dispose() }
            $map[$name.ToLowerInvariant()] = Get-NormalizedOpcPart $name $buf.ToArray()
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
function Invoke-RewrittenContentCheck {
    param(
        [Parameter(Mandatory)][object[]]$Items,
        [int]$ThrottleLimit = 8,
        [long]$MaxBytes = 300MB,
        [scriptblock]$OnProgress
    )
    $modulePath = $PSCommandPath
    $done = 0
    $results = [System.Collections.Generic.List[object]]::new()
    $Items | ForEach-Object -ThrottleLimit $ThrottleLimit -Parallel {
        $it = $_
        Import-Module $using:modulePath
        try {
            if ($it.Size -gt $using:MaxBytes) {
                return @{ Rel = $it.Rel; Key = $it.Key; Status = 'unchecked'; Detail = 'too large for a content check' }
            }
            if (-not $it.TargetUrl -or (-not $it.SourceUrl -and -not $it.SourceFile)) {
                return @{ Rel = $it.Rel; Key = $it.Key; Status = 'unchecked'; Detail = 'no download link available' }
            }
            $http = [System.Net.Http.HttpClient]::new()
            $http.Timeout = [TimeSpan]::FromMinutes(10)
            try {
                $src = if ($it.SourceFile) { [System.IO.File]::ReadAllBytes($it.SourceFile) } else { $http.GetByteArrayAsync($it.SourceUrl).GetAwaiter().GetResult() }
                $tgt = $http.GetByteArrayAsync($it.TargetUrl).GetAwaiter().GetResult()
            } finally { $http.Dispose() }
            $r = Test-RewrittenFileContent -SourceBytes $src -TargetBytes $tgt -Extension $it.Ext
            return @{ Rel = $it.Rel; Key = $it.Key; Status = $r.Status; Detail = $r.Detail }
        } catch {
            return @{ Rel = $it.Rel; Key = $it.Key; Status = 'unchecked'; Detail = "download failed: $($_.Exception.Message)" }
        }
    } | ForEach-Object {
        $results.Add($_)
        $done++
        if ($OnProgress) { & $OnProgress $done }
    }
    return $results
}

Export-ModuleMember -Function Test-RewrittenFileContent, Invoke-RewrittenContentCheck
