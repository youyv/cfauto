@echo off
REM Build: frontend bundle + esbuild -> dist/worker.js
cd /d %~dp0
del /f distworker.js 2>nul
node build.js
pause
