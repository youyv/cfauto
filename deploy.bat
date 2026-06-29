@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=

REM Deploy Worker to Cloudflare
REM Prereq: run build.bat first
REM Auto-uses wrangler.local.toml if exists, otherwise wrangler.toml
cd /d %~dp0
if exist wrangler.local.toml (
    node node_modules\wrangler\wrangler-dist\cli.js deploy -c wrangler.local.toml
) else (
    node node_modules\wrangler\wrangler-dist\cli.js deploy
)
pause
