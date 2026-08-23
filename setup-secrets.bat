@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=
REM === DNS fix: Node.js DNS (127.0.0.1 broken) -> auto fallback ===
set NODE_OPTIONS=--require %~dp0dns-fix.js

REM Setup secrets (first time only)
REM Sets ACCESS_CODE / GITHUB_TOKEN / ENCRYPTION_SECRET via wrangler secret
cd /d %~dp0
set WRANGLER_CONFIG=
if exist wrangler.local.toml set WRANGLER_CONFIG=-c wrangler.local.toml

echo.
echo === [1/3] Set panel password (ACCESS_CODE) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put ACCESS_CODE %WRANGLER_CONFIG%

echo.
echo === [2/3] Set GitHub Token (press Enter to skip) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put GITHUB_TOKEN %WRANGLER_CONFIG%

echo.
echo === [3/3] Set ENCRYPTION_SECRET (optional but recommended) ===
echo    Purpose: a dedicated key for encrypting stored API keys.
echo    With it set, changing ACCESS_CODE will NOT break already-encrypted data.
echo    IMPORTANT: the variable name must be exactly ENCRYPTION_SECRET (singular).
echo    WARNING: if accounts were already saved WITHOUT this secret, setting it now
echo             makes old ciphertext undecryptable - you must re-enter each API key.
echo    Press Enter to skip if you are unsure.
node node_modules\wrangler\wrangler-dist\cli.js secret put ENCRYPTION_SECRET %WRANGLER_CONFIG%

echo.
echo Secrets stored in CF. Deploy will never touch them.
pause
