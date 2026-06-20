@echo off
chcp 65001 >nul
REM ===========================================
REM 安装依赖 — 下载 Node.js 依赖 (esbuild + wrangler)
REM 仅在首次使用或 package.json 变更后需要运行
REM ===========================================
cd /d %~dp0
call npm install wrangler --save-dev --ignore-scripts
pause
