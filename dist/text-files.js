import { decodeMarkup } from './markup.js';
import { captureZoomAnchor, bindZoomGestures } from './gestures.js';
import { editingShortcut } from './shortcuts.js';
import { History } from './editors/history.js';
import { LIMITS } from './validation.js';
import { colorCode, colorInput } from './syntax.js';

export const makeNode = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Preserve Unicode BOMs and line endings. Legacy Windows encodings export as UTF-8. */
export function textCodec(bytes) {
  const data = new Uint8Array(bytes), text = decodeMarkup(bytes);
  const utf16 = data[0] === 255 && data[1] === 254 ? 'le' : data[0] === 254 && data[1] === 255 ? 'be' : null;
  const bom = data[0] === 239 && data[1] === 187 && data[2] === 191;
  const normalized = text.replace(/\r\n?/g, '\n');
  const newline = text.includes('\r\n') ? '\r\n' : text.includes('\r') && !text.includes('\n') ? '\r' : '\n';
  return {
    text: normalized,
    encode(value) {
      const source = value.replace(/\r\n?/g, '\n').replaceAll('\n', newline);
      if (utf16) {
        const result = new Uint8Array(2 + source.length * 2), view = new DataView(result.buffer);
        result.set(utf16 === 'le' ? [255, 254] : [254, 255]);
        for (let i = 0; i < source.length; i++) view.setUint16(2 + i * 2, source.charCodeAt(i), utf16 === 'le');
        return result.buffer;
      }
      return new TextEncoder().encode((bom ? '\ufeff' : '') + source).buffer;
    }
  };
}

export function parseJson(source) {
  try { return JSON.parse(source); }
  catch (error) { throw new Error(`Ошибка JSON: ${error.message}`); }
}

/** Format lexical tokens rather than reserializing numbers through JavaScript doubles. */
export function formatJson(source) {
  parseJson(source);
  if (source.length > 1024 * 1024) return source;
  const tokens = /"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g;
  const parts = []; let depth = 0, previous = '', length = 0, found;
  const append = text => { parts.push(text); length += text.length; };
  const newline = () => append('\n' + '  '.repeat(depth));
  while (found = tokens.exec(source)) {
    const token = found[0];
    if (token === '{' || token === '[') {
      append(token); depth++; if (depth > 64) return source;
      let next = tokens.lastIndex; while (/\s/.test(source[next] || '') && next < source.length) next++;
      if (source[next] !== '}' && source[next] !== ']') newline();
    } else if (token === '}' || token === ']') {
      depth--; if (previous !== '{' && previous !== '[') newline(); append(token);
    } else if (token === ',') { append(','); newline(); }
    else append(token === ':' ? ': ' : token);
    if (length > 8 * 1024 * 1024) return source; previous = token;
  }
  return parts.join('');
}

/** Source files are always text; JavaScript and environment values never execute. */
export function renderText(source, ext, document) {
  const fragment = document.createDocumentFragment();
  let display = source;
  if (ext === 'json') {
    try { display = formatJson(source); }
    catch (error) { fragment.append(makeNode(document, 'p', 'source-notice', `${error.message}. Можно исправить в редакторе.`)); }
  }
  const pre = makeNode(document, 'pre', 'source-preview');
  const code=makeNode(document, 'code', `language-${ext}`);colorCode(code,display||'',ext);pre.append(code);
  fragment.append(pre); return fragment;
}

/** Share selectable text search between source files and notebook cells. */
export function textNavigation(article) {
  const document = article.ownerDocument, window = document.defaultView;
  let previousQuery = '', previousOffset = -1;
  return {
    copyText: () => window.getSelection()?.toString() || '',
    find(query) {
      const needle = query.toLocaleLowerCase(); if (!needle) return null;
      const walker = document.createTreeWalker(article, window.NodeFilter.SHOW_TEXT), nodes = [];
      let node,text='';
      while (node = walker.nextNode()) {
        if (!node.parentElement.closest('textarea,button,.katex-mathml,annotation,[hidden],[aria-hidden="true"]')) {nodes.push({node,start:text.length,end:text.length+node.length});text+=node.textContent;}
      }
      const folded=text.toLocaleLowerCase(),start=previousQuery===needle?previousOffset+needle.length:0;
      let at=folded.indexOf(needle,start);if(at<0 && start)at=folded.indexOf(needle);if(at<0)return null;
      const first=nodes.find(part=>at>=part.start && at<part.end),last=nodes.find(part=>at+query.length>part.start && at+query.length<=part.end);
      if(!first || !last)return null;
      const range=document.createRange();range.setStart(first.node,at-first.start);range.setEnd(last.node,at+query.length-last.start);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);first.node.parentElement.scrollIntoView?.({block:'center'});
      previousQuery=needle;previousOffset=at;return {message:'Совпадение найдено'};
    }
  };
}

export async function openText(file, root, context) {
  const bytes = await file.arrayBuffer();
  if (context.signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const article = makeNode(root.ownerDocument, 'article', 'source-document');
  article.append(renderText(textCodec(bytes).text, context.ext, root.ownerDocument)); root.replaceChildren(article);
  return {
    ...textNavigation(article),
    setZoom(value, point) {
      const restore = captureZoomAnchor(() => [article], root, point);
      article.style.fontSize = `${16 * value}px`; restore();
    }
  };
}

/** One inline source editor supports preview, undo, keyboard shortcuts and pinch zoom. */
export async function openTextEditor(record, root, options, custom = {}) {
  const { signal, onSave, onClose, onError, onDirty, initialZoom = 1 } = options;
  const bytes = await record.blob.arrayBuffer();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const document = root.ownerDocument, codec = textCodec(bytes), original = codec.text;
  const node = (tag, cls, text) => makeNode(document, tag, cls, text);
  const panel = node('div', 'editor-panel source-editor'), bar = node('div', 'editor-bar');
  const undo = node('button', '', 'Отменить'), redo = node('button', '', 'Повторить');
  const preview = node('button', '', 'Просмотр'), save = node('button', 'primary', 'Сохранить копию'), close = node('button', '', 'К просмотру');
  for (const button of [undo, redo, preview, save, close]) button.type = 'button';
  bar.append(undo, redo, preview, save, close);
  const canvas = node('div', 'source-edit-canvas'), input = node('textarea', 'source-input');
  const status = node('p', 'source-notice source-edit-notice'); status.hidden = true; status.setAttribute('role', 'alert');
  input.value = original; input.spellcheck = false; input.autocomplete = 'off';
  input.maxLength = LIMITS[record.ext] * 1024 * 1024; input.setAttribute('aria-label', `Исходный текст ${record.ext.toUpperCase()}`);
  const article = node('article', custom.articleClass || 'source-document'); article.hidden = true;
  canvas.append(input, article); panel.append(bar, status, canvas); root.replaceChildren(panel);
  const colors=colorInput(input,record.ext,{signal});
  const history = new History(); let sourceMode = true, busy = false, disposed = false, zoom = initialZoom, draft = original;
  let selection = { start: 0, end: 0 }, api;
  const render = () => article.replaceChildren(custom.render ? custom.render(input.value) : renderText(input.value, record.ext, document));
  function update() {
    if (disposed) return;
    input.readOnly = busy;
    for (const button of [preview, save, close]) button.disabled = busy;
    undo.disabled = busy || !history.done.length; redo.disabled = busy || !history.future.length;
    save.disabled = busy || input.value === original; preview.textContent = sourceMode ? 'Просмотр' : 'Редактировать';
    onDirty?.(input.value !== original);
    colors.refresh();
  }
  const guarded = action => async () => { if (busy || disposed) return; try { await action(); } catch (error) { onError?.(error); } };
  function toggleView() {
    if (busy || disposed) return;
    if (sourceMode) render();
    sourceMode = !sourceMode; input.hidden = !sourceMode; colors.wrap.hidden=!sourceMode; article.hidden = sourceMode;
    update(); if (sourceMode) input.focus({ preventScroll: true });
  }
  function setZoom(value, point) {
    if (disposed) return;
    const restore = captureZoomAnchor(() => [sourceMode ? input : article], canvas, point);
    zoom = Math.max(0.5, Math.min(3, value));
    input.style.fontSize = `${16 * zoom}px`; article.style.fontSize = `${16 * zoom}px`; colors.refresh();restore();
  }
  api = {
    get dirty() { return input.value !== original; }, get busy() { return busy; }, get sourceMode() { return sourceMode; },
    get position() { return { zoom }; },
    export() {
      try {
        if (custom.validate) custom.validate(input.value);
        else if (record.ext === 'json') parseJson(input.value);
      } catch (error) { status.textContent = error.message; status.hidden = false; throw error; }
      return codec.encode(input.value);
    },
    toggleView, setBusy(value) { busy = !!value; update(); },
    adjustZoom: delta => setZoom(delta === null ? 1 : zoom + delta),
    dispose() { if (disposed) return; disposed = true; gestures.dispose();colors.dispose(); }
  };
  const gestures = bindZoomGestures(canvas, { signal, getZoom: () => zoom, setZoom, onError });
  history.onChange = () => { status.hidden = true; if (!sourceMode) render(); update(); };
  function commit() {
    status.hidden = true;
    const next = input.value, previous = draft, before = { ...selection }, after = { start: input.selectionStart, end: input.selectionEnd };
    if (next === previous) { update(); return; }
    const apply = (text, position) => { draft = text; input.value = text; input.setSelectionRange(position.start, position.end); };
    history.execute(() => apply(next, after), () => apply(previous, before), 'source-input'); selection = after;
  }
  input.addEventListener('beforeinput', () => { selection = { start: input.selectionStart, end: input.selectionEnd }; });
  input.addEventListener('input', commit);
  undo.onclick = guarded(() => history.undo()); redo.onclick = guarded(() => history.redo());
  preview.onclick = toggleView; save.onclick = guarded(() => onSave(api)); close.onclick = guarded(onClose);
  panel.addEventListener('keydown', event => {
    const action = editingShortcut(event);
    if (action) { event.preventDefault(); ({ save, undo, redo })[action].click(); }
    else if (event.key === 'Tab' && event.target === input && !event.ctrlKey && !event.metaKey && !busy) {
      event.preventDefault(); selection = { start: input.selectionStart, end: input.selectionEnd };
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end'); commit();
    }
  });
  signal.addEventListener('abort', () => api.dispose(), { once: true });
  setZoom(zoom); update(); input.focus({ preventScroll: true }); return api;
}
