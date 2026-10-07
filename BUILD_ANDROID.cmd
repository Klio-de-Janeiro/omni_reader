@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0BUILD_ANDROID.ps1"
if errorlevel 1 echo Build failed. Read the error above.
pause
