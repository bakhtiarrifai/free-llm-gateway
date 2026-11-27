@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"
echo Menghapus shortcut Free LLM Gateway dari Desktop dan Startup ...
node scripts\windows.js uninstall
echo.
echo Selesai. Folder ini boleh dihapus. API key kamu tetap ada di
echo %USERPROFILE%\.config\free-llm-gateway\.env (hapus manual kalau tidak dipakai lagi).
pause
