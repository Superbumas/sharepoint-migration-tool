#Requires -Version 7.0
<#
.SYNOPSIS
  Builds a portable Windows package of the tool: a zip that carries its own
  Node.js runtime and prebuilt node_modules, so the target PC needs no Node
  install and can never hit a better-sqlite3 NODE_MODULE_VERSION mismatch.

.DESCRIPTION
  Must run on Windows x64 - better-sqlite3's native binary is fetched for the
  bundled node.exe's ABI, so it has to be the same OS/arch as the target.

  The zip deliberately contains NO .env, setup/certs/ or data/ - those are
  per-installation secrets and state. Extracting a newer zip over an existing
  install therefore upgrades the code and keeps the configuration.

.EXAMPLE
  pwsh -File packaging/windows/Build-WindowsPackage.ps1
  pwsh -File packaging/windows/Build-WindowsPackage.ps1 -NodeVersion 24.11.1
#>
param(
    # Exact Node version to bundle. Empty = latest release of -NodeMajor.
    [string]$NodeVersion = '',
    # LTS line to bundle when -NodeVersion is not given. Keep this on an LTS
    # major that better-sqlite3 publishes prebuilt binaries for.
    [int]$NodeMajor = 24,
    [string]$OutputDir = "$PSScriptRoot/../../dist-package"
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)
$workDir = Join-Path $OutputDir 'work'
$stageDir = Join-Path $workDir 'SharePointMigrationTool'

function Write-Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }

if (-not $IsWindows) { throw 'Build-WindowsPackage.ps1 must run on Windows x64 (the native SQLite module is built for the bundled node.exe).' }

# ---------------------------------------------------------------------------
# 1. Resolve and download the Node runtime
# ---------------------------------------------------------------------------
Write-Step 'Resolving Node.js runtime'
if (-not $NodeVersion) {
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $NodeVersion = ($index | Where-Object { $_.version -like "v$NodeMajor.*" } | Select-Object -First 1).version.TrimStart('v')
    if (-not $NodeVersion) { throw "No Node.js v$NodeMajor release found on nodejs.org." }
}
Write-Host "Bundling Node.js v$NodeVersion"

if (Test-Path $workDir) { Remove-Item $workDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

$nodeZipName = "node-v$NodeVersion-win-x64"
$nodeZip = Join-Path $workDir "$nodeZipName.zip"
Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$nodeZipName.zip" -OutFile $nodeZip
Expand-Archive $nodeZip -DestinationPath $workDir
Move-Item (Join-Path $workDir $nodeZipName) (Join-Path $stageDir 'node')
Remove-Item $nodeZip

$nodeExe = Join-Path $stageDir 'node/node.exe'
$npmCli = Join-Path $stageDir 'node/node_modules/npm/bin/npm-cli.js'
# Every npm call below runs under the BUNDLED node.exe, so prebuild-install
# downloads the better-sqlite3 binary matching exactly the runtime we ship.
function Invoke-BundledNpm {
    param([string]$WorkingDir, [string[]]$NpmArgs)
    Push-Location $WorkingDir
    try {
        & $nodeExe $npmCli @NpmArgs
        if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------------------
# 2. Build the web UI from the repo checkout
# ---------------------------------------------------------------------------
Write-Step 'Building the web UI'
Invoke-BundledNpm $repoRoot @('ci')
Invoke-BundledNpm $repoRoot @('run', 'build')

# ---------------------------------------------------------------------------
# 3. Stage the app in the same layout as the repo (server/config.js resolves
#    .env, engine/, data/ and setup/certs/ relative to the repo root)
# ---------------------------------------------------------------------------
Write-Step 'Staging application files'
$robocopyExclude = @('/XD', 'node_modules', '/XF', '*.log')
foreach ($dir in @('server', 'engine')) {
    robocopy (Join-Path $repoRoot $dir) (Join-Path $stageDir $dir) /E /NFL /NDL /NJH /NJS @robocopyExclude | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy of $dir failed ($LASTEXITCODE)" }
}
New-Item -ItemType Directory -Path (Join-Path $stageDir 'setup') -Force | Out-Null
Copy-Item (Join-Path $repoRoot 'setup/New-AppRegistration.ps1') (Join-Path $stageDir 'setup')
New-Item -ItemType Directory -Path (Join-Path $stageDir 'web') -Force | Out-Null
Copy-Item (Join-Path $repoRoot 'web/dist') (Join-Path $stageDir 'web/dist') -Recurse
Copy-Item (Join-Path $repoRoot 'web/package.json') (Join-Path $stageDir 'web')
foreach ($file in @('package.json', 'package-lock.json', '.env.example', 'README.md', 'SETUP.md', 'COMPLIANCE.md')) {
    Copy-Item (Join-Path $repoRoot $file) $stageDir
}
Copy-Item (Join-Path $PSScriptRoot 'launcher/*') $stageDir -Recurse

# ---------------------------------------------------------------------------
# 4. Production dependencies for the server workspace only
# ---------------------------------------------------------------------------
Write-Step 'Installing server runtime dependencies'
Invoke-BundledNpm $stageDir @('ci', '--omit=dev', '--workspace', 'server', '--include-workspace-root=false', '--no-audit', '--no-fund')

# Smoke test: the native module must load under the bundled runtime.
& $nodeExe -e "require('$($stageDir.Replace('\','/'))/node_modules/better-sqlite3')(':memory:').close(); console.log('better-sqlite3 OK')"
if ($LASTEXITCODE -ne 0) { throw 'better-sqlite3 failed to load under the bundled Node runtime.' }

# ---------------------------------------------------------------------------
# 5. Zip it
# ---------------------------------------------------------------------------
Write-Step 'Creating zip'
$appVersion = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
$commit = (git -C $repoRoot rev-parse --short HEAD 2>$null)
$suffix = if ($commit) { "$appVersion-$commit" } else { $appVersion }
$zipPath = Join-Path $OutputDir "SharePointMigrationTool-win-x64-$suffix.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path $stageDir -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item $workDir -Recurse -Force

Write-Host "`nPackage ready: $zipPath" -ForegroundColor Green
