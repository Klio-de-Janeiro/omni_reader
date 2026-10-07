import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

test('Desktop routes each import and OS file to its own trusted window', async () => {
  const created = [], handlers = new Map(), savedIn = [];
  let id = 0;
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); this.destroyed = false; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { id: ++id, mainFrame: { url: 'omni://app/index.html' }, sent: [], session: {
        setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} }
      }, setWindowOpenHandler() {}, setVisualZoomLevelLimits: async () => {}, send(type, data) { this.sent.push({ type, data }); } });
      created.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    restore() {} show() {} focus() {} setTitle(value) { this.title = value; }
    async loadURL() {}
    static getFocusedWindow() { return created.at(-1); }
  }
  const app = new EventEmitter(); Object.assign(app, { requestSingleInstanceLock: () => true, whenReady: async () => {}, quit() {}, isPackaged: false });
  const electron = { app, BrowserWindow, ipcMain: { handle(name, callback) { handlers.set(name, callback); } },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    dialog: { showMessageBoxSync() { throw new Error('Opening another file must not discard a draft'); }, showErrorBox() {}, async showSaveDialog(window) { savedIn.push(window); return { canceled: true }; } }
  };
  const fs = { async stat() { return { isFile: () => true, size: 4 }; }, async readFile() { return Buffer.from('file'); }, async writeFile() {} };
  vm.runInNewContext(await readFile(new URL('../desktop/main.cjs', import.meta.url), 'utf8'), {
    require(name) { if (name === 'electron') return electron; if (name === 'node:fs/promises') return fs; if (name === 'node:path') return path; throw new Error(name); },
    __dirname: '/application/desktop', process: { argv: ['electron', '/application'] }, ArrayBuffer, Buffer, URL, Response
  });
  await new Promise(resolve => setImmediate(resolve));
  const event = window => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  const file = name => ({ name, bytes: new ArrayBuffer(4) });
  assert.equal(created.length, 1);
  const first = created[0]; handlers.get('omni-ready')(event(first));
  handlers.get('omni-open-file')(event(first), file('one.md'));
  handlers.get('omni-open-file')(event(first), file('two.tex'));
  handlers.get('omni-open-file')(event(first), file('three.pptx'));
  assert.equal(created.length, 3); assert.equal(first.webContents.sent.length, 1);
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
});
