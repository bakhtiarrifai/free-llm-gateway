@echo off
rem fgw for Windows: Install-Windows.bat adds this folder to the user PATH, so "fgw claude" works in any new
rem PowerShell or CMD window. "fgw claude" starts the gateway first when it is not running yet.
setlocal
set "FGW_ROOT=%~dp0..\.."
where node >nul 2>nul
if errorlevel 1 set "PATH=%ProgramFiles%\nodejs;%PATH%"
if /i not "%~1"=="claude" goto :run
node "%FGW_ROOT%\scripts\windows.js" running
if not errorlevel 1 goto :run
echo [fgw] Menyalakan Free LLM Gateway di jendela lain ...
start "Free LLM Gateway" /min "%FGW_ROOT%\windows\start-gateway.bat"
set /a FGW_TRIES=0
:wait
ping -n 2 127.0.0.1 >nul
node "%FGW_ROOT%\scripts\windows.js" running
if not errorlevel 1 goto :run
set /a FGW_TRIES+=1
if %FGW_TRIES% LSS 20 goto :wait
echo [fgw] Gateway belum menyala. Lihat jendela "Free LLM Gateway" untuk pesan error-nya.
:run
node "%FGW_ROOT%\bin\fgw.js" %*
exit /b %errorlevel%
