@echo off
cd /d "%~dp0"
if exist "%~dp0release\Movies R Sap-win32-x64\Movies R Sap.exe" (
  start "" "%~dp0release\Movies R Sap-win32-x64\Movies R Sap.exe"
  exit /b 0
)
echo The desktop build has not been packaged yet.
echo From this folder run npm ci, then npm run package:win.
pause
