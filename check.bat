@echo off
setlocal
cd /d "%~dp0"
REM Same single pipeline as package.json and CI. No dependency reinstall/deploy.
node scripts\check.cjs %*
if errorlevel 1 goto :fail
echo [OK] Local checks passed. This is NOT deployment approval.
pause
exit /b 0
:fail
echo [FAIL] Fix the failed gate before continuing.
pause
exit /b 1