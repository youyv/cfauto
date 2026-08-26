@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=
REM === DNS fix: Node.js DNS (127.0.0.1 broken) -> auto fallback ===
set NODE_OPTIONS=--require %~dp0dns-fix.js

REM Install dependencies with pnpm.
REM The repo ships pnpm-lock.yaml (not package-lock.json), so pnpm is the only
REM package manager that gives a reproducible install here - `npm install` would
REM ignore that lockfile and resolve fresh versions.
REM --ignore-scripts skips esbuild / workerd / sharp postinstall downloads; the
REM platform binaries come from optional deps and work without those scripts.
cd /d %~dp0

where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] pnpm not found, enabling it via corepack...
    call corepack enable pnpm
    if %errorlevel% neq 0 (
        echo.
        echo [FAIL] Could not enable pnpm. Install it manually:
        echo        npm install -g pnpm
        pause
        exit /b 1
    )
)

call pnpm install --frozen-lockfile --ignore-scripts
if %errorlevel% neq 0 (
    echo.
    echo [WARN] Frozen install failed - lockfile may be out of sync with package.json.
    echo        Retrying without --frozen-lockfile ^(this may update pnpm-lock.yaml^)...
    call pnpm install --ignore-scripts
    if %errorlevel% neq 0 (
        echo.
        echo [FAIL] pnpm install failed.
        pause
        exit /b 1
    )
    echo.
    echo [NOTE] pnpm-lock.yaml may have changed - commit it if so.
)

echo.
echo [OK] Dependencies installed. Next: build.bat ^(or check.bat for the full check chain^)
pause
