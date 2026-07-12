@echo off
REM Install deps (first time only)
cd /d %~dp0
call npm install wrangler --save-dev --ignore-scripts
pause
