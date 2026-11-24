@echo off
setlocal EnableExtensions
REM ---------------------------------------------------------------------
REM  dsh-thinking-guard -- Windows launcher
REM
REM  The real work is done by install.ps1 (Windows PowerShell).
REM  No Git, no Node, no pnpm needed.
REM
REM  This file is deliberately PURE ASCII with CRLF line endings:
REM  cmd.exe misreads UTF-8 text and LF-only files inside .cmd batches,
REM  which used to surface as "'p' is not recognized" style errors.
REM ---------------------------------------------------------------------

chcp 65001 >nul 2>nul
set "PS1=%~dp0install.ps1"

if not exist "%PS1%" (
  echo.
  echo  [dsh-thinking-guard] install.ps1 is missing next to install.cmd.
  echo  Unzip the whole archive again and keep these files together.
  echo.
  pause
  exit /b 1
)

echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo  [dsh-thinking-guard] stopped with exit code %RC% - scroll up for the reason.
pause
exit /b %RC%
