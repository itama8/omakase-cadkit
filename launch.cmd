@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
set "cadkit_result=%errorlevel%"
if not "%cadkit_result%"=="0" pause
exit /b %cadkit_result%
