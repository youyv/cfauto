@echo off
chcp 65001 >nul
REM ===========================================
REM 部署脚本 — 将 dist/worker.js 推送到 Cloudflare
REM 前置: 先运行 build.bat
REM
REM 自动检测 wrangler.local.toml (个人配置)
REM 不存在则使用 wrangler.toml (模板)
REM ===========================================
cd /d %~dp0
if exist wrangler.local.toml (
    echo 使用个人配置 wrangler.local.toml ...
    node node_modules\wrangler\wrangler-dist\cli.js deploy -c wrangler.local.toml
) else (
    echo 使用模板配置 wrangler.toml ...
    node node_modules\wrangler\wrangler-dist\cli.js deploy
)
pause
