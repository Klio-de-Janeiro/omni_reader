import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const nativeRequire = createRequire(import.meta.url);

test('Desktop routes each import and OS file to its own trusted window', async () => {
  const created = [], handlers = new Map(), savedIn = [], imageReads = [], exportOps = [], speechCalls = [], speechCancels = [], speechChoices = [];
  let saveResult = { canceled: true };
  let openResult = { canceled: true };
  class SpeechService {
    async settings() { return { python: 'python.exe', model: 'small.pt' }; }
    async configure(kind, selected) { speechChoices.push({ kind, selected }); return this.settings(); }
    async run(owner, id, audio, report) { speechCalls.push({ owner, id, audio }); report({ id, type: 'status', message: 'CPU' }); return { text: 'Речь', savedPath: audio + '.txt' }; }
    cancel(owner, id) { speechCancels.push({ owner, id }); return false; }
  }
  let id = 0;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: ++id, mainFrame: { url: 'omni://app/index.html' }, sent: [], session: {
        setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} }
      }, async printToPDF(options) { this.printOptions=options; return Buffer.from('%PDF-1.7\nmock'); }, setWindowOpenHandler() {}, setIgnoreMenuShortcuts(value) { this.ignoreMenuShortcuts=value; }, setVisualZoomLevelLimits: async () => {}, send(type, data) { this.sent.push({ type, data }); } });
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {} show() {} focus() {} setTitle(value) { this.title = value; }
    async loadURL(url) { this.url=url; }
    destroy() { this.destroyed=true; this.emit('closed'); }
    static getFocusedWindow() { return created.at(-1); }
  }
  const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() {}, isPackaged: false, getPath:()=>'/application/user-data', setAppUserModelId(value) { this.modelId = value; } });
  const electron = { app, BrowserWindow, ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    dialog: { showMessageBoxSync() { throw new Error('Opening another file must not discard a draft'); }, showErrorBox() {}, async showSaveDialog(window) { savedIn.push(window); return saveResult; }, async showOpenDialog() { return openResult; } }
  };
  const fs = { async realpath(value) { return value; }, async stat() { return { isFile: () => true, size: 4 }; }, async readFile() { return Buffer.from('file'); }, async writeFile() {},
    async open(name, flags) { exportOps.push(['open',name,flags]); return { async write(bytes, at, length) { const n=Math.min(2,length); exportOps.push(['write',...bytes.subarray(at,at+n)]); return {bytesWritten:n}; },async close(){exportOps.push(['close']);} }; },
    async rename(from,to){exportOps.push(['rename',from,to]);},async rm(name){exportOps.push(['rm',name]);} };
  const documentImages = { readDocumentImage(base, relative) { imageReads.push({base, relative}); return 'data:image/png;base64,cG5n'; } };
  vm.runInNewContext(await readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8'), {
    require(name) { if (['node:crypto','node:url'].includes(name)) return nativeRequire(name); if (name === 'electron') return electron; if (name === 'node:fs/promises') return fs; if (name === 'node:path') return path; if(name === './speech.cjs') return {SpeechService}; if(name === './document-images.cjs') return documentImages; throw new Error(name); },
    __dirname: '/application/desktop', process: { platform: 'win32', argv: ['electron', '/application'] }, ArrayBuffer, Buffer, URL, Response
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.modelId, 'dev.klio.omni');
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const file = name => ({ name, bytes: new ArrayBuffer(4) });
  assert.equal(created.length, 1);
  const first = created[0]; handlers.get('omni-ready')(event(first));
  handlers.get('omni-open-file')(event(first), file('one.md'));
  handlers.get('omni-open-file')(event(first), file('two.tex'));
  handlers.get('omni-open-file')(event(first), file('three.pptx'));
  assert.equal(created.length, 3); assert.equal(first.webContents.sent.length, 1);
  assert.ok(created.every(window=>window.webContents.ignoreMenuShortcuts===true));
  for (const window of created.slice(1)) handlers.get('omni-ready')(event(window));
  assert.deepEqual(created.map(w => w.webContents.sent[0].data[0].name), ['one.md', 'two.tex', 'three.pptx']);
  assert.throws(() => handlers.get('omni-open-file')({ ...event(first), senderFrame: { url: 'omni://app/index.html' } }, file('blocked.docx')), /Invalid sender/);
  await handlers.get('omni-save')(event(created[1]), file('copy.pdf')); assert.equal(savedIn[0], created[1]);
  handlers.get('omni-document')(event(created[1]), null);
  handlers.get('omni-open-file')(event(first), file('reuse.pdf')); assert.equal(created.length, 3);
  assert.equal(created[1].webContents.sent.at(-1).data[0].name, 'reuse.pdf');
  created[1].webContents.emit('did-start-navigation', { isMainFrame: false });
  handlers.get('omni-document')(event(created[1]), null);
  handlers.get('omni-open-file')(event(first), file('after-frame.docx'));
  assert.equal(created[1].webContents.sent.at(-1).data[0].name, 'after-frame.docx');
  app.emit('second-instance', {}, ['electron', '/docs/from-os.docx', '/docs/second.pdf']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.length, 5);
  handlers.get('omni-ready')(event(created[3])); handlers.get('omni-ready')(event(created[4]));
  assert.equal(created[3].webContents.sent[0].data[0].name, 'from-os.docx');
  assert.equal(created[4].webContents.sent[0].data[0].name, 'second.pdf');
  first.destroyed = true; first.emit('closed');
  assert.throws(() => handlers.get('omni-open-file')(event(first), file('closed.pdf')), /Invalid sender/);
  assert.equal(created[2].webContents.sent.length, 1);
  for (const name of ['notes.ipynb','settings.JSON','config.yaml','config.yml','main.js','.env','notes.txt']) {
    handlers.get('omni-open-file')(event(created[2]), file(name));
    const target = created.at(-1); handlers.get('omni-ready')(event(target));
    assert.equal(target.webContents.sent[0].data[0].name, name);
  }
  const before = created.length;
  app.emit('second-instance', {}, ['electron', '/docs/.env', '/docs/empty.txt', '/docs/unsupported.exe']);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(created.length, before + 2);
  for (const [index,name] of ['.env','empty.txt'].entries()) {
    const target = created[before + index]; handlers.get('omni-ready')(event(target));
    assert.equal(target.webContents.sent[0].data[0].name, name);
  }
  app.emit('second-instance', {}, ['electron', '/docs/seminar.ipynb', '/other/notes.md']);
  await new Promise(resolve => setImmediate(resolve));
  const notebookWindow = created.at(-2), otherWindow = created.at(-1);
  handlers.get('omni-ready')(event(notebookWindow)); handlers.get('omni-ready')(event(otherWindow));
  const imported = notebookWindow.webContents.sent[0].data[0];
  assert.equal(imported.sourcePath, undefined); assert.equal(imported.bytes, undefined); assert.match(imported.url, /^omni:\/\/app\/native\//);
  assert.equal(handlers.get('omni-read-image')(event(notebookWindow), imported.imageSource, 'seminar_data/2b827.png'), 'data:image/png;base64,cG5n');
  assert.deepEqual(imageReads.at(-1), {base:'/docs', relative:'seminar_data/2b827.png'});
  assert.equal(handlers.get('omni-read-image')(event(otherWindow), imported.imageSource, 'seminar_data/2b827.png'), null);
  await handlers.get('omni-open-file')(event(otherWindow), {name:'selected.md', bytes:new ArrayBuffer(4), sourcePath:'/selected/selected.md'});
  const selectedWindow = created.at(-1); handlers.get('omni-ready')(event(selectedWindow));
  const selected = selectedWindow.webContents.sent[0].data[0];
  handlers.get('omni-read-image')(event(selectedWindow), selected.imageSource, 'image.png');
  assert.equal(imageReads.at(-1).base, '/selected');
  saveResult={canceled:false,filePath:'/exports/copy.png'};
  assert.equal(await handlers.get('omni-save-start')(event(selectedWindow),'copy.png'),true);
  await assert.rejects(handlers.get('omni-save-start')(event(selectedWindow),'another.png'),/Invalid/);
  await handlers.get('omni-save-chunk')(event(selectedWindow),new Uint8Array([1,2,3,4,5]).buffer);
  await assert.rejects(handlers.get('omni-save-chunk')(event(selectedWindow),new ArrayBuffer(1048577)),/Invalid/);
  assert.equal(await handlers.get('omni-save-finish')(event(selectedWindow),false),true);
  assert.deepEqual(exportOps.filter(op=>op[0]==='write').flatMap(op=>op.slice(1)),[1,2,3,4,5]);
  assert.equal(exportOps.filter(op=>op[0]==='rename').length,1);assert.equal(exportOps.find(op=>op[0]==='rename')[2],'/exports/copy.png');
  await handlers.get('omni-save-start')(event(selectedWindow),'copy.png');await handlers.get('omni-save-finish')(event(selectedWindow),true);
  assert.equal(exportOps.filter(op=>op[0]==='rename').length,1,'Cancelled writes must not replace the destination');
  app.emit('second-instance', {}, ['electron', '/audio/recording.ogg']);
  await new Promise(resolve => setImmediate(resolve));
  const audioWindow = created.at(-1); handlers.get('omni-ready')(event(audioWindow));
  const audioFile = audioWindow.webContents.sent[0].data[0];
  const recognized = await handlers.get('omni-speech-run')(event(audioWindow), { id:'recognize', name:audioFile.name, url:audioFile.url });
  assert.equal(recognized.text, 'Речь'); assert.deepEqual(speechCalls.at(-1), { owner:audioWindow.webContents.id, id:'recognize', audio:'/audio/recording.ogg' });
  assert.equal(audioWindow.webContents.sent.at(-1).type, 'omni-speech-progress');
  await assert.rejects(handlers.get('omni-speech-run')(event(otherWindow), { id:'foreign', name:audioFile.name, url:audioFile.url }), /не принадлежит/);
  await assert.rejects(handlers.get('omni-speech-run')(event(audioWindow), { id:'arbitrary', name:'recording.ogg', url:'file:///private/audio.ogg' }), /источник/);
  openResult = { canceled:false, filePaths:['/env/python.exe'] };
  await handlers.get('omni-speech-choose')(event(audioWindow),'python');
  assert.deepEqual(speechChoices.at(-1), { kind:'python', selected:'/env/python.exe' });
  let chooseOriginal; openResult = new Promise(resolve => { chooseOriginal = resolve; });
  const pendingSpeech = handlers.get('omni-speech-run')(event(audioWindow), { id:'pending-choice', name:'copy.wav' });
  assert.equal(handlers.get('omni-speech-cancel')(event(audioWindow),'pending-choice'), true);
  chooseOriginal({ canceled:false, filePaths:['/audio/copy.wav'] });
  await assert.rejects(pendingSpeech, /отменено/); assert.equal(speechCalls.length,1);
  audioWindow.destroy(); assert.equal(speechCancels.at(-1).owner,audioWindow.webContents.id);
  const pdf=await handlers.get('omni-pdf')(event(selectedWindow),'<html><body>Document</body></html>');
  assert.match(pdf.toString(),/^%PDF/);const print=created.at(-1);assert.equal(print.options.webPreferences.javascript,false);assert.equal(print.options.webPreferences.nodeIntegration,false);assert.equal(print.destroyed,true);assert.equal(print.webContents.printOptions.preferCSSPageSize,true);

});
