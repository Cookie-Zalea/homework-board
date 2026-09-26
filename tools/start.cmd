@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 作业发布系统

where node >nul 2>nul
if %errorlevel%==0 (
  node "tools\serve.mjs"
  goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo 未找到 Node.js，改用 Python 启动本地服务。
  start "" http://localhost:8777/
  python -m http.server 8777
  goto :end
)

echo.
echo 需要 Node.js 或 Python 才能启动本地服务。
echo 本项目使用原生 ES Module，必须通过 http 打开，不能直接双击 index.html。
echo.
pause

:end
