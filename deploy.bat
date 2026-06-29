@echo off
REM === Unset proxy (Cloudflare direct connect) ===
set HTTP_PROXY=
set HTTPS_PROXY=
REM === DNS fix: Node.js DNS (127.0.0.1 broken) -> use gateway DNS ===
set NODE_OPTIONS=--require %~dp0dns-fix.js

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
