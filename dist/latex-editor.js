import { textCodec, makeNode } from './text-files.js';
import { colorInput } from './syntax.js';
import { History } from './editors/history.js';
import { editingShortcut } from './shortcuts.js';
import { openViewer } from './viewers.js';
import { getLatexStatus, compileLatex, cancelLatex, saveLatexSource, downloadLatexPdf } from './latex-client.js';

const pdfName = name => name.replace(/\.tex$/i, '') + '.pdf';
const cancelled = error => error?.name === 'AbortError';
const bytesOf = data => data instanceof Uint8Array ? data : new Uint8Array(data);

/** A real source editor and a retained, separately cancellable PDF preview. */
export async function openLatexEditor(record, root, options = {}) {
  if (record.blob.size > 8 * 1024 * 1024) throw new Error('Редактор LaTeX поддерживает исходники до 8 МиБ. Уменьшите файл .tex или разделите его на части.');
  const originalBytes = await record.blob.arrayBuffer();
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const document = root.ownerDocument, window = document.defaultView;
  const lifecycle = new window.AbortController(), signal = lifecycle.signal;
  const services = { getLatexStatus, compileLatex, cancelLatex, saveLatexSource, downloadLatexPdf, ...options.services };
  const renderPdf = options.renderPdf || openViewer;
  const codec = textCodec(originalBytes);
  const node = (tag, cls, text) => makeNode(document, tag, cls, text);
  const button = (name, text, title) => {
    const result = node('button', 'latex-' + name, text);
    result.type = 'button'; if (title) result.title = title; return result;
  };
  const panel = node('section', 'editor-panel latex-editor');
  panel.setAttribute('aria-label', 'Редактор LaTeX'); panel.dataset.mode = 'split';
  const toolbar = node('div', 'latex-toolbar');
  toolbar.setAttribute('role', 'group'); toolbar.setAttribute('aria-label', 'LaTeX: компиляция и сохранение');
  const compileButton = button('compile', 'Компилировать', 'Скомпилировать текущий текст — Ctrl+Enter');
  compileButton.classList.add('primary');
  const cancelButton = button('cancel', 'Остановить', 'Отменить компиляцию'); cancelButton.hidden = true;
  const autoLabel = node('label', 'latex-auto-label');
  const autoInput = node('input', 'latex-auto'); autoInput.type = 'checkbox';
  autoLabel.append(autoInput, document.createTextNode('Автокомпиляция'));
  const modeGroup = node('div', 'latex-mode-group');
  modeGroup.setAttribute('role', 'group'); modeGroup.setAttribute('aria-label', 'Расположение редактора');
  const modeButtons = new Map([
    ['source', button('mode-source', '.tex', 'Показывать только исходный текст')],
    ['split', button('mode-split', '.tex | PDF', 'Исходный текст слева, PDF справа')],
    ['preview', button('mode-preview', 'PDF', 'Показывать только скомпилированный PDF')]
  ]);
  modeGroup.append(...modeButtons.values());
  const undoButton = button('undo', '↶', 'Отменить правку'); undoButton.setAttribute('aria-label', 'Отменить правку');
  const redoButton = button('redo', '↷', 'Повторить правку'); redoButton.setAttribute('aria-label', 'Повторить правку');
  const saveButton = button('save', 'Сохранить .tex', 'Сохранить исходный файл — Ctrl+S');
  const copyButton = button('save-copy', 'Копия .tex', 'Сохранить исходный текст как новый файл');
  const exportButton = button('export', 'Скачать PDF', 'Скачать последнюю успешную сборку');
  const filesButton = button('files', 'Файлы проекта', 'Выбрать папку с дополнительными .tex, изображениями, стилями и библиографией');
  const filesInput = node('input', 'latex-files-input'); filesInput.type = 'file'; filesInput.multiple = true;
  filesInput.setAttribute('webkitdirectory', ''); filesInput.hidden = true;
  toolbar.append(compileButton, cancelButton, autoLabel, modeGroup, undoButton, redoButton, saveButton, copyButton, filesButton, filesInput, exportButton);

  const trustRow = node('div', 'latex-trust-row');
  const trustLabel = node('label', 'latex-trust-label'), trustInput = node('input', 'latex-trust'); trustInput.type = 'checkbox';
  trustLabel.append(trustInput, document.createTextNode('Доверяю этому TeX-проекту'));
  const trustNote = node('span', 'latex-trust-note', 'Локальный LaTeX может читать файлы компьютера. Компилируйте только доверенные документы.');
  trustRow.append(trustLabel, trustNote);
  const statusRow = node('div', 'latex-status-row');
  const status = node('span', 'latex-status', 'Проверка компилятора…'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const stale = node('span', 'latex-stale', 'PDF устарел — скомпилируйте изменения'); stale.hidden = true;
  const cursor = node('span', 'latex-cursor', 'Строка 1, столбец 1');
  statusRow.append(status, stale, cursor);

  const workspace = node('div', 'latex-workspace');
  workspace.style.setProperty('--latex-source-ratio', '50%');
  const sourcePane = node('section', 'latex-source-pane'), sourceHeader = node('div', 'latex-pane-heading', record.name);
  sourceHeader.title = record.name;
  const input = node('textarea', 'latex-source'); input.value = codec.text;
  input.spellcheck = false; input.autocomplete = 'off'; input.autocapitalize = 'off'; input.wrap = 'off';
  input.maxLength = 8 * 1024 * 1024;
  input.setAttribute('aria-label', 'Исходный текст LaTeX');
  sourcePane.append(sourceHeader, input);
  const colors = colorInput(input, 'tex', { signal });
  const separator = node('div', 'latex-separator');
  separator.tabIndex = 0; separator.setAttribute('role', 'separator'); separator.setAttribute('aria-label', 'Ширина исходного текста');
  separator.setAttribute('aria-orientation', 'vertical'); separator.setAttribute('aria-valuemin', '20'); separator.setAttribute('aria-valuemax', '80');
  const previewPane = node('section', 'latex-preview-pane'), previewHeader = node('div', 'latex-pane-heading', 'Скомпилированный PDF');
  const previewFrame = node('div', 'latex-preview-frame');
  const placeholder = node('div', 'latex-placeholder');
  placeholder.append(node('strong', '', 'Здесь появится PDF'), node('p', '', 'Нажмите «Компилировать» или Ctrl+Enter. Исходный текст можно редактировать во время сборки.'));
  previewFrame.append(placeholder); previewPane.append(previewHeader, previewFrame); workspace.append(sourcePane, separator, previewPane);

  const diagnosticsPanel = node('details', 'latex-diagnostics');
  const diagnosticsSummary = node('summary', '', 'Журнал компиляции');
  const diagnosticsList = node('ul', 'latex-diagnostic-list');
  const log = node('pre', 'latex-log'); log.tabIndex = 0; log.setAttribute('aria-label', 'Журнал компиляции LaTeX');
  diagnosticsPanel.append(diagnosticsSummary, diagnosticsList, log); diagnosticsPanel.hidden = true;
  panel.append(toolbar, trustRow, statusRow, workspace, diagnosticsPanel); root.replaceChildren(panel);

  let baseline = codec.text, expectedBytes = originalBytes, draft = codec.text, disposed = false, busy = false;
  let mode = 'split', ratio = 50, zoom = options.initialZoom || 1, compiler = null, available = false, compiling = false;
  let compiledSource = null, lastPdf = null, previewViewer = null, previewController = null, pendingPreview = null, previewPage = 1;
  let compilationRevision = 0, autoTimer = 0, currentCompile = null, selection = { start: 0, end: 0 }, api;
  let projectFiles = options.files || record.latexFiles || [], projectRevision = 0, compiledProjectRevision = null, loadingFiles = false;
  let finishingCompile = null, autoPending = false;
  const sessionId = 'latex-' + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2));
  const history = new History();
  const report = error => { if (!disposed && !cancelled(error)) options.onError?.(error); };
  const guard = action => () => { if (!disposed) Promise.resolve().then(action).catch(report); };
  const setStatus = message => { if (!disposed) status.textContent = message; };
  function updateCursor() {
    const before = input.value.slice(0, input.selectionStart), lines = before.split('\n');
    cursor.textContent = `Строка ${lines.length}, столбец ${lines.at(-1).length + 1}`;
  }
  function update() {
    if (disposed) return;
    compileButton.disabled = !available || !trustInput.checked || compiling || busy;
    cancelButton.hidden = !compiling; autoInput.disabled = !available || !trustInput.checked;
    input.readOnly = busy;
    undoButton.disabled = busy || !history.done.length; redoButton.disabled = busy || !history.future.length;
    saveButton.disabled = busy || input.value === baseline; copyButton.disabled = busy;
    filesButton.disabled = loadingFiles || busy;
    filesButton.textContent = 'Файлы проекта' + (projectFiles.length ? ` · ${projectFiles.length}` : '');
    exportButton.disabled = !lastPdf; stale.hidden = compiledSource === null || input.value === compiledSource && projectRevision === compiledProjectRevision;
    sourceHeader.textContent = record.name + (input.value !== baseline ? ' •' : '');
    sourceHeader.title = record.name + (input.value !== baseline ? ' — несохранённые изменения' : '');
    panel.dataset.compiling = String(compiling); panel.dataset.dirty = String(input.value !== baseline);
    options.onDirty?.(input.value !== baseline); colors.refresh(); updateCursor();
  }
  function layoutChanged() {
    window.dispatchEvent(new window.Event('omni-layout-change'));
    if (mode !== 'source') Promise.resolve(previewViewer?.setZoom?.(zoom)).catch(report);
    colors.refresh();
  }
  function setMode(value) {
    if (disposed || !modeButtons.has(value)) return;
    mode = value; panel.dataset.mode = mode;
    sourcePane.hidden = mode === 'preview'; previewPane.hidden = mode === 'source'; separator.hidden = mode !== 'split';
    for (const [key, item] of modeButtons) item.setAttribute('aria-pressed', String(key === mode));
    layoutChanged(); options.onModeChange?.(mode);
  }
  function setRatio(value) {
    ratio = Math.max(20, Math.min(80, value)); workspace.style.setProperty('--latex-source-ratio', ratio + '%');
    separator.setAttribute('aria-valuenow', String(Math.round(ratio)));
    separator.setAttribute('aria-valuetext', `Исходный текст: ${Math.round(ratio)}%, PDF: ${Math.round(100 - ratio)}%`);
    layoutChanged();
  }
  function scheduleCompile() {
    clearTimeout(autoTimer);
    if (!autoInput.checked || !available || !trustInput.checked || disposed) return;
    autoTimer = setTimeout(() => {
      if (disposed) return;
      if (compiling) autoPending = true;
      else void compile().catch(report);
    }, options.autoCompileDelay ?? 1000);
  }
  function commit() {
    const next = input.value, previous = draft, before = { ...selection };
    const after = { start: input.selectionStart, end: input.selectionEnd };
    if (next === previous) { update(); return; }
    const apply = (value, caret) => {
      draft = value; input.value = value; input.setSelectionRange(caret.start, caret.end); selection = caret;
    };
    history.execute(() => apply(next, after), () => apply(previous, before), 'latex-input');
  }
  function goToLine(value) {
    const line = Math.max(1, Math.trunc(Number(value) || 1)), lines = input.value.split('\n');
    const offset = lines.slice(0, Math.min(line - 1, lines.length - 1)).reduce((sum, item) => sum + item.length + 1, 0);
    if (mode === 'preview') setMode('split');
    input.focus({ preventScroll: true }); input.setSelectionRange(offset, offset);
    const font = window.getComputedStyle(input), height = parseFloat(font.lineHeight) || 26;
    input.scrollTop = Math.max(0, (line - 3) * height); input.dispatchEvent(new window.Event('scroll'));
    selection = { start: offset, end: offset }; updateCursor();
  }
  function displayDiagnostics(result) {
    const items = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    diagnosticsList.replaceChildren();
    for (const item of items) {
      const li = node('li', 'latex-diagnostic ' + (item.severity === 'warning' ? 'warning' : 'error'));
      const message = item.message || String(item);
      if (Number(item.line) > 0) {
        const link = button('diagnostic-link', `Строка ${item.line}: ${message}`);
        link.onclick = () => goToLine(item.line); li.append(link);
      } else li.textContent = message;
      diagnosticsList.append(li);
    }
    log.textContent = result.log || '';
    diagnosticsPanel.hidden = !log.textContent && !items.length;
    diagnosticsSummary.textContent = `Журнал компиляции${items.length ? ` · ${items.length} сообщений` : ''}`;
    diagnosticsPanel.open = !result.ok;
  }
  function stopCompile(showStatus = true) {
    clearTimeout(autoTimer); autoPending = false; compilationRevision++;
    const active = currentCompile; currentCompile = null; compiler?.abort(); compiler = null;
    pendingPreview?.abort(); pendingPreview = null; compiling = false;
    if (active) { try { Promise.resolve(services.cancelLatex(active)).catch(() => {}); } catch {} }
    if (showStatus) setStatus('Компиляция отменена. Исходный текст сохранён в редакторе.');
    update();
  }
  async function mountPdf(pdf, revision) {
    const controller = new AbortController(); pendingPreview = controller;
    const previousPage = Number(previewFrame.querySelector('.latex-pdf-viewer:not(.latex-pdf-staging)')?.dataset.page) || previewPage;
    const stage = node('div', 'latex-pdf-viewer latex-pdf-staging');
    stage.setAttribute('aria-label', 'Скомпилированный документ PDF'); stage.setAttribute('aria-hidden', 'true');
    previewFrame.append(stage);
    try {
      const file = new File([pdf], pdfName(record.name), { type: 'application/pdf' });
      let page = 1;
      const viewer = await renderPdf(file, stage, {
        ext: 'pdf', signal: controller.signal, viewMode: 'scroll',
        onWarning: report, onZoom: value => { zoom = value; }, onPage: value => { page = value; stage.dataset.page = String(value); if (previewController === controller) previewPage = value; },
        onPages: count => { stage.dataset.pages = String(count); }, onShellShortcut: options.onShellShortcut
      });
      if (disposed || revision !== compilationRevision || controller.signal.aborted) {
        controller.abort(); viewer?.dispose?.(); return false;
      }
      await viewer?.setZoom?.(zoom);
      // A new build can have fewer pages; preserve the old page only when it exists.
      if (previousPage > 1 && viewer?.setPage) await viewer.setPage(Math.min(previousPage, Number(stage.dataset.pages) || previousPage));
      if (disposed || revision !== compilationRevision || controller.signal.aborted) { controller.abort(); viewer?.dispose?.(); return false; }
      previewController?.abort(); previewViewer?.dispose?.();
      previewController = controller; previewViewer = viewer;
      previewPage = page; stage.dataset.page = String(page); stage.classList.remove('latex-pdf-staging'); stage.removeAttribute('aria-hidden');
      for (const child of [...previewFrame.children]) if (child !== stage) child.remove();
      pendingPreview = null; return true;
    } catch (error) {
      controller.abort(); stage.remove(); throw error;
    } finally {
      if (pendingPreview === controller) pendingPreview = null;
      if (controller.signal.aborted) stage.remove();
    }
  }
  async function runCompile() {
    if (disposed || busy || compiling) return false;
    if (!trustInput.checked) { setStatus('Для компиляции подтвердите доверие к TeX-проекту.'); return false; }
    if (!available) { setStatus('Компилятор недоступен. Выполните npm run latex:setup и перезапустите Omni.'); return false; }
    clearTimeout(autoTimer);
    const snapshot = input.value, filesSnapshot = projectFiles, filesRevision = projectRevision;
    const revision = ++compilationRevision, controller = new AbortController();
    compiler = controller; compiling = true; currentCompile = sessionId + '-' + revision;
    setStatus('Компиляция… Можно редактировать. Первая сборка может занять несколько минут.'); update();
    try {
      const result = await services.compileLatex({
        id: currentCompile, name: record.name, source: snapshot, nativeUrl: record.nativeUrl,
        files: filesSnapshot, trusted: true
      }, { signal: controller.signal });
      if (disposed || revision !== compilationRevision || controller.signal.aborted) return false;
      displayDiagnostics(result);
      if (!result.ok || !result.pdf?.byteLength) {
        setStatus('Ошибка компиляции. Исправьте исходный текст; последняя успешная версия PDF остаётся справа.'); return false;
      }
      const pdf = bytesOf(result.pdf).slice();
      if (!await mountPdf(pdf, revision)) return false;
      lastPdf = pdf; compiledSource = snapshot; compiledProjectRevision = filesRevision;
      setStatus(`PDF готов${result.engine ? ` · ${result.engine}` : ''}`); return true;
    } catch (error) {
      if (disposed || revision !== compilationRevision) return false;
      if (cancelled(error)) setStatus('Компиляция отменена.');
      else { setStatus(error.message || 'Не удалось скомпилировать документ.'); report(error); }
      return false;
    } finally {
      if (!disposed && revision === compilationRevision) {
        compiler = null; currentCompile = null; compiling = false; update();
        if (autoPending && (input.value !== snapshot || projectRevision !== filesRevision)) scheduleCompile();
        autoPending = false;
      }
    }
  }
  async function compile() {
    if (disposed || busy || compiling) return false;
    // A canceled native process still needs to exit and release its temporary files.
    if (finishingCompile) await finishingCompile;
    if (disposed || busy || compiling) return false;
    const task = runCompile(); finishingCompile = task;
    try { return await task; }
    finally { if (finishingCompile === task) finishingCompile = null; }
  }
  async function loadProjectFiles(files) {
    if (disposed || !files.length) return;
    const selected = [...files];
    const paths = selected.map(file => (file.webkitRelativePath || file.name).replaceAll('\\', '/'));
    const commonRoot = paths.every(name => name.includes('/') && name.split('/')[0] === paths[0].split('/')[0]);
    const stem = record.name.replace(/\.tex$/i, '').toLowerCase();
    const generated = new Set(['pdf', 'log', 'aux', 'xdv', 'bbl', 'blg', 'fls', 'fmt', 'out', 'toc', 'synctex.gz'].map(ext => `${stem}.${ext}`));
    const entries = selected.map((file, index) => ({ file, path: commonRoot ? paths[index].slice(paths[index].indexOf('/') + 1) : paths[index] }))
      .filter(entry => entry.path.toLowerCase() !== record.name.toLowerCase() && !generated.has(entry.path.toLowerCase()) && entry.path.split('/')[0].toLowerCase() !== 'output');
    if (entries.length > 256 || entries.reduce((sum, entry) => sum + entry.file.size, 0) > 64 * 1024 * 1024) {
      throw new Error('Выберите папку до 256 дополнительных файлов и 64 МиБ. Основной .tex берётся из редактора.');
    }
    if (new Set(entries.map(entry => entry.path.toLowerCase())).size !== entries.length) throw new Error('В выбранном проекте есть файлы с одинаковыми путями.');
    loadingFiles = true; update();
    try {
      const snapshots = [];
      for (const entry of entries) {
        const data = await entry.file.arrayBuffer();
        if (disposed) return;
        snapshots.push({ path: entry.path, bytes: new Uint8Array(data) });
      }
      projectFiles = snapshots; projectRevision++; setStatus(`Файлы проекта добавлены: ${projectFiles.length}. Основной .tex берётся из редактора.`);
      scheduleCompile();
    } finally { loadingFiles = false; update(); }
  }
  async function save() {
    if (disposed || busy) return false;
    const snapshot = input.value, data = codec.encode(snapshot);
    busy = true; update();
    try {
      if (!await services.saveLatexSource(record, data, expectedBytes)) return false;
      baseline = snapshot; expectedBytes = data;
      const blob = new Blob([data], { type: 'application/x-tex' });
      record.blob = blob; record.size = blob.size;
      setStatus('Исходный файл .tex сохранён.');
      await options.onSaved?.(record, blob); return true;
    } finally { busy = false; update(); }
  }
  async function saveCopy() {
    if (disposed || busy) return false;
    return options.onSave?.(api);
  }
  function setZoom(value) {
    zoom = Math.max(.5, Math.min(3, value)); input.style.fontSize = `${16 * zoom}px`;
    colors.refresh(); if (mode !== 'source') return previewViewer?.setZoom?.(zoom);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stopCompile(false); previewController?.abort(); previewViewer?.dispose?.();
    colors.dispose(); lifecycle.abort(); options.signal?.removeEventListener('abort', dispose);
  }
  api = {
    get dirty() { return input.value !== baseline; }, get busy() { return busy; },
    get sourceMode() { return mode !== 'preview'; }, get mode() { return mode; },
    get compiling() { return compiling; }, get readingViewer() { return mode === 'preview' ? previewViewer : null; },
    get position() { return { zoom, ratio, mode }; },
    export: () => codec.encode(input.value), save, saveCopy, compile, cancel: stopCompile,
    setMode, toggleView: () => setMode(mode === 'preview' ? 'split' : 'preview'),
    setBusy(value) { busy = !!value; update(); }, adjustZoom: delta => setZoom(delta === null ? 1 : zoom + delta),
    navigate: delta => { previewPage = Math.max(1, Math.min(Number(previewFrame.querySelector('.latex-pdf-viewer')?.dataset.pages) || Infinity, Number(previewFrame.querySelector('.latex-pdf-viewer')?.dataset.page || 1) + delta)); return previewViewer?.setPage?.(previewPage); },
    dispose
  };
  history.onChange = () => { update(); scheduleCompile(); };
  input.addEventListener('beforeinput', () => { selection = { start: input.selectionStart, end: input.selectionEnd }; }, { signal });
  input.addEventListener('input', commit, { signal });
  for (const event of ['click', 'keyup', 'select']) input.addEventListener(event, updateCursor, { signal });
  compileButton.onclick = guard(compile); cancelButton.onclick = () => stopCompile();
  saveButton.onclick = guard(save); copyButton.onclick = guard(saveCopy);
  undoButton.onclick = () => { if (!busy) history.undo(); }; redoButton.onclick = () => { if (!busy) history.redo(); };
  exportButton.onclick = guard(() => lastPdf && services.downloadLatexPdf(lastPdf.slice(), pdfName(record.name)));
  filesButton.onclick = () => filesInput.click();
  filesInput.addEventListener('change', () => { void loadProjectFiles(filesInput.files).catch(report).finally(() => { filesInput.value = ''; }); }, { signal });
  for (const [key, item] of modeButtons) item.onclick = () => setMode(key);
  autoInput.addEventListener('change', () => { if (autoInput.checked) scheduleCompile(); else clearTimeout(autoTimer); }, { signal });
  trustInput.addEventListener('change', () => {
    trustNote.hidden = trustInput.checked;
    if (!trustInput.checked) { autoInput.checked = false; stopCompile(false); }
    update();
  }, { signal });
  panel.addEventListener('keydown', event => {
    if (event.isComposing) return;
    const shortcut = editingShortcut(event);
    const compileKey = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === 'Enter';
    if (compileKey || shortcut) {
      event.preventDefault(); event.stopPropagation();
      if (compileKey) { if (!event.repeat) void compile().catch(report); }
      else if (shortcut === 'save') void save().catch(report);
      else if (!busy) history[shortcut]();
    } else if (event.key === 'Tab' && event.target === input && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !busy) {
      event.preventDefault(); selection = { start: input.selectionStart, end: input.selectionEnd };
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end'); commit();
    }
  }, { signal });
  separator.addEventListener('keydown', event => {
    const delta = { ArrowLeft: -2, ArrowRight: 2 }[event.key];
    if (delta || ['Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      setRatio(event.key === 'Home' ? 20 : event.key === 'End' ? 80 : ratio + delta * (event.shiftKey ? 5 : 1));
    }
  }, { signal });
  let dragging = false;
  separator.addEventListener('pointerdown', event => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true; separator.setPointerCapture?.(event.pointerId); event.preventDefault();
  }, { signal });
  separator.addEventListener('pointermove', event => {
    if (!dragging) return; const rect = workspace.getBoundingClientRect();
    if (rect.width > 0) setRatio((event.clientX - rect.left) / rect.width * 100);
  }, { signal });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) separator.addEventListener(event, () => { dragging = false; }, { signal });
  options.signal?.addEventListener('abort', dispose, { once: true });
  setRatio(50); setMode('split'); setZoom(zoom); update(); input.focus({ preventScroll: true });
  // Never run TeX merely because a file was opened: compilation requires trust and an explicit action.
  void Promise.resolve().then(() => services.getLatexStatus()).then(result => {
    if (disposed) return;
    available = !!result.available;
    setStatus(available ? `Компилятор готов${result.engine ? ` · ${result.engine}` : ''}. Нажмите «Компилировать».` : `${result.message || 'Компилятор LaTeX не установлен.'} Выполните npm run latex:setup и перезапустите Omni.`);
    update();
  }).catch(error => { if (!disposed) { setStatus(error.message || 'Не удалось проверить компилятор.'); update(); } });
  return api;
}
