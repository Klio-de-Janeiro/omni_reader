@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12+ first.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 goto failed
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<12)){console.error('Node.js 22.12+ is required.');process.exit(1);}"
if errorlevel 1 goto failed
node scripts/sync-native.mjs
if errorlevel 1 goto failed
node -e "const fs=require('node:fs'),hash=require('node:crypto').createHash('sha256').update(fs.readFileSync('desktop/package-lock.json')).digest('hex');try{if(fs.readFileSync('desktop/node_modules/.omni-lock','utf8')!==hash)process.exit(1);require('./desktop/node_modules/electron/package.json');require('./desktop/node_modules/electron-builder/package.json');}catch{process.exit(1);}"
if errorlevel 1 (
  call npm --prefix desktop ci --include=dev
  if errorlevel 1 goto failed
)
node desktop/node_modules/electron/install.js
if errorlevel 1 goto failed
node -e "const fs=require('node:fs'),hash=require('node:crypto').createHash('sha256').update(fs.readFileSync('desktop/package-lock.json')).digest('hex');const executable=require('./desktop/node_modules/electron');if(!fs.existsSync(executable))process.exit(1);fs.writeFileSync('desktop/node_modules/.omni-lock',hash);"
if errorlevel 1 goto failed
call npm --prefix desktop start
if errorlevel 1 goto failed
exit /b 0
:failed
echo Launch failed. Read the error above.
pause
exit /b 1
