import { bindZoomGestures, createVisualZoom } from './gestures.js';
import { editingShortcut } from './shortcuts.js';
import { columnName, parseAddress, parseCsv, detectDelimiter } from './table-core.js';

export const LARGE_TEXT_BYTES = 8 * 1024 * 1024;
export const PAGE_BYTES = 128 * 1024;
const aborted = signal => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); };
const node = (tag, text, cls) => { const el = document.createElement(tag); if (text != null) el.textContent = text; if (cls) el.className = cls; return el; };
const button = text => { const el = node('button', text); el.type = 'button'; return el; };

/** Original bytes plus bounded replacement ranges; exporting never joins the whole file into a string. */
export class BlobText {
  constructor(blob, encoding) { this.blob = blob; this.encoding = encoding; this.changes = new Map(); }
  static async open(blob) {
    const sample = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    let encoding = sample[0] === 255 && sample[1] === 254 ? 'utf-16le' : sample[0] === 254 && sample[1] === 255 ? 'utf-16be' : 'utf-8';
    if (encoding === 'utf-8') try { new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true }); } catch { encoding = 'windows-1251'; }
    return new BlobText(blob, encoding);
  }
  decode(bytes) { return new TextDecoder(this.encoding, { fatal: true, ignoreBOM: true }).decode(bytes); }
  encode(text) {
    if (this.encoding === 'utf-8') return new TextEncoder().encode(text);
    if (this.encoding.startsWith('utf-16')) {
      const bytes = new Uint8Array(text.length * 2), view = new DataView(bytes.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), this.encoding === 'utf-16le');
      return bytes;
    }
    if (!this.reverse) { this.reverse = new Map(); const d = new TextDecoder(this.encoding); for (let i = 0; i < 256; i++) this.reverse.set(d.decode(new Uint8Array([i])), i); }
    const result = [];
    for (const char of text) { if (!this.reverse.has(char)) throw new Error('Этот символ нельзя сохранить в Windows-1251. Используйте UTF-8.'); result.push(this.reverse.get(char)); }
    return new Uint8Array(result);
  }
  async boundary(value) {
    let at = Math.max(0, Math.min(this.blob.size, value));
    if (!at || at === this.blob.size) return at;
    if (this.encoding.startsWith('utf-16')) {
      at -= at % 2; const bytes = await this.blob.slice(at, at + 2).arrayBuffer();
      if (bytes.byteLength === 2) { const c = new DataView(bytes).getUint16(0, this.encoding === 'utf-16le'); if (c >= 0xdc00 && c <= 0xdfff) at -= 2; }
    } else if (this.encoding === 'utf-8') {
      const start = Math.max(0, at - 3), bytes = new Uint8Array(await this.blob.slice(start, at + 1).arrayBuffer());
      while (at > start && (bytes[at - start] & 0xc0) === 0x80) at--;
    }
    const unit = this.encoding.startsWith('utf-16') ? 2 : 1;
    if (at >= unit && at + unit <= this.blob.size) {
      const bytes = new Uint8Array(await this.blob.slice(at - unit, at + unit).arrayBuffer());
      const view = new DataView(bytes.buffer), before = unit === 1 ? bytes[0] : view.getUint16(0, this.encoding === 'utf-16le'), after = unit === 1 ? bytes[1] : view.getUint16(2, this.encoding === 'utf-16le');
      if (before === 13 && after === 10) at -= unit;
    }
    return at;
  }
  async range(start, end) { return this.decode(await (this.changes.get(start)?.blob || this.blob.slice(start, end)).arrayBuffer()); }
  async page(index) {
    const start = await this.boundary(index * PAGE_BYTES), end = await this.boundary((index + 1) * PAGE_BYTES);
    return { start, end, text: await this.range(start, end) };
  }
  async replace(start, end, text) {
    const encoded = this.encode(text), original = this.decode(await this.blob.slice(start, end).arrayBuffer());
    if (text === original) this.changes.delete(start); else this.changes.set(start, { end, blob: new Blob([encoded]) });
  }
  export() {
    const parts = []; let at = 0;
    for (const [start, change] of [...this.changes].sort((a, b) => a[0] - b[0])) { parts.push(this.blob.slice(at, start), change.blob); at = change.end; }
    parts.push(this.blob.slice(at)); return new Blob(parts, { type: this.blob.type });
  }
}

export async function openLargeText(file, root, context = {}, editing = false) {
  const model = await BlobText.open(file); aborted(context.signal);
  const panel = node('div', null, 'editor-panel large-text-panel'), bar = node('div', null, 'editor-bar');
  const previous = button('←'), next = button('→'), status = node('span', '', 'editor-status');
  const body = node('div', null, 'large-text-body'), input = node('textarea', null, 'large-text-input');
  input.spellcheck = false; input.setAttribute('aria-label', 'Содержимое части файла');
  const count = Math.max(1, Math.ceil(file.size / PAGE_BYTES));
  let page = 0, current, busy = false, pageDirty = false, sourceMode = true, zoom = 1, disposed = false, searchQuery = '', searchOffset = 0;
  bar.append(previous, next, status); body.append(input);
  panel.append(bar, node('p', 'Большой файл: исходный текст частями по 128 КиБ. При сохранении остальные части остаются без изменений.', 'large-file-note'), body); root.replaceChildren(panel);
  const guard = action => async () => { try { await action(); } catch (error) { if (!disposed) (context.onError || context.onWarning)?.(error); } };
  function sync() { input.readOnly = !editing || !sourceMode || busy; previous.disabled = busy || page === 0; next.disabled = busy || page + 1 >= count; status.textContent = `Часть ${page + 1} / ${count} · ${model.encoding}`; }
  async function flush() { if (pageDirty && current) { const newline = current.text.includes('\r\n') ? '\r\n' : current.text.includes('\r') && !current.text.includes('\n') ? '\r' : '\n'; await model.replace(current.start, current.end, input.value.replace(/\r\n?/g, '\n').replaceAll('\n', newline)); pageDirty = false; } }
  async function go(index) {
    if (busy) return; busy = true; sync();
    try { await flush(); const value = Math.max(0, Math.min(count - 1, index)); const part = await model.page(value); aborted(context.signal); if (disposed) return; current = part; page = value; input.value = part.text; input.scrollTop = 0; context.onPage?.(page + 1); }
    finally { busy = false; sync(); }
  }
  const visual = createVisualZoom(body, input, { signal: context.signal, fillHeight: true });
  const api = {
    get dirty() { return pageDirty || model.changes.size > 0; }, get busy() { return busy; }, get sourceMode() { return sourceMode; },
    get position() { return { page: page + 1, zoom }; },
    export: async () => { await flush(); return model.export(); }, setBusy(value) { busy = value; sync(); },
    toggleView() { sourceMode = !sourceMode; sync(); }, setPage: value => go(value - 1), navigate: delta => go(page + delta),
    setZoom(value, point) { zoom = Math.max(.5, Math.min(3, value)); visual.setZoom(zoom, point); context.onZoom?.(zoom); }, adjustZoom(delta) { api.setZoom(delta === null ? 1 : zoom + delta); },
    copyText: () => input.value.slice(input.selectionStart, input.selectionEnd),
    async find(query) {
      if (!query || busy) return { message: 'Введите текст для поиска.' };
      await flush(); if (searchQuery !== query) { searchQuery = query; searchOffset = 0; }
      for (let n = 0; n < count; n++) { aborted(context.signal); const index = (page + n) % count, part = await model.page(index), at = part.text.toLowerCase().indexOf(query.toLowerCase(), n ? 0 : searchOffset); if (at >= 0) { await go(index); searchOffset = at + query.length; input.focus(); input.setSelectionRange(at, at + query.length); return { page: index + 1, message: 'Найдено в части ' + (index + 1) }; } }
      searchOffset = 0; return { message: 'В оставшихся частях не найдено. Повторите поиск для начала текущей части.' };
    },
    dispose() { disposed = true; gestures.dispose(); }
  };
  const gestures = bindZoomGestures(body, { getZoom: () => zoom, setZoom: api.setZoom, signal: context.signal, onError: context.onError || context.onWarning });
  input.oninput = () => { pageDirty = true; context.onDirty?.(); };
  previous.onclick = guard(() => go(page - 1)); next.onclick = guard(() => go(page + 1));
  if (editing) { const save = button('Сохранить копию'), close = button('К просмотру'); save.onclick = guard(() => !busy && context.onSave?.(api)); close.onclick = guard(() => !busy && context.onClose?.()); bar.append(save, close); }
  panel.addEventListener('keydown', event => { if (editing && sourceMode && editingShortcut(event) === 'save') { event.preventDefault(); if (!busy) void guard(() => context.onSave?.(api))(); } });
  context.signal?.addEventListener('abort', () => api.dispose(), { once: true });
  await go(0); context.onPages?.(count); return api;
}

/** Byte offsets every 100 logical CSV records, respecting quoted newlines and CRLF across chunks. */
export async function indexCsv(file, encoding, signal, onProgress) {
  const unit = encoding.startsWith('utf-16') ? 2 : 1, little = encoding === 'utf-16le';
  const checkpoints = [0]; let rows = 0, quoted = false, pendingCR = false, lastEnd = 0;
  for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
    aborted(signal); const bytes = new Uint8Array(await file.slice(offset, offset + 1024 * 1024).arrayBuffer()), view = new DataView(bytes.buffer);
    for (let i = 0; i + unit <= bytes.length; i += unit) {
      const c = unit === 1 ? bytes[i] : view.getUint16(i, little), end = offset + i + unit;
      if (pendingCR) { pendingCR = false; if (c === 10) { lastEnd = end; if (rows % 100 === 0) checkpoints[checkpoints.length - 1] = end; continue; } }
      if (c === 34) quoted = !quoted;
      else if (!quoted && (c === 10 || c === 13)) { rows++; lastEnd = end; if (rows % 100 === 0) checkpoints.push(end); pendingCR = c === 13; }
    }
    onProgress?.(Math.min(100, Math.round((offset + bytes.length) * 100 / Math.max(1, file.size))));
  }
  if (quoted) throw new Error('Некорректный CSV: незакрытые кавычки.');
  if (lastEnd < file.size || rows === 0) rows++;
  while (checkpoints.length > 1 && checkpoints.at(-1) === file.size) checkpoints.pop();
  return { checkpoints, rows, unit };
}

export async function openLargeCsv(file, root, context = {}, editing = false) {
  const model = await BlobText.open(file);
  const index = await indexCsv(file, model.encoding, context.signal, progress => { root.textContent = `Подготавливаем таблицу: ${progress}%`; });
  aborted(context.signal);
  const endAt = group => index.checkpoints[group + 1] ?? file.size;
  if (index.checkpoints.some((start, i) => endAt(i) - start > LARGE_TEXT_BYTES)) return openLargeText(file, root, context, editing);
  const firstText = await model.range(0, endAt(0)), delimiter = detectDelimiter(firstText);
  const panel = node('div', null, 'editor-panel'), bar = node('div', null, 'editor-bar'), body = node('div', null, 'large-csv-body'), table = node('table', null, 'large-csv-table');
  const up = button('−100 строк'), down = button('+100 строк'), left = button('← столбцы'), right = button('столбцы →'), jump = button('Перейти');
  const address = node('input'); address.value = 'A1'; address.setAttribute('aria-label', 'Адрес ячейки');
  const status = node('span', '', 'editor-status'); bar.append(up, down, left, right, jump, address, status); body.append(table);
  panel.append(bar, node('p', 'Большой CSV: 100 строк и 10 столбцов за раз. Выберите ячейку для ввода значения.', 'large-file-note'), body); root.replaceChildren(panel);
  let group = 0, col = 0, rows = [], original = '', pageDirty = false, busy = false, sourceMode = true, zoom = 1, disposed = false;
  const guard = action => async () => { try { if (!busy) await action(); } catch (error) { if (!disposed) (context.onError || context.onWarning)?.(error); } };
  function sync() { for (const el of bar.querySelectorAll('button,input')) el.disabled = busy; up.disabled ||= group === 0; down.disabled ||= group + 1 >= index.checkpoints.length; left.disabled ||= col === 0; right.disabled ||= col >= 16374; for (const el of table.querySelectorAll('textarea')) el.readOnly = busy || !editing || !sourceMode; status.textContent = `Строки ${group * 100 + 1}–${Math.min(index.rows, (group + 1) * 100)} / ${index.rows}`; }
  async function flush() {
    if (!pageDirty) return;
    const newline = original.includes('\r\n') ? '\r\n' : original.includes('\r') ? '\r' : '\n';
    const quote = value => value.includes(delimiter) || /["\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
    const text = (original.startsWith('\uFEFF') ? '\uFEFF' : '') + rows.map(row => row.map(value => quote(value ?? '')).join(delimiter)).join(newline) + (/[\r\n]$/.test(original) ? newline : '');
    await model.replace(index.checkpoints[group], endAt(group), text); original = text; pageDirty = false;
  }
  function render() {
    table.replaceChildren(); const head = node('tr'); head.append(node('th', '#')); for (let c = col; c < Math.min(16384, col + 10); c++) head.append(node('th', columnName(c))); table.append(head);
    rows.forEach((row, r) => { const tr = node('tr'); tr.append(node('th', group * 100 + r + 1)); for (let c = col; c < Math.min(16384, col + 10); c++) {
      const td = node('td'), input = node('textarea', null, 'csv-cell-input'); input.value = row[c] ?? ''; input.rows = 1; input.setAttribute('aria-label', columnName(c) + (group * 100 + r + 1));
      input.oninput = () => { while (row.length <= c) row.push(''); row[c] = input.value; pageDirty = true; context.onDirty?.(); }; td.append(input); tr.append(td);
    } table.append(tr); }); sync();
  }
  async function go(nextGroup, nextCol = col) {
    if (busy) return; busy = true; sync();
    try { await flush(); const target = Math.max(0, Math.min(index.checkpoints.length - 1, nextGroup)); const text = await model.range(index.checkpoints[target], endAt(target)); aborted(context.signal); if (disposed) return; const parsed = parseCsv(text, delimiter, { maxRows: 100, maxCols: 16384 }); group = target; col = Math.max(0, Math.min(16374, nextCol)); original = text; rows = parsed; render(); context.onPage?.(group + 1); }
    finally { busy = false; sync(); }
  }
  const visual = createVisualZoom(body, table, { signal: context.signal, fixedWidth: false });
  const api = {
    get dirty() { return pageDirty || model.changes.size > 0; }, get busy() { return busy; }, get sourceMode() { return sourceMode; }, get position() { return { page: group + 1, zoom }; },
    export: async () => { await flush(); return model.export(); }, setBusy(value) { busy = value; sync(); }, toggleView() { sourceMode = !sourceMode; sync(); },
    setPage: value => go(value - 1), navigate: delta => go(group + delta),
    setZoom(value, point) { zoom = Math.max(.5, Math.min(3, value)); visual.setZoom(zoom, point); context.onZoom?.(zoom); }, adjustZoom(delta) { api.setZoom(delta === null ? 1 : zoom + delta); },
    copyText: () => root.ownerDocument.defaultView.getSelection()?.toString() || '',
    dispose() { disposed = true; gestures.dispose(); }
  };
  const gestures = bindZoomGestures(body, { getZoom: () => zoom, setZoom: api.setZoom, signal: context.signal, onError: context.onError || context.onWarning });
  up.onclick = guard(() => go(group - 1)); down.onclick = guard(() => go(group + 1)); left.onclick = guard(() => go(group, col - 10)); right.onclick = guard(() => go(group, col + 10));
  jump.onclick = guard(async () => { const at = parseAddress(address.value); if (at.row >= index.rows) throw new Error('Этой строки нет в файле.'); await go(Math.floor(at.row / 100), Math.floor(at.col / 10) * 10); table.querySelector(`[aria-label="${columnName(at.col)}${at.row + 1}"]`)?.focus(); });
  if (editing) { const save = button('Сохранить копию'), close = button('К просмотру'); save.onclick = guard(() => context.onSave?.(api)); close.onclick = guard(() => context.onClose?.()); bar.append(save, close); }
  panel.addEventListener('keydown', event => { if (editing && sourceMode && editingShortcut(event) === 'save') { event.preventDefault(); if (!busy) void guard(() => context.onSave?.(api))(); } });
  context.signal?.addEventListener('abort', () => api.dispose(), { once: true });
  await go(0, 0); context.onPages?.(index.checkpoints.length); return api;
}
