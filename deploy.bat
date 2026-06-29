@echo off
REM === Proxy (modify port if different) ===
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890
set NO_PROXY=localhost,127.0.0.1

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
