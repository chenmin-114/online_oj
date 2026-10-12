@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not exist "pairing.json" (
  echo [错误] 安装包缺少一次性配对文件，请从机创OJ管理后台重新下载。
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File ""%~dp0Install-JCOJJudgeNode.ps1""'"
if errorlevel 1 (
  echo [错误] 未获得Windows管理员权限，安装已取消。
  pause
  exit /b 1
)
exit /b 0
