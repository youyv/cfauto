@echo off
setlocal
cd /d "%~dp0"
REM Build only; does not delete prior evidence, install dependencies or deploy.
node build.js
if errorlevel 1 goto :fail
echo [OK] Build complete. Run check.bat for local validation.
pause
exit /b 0
:fail
echo [FAIL] Build failed. Do not publish stale output.
pause
exit /b 1