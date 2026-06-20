@echo off
chcp 65001 >nul
REM ===========================================
REM 部署脚本 — 将 dist/worker.js 推送到 Cloudflare
REM
REM 前置: 先运行 build.bat
REM
REM 首次使用需设置密钥 (仅一次, 之后永不被覆盖):
REM   npx wrangler secret put ACCESS_CODE
REM   npx wrangler secret put GITHUB_TOKEN
REM ===========================================
cd /d %~dp0
node node_modules\wrangler\wrangler-dist\cli.js deploy
pause
