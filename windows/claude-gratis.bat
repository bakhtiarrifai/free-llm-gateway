@echo off
setlocal
title Claude Code Gratis
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"
set "PATH=%USERPROFILE%\.local\bin;%PATH%"

node scripts\windows.js running
if not errorlevel 1 goto :claude
echo Menyalakan Free LLM Gateway di jendela lain ...
start "Free LLM Gateway" /min "%~dp0start-gateway.bat"
timeout /t 8 >nul

:claude
where claude >nul 2>nul
if not errorlevel 1 goto :run
echo.
echo  Claude Code belum terpasang di komputer ini.
choice /c YN /n /m "  Pasang sekarang dengan installer resmi dari claude.ai? [Y/N] "
if errorlevel 2 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"
where claude >nul 2>nul
if not errorlevel 1 goto :run
echo  Claude Code belum bisa dijalankan. Tutup jendela ini lalu coba lagi.
pause
exit /b 1

:run
cd /d "%USERPROFILE%"
node "%~dp0..\bin\fgw.js" claude
pause
