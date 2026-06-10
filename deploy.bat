@echo off
set PATH=C:\Program Files\nodejs;D:\Reasonix;%PATH%
pushd "D:\下载\worker-refactor"
node "D:\下载\worker-refactor\node_modules\wrangler\wrangler-dist\cli.js" deploy
popd
