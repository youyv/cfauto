@echo off
chcp 65001 >nul
REM ===========================================
REM 构建脚本 — 拼接前端资源 + esbuild 打包
REM 输出: dist/worker.js (可直接部署到 Cloudflare)
REM 前置: 需先运行 install.bat 安装依赖
REM ===========================================
cd /d %~dp0
node build.js
pause
