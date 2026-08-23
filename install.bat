@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=
REM === DNS fix: Node.js DNS (127.0.0.1 broken) -> auto fallback ===
set NODE_OPTIONS=--require %~dp0dns-fix.js

REM Install ALL devDependencies (esbuild / typescript / vitest / wrangler / workers-types)
REM Previously only wrangler was installed, which made build.bat fail on a fresh clone.
cd /d %~dp0
call npm install --ignore-scripts
if %errorlevel% neq 0 (
    echo.
    echo [FAIL] npm install failed. Try: npm install --ignore-scripts --legacy-peer-deps
    pause
    exit /b 1
)
echo.
echo [OK] Dependencies installed. Next: run build.bat
pause
