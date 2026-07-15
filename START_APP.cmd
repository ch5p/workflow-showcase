@echo off
setlocal
cd /d "%~dp0"

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo Electron is not installed in this app folder.
  echo Run: npm.cmd ci
  pause
  exit /b 1
)

start "" "%ELECTRON_EXE%" .
exit /b 0
