@echo off
rem One-time setup for a brand-new install: creates the app registration,
rem certificate and .env. Skip this if you copied .env and setup\certs from a
rem PC where the tool already runs. Sign in with YOUR OWN tenant's admin.
setlocal
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh^) is required. Install it with:   winget install Microsoft.PowerShell
  pause
  exit /b 1
)

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\New-AppRegistration.ps1" %*
pause
