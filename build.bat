@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=
REM === DNS fix: build.js downloads SweetAlert2, needs working DNS ===
set NODE_OPTIONS=--require %~dp0dns-fix.js

REM Build: frontend bundle + esbuild -> dist/worker.js
cd /d %~dp0
del /f dist\worker.js 2>nul
node build.js
pause
