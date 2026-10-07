import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { openViewer } from '../dist/viewers.js';
import { openEditor } from '../dist/editors/ui.js';
import { textCodec, formatJson } from '../dist/text-files.js';
import { parseNotebook } from '../dist/notebooks.js';
import { validateFile, validateBytes } from '../dist/validation.js';
import { isFullscreenShortcut, isThemeShortcut, zoomShortcut, shortcutCommand, getShortcutBindings, shortcutLabel } from '../dist/shortcuts.js';
import { initShortcutSettings } from '../dist/shortcut-settings.js';
import { createReadHighlights } from '../dist/read-highlights.js';
import { initThemes } from '../dist/themes.js';
import { syncBranding } from '../scripts/branding.mjs';
import pngjs from '../vendor-sources/pngjs/lib/png.js';

function fixture(html = '<!doctype html><div id="root"></div>') {
  const w = new JSDOM(html, { url: 'https://omni.test/', pretendToBeVisual: true, runScripts: 'outside-only' }).window;
  const values = { window: w, document: w.document, getSelection: w.getSelection.bind(w), NodeFilter: w.NodeFilter,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w) };
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, values); w.HTMLElement.prototype.scrollIntoView = () => {};
  return { w, root: w.document.querySelector('#root'), close() { w.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } } };
}
const until = async test => { for (let n = 0; n < 100; n++) { if (test()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('UI timed out'); };
const samples = { txt: 'Текст <script>window.injected=true</script>\nСтрока 2', env: '# Комментарий\nTOKEN="a=b"\nPORT=3000', js: '// Комментарий\nwindow.injected = true;\nconst x = `<b>код</b>`;', yaml: '# Конфигурация\nitems:\n  - один\n  - два\nanchor: &x {key: value}\ncopy: *x', yml: 'text: |\n  Строка 1\n  Строка 2', json: '{"label":"Привет","array":[1,true,null],"html":"<img src=x onerror=alert(1)>"}' };
const notebook = {
  nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' }, custom: { retained: true } }, future_field: { keep: [1, 2] },
  cells: [
    { id: 'intro', cell_type: 'markdown', metadata: { tags: ['intro'] }, source: ['# Заголовок\n', '**Текст** и $x^2$'], attachments: { 'image.png': { 'image/png': 'aGVsbG8=' } } },
    { id: 'code', cell_type: 'code', metadata: { custom: 'keep' }, source: ['print("before")\n'], execution_count: 7, outputs: [{ output_type: 'stream', name: 'stdout', text: ['before\n'] }, { output_type: 'display_data', data: { 'text/html': '<table><tr><td>Результат</td></tr></table><script>window.injected=true</script><button id="focus-exit">bad</button>' }, metadata: { keep: true } }], future_cell: 'retain' },
    { id: 'raw', cell_type: 'raw', metadata: { format: 'text/latex' }, source: '\\frac{a}{b}' }
  ]
};

test('New file formats accept empty text, .env and uppercase extensions without admitting binary input', () => {
  for (const ext of Object.keys(samples)) {
    const name = ext === 'env' ? '.env' : `file.${ext.toUpperCase()}`;
    assert.equal(validateFile({ name, size: 0 }), ext);
    validateBytes(new ArrayBuffer(0), ext);
    assert.throws(() => validateBytes(new Uint8Array([0, 1, 2]).buffer, ext), /двоичные/);
    assert.throws(() => validateFile({ name, size: 40 * 1024 * 1024 }), /Лимит/);
  }
  assert.equal(validateFile({ name: 'Notebook.IPYNB', size: 300 }), 'ipynb');
});

test('Text source viewers and inline editors preserve data, preview current drafts and support undo/zoom', async () => {
  const f = fixture();
  try {
    for (const [ext, source] of Object.entries(samples)) {
      const record = { ext, name: ext === 'env' ? '.env' : `test.${ext}`, blob: new File([source], `test.${ext}`) };
      const viewController = new AbortController(), view = await openViewer(record.blob, f.root, { ext, signal: viewController.signal });
      assert.ok(f.root.querySelector('pre')); assert.equal(f.w.injected, undefined);
      assert.equal(f.root.querySelectorAll('script,img,button').length, 0);
      await view.setZoom(1.5); assert.equal(f.root.querySelector('article').style.fontSize, '24px'); viewController.abort();
      let saved; const controller = new AbortController();
      const editor = await openEditor(record, f.root, { signal: controller.signal, onDirty() {}, onError: assert.fail, onClose() {}, onSave: api => { saved = api.export(); } });
      const input = f.root.querySelector('textarea'); assert.equal(input.value, source); assert.equal(editor.dirty, false);
      const changed = ext === 'json' ? '{"changed":true}' : source + '\nДобавлено';
      input.value = changed; input.dispatchEvent(new f.w.Event('input')); assert.equal(editor.dirty, true);
      input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
      assert.equal(input.value, source); assert.equal(editor.dirty, false);
      input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'y', code: 'KeyY', ctrlKey: true, bubbles: true, cancelable: true })); assert.equal(input.value, changed);
      editor.toggleView(); assert.equal(input.hidden, true); assert.match(f.root.querySelector('article').textContent, ext === 'json' ? /changed/ : /Добавлено/);
      editor.toggleView(); assert.equal(input.value, changed); editor.adjustZoom(.25); assert.equal(input.style.fontSize, '20px');
      editor.setBusy(true); assert.equal(input.readOnly, true); editor.setBusy(false);
      input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
      await until(() => saved); assert.equal(new TextDecoder().decode(saved), changed);
      assert.equal(f.root.querySelectorAll('dialog').length, 0); assert.equal(f.w.injected, undefined); controller.abort();
    }
  } finally { f.close(); }
});

test('Invalid JSON stays readable and editable, but cannot export until corrected', async () => {
  const f = fixture(), source = '{"broken":', record = { name: 'broken.json', ext: 'json', blob: new File([source], 'broken.json') };
  try {
    const viewSignal = new AbortController(); await openViewer(record.blob, f.root, { ext: 'json', signal: viewSignal.signal });
    assert.match(f.root.querySelector('.source-notice').textContent, /Ошибка JSON/); viewSignal.abort();
    const signal = new AbortController(), editor = await openEditor(record, f.root, { signal: signal.signal, onSave() {}, onClose() {}, onError: assert.fail });
    assert.throws(() => editor.export(), /Ошибка JSON/);
    assert.equal(f.root.querySelector('.source-edit-notice').hidden, false);
    const input = f.root.querySelector('textarea'); input.value = '{"fixed":1}'; input.dispatchEvent(new f.w.Event('input'));
    assert.equal(f.root.querySelector('.source-edit-notice').hidden, true);
    assert.equal(JSON.parse(new TextDecoder().decode(editor.export())).fixed, 1); signal.abort();
  } finally { f.close(); }
});

test('Text round-trips UTF-8/UTF-16 BOMs and CRLF while editing Unicode', () => {
  const text = 'Привет\r\n😀\r\n';
  const utf8 = new TextEncoder().encode('\ufeff' + text), le = Buffer.from('\ufeff' + text, 'utf16le'), be = Buffer.from(le);
  be.swap16();
  for (const bytes of [utf8, le, be]) {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), codec = textCodec(data);
    assert.equal(codec.text, 'Привет\n😀\n');
    assert.deepEqual(new Uint8Array(codec.encode(codec.text)), new Uint8Array(data));
  }
});

test('JSON preview formats without rounding integers or altering number/string tokens', () => {
  const source = '{"big":900719925474099312345,"exp":1e999,"escaped":"a\\\"b\\\\c","empty":[],"nested":{"n":-0.10e+2}}';
  const pretty = formatJson(source);
  assert.match(pretty, /900719925474099312345/); assert.match(pretty, /1e999/); assert.match(pretty, /-0.10e\+2/);
  assert.deepEqual(JSON.parse(pretty), JSON.parse(source)); assert.match(pretty, /\n  "big"/);
});

test('Notebook viewer renders Markdown/formulas, literal code and saved outputs without execution', async () => {
  const f = fixture(), signal = new AbortController();
  try {
    const view = await openViewer(new File([JSON.stringify(notebook)], 'notes.ipynb'), f.root, { ext: 'ipynb', signal: signal.signal });
    assert.equal(f.root.querySelectorAll('.notebook-cell').length, 3); assert.equal(f.root.querySelector('h1').textContent, 'Заголовок');
    assert.equal(f.root.querySelector('.katex') !== null, true); assert.match(f.root.textContent, /print\("before"\)/);
    assert.match(f.root.querySelector('.notebook-outputs').textContent, /before\n/);
    assert.equal(f.root.querySelector('td').textContent, 'Результат'); assert.equal(f.root.querySelectorAll('script,button,[id]').length, 0);
    assert.equal(f.w.injected, undefined); const result = view.find('print'); assert.match(result.message, /найдено/);
    assert.equal(f.w.getSelection().toString(), 'print'); await view.setZoom(2); assert.equal(f.root.querySelector('article').style.fontSize, '32px');
  } finally { signal.abort(); f.close(); }
});

test('Notebook cell edits, preview, add/delete, undo and export keep metadata, attachments and outputs', async () => {
  const f = fixture(), signal = new AbortController(), record = { name: 'notes.ipynb', ext: 'ipynb', blob: new File([JSON.stringify(notebook)], 'notes.ipynb') };
  try {
    const editor = await openEditor(record, f.root, { signal: signal.signal, onDirty() {}, onSave() {}, onClose() {}, onError: assert.fail });
    const inputs = [...f.root.querySelectorAll('textarea')]; assert.equal(inputs.length, 3); assert.equal(editor.dirty, false);
    inputs[1].value = 'print("after")\n'; inputs[1].dispatchEvent(new f.w.Event('input')); assert.equal(editor.dirty, true);
    assert.equal(f.root.querySelectorAll('.notebook-stale:not([hidden])').length, 1);
    inputs[1].dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    assert.equal(inputs[1].value, 'print("before")\n');
    inputs[1].dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'y', code: 'KeyY', ctrlKey: true, bubbles: true, cancelable: true }));
    editor.toggleView(); assert.equal(inputs[1].hidden, true); assert.match(f.root.querySelectorAll('.notebook-content')[1].textContent, /after/);
    editor.toggleView(); assert.equal(inputs[1].value, 'print("after")\n');
    const button = text => [...f.root.querySelectorAll('button')].find(b => b.textContent === text);
    button('+ Markdown').click(); assert.equal(f.root.querySelectorAll('.notebook-cell').length, 4);
    const added = f.root.querySelectorAll('textarea')[3]; added.value = '# Новый раздел'; added.dispatchEvent(new f.w.Event('input'));
    const current = parseNotebook(new TextDecoder().decode(editor.export()));
    assert.deepEqual(current.metadata, notebook.metadata); assert.deepEqual(current.future_field, notebook.future_field);
    assert.deepEqual(current.cells[0], notebook.cells[0]); assert.deepEqual(current.cells[1].outputs, notebook.cells[1].outputs);
    assert.equal(current.cells[1].execution_count, 7); assert.equal(current.cells[1].future_cell, 'retain');
    assert.deepEqual(current.cells[1].source, ['print("after")\n']); assert.equal(current.cells[3].source.join(''), '# Новый раздел');
    assert.match(current.cells[3].id, /^[\w-]{1,64}$/); assert.equal(new Set(current.cells.map(c => c.id)).size, 4);
    [...f.root.querySelectorAll('.notebook-cell-heading button')].at(-1).click(); assert.equal(f.root.querySelectorAll('.notebook-cell').length, 3);
    button('Отменить').click(); assert.equal(f.root.querySelectorAll('.notebook-cell').length, 4);
    editor.setBusy(true); assert.equal(inputs[0].readOnly, true); editor.setBusy(false);
    editor.adjustZoom(.25); assert.equal(f.root.querySelector('article').style.fontSize, '20px');
  } finally { signal.abort(); f.close(); }
});

test('Damaged notebook can be repaired through its inline JSON source', async () => {
  const f = fixture(), signal = new AbortController();
  try {
    const record = { name: 'bad.ipynb', ext: 'ipynb', blob: new File(['{"nbformat":4}'], 'bad.ipynb') };
    const editor = await openEditor(record, f.root, { signal: signal.signal, onSave() {}, onClose() {}, onError: assert.fail });
    assert.ok(f.root.querySelector('.source-input')); assert.throws(() => editor.export(), /ноутбук/);
    const input = f.root.querySelector('textarea'); input.value = JSON.stringify(notebook); input.dispatchEvent(new f.w.Event('input'));
    editor.toggleView(); assert.equal(f.root.querySelectorAll('.notebook-cell').length, 3);
    assert.equal(parseNotebook(new TextDecoder().decode(editor.export())).cells.length, 3);
  } finally { signal.abort(); f.close(); }
});

test('Fullscreen host exposes source editing and exports .env copies without an empty name', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8'), f = fixture(html), w = f.w;
  const record = { id: 'env', name: '.env', ext: 'env', blob: new File([samples.env], '.env'), size: samples.env.length, saved: true };
  let exported;
  Object.assign(w, { File, TextEncoder, normalizeMode: v => v === 'page' ? 'page' : 'scroll', isFullscreenShortcut, isThemeShortcut, zoomShortcut, initThemes, shortcutCommand, getShortcutBindings, shortcutLabel, initShortcutSettings, createReadHighlights,
    copyText: async () => {}, isNative: true, hasDocumentWindows: false, saveOriginal: async record => { exported = record; },
    setNativeFullscreen: () => true, setNativeDocument() {}, connectNativeFiles() {}, listFiles: async () => [record], saveFile: async () => {}, formatSize: () => '1 B', validateFile, validateBytes, openViewer, openEditor });
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  try {
    let app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
    app = app.replace(/^import .*;\n/gm, '').replace("const { openEditor } = await import('./editors/ui.js');", 'const { openEditor } = window;');
    w.eval(app); await until(() => w.document.querySelector('.file-open')); await w.selectFile('env');
    const edit = w.document.querySelector('#focus-edit'); assert.equal(edit.hidden, false); assert.equal(w.document.body.classList.contains('focus-mode'), true);
    edit.click(); await until(() => !edit.disabled && w.document.querySelector('textarea'));
    const input = w.document.querySelector('textarea'); input.value += '\nNEW_VALUE=1'; input.dispatchEvent(new w.Event('input'));
    edit.click(); assert.match(w.document.querySelector('#viewer').textContent, /NEW_VALUE=1/);
    w.document.querySelector('#focus-save').click(); await until(() => exported);
    assert.equal(exported.name, '.env-edited-1.env'); assert.match(await exported.blob.text(), /NEW_VALUE=1/);
    assert.equal(w.document.body.classList.contains('focus-mode'), true); assert.equal(w.document.querySelector('#discard-dialog').open, false);
  } finally { f.close(); }
});

test('One root omni.png updates app logo, PNG/ICO dimensions and Android resources with no installed dependency', async () => {
  const taskRoot = path.resolve('../tooling/text-notebooks-mobile'); await mkdir(taskRoot, { recursive: true });
  const root = await mkdtemp(path.join(taskRoot, 'branding-'));
  try {
    await mkdir(path.join(root, 'dist')); await mkdir(path.join(root, 'android/app/src/main'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.html'), '<link id="app-favicon" rel="icon" href="./icon.svg" type="image/svg+xml"><img id="brand-logo" src="./icon.svg">');
    await writeFile(path.join(root, 'dist/manifest.webmanifest'), '{"icons":[]}');
    await writeFile(path.join(root, 'android/app/src/main/AndroidManifest.xml'), '<application android:icon="@drawable/ic_launcher"/>');
    assert.equal(await syncBranding(root), false);
    const image = new pngjs.PNG({ width: 64, height: 32 });
    for (let offset = 0; offset < image.data.length; offset += 4) image.data.set([50, 180, 220, 255], offset);
    const original = pngjs.PNG.sync.write(image); await writeFile(path.join(root, 'omni.png'), original);
    assert.equal(await syncBranding(root), true);
    assert.deepEqual(await readFile(path.join(root, 'omni.png')), original);
    assert.match(await readFile(path.join(root, 'dist/index.html'), 'utf8'), /src="\.\/omni.png"/);
    assert.match(await readFile(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8'), /@drawable\/omni_launcher/);
    for (const size of [192, 512]) {
      const decoded = pngjs.PNG.sync.read(await readFile(path.join(root, `dist/icon-${size}.png`))); assert.equal(decoded.width, size); assert.equal(decoded.height, size);
      const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4; assert.deepEqual([...decoded.data.subarray(center, center + 4)], [50, 180, 220, 255]);
      assert.equal(decoded.data[3], 0);
    }
    const ico = await readFile(path.join(root, 'dist/icon.ico')); assert.equal(ico.readUInt16LE(4), 7);
    for (let n = 0; n < 7; n++) {
      const entry = 6 + n * 16, size = ico[entry] || 256, length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12);
      const decoded = pngjs.PNG.sync.read(ico.subarray(offset, offset + length)); assert.equal(decoded.width, size); assert.equal(decoded.height, size);
    }
    assert.equal(await syncBranding(root), true); await writeFile(path.join(root, 'omni.png'), 'wrong format');
    await assert.rejects(syncBranding(root), /настоящее изображение PNG/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
