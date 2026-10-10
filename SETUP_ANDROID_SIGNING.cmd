@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SETUP_ANDROID_SIGNING.ps1"
if errorlevel 1 echo Signing setup failed. Read the error above.
pause
