import { captureZoomAnchor, bindZoomGestures } from './gestures.js';
import { editingShortcut } from './shortcuts.js';
import { History } from './editors/history.js';

/** Decode BOM-marked Unicode and UTF-8, with a fallback for Windows text files. */
export function decodeMarkup(bytes) {
  const data = new Uint8Array(bytes);
  if (data[0] === 255 && data[1] === 254) return new TextDecoder('utf-16le').decode(data);
  if (data[0] === 254 && data[1] === 255) return new TextDecoder('utf-16be').decode(data);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { return new TextDecoder('windows-1251').decode(data); }
}

/** Mount a formatted Markdown/TeX document in the existing scrollable file area. */
export async function openMarkup(file, root, context) {
  const [{ renderMarkup }, bytes] = await Promise.all([import('./vendor/markdown.js'), file.arrayBuffer()]);
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const article = document.createElement('article'); article.className = 'markdown-document';
  article.append(renderMarkup(decodeMarkup(bytes), context.ext, root.ownerDocument.defaultView)); root.replaceChildren(article);
  return {
    setZoom(value, point) {
      const restore = captureZoomAnchor(() => [article], root, point);
      article.style.fontSize = `${16 * value}px`; restore();
    },
    copyText: () => getSelection()?.toString() || '',
    find(query) {
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      let node; const needle = query.toLocaleLowerCase();
      if (!needle) return null;
      while (node = walker.nextNode()) {
        const at = node.textContent.toLocaleLowerCase().indexOf(needle);
        if (at < 0 || node.parentElement.closest('.katex-mathml,annotation')) continue;
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + query.length);
        const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range);
        node.parentElement.scrollIntoView({ block: 'center' }); return { message: 'Совпадение найдено' };
      }
      return null;
    }
  };
}

/** Edit Markdown source inline; previews and exports always use the current draft. */
export async function openMarkupEditor(record, root, options) {
  const { signal, onSave, onClose, onError, onDirty, initialZoom = 1 } = options;
  const [{ renderMarkup }, bytes] = await Promise.all([import('./vendor/markdown.js'), record.blob.arrayBuffer()]);
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const original = decodeMarkup(bytes), window = root.ownerDocument.defaultView;
  let zoom = initialZoom, busy = false, disposed = false, sourceMode = true, api;
  const panel = document.createElement('div'); panel.className = 'editor-panel markdown-editor';
  const bar = document.createElement('div'); bar.className = 'editor-bar';
  const makeButton = text => { const button = document.createElement('button'); button.type = 'button'; button.textContent = text; return button; };
  const preview = makeButton('Просмотр'), save = makeButton('Сохранить копию'), close = makeButton('К просмотру');
  const undo=makeButton('Отменить'),redo=makeButton('Повторить');
  save.className = 'primary'; bar.append(undo, redo, preview, save, close);
  const canvas = document.createElement('div'); canvas.className = 'markup-edit-canvas';
  const input = document.createElement('textarea'); input.className = 'markdown-source'; input.value = original;
  input.spellcheck = false; input.maxLength = 2 * 1024 * 1024; input.setAttribute('aria-label', 'Исходный текст Markdown');
  const article = document.createElement('article'); article.className = 'markdown-document'; article.hidden = true;
  const history=new History();let draft=original,selection={start:0,end:0};
  canvas.append(input, article); panel.append(bar, canvas); root.replaceChildren(panel);
  function update() {
    if (disposed) return;
    input.readOnly = busy; for (const button of [preview, save, close]) button.disabled = busy;
    save.disabled = busy || input.value === original; preview.textContent = sourceMode ? 'Просмотр' : 'Редактировать';
    undo.disabled=busy || !history.done.length;redo.disabled=busy || !history.future.length;
    onDirty?.(input.value !== original);
  }
  const run = action => async () => { if (busy || disposed) return; try { await action(); } catch (error) { onError(error); } };
  function toggleView() {
    if (busy || disposed) return;
    if (sourceMode) article.replaceChildren(renderMarkup(input.value, 'md', window));
    sourceMode = !sourceMode; input.hidden = !sourceMode; article.hidden = sourceMode;
    update(); if (sourceMode) input.focus({ preventScroll: true });
  }
  function setZoom(value) {
    if (disposed) return;
    zoom = Math.max(0.5, Math.min(3, value));
    input.style.fontSize = `${16 * zoom}px`; article.style.fontSize = `${16 * zoom}px`;
  }
  api = {
    get dirty() { return input.value !== original; }, get busy() { return busy; }, get sourceMode() { return sourceMode; },
    get position() { return { zoom }; },
    export: () => new TextEncoder().encode(input.value).buffer,
    setBusy(value) { busy = !!value; update(); },
    toggleView, adjustZoom: delta => setZoom(delta === null ? 1 : zoom + delta),
    dispose() { disposed = true; gestures.dispose(); }
  };
  const gestures = bindZoomGestures(canvas, { signal, getZoom: () => zoom, setZoom, onError });
  preview.onclick = toggleView; save.onclick = run(() => onSave(api)); close.onclick = run(onClose);
  history.onChange=()=>{if(!sourceMode)article.replaceChildren(renderMarkup(input.value,'md',window));update();};
  const commit=()=>{
    const next=input.value,previous=draft,before={...selection},after={start:input.selectionStart,end:input.selectionEnd};
    if(next===previous){update();return;}
    const apply=(text,position)=>{draft=text;input.value=text;input.setSelectionRange(position.start,position.end);};
    history.execute(()=>apply(next,after),()=>apply(previous,before),'markdown-input');selection=after;
  };
  input.addEventListener('beforeinput',()=>{selection={start:input.selectionStart,end:input.selectionEnd};});
  input.addEventListener('input', commit);
  undo.onclick=run(()=>history.undo());redo.onclick=run(()=>history.redo());
  panel.addEventListener('keydown', event => {
    const action=editingShortcut(event);
    if(action){event.preventDefault();({save,undo,redo})[action].click();}
    if (event.key === 'Tab' && event.target === input && !event.ctrlKey && !event.metaKey && !busy) {
      event.preventDefault();selection={start:input.selectionStart,end:input.selectionEnd};input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');commit();
    }
  });
  signal.addEventListener('abort', () => api.dispose(), { once: true });
  setZoom(zoom); update(); input.focus({ preventScroll: true }); return api;
}
