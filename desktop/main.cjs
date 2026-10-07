const { app, BrowserWindow, protocol, ipcMain, dialog } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const ALLOWED = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.wav', '.jpg', '.jpeg', '.png', '.md', '.tex', '.ipynb', '.json', '.yaml', '.yml', '.js', '.env', '.txt']);
const allowedName = name => ALLOWED.has(path.extname(name).toLowerCase()) || path.basename(name).toLowerCase() === '.env';
const MAX = 100 * 1024 * 1024;
const APP_URL = 'omni://app/index.html';
const windows = new Map(), pending = [];
let ready = false, osQueue = Promise.resolve();
protocol.registerSchemesAsPrivileged([{ scheme: 'omni', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();

/** Trust only the top frame of a window created by this application. */
function senderState(event) {
  const state = windows.get(event.sender.id);
  if (!state || state.window.isDestroyed() || event.sender !== state.window.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== APP_URL) throw new Error('Invalid sender');
  return state;
}
function deliver(state) {
  if (state.loaded && state.pending && !state.window.isDestroyed()) {
    state.window.webContents.send('omni-files', [state.pending]); state.pending = null;
  }
}
function createWindow() {
  const root = path.join(__dirname, 'www');
  const window = new BrowserWindow({ width: 1380, height: 920, minWidth: 390, minHeight: 620, backgroundColor: '#020611', icon: path.join(root, 'icon-192.png'), autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  const state = { window, loaded: false, occupied: false, pending: null };
  const id = window.webContents.id;
  windows.set(id, state);
  window.on('closed', () => windows.delete(id));
  window.webContents.on('did-start-navigation', details => { if (details.isMainFrame) state.loaded = false; });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Document gestures own scaling; do not zoom the application chrome.
  void window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', title: 'Несохранённые изменения', message: 'Закрыть Omni без сохранения черновика?', buttons: ['Продолжить редактирование', 'Закрыть без сохранения'], defaultId: 0, cancelId: 0, noLink: true });
    if (choice === 1) event.preventDefault();
  });
  window.webContents.on('will-navigate', (event, url) => { if (url !== APP_URL) event.preventDefault(); });
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^https?:/i.test(details.url) }));
  void window.loadURL(APP_URL).catch(error => { if (!window.isDestroyed()) dialog.showErrorBox('Omni', error.message); });
  return state;
}
/** Reserve an empty window before asynchronous file delivery; occupied windows stay intact. */
function openFile(file, preferred) {
  const state = preferred && !preferred.occupied ? preferred : [...windows.values()].find(item => !item.occupied) || createWindow();
  state.occupied = true; state.pending = file;
  state.window.setTitle(file.name + ' — Omni');
  deliver(state);
  if (state.window.isMinimized()) state.window.restore();
  state.window.show(); state.window.focus();
  return state.window.webContents.id;
}
/** Read only explicit OS file arguments, in their original order. */
function queueFiles(args) {
  osQueue = osQueue.catch(() => {}).then(async () => {
    for (const name of args) {
      if (!allowedName(name)) continue;
      try {
        const resolved = path.resolve(name), stat = await fs.stat(resolved);
        if (!stat.isFile() || stat.size > MAX) continue;
        const file = { name: path.basename(resolved), bytes: await fs.readFile(resolved) };
        if (ready) openFile(file); else pending.push(file);
      } catch { /* Invalid OS arguments do not block the other files. */ }
    }
  });
  return osQueue;
}
app.on('second-instance', (_event, argv) => {
  void queueFiles(argv.slice(1));
  const window = BrowserWindow.getFocusedWindow() || [...windows.values()][0]?.window;
  if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
});
app.on('open-file', (event, name) => { event.preventDefault(); void queueFiles([name]); });
if (locked) app.whenReady().then(async () => {
  const root = path.join(__dirname, 'www');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.json': 'application/json' };
  protocol.handle('omni', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('', { status: 403 });
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) return new Response('', { status: 403 });
      return new Response(await fs.readFile(file), { headers: { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  ipcMain.handle('omni-ready', event => { const state = senderState(event); state.loaded = true; deliver(state); });
  ipcMain.handle('omni-open-file', (event, input) => {
    const state = senderState(event);
    if (!input || !(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength > MAX || typeof input.name !== 'string' || !allowedName(input.name)) throw new Error('Invalid file import');
    return openFile({ name: path.basename(input.name), bytes: Buffer.from(input.bytes) }, state);
  });
  ipcMain.handle('omni-document', (event, name) => {
    const state = senderState(event);
    if (name !== null && typeof name !== 'string') throw new Error('Invalid document');
    state.occupied = name !== null || !!state.pending;
    state.window.setTitle(name ? path.basename(name).slice(0, 200) + ' — Omni' : 'Omni');
  });
  ipcMain.handle('omni-fullscreen', (event, enabled) => {
    const state = senderState(event);
    if (typeof enabled !== 'boolean') throw new Error('Invalid fullscreen state');
    state.window.setFullScreen(enabled);
  });
  ipcMain.handle('omni-save', async (event, input) => {
    const state = senderState(event);
    if (!input || !(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength > MAX || typeof input.name !== 'string') throw new Error('Invalid file export');
    const result = await dialog.showSaveDialog(state.window, { defaultPath: path.basename(input.name), title: 'Экспорт файла' });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, Buffer.from(input.bytes)); return true;
  });
  createWindow(); ready = true;
  for (const file of pending.splice(0)) openFile(file);
  await queueFiles(process.argv.slice(app.isPackaged ? 1 : 2));
});
app.on('window-all-closed', () => app.quit());
