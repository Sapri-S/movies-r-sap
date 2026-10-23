@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo The browser companion needs Node.js 24.11 or later.
  pause
  exit /b 1
)
echo Starting Movies R Sap browser companion...
echo Open http://127.0.0.1:4173 in your browser.
echo Keep this window open while watching. Press Ctrl+C to stop.
node apps/server/index.mjs
if errorlevel 1 pause
