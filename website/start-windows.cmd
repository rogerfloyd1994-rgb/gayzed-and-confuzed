@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js LTS, then try again.
  pause
  exit /b 1
)
node build.cjs
if errorlevel 1 (
  echo Motion Organizer's website could not be built.
  pause
  exit /b 1
)
node server.cjs --open
if errorlevel 1 (
  echo Motion Organizer's website preview stopped with an error.
  pause
  exit /b 1
)
