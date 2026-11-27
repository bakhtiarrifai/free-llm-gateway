@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"
node scripts\windows.js running
if not errorlevel 1 goto :open
echo Gateway belum berjalan. Klik dua kali "Free LLM Gateway - Start" di Desktop dulu.
pause
exit /b 1
:open
node scripts\windows.js dashboard
