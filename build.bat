@echo off
REM Build: frontend bundle + esbuild -> dist/worker.js
cd /d %~dp0
node build.js
pause
