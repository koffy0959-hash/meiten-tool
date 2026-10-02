@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js is not installed. https://nodejs.org/ja
  start "" "https://nodejs.org/ja"
  pause
  exit /b 1
)
set OPEN_BROWSER=1
node server.js
echo.
pause
