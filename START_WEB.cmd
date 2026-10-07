@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12+ first.
  pause
  exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12)){console.error('Node.js 22.12+ is required.');process.exit(1);}"
if errorlevel 1 (
  pause
  exit /b 1
)
start "Omni local server" cmd /k node scripts\serve.mjs
powershell -NoProfile -Command "Start-Sleep -Seconds 1"
start "" "http://127.0.0.1:4173"
exit /b 0
