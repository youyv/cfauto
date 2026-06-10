@echo off
cd /d "D:\下载\worker-refactor"

echo === Init Git ===
git init
git remote remove origin 2>nul
git remote add origin https://github.com/youyv/cfauto.git

echo === Stage files ===
git add .

echo === Commit ===
git commit -m "Worker Manager V10.10.0 - TypeScript modular refactor"

echo === Push ===
git branch -M main
git push -u origin main

echo === Done ===
pause
