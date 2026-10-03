@echo off
setlocal
where pwsh.exe >nul 2>&1
if not errorlevel 1 (
  pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Chrome-CDP.ps1"
) else (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Chrome-CDP.ps1"
)
set "LAUNCH_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %LAUNCH_EXIT%
