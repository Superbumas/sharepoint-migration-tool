#Requires -Version 7.0
# Launcher for the portable Windows package: checks prerequisites, starts the
# bundled Node server, and opens the browser once it is listening.
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$appRoot = (Resolve-Path "$PSScriptRoot/..").Path
$nodeExe = Join-Path $appRoot 'node/node.exe'
$envFile = Join-Path $appRoot '.env'

function Stop-WithMessage($text) {
    Write-Host "`n$text" -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path $nodeExe)) {
    Stop-WithMessage "The bundled Node runtime is missing ($nodeExe). Re-extract the package zip."
}

if (-not (Test-Path $envFile)) {
    Stop-WithMessage (@(
        'No .env configuration found in this folder.',
        '',
        '  Moving from another PC: copy .env and the whole setup\certs folder from there',
        '  (and data\ if you want your projects and job history) into:',
        "    $appRoot",
        '',
        '  Brand-new install: run First-Time-Setup.cmd (sign in with your OWN tenant admin).'
    ) -join "`n")
}

if (-not (Get-Module -ListAvailable -Name PnP.PowerShell)) {
    Write-Host 'PnP.PowerShell module not found - installing it for the current user...' -ForegroundColor Yellow
    Install-Module PnP.PowerShell -Scope CurrentUser -Force -AllowClobber
}

# Read PORT from .env the same way dotenv would (last assignment wins).
$port = 3000
foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
}

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "Something is already listening on port $port - assuming the tool is already running."
    if (-not $NoBrowser) { Start-Process "http://localhost:$port" }
    exit 0
}

$env:NODE_ENV = 'production'
$url = "http://localhost:$port"

if (-not $NoBrowser) {
    # Open the browser as soon as the server answers, without blocking the
    # server's console output in this window.
    Start-Job -ArgumentList $url -ScriptBlock {
        param($url)
        for ($i = 0; $i -lt 60; $i++) {
            try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $url; return } catch { Start-Sleep -Seconds 1 }
        }
    } | Out-Null
}

Write-Host "Starting SharePoint Migration Tool on $url (close this window to stop it)" -ForegroundColor Cyan
Push-Location $appRoot
try {
    & $nodeExe (Join-Path $appRoot 'server/index.js')
    exit $LASTEXITCODE
} finally { Pop-Location }
