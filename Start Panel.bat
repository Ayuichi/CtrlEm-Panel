@echo off
cd /d "%~dp0"
title CtrlEm Panel
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo Close this window to stop the panel.
node server.js
if errorlevel 1 (
  echo.
  echo The panel stopped because of an error.
  pause
)
