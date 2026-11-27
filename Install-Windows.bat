@echo off
setlocal
title Free LLM Gateway - Installer
cd /d "%~dp0"

if not exist "src\server.js" goto :notextracted

echo.
echo  ==========================================================
echo    FREE LLM GATEWAY - Installer untuk Windows
echo  ==========================================================
echo.
echo  [1/3] Memeriksa Node.js ...
call :findnode
if defined NODEOK goto :setup

echo        Node.js 22 atau lebih baru belum terpasang.
where winget >nul 2>nul
if errorlevel 1 goto :manualnode
echo        Memasang Node.js LTS lewat winget. Kalau muncul jendela
echo        "Do you want to allow this app...", klik YES.
echo.
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
call :findnode
if defined NODEOK goto :setup

:manualnode
echo.
echo  Node.js belum bisa dipasang otomatis.
echo  Browser akan membuka halaman unduhan Node.js:
echo    1. Unduh "Windows Installer (.msi)" versi LTS, lalu pasang (Next, Next, Install).
echo    2. Setelah selesai, klik dua kali Install-Windows.bat ini sekali lagi.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:setup
for /f "delims=" %%v in ('node -v') do echo        OK, Node.js %%v
echo.
echo  [2/3] Pengaturan
choice /c YN /n /m "        Jalankan gateway otomatis setiap Windows menyala? [Y/N] "
set "AUTO="
if errorlevel 2 goto :install
set "AUTO=--autostart"

:install
echo.
echo  [3/3] Membuat file pengaturan dan shortcut di Desktop ...
node scripts\windows.js setup %AUTO%
if errorlevel 1 goto :failed

echo.
echo  ==========================================================
echo    SELESAI. Langkah berikutnya:
echo  ==========================================================
echo    1. Notepad akan terbuka. Isi minimal SATU API key gratis
echo       (paling mudah: Gemini, https://aistudio.google.com/apikey),
echo       lalu Simpan (Ctrl+S) dan tutup Notepad.
echo    2. Klik dua kali "Free LLM Gateway - Start" di Desktop.
echo    3. Pakai di aplikasi: Base URL http://127.0.0.1:8787/v1
echo       API key = GATEWAY_KEY di file yang sama, model "auto".
echo.
echo    Jangan pindahkan atau hapus folder ini:
echo    %CD%
echo    (shortcut di Desktop mengarah ke sini).
echo.
pause
node scripts\windows.js edit
exit /b 0

:failed
echo.
echo  Instalasi gagal. Salin tulisan di atas dan kirim ke yang membagikan aplikasi ini.
pause
exit /b 1

:notextracted
echo.
echo  File ZIP belum diekstrak.
echo  Klik kanan file ZIP yang diunduh, pilih "Extract All...", lalu
echo  klik dua kali Install-Windows.bat di dalam folder hasil ekstrak.
echo.
pause
exit /b 1

:findnode
set "NODEOK="
where node >nul 2>nul
if errorlevel 1 exit /b 0
for /f %%v in ('node -p "parseInt(process.versions.node)"') do if %%v GEQ 22 set "NODEOK=1"
exit /b 0
