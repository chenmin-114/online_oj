@echo off
setlocal
chcp 65001 >nul
title 机创 OJ Claude 批改助手
cd /d "%~dp0\.."

where node >nul 2>nul
if errorlevel 1 goto no_node

node scripts\claude-grading-server.js
set "helper_exit=%errorlevel%"
if "%helper_exit%"=="0" exit /b 0

echo.
echo 启动失败。请保留本窗口中的错误信息，以便排查。
echo 请确认已经安装 Node.js 和 Claude Code，并已登录 Claude。
pause
exit /b %helper_exit%

:no_node
echo 未找到 Node.js。请先安装 Node.js，再重新运行本脚本。
pause
exit /b 1
