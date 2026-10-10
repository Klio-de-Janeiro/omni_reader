const { app, BrowserWindow, protocol, ipcMain, dialog, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { readDocumentImage } = require('./document-images.cjs');
const { SpeechService } = require('./speech.cjs');
let speech;
// Match the installer shortcut identity so Windows groups and pins Omni correctly.
if (process.platform === 'win32') app.setAppUserModelId('dev.klio.omni');
const ALLOWED = new Set(['.pdf', '.doc', '.docx', '.pptx', '.xlsx', '.csv', '.wav', '.ogg', '.jpg', '.jpeg', '.png', '.md', '.tex', '.ipynb', '.json', '.yaml', '.yml', '.js', '.env', '.txt']);
const allowedName = name => ALLOWED.has(path.extname(name).toLowerCase()) || path.basename(name).toLowerCase() === '.env';
const MAX = 499999999;
const APP_URL = 'omni://app/index.html';
const windows = new Map(), pending = [], nativeFiles = new Map(), printPages = new Map();
let ready = false, osQueue = Promise.resolve();
let imageSequence = 0;
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
  const state = { window, loaded: false, occupied: false, pending: null, imageSources: new Map() };
  const id = window.webContents.id;
  windows.set(id, state);
  window.on('closed', () => {
    if (state.speechRequest) state.speechRequest.cancelled = true;
    speech?.cancel(id);
    windows.delete(id);
    for (const [key, value] of nativeFiles) if (value.owner === id) nativeFiles.delete(key);
    const job = state.exportJob; state.exportJob = null;
    if (job?.handle) void job.handle.close().catch(() => {}).then(() => fs.rm(job.temp, { force: true }).catch(() => {}));
  });
  window.webContents.on('did-start-navigation', details => { if (details.isMainFrame) state.loaded = false; });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Renderer commands own their configurable bindings, including Ctrl+Z and zoom.
  window.webContents.setIgnoreMenuShortcuts(true);
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
  const imageBase = file.sourcePath ? path.dirname(file.sourcePath) : file.imageBase;
  let imageSource;
  if (imageBase && ['.md','.tex','.ipynb'].includes(path.extname(file.name).toLowerCase())) {
    imageSource = 'document-' + (++imageSequence); state.imageSources.set(imageSource, imageBase);
  }
  let url;
  if (file.sourcePath) { const key = randomUUID(); nativeFiles.set(key, { path: file.sourcePath, owner: state.window.webContents.id }); url = 'omni://app/native/' + key; }
  state.occupied = true; state.pending = { name: file.name, bytes: file.bytes, url, imageSource, images: file.images || {} };
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
        const file = { name: path.basename(resolved), sourcePath: resolved };
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
  speech = new SpeechService(app.getPath('userData'), path.join(app.isPackaged ? process.resourcesPath : __dirname, 'speech', 'transcribe.py'));
  const root = path.join(__dirname, 'www');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.json': 'application/json' };
  protocol.handle('omni', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || request.method !== 'GET') return new Response('', { status: 403 });
      if (url.pathname.startsWith('/native/')) {
        const source = nativeFiles.get(url.pathname.slice(8)); if (!source) return new Response('', { status: 404 });
        const stat = await fs.stat(source.path); if (!stat.isFile() || stat.size > MAX) return new Response('', { status: 413 });
        return net.fetch(pathToFileURL(source.path).href);
      }
      if (url.pathname.startsWith('/print/')) {
        const html = printPages.get(url.pathname.slice(7)); if (!html) return new Response('', { status: 404 });
        return new Response(html, { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;" } });
      }
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) return new Response('', { status: 403 });
      return new Response(await fs.readFile(file), { headers: { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' } });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  ipcMain.handle('omni-ready', event => { const state = senderState(event); state.loaded = true; deliver(state); });
  ipcMain.handle('omni-open-file', (event, input) => {
    const state = senderState(event);
    if (!input || (!(input.bytes instanceof ArrayBuffer) && typeof input.sourcePath !== 'string') || (input.bytes && input.bytes.byteLength > MAX) || typeof input.name !== 'string' || !allowedName(input.name)) throw new Error('Invalid file import');
    const file = { name: path.basename(input.name), bytes: input.bytes instanceof ArrayBuffer ? Buffer.from(input.bytes) : undefined, images: input.images || {}, imageBase: state.imageSources.get(input.imageSource) };
    // sourcePath is supplied exclusively by preload's getPathForFile(File), not by page text.
    if (typeof input.sourcePath === 'string' && input.sourcePath) return (async () => {
      const sourcePath = await fs.realpath(input.sourcePath), stat = await fs.stat(sourcePath);
      if (!stat.isFile() || stat.size > MAX || path.basename(sourcePath) !== file.name) throw new Error('Invalid selected file');
      file.bytes = undefined; file.sourcePath = sourcePath;
      return openFile(file, state);
    })();
    return openFile(file, state);
  });
  ipcMain.handle('omni-speech-settings', event => { senderState(event); return speech.settings(); });
  ipcMain.handle('omni-speech-choose', async (event, kind) => {
    const state = senderState(event);
    if (!['python','model-file','model-folder','ffmpeg'].includes(kind)) throw new Error('Неверная настройка Whisper.');
    const titles = { python: 'Выберите python.exe окружения с Whisper', 'model-file': 'Выберите скачанную модель Whisper .pt', 'model-folder': 'Выберите папку faster-whisper с model.bin', ffmpeg: 'Выберите ffmpeg.exe' };
    const selection = await dialog.showOpenDialog(state.window, { title: titles[kind], properties: [kind === 'model-folder' ? 'openDirectory' : 'openFile'], filters: kind === 'model-file' ? [{name:'Whisper',extensions:['pt']}] : [{name:'Программы',extensions:['exe','*']}] });
    if (selection.canceled || !selection.filePaths?.length) return null;
    return speech.configure(kind, selection.filePaths[0]);
  });
  ipcMain.handle('omni-speech-run', async (event, input) => {
    const state = senderState(event);
    if (!input || typeof input.name !== 'string' || !['.wav','.ogg'].includes(path.extname(input.name).toLowerCase())) throw new Error('Нужна запись OGG или WAV.');
    if (typeof input.id !== 'string' || !/^[\w-]{1,80}$/.test(input.id)) throw new Error('Неверный запрос распознавания.');
    if (state.speechRequest) throw new Error('В этом окне уже запущено распознавание.');
    const request = { id: input.id, cancelled: false }; state.speechRequest = request;
    try {
      let source;
      if (input.url) {
        const url = new URL(input.url);
        if (url.protocol !== 'omni:' || url.hostname !== 'app' || !url.pathname.startsWith('/native/')) throw new Error('Неверный источник записи.');
        const file = nativeFiles.get(url.pathname.slice(8));
        if (!file || file.owner !== event.sender.id) throw new Error('Запись не принадлежит этому окну. Откройте её с диска заново.');
        source = file.path;
      } else {
        const selection = await dialog.showOpenDialog(state.window, { title: 'Выберите исходную запись на диске для сохранения текста рядом', properties: ['openFile'], filters: [{name:'Запись OGG/WAV',extensions:['ogg','wav']}] });
        if (selection.canceled || !selection.filePaths?.length) return null;
        source = selection.filePaths[0];
      }
      if (request.cancelled || state.window.isDestroyed()) throw new Error('Распознавание отменено.');
      return await speech.run(event.sender.id, input.id, source, progress => {
        if (!state.window.isDestroyed()) { try { state.window.webContents.send('omni-speech-progress', progress); } catch {} }
      });
    } finally { if (state.speechRequest === request) state.speechRequest = null; }
  });
  ipcMain.handle('omni-speech-cancel', (event, id) => {
    const state = senderState(event), request = state.speechRequest;
    if (request?.id === id) request.cancelled = true;
    return speech.cancel(event.sender.id, id) || request?.id === id;
  });
  ipcMain.handle('omni-read-image', (event, source, relative) => {
    const state = senderState(event), base = state.imageSources.get(source);
    return base ? readDocumentImage(base, relative) : null;
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
  ipcMain.handle('omni-save-start', async (event, name) => {
    const state = senderState(event);
    if (state.exportJob || typeof name !== 'string' || !name || name.length > 240) throw new Error('Invalid file export');
    const job = {}; state.exportJob = job;
    try {
      const result = await dialog.showSaveDialog(state.window, { defaultPath: path.basename(name), title: 'Экспорт файла' });
      if (result.canceled || !result.filePath || state.window.isDestroyed()) { state.exportJob = null; return false; }
      job.path = result.filePath; job.temp = job.path + '.omni-' + randomUUID() + '.tmp'; job.bytes = 0; job.handle = await fs.open(job.temp, 'wx'); if (state.window.isDestroyed()) { await job.handle.close(); await fs.rm(job.temp, { force: true }); state.exportJob = null; return false; } return true;
    } catch (error) { state.exportJob = null; throw error; }
  });
  ipcMain.handle('omni-save-chunk', async (event, bytes) => {
    const state = senderState(event), job = state.exportJob;
    if (!job?.handle || job.writing || !(bytes instanceof ArrayBuffer) || bytes.byteLength > 1048576 || job.bytes + bytes.byteLength > MAX) throw new Error('Invalid export chunk');
    job.writing = true;
    try { const buffer = Buffer.from(bytes); let at = 0; while (at < buffer.length) { const result = await job.handle.write(buffer, at, buffer.length - at); if (!result.bytesWritten) throw new Error('Failed to write file'); at += result.bytesWritten; } job.bytes += buffer.length; }
    finally { job.writing = false; }
  });
  ipcMain.handle('omni-save-finish', async (event, cancel = false) => {
    const state = senderState(event), job = state.exportJob;
    if (!job?.handle || job.writing) throw new Error('No active export');
    try { await job.handle.close(); if (!cancel) await fs.rename(job.temp, job.path); }
    finally { state.exportJob = null; await fs.rm(job.temp, { force: true }); }
    return !cancel;
  });
  ipcMain.handle('omni-pdf', async (event, html) => {
    const state = senderState(event);
    if (state.printBusy || typeof html !== 'string' || Buffer.byteLength(html) > MAX) throw new Error('Invalid PDF request');
    state.printBusy = true; const key = randomUUID(); let printWindow;
    try {
      printPages.set(key, html);
      printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false } });
      printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await printWindow.loadURL('omni://app/print/' + key);
      const bytes = await printWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: 'A4', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
      if (bytes.length > MAX) throw new Error('PDF должен быть меньше 500 МБ.'); return bytes;
    } finally { printWindow?.destroy(); printPages.delete(key); state.printBusy = false; }
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
