@echo off
setlocal
title Free LLM Gateway
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"

node scripts\windows.js running
if errorlevel 1 goto :checkkeys
echo Free LLM Gateway sudah berjalan. Membuka dashboard ...
node scripts\windows.js dashboard
timeout /t 3 >nul
exit /b 0

:checkkeys
node scripts\windows.js keys
if not errorlevel 1 goto :start
echo.
echo  Belum ada API key yang diisi.
echo  Notepad akan terbuka: isi minimal satu API key, Simpan (Ctrl+S),
echo  tutup Notepad, lalu jalankan "Free LLM Gateway - Start" lagi.
echo.
node scripts\windows.js edit
pause
exit /b 1

:start
echo.
echo  Free LLM Gateway berjalan di http://127.0.0.1:8787
echo  JANGAN tutup jendela ini selama gateway dipakai (boleh di-minimize).
echo  Untuk berhenti: tutup jendela ini.
echo.
node src\server.js
echo.
echo  Gateway berhenti. Kalau ada pesan error di atas, periksa API key kamu.
pause
