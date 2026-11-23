@echo off
REM dsh-thinking-guard 一键安装（Windows 双击即可）
REM
REM 做的事：把本目录 link 进 DSH 的 desktop profile，并登记到 bundle 列表。
REM 不碰会话数据，不重启 DSH——装完会把下一步该做的两件事打出来。
setlocal
set "SCRIPT_DIR=%~dp0"
where bash >nul 2>nul
if errorlevel 1 (
  echo 没找到 bash。
  echo 装了 Git for Windows 的话，用这个路径运行本脚本：
  echo   "C:\Program Files\Git\bin\bash.exe" "%SCRIPT_DIR%install.sh"
  pause
  exit /b 1
)
bash "%SCRIPT_DIR%install.sh"
echo.
pause
