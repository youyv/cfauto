@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=
REM === DNS fix: Node.js DNS (127.0.0.1 broken) -> auto fallback ===
set NODE_OPTIONS=--require %~dp0dns-fix.js

REM Full local check chain, same order as CI (.github/workflows/ci.yml):
REM   build -> typecheck -> verify -> tests
REM build must run first: it generates src/frontend-bundle.ts which tsc needs.
cd /d %~dp0

echo.
echo === [1/4] Build ===
node build.js
if %errorlevel% neq 0 goto :fail

echo.
echo === [2/4] Typecheck (tsc --noEmit) ===
call npx tsc --noEmit
if %errorlevel% neq 0 goto :fail

echo.
echo === [3/4] Verify (structure / routes / CSP / anti-patterns) ===
node verify.js
if %errorlevel% neq 0 goto :fail

echo.
echo === [4/4] Tests (vitest run) ===
call npx vitest run
if %errorlevel% neq 0 goto :fail

echo.
echo [OK] All checks passed. Next: deploy.bat
pause
exit /b 0

:fail
echo.
echo [FAIL] Check chain failed above. Fix the errors before deploying.
pause
exit /b 1
