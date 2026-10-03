@echo off
chcp 65001 >nul
title 机创 OJ Claude 批改助手
cd /d "%~dp0\.."
node scripts\claude-grading-server.js
if errorlevel 1 (
  echo.
  echo 启动失败，请确认已经安装 Node.js 和 Claude Code，并已登录 Claude。
  pause
)
