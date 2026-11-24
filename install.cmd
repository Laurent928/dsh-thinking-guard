@echo off
setlocal EnableExtensions

REM -- switch this console to UTF-8 so the Chinese output coming back from
REM    install.sh renders correctly instead of turning into mojibake
chcp 65001 >nul 2>nul

REM ---------------------------------------------------------------------
REM  dsh-thinking-guard -- Windows launcher for install.sh
REM
REM  If you are looking for Chinese instructions, read README.md.
REM
REM  This file is deliberately PURE ASCII with CRLF line endings.
REM  cmd.exe misparses UTF-8 Chinese text inside .cmd files, and it breaks
REM  on LF-only line endings -- that combination is what used to make this
REM  launcher print garbage like "'p' is not recognized" and exit.
REM ---------------------------------------------------------------------

set "SH_WIN=%~dp0install.sh"
set "SH_UNIX=%SH_WIN:\=/%"
set "BASH="

REM -- 1) bash already on PATH?  (skip WSL's C:\Windows\System32\bash.exe)
for /f "delims=" %%i in ('where bash 2^>nul') do call :take "%%i"
if defined BASH goto :run

REM -- 2) Git for Windows does NOT have to be on PATH; check usual places
if exist "%ProgramFiles%\Git\bin\bash.exe" set "BASH=%ProgramFiles%\Git\bin\bash.exe"
if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "BASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "BASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if defined BASH goto :run

REM -- 3) git.exe on PATH -> ...\Git\cmd\git.exe -> ...\Git\bin\bash.exe
for /f "delims=" %%i in ('where git 2^>nul') do call :fromgit "%%i"
if defined BASH goto :run

echo.
echo  [dsh-thinking-guard] Git Bash was not found.
echo.
echo  This installer hands over to install.sh, which needs Git Bash.
echo  Install "Git for Windows" first (default options are fine):
echo.
echo      https://git-scm.com/download/win
echo.
echo  Then close this window, open a new one, and double-click install.cmd again.
echo.
pause
exit /b 1

:take
if defined BASH goto :eof
echo %~1 | find /i "system32" >nul
if errorlevel 1 set "BASH=%~1"
goto :eof

:fromgit
if defined BASH goto :eof
set "GCMD=%~dp1"
if exist "%GCMD%..\bin\bash.exe" set "BASH=%GCMD%..\bin\bash.exe"
goto :eof

:run
echo.
echo  [dsh-thinking-guard] bash   : %BASH%
echo  [dsh-thinking-guard] script : %SH_UNIX%
echo.
"%BASH%" "%SH_UNIX%"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo  [dsh-thinking-guard] install.sh exited with code %RC%.
pause
exit /b %RC%
