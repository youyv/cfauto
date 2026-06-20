@echo off
REM Setup secrets (first time only)
REM Sets ACCESS_CODE and GITHUB_TOKEN via wrangler secret
cd /d %~dp0
echo.
echo === Set panel password (ACCESS_CODE) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put ACCESS_CODE
echo.
echo === Set GitHub Token (press Enter to skip) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put GITHUB_TOKEN
echo.
echo Secrets stored in CF. Deploy will never touch them.
pause
