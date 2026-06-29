@echo off
REM === Proxy (modify port if different) ===
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890
set NO_PROXY=localhost,127.0.0.1

REM Setup secrets (first time only)
REM Sets ACCESS_CODE and GITHUB_TOKEN via wrangler secret
cd /d %~dp0
set WRANGLER_CONFIG=
if exist wrangler.local.toml set WRANGLER_CONFIG=-c wrangler.local.toml
echo.
echo === Set panel password (ACCESS_CODE) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put ACCESS_CODE %WRANGLER_CONFIG%
echo.
echo === Set GitHub Token (press Enter to skip) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put GITHUB_TOKEN %WRANGLER_CONFIG%
echo.
echo Secrets stored in CF. Deploy will never touch them.
pause
