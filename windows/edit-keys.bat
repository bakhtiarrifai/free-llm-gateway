@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"
node scripts\windows.js edit
