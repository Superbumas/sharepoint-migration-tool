#Requires -Version 7.0

# Filesystem (DFS/UNC/local path) as a migration SOURCE - the mirror image of
# BlobTarget.psm1, which added a second migration TARGET. A DFS namespace is
# just an SMB path to the engine, so everything here works on any UNC or local
# directory the engine process account can read. The engine stays copy-only:
# nothing in this module ever writes to the source.
#
# Two things make a filesystem source genuinely different from a SharePoint
# source, and both live here so Invoke-MigrationJob.ps1 only branches, never
# re-implements:
#
# 1. Name legality. NTFS tolerates names SharePoint Online rejects (leading/
#    trailing spaces, trailing dots, " * : < > ? / \ | , control chars,
#    reserved device names, "_vti_"). Every name is passed through
#    ConvertTo-SharePointSafeName during enumeration and the SANITIZED name is
#    used for the target path and every map key, while the ORIGINAL name keeps
#    addressing the source file - so verification keys match on both sides by
#    construction. Renames are surfaced per-file (Renamed flag), never silent.
#
# 2. Verification. There is no Graph on the source side, but QuickXorHash is a
#    documented, deterministic algorithm - so the engine computes it LOCALLY
#    over each source file and compares against the hash SharePoint computed
#    server-side for the uploaded copy. Same "matching hashes prove identical
#    bytes" guarantee as SharePoint-to-SharePoint verification.

# --- QuickXorHash ------------------------------------------------------------
# Microsoft's reference implementation of the OneDrive/SharePoint content hash
# (https://learn.microsoft.com/onedrive/developer/code-snippets/quickxorhash),
# verbatim apart from the namespace. Property-tested against an independent
# naive bit-by-bit implementation (see engine/tests/Test-QuickXorHash.ps1):
# each input byte i is XORed into a circular 160-bit vector at bit position
# (i*11) mod 160, then the 8-byte little-endian stream length is XORed into
# the digest's last 8 bytes.
$script:QuickXorHashSource = @'
using System;

namespace MigrationEngine
{
    public sealed class QuickXorHash : System.Security.Cryptography.HashAlgorithm
    {
        private const int BitsInLastCell = 32;
        private const byte Shift = 11;
        private const byte WidthInBits = 160;

        private ulong[] _data;
        private long _lengthSoFar;
        private int _shiftSoFar;

        public QuickXorHash()
        {
            this.Initialize();
        }

        protected override void HashCore(byte[] array, int ibStart, int cbSize)
        {
            unchecked
            {
                int currentShift = this._shiftSoFar;

                // The bitvector where we'll start xoring
                int vectorArrayIndex = currentShift / 64;

                // The position within the bit vector at which we begin xoring
                int vectorOffset = currentShift % 64;
                int iterations = Math.Min(cbSize, (int)WidthInBits);

                for (int i = 0; i < iterations; i++)
                {
                    bool isLastCell = vectorArrayIndex == this._data.Length - 1;
                    int bitsInVectorCell = isLastCell ? BitsInLastCell : 64;

                    // There's at least 2 bitvectors before we reach the end of the array
                    if (vectorOffset <= bitsInVectorCell - 8)
                    {
                        for (int j = ibStart + i; j < cbSize + ibStart; j += WidthInBits)
                        {
                            this._data[vectorArrayIndex] ^= (ulong)array[j] << vectorOffset;
                        }
                    }
                    else
                    {
                        int index1 = vectorArrayIndex;
                        int index2 = isLastCell ? 0 : (vectorArrayIndex + 1);
                        byte low = (byte)(bitsInVectorCell - vectorOffset);

                        for (int j = ibStart + i; j < cbSize + ibStart; j += WidthInBits)
                        {
                            this._data[index1] ^= (ulong)array[j] << vectorOffset;
                            this._data[index2] ^= (ulong)array[j] >> low;
                        }
                    }

                    vectorOffset += Shift;
                    while (vectorOffset >= bitsInVectorCell)
                    {
                        vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
                        vectorOffset -= bitsInVectorCell;
                    }
                }

                // Update the starting position in a circular shift pattern
                this._shiftSoFar = (this._shiftSoFar + Shift * (cbSize % WidthInBits)) % WidthInBits;
            }

            this._lengthSoFar += cbSize;
        }

        protected override byte[] HashFinal()
        {
            // Create a byte array big enough to hold all our data
            byte[] rgb = new byte[(WidthInBits - 1) / 8 + 1];

            // Block copy all our bitvectors to this byte array
            for (int i = 0; i < this._data.Length - 1; i++)
            {
                Buffer.BlockCopy(BitConverter.GetBytes(this._data[i]), 0, rgb, i * 8, 8);
            }

            Buffer.BlockCopy(
                BitConverter.GetBytes(this._data[this._data.Length - 1]), 0,
                rgb, (this._data.Length - 1) * 8, rgb.Length - (this._data.Length - 1) * 8);

            // XOR the file length with the least significant bits (little-endian)
            var lengthBytes = BitConverter.GetBytes(this._lengthSoFar);
            for (int i = 0; i < lengthBytes.Length; i++)
            {
                rgb[(WidthInBits / 8) - lengthBytes.Length + i] ^= lengthBytes[i];
            }

            return rgb;
        }

        public sealed override void Initialize()
        {
            this._data = new ulong[(WidthInBits - 1) / 64 + 1];
            this._lengthSoFar = 0;
            this._shiftSoFar = 0;
        }

        public override int HashSize
        {
            get { return WidthInBits; }
        }
    }

    // Read-only stream wrapper that counts consumed bytes - wrapped around the
    // FileStream handed to Add-PnPFile so the engine can report live per-file
    // upload progress. PnP reads the stream on its own (possibly async I/O)
    // threads while the engine's MAIN thread polls BytesConsumed from its
    // drain loop, so the counter uses Interlocked; nothing else crosses
    // threads (the main thread never touches the inner stream). Seeks reset
    // the counter to the new position, so PnP rewinding between chunk
    // attempts moves the reported progress backwards instead of past 100%.
    public sealed class ProgressReadStream : System.IO.Stream
    {
        private readonly System.IO.Stream _inner;
        private long _consumed;

        public ProgressReadStream(System.IO.Stream inner) { _inner = inner; }

        public long BytesConsumed { get { return System.Threading.Interlocked.Read(ref _consumed); } }

        public override bool CanRead { get { return _inner.CanRead; } }
        public override bool CanSeek { get { return _inner.CanSeek; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return _inner.Length; } }

        public override long Position
        {
            get { return _inner.Position; }
            set { _inner.Position = value; System.Threading.Interlocked.Exchange(ref _consumed, value); }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            int n = _inner.Read(buffer, offset, count);
            System.Threading.Interlocked.Add(ref _consumed, n);
            return n;
        }

        public override async System.Threading.Tasks.Task<int> ReadAsync(byte[] buffer, int offset, int count, System.Threading.CancellationToken cancellationToken)
        {
            int n = await _inner.ReadAsync(buffer, offset, count, cancellationToken).ConfigureAwait(false);
            System.Threading.Interlocked.Add(ref _consumed, n);
            return n;
        }

        public override long Seek(long offset, System.IO.SeekOrigin origin)
        {
            long p = _inner.Seek(offset, origin);
            System.Threading.Interlocked.Exchange(ref _consumed, p);
            return p;
        }

        public override void SetLength(long value) { throw new System.NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new System.NotSupportedException(); }
        public override void Flush() { _inner.Flush(); }

        protected override void Dispose(bool disposing)
        {
            if (disposing) { _inner.Dispose(); }
            base.Dispose(disposing);
        }
    }
}
'@

# Add-Type is process-wide and throws on re-definition; ThreadJob lanes share
# the process with the main thread, so guard with a type-exists check instead
# of relying on import order.
if (-not ('MigrationEngine.QuickXorHash' -as [type]) -or -not ('MigrationEngine.ProgressReadStream' -as [type])) {
    Add-Type -TypeDefinition $script:QuickXorHashSource -Language CSharp
}

# Base64 QuickXorHash of a local/UNC file - directly comparable to Graph's
# driveItem file.hashes.quickXorHash for the uploaded copy.
#
# Reads in large explicit chunks rather than [System.IO.File]::OpenRead +
# ComputeHash. That default path uses a 4 KB FileStream buffer and
# ComputeHash then pulls the stream in ~4 KB reads - which over SMB (the
# common case here: verifying a file-share source) is thousands of tiny,
# latency-bound network round-trips per file, and it dominates verification
# time on a DFS/UNC source (observed live: a 4 GB user-documents tree taking
# ~20+ minutes to hash, decelerating on the larger tail files). Reading 4 MB
# at a time turns each of those into one round-trip that moves 4 MB, so the
# read is bandwidth-bound instead. Identical hash output - only the I/O
# batching changes. FileShare ReadWrite|Delete so a file a user has open on
# the live share still hashes instead of failing to a size-only check.
$script:HashReadChunkBytes = 4MB
function Get-FileQuickXorHash {
    param([Parameter(Mandatory)][string]$Path)
    $algo = [MigrationEngine.QuickXorHash]::new()
    try {
        $share = [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete
        $stream = [System.IO.FileStream]::new(
            $Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, $share,
            81920, [System.IO.FileOptions]::SequentialScan)
        try {
            $buffer = [byte[]]::new($script:HashReadChunkBytes)
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $null = $algo.TransformBlock($buffer, 0, $read, $null, 0)
            }
            $null = $algo.TransformFinalBlock([byte[]]::new(0), 0, 0)
            return [Convert]::ToBase64String($algo.Hash)
        } finally {
            $stream.Dispose()
        }
    } finally {
        $algo.Dispose()
    }
}

# --- SharePoint name legality ------------------------------------------------

$script:ReservedDeviceNames = @('CON', 'PRN', 'AUX', 'NUL') +
    @(0..9 | ForEach-Object { "COM$_"; "LPT$_" })

# Makes one path segment (file or folder name) legal for SharePoint Online.
# Deterministic - the same input always sanitizes identically, which is what
# keeps resume/skip checks and verification keys stable across runs. Returns
# the name unchanged when it's already legal (the overwhelmingly common case).
function ConvertTo-SharePointSafeName {
    param([Parameter(Mandatory)][string]$Name)
    $safe = ($Name.ToCharArray() | ForEach-Object {
        if ([int]$_ -lt 32 -or $_ -in '"', '*', ':', '<', '>', '?', '/', '\', '|') { '_' } else { $_ }
    }) -join ''
    # Leading/trailing whitespace and trailing dots are rejected by SPO even
    # though NTFS (via some tools) can create them.
    $safe = $safe.Trim().TrimEnd('.')
    # '_vti_' is reserved anywhere in a SharePoint URL (FrontPage legacy).
    $safe = $safe -replace '_vti_', '_vti-'
    $base = [System.IO.Path]::GetFileNameWithoutExtension($safe)
    if ($base -and $script:ReservedDeviceNames -contains $base.ToUpperInvariant()) { $safe = "_$safe" }
    if (-not $safe) { $safe = '_' }
    return $safe
}

# OS/application droppings that have no business being migrated into a
# document library: Explorer thumbnail caches, folder-view settings, and
# Office's transient ownership-lock files (~$Report.docx). Skipped during
# enumeration (counted, logged, never item events - they don't belong in the
# job's totals any more than SharePoint's own hidden files would).
function Test-IsJunkFile {
    param([Parameter(Mandatory)][string]$Name)
    return ($Name -in 'Thumbs.db', 'desktop.ini') -or ($Name -like '~$*')
}

# --- Enumeration ---------------------------------------------------------------
# Breadth-first walk of a directory tree, returning the same shape as
# SharePointTree.psm1's Get-PnPFolderTree (Files with SourceFolder / Name /
# Size / Modified / RelativeFromRoot, Folders as root-relative paths) so the
# engine's tree cache, folder pre-creation and checkpointing work unchanged.
#
# Filesystem-specific additions per file:
#   TargetName - the sanitized (SharePoint-legal) leaf name; equals Name for
#                almost every file. Target paths and ALL map keys use it.
#   Created    - filesystem creation time (UTC), stamped onto the copy.
#   Renamed    - true when sanitization changed the name (surfaced as a log).
# RelativeFromRoot and Folders are built from SANITIZED segments ('/'-joined,
# matching Graph map keys); SourceFolder keeps the ORIGINAL absolute path so
# the source file always remains addressable as SourceFolder + Name.
#
# Sibling entries are processed in ordinal name order and sanitize collisions
# get a deterministic " (2)" suffix - stable across runs, so resume's
# skip-by-key logic never sees the same file under two different keys.
#
# Unreadable directories and reparse points (junctions/symlinks - a cycle
# hazard on file servers; actual DFS folder links are resolved transparently
# by SMB and never surface as reparse points to this client) are recorded in
# .Errors / .SkippedReparsePoints rather than failing the walk; the caller
# logs them so a partial enumeration is always visible, never silent.
function Get-FileSystemTree {
    param(
        [Parameter(Mandatory)][string]$RootPath,
        # Invoked after each directory with (foldersFound, filesFound,
        # foldersPending) - same progress contract as Get-PnPFolderTree.
        [scriptblock]$OnProgress
    )

    $root = [System.IO.DirectoryInfo]::new($RootPath.TrimEnd('\', '/'))
    if (-not $root.Exists) { throw "Source path '$RootPath' does not exist or is not accessible to the engine process account." }

    $queue = [System.Collections.Generic.Queue[object]]::new()
    $queue.Enqueue(@{ Dir = $root; Rel = '' })

    $files = [System.Collections.Generic.List[object]]::new()
    $folders = [System.Collections.Generic.List[string]]::new()
    $errors = [System.Collections.Generic.List[object]]::new()
    $reparseSkipped = [System.Collections.Generic.List[string]]::new()
    $junkSkipped = 0
    $renamedCount = 0

    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()

        $entries = $null
        try {
            $entries = @($current.Dir.EnumerateFileSystemInfos() | Sort-Object -Property Name)
        } catch {
            $errors.Add([pscustomobject]@{ Path = $current.Dir.FullName; Message = $_.Exception.Message })
            continue
        }

        # Sanitized names must stay unique within their parent (files and
        # folders share one namespace in SharePoint just like on disk).
        $usedNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

        foreach ($entry in $entries) {
            $isDir = $entry -is [System.IO.DirectoryInfo]

            if ($isDir -and ($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                $reparseSkipped.Add($entry.FullName)
                continue
            }
            if (-not $isDir -and (Test-IsJunkFile -Name $entry.Name)) {
                $junkSkipped++
                continue
            }

            $safeName = ConvertTo-SharePointSafeName -Name $entry.Name
            if (-not $usedNames.Add($safeName)) {
                # Deterministic de-collision (ordinal sibling order is stable):
                # "report_.txt" -> "report_ (2).txt", folders get " (2)" appended.
                $stem = if ($isDir) { $safeName } else { [System.IO.Path]::GetFileNameWithoutExtension($safeName) }
                $ext = if ($isDir) { '' } else { [System.IO.Path]::GetExtension($safeName) }
                $n = 2
                while (-not $usedNames.Add("$stem ($n)$ext")) { $n++ }
                $safeName = "$stem ($n)$ext"
            }
            $renamed = $safeName -ne $entry.Name
            if ($renamed) { $renamedCount++ }

            if ($isDir) {
                $relChild = if ($current.Rel) { "$($current.Rel)/$safeName" } else { $safeName }
                $folders.Add($relChild)
                $queue.Enqueue(@{ Dir = $entry; Rel = $relChild })
            } else {
                $files.Add([pscustomobject]@{
                    SourceFolder     = $current.Dir.FullName
                    Name             = $entry.Name
                    TargetName       = $safeName
                    Size             = [long]$entry.Length
                    Modified         = $entry.LastWriteTimeUtc
                    Created          = $entry.CreationTimeUtc
                    RelativeFromRoot = $current.Rel
                    Renamed          = $renamed
                })
            }
        }

        if ($OnProgress) { & $OnProgress $folders.Count $files.Count $queue.Count }
    }

    return [pscustomobject]@{
        Files                = $files
        Folders              = $folders
        Errors               = $errors
        SkippedReparsePoints = $reparseSkipped
        JunkSkipped          = $junkSkipped
        RenamedCount         = $renamedCount
    }
}

# Returns @{ '<sanitized path relative to root>' = @{ Size; Hash; Created;
# Modified; FullPath } } for every file under the root - the filesystem
# equivalent of Verification.psm1's Get-GraphFileMap, keyed identically to the
# target-side Graph map by construction (same sanitize + same '/'-joined
# relative paths), so Compare-MigratedFileMaps can diff them directly.
# -IncludeHash computes the local QuickXorHash of every file (reads every
# byte - this is what makes verification honest, and it's LAN reads).
function Get-FileSystemFileMap {
    param(
        [Parameter(Mandatory)][string]$RootPath,
        [switch]$IncludeHash,
        # Invoked with the cumulative file count - hashing a big tree can run
        # for many minutes and must not look hung.
        [scriptblock]$OnProgress
    )
    $tree = Get-FileSystemTree -RootPath $RootPath
    $map = @{}
    foreach ($f in $tree.Files) {
        $rel = if ($f.RelativeFromRoot) { "$($f.RelativeFromRoot)/$($f.TargetName)" } else { $f.TargetName }
        $fullPath = Join-Path $f.SourceFolder $f.Name
        $entry = @{
            Size     = [long]$f.Size
            Hash     = $null
            Created  = $f.Created
            Modified = $f.Modified
            FullPath = $fullPath
        }
        if ($IncludeHash) {
            # A file that vanished or became unreadable mid-verification
            # degrades that one file to a size-only check (Hash stays $null,
            # which Compare-MigratedFileMaps counts as hashUnavailable) rather
            # than killing the whole verification pass.
            try { $entry.Hash = Get-FileQuickXorHash -Path $fullPath } catch {}
        }
        $map[$rel] = $entry
        if ($OnProgress) { & $OnProgress $map.Count }
    }
    return $map
}

Export-ModuleMember -Function Get-FileQuickXorHash, ConvertTo-SharePointSafeName, Test-IsJunkFile, Get-FileSystemTree, Get-FileSystemFileMap
