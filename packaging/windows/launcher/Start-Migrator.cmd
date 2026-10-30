@echo off
rem Starts the SharePoint Migration Tool from this portable folder.
rem The engine needs PowerShell 7 (pwsh) - everything else is bundled.
setlocal
cd /d "%~dp0"

where pwsh >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh^) is required but was not found.
  echo.
  echo Install it with:   winget install Microsoft.PowerShell
  echo then close this window and run Start-Migrator again.
  echo.
  pause
  exit /b 1
)

pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\Start-Migrator.ps1" %*
if errorlevel 1 pause
