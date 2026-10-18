import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { openLatexEditor } from '../dist/latex-editor.js';

const waitFor = async predicate => {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('LaTeX editor timed out');
};
const pending = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const pdf = new TextEncoder().encode('%PDF-1.7\nfixture');

async function fixture({ source = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}', services = {}, ...extra } = {}) {
  const w = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://omni.test/', pretendToBeVisual: true }).window;
  const previous = new Map(['window', 'document'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, { window: w, document: w.document });
  const root = w.document.querySelector('#root'), controller = new AbortController(), calls = [], renders = [], errors = [], saved = [];
  const record = { id: 'tex-fixture', ext: 'tex', name: 'sample.tex', blob: new Blob([source]), nativeUrl: 'C:/project/sample.tex' };
  const actualServices = {
    getLatexStatus: async () => ({ available: true, engine: 'Tectonic' }),
    compileLatex: async (request, options) => { calls.push({ request, options }); return { ok: true, pdf, diagnostics: [], log: '', engine: 'Tectonic' }; },
    cancelLatex: async () => true,
    saveLatexSource: async (...args) => { saved.push(args); return true; },
    downloadLatexPdf: async () => true,
    ...services
  };
  const editor = await openLatexEditor(record, root, {
    signal: controller.signal, onError: error => errors.push(error), ...extra, services: actualServices,
    renderPdf: extra.renderPdf || (async (file, stage, context) => {
      const mark = w.document.createElement('div'); mark.textContent = 'PDF build ' + (renders.length + 1); stage.append(mark);
      const viewer = { setZoom: async () => {}, setPage: async page => { context.onPage(page); }, dispose() { viewer.disposed = true; } };
      context.onPages(3); context.onPage(1); renders.push({ file, stage, context, viewer }); return viewer;
    })
  });
  await waitFor(() => !root.querySelector('.latex-status').textContent.includes('Проверка'));
  const input = root.querySelector('textarea');
  return {
    w, root, input, editor, record, calls, renders, errors, saved, controller,
    change(value) { input.dispatchEvent(new w.Event('beforeinput')); input.value = value; input.dispatchEvent(new w.Event('input')); },
    trust() { const field = root.querySelector('.latex-trust'); field.checked = true; field.dispatchEvent(new w.Event('change')); },
    async close() { controller.abort(); w.close(); for (const [name, value] of previous) { if (value) Object.defineProperty(globalThis, name, value); else delete globalThis[name]; } }
  };
}

test('Opening TeX never executes it; trust gates manual compilation and all three layouts keep the draft', async () => {
  const f = await fixture();
  try {
    assert.equal(f.calls.length, 0); assert.equal(f.root.querySelector('.latex-auto').checked, false);
    assert.equal(f.root.querySelector('.latex-compile').disabled, true); assert.equal(await f.editor.compile(), false);
    f.change('Draft <script>alert(1)</script>');
    for (const mode of ['source', 'preview', 'split']) {
      f.root.querySelector('.latex-mode-' + mode).click();
      assert.equal(f.editor.mode, mode); assert.equal(f.editor.sourceMode, mode !== 'preview');
      assert.equal(f.input.value, 'Draft <script>alert(1)</script>');
      assert.equal(f.root.querySelector('.latex-mode-' + mode).getAttribute('aria-pressed'), 'true');
      assert.equal(f.root.querySelector('.latex-source-pane').hidden, mode === 'preview');
      assert.equal(f.root.querySelector('.latex-preview-pane').hidden, mode === 'source');
    }
    const separator = f.root.querySelector('[role="separator"]');
    separator.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.equal(separator.getAttribute('aria-valuenow'), '80');
    separator.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(separator.getAttribute('aria-valuenow'), '80');
    separator.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.equal(separator.getAttribute('aria-valuenow'), '20');
    f.trust(); assert.equal(f.root.querySelector('.latex-compile').disabled, false);
    f.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => f.renders.length === 1 && !f.editor.compiling);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].request.trusted, true);
    assert.equal(f.calls[0].request.source, f.input.value); assert.equal(f.calls[0].request.nativeUrl, f.record.nativeUrl);
    assert.equal(f.root.querySelectorAll('script').length, 0); assert.equal(f.editor.busy, false);
  } finally { await f.close(); }
});

test('The editor rejects oversized TeX before allocating a source buffer', async () => {
  let read = false;
  await assert.rejects(openLatexEditor({ blob: { size: 8 * 1024 * 1024 + 1, arrayBuffer() { read = true; } } }, null), /8 МиБ/);
  assert.equal(read, false);
});

test('Editing during compilation marks its PDF stale; failed builds retain PDF and clickable diagnostics locate source lines', async () => {
  const build = pending(), attempts = [], exports = [];
  const f = await fixture({ source: 'First\nSecond\nThird', services: {
    compileLatex: (request, options) => { attempts.push({ request, options }); return attempts.length === 1 ? build.promise : { ok: false, diagnostics: [{ line: 2, severity: 'error', message: '<img src=x onerror=alert(1)> Missing brace' }], log: '! Error\nl.2 Second' }; },
    downloadLatexPdf: async (data, name) => { exports.push({ data, name }); return true; }
  } });
  try {
    f.trust(); const compiling = f.editor.compile();
    assert.equal(f.editor.compiling, true); assert.equal(f.editor.busy, false); assert.equal(f.input.readOnly, false);
    f.change('First\nChanged second\nThird');
    build.resolve({ ok: true, pdf, log: 'Done', diagnostics: [] }); assert.equal(await compiling, true);
    assert.equal(f.root.querySelector('.latex-stale').hidden, false);
    const goodStage = f.root.querySelector('.latex-pdf-viewer');
    assert.equal(await f.editor.compile(), false); assert.equal(f.root.querySelector('.latex-pdf-viewer'), goodStage);
    assert.equal(f.renders.length, 1); assert.equal(f.renders[0].context.signal.aborted, false);
    assert.equal(f.root.querySelector('.latex-diagnostics').open, true);
    f.editor.setMode('preview'); f.root.querySelector('.latex-diagnostic-link').click();
    assert.equal(f.editor.mode, 'split'); assert.equal(f.input.selectionStart, 6); assert.equal(f.w.document.activeElement, f.input);
    assert.equal(f.root.querySelectorAll('img').length, 0);
    f.root.querySelector('.latex-export').click(); await waitFor(() => exports.length);
    assert.deepEqual(exports[0].data, pdf); assert.equal(exports[0].name, 'sample.pdf');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Cancellation ignores a late compiler response, permits a new build, and disposal aborts PDF rendering', async () => {
  const first = pending(), second = pending(), attempts = [], canceledIds = [];
  const f = await fixture({ services: {
    compileLatex: (request, options) => { attempts.push({ request, options }); return attempts.length === 1 ? first.promise : second.promise; },
    cancelLatex: async id => { canceledIds.push(id); }
  } });
  try {
    f.trust(); const old = f.editor.compile(); f.editor.cancel();
    assert.equal(attempts[0].options.signal.aborted, true); assert.equal(f.editor.compiling, false);
    assert.deepEqual(canceledIds, [attempts[0].request.id]); assert.match(attempts[0].request.id, /^latex-[\w-]+$/);
    f.change('A newer draft'); const next = f.editor.compile();
    first.resolve({ ok: true, pdf, log: 'Old result' }); assert.equal(await old, false); assert.equal(f.renders.length, 0);
    second.resolve({ ok: true, pdf, log: 'New result' }); assert.equal(await next, true);
    f.editor.setMode('preview'); assert.equal(f.editor.readingViewer, f.renders[0].viewer);
    f.controller.abort(); assert.equal(f.renders[0].context.signal.aborted, true); assert.equal(f.renders[0].viewer.disposed, true);
    assert.equal(await f.editor.compile(), false); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Saving .tex in place preserves BOM and CRLF, marks a baseline only after success, and keeps copy saving independent', async () => {
  const original = new TextEncoder().encode('\ufeffOriginal\r\nSecond\r\n'), saves = [], onSaved = [], copies = [];
  let outcome = false;
  const f = await fixture({ source: original, onSaved: (record, blob) => onSaved.push({ record, blob }), onSave: api => copies.push(api), services: {
    saveLatexSource: async (...args) => { saves.push(args); return outcome; }
  } });
  try {
    f.change('Updated\nSecond\n'); assert.equal(f.editor.dirty, true);
    assert.equal(await f.editor.save(), false); assert.equal(f.editor.dirty, true); assert.equal(onSaved.length, 0);
    outcome = true;
    f.input.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    await waitFor(() => onSaved.length === 1 && !f.editor.busy);
    assert.equal(f.editor.dirty, false); assert.deepEqual(new Uint8Array(saves[1][2]), original);
    assert.deepEqual(new Uint8Array(saves[1][1]), new TextEncoder().encode('\ufeffUpdated\r\nSecond\r\n'));
    assert.deepEqual(new Uint8Array(await f.record.blob.arrayBuffer()), new Uint8Array(saves[1][1]));
    f.root.querySelector('.latex-undo').click(); assert.equal(f.input.value, 'Original\nSecond\n'); assert.equal(f.editor.dirty, true);
    f.root.querySelector('.latex-redo').click(); assert.equal(f.editor.dirty, false);
    f.change('Unsaved copy'); await f.editor.saveCopy(); assert.equal(copies[0], f.editor); assert.equal(f.editor.dirty, true);
    assert.deepEqual(new Uint8Array(f.editor.export()), new TextEncoder().encode('\ufeffUnsaved copy'));
  } finally { await f.close(); }
});

test('Auto compilation requires opt in and trust, debounces to the latest text, and stops when unchecked', async () => {
  const f = await fixture({ autoCompileDelay: 15 });
  try {
    f.change('Before opt in'); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.calls.length, 0);
    f.trust(); const auto = f.root.querySelector('.latex-auto'); auto.checked = true; auto.dispatchEvent(new f.w.Event('change'));
    f.change('First'); f.change('Latest');
    await waitFor(() => f.calls.length === 1 && !f.editor.compiling);
    assert.equal(f.calls[0].request.source, 'Latest');
    auto.checked = false; auto.dispatchEvent(new f.w.Event('change')); f.change('No more builds');
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('A missing compiler leaves source editing and saving available and shows setup instructions', async () => {
  const f = await fixture({ services: { getLatexStatus: async () => ({ available: false, message: 'Tectonic not found.' }) } });
  try {
    f.trust(); f.change('Can still edit'); assert.equal(f.input.readOnly, false);
    assert.equal(f.root.querySelector('.latex-compile').disabled, true); assert.equal(f.root.querySelector('.latex-auto').disabled, true);
    assert.match(f.root.querySelector('.latex-status').textContent, /npm run latex:setup/);
    assert.equal(await f.editor.save(), true); assert.equal(f.editor.dirty, false); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('A broken new PDF renderer cannot replace the last successful preview', async () => {
  const rendered = [];
  const f = await fixture({ renderPdf: async (file, stage, context) => {
    rendered.push(context);
    if (rendered.length > 1) throw new Error('Invalid PDF');
    stage.textContent = 'Good PDF'; return { setZoom: async () => {} };
  } });
  try {
    f.trust(); assert.equal(await f.editor.compile(), true); const good = f.root.querySelector('.latex-pdf-viewer');
    f.change('A changed document'); assert.equal(await f.editor.compile(), false);
    assert.equal(f.root.querySelector('.latex-pdf-viewer'), good); assert.equal(good.textContent, 'Good PDF');
    assert.equal(rendered[0].signal.aborted, false); assert.equal(rendered[1].signal.aborted, true);
    assert.equal(f.errors[0].message, 'Invalid PDF');
  } finally { await f.close(); }
});

test('A selected project folder supplies binary companion snapshots while preserving the main editor draft', async () => {
  const f = await fixture({ source: 'Draft main file' });
  try {
    f.trust(); assert.equal(await f.editor.compile(), true);
    const selected = [
      ['project/sample.tex', 'A stale disk version'], ['project/chapters/intro.tex', 'Chapter text'],
      ['project/figures/chart.png', new Uint8Array([137, 80, 78, 71])], ['project/sample.pdf', 'Old generated output']
    ].map(([path, contents]) => {
      const file = new File([contents], path.split('/').at(-1));
      Object.defineProperty(file, 'webkitRelativePath', { value: path }); return file;
    });
    const field = f.root.querySelector('.latex-files-input');
    Object.defineProperty(field, 'files', { configurable: true, value: selected }); field.dispatchEvent(new f.w.Event('change'));
    await waitFor(() => f.root.querySelector('.latex-files').textContent.endsWith('· 2'));
    assert.equal(f.input.value, 'Draft main file'); assert.equal(f.root.querySelector('.latex-stale').hidden, false);
    assert.equal(await f.editor.compile(), true);
    const request = f.calls.at(-1).request;
    assert.equal(request.source, 'Draft main file');
    assert.deepEqual(request.files.map(file => file.path), ['chapters/intro.tex', 'figures/chart.png']);
    assert.equal(new TextDecoder().decode(request.files[0].bytes), 'Chapter text');
    assert.deepEqual(request.files[1].bytes, new Uint8Array([137, 80, 78, 71]));
    assert.equal(f.root.querySelector('.latex-stale').hidden, true); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Automatic edits during a running build queue one later build instead of starting concurrent TeX processes', async () => {
  const first = pending(), attempts = [];
  const f = await fixture({ autoCompileDelay: 5, services: {
    compileLatex: (request, options) => {
      attempts.push({ request, options });
      return attempts.length === 1 ? first.promise : { ok: true, pdf, diagnostics: [] };
    }
  } });
  try {
    f.trust(); const auto = f.root.querySelector('.latex-auto'); auto.checked = true; auto.dispatchEvent(new f.w.Event('change'));
    await waitFor(() => attempts.length === 1); f.change('Updated while TeX was busy');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(attempts.length, 1); assert.equal(attempts[0].options.signal.aborted, false);
    assert.equal(await f.editor.compile(), false);
    first.resolve({ ok: true, pdf, diagnostics: [] });
    await waitFor(() => attempts.length === 2 && !f.editor.compiling);
    assert.equal(attempts[1].request.source, 'Updated while TeX was busy');
    assert.notEqual(attempts[0].request.id, attempts[1].request.id); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
