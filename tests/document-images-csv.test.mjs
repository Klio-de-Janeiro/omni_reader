import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { renderMarkup } from '../dist/vendor/markdown.js';
import { documentMarkup, attachDocumentImages, refreshDocumentImages } from '../dist/document-images.js';
import { relativeImagePath } from '../dist/image-paths.js';
import { openViewer } from '../dist/viewers.js';
import { openEditor } from '../dist/editors/ui.js';
import { parseCsv } from '../dist/table-core.js';
const { readDocumentImage } = createRequire(import.meta.url)('../desktop/document-images.cjs');
const project = fileURLToPath(new URL('../', import.meta.url));
const png = await readFile(new URL('./fixtures/sample.png', import.meta.url));
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
const until = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Image/UI did not finish'); };
function fixture() {
  const w = new JSDOM('<div id="root"></div>', { url: 'https://omni.test/', pretendToBeVisual: true }).window;
  const globals = { window: w, document: w.document, getSelection: w.getSelection.bind(w), NodeFilter: w.NodeFilter,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w) };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals); w.HTMLElement.prototype.scrollIntoView = () => {};
  return { w, root: w.document.querySelector('#root'), close() { w.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } } };
}

test('Markdown inline/reference images resolve relative paths while remote HTML and URL payloads remain blocked', async () => {
  const f = fixture(), calls = [];
  try {
    const source = '### Пример данных\n**вход**\n![image1](seminar_data/2b827.png)\n\n![ref][picture]\n\n[picture]: seminar_data/%D0%A0%D0%B8%D1%81%D1%83%D0%BD%D0%BE%D0%BA%20%25%23.png\n\n![remote](https://example.com/a.png)\n\n![escape](../private.png)';
    const render = documentMarkup(renderMarkup, { imageSource: 'test', images: {} });
    f.w.omniDesktop = { readImage: async (_source, name) => { calls.push(name); return dataUrl; } };
    f.root.append(render(source, 'md', f.w));
    await until(() => f.root.querySelectorAll('img').length === 2);
    assert.equal(f.root.querySelector('h3').textContent, 'Пример данных');
    assert.equal(f.root.querySelector('strong').textContent, 'вход');
    assert.equal(f.root.querySelector('img').alt, 'image1');
    assert.ok([...f.root.querySelectorAll('img')].every(image => image.src === dataUrl));
    assert.deepEqual(calls, ['seminar_data/2b827.png', 'seminar_data/Рисунок %#.png']);
    assert.equal(f.root.querySelectorAll('.markdown-image-placeholder').length, 2);
  } finally { f.close(); }
});

test('IPYNB images survive inline editing, preview and export without replacing Markdown paths', async () => {
  const f = fixture(), controller = new AbortController();
  const source = '![image1](seminar_data/2b827.png)';
  const book = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'm', cell_type: 'markdown', metadata: {}, source }] };
  const record = { name: 'seminar.ipynb', ext: 'ipynb', blob: new File([JSON.stringify(book)], 'seminar.ipynb'), imageSource: 'test', images: {} };
  let reads = 0;
  f.w.omniDesktop = { readImage: async () => { reads++; return dataUrl; } };
  try {
    await openViewer(record.blob, f.root, { ext: 'ipynb', signal: controller.signal, imageRecord: record });
    await until(() => f.root.querySelector('img'));
    controller.abort();
    const editorController = new AbortController();
    const editor = await openEditor(record, f.root, { signal: editorController.signal, onError: assert.fail, onDirty() {}, onClose() {} });
    const input = f.root.querySelector('.notebook-source'); input.value += '\n**Изменено**'; input.dispatchEvent(new f.w.Event('input'));
    editor.toggleView(); await until(() => f.root.querySelector('.notebook-content:not([hidden]) img'));
    assert.match(f.root.querySelector('.notebook-content').textContent, /Изменено/);
    assert.equal(reads, 1);
    const result = JSON.parse(new TextDecoder().decode(await editor.export()));
    assert.match(result.cells[0].source, /!\[image1\]\(seminar_data\/2b827.png\)/);
    assert.equal(record.images['seminar_data/2b827.png'], dataUrl);
    editorController.abort();
  } finally { f.close(); }
});

test('Explicit phone image selection restores placeholders and persists without a native folder token', async () => {
  const f = fixture(), record = { images: {} };
  try {
    f.root.append(renderMarkup('![image1](seminar_data/2b827.png)', 'md', f.w));
    await attachDocumentImages(record, [new File([png], '2b827.png')], f.w);
    refreshDocumentImages(f.root, record);
    assert.equal(f.root.querySelector('img').src, dataUrl);
    const restored = JSON.parse(JSON.stringify(record));
    f.root.replaceChildren(documentMarkup(renderMarkup, restored)('![again](seminar_data/2b827.png)', 'md', f.w));
    await until(() => f.root.querySelector('img'));
    assert.equal(f.root.querySelector('img').src, dataUrl);
  } finally { f.close(); }
});

test('Desktop image reader loads a local raster and rejects traversal, outside links, missing files and disguised text', async () => {
  await mkdir(path.join(project, '.tools'), { recursive: true });
  const workspace = await mkdtemp(path.join(project, '.tools', 'image-reader-test-'));
  try {
    const base = path.join(workspace, 'document'), assets = path.join(base, 'seminar_data');
    await mkdir(assets, { recursive: true }); await writeFile(path.join(assets, '2b827.png'), png);
    await writeFile(path.join(assets, 'Рисунок %#.png'), png); await writeFile(path.join(workspace, 'outside.png'), png);
    await writeFile(path.join(assets, 'fake.png'), '<script>bad</script>');
    assert.equal(await readDocumentImage(base, 'seminar_data/2b827.png'), dataUrl);
    assert.equal(await readDocumentImage(base, relativeImagePath('seminar_data/Рисунок%20%25%23.png')), dataUrl);
    for (const name of ['../outside.png', '/outside.png', 'C:\\outside.png', 'https://example.com/a.png', 'seminar_data/fake.png', 'seminar_data/missing.png']) assert.equal(await readDocumentImage(base, name), null);
    if (process.platform !== 'win32') {
      await symlink(path.join(workspace, 'outside.png'), path.join(assets, 'link.png'));
      assert.equal(await readDocumentImage(base, 'seminar_data/link.png'), null);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('Desktop preload derives the source from the selected File and ignores a supplied arbitrary path', async () => {
  const calls = []; let bridge;
  const file = new File(['# sample'], 'sample.md');
  vm.runInNewContext(await readFile(new URL('../desktop/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } },
      webUtils: { getPathForFile(value) { assert.equal(value, file); return '/selected/sample.md'; } },
      ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } } }), process: { isMainFrame: true }
  });
  await bridge.openFile(file, { sourcePath: '/private/secret.md' });
  assert.equal(calls[0][0], 'omni-open-file'); assert.equal(calls[0][1].sourcePath, '/selected/sample.md');
  assert.equal(new TextDecoder().decode(calls[0][1].bytes), '# sample');
});

test('CSV cells accept direct typing and paste, preserve quoted values, and preview/export the same draft', async () => {
  const f = fixture(), controller = new AbortController();
  const record = { name: 'data.csv', ext: 'csv', blob: new File(['name,value,note\nitem,1,old\n'], 'data.csv') };
  try {
    const editor = await openEditor(record, f.root, { signal: controller.signal, onError: assert.fail, onDirty() {}, onClose() {}, onSave() {} });
    const choose = address => { f.root.querySelector(`td[data-address="${address}"]`).click(); return f.root.querySelector('.csv-cell-input'); };
    let input = choose('B2'); assert.equal(f.w.document.activeElement, input);
    input.value = '0042'; input.dispatchEvent(new f.w.Event('input')); assert.equal(editor.dirty, true);
    input.blur(); input = choose('C2');
    const literal = 'value, with "quotes"\nand a newline';
    input.value = literal; input.dispatchEvent(new f.w.Event('input'));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.equal(f.root.querySelector('.csv-cell-input').getAttribute('aria-label'), 'Значение ячейки D2');
    let data = new TextDecoder().decode(await editor.export());
    assert.deepEqual(parseCsv(data, ',')[1], ['item', '0042', literal]);
    await editor.toggleView();
    assert.equal(f.root.querySelector('.draft-read-viewer td[data-row="1"][data-col="1"]').textContent, '0042');
    await editor.toggleView(); input = choose('B2'); input.value = '123'; input.dispatchEvent(new f.w.Event('input'));
    input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(f.root.querySelector('.csv-cell-input').value, '0042');
    controller.abort();
  } finally { f.close(); }
});
