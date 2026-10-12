@echo off
rem PowerShell launch: .\Build_windows (Windows resolves this CMD file).
setlocal
cd /d "%~dp0"
if errorlevel 1 goto failed
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12+ first.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js 22.12+ with npm.
  pause
  exit /b 1
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 12)) { console.error('Node.js 22.12+ is required. Current: ' + process.version); process.exit(1); }"
if errorlevel 1 goto failed
node -e "const fs = require('node:fs'); for (const file of ['desktop/main.cjs','desktop/preload.cjs','desktop/speech.cjs','desktop/speech-session.cjs','desktop/speech-defaults.json','desktop/speech/transcribe.py','dist/speech-ui.js','dist/speech-options-ui.js','dist/speech.css']) { if (!fs.existsSync(file)) { console.error('Missing source file: ' + file + '. Extract the complete patch into the project folder.'); process.exit(1); } }"
if errorlevel 1 goto failed
node scripts/sync-native.mjs
if errorlevel 1 goto failed
call npm --prefix desktop ci --include=dev
if errorlevel 1 goto failed
node desktop/node_modules/electron/install.js
if errorlevel 1 goto failed
node -e "const fs = require('node:fs'); const executable = require('./desktop/node_modules/electron'); if (!fs.existsSync(executable)) { console.error('Electron executable is missing. Check the download error above.'); process.exit(1); }"
if errorlevel 1 goto failed
call npm --prefix desktop run dist:win -- --publish never
if errorlevel 1 goto failed
node -e "const fs = require('node:fs'); const p = require('./desktop/package.json'); const file = 'release/windows/Omni-Reader-' + p.version + '-Windows-Setup.exe'; if (!fs.existsSync(file)) { console.error('Build finished without the expected installer: ' + file); process.exit(1); } console.log('Installer ready: ' + file);"
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo Build failed. Read the error above.
pause
exit /b 1
