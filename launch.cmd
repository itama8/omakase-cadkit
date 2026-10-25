@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" %*
set "cadkit_result=%errorlevel%"
rem A double-click run has no console to read the error from; scripts and CI must not wait for a key.
if not "%cadkit_result%"=="0" if not defined CI pause
exit /b %cadkit_result%
