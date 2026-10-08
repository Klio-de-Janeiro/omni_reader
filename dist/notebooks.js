import { decodeMarkup } from './markup.js';
import { bindZoomGestures, createVisualZoom } from './gestures.js';
import { editingShortcut } from './shortcuts.js';
import { History } from './editors/history.js';
import { makeNode, openTextEditor, parseJson, renderText, textNavigation } from './text-files.js';
import { colorCode, colorInput } from './syntax.js';
import { documentMarkup } from './document-images.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const cellText = source => Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : '';
const multiline = value => typeof value === 'string' || Array.isArray(value) && value.every(part => typeof part === 'string');
const stripAnsi = source => source.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');

/** Accept notebook v4, retaining every unknown field and saved output unchanged. */
export function parseNotebook(source) {
  const notebook = parseJson(source);
  if (!object(notebook) || notebook.nbformat !== 4 || !Number.isInteger(notebook.nbformat_minor) || notebook.nbformat_minor < 0 || !Array.isArray(notebook.cells) || !object(notebook.metadata)) {
    throw new Error('Нужен ноутбук IPYNB версии 4 с cells, metadata и nbformat_minor.');
  }
  if (notebook.cells.length > 10000) throw new Error('Ноутбук содержит более 10 000 ячеек.');
  for (const [index, cell] of notebook.cells.entries()) {
    if (!object(cell) || typeof cell.cell_type !== 'string' || !multiline(cell.source) || !object(cell.metadata)) {
      throw new Error(`Повреждена ячейка ${index + 1}: проверьте source, cell_type и metadata.`);
    }
    if (cell.cell_type === 'code' && (!Array.isArray(cell.outputs) || !(cell.execution_count === null || Number.isInteger(cell.execution_count)))) {
      throw new Error(`Повреждён вывод кодовой ячейки ${index + 1}.`);
    }
  }
  return notebook;
}

function imageData(bundle) {
  if (!object(bundle)) return null;
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    if (!multiline(bundle[mime])) continue;
    const data = cellText(bundle[mime]).replace(/\s/g, '');
    if (data && /^[A-Za-z0-9+/]*={0,2}$/.test(data)) return `data:${mime};base64,${data}`;
  }
  return null;
}

function attachedMarkdown(cell) {
  return cellText(cell.source).replace(/(!\[[^\]]*\]\(\s*)attachment:([^\s)"<>]+)(?=[\s)])/g, (match, prefix, name) => {
    let decoded; try { decoded = decodeURIComponent(name); } catch { decoded = name; }
    const image = imageData(cell.attachments?.[decoded]); return image ? prefix + image : match;
  });
}

function renderOutputs(cell, document, renderMarkup) {
  const outputs = makeNode(document, 'div', 'notebook-outputs');
  for (const output of cell.outputs || []) {
    if (!object(output)) continue;
    const content = makeNode(document, 'div', 'notebook-output');
    if (output.output_type === 'stream') content.append(makeNode(document, 'pre', 'source-preview', stripAnsi(cellText(output.text))));
    else if (output.output_type === 'error') content.append(makeNode(document, 'pre', 'source-preview notebook-error', stripAnsi(Array.isArray(output.traceback) ? output.traceback.join('\n') : `${output.ename || 'Ошибка'}: ${output.evalue || ''}`)));
    else if (object(output.data)) {
      const image = imageData(output.data);
      if (image) {
        const img = makeNode(document, 'img', 'notebook-image'); img.src = image; img.alt = 'Сохранённый результат ячейки'; content.append(img);
      } else if (multiline(output.data['text/markdown']) || multiline(output.data['text/html'])) {
        const article = makeNode(document, 'div', 'markdown-document');
        article.append(renderMarkup(cellText(output.data['text/markdown'] ?? output.data['text/html']), 'md', document.defaultView)); content.append(article);
      } else if (Object.hasOwn(output.data, 'application/json')) {
        content.append(makeNode(document, 'pre', 'source-preview', JSON.stringify(output.data['application/json'], null, 2)));
      } else if (multiline(output.data['text/plain'])) content.append(makeNode(document, 'pre', 'source-preview', stripAnsi(cellText(output.data['text/plain']))));
      else content.append(makeNode(document, 'p', 'notebook-caption', 'Этот сохранённый вывод доступен в Jupyter.'));
    } else content.append(makeNode(document, 'p', 'notebook-caption', 'Этот сохранённый вывод доступен в Jupyter.'));
    outputs.append(content);
  }
  return outputs;
}

const notebookLanguage=book=>book.metadata?.language_info?.name || book.metadata?.kernelspec?.language || (String(book.metadata?.kernelspec?.name).includes('python')?'python':'text');
function cellContent(cell, document, renderMarkup, language='text') {
  const content = makeNode(document, 'div', 'notebook-content');
  if (cell.cell_type === 'markdown') {
    const markdown = makeNode(document, 'div', 'markdown-document');
    markdown.append(renderMarkup(attachedMarkdown(cell), 'md', document.defaultView)); content.append(markdown);
  } else {const pre=makeNode(document,'pre','source-preview'),code=makeNode(document,'code');colorCode(code,cellText(cell.source),cell.cell_type==='code'?language:'text');pre.append(code);content.append(pre);}
  return content;
}
const cellLabel = (cell, index) => `${index + 1} · ${cell.cell_type === 'markdown' ? 'Markdown' : cell.cell_type === 'raw' ? 'Текст' : cell.cell_type === 'code' ? `Код [${cell.execution_count ?? ' '}]` : cell.cell_type}`;

export function renderNotebook(notebook, document, renderMarkup) {
  const fragment = document.createDocumentFragment();
  fragment.append(makeNode(document, 'p', 'notebook-caption notebook-intro', 'Ячейки и сохранённые результаты. Выполнение кода доступно в Jupyter.'));
  for (const [index, cell] of notebook.cells.entries()) {
    const section = makeNode(document, 'section', 'notebook-cell');
    section.dataset.cellId=cell.id || 'cell-'+index;
    section.append(makeNode(document, 'div', 'notebook-cell-heading', cellLabel(cell, index)), cellContent(cell, document, renderMarkup,notebookLanguage(notebook)));
    if (cell.cell_type === 'code' && cell.outputs.length) section.append(renderOutputs(cell, document, renderMarkup));
    fragment.append(section);
  }
  if (!notebook.cells.length) fragment.append(makeNode(document, 'p', 'notebook-caption', 'Ячеек пока нет. Добавьте их в редакторе.'));
  return fragment;
}

function notebookPreview(source, document, renderMarkup) {
  try { return renderNotebook(parseNotebook(source), document, renderMarkup); }
  catch (error) {
    const fragment = document.createDocumentFragment();
    fragment.append(makeNode(document, 'p', 'source-notice', `${error.message} Можно исправить исходный JSON в редакторе.`), renderText(source, 'txt', document));
    return fragment;
  }
}

export async function openNotebook(file, root, context) {
  const [{ renderMarkup: engine }, bytes] = await Promise.all([import('./vendor/markdown.js'), file.arrayBuffer()]);
  const renderMarkup = documentMarkup(engine, context.imageRecord, context.signal);
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const document = root.ownerDocument, article = makeNode(document, 'article', 'notebook-document');
  article.append(notebookPreview(decodeMarkup(bytes), document, renderMarkup)); root.replaceChildren(article);
  const visual = createVisualZoom(root, article, { signal: context.signal });
  return {
    ...textNavigation(article),
    setZoom: visual.setZoom
  };
}

/** Edit code/Markdown/raw cells in place without rebuilding or executing their outputs. */
export async function openNotebookEditor(record, root, options) {
  const { signal, onSave, onClose, onError, onDirty, initialZoom = 1 } = options;
  const [{ renderMarkup: engine }, bytes] = await Promise.all([import('./vendor/markdown.js'), record.blob.arrayBuffer()]);
  const renderMarkup = documentMarkup(engine, record, signal);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const original = decodeMarkup(bytes), document = root.ownerDocument;
  let notebook;
  try { notebook = parseNotebook(original); }
  catch {
    return openTextEditor(record, root, options, {
      articleClass: 'notebook-document', validate: parseNotebook,
      render: text => notebookPreview(text, document, renderMarkup)
    });
  }
  const node = (tag, cls, text) => makeNode(document, tag, cls, text);
  const button = text => { const b = node('button', '', text); b.type = 'button'; return b; };
  const panel = node('div', 'editor-panel notebook-editor'), bar = node('div', 'editor-bar');
  const undo = button('Отменить'), redo = button('Повторить'), preview = button('Просмотр'), save = button('Сохранить копию'), close = button('К просмотру');
  save.className = 'primary'; bar.append(undo, redo, preview, save, close);
  const canvas = node('div', 'notebook-edit-canvas'), article = node('article', 'notebook-document');
  const cells = node('div', 'notebook-cells'), addBar = node('div', 'notebook-add');
  const addCode = button('+ Код'), addMarkdown = button('+ Markdown'), addRaw = button('+ Текст');
  addBar.append(addCode, addMarkdown, addRaw);
  article.append(node('p', 'notebook-caption notebook-intro', 'Редактируйте ячейки на странице. Сохранённые результаты и метаданные остаются в файле; код здесь не выполняется.'), cells, addBar);
  canvas.append(article); panel.append(bar, canvas); root.replaceChildren(panel);
  const history = new History(), views = new WeakMap(), inputColors=new WeakMap(),allColors=new Set(),originals = new WeakMap(notebook.cells.map(cell => [cell, cellText(cell.source)]));
  let sourceMode = true, busy = false, disposed = false, zoom = initialZoom, api, sequence = 0,lastInput;
  const guarded = action => async () => { if (busy || disposed) return; try { await action(); } catch (error) { onError?.(error); } };
  function resize(input) {
    input.style.height = 'auto'; input.style.height = `${Math.max(72, input.scrollHeight + 4)}px`;
    inputColors.get(input)?.refresh();
  }
  function update() {
    if (disposed) return;
    undo.disabled = busy || !history.done.length; redo.disabled = busy || !history.future.length;
    save.disabled = busy || !history.dirty; preview.disabled = close.disabled = busy;
    preview.textContent = sourceMode ? 'Просмотр' : 'Редактировать'; addBar.hidden = !sourceMode;
    for (const b of [addCode, addMarkdown, addRaw]) b.disabled = busy || notebook.cells.length >= 10000;
    for (const [index, cell] of notebook.cells.entries()) {
      const view = views.get(cell); if (!view) continue;
      view.label.textContent = cellLabel(cell, index); view.input.hidden = view.colors.wrap.hidden = !sourceMode; view.content.hidden = sourceMode;
      view.input.readOnly = busy || cell.metadata.editable === false;
      view.remove.hidden = !sourceMode; view.remove.disabled = busy || cell.metadata.deletable === false || cell.metadata.editable === false;
      view.stale.hidden = cell.cell_type !== 'code' || !cell.outputs.length || cellText(cell.source) === originals.get(cell);
    }
    onDirty?.(history.dirty);
  }
  function createCellView(cell) {
    const section = node('section', 'notebook-cell'), heading = node('div', 'notebook-cell-heading');
    const label = node('span', '', ''), remove = button('Удалить ячейку');
    remove.setAttribute('aria-label', 'Удалить ячейку'); heading.append(label, remove);
    const input = node('textarea', 'notebook-source'); input.value = cellText(cell.source).replace(/\r\n?/g, '\n');
    input.spellcheck = false; input.autocomplete = 'off'; input.maxLength = 8 * 1024 * 1024;
    input.setAttribute('aria-label', `Исходный текст ячейки ${cell.cell_type}`);
    input.addEventListener('focus',()=>{lastInput=input;});
    const content = cellContent(cell, document, renderMarkup,notebookLanguage(notebook)); content.hidden = true;
    const stale = node('p', 'notebook-caption notebook-stale', 'Код изменён. Ниже показан результат предыдущего выполнения.'); stale.hidden = true;
    section.append(heading, input, content, stale);
    if (cell.cell_type === 'code' && cell.outputs.length) section.append(renderOutputs(cell, document, renderMarkup));
    const colors=colorInput(input,cell.cell_type==='markdown'?'markdown':cell.cell_type==='code'?notebookLanguage(notebook):'text',{signal});
    inputColors.set(input,colors);allColors.add(colors);
    const view = { section, label, remove, input, content, stale, colors, key: `cell-${sequence++}` }; views.set(cell, view);section.dataset.cellId=cell.id || view.key;
    let selection = { start: 0, end: 0 };
    input.addEventListener('beforeinput', () => { selection = { start: input.selectionStart, end: input.selectionEnd }; });
    function commit() {
      if (busy || disposed || cell.metadata.editable === false) return;
      const text = input.value, before = cell.source, previousSelection = { ...selection }, after = { start: input.selectionStart, end: input.selectionEnd };
      if (text === cellText(before).replace(/\r\n?/g, '\n')) return;
      const next = Array.isArray(before) ? text.match(/[^\n]*\n|[^\n]+$/g) || [] : text;
      const apply = (source, position) => {
        cell.source = source; input.value = cellText(source).replace(/\r\n?/g, '\n');
        input.setSelectionRange(position.start, position.end); resize(input);
        if (!sourceMode) { const fresh = cellContent(cell, document, renderMarkup,notebookLanguage(notebook)); view.content.replaceChildren(...fresh.childNodes); }
      };
      history.execute(() => apply(next, after), () => apply(before, previousSelection), view.key); selection = after;
    }
    input.addEventListener('input', commit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !input.readOnly) {
        event.preventDefault(); selection = { start: input.selectionStart, end: input.selectionEnd };
        input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end'); commit();
      }
    });
    remove.onclick = guarded(() => {
      if (cell.metadata.deletable === false || cell.metadata.editable === false) return;
      const index = notebook.cells.indexOf(cell);
      history.execute(() => { notebook.cells.splice(index, 1); section.remove(); }, () => { notebook.cells.splice(index, 0, cell); cells.insertBefore(section, cells.children[index] || null); });
    });
    return section;
  }
  for (const cell of notebook.cells) cells.append(createCellView(cell));
  function addCell(type) {
    const cell = { cell_type: type, metadata: {}, source: [] };
    if (notebook.nbformat_minor >= 5) {
      do { cell.id = document.defaultView.crypto.randomUUID(); } while (notebook.cells.some(item => item.id === cell.id));
    }
    if (type === 'code') { cell.execution_count = null; cell.outputs = []; }
    const section = createCellView(cell), index = notebook.cells.length;
    history.execute(() => { notebook.cells.splice(index, 0, cell); cells.insertBefore(section, cells.children[index] || null); }, () => { notebook.cells.splice(index, 1); section.remove(); });
    resize(views.get(cell).input); views.get(cell).input.focus();
  }
  function toggleView() {
    if (busy || disposed) return;
    if (sourceMode) for (const cell of notebook.cells) {
      const view = views.get(cell), fresh = cellContent(cell, document, renderMarkup,notebookLanguage(notebook)); view.content.replaceChildren(...fresh.childNodes);
    }
    sourceMode = !sourceMode; update();
    if (sourceMode) {for (const cell of notebook.cells) resize(views.get(cell).input);const input=lastInput?.isConnected?lastInput:views.get(notebook.cells[0])?.input;input?.focus({preventScroll:true});}
  }
  function setZoom(value, point) {
    if (disposed) return;
    zoom = Math.max(0.5, Math.min(3, value));visual.setZoom(zoom,point);
  }
  api = {
    get dirty() { return history.dirty; }, get busy() { return busy; }, get sourceMode() { return sourceMode; },
    get position() { return { zoom }; },
    export() { const text = JSON.stringify(notebook, null, 2) + '\n'; parseNotebook(text); return new TextEncoder().encode(text).buffer; },
    toggleView, setBusy(value) { busy = !!value; update(); },
    adjustZoom: delta => setZoom(delta === null ? 1 : zoom + delta),
    dispose() { if (disposed) return; disposed = true; gestures.dispose();for(const colors of allColors)colors.dispose();allColors.clear(); }
  };
  const visual=createVisualZoom(canvas,article,{signal});
  const gestures = bindZoomGestures(canvas, { signal, getZoom: () => zoom, setZoom, onError });
  history.onChange = update;
  undo.onclick = guarded(() => history.undo()); redo.onclick = guarded(() => history.redo());
  preview.onclick = toggleView; save.onclick = guarded(() => onSave(api)); close.onclick = guarded(onClose);
  addCode.onclick = guarded(() => addCell('code')); addMarkdown.onclick = guarded(() => addCell('markdown')); addRaw.onclick = guarded(() => addCell('raw'));
  panel.addEventListener('keydown', event => {
    const action = editingShortcut(event); if (action) { event.preventDefault(); ({ save, undo, redo })[action].click(); }
  });
  signal.addEventListener('abort', () => api.dispose(), { once: true });
  setZoom(zoom); update(); notebook.cells.length && views.get(notebook.cells[0]).input.focus({ preventScroll: true });
  return api;
}
