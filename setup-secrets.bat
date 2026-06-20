@echo off
chcp 65001 >nul
REM ===========================================
REM 设置密钥 (仅首次运行一次, 之后永不被覆盖)
REM ===========================================
cd /d %~dp0
echo.
echo === 设置面板登录密码 ===
node node_modules\wrangler\wrangler-dist\cli.js secret put ACCESS_CODE
echo.
echo === 设置 GitHub Token (可直接回车跳过) ===
node node_modules\wrangler\wrangler-dist\cli.js secret put GITHUB_TOKEN
echo.
echo 密钥已加密存储到 CF, 之后 deploy 永不覆盖
pause
