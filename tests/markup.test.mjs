import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { renderMarkup } from '../dist/vendor/markdown.js';
import { openViewer } from '../dist/viewers.js';
import { openMarkupEditor, decodeMarkup } from '../dist/markup.js';
import { openEditor } from '../dist/editors/ui.js';
import { validateFile, validateBytes, validateBlob } from '../dist/validation.js';
import { isFullscreenShortcut, isThemeShortcut, zoomShortcut, shortcutCommand, getShortcutBindings, shortcutLabel } from '../dist/shortcuts.js';
import { initShortcutSettings } from '../dist/shortcut-settings.js';
import { createReadHighlights } from '../dist/read-highlights.js';
import { initThemes } from '../dist/themes.js';

const source = '# Заметки\n\n**Жирный** и *курсив*, ~~удалено~~. Формула $a_i^2$.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] Готово\n- [ ] Позже\n\n$$\\frac{a}{b}$$\n\n```tex\n\\int_0^1 x^2 dx\n```\n\n```python\nprint("$code$")\n```';
function globals(w) {
  const names = ['window', 'document', 'getSelection', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, { window: w, document: w.document, getSelection: w.getSelection.bind(w), NodeFilter: w.NodeFilter,
    requestAnimationFrame: w.requestAnimationFrame.bind(w), cancelAnimationFrame: w.cancelAnimationFrame.bind(w) });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  return () => { for (const name of names) { const value = previous.get(name); if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } };
}
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('UI did not finish'); };

test('Markdown renders GFM and math cells, retaining literal source in code blocks', () => {
  const w = new JSDOM('').window;
  try {
    const result = renderMarkup(source, 'md', w);
    assert.equal(result.querySelector('h1').textContent, 'Заметки');
    assert.equal(result.querySelector('strong').textContent, 'Жирный');
    assert.equal(result.querySelector('em').textContent, 'курсив');
    assert.equal(result.querySelector('del').textContent, 'удалено');
    assert.equal(result.querySelectorAll('td').length, 2);
    assert.match(result.textContent, /☑ Готово/); assert.match(result.textContent, /☐ Позже/);
    assert.equal(result.querySelectorAll('.katex').length, 3);
    assert.equal(result.querySelector('pre code').textContent, 'print("$code$")');
    assert.ok(result.querySelector('.katex-mathml math')); // Accessible formulas survive sanitization.
    assert.equal(renderMarkup('Текст <u>подчёркнут</u><br>ниже', 'md', w).querySelector('u').textContent, 'подчёркнут');
    const currency = renderMarkup('Цена $100 и $200.', 'md', w);
    assert.equal(currency.querySelectorAll('.katex').length, 0); assert.match(currency.textContent, /\$100/);
  } finally { w.close(); }
});
test('TeX snippets and Markdown delimiters render; unsupported TeX remains readable', () => {
  const w = new JSDOM('').window;
  try {
    for (const input of ['\\frac{1}{2}', '\\begin{align}a&=b+c\\\\d&=e\\end{align}', '\\[x^2\\]', '$$x^2$$']) {
      assert.equal(renderMarkup(input, 'tex', w).querySelectorAll('.katex').length, 1);
    }
    assert.equal(renderMarkup('Формула \\(x^2\\)', 'md', w).querySelectorAll('.katex').length, 1);
    assert.match(renderMarkup('$$\\frac{$$', 'md', w).textContent, /\\frac\{/);
    assert.match(renderMarkup('\\documentclass{article}\n\\begin{document}\nТекст\n\\end{document}', 'tex', w).querySelector('.markup-note').textContent, /компилировать в PDF/);
  } finally { w.close(); }
});
test('Markdown cannot execute HTML, inject app controls, fetch images or trust TeX URLs', () => {
  const w = new JSDOM('').window;
  try {
    const input = '<script>alert(1)</script>\n<div class="katex" style="position:fixed" id="focus-exit">X</div>\n\n![remote](https://example.com/a.png)\n\n[link](javascript:alert(1))\n\n$\\href{https://example.com}{x}$';
    const result = renderMarkup(input, 'md', w);
    assert.equal(result.querySelectorAll('script,iframe,object,form,[id],[onclick],[href],[src], [style*="fixed"]').length, 0);
    assert.match(result.textContent, /alert\(1\)/); assert.match(result.querySelector('.markdown-image-placeholder').textContent, /remote/);
  } finally { w.close(); }
});
test('Markdown and TeX accept Unicode and reject binary/oversized input', () => {
  const utf8 = new TextEncoder().encode('# Привет');
  for (const ext of ['md', 'tex']) {
    assert.equal(validateFile({ name: `A.${ext.toUpperCase()}`, size: utf8.length }), ext);
    validateBytes(utf8.buffer, ext); assert.equal(decodeMarkup(utf8.buffer), '# Привет');
    assert.throws(() => validateBytes(new Uint8Array([0, 1, 2]).buffer, ext), /двоичные/);
    assert.throws(() => validateFile({ name: `a.${ext}`, size: 500000000 }), /500/);
  }
  assert.equal(decodeMarkup(new Uint8Array([255, 254, 35, 0, 32, 0, 31, 4]).buffer), '# П');
});
test('Inline Markdown source, preview and export share one draft and scale without leaving the file', async () => {
  const w = new JSDOM('<div id="view"></div>', { pretendToBeVisual: true }).window, restore = globals(w);
  const root = w.document.querySelector('#view'), signal = new AbortController();
  const record = { name: 'notes.md', ext: 'md', blob: new File([source], 'notes.md') };
  const dirty = []; let saved;
  try {
    const view = await openViewer(record.blob, root, { ext: 'md', signal: signal.signal });
    assert.ok(root.querySelector('h1')); await view.setZoom(1.5);
    assert.equal(root.querySelector('article').style.transform, 'scale(1.5)'); signal.abort();
    const editor = await openMarkupEditor(record, root, { signal: new AbortController().signal, onDirty: value => dirty.push(value), onSave: async api => { saved = await api.export(); }, onClose() {}, onError: assert.fail });
    const input = root.querySelector('textarea'); assert.equal(w.document.activeElement, input);
    input.value += '\n\n## Новая глава\n\n$E=mc^2$'; input.dispatchEvent(new w.Event('input'));
    assert.equal(editor.dirty, true); assert.equal(dirty.at(-1), true);
    editor.toggleView(); assert.equal(input.hidden, true); assert.equal(root.querySelector('h2').textContent, 'Новая глава');
    editor.adjustZoom(0.25); assert.equal(root.querySelector('.visual-zoom-content').style.transform, 'scale(1.25)');
    editor.toggleView(); assert.equal(input.hidden, false); assert.match(input.value, /Новая глава/);
    editor.setBusy(true); assert.equal(input.readOnly, true); editor.setBusy(false);
    input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', code: 'KeyS', ctrlKey: true, bubbles: true, cancelable: true }));
    await until(() => !!saved); assert.equal(new TextDecoder().decode(saved), input.value);
    editor.adjustZoom(null); assert.equal(root.querySelector('.visual-zoom-content').style.transform, 'scale(1)');
    assert.equal(root.querySelectorAll('dialog').length, 0); editor.dispose();
  } finally { restore(); w.close(); }
});
test('Fullscreen button edits Markdown, previews the draft and saves a copy; Ctrl +/-/0 scales the document', async () => {
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const w = new JSDOM(html, { pretendToBeVisual: true, runScripts: 'outside-only', url: 'https://omni.test/' }).window, restore = globals(w);
  const record = { id: 'one', name: 'notes.md', ext: 'md', blob: new File([source], 'notes.md'), size: new TextEncoder().encode(source).length, saved: true };
  Object.assign(w, { initConversion:()=>({sync(){}}), File, TextEncoder, normalizeMode: v => v === 'page' ? 'page' : 'scroll', isFullscreenShortcut, isThemeShortcut, zoomShortcut, initThemes, shortcutCommand, getShortcutBindings, shortcutLabel, initShortcutSettings, createReadHighlights,
    copyText: async () => {}, isNative: true, hasDocumentWindows: false, saveOriginal: async () => true,
    setNativeFullscreen: () => true, setNativeDocument() {}, connectNativeFiles() {},
    listFiles: async () => [record], saveFile: async () => {}, formatSize: () => '1 B', validateFile, validateBytes, validateBlob, openViewer, openEditor });
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  const key = data => { const event = new w.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...data }); (w.document.querySelector('textarea:not([hidden])') || w.document).dispatchEvent(event); return event; };
  try {
    let app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
    app = app.replace(/^import .*;\n/gm, '').replace("const { openEditor } = await import('./editors/ui.js');", 'const { openEditor } = window;');
    w.localStorage.setItem('omni.autosave','true');w.eval(app); await until(() => w.document.querySelector('.file-open'));
    const remember=w.document.querySelector('#remember');assert.equal(remember.checked,true);remember.checked=false;remember.dispatchEvent(new w.Event('change'));assert.equal(w.localStorage.getItem('omni.autosave'),'false');w.dispatchEvent(new w.StorageEvent('storage',{key:'omni.autosave',newValue:'true'}));assert.equal(remember.checked,true);remember.checked=false;remember.dispatchEvent(new w.Event('change'));
    await w.selectFile('one'); assert.equal(w.document.body.classList.contains('focus-mode'), true);
    key({ctrlKey:true,key:'ч',code:'KeyX'});assert.equal(w.document.documentElement.dataset.theme,'normal');assert.equal(w.document.body.classList.contains('focus-mode'),true);
    key({ctrlKey:true,key:'я',code:'KeyZ'});assert.equal(w.document.body.classList.contains('focus-mode'),false);
    key({ctrlKey:true,key:'z',code:'KeyZ'});assert.equal(w.document.body.classList.contains('focus-mode'),true);
    const edit = w.document.querySelector('#focus-edit'); assert.equal(edit.hidden, false); assert.equal(edit.disabled, false);
    assert.equal(key({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' }).defaultPrevented, true);
    await until(() => w.document.querySelector('article').style.transform === 'scale(1.25)');
    key({ ctrlKey: true, key: '-', code: 'NumpadSubtract' }); await until(() => w.document.querySelector('article').style.transform === 'scale(1)');
    edit.click(); await until(() => !edit.disabled && w.document.querySelector('textarea'));
    assert.equal(w.document.body.classList.contains('focus-mode'), true); assert.equal(edit.textContent, 'Просмотр');
    const input = w.document.querySelector('textarea'); input.value += '\n\n## Изменено'; input.dispatchEvent(new w.Event('input'));
    key({ctrlKey:true,altKey:true,key:'z',code:'KeyZ'});assert.ok(!input.value.includes('Изменено'));assert.equal(w.document.body.classList.contains('focus-mode'),true);
    key({ctrlKey:true,key:'y',code:'KeyY'});assert.match(input.value,/Изменено/);
    const save = w.document.querySelector('#focus-save'); assert.equal(save.hidden, false); assert.equal(save.disabled, false);
    edit.click(); assert.equal(w.document.querySelector('#viewer h2').textContent, 'Изменено'); assert.equal(edit.textContent, 'Редактировать');
    edit.click(); assert.match(input.value, /Изменено/);
    key({ ctrlKey: true, key: '=', code: 'Equal' }); assert.equal(w.document.querySelector('.visual-zoom-content').style.transform, 'scale(1.25)');
    key({ ctrlKey: true, key: '0', code: 'Numpad0' }); assert.equal(w.document.querySelector('.visual-zoom-content').style.transform, 'scale(1)');
    key({ ctrlKey: true, key: 's', code: 'KeyS' });
    await until(() => w.document.querySelector('#reader-name').textContent === 'notes-edited-1.md' && w.document.querySelector('#viewer h2')?.textContent === 'Изменено');
    assert.equal(w.document.querySelector('#viewer h2').textContent, 'Изменено'); assert.equal(w.document.body.classList.contains('focus-mode'), true);
    assert.equal(w.document.querySelector('#discard-dialog').open, false);
  } finally { w.close(); restore(); }
});
