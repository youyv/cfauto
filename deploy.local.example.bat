@echo off
REM ============================================================
REM  Deploy credential for wrangler (template - DO NOT COMMIT)
REM ============================================================
REM
REM Usage:
REM   1. Create an API token:
REM      https://dash.cloudflare.com/profile/api-tokens -> Create Token
REM      Permissions needed for this project:
REM        Account  | Workers Scripts      | Edit
REM        Account  | Workers KV Storage   | Edit
REM        Account  | Workers Routes       | Edit
REM        Zone     | Zone                 | Read   <-- 仅当路由用 zone_name 时才需要；
REM                                                    改用 zone_id 可省掉这条权限
REM        Account  | Account Settings     | Read
REM   2. Copy this file to deploy.local.bat (gitignored)
REM   3. Replace the placeholder below with your token
REM
REM deploy.bat / setup-secrets.bat call deploy.local.bat automatically.

set CLOUDFLARE_API_TOKEN=paste-your-token-here
